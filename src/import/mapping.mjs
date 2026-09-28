import fs from 'node:fs';
import { MAX_MAPPING_FILE_BYTES } from '../constants.mjs';
import { USAGE_KEYS } from '../schema.mjs';

// A mapping is data, not code (intent 06, D10): it says where in one agent's
// session-file format each number and identifier lives. Everything the format
// can change lives here, so a new format era is a new mapping file. The shape is
// closed: an unknown key, target or predicate is refused before any session
// file is opened.

const TOP_KEYS = ['mapping_id', 'mapping_version', 'agent', 'evidence', 'file', 'context', 'record', 'summary',
  'semantics', 'usage_mode', 'authority', 'overlap'];
const RECORD_KEYS = ['select', 'ts', 'session_id', 'response_id', 'model', 'project_path',
  'usage', 'usage_cumulative', 'billing', 'billing_cumulative'];
const CONTEXT_KEYS = ['select', 'session_id', 'model', 'project_path'];
const PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;
const UNIT = /^[a-z_]{1,32}$/;
// A mapping may be kept from a user's repair and shared as data (intent 19), so
// its free-standing strings are closed too: the evidence block has fixed keys
// and shapes, and a glob is a file-name pattern with no directory in it (D8).
const EVIDENCE = {
  agent_version: (value) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(value),
  probed_on: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  note: (value) => value.length <= 500,
  repaired_from: (value) => /^[a-z0-9-]{3,40}$/.test(value)
};
const GLOB = /^(\*\*\/)?[A-Za-z0-9_.*-]{1,80}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateMapping(mapping) {
  const errors = [];
  const fail = (where) => errors.push(where);
  if (!isObject(mapping)) return ['mapping'];
  for (const key of Object.keys(mapping)) if (!TOP_KEYS.includes(key)) fail(key);
  if (typeof mapping.mapping_id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(mapping.mapping_id)) fail('mapping_id');
  if (typeof mapping.mapping_version !== 'string' || !/^[0-9]+\.[0-9]+$/.test(mapping.mapping_version)) fail('mapping_version');
  if (!['claude', 'codex', 'copilot'].includes(mapping.agent)) fail('agent');
  if (mapping.evidence !== undefined) {
    if (!isObject(mapping.evidence)) fail('evidence');
    else for (const [key, value] of Object.entries(mapping.evidence)) {
      if (!EVIDENCE[key] || typeof value !== 'string' || !EVIDENCE[key](value)) fail(`evidence.${key}`);
    }
  }
  if (!isObject(mapping.file) || typeof mapping.file.glob !== 'string' || !GLOB.test(mapping.file.glob) || mapping.file.line_format !== 'jsonl'
    || Object.keys(mapping.file).some((key) => !['glob', 'line_format'].includes(key))) fail('file');
  if (!['components', 'cached_subset'].includes(mapping.semantics)) fail('semantics');
  if (!['per_call', 'running_total'].includes(mapping.usage_mode)) fail('usage_mode');
  if (!['per_call', 'summary', 'per_call_else_summary'].includes(mapping.authority)) fail('authority');
  if (!isObject(mapping.overlap) || !['last_call_per_turn', 'session_sum'].includes(mapping.overlap.compare)
    || Object.keys(mapping.overlap).length !== 1) fail('overlap');
  const select = (value, where) => {
    if (!Array.isArray(value) || !value.length) return fail(where);
    value.forEach((predicate, index) => {
      if (!isObject(predicate) || Object.keys(predicate).sort().join() !== 'equals,path' || !PATH.test(predicate.path ?? '')
        || !['string', 'number', 'boolean'].includes(typeof predicate.equals)) fail(`${where}.${index}`);
    });
  };
  const path = (value, where) => { if (value !== undefined && (typeof value !== 'string' || !PATH.test(value))) fail(where); };
  const numbers = (value, where, allowed) => {
    if (value === undefined) return;
    if (!isObject(value) || !Object.keys(value).length) return fail(where);
    for (const [target, source] of Object.entries(value)) {
      if (!allowed(target)) fail(`${where}.${target}`);
      else if (!isObject(source) || Object.keys(source).some((key) => !['path', 'scale'].includes(key)) || !PATH.test(source.path ?? '')
        || (source.scale !== undefined && !(Number.isFinite(source.scale) && source.scale > 0))) fail(`${where}.${target}`);
    }
  };
  const recordSpec = (value, where) => {
    if (!isObject(value)) return fail(where);
    for (const key of Object.keys(value)) if (!RECORD_KEYS.includes(key)) fail(`${where}.${key}`);
    select(value.select, `${where}.select`);
    for (const key of ['ts', 'session_id', 'response_id', 'model', 'project_path']) path(value[key], `${where}.${key}`);
    if (typeof value.ts !== 'string') fail(`${where}.ts`);
    const usage = (key) => USAGE_KEYS.includes(key);
    numbers(value.usage, `${where}.usage`, usage);
    numbers(value.usage_cumulative, `${where}.usage_cumulative`, usage);
    numbers(value.billing, `${where}.billing`, (key) => UNIT.test(key));
    numbers(value.billing_cumulative, `${where}.billing_cumulative`, (key) => UNIT.test(key));
    if (!value.usage && !value.usage_cumulative && !value.billing && !value.billing_cumulative) fail(`${where}.usage`);
  };
  recordSpec(mapping.record, 'record');
  if (mapping.summary !== undefined) recordSpec(mapping.summary, 'summary');
  if (mapping.authority !== 'per_call' && mapping.summary === undefined) fail('summary');
  if (mapping.context !== undefined) {
    if (!Array.isArray(mapping.context)) fail('context');
    else mapping.context.forEach((entry, index) => {
      if (!isObject(entry)) return fail(`context.${index}`);
      for (const key of Object.keys(entry)) if (!CONTEXT_KEYS.includes(key)) fail(`context.${index}.${key}`);
      select(entry.select, `context.${index}.select`);
      for (const key of ['session_id', 'model', 'project_path']) path(entry[key], `context.${index}.${key}`);
    });
  }
  return errors;
}

// One mapping file, parsed and validated for one agent. Every failure is a
// MAPPING_INVALID error with the validator's key paths, never the file's text:
// a JSON parse message quotes what it failed on (intent 06, D6).
// Any failure to read the file (missing, a directory, unreadable, too large)
// is a MAPPING_INVALID too, so every tier, keep, export and doctor name it
// rather than crash on it (review-fix, D11).
// A file that cannot be read or parsed never reached the validator, so it has
// no key path to name. Its `errors` entry names the failure instead, as a fixed
// token that carries no value from the file: an empty list would read as "the
// mapping validated" to a skill branching on it (#15).
export function readMapping(source, agent) {
  const invalid = (message, errors) => Object.assign(new Error(message), { code: 'MAPPING_INVALID', errors });
  let text;
  try {
    if (fs.statSync(source).size > MAX_MAPPING_FILE_BYTES) throw invalid(`the mapping file is larger than Tokenwatch reads (${MAX_MAPPING_FILE_BYTES} bytes)`, ['<file:too_large>']);
    text = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (error.code === 'MAPPING_INVALID') throw error;
    throw invalid(`the mapping file could not be read (${typeof error.code === 'string' ? error.code : 'unknown'})`, ['<file:unreadable>']);
  }
  let mapping;
  try { mapping = JSON.parse(text); } catch {
    throw invalid('the mapping file is not valid JSON', ['<file:not_json>']);
  }
  const errors = validateMapping(mapping);
  if (errors.length) throw invalid(`the mapping is not valid at: ${errors.join(', ')}`, errors);
  if (agent && mapping.agent !== agent) throw invalid(`the mapping is for ${mapping.agent}, not ${agent}`, ['agent']);
  return mapping;
}

// Every dotted path a mapping names, per part, for the --check diagnostic of
// which ones the session files still carry (intent 19, FR-07). Paths only.
export function mappingPaths(mapping, parts = ['record', 'summary', 'context']) {
  const found = new Set();
  const spec = (value) => {
    if (!value) return;
    for (const predicate of value.select ?? []) found.add(predicate.path);
    for (const key of ['ts', 'session_id', 'response_id', 'model', 'project_path']) if (value[key]) found.add(value[key]);
    for (const key of ['usage', 'usage_cumulative', 'billing', 'billing_cumulative']) {
      for (const source of Object.values(value[key] ?? {})) found.add(source.path);
    }
  };
  if (parts.includes('record')) spec(mapping.record);
  if (parts.includes('summary')) spec(mapping.summary);
  if (parts.includes('context')) for (const entry of mapping.context ?? []) spec(entry);
  return [...found].sort();
}

// The parts whose rows a mapping can write: the others are read only as a
// self-check (intent 06, D25), so a missing path there does not break an import.
export function writableParts(mapping) {
  if (mapping.authority === 'summary') return ['summary', 'context'];
  if (mapping.authority === 'per_call') return ['record', 'context'];
  return ['record', 'summary', 'context'];
}
