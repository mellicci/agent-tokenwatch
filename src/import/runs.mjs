import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, renameWithRetry } from '../fs-util.mjs';

// Every import run is recorded beside the ledger, before its first row and
// again after its last, so a run that stopped part-way is visible to `doctor`
// and removable by `--undo --run` (intent 06, D12). It holds counts, dates and
// ids, never session-file text or a path.
export function importsFile(config) {
  return path.join(path.dirname(config.dataFile), 'imports.json');
}

// The one read of the run record. A file that is missing holds no runs; a file
// that cannot be read is reported as `unreadable`, never taken for "no import
// ever ran", so nothing rewrites it unseen (D26).
export function loadImportRuns(config) {
  let text;
  try { text = fs.readFileSync(importsFile(config), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { runs: [], unreadable: false };
    return { runs: [], unreadable: true };
  }
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.runs)) return { runs: data.runs.filter((run) => run && typeof run === 'object'), unreadable: false };
  } catch {}
  return { runs: [], unreadable: true };
}

// A rewrite over an unreadable record first moves it aside, so what it held is
// kept for the user to inspect. When it cannot be moved, nothing is written
// over it (D27).
function saveRuns(config, runs, current) {
  if (current.unreadable) {
    try {
      renameWithRetry(importsFile(config), `${importsFile(config)}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    } catch {
      throw Object.assign(new Error('imports.json could not be read or moved aside'), { code: 'IMPORTS_UNREADABLE' });
    }
  }
  atomicWriteJson(importsFile(config), { version: 1, runs });
}

export function writeImportRun(config, run) {
  const current = loadImportRuns(config);
  saveRuns(config, [...current.runs.filter((entry) => entry.run_id !== run.run_id), run], current);
}

// A run whose append wrote no row at all leaves no record behind.
export function forgetImportRun(config, runId) {
  const current = loadImportRuns(config);
  const kept = current.runs.filter((entry) => entry.run_id !== runId);
  if (kept.length !== current.runs.length) saveRuns(config, kept, current);
}

// Only the named agent's runs are marked: another agent's run under the same
// mapping id was not undone.
export function markImportRunsUndone(config, { agent, mappingId, runId }) {
  const current = loadImportRuns(config);
  // An unreadable record has no runs, so it is returned untouched here.
  if (!current.runs.length) return { unreadable: current.unreadable };
  const undoneAt = new Date().toISOString();
  for (const run of current.runs) {
    if (run.agent === agent && run.mapping_id === mappingId && (runId === undefined || run.run_id === runId) && !run.undone_at) run.undone_at = undoneAt;
  }
  saveRuns(config, current.runs, current);
  return { unreadable: false };
}
