import fs from 'node:fs';
import { readJson, writeTextAtomic } from '../fs-util.mjs';
import { listSessionStateFiles } from '../store.mjs';
import { AGENT_NAMES } from '../constants.mjs';
import { loadImportRuns, markImportRunsUndone } from './runs.mjs';

// `tokenwatch import <agent> --undo <mapping id> [--run <run id>]` removes
// exactly the rows an import wrote, the way `repair` rewrites the ledger: a
// timestamped backup, then an atomic swap (intent 06, D12). Every other line is
// kept byte for byte, including one that does not parse.

function pendingSince(config, startMs) {
  for (const file of listSessionStateFiles(config)) {
    const state = readJson(file, null);
    for (const turns of Object.values(state?.pending ?? {})) {
      for (const pending of Object.values(turns ?? {})) {
        if (new Date(pending?.event?.ts).getTime() >= startMs) return true;
      }
    }
  }
  return false;
}

const shortAgent = (name) => (name in AGENT_NAMES ? name : Object.keys(AGENT_NAMES).find((key) => AGENT_NAMES[key] === name) ?? String(name));

// An undo removes only the rows of the agent it names: `import claude --undo
// codex-rollout-1` once removed Codex's history, because the mapping id alone
// chose the rows. An id that only another agent's rows or runs carry is refused,
// naming whose it is, and a dry run reports exactly what the undo would do.
// `pendingRows` are live turns not in the ledger yet (a dry run reads them from
// state instead of flushing them); they are never imported rows, so they are
// counted as kept.
export function undoImport(config, { agent, mappingId, runId, dryRun = false, pendingRows = [], now = new Date() }) {
  if (!(agent in AGENT_NAMES)) throw new TypeError('undoImport needs the agent whose imported rows it removes');
  const startMs = now.getTime();
  const matches = (mapping, run) => mapping === mappingId && (runId === undefined || run === runId);
  // A missing ledger has no rows to remove; its run records are still read,
  // so an id of another agent's is refused there too.
  let text = '';
  try { text = fs.readFileSync(config.dataFile, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const readBytes = Buffer.byteLength(text);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const kept = [];
  const others = new Set();
  let removed = 0;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch {}
    const imported = event?.source === 'import' && matches(event.import?.mapping_id, event.import?.run_id);
    if (imported && event.agent === AGENT_NAMES[agent]) removed += 1;
    else {
      if (imported) others.add(shortAgent(event.agent));
      kept.push(line);
    }
  }
  let ownRuns = 0;
  for (const run of loadImportRuns(config).runs) {
    if (!matches(run.mapping_id, run.run_id)) continue;
    if (run.agent === agent) ownRuns += 1;
    else others.add(shortAgent(run.agent));
  }
  const result = { removed, kept: kept.length + pendingRows.length, dry_run: dryRun };
  if (!removed && !ownRuns && others.size) {
    const id = runId === undefined ? mappingId : `${mappingId} run ${runId}`;
    const commands = [...others].map((other) => `tokenwatch import ${other} --undo ${mappingId}${runId === undefined ? '' : ` --run ${runId}`}`);
    return { ...result, refused: `${id} belongs to ${[...others].join(' and ')}'s imported history, not ${agent}'s; to remove it, run ${commands.join(' or ')}` };
  }
  if (dryRun || !removed) return result;
  // A live turn arriving now would be appended to the file this swap replaces.
  if (pendingSince(config, startMs) || fs.statSync(config.dataFile).size !== readBytes) {
    return { ...result, removed: 0, refused: 'the ledger is being written to by a live session; run the undo again when it is idle' };
  }
  const backup = `${config.dataFile}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(config.dataFile, backup);
  const keptText = kept.length ? `${kept.join('\n')}\n` : '';
  writeTextAtomic(config.dataFile, keptText, 0o600);
  result.backup = backup;
  if (fs.statSync(config.dataFile).size !== Buffer.byteLength(keptText)) {
    result.warning = `the ledger changed during the undo; compare it with the backup at ${backup}`;
  }
  if (markImportRunsUndone(config, { agent, mappingId, runId }).unreadable) {
    result.warning = [result.warning, 'imports.json could not be read, so the undone runs are not marked in it'].filter(Boolean).join('; ');
  }
  return result;
}
