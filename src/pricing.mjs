import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJson } from './fs-util.mjs';

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function loadPricing(file) {
  if (!file) return null;
  const pricing = readJson(file, null);
  if (!pricing || !Array.isArray(pricing.models)) throw new Error(`Pricing file ${file} must contain a models array.`);
  const raw = fs.readFileSync(file);
  return {
    ...pricing,
    _version: pricing.version ? String(pricing.version) : crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
  };
}

function findPrice(pricing, agent, model) {
  if (!pricing || !model) return null;
  return pricing.models.find((entry) => {
    if (entry.agent && entry.agent !== agent && entry.agent !== '*') return false;
    return globToRegExp(entry.match ?? entry.model ?? '*').test(model);
  }) ?? null;
}

export function estimateEventCost(event, pricing) {
  const usage = event.usage;
  if (!usage || !event.model) return null;
  // A sample is a gauge re-reported on every refresh; pricing it would charge
  // for the whole context once per render.
  if (usage.basis === 'sample') return null;
  const price = findPrice(pricing, event.agent, event.model);
  if (!price) return null;
  // cache_write may be a total synthesized from the 5m/1h split. Charging the
  // split and the synthesized total bills the same tokens twice.
  const hasSplitWrites = Number.isFinite(usage.cache_write_5m) || Number.isFinite(usage.cache_write_1h);
  const components = [
    ['input_fresh', 'input_per_million'],
    ['cache_read', 'cache_read_per_million'],
    ['cache_write_5m', 'cache_write_5m_per_million'],
    ['cache_write_1h', 'cache_write_1h_per_million'],
    ['cache_write', 'cache_write_per_million'],
    ['output', 'output_per_million'],
    ['reasoning', 'reasoning_per_million']
  ];
  let amount = 0;
  let used = false;
  const missing = [];
  for (const [tokenKey, priceKey] of components) {
    if (tokenKey === 'cache_write' && hasSplitWrites) continue;
    const tokens = usage[tokenKey] ?? 0;
    if (!tokens) continue;
    let rate = Number(price[priceKey]);
    if (!Number.isFinite(rate) && tokenKey === 'reasoning') rate = Number(price.output_per_million);
    if (!Number.isFinite(rate) && tokenKey.startsWith('cache_write_')) rate = Number(price.cache_write_per_million);
    if (!Number.isFinite(rate)) {
      missing.push(priceKey);
      continue;
    }
    amount += (tokens / 1_000_000) * rate;
    used = true;
  }
  if (missing.length || !used) return { complete: false, missing, price };
  return {
    complete: true,
    amount_usd: amount,
    basis: 'configured_estimate',
    currency: 'USD',
    price_version: pricing._version,
    price
  };
}
