import { IMPORT_PROBE_FILES, MAX_IMPORT_PROBE_DEPTH, MAX_IMPORT_PROBE_ITEMS, MAX_IMPORT_PROBE_PATHS } from '../constants.mjs';
import { identifierOrUndefined } from '../privacy.mjs';
import { readSessionRecords } from './reader.mjs';

// What a person or an agent needs to see whether a mapping still fits a format:
// the key paths in the newest session files, the types found at each, and how
// often. Never a value, and a key that is not identifier-shaped (a path, a
// sentence) is shown as <key> (intent 06, D6).
export function shapeProbe(files, { maxFiles = IMPORT_PROBE_FILES, maxDepth = MAX_IMPORT_PROBE_DEPTH, maxPaths = MAX_IMPORT_PROBE_PATHS } = {}) {
  const counts = {};
  const paths = new Map();
  let truncated = false;
  const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const visit = (value, trail, depth) => {
    const key = trail.join('.');
    if (key) {
      let entry = paths.get(key);
      if (!entry) {
        if (paths.size >= maxPaths) { truncated = true; return; }
        entry = { path: key, types: new Set(), count: 0 };
        paths.set(key, entry);
      }
      entry.types.add(typeOf(value));
      entry.count += 1;
    }
    if (depth >= maxDepth || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_IMPORT_PROBE_ITEMS)) visit(item, [...trail, '[]'], depth + 1);
      return;
    }
    for (const [name, child] of Object.entries(value)) visit(child, [...trail, identifierOrUndefined(name) ?? '<key>'], depth + 1);
  };
  for (const file of files.slice(0, maxFiles)) {
    for (const record of readSessionRecords(file, counts)) visit(record, [], 0);
  }
  return {
    files: Math.min(files.length, maxFiles),
    lines: counts.lines ?? 0,
    oversized_lines: counts.oversized_lines ?? 0,
    malformed_lines: counts.malformed_lines ?? 0,
    truncated,
    paths: [...paths.values()].map((entry) => ({ path: entry.path, types: [...entry.types].sort(), count: entry.count }))
  };
}
