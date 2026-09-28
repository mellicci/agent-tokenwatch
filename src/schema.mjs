import crypto from 'node:crypto';
import { AGENT_NAMES, MAX_EVENT_LINE_BYTES, SCHEMA } from './constants.mjs';
import { finiteNonNegative, looksSensitive, safeIdentifier, safeString } from './privacy.mjs';

export const USAGE_KEYS = [
  'input_total', 'input_fresh', 'cache_read', 'cache_write',
  'cache_write_5m', 'cache_write_1h', 'output', 'reasoning', 'total'
];

export function cleanUsage(usage = {}) {
  const out = {};
  for (const key of USAGE_KEYS) {
    const value = finiteNonNegative(usage[key]);
    if (value !== undefined) out[key] = Math.round(value);
  }
  const semantics = ['components', 'cached_subset', 'unknown'].includes(usage.semantics)
    ? usage.semantics : 'unknown';
  out.semantics = semantics;
  // `transcript` is one API response read from a session file by an explicit
  // import: additive like `increment`, and labelled so reports can tell it
  // apart (intent 06, D1).
  out.basis = ['increment', 'sample', 'transcript'].includes(usage.basis) ? usage.basis : 'increment';

  if (out.cache_write === undefined) {
    const writes = (out.cache_write_5m ?? 0) + (out.cache_write_1h ?? 0);
    if (writes > 0) out.cache_write = writes;
  }
  if (semantics === 'components') {
    if (out.input_fresh === undefined && out.input_total !== undefined) {
      const cached = (out.cache_read ?? 0) + (out.cache_write ?? 0);
      out.input_fresh = Math.max(0, out.input_total - cached);
    }
    if (out.input_total === undefined && out.input_fresh !== undefined) {
      out.input_total = out.input_fresh + (out.cache_read ?? 0) + (out.cache_write ?? 0);
    }
  } else if (semantics === 'cached_subset') {
    if (out.input_fresh === undefined && out.input_total !== undefined) {
      out.input_fresh = Math.max(0, out.input_total - (out.cache_read ?? 0));
    }
  }
  if (out.total === undefined && (out.input_total !== undefined || out.output !== undefined)) {
    out.total = (out.input_total ?? 0) + (out.output ?? 0);
  }
  return out;
}

// A provider that reports session-cumulative counters instead of a per-call
// gauge. Kept beside the derived per-call usage so `repair` can rebuild the
// deltas from the ledger alone. Counts only - no semantics, no basis, because
// a running total is neither an increment nor a sample.
export function cleanCounters(counters) {
  if (!counters || typeof counters !== 'object') return undefined;
  const out = {};
  for (const key of USAGE_KEYS) {
    const value = finiteNonNegative(counters[key]);
    if (value !== undefined) out[key] = Math.round(value);
  }
  return Object.keys(out).length ? out : undefined;
}

// Not every provider bills in currency. Copilot CLI reports AI units and
// premium requests and no dollars at all. These are provider-reported counts in
// the unit the user's quota is actually consumed in, kept apart from `cost` so
// nothing can mistake one for the other or add them together.
export function cleanBillingUnits(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const name = safeIdentifier(key, 40);
    const value = finiteNonNegative(raw);
    if (name && value !== undefined) out[name] = Number(value.toFixed(6));
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanCost(cost) {
  if (!cost || typeof cost !== 'object') return undefined;
  const out = {};
  for (const key of ['amount_usd', 'delta_usd', 'cumulative_usd']) {
    const value = finiteNonNegative(cost[key]);
    if (value !== undefined) out[key] = Number(value.toFixed(12));
  }
  if (cost.basis === 'provider_reported' || cost.basis === 'configured_estimate') out.basis = cost.basis;
  if (cost.currency) out.currency = safeIdentifier(cost.currency, 8);
  if (cost.price_version) out.price_version = safeString(cost.price_version, 80);
  return Object.keys(out).length ? out : undefined;
}

// Why a history import is unverified: a closed set, so the block can never
// carry free text (intent 06, D1). Only rows carry it, and a row exists only
// when the overlap check ran, so these are exactly the check's verdicts. A run
// that stopped (an invalid mapping, a read-only data directory) writes no row
// and keeps no record; that reason belongs to the command's output, not here
// (#18). No reader checks a stored reason against this list, so a ledger
// written under the wider list reads as before.
export const IMPORT_REASONS = ['no_overlap', 'no_live_tokens', 'mismatch'];

// The provenance of an imported row: fixed keys only; anything else is dropped.
export function cleanImport(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const key of ['mapping_id', 'mapping_version', 'run_id']) {
    const value = safeIdentifier(input[key], 80);
    if (value !== undefined) out[key] = value;
  }
  if (input.verification === 'verified' || input.verification === 'unverified') out.verification = input.verification;
  if (IMPORT_REASONS.includes(input.reason)) out.reason = input.reason;
  return Object.keys(out).length ? out : undefined;
}

export function makeEvent(input) {
  const agentKey = input.agent in AGENT_NAMES ? input.agent : Object.keys(AGENT_NAMES)
    .find((key) => AGENT_NAMES[key] === input.agent);
  if (!agentKey) throw new Error(`Unsupported agent: ${input.agent}`);
  const event = {
    schema: SCHEMA,
    event_id: safeIdentifier(input.event_id, 160) || crypto.randomUUID(),
    ts: new Date(input.ts ?? Date.now()).toISOString(),
    agent: AGENT_NAMES[agentKey],
    kind: safeIdentifier(input.kind, 48) || 'lifecycle',
    source: safeIdentifier(input.source, 48) || 'hook'
  };
  for (const [key, max] of [
    ['session_id', 160], ['turn_id', 160], ['parent_id', 160],
    ['model', 160], ['project_id', 80], ['event_name', 100],
    ['tool_name', 120], ['subagent_type', 120], ['status', 80]
  ]) {
    const value = safeIdentifier(input[key], max);
    if (value !== undefined) event[key] = value;
  }
  if (input.usage) event.usage = cleanUsage(input.usage);
  const counters = cleanCounters(input.usage_cumulative);
  if (counters) event.usage_cumulative = counters;
  const billing = cleanBillingUnits(input.billing);
  if (billing) event.billing = billing;
  const billingCumulative = cleanBillingUnits(input.billing_cumulative);
  if (billingCumulative) event.billing_cumulative = billingCumulative;
  const cost = cleanCost(input.cost);
  if (cost) event.cost = cost;
  if (input.context && typeof input.context === 'object') {
    const context = {};
    for (const key of ['used', 'limit', 'percent']) {
      const value = finiteNonNegative(input.context[key]);
      if (value !== undefined) context[key] = key === 'percent' ? Number(value.toFixed(2)) : Math.round(value);
    }
    if (Object.keys(context).length) event.context = context;
  }
  if (input.cache && typeof input.cache === 'object') {
    const cache = {};
    for (const key of ['ttl_seconds', 'age_seconds', 'hit_rate']) {
      const value = finiteNonNegative(input.cache[key]);
      if (value !== undefined) cache[key] = Number(value.toFixed(4));
    }
    if (input.cache.ttl_source) cache.ttl_source = safeIdentifier(input.cache.ttl_source, 40);
    if (Object.keys(cache).length) event.cache = cache;
  }
  if (input.metrics && typeof input.metrics === 'object') {
    const metrics = {};
    for (const [key, raw] of Object.entries(input.metrics)) {
      const name = safeIdentifier(key, 64);
      const value = finiteNonNegative(raw);
      if (name && value !== undefined) metrics[name] = Number(value.toFixed(6));
    }
    if (Object.keys(metrics).length) event.metrics = metrics;
  }
  if (input.flags && typeof input.flags === 'object') {
    const flags = {};
    for (const [key, raw] of Object.entries(input.flags)) {
      const name = safeIdentifier(key, 64);
      if (name && typeof raw === 'boolean') flags[name] = raw;
    }
    if (Object.keys(flags).length) event.flags = flags;
  }
  if (input.cumulative) event.cumulative = true;
  const provenance = cleanImport(input.import);
  if (provenance) event.import = provenance;
  if (input.fingerprint) event.fingerprint = safeIdentifier(input.fingerprint, 160);
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_LINE_BYTES) {
    throw new Error('Normalized event exceeds the metadata safety limit.');
  }
  return event;
}

export function assertPrivacySafe(event) {
  const forbidden = new Set([
    'prompt', 'user_prompt', 'assistant_message', 'message', 'content', 'body',
    'tool_input', 'tool_output', 'transcript', 'transcript_path', 'cwd',
    'current_dir', 'project_dir', 'file_path', 'command', 'arguments', 'env'
  ]);
  const visit = (value, trail = []) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (forbidden.has(lower)) throw new Error(`Unsafe field in normalized event: ${[...trail, key].join('.')}`);
      // A permitted field name says nothing about what was put inside it. This
      // is the tripwire for a construction path that bypassed `safeIdentifier`,
      // which is where the value would normally have been dropped already.
      if (typeof child === 'string' && looksSensitive(child)) {
        throw new Error(`Unsafe value in normalized event: ${[...trail, key].join('.')}`);
      }
      visit(child, [...trail, key]);
    }
  };
  visit(event);
  return true;
}
