import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MAPPING_FILE_BYTES } from '../constants.mjs';
import { atomicWriteJson, isWriteRefused } from '../fs-util.mjs';
import { looksSecretOrPath } from '../privacy.mjs';
import { readMapping } from './mapping.mjs';

// Which mapping an import reads (intent 19, D8). Three tiers, first found wins:
// the file named by --mapping, the user's kept mapping beside the ledger, and
// the one Tokenwatch ships. The tier that is chosen must be valid: an invalid
// file is an error, never a quiet fall-through to the next tier (FR-01, FR-31).
export function userMappingFile(config, agent) {
  return path.join(path.dirname(config.dataFile), 'mappings', `${agent}.json`);
}

export function bundledMappingFile(agent) {
  return fileURLToPath(new URL(`./mappings/${agent}.json`, import.meta.url));
}

// The bundled mapping, read with the same refusal as every other tier: a
// broken install is a named MAPPING_INVALID with origin 'bundled', never a
// crash, wherever it is read (review-fix 2, D12).
export function bundledMapping(agent) {
  const file = bundledMappingFile(agent);
  try {
    return { mapping: readMapping(file, agent) };
  } catch (error) {
    if (error.code !== 'MAPPING_INVALID') throw error;
    return { error: { message: error.message, errors: error.errors, origin: 'bundled', path: file } };
  }
}

function tier(source, agent, origin) {
  try {
    return { mapping: readMapping(source, agent), origin, path: source };
  } catch (error) {
    if (error.code === 'MAPPING_INVALID') Object.assign(error, { origin, path: source });
    throw error;
  }
}

export function resolveMapping({ agent, file, config }) {
  if (file) return tier(file, agent, 'file');
  const user = config ? userMappingFile(config, agent) : undefined;
  if (user && fs.existsSync(user)) return tier(user, agent, 'user');
  return tier(bundledMappingFile(agent), agent, 'bundled');
}

// A mapping the user keeps or shares is written by an agent from a probe, so
// before it is kept or printed, every string in it is checked for a secret or a
// path and refused by key path, never quoted (D4, FR-03). file.glob is exempt:
// it is held to a file-name shape by validateMapping.
function unsafeStringPath(mapping) {
  const walk = (value, trail) => {
    if (typeof value === 'string') return trail !== 'file.glob' && looksSecretOrPath(value) ? trail : undefined;
    if (!value || typeof value !== 'object') return undefined;
    for (const [key, child] of Object.entries(value)) {
      const found = walk(child, trail ? `${trail}.${key}` : key);
      if (found) return found;
    }
    return undefined;
  };
  return walk(mapping, '');
}

const stable = (value) => (Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value);

// The keys a repair should leave as the bundled mapping has them (FR-04, D3):
// reported, never refused.
const SEMANTIC_KEYS = ['authority', 'file', 'overlap', 'semantics', 'usage_mode'];

export function canonicalMappingText(mapping) {
  return `${JSON.stringify(mapping, null, 2)}\n`;
}

export function keepMapping(config, { agent, file }) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size > MAX_MAPPING_FILE_BYTES) return { status: 'too_large', exitCode: 1, limit: MAX_MAPPING_FILE_BYTES };
  let mapping;
  try { mapping = readMapping(file, agent); } catch (error) {
    if (error.code !== 'MAPPING_INVALID') throw error;
    return { status: 'mapping_invalid', exitCode: 1, message: error.message, errors: error.errors };
  }
  const shipped = bundledMapping(agent);
  if (shipped.error) return { status: 'mapping_invalid', exitCode: 1, message: `the bundled ${agent} mapping is broken: ${shipped.error.message}`, errors: shipped.error.errors, mapping_origin: 'bundled' };
  const bundled = shipped.mapping;
  if (mapping.mapping_id === bundled.mapping_id) return { status: 'shadows_bundled', exitCode: 1, mapping_id: mapping.mapping_id };
  const unsafe = unsafeStringPath(mapping);
  if (unsafe) return { status: 'unsafe_string', exitCode: 1, key_path: unsafe };
  const target = userMappingFile(config, agent);
  try { atomicWriteJson(target, mapping, 0o600); } catch (error) {
    if (!isWriteRefused(error)) throw error;
    return { status: 'read_only', exitCode: 1 };
  }
  return {
    status: 'kept', exitCode: 0, path: target, mapping_id: mapping.mapping_id, mapping_version: mapping.mapping_version,
    differs_from_bundled: SEMANTIC_KEYS.filter((key) => JSON.stringify(stable(mapping[key])) !== JSON.stringify(stable(bundled[key])))
  };
}

// The mapping an import would use, printed for sharing as data (FR-05). It
// opens no session file.
export function exportMapping(config, { agent, file }) {
  let resolved;
  try { resolved = resolveMapping({ agent, file, config }); } catch (error) {
    if (error.code !== 'MAPPING_INVALID') throw error;
    return { status: 'mapping_invalid', exitCode: 1, message: error.message, errors: error.errors, mapping_origin: error.origin };
  }
  const unsafe = unsafeStringPath(resolved.mapping);
  if (unsafe) return { status: 'unsafe_string', exitCode: 1, key_path: unsafe, mapping_origin: resolved.origin };
  return { status: 'exported', exitCode: 0, text: canonicalMappingText(resolved.mapping), mapping_id: resolved.mapping.mapping_id, mapping_origin: resolved.origin };
}
