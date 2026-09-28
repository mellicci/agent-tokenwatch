import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IMPORT_REASONS, makeEvent } from '../src/schema.mjs';
import { sessionStateFile } from '../src/store.mjs';
import { runImport } from '../src/import/run.mjs';
import { importsFile, loadImportRuns, writeImportRun } from '../src/import/runs.mjs';
import { canonicalMappingText, exportMapping, keepMapping, userMappingFile } from '../src/import/override.mjs';
import { overlapCheck } from '../src/import/overlap.mjs';
import { undoImport } from '../src/import/undo.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { tempDir, testConfig } from './helpers.mjs';

// Intent 06: `tokenwatch import claude` end to end, over synthetic session
// files shaped like Claude Code's and poisoned with the things a transcript
// holds - a prompt, a reply, a file path, a secret - none of which may reach
// the ledger, the run record or the printed output.

const POISON = ['refactor the billing page', 'Here is the new code', '/home/alice/secret-project', 'sk-ant-api03-POISONPOISONPOISON',
  'C:\\Users\\alice\\secret-project', 'please rewrite the whole login flow'];
const SINCE = '2026-09-01T00:00:00.000Z';

function setup({ storeModelNames = true } = {}) {
  const root = tempDir();
  const sessions = path.join(root, 'claude-projects');
  fs.mkdirSync(sessions);
  const config = testConfig(path.join(root, 'tw'));
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  config.privacy.storeModelNames = storeModelNames;
  config.import = { claude: { sessionDir: sessions } };
  return { root, sessions, config };
}

const usage = (fresh, read, write, output) => ({
  input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output
});

// One Claude session file. Each response is written as two lines sharing its
// message id, as Claude Code streams it: the last carries the final output.
function writeSession(sessions, sessionId, responses, { project = 'proj-a' } = {}) {
  const dir = path.join(sessions, project);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const [index, response] of responses.entries()) {
    lines.push({ type: 'user', timestamp: response.ts, sessionId, cwd: POISON[2], message: { role: 'user', content: POISON[0] } });
    // Poisoned in keys as well as values: a key can be text too.
    lines.push({ type: 'attachment', timestamp: response.ts, sessionId, [POISON[5]]: POISON[4], files: { [POISON[4]]: POISON[5] } });
    const base = { type: 'assistant', timestamp: response.ts, sessionId, cwd: POISON[2] };
    const message = { id: response.id ?? `msg_${sessionId}_${index}`, model: 'claude-opus-5-5', role: 'assistant' };
    lines.push({ ...base, message: { ...message, content: [{ type: 'text', text: POISON[1] }], usage: { ...response.usage, output_tokens: 1 } } });
    lines.push({ ...base, message: { ...message, content: [{ type: 'text', text: POISON[3] }], usage: response.usage } });
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

// The operator's CLAUDE_CONFIG_DIR would otherwise point the import at their
// real session files.
const importHistory = (config, options) => runImport(config, { env: {}, ...options });

function ledger(config) {
  if (!fs.existsSync(config.dataFile)) return [];
  return fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function liveSample(sessionId, turnId, ts, fields) {
  return makeEvent({
    agent: 'claude', source: 'status', kind: 'usage', session_id: sessionId, turn_id: turnId, ts,
    usage: { ...fields, semantics: 'components', basis: 'sample' }
  });
}

function appendLive(config, events) {
  fs.appendFileSync(config.dataFile, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

function assertNoPoison(text, where) {
  for (const poison of POISON) assert.ok(!text.includes(poison), `${where} holds session-file text: ${poison}`);
}

const twoSessions = (sessions) => {
  writeSession(sessions, 'sess-b', [
    { ts: '2026-09-10T10:00:05.000Z', usage: usage(5, 100, 20, 7) }
  ]);
  writeSession(sessions, 'sess-a', [
    { ts: '2026-09-10T09:00:00.000Z', usage: usage(10, 0, 50, 30) },
    { ts: '2026-09-10T09:01:00.000Z', usage: usage(2, 60, 0, 40) }
  ], { project: 'proj-b' });
};

test('an accepted import writes numbers only, one row per response with its last figures, in time order', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(result.status, 'written');
  const rows = ledger(config);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.ts), [...rows.map((row) => row.ts)].sort(), 'appended in ascending ts');
  const first = rows[0];
  assert.equal(first.source, 'import');
  assert.equal(first.kind, 'usage');
  assert.equal(first.event_name, 'import.response');
  assert.equal(first.session_id, 'sess-a');
  assert.equal(first.turn_id, 'msg_sess-a_0');
  assert.equal(first.model, 'claude-opus-5-5');
  assert.match(first.project_id, /^project_[0-9a-f]{20}$/);
  assert.deepEqual(
    { basis: first.usage.basis, semantics: first.usage.semantics, fresh: first.usage.input_fresh, total: first.usage.input_total, output: first.usage.output },
    { basis: 'transcript', semantics: 'components', fresh: 10, total: 60, output: 30 },
    'the final line of the response wins over its partial first line'
  );
  assert.equal(first.cost, undefined, 'an import never prices a row');
  assert.deepEqual(first.import, { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: result.record.run_id, verification: 'unverified', reason: 'no_overlap' });
  assertNoPoison(fs.readFileSync(config.dataFile, 'utf8'), 'the ledger');
  const runs = loadImportRuns(config).runs;
  assert.equal(runs.length, 1);
  assert.ok(runs[0].finished_at, 'the run record is completed after the last row');
  assert.equal(runs[0].responses_written, 3);
  assert.equal(runs[0].sessions_imported, 2);
  assert.equal(runs[0].earliest_ts, '2026-09-10T09:00:00.000Z');
  assertNoPoison(fs.readFileSync(importsFile(config), 'utf8'), 'imports.json');
  assert.ok(!fs.readFileSync(importsFile(config), 'utf8').includes(sessions), 'imports.json holds no path');

  const again = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(again.record.responses_written, 0, 'a second run appends nothing');
  assert.equal(again.record.responses_skipped_duplicate, 3);
  assert.equal(ledger(config).length, 3);
});

test('an unverified import writes nothing without --accept-unverified, and dry-run and check never write', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const refused = await importHistory(config, { agent: 'claude', since: SINCE });
  assert.equal(refused.status, 'unverified');
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.overlap.reason, 'no_overlap');
  const dry = await importHistory(config, { agent: 'claude', since: SINCE, dryRun: true, acceptUnverified: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.record.responses_written, 3, 'a dry run counts what it would write');
  const check = await importHistory(config, { agent: 'claude', since: SINCE, check: true });
  assert.ok(check.probe.paths.some((entry) => entry.path === 'message.usage.output_tokens'));
  assertNoPoison(JSON.stringify(check), 'the check output');
  assert.equal(fs.existsSync(config.dataFile), false, 'nothing reached the ledger');
  assert.equal(fs.existsSync(importsFile(config)), false, 'no run was recorded');
});

test('a session live capture recorded, or one with a state file, is skipped whole', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  appendLive(config, [makeEvent({ agent: 'claude', source: 'hook', kind: 'lifecycle', session_id: 'sess-a', ts: '2026-09-10T08:59:00.000Z', event_name: 'SessionStart' })]);
  const stateFile = sessionStateFile(config, 'sess-b');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '{}');
  const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(result.record.sessions_skipped_live, 2);
  assert.equal(result.record.responses_written, 0);
  assert.equal(ledger(config).filter((row) => row.source === 'import').length, 0);
});

test('the overlap check finds the imported call behind each live turn by its input figures', async () => {
  const { sessions, config } = setup();
  writeSession(sessions, 'sess-o', [
    { ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 10, 5) },
    { ts: '2026-09-10T09:00:30.000Z', usage: usage(2, 10, 0, 6) },
    { ts: '2026-09-10T09:02:00.000Z', usage: usage(3, 12, 0, 7) },
    { ts: '2026-09-10T09:04:00.000Z', usage: usage(4, 15, 0, 8) }
  ]);
  const turn = (id, ts, fresh, read, write, output) => liveSample('sess-o', id, ts,
    { input_fresh: fresh, cache_read: read, cache_write: write, output });
  // Three live turns: the first ends after the second call, and each carries
  // that turn's last call.
  appendLive(config, [
    turn('t1', '2026-09-10T09:01:00.000Z', 2, 10, 0, 6),
    turn('t2', '2026-09-10T09:03:00.000Z', 3, 12, 0, 7),
    turn('t3', '2026-09-10T09:05:00.000Z', 4, 15, 0, 8)
  ]);
  const verified = await importHistory(config, { agent: 'claude', since: SINCE, check: true });
  assert.deepEqual(
    { verification: verified.overlap.verification, sessions: verified.overlap.sessions_compared, turns: verified.overlap.turns_compared, matched: verified.overlap.matched },
    { verification: 'verified', sessions: 1, turns: 3, matched: 3 }
  );
  const middle = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 5, output: 1 } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 6, output: 2 } },
    { session_id: 's', ts: '2026-09-10T09:04:00.000Z', usage: { input_total: 7, output: 3 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 5, output: 1, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:03:00.000Z', usage: { input_total: 6, output: 9, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:05:00.000Z', usage: { input_total: 7, output: 3, basis: 'sample' } }
  ]);
  assert.equal(middle.verification, 'unverified');
  assert.equal(middle.reason, 'mismatch');
  assert.deepEqual(middle.mismatches, [{ session_id: 's', turn_ts: '2026-09-10T09:03:00.000Z', field: 'output', live: 9, imported: 2, boundary: false }]);
  const edge = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 5, output: 1 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 4, output: 1, basis: 'sample' } }
  ]);
  assert.equal(edge.verification, 'verified', 'a mismatch on a first or last turn is a boundary, not a failure');
  assert.equal(edge.boundary_mismatches, 1);
  assert.equal(edge.by_field.input_total, 0, 'by_field counts only non-boundary mismatches');
  assert.deepEqual(middle.by_field, { input_total: 0, cache_read: 0, cache_write: 0, output: 1 });
  const empty = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 5, output: 1 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 5, output: 1, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 9, output: 9, basis: 'sample' } }
  ]);
  assert.deepEqual([empty.turns_compared, empty.mismatches.map((entry) => entry.field)], [2, ['input_total', 'output']],
    'a live turn whose figures no imported call has is a mismatch, never skipped');
  // D28, from the live test: the transcript stamps a call when it completes,
  // after the last render that caught it mid-stream; and a turn that starts
  // before its first call completes re-shows the previous call.
  const claudeOrder = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 100, cache_read: 90, cache_write: 5, output: 40 } },
    { session_id: 's', ts: '2026-09-10T09:02:04.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 380 } },
    { session_id: 's', ts: '2026-09-10T09:05:00.000Z', usage: { input_total: 170, cache_read: 160, cache_write: 2, output: 20 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 100, cache_read: 90, cache_write: 5, output: 40, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 5, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:03:00.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 380, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:06:00.000Z', usage: { input_total: 170, cache_read: 160, cache_write: 2, output: 20, basis: 'sample' } }
  ]);
  assert.deepEqual([claudeOrder.verification, claudeOrder.matched, claudeOrder.turns_compared], ['verified', 4, 4], JSON.stringify(claudeOrder.mismatches));
  // Many-to-one is intended: the second and third live turns both describe the
  // call stamped 09:02:04, one mid-stream and one re-shown. A rule allowing each
  // call to satisfy only one turn would bring back the defect D28 fixed.
  const oneCallPerTurn = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 380 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 380, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 150, cache_read: 140, cache_write: 6, output: 380, basis: 'sample' } }
  ]);
  assert.deepEqual([oneCallPerTurn.verification, oneCallPerTurn.matched], ['verified', 2], 'one imported call may stand for several live turns');
  const ahead = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 1, output: 1 } },
    { session_id: 's', ts: '2026-09-10T09:02:04.000Z', usage: { input_total: 150, output: 380 } },
    { session_id: 's', ts: '2026-09-10T09:05:00.000Z', usage: { input_total: 2, output: 1 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 1, output: 1, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 150, output: 400, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:06:00.000Z', usage: { input_total: 2, output: 1, basis: 'sample' } }
  ]);
  assert.deepEqual(ahead.mismatches.map((entry) => [entry.field, entry.live, entry.imported]), [['output', 400, 380]],
    'a gauge can be behind the final output, never ahead of it');
  const cleared = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 100, cache_read: 90, output: 4 } }
  ], [
    { session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 100, cache_read: 90, output: 4, basis: 'sample' } },
    { session_id: 's', ts: '2026-09-10T09:02:00.000Z', usage: { input_total: 0, cache_read: 0, cache_write: 0, output: 0, basis: 'sample' } }
  ]);
  assert.deepEqual([cleared.verification, cleared.turns_compared], ['verified', 1], 'a gauge of zeros describes no call');
  const increments = overlapCheck({ agent: 'claude', overlap: { compare: 'last_call_per_turn' } }, [
    { session_id: 's', ts: '2026-09-10T09:00:00.000Z', usage: { input_total: 5 } }
  ], [{ session_id: 's', ts: '2026-09-10T09:01:00.000Z', usage: { input_total: 5, basis: 'increment' } }]);
  assert.equal(increments.reason, 'no_overlap', 'only collapsed samples stand for a Claude turn');
});

test('the window, the model setting and a missing directory are honoured', async () => {
  const { sessions, config } = setup({ storeModelNames: false });
  writeSession(sessions, 'sess-old', [{ ts: '2026-08-01T09:00:00.000Z', usage: usage(1, 0, 0, 1) }]);
  const stale = writeSession(sessions, 'sess-stale', [{ ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 0, 1) }], { project: 'proj-c' });
  fs.utimesSync(stale, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
  writeSession(sessions, 'sess-new', [{ ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 0, 1) },
    { ts: '2026-09-10T09:01:00.000Z', usage: usage(0, 0, 0, 0) }], { project: 'proj-d' });
  const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(result.record.files_read, 2, 'a file untouched since the window opened is not read');
  assert.equal(result.record.responses_without_usage, 1, 'a response of zeros (an API error line) is counted, not imported');
  assert.deepEqual(ledger(config).map((row) => row.session_id), ['sess-new'], 'a record before the window is not imported');
  assert.equal(ledger(config)[0].model, undefined, 'storeModelNames: false keeps the model out');

  const missing = await importHistory({ ...config, import: { claude: { sessionDir: path.join(sessions, 'nope') } } }, { agent: 'claude', since: SINCE });
  assert.deepEqual([missing.status, missing.exitCode], ['no_directory', 1]);
});

test('a mapping that no longer fits the files, or maps prose as an id, stops before writing', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  const mapping = JSON.parse(fs.readFileSync(new URL('../src/import/mappings/claude.json', import.meta.url), 'utf8'));
  const write = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const selectsNothing = write('m1.json', { ...mapping, record: { ...mapping.record, select: [{ path: 'type', equals: 'assistant_v2' }] } });
  const nothing = await importHistory(config, { agent: 'claude', since: SINCE, mappingFile: selectsNothing, acceptUnverified: true });
  assert.deepEqual([nothing.status, nothing.exitCode], ['mapping_invalid', 1]);
  assertNoPoison(JSON.stringify(nothing.probe), 'the probe');
  const moved = write('m4.json', { ...mapping, record: { ...mapping.record, usage: { output: { path: 'message.usage_v2.output_tokens' } } } });
  assert.equal((await importHistory(config, { agent: 'claude', since: SINCE, mappingFile: moved, acceptUnverified: true })).status, 'mapping_invalid',
    'records it selects, but none carrying the numbers it names');
  const prose = write('m2.json', { ...mapping, record: { ...mapping.record, session_id: 'message.content' } });
  const proseRun = await importHistory(config, { agent: 'claude', since: SINCE, mappingFile: prose, acceptUnverified: true });
  assert.equal(proseRun.status, 'mapping_invalid');
  assert.equal(proseRun.rejected_identifiers, proseRun.records_matched);
  const script = write('m3.json', { ...mapping, script: 'rm -rf /' });
  assert.equal((await importHistory(config, { agent: 'claude', since: SINCE, mappingFile: script })).status, 'mapping_invalid');
  assert.equal(fs.existsSync(config.dataFile), false);
});

test('a read-only data directory reports data_directory_read_only and leaves no run behind', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  fs.writeFileSync(config.dataFile, '');
  fs.chmodSync(config.dataFile, 0o400);
  const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.deepEqual([result.status, result.reason, result.exitCode], ['read_only', 'data_directory_read_only', 1]);
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), '');
  assert.deepEqual(loadImportRuns(config).runs, [], 'the run record of a refused import is removed');
});

test('tokenwatch import is a command: it reads CLAUDE_CONFIG_DIR, prints counts, and refuses an unknown agent', () => {
  const root = tempDir();
  const claudeDir = path.join(root, 'claude-config');
  twoSessions(path.join(claudeDir, 'projects'));
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: path.join(root, 'tw'), CLAUDE_CONFIG_DIR: claudeDir };
  const dry = spawnSync(process.execPath, [cli, 'import', 'claude', '--since', '2026-09-01', '--dry-run', '--json'], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  const record = JSON.parse(dry.stdout);
  assert.equal(record.dry_run, true);
  assert.equal(record.responses_written, 3);
  assertNoPoison(dry.stdout + dry.stderr, 'the command output');
  const plain = spawnSync(process.execPath, [cli, 'import', 'claude', '--since', '2026-09-01'], { encoding: 'utf8', env });
  assert.equal(plain.status, 2, 'unverified without --accept-unverified');
  assert.match(plain.stderr, /nothing written/);
  const bareUndo = spawnSync(process.execPath, [cli, 'import', 'claude', '--undo'], { encoding: 'utf8', env });
  assert.equal(bareUndo.status, 1, 'an undo names the mapping it removes');
  const undo = spawnSync(process.execPath, [cli, 'import', 'claude', '--undo', 'claude-jsonl-1', '--dry-run'], { encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(undo.stdout), { removed: 0, kept: 0, dry_run: true });
  const unknown = spawnSync(process.execPath, [cli, 'import', 'gemini'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 1);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env });
  for (const flag of ['--check', '--dry-run', '--since', '--accept-unverified', '--mapping', '--undo', '--run']) assert.ok(help.stdout.includes(flag), flag);
});

// Codex: one token_usage_record per response, the session and project from the
// session header and the model from the turn header; the running token_count
// totals are only a self-check (D19).
function writeCodexRollout(dir, sessionId, calls, { total } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: '2026-09-10T09:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: POISON[2], instructions: POISON[0] } },
    { timestamp: '2026-09-10T09:00:00.100Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: POISON[2] } },
    { timestamp: '2026-09-10T09:00:00.200Z', type: 'response_item', payload: { type: 'message', content: [{ text: POISON[1] }] } }
  ];
  for (const [index, call] of calls.entries()) {
    lines.push({ timestamp: call.ts, type: 'token_usage_record', payload: {
      session_id: sessionId, response_id: `resp_${sessionId}_${index}`,
      usage: { input_tokens: call.input, cached_input_tokens: call.cached, cache_write_input_tokens: 0, output_tokens: call.output, reasoning_output_tokens: 1, total_tokens: call.input + call.output }
    } });
  }
  lines.push({ timestamp: '2026-09-10T09:30:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: total ? { total_token_usage: total } : null } });
  fs.writeFileSync(path.join(dir, `rollout-2026-09-10T09-00-00-${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

test('a Codex rollout imports one row per response, labelled as live Codex rows are, and checks itself against its totals', async () => {
  const root = tempDir();
  const sessions = path.join(root, 'codex-sessions');
  const config = testConfig(path.join(root, 'tw'));
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  config.import = { codex: { sessionDir: sessions } };
  writeCodexRollout(path.join(sessions, '2026', '09', '10'), 'codex-1', [
    { ts: '2026-09-10T09:01:00.000Z', input: 100, cached: 60, output: 10 },
    { ts: '2026-09-10T09:02:00.000Z', input: 200, cached: 150, output: 20 }
  ], { total: { input_tokens: 300, cached_input_tokens: 210, cache_write_input_tokens: 0, output_tokens: 31 } });
  const check = await importHistory(config, { agent: 'codex', since: SINCE, check: true });
  assert.deepEqual(check.summary_delta, [{ session_id: 'codex-1', input_total: 0, cache_read: 0, cache_write: 0, output: -1 }],
    'the per-call sum against the final running total, as information');
  const result = await importHistory(config, { agent: 'codex', since: SINCE, acceptUnverified: true });
  assert.equal(result.record.responses_written, 2);
  const rows = ledger(config);
  assert.deepEqual(rows.map((row) => [row.agent, row.session_id, row.turn_id, row.model]),
    [['codex-cli', 'codex-1', 'resp_codex-1_0', 'gpt-5.5'], ['codex-cli', 'codex-1', 'resp_codex-1_1', 'gpt-5.5']]);
  assert.deepEqual({ ...rows[1].usage }, { input_total: 200, input_fresh: 50, cache_read: 150, cache_write: 0, output: 20, reasoning: 1, total: 220, semantics: 'cached_subset', basis: 'transcript' });
  assert.match(rows[0].project_id, /^project_/);
  assertNoPoison(fs.readFileSync(config.dataFile, 'utf8'), 'the ledger');
  const mapping = JSON.parse(fs.readFileSync(new URL('../src/import/mappings/codex.json', import.meta.url), 'utf8'));
  const renamed = path.join(root, 'codex-renamed.json');
  fs.writeFileSync(renamed, JSON.stringify({ ...mapping, record: { ...mapping.record, select: [{ path: 'type', equals: 'token_usage_record_v2' }] } }));
  assert.equal((await importHistory(config, { agent: 'codex', since: SINCE, mappingFile: renamed, check: true })).status, 'mapping_invalid',
    'a self-check summary that still resolves does not make a mapping whose records are gone fit');
});

// Copilot: the session.shutdown summary is the session, and rises across
// resumes; model.model_call_success covers only some requests (D24).
function writeCopilotSession(sessions, sessionId, shutdowns, { calls = [] } = {}) {
  const dir = path.join(sessions, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { id: 'e0', timestamp: '2026-09-10T09:00:00.000Z', type: 'session.start', data: { sessionId, context: { cwd: POISON[2] } } },
    { id: 'e1', timestamp: '2026-09-10T09:00:01.000Z', type: 'user.message', data: { content: POISON[0] } }
  ];
  for (const call of calls) {
    lines.push({ id: `c${call.ts}`, timestamp: call.ts, type: 'model.model_call_success', data: {
      modelCall: { model: 'claude-sonnet-4.5' }, copilotUsage: { total_nano_aiu: 1000000000 },
      responseChunk: { id: `chunk-${call.ts}`, choices: [{ delta: { content: POISON[1] } }], usage: { prompt_tokens: call.prompt, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } }
    } });
  }
  for (const shutdown of shutdowns) {
    lines.push({ id: `s${shutdown.ts}`, timestamp: shutdown.ts, type: 'session.shutdown', data: {
      currentModel: 'claude-sonnet-4.5', totalNanoAiu: shutdown.nano, totalPremiumRequests: shutdown.premium,
      tokenDetails: { input: { tokenCount: shutdown.input }, cache_read: { tokenCount: shutdown.read }, cache_write: { tokenCount: shutdown.write }, output: { tokenCount: shutdown.output } },
      codeChanges: { filesModified: [POISON[2]] }
    } });
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

test('a Copilot session imports its last shutdown summary as one row, and is verified against live running totals', async () => {
  const root = tempDir();
  const sessions = path.join(root, 'copilot-state');
  const config = testConfig(path.join(root, 'tw'));
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  config.import = { copilot: { sessionDir: sessions } };
  writeCopilotSession(sessions, 'cop-1', [
    { ts: '2026-09-10T09:10:00.000Z', input: 5, read: 100, write: 20, output: 7, nano: 2000000000, premium: 1 },
    { ts: '2026-09-10T09:20:00.000Z', input: 9, read: 300, write: 40, output: 15, nano: 17184730000, premium: 3 }
  ], { calls: [{ ts: '2026-09-10T09:05:00.000Z', prompt: 50 }] });
  writeCopilotSession(sessions, 'cop-live', [
    { ts: '2026-09-10T10:20:00.000Z', input: 1, read: 10, write: 2, output: 3, nano: 1000000000, premium: 1 }
  ]);
  const snapshot = (ts, totals) => makeEvent({ agent: 'copilot', source: 'status', kind: 'usage', session_id: 'cop-live', ts, usage_cumulative: totals });
  appendLive(config, [
    snapshot('2026-09-10T10:00:00.000Z', { input_total: 5, cache_read: 4, cache_write: 1, output: 1 }),
    snapshot('2026-09-10T10:19:00.000Z', { input_total: 13, cache_read: 10, cache_write: 2, output: 3 })
  ]);
  const check = await importHistory(config, { agent: 'copilot', since: SINCE, check: true });
  assert.deepEqual({ verification: check.overlap.verification, sessions: check.overlap.sessions_compared }, { verification: 'verified', sessions: 1 },
    JSON.stringify(check.overlap));
  assert.deepEqual(check.summary_delta, [{ session_id: 'cop-1', input_total: 50 - 349, cache_read: -300, cache_write: -40, output: 3 - 15 }]);
  const result = await importHistory(config, { agent: 'copilot', since: SINCE });
  assert.equal(result.status, 'written');
  assert.equal(result.record.sessions_skipped_live, 1);
  const rows = ledger(config).filter((row) => row.source === 'import');
  assert.equal(rows.length, 1, 'one row per session: the last summary, never the per-call subset beside it');
  assert.deepEqual({ ...rows[0].usage }, { input_total: 349, input_fresh: 9, cache_read: 300, cache_write: 40, output: 15, total: 364, semantics: 'components', basis: 'transcript' });
  assert.deepEqual(rows[0].billing, { aiu: 17184730000 / 1e9, premium_requests: 3 });
  assert.equal(rows[0].turn_id, 'session-summary');
  assert.equal(rows[0].import.verification, 'verified');
  assertNoPoison(fs.readFileSync(config.dataFile, 'utf8'), 'the ledger');

  const off = overlapCheck({ agent: 'copilot', overlap: { compare: 'session_sum' } },
    [{ session_id: 'x', ts: '2026-09-10T10:20:00.000Z', usage: { input_total: 13, cache_read: 10, cache_write: 2, output: 4 } }],
    [{ session_id: 'x', ts: '2026-09-10T10:19:00.000Z', usage_cumulative: { input_total: 13, cache_read: 10, cache_write: 2, output: 3 } }]);
  assert.deepEqual([off.reason, off.mismatches.map((entry) => entry.field)], ['mismatch', ['output']]);
  const codexLive = overlapCheck({ agent: 'codex', overlap: { compare: 'session_sum' } },
    [{ session_id: 'x', ts: '2026-09-10T10:20:00.000Z', usage: { input_total: 30, output: 3 } }],
    [{ session_id: 'x', ts: '2026-09-10T10:19:00.000Z', usage: { input_total: 10, output: 1, basis: 'increment' } },
      { session_id: 'x', ts: '2026-09-10T10:19:30.000Z', usage: { input_total: 20, output: 2, basis: 'increment' } }]);
  assert.equal(codexLive.verification, 'verified', 'Codex sums live increments');
  const noTokens = overlapCheck({ agent: 'codex', overlap: { compare: 'session_sum' } },
    [{ session_id: 'x', ts: '2026-09-10T10:20:00.000Z', usage: { input_total: 30 } }],
    [{ session_id: 'x', ts: '2026-09-10T10:19:00.000Z', event_name: 'codex.tool_result' }]);
  assert.equal(noTokens.reason, 'no_live_tokens', 'a plain codex session recorded events but no tokens');
});

test('undo removes exactly one mapping\'s or one run\'s rows, keeps every other line byte for byte, and backs the ledger up', async () => {
  const { root, sessions, config } = setup();
  const liveRow = JSON.stringify(makeEvent({ agent: 'claude', source: 'hook', kind: 'lifecycle', session_id: 'live-1', ts: '2026-09-09T00:00:00.000Z', event_name: 'SessionStart' }));
  const foreign = JSON.stringify({ ...JSON.parse(liveRow), source: 'import', import: { mapping_id: 'other-mapping-1', run_id: 'r0' } });
  fs.writeFileSync(config.dataFile, `${liveRow}\n{"not json\n${foreign}\n`);
  writeSession(sessions, 'sess-1', [{ ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 0, 1) }]);
  const first = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  writeSession(sessions, 'sess-2', [{ ts: '2026-09-11T09:00:00.000Z', usage: usage(2, 0, 0, 2) }], { project: 'proj-2' });
  const second = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(second.record.responses_written, 1);
  const before = fs.readFileSync(config.dataFile, 'utf8');

  assert.deepEqual(undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', dryRun: true }), { removed: 2, kept: 3, dry_run: true });
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), before, 'a dry run writes nothing');
  assert.deepEqual(undoImport(config, { agent: 'claude', mappingId: 'no-such-mapping' }), { removed: 0, kept: 5, dry_run: false });
  assert.equal(fs.readdirSync(path.dirname(config.dataFile)).filter((name) => name.includes('.bak-')).length, 0, 'nothing to remove writes no backup');

  const one = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', runId: second.record.run_id });
  assert.equal(one.removed, 1);
  assert.equal(fs.readFileSync(one.backup, 'utf8'), before, 'the backup is the ledger as it was');
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), before.split('\n').filter((line) => !line.includes(second.record.run_id)).join('\n'));
  assert.deepEqual(loadImportRuns(config).runs.map((run) => Boolean(run.undone_at)), [false, true], 'only the undone run is marked');
  const rest = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', now: new Date(Date.now() + 1000) });
  assert.equal(rest.removed, 1);
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), `${liveRow}\n{"not json\n${foreign}\n`, 'the live row, an unreadable line and another mapping\'s row survive exactly');
  assert.ok(first.record.run_id);
});

// `tokenwatch import claude --undo codex-rollout-1` used to remove Codex's
// imported history: the undo filtered on the mapping id alone and never used the
// agent the user named. An undo now touches only that agent's rows and runs.
function importedRow(agent, mappingId, runId, sessionId) {
  return makeEvent({
    agent, source: 'import', kind: 'usage', event_name: 'import.response', ts: '2026-09-10T09:00:00.000Z',
    session_id: sessionId, turn_id: `resp-${sessionId}`,
    usage: { input_total: 10, output: 2, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: mappingId, mapping_version: '1.0', run_id: runId, verification: 'unverified', reason: 'no_overlap' }
  });
}

test('an undo never removes another agent\'s imported rows, and refuses an id that belongs only to another agent', () => {
  const { config } = setup();
  const rows = [
    importedRow('codex', 'codex-rollout-1', 'run-codex', 'codex-s1'),
    importedRow('claude', 'claude-jsonl-1', 'run-claude', 'claude-s1'),
    importedRow('claude', 'shared-1', 'run-shared-claude', 'claude-s2'),
    importedRow('copilot', 'shared-1', 'run-shared-copilot', 'copilot-s1')
  ];
  const before = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  fs.writeFileSync(config.dataFile, before);
  for (const [agent, mappingId, runId] of [['codex', 'codex-rollout-1', 'run-codex'], ['claude', 'claude-jsonl-1', 'run-claude'],
    ['claude', 'shared-1', 'run-shared-claude'], ['copilot', 'shared-1', 'run-shared-copilot']]) {
    writeImportRun(config, { run_id: runId, mapping_id: mappingId, agent, finished_at: '2026-09-10T09:00:01.000Z' });
  }
  const runsBefore = fs.readFileSync(importsFile(config), 'utf8');

  for (const dryRun of [true, false]) {
    const foreign = undoImport(config, { agent: 'claude', mappingId: 'codex-rollout-1', dryRun });
    assert.equal(foreign.removed, 0, `dry run ${dryRun}: another agent's rows are never removed`);
    assert.match(foreign.refused, /codex-rollout-1.*codex.*not claude.*tokenwatch import codex --undo codex-rollout-1/, `dry run ${dryRun}: the refusal names whose id it is`);
    const foreignRun = undoImport(config, { agent: 'claude', mappingId: 'codex-rollout-1', runId: 'run-codex', dryRun });
    assert.deepEqual([foreignRun.removed, Boolean(foreignRun.refused)], [0, true], `dry run ${dryRun}: --run cannot reach another agent's run either`);
    assert.equal(fs.readFileSync(config.dataFile, 'utf8'), before, `dry run ${dryRun}: the ledger is untouched`);
    assert.equal(fs.readFileSync(importsFile(config), 'utf8'), runsBefore, `dry run ${dryRun}: no run is marked undone`);
  }
  assert.equal(fs.readdirSync(path.dirname(config.dataFile)).filter((name) => name.includes('.bak-')).length, 0, 'a refused undo writes no backup');

  // One id two agents share: the named agent's rows go, the other's stay.
  assert.deepEqual(undoImport(config, { agent: 'claude', mappingId: 'shared-1', dryRun: true }), { removed: 1, kept: 3, dry_run: true });
  const shared = undoImport(config, { agent: 'claude', mappingId: 'shared-1' });
  assert.equal(shared.removed, 1);
  assert.deepEqual(ledger(config).map((row) => row.import.run_id), ['run-codex', 'run-claude', 'run-shared-copilot']);
  assert.deepEqual(loadImportRuns(config).runs.filter((run) => run.undone_at).map((run) => run.run_id), ['run-shared-claude'],
    'only the named agent\'s run is marked undone');

  const own = undoImport(config, { agent: 'codex', mappingId: 'codex-rollout-1', now: new Date(Date.now() + 1000) });
  assert.equal(own.removed, 1, 'the agent that owns the id undoes it');
  assert.deepEqual(ledger(config).map((row) => row.import.run_id), ['run-claude', 'run-shared-copilot']);
  assert.throws(() => undoImport(config, { mappingId: 'claude-jsonl-1' }), /agent/, 'an undo with no agent is a programming error, not an undo of every agent');
});

test('undo refuses while a live turn is pending or the ledger grows under it', async () => {
  const { sessions, config } = setup();
  writeSession(sessions, 'sess-1', [{ ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 0, 1) }]);
  await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  const before = fs.readFileSync(config.dataFile, 'utf8');
  const now = new Date();
  const stateFile = sessionStateFile(config, 'live-1');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ pending: { claude: { t1: { event: { ts: new Date(now.getTime() + 5).toISOString() } } } } }));
  const pending = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', now });
  assert.deepEqual([pending.removed, Boolean(pending.refused)], [0, true]);
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), before);
  fs.rmSync(stateFile);

  const statSync = fs.statSync;
  fs.statSync = (file, ...rest) => {
    const stat = statSync(file, ...rest);
    return file === config.dataFile ? { ...stat, size: stat.size + 1 } : stat;
  };
  try {
    const grown = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', now });
    assert.deepEqual([grown.removed, Boolean(grown.refused)], [0, true], 'a row appended since the read would be lost by the swap');
  } finally { fs.statSync = statSync; }
  assert.equal(fs.readFileSync(config.dataFile, 'utf8'), before);
  let calls = 0;
  fs.statSync = (file, ...rest) => {
    const stat = statSync(file, ...rest);
    if (file !== config.dataFile) return stat;
    calls += 1;
    return calls === 2 ? { ...stat, size: stat.size + 1 } : stat;
  };
  let late;
  try { late = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', now }); } finally { fs.statSync = statSync; }
  assert.equal(late.removed, 1);
  assert.match(late.warning, /changed during the undo.*\.bak-/, 'a row that lands after the swap is named, with the backup to compare');
});

// D26: a write that fails part-way leaves its rows and keeps its run record,
// unfinished and counted, so doctor names the one undo that removes them. The
// failure is injected by wrapping fs.writeSync for the import's own rows: a
// disk that fills on the second row cannot be staged with real bytes here
// (principles §2.5 lists this as a disclosed exception).
function failingWrites(failOn) {
  const writeSync = fs.writeSync;
  let seen = 0;
  fs.writeSync = function (fd, data, ...rest) {
    if (typeof data === 'string' && data.includes('"source":"import"')) {
      seen += 1;
      if (seen === failOn) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return writeSync.call(this, fd, data, ...rest);
  };
  return () => { fs.writeSync = writeSync; };
}

test('an import that fails on its Nth row keeps an unfinished, counted run record that doctor turns into an exact undo', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const restore = failingWrites(2);
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { restore(); }
  assert.deepEqual([result.status, result.written, result.of, result.code, result.exitCode], ['write_failed', 1, 3, 'ENOSPC', 1]);
  assert.equal(ledger(config).length, 1, 'the row before the failure stays');
  const [run] = loadImportRuns(config).runs;
  assert.equal(run.run_id, result.record.run_id);
  assert.equal(run.finished_at, undefined, 'the record says the run did not finish');
  assert.equal(run.responses_written, 1);
  assert.equal(run.latest_ts, ledger(config)[0].ts);
  const check = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:claude');
  assert.equal(check.status, 'warn');
  assert.ok(check.detail.includes(`--undo claude-jsonl-1 --run ${run.run_id}`), check.detail);
  assertNoPoison(fs.readFileSync(config.dataFile, 'utf8') + fs.readFileSync(importsFile(config), 'utf8'), 'a partial import');
  assert.equal(undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1', runId: run.run_id }).removed, 1);
  assert.equal(ledger(config).length, 0);
});

// D27: a short write does not throw, so it is caught by its byte count; the
// fragment is ended with a newline so the next append starts its own line.
test('a short write counts as a failure, is not counted as a row, and leaves the next append on a line of its own', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const writeSync = fs.writeSync;
  let seen = 0;
  fs.writeSync = function (fd, data, ...rest) {
    if (typeof data === 'string' && data.includes('"source":"import"') && ++seen === 2) return writeSync.call(this, fd, data.slice(0, 20), ...rest);
    return writeSync.call(this, fd, data, ...rest);
  };
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { fs.writeSync = writeSync; }
  assert.deepEqual([result.status, result.written, result.code], ['write_failed', 1, 'ESHORTWRITE']);
  assert.equal(loadImportRuns(config).runs[0].responses_written, 1, 'the fragment is not counted');
  fs.appendFileSync(config.dataFile, `${JSON.stringify(makeEvent({ agent: 'claude', source: 'hook', kind: 'lifecycle', session_id: 'live-9', ts: '2026-09-12T00:00:00.000Z', event_name: 'Stop' }))}\n`);
  const lines = fs.readFileSync(config.dataFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'row, fragment, live row: each on its own line');
  assert.equal(JSON.parse(lines[2]).session_id, 'live-9', 'the live row after the fragment still parses');
});

test('a partial write counts the sessions its written rows came from', async () => {
  const { sessions, config } = setup();
  for (const [index, id] of ['s-1', 's-2', 's-3'].entries()) {
    writeSession(sessions, id, [{ ts: `2026-09-10T0${index}:00:00.000Z`, usage: usage(1, 0, 0, 1) }], { project: `p-${id}` });
  }
  const restore = failingWrites(3);
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { restore(); }
  assert.equal(result.written, 2);
  const [run] = loadImportRuns(config).runs;
  assert.deepEqual([run.responses_written, run.sessions_imported, run.earliest_ts, run.latest_ts],
    [2, 2, '2026-09-10T00:00:00.000Z', '2026-09-10T01:00:00.000Z']);
});

// D27: the record written before the rows holds the plan only, so a run killed
// part-way (no throw, no rewrite) never shows doctor a count it did not measure.
test('before its rows, a run records only what it plans, and doctor says a killed run recorded no count', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const writeSync = fs.writeSync;
  let before;
  fs.writeSync = function (fd, data, ...rest) {
    if (before === undefined && typeof data === 'string' && data.includes('"source":"import"')) before = loadImportRuns(config).runs[0];
    return writeSync.call(this, fd, data, ...rest);
  };
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { fs.writeSync = writeSync; }
  assert.equal(result.status, 'written');
  assert.deepEqual([before.responses_written, before.sessions_imported, before.earliest_ts, before.finished_at], [undefined, undefined, undefined, undefined]);
  assert.deepEqual([before.responses_planned, before.sessions_planned, before.earliest_planned_ts], [3, 2, '2026-09-10T09:00:00.000Z']);
  const done = loadImportRuns(config).runs[0];
  assert.deepEqual([done.responses_written, done.sessions_imported, Boolean(done.finished_at)], [3, 2, true]);
  fs.writeFileSync(importsFile(config), JSON.stringify({ version: 1, runs: [before] }));
  const check = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:claude');
  // The plan is not a count; the rows of this run in the ledger are (#14).
  assert.match(check.detail, /recorded no count; 3 rows of this run are in the ledger \(it planned 3 responses from 2 sessions/);
  assert.doesNotMatch(check.detail, /were written/);
});

test('an unreadable imports.json that cannot be moved aside is never overwritten, and nothing is imported', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  fs.writeFileSync(importsFile(config), 'not json');
  const dir = path.dirname(config.dataFile);
  fs.chmodSync(dir, 0o500);
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { fs.chmodSync(dir, 0o700); }
  assert.deepEqual([result.status, result.exitCode], ['record_unreadable', 1]);
  assert.equal(fs.readFileSync(importsFile(config), 'utf8'), 'not json');
  assert.equal(fs.existsSync(config.dataFile), false);
});

test('an import whose first row fails leaves no rows and no run record, and says why', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const restore = failingWrites(1);
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { restore(); }
  assert.deepEqual([result.status, result.written, result.code], ['write_failed', 0, 'ENOSPC']);
  assert.deepEqual(ledger(config), []);
  assert.deepEqual(loadImportRuns(config), { runs: [], unreadable: false });
});

// #14: the writer's guard runs again before the plan is recorded, so a row it
// refuses stops the run with no record at all, not a record written and then
// taken back. Real bytes reach it: a mapping may name a billing unit (any
// lower-case word), and one named like a content field, here `message`,
// passes the mapping validator and `makeEvent`, and is refused only by
// `assertPrivacySafe`.
test('a row the privacy guard refuses stops the import before its run is planned, so imports.json is never written', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  const mapping = path.join(root, 'billing-named-message.json');
  fs.writeFileSync(mapping, JSON.stringify(claudeMappingWith((bundled) => ({
    record: { ...bundled.record, billing: { message: { path: 'message.usage.output_tokens' } } }
  }))));
  await assert.rejects(importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true, mappingFile: mapping }), /Unsafe field in normalized event: billing\.message/);
  assert.deepEqual(ledger(config), []);
  assert.equal(fs.existsSync(importsFile(config)), false, 'no run record was written, not even one taken back afterwards');
});

test('an unreadable imports.json is reported, set aside rather than overwritten, and never read as "no import ran"', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  fs.writeFileSync(importsFile(config), '{"version": 1, "runs": [ {"run_id": "r-old"');
  assert.deepEqual(loadImportRuns(config), { runs: [], unreadable: true });
  const doctor = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:runs');
  assert.equal(doctor?.status, 'warn');
  const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.equal(result.status, 'written');
  const aside = fs.readdirSync(path.dirname(config.dataFile)).filter((name) => name.startsWith('imports.json.unreadable-'));
  assert.equal(aside.length, 1, 'the unreadable record is kept beside the new one');
  assert.equal(fs.readFileSync(path.join(path.dirname(config.dataFile), aside[0]), 'utf8'), '{"version": 1, "runs": [ {"run_id": "r-old"');
  assert.deepEqual(loadImportRuns(config).runs.map((run) => run.run_id), [result.record.run_id]);
  fs.writeFileSync(importsFile(config), 'not json');
  const undone = undoImport(config, { agent: 'claude', mappingId: 'claude-jsonl-1' });
  assert.equal(undone.removed, 3);
  assert.match(undone.warning, /imports\.json could not be read/);
  assert.equal(fs.readFileSync(importsFile(config), 'utf8'), 'not json', 'undo does not rewrite a record it cannot read');
});

// Intent 19: a mapping the user kept beside the ledger outranks the bundled
// one; an explicit --mapping outranks both; the chosen tier must be valid.
function repairedClaude(extra = {}) {
  const bundled = JSON.parse(fs.readFileSync(new URL('../src/import/mappings/claude.json', import.meta.url), 'utf8'));
  return { ...bundled, mapping_id: 'claude-jsonl-1-r1', evidence: { ...bundled.evidence, repaired_from: 'claude-jsonl-1' }, ...extra };
}

test('a user-local mapping outranks the bundled one, an explicit --mapping outranks both, and origin is reported everywhere', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  assert.equal((await importHistory(config, { agent: 'claude', since: SINCE, dryRun: true })).record.mapping_origin, 'bundled');
  const userFile = userMappingFile(config, 'claude');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(repairedClaude()));
  const written = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
  assert.deepEqual([written.record.mapping_origin, written.record.mapping_id, written.record.repaired_from], ['user', 'claude-jsonl-1-r1', 'claude-jsonl-1']);
  assert.deepEqual([...new Set(ledger(config).map((row) => row.import.mapping_id))], ['claude-jsonl-1-r1'], 'rows are labelled with the repaired mapping');
  assert.deepEqual(Object.keys(ledger(config)[0].import).sort(), ['mapping_id', 'mapping_version', 'reason', 'run_id', 'verification'], 'the row\'s import block is unchanged');
  const [run] = loadImportRuns(config).runs;
  assert.deepEqual([run.mapping_origin, run.repaired_from], ['user', 'claude-jsonl-1']);

  fs.writeFileSync(userFile, 'not json');
  const explicit = path.join(root, 'explicit.json');
  fs.writeFileSync(explicit, JSON.stringify(repairedClaude({ mapping_id: 'claude-jsonl-1-r2' })));
  const withFile = await importHistory(config, { agent: 'claude', since: SINCE, dryRun: true, mappingFile: explicit });
  assert.deepEqual([withFile.status, withFile.record.mapping_origin, withFile.record.mapping_id], ['dry_run', 'file', 'claude-jsonl-1-r2'],
    'an explicit mapping wins, and the broken user-local file is not even read');
});

test('an invalid user-local mapping stops the import with its path and errors, and the bundled mapping is not used instead', async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const userFile = userMappingFile(config, 'claude');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  for (const [content, errors] of [['not json', ['<file:not_json>']], [JSON.stringify(repairedClaude({ semantics: 'guess' })), ['semantics']], [JSON.stringify(repairedClaude({ agent: 'codex' })), ['agent']]]) {
    fs.writeFileSync(userFile, content);
    const result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true });
    assert.deepEqual([result.status, result.exitCode, result.mapping_origin, result.mapping_path, result.errors], ['mapping_invalid', 1, 'user', userFile, errors]);
  }
  assert.equal(fs.existsSync(config.dataFile), false, 'nothing was imported through the bundled mapping');
  assert.equal(fs.readFileSync(userFile, 'utf8'), JSON.stringify(repairedClaude({ agent: 'codex' })), 'the broken file is left for the user');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const home = path.dirname(config.dataFile);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, import: { claude: { sessionDir: sessions } } }));
  const run = spawnSync(process.execPath, [cli, 'import', 'claude', '--dry-run'], { encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, CLAUDE_CONFIG_DIR: '' } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /the user-local claude mapping at .*mappings.claude\.json is not valid .*fix or remove that file/);
});

test('doctor names the mapping in use, warns on an invalid or bundled-id user-local file, and never touches it', async () => {
  const { config } = setup();
  const lines = () => runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.filter((entry) => entry.id.startsWith('import:mapping:'));
  assert.deepEqual(lines(), [], 'no user-local file, no line');
  const userFile = userMappingFile(config, 'claude');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(repairedClaude()));
  assert.deepEqual(lines().map((entry) => [entry.id, entry.status]), [['import:mapping:claude', 'ok']]);
  assert.match(lines()[0].detail, /user-local mapping claude-jsonl-1-r1 \(repaired from claude-jsonl-1\) at .* is used instead of the bundled claude-jsonl-1/);
  fs.writeFileSync(userFile, JSON.stringify(repairedClaude({ mapping_id: 'claude-jsonl-1' })));
  assert.match(lines()[0].detail, /uses the bundled id claude-jsonl-1/);
  assert.equal(lines()[0].status, 'warn');
  fs.writeFileSync(userFile, JSON.stringify(repairedClaude({ usage_mode: 'sometimes' })));
  assert.deepEqual([lines()[0].status, /usage_mode/.test(lines()[0].detail), /imports of claude will fail until it is fixed or removed/.test(lines()[0].detail)], ['warn', true, true]);
  assert.equal(fs.readFileSync(userFile, 'utf8'), JSON.stringify(repairedClaude({ usage_mode: 'sometimes' })), 'doctor reports, never rewrites');
  writeImportRun(config, { run_id: 'r-u', mapping_id: 'claude-jsonl-1-r1', mapping_origin: 'user', agent: 'claude', started_at: '2026-09-25T10:00:00.000Z', finished_at: '2026-09-25T10:00:01.000Z', responses_written: 3, sessions_imported: 1 });
  const run = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:claude');
  assert.match(run.detail, /\(mapping claude-jsonl-1-r1, user-local,/);
});

test('--keep-mapping keeps a valid repaired mapping beside the ledger and refuses each unsafe or shadowing one by name', () => {
  const { root, config } = setup();
  const file = (name, value) => { const target = path.join(root, name); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target; };
  const good = file('good.json', repairedClaude());
  const kept = keepMapping(config, { agent: 'claude', file: good });
  assert.deepEqual([kept.status, kept.exitCode, kept.mapping_id, kept.differs_from_bundled], ['kept', 0, 'claude-jsonl-1-r1', []]);
  const target = userMappingFile(config, 'claude');
  assert.equal(fs.readFileSync(target, 'utf8'), canonicalMappingText(repairedClaude()));
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const before = fs.readFileSync(target, 'utf8');
  assert.equal(keepMapping(config, { agent: 'claude', file: good }).status, 'kept');
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'keeping the same mapping twice leaves the same bytes');
  assert.deepEqual(keepMapping(config, { agent: 'claude', file: file('sem.json', repairedClaude({ semantics: 'cached_subset' })) }).differs_from_bundled, ['semantics'],
    'a changed meaning is reported, not refused');
  fs.writeFileSync(target, before);

  const refusals = {
    too_large: file('big.json', ' '.repeat(256 * 1024 + 1)),
    mapping_invalid: file('bad.json', 'not json'),
    shadows_bundled: file('shadow.json', repairedClaude({ mapping_id: 'claude-jsonl-1' })),
    unsafe_string: file('path.json', repairedClaude({ evidence: { note: 'probed from /home/alice/secret-project/s.jsonl', repaired_from: 'claude-jsonl-1' } }))
  };
  for (const [status, source] of Object.entries(refusals)) {
    const result = keepMapping(config, { agent: 'claude', file: source });
    assert.deepEqual([result.status, result.exitCode], [status, 1], status);
    assertNoPoison(JSON.stringify(result), `${status} refusal`);
  }
  assert.equal(keepMapping(config, { agent: 'claude', file: refusals.unsafe_string }).key_path, 'evidence.note');
  const secret = keepMapping(config, { agent: 'claude', file: file('secret.json', repairedClaude({ evidence: { note: `token ${POISON[3]}` } })) });
  assert.deepEqual([secret.status, secret.key_path], ['unsafe_string', 'evidence.note']);
  assert.equal(keepMapping(config, { agent: 'claude', file: file('prose.json', repairedClaude({ evidence: { note: 'the usage fields moved under message metrics in this release', repaired_from: 'claude-jsonl-1' } })) }).status, 'kept',
    'a note is prose by design, and prose alone is not refused');
  assert.equal(keepMapping(config, { agent: 'claude', file: file('codex.json', { ...JSON.parse(fs.readFileSync(new URL('../src/import/mappings/codex.json', import.meta.url), 'utf8')), mapping_id: 'codex-rollout-1-r1' }) }).status, 'mapping_invalid',
    'a mapping for another agent is refused');
  assert.equal(keepMapping(config, { agent: 'claude', file: path.join(root, 'missing.json') }).status, 'mapping_invalid');
  fs.writeFileSync(target, before);
  keepMapping(config, { agent: 'claude', file: refusals.shadows_bundled });
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'a refused keep leaves the kept file untouched');
});

test('a kept mapping round-trips through --export-mapping onto a fresh home byte for byte, and export names its origin', async () => {
  const first = setup();
  const second = setup();
  const repaired = path.join(first.root, 'r1.json');
  fs.writeFileSync(repaired, JSON.stringify(repairedClaude()));
  assert.deepEqual(exportMapping(first.config, { agent: 'claude' }).mapping_origin, 'bundled');
  keepMapping(first.config, { agent: 'claude', file: repaired });
  const exported = exportMapping(first.config, { agent: 'claude' });
  assert.deepEqual([exported.status, exported.mapping_origin, exported.mapping_id], ['exported', 'user', 'claude-jsonl-1-r1']);
  const shared = path.join(second.root, 'shared.json');
  fs.writeFileSync(shared, exported.text);
  assert.equal(keepMapping(second.config, { agent: 'claude', file: shared }).status, 'kept');
  assert.equal(fs.readFileSync(userMappingFile(second.config, 'claude'), 'utf8'), fs.readFileSync(userMappingFile(first.config, 'claude'), 'utf8'));
  twoSessions(second.sessions);
  assert.equal((await importHistory(second.config, { agent: 'claude', since: SINCE, dryRun: true })).record.mapping_origin, 'user');
  assert.equal(exportMapping(first.config, { agent: 'claude', file: repaired }).mapping_origin, 'file');

  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: path.dirname(first.config.dataFile) };
  fs.writeFileSync(path.join(path.dirname(first.config.dataFile), 'config.json'), JSON.stringify(first.config));
  const out = spawnSync(process.execPath, [cli, 'import', 'claude', '--export-mapping'], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, canonicalMappingText(repairedClaude()));
  assert.equal(out.stderr, 'mapping claude-jsonl-1-r1 (user)\n');
  const unsafe = path.join(first.root, 'unsafe.json');
  fs.writeFileSync(unsafe, JSON.stringify(repairedClaude({ evidence: { note: POISON[2] } })));
  const refused = spawnSync(process.execPath, [cli, 'import', 'claude', '--export-mapping', '--mapping', unsafe], { encoding: 'utf8', env });
  assert.deepEqual([refused.status, refused.stdout], [1, ''], 'nothing is printed to share when a string is unsafe');
  assert.doesNotMatch(refused.stderr, /alice/);
  const bare = spawnSync(process.execPath, [cli, 'import', 'claude', '--keep-mapping'], { encoding: 'utf8', env });
  assert.equal(bare.status, 1);
});

test('--keep-mapping on a read-only data directory refuses with read_only and writes nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { root, config } = setup();
  const source = path.join(root, 'r1.json');
  fs.writeFileSync(source, JSON.stringify(repairedClaude()));
  const dir = path.dirname(config.dataFile);
  fs.chmodSync(dir, 0o500);
  let result;
  try { result = keepMapping(config, { agent: 'claude', file: source }); } finally { fs.chmodSync(dir, 0o700); }
  assert.deepEqual([result.status, result.exitCode], ['read_only', 1]);
  assert.equal(fs.existsSync(userMappingFile(config, 'claude')), false);
});

// Intent 19: the --check diagnostics a repair is driven by. A Claude format
// where the usage block moved under message.metrics, as a new release might.
function writeMovedSession(sessions, sessionId, responses, { project = 'moved' } = {}) {
  const dir = path.join(sessions, project);
  fs.mkdirSync(dir, { recursive: true });
  const lines = responses.flatMap((response, index) => [
    { type: 'user', timestamp: response.ts, sessionId, cwd: POISON[2], message: { content: POISON[0] } },
    { type: 'assistant', timestamp: response.ts, sessionId, cwd: POISON[2],
      message: { id: `msg_${sessionId}_${index}`, model: 'claude-opus-5-5', content: [{ text: POISON[1] }], metrics: { usage: response.usage } } }
  ]);
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function claudeMappingWith(changes) {
  const bundled = JSON.parse(fs.readFileSync(new URL('../src/import/mappings/claude.json', import.meta.url), 'utf8'));
  return { ...bundled, mapping_id: 'claude-jsonl-1-r1', evidence: { repaired_from: 'claude-jsonl-1' }, ...changes(bundled) };
}

test('--check names the paths the files no longer carry, and a repaired mapping is verified while a wrong one is not', async () => {
  const { root, sessions, config } = setup();
  const calls = [
    { ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 10, 5) },
    { ts: '2026-09-10T09:02:00.000Z', usage: usage(3, 12, 0, 7) },
    { ts: '2026-09-10T09:04:00.000Z', usage: usage(4, 15, 0, 8) }
  ];
  writeMovedSession(sessions, 'sess-m', calls);
  const turn = (id, ts, fresh, read, write, output) => liveSample('sess-m', id, ts, { input_fresh: fresh, cache_read: read, cache_write: write, output });
  appendLive(config, [turn('t1', '2026-09-10T09:01:00.000Z', 1, 0, 10, 5), turn('t2', '2026-09-10T09:03:00.000Z', 3, 12, 0, 7), turn('t3', '2026-09-10T09:05:00.000Z', 4, 15, 0, 8)]);

  const broken = await importHistory(config, { agent: 'claude', since: SINCE, check: true });
  assert.deepEqual([broken.status, broken.diagnosis], ['mapping_invalid', 'paths_unresolved']);
  assert.deepEqual(broken.mapping_paths.unresolved.filter((dotted) => dotted.startsWith('message.usage.')),
    ['message.usage.cache_creation.ephemeral_1h_input_tokens', 'message.usage.cache_creation.ephemeral_5m_input_tokens', 'message.usage.cache_creation_input_tokens', 'message.usage.cache_read_input_tokens', 'message.usage.input_tokens', 'message.usage.output_tokens']);
  assert.ok(broken.mapping_paths.resolved.includes('type') && broken.mapping_paths.resolved.includes('message.id'));
  assert.ok(broken.probe.paths.some((entry) => entry.path === 'message.metrics.usage.output_tokens'), 'the probe shows where the numbers went');
  assertNoPoison(JSON.stringify(broken), 'the check of a broken mapping');

  const moveUsage = (bundled) => ({ record: { ...bundled.record, usage: Object.fromEntries(Object.entries(bundled.record.usage).map(([key, source]) => [key, { path: source.path.replace('message.usage.', 'message.metrics.usage.') }])) } });
  const repaired = path.join(root, 'r1.json');
  fs.writeFileSync(repaired, JSON.stringify(claudeMappingWith(moveUsage)));
  const fixed = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: repaired });
  assert.deepEqual([fixed.diagnosis, fixed.overlap.matched, fixed.record.mapping_origin], ['verified', 3, 'file'], JSON.stringify(fixed.overlap.mismatches));

  const outputRenamed = path.join(root, 'output-renamed.json');
  fs.writeFileSync(outputRenamed, JSON.stringify(claudeMappingWith((bundled) => {
    const moved = moveUsage(bundled).record;
    return { record: { ...moved, usage: { ...moved.usage, output: { path: 'message.metrics.usage.output_token_count' } } } };
  })));
  const oneField = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: outputRenamed });
  assert.deepEqual([oneField.diagnosis, oneField.mapping_paths.unresolved.includes('message.metrics.usage.output_token_count')], ['paths_unresolved', true],
    'one missing number path, on exactly the field the check disagrees on, is a repair');

  const wrong = path.join(root, 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify(claudeMappingWith((bundled) => {
    const moved = moveUsage(bundled).record;
    return { record: { ...moved, usage: { ...moved.usage, output: moved.usage.input_fresh, input_fresh: moved.usage.output } } };
  })));
  const swapped = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: wrong });
  assert.equal(swapped.diagnosis, 'mismatch', 'every path resolves, so a wrong proposal shows up as disagreement, not as a missing path');
  assert.ok(swapped.overlap.by_field.output >= 1, JSON.stringify(swapped.overlap.by_field));
});

test('--check says when a glob matches nothing, when an invalid mapping still has a probe, and when a renamed selector cannot be repaired from shapes', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  // A file-name tail is not an extension (review-fix, D11).
  fs.writeFileSync(path.join(sessions, `notes.${POISON[5]}`), 'x');
  const write = (name, value) => { const target = path.join(root, name); fs.writeFileSync(target, JSON.stringify(value)); return target; };
  const noGlob = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: write('glob.json', claudeMappingWith((bundled) => ({ file: { ...bundled.file, glob: '**/*.log' } }))) });
  assert.deepEqual([noGlob.diagnosis, noGlob.directory.matching_glob, noGlob.record.files_read], ['glob_matches_nothing', 0, 0]);
  assert.ok(noGlob.directory.files >= 2 && noGlob.directory.extensions['.jsonl'] >= 2);
  assert.doesNotMatch(JSON.stringify(noGlob.directory), /sess-|proj-/, 'no file or directory name');
  assertNoPoison(JSON.stringify(noGlob.directory), 'the directory counts');
  assert.equal(noGlob.directory.extensions['<other>'], 1, 'a tail that is not an extension is counted, never printed');

  const invalid = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: write('invalid.json', claudeMappingWith(() => ({ semantics: 'guess' }))) });
  assert.deepEqual([invalid.status, invalid.diagnosis, invalid.errors], ['mapping_invalid', 'mapping_invalid', ['semantics']]);
  assert.ok(invalid.probe.paths.some((entry) => entry.path === 'message.usage.output_tokens'), 'a probe built with the bundled glob');
  assert.equal(invalid.directory.matching_glob, 2);

  const renamed = await importHistory(config, { agent: 'claude', since: SINCE, check: true, mappingFile: write('renamed.json', claudeMappingWith((bundled) => ({ record: { ...bundled.record, select: [{ path: 'type', equals: 'assistant_message' }] } }))) });
  assert.equal(renamed.diagnosis, 'mapping_invalid', 'every essential path resolves but nothing is selected: a renamed value the probe cannot show (D1)');
  assert.ok(renamed.mapping_paths.resolved.includes('type'));
  assertNoPoison(JSON.stringify([noGlob, invalid, renamed]), 'the diagnostics');
});

test('--check counts files with records in a folder of two format eras, and a Codex extra live request is a mismatch, not a repair', async () => {
  const { sessions, config } = setup();
  writeSession(sessions, 'sess-new', [{ ts: '2026-09-10T09:00:00.000Z', usage: usage(1, 0, 0, 1) }]);
  writeMovedSession(sessions, 'sess-old-era', [{ ts: '2026-09-10T10:00:00.000Z', usage: usage(1, 0, 0, 1) }]);
  const mixed = await importHistory(config, { agent: 'claude', since: SINCE, check: true });
  assert.deepEqual([mixed.record.files_read, mixed.record.files_with_records], [2, 1]);

  const root = tempDir();
  const codexSessions = path.join(root, 'codex');
  const codexConfig = testConfig(path.join(root, 'tw'));
  fs.mkdirSync(path.dirname(codexConfig.dataFile), { recursive: true });
  codexConfig.import = { codex: { sessionDir: codexSessions } };
  writeCodexRollout(path.join(codexSessions, '2026'), 'codex-x', [{ ts: '2026-09-10T09:01:00.000Z', input: 100, cached: 60, output: 10 }]);
  const increment = (ts, fields) => makeEvent({ agent: 'codex', source: 'otlp', kind: 'usage', session_id: 'codex-x', ts, usage: { ...fields, semantics: 'cached_subset', basis: 'increment' } });
  appendLive(codexConfig, [increment('2026-09-10T09:00:30.000Z', { input_total: 90, output: 0 }), increment('2026-09-10T09:01:00.000Z', { input_total: 100, cache_read: 60, output: 10 })]);
  const codex = await importHistory(codexConfig, { agent: 'codex', since: SINCE, check: true });
  assert.equal(codex.diagnosis, 'mismatch');
  assert.ok(codex.mapping_paths.unresolved.every((dotted) => dotted.startsWith('payload.info.')),
    'only the self-check summary\'s paths are missing (this fixture\'s token_count has no info), and they do not count');
  assert.deepEqual(codex.overlap.by_field, { input_total: 1, cache_read: 0, cache_write: 0, output: 0 });
});

// Review-fix D11: any failure to read a mapping file is named, never a crash,
// in every tier, in keep, and in doctor.
test('an unreadable mapping file is refused by name everywhere, and doctor warns instead of dying', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  const userFile = userMappingFile(config, 'claude');
  fs.mkdirSync(userFile, { recursive: true });
  const run = await importHistory(config, { agent: 'claude', since: SINCE, dryRun: true });
  assert.deepEqual([run.status, run.mapping_origin], ['mapping_invalid', 'user']);
  assert.match(run.message, /could not be read \(EISDIR\)/);
  const report = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() });
  const line = report.checks.find((entry) => entry.id === 'import:mapping:claude');
  assert.deepEqual([line?.status, /could not be read/.test(line?.detail)], ['warn', true]);
  assert.equal(keepMapping(config, { agent: 'claude', file: userFile }).status, 'mapping_invalid');
  assert.equal(exportMapping(config, { agent: 'claude' }).status, 'mapping_invalid');
  const big = path.join(root, 'big.json');
  fs.writeFileSync(big, ' '.repeat(256 * 1024 + 1));
  const oversized = await importHistory(config, { agent: 'claude', since: SINCE, dryRun: true, mappingFile: big });
  assert.deepEqual([oversized.status, oversized.mapping_origin, /larger than Tokenwatch reads/.test(oversized.message)], ['mapping_invalid', 'file', true],
    'the size bound applies to --mapping and a user-local file too, not only to keep');
});

// Review-fix 2, D12: a broken bundled mapping (a damaged install) is refused by
// name wherever it is read, never a crash. Staged with real bytes: the package
// is copied to a temp folder and the copy's bundled mapping is broken, so the
// installed files are never touched.
test('a broken bundled mapping is a named refusal in doctor, keep and --check, never a crash', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const root = tempDir();
  const pkg = path.join(root, 'pkg');
  for (const part of ['bin', 'src', 'skills', 'package.json']) fs.cpSync(path.join(repo, part), path.join(pkg, part), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'src', 'import', 'mappings', 'claude.json'), 'not json');
  const home = path.join(root, 'tw');
  const sessions = path.join(root, 'claude-projects');
  twoSessions(sessions);
  const config = testConfig(home);
  config.import = { claude: { sessionDir: sessions } };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const kept = path.join(home, 'mappings', 'claude.json');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, JSON.stringify(repairedClaude()));
  const cli = path.join(pkg, 'bin', 'tokenwatch.mjs');
  const env = { ...process.env, TOKENWATCH_HOME: home, CLAUDE_CONFIG_DIR: '' };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });

  const doctor = run('doctor', '--json');
  const report = JSON.parse(doctor.stdout);
  const line = report.checks.find((entry) => entry.id === 'import:mapping:claude');
  assert.deepEqual([line?.status, /the bundled claude mapping at .* is broken/.test(line?.detail)], ['warn', true]);
  assert.ok(report.checks.length > 10, 'every other doctor check is still reported');

  const proposal = path.join(root, 'r2.json');
  fs.writeFileSync(proposal, JSON.stringify(repairedClaude({ mapping_id: 'claude-jsonl-1-r2' })));
  const keep = run('import', 'claude', '--keep-mapping', proposal);
  assert.equal(keep.status, 1);
  assert.match(keep.stderr, /^not kept \(mapping_invalid\): the bundled claude mapping is broken/);
  assert.doesNotMatch(keep.stderr, /^tokenwatch: /m, 'a refusal, not the top-level error printer');

  const invalid = path.join(root, 'invalid.json');
  fs.writeFileSync(invalid, JSON.stringify(repairedClaude({ semantics: 'guess' })));
  const check = run('import', 'claude', '--check', '--json', '--mapping', invalid);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /the bundled claude mapping is broken too .*so no probe was built/);
  assert.equal(JSON.parse(check.stdout).bundled_mapping_broken, true, 'the user\'s mapping is the invalid one, and the damaged install is flagged too');
  assert.doesNotMatch(check.stderr, /^tokenwatch: /m);
  const tooLarge = path.join(root, 'big.json');
  fs.writeFileSync(tooLarge, ' '.repeat(256 * 1024 + 1));
  assert.match(run('import', 'claude', '--keep-mapping', tooLarge).stderr, /larger than Tokenwatch reads \(\d+ bytes\)/, 'the too_large message shows the limit');

  // Third review, D13: with no mapping of the user's own, the damaged bundled
  // one is named as an install problem in every surface.
  fs.rmSync(kept);
  const plain = run('import', 'claude', '--dry-run', '--json');
  assert.equal(plain.status, 1);
  assert.deepEqual(JSON.parse(plain.stdout), { status: 'mapping_invalid', mapping_origin: 'bundled', errors: ['<file:not_json>'], bundled_mapping_broken: true });
  assert.match(plain.stderr, /^the bundled claude mapping is broken .*reinstall Tokenwatch$/m, 'not "does not fit these session files"');
  const checked = JSON.parse(run('import', 'claude', '--check', '--json').stdout);
  assert.deepEqual([checked.diagnosis, checked.mapping_origin, checked.bundled_mapping_broken], ['mapping_invalid', 'bundled', true]);
  const bare = JSON.parse(run('doctor', '--json').stdout).checks.find((entry) => entry.id === 'import:mapping:claude');
  assert.match(bare?.detail ?? '', /bundled claude mapping at .* is broken/, 'doctor reports a damaged install with no user-local mapping too');
});

// #14: the run record is written before the rows, so a run that stops must
// leave a record that says only what was measured. A disk that fills on the
// first row and stays full cannot remove the planned record either; the data
// directory is made read-only at that moment, with real bytes, so the record's
// own rewrite fails the way it would on a full disk (the fs.writeSync wrapper
// is the partial-write exception principles §2.5 discloses).
function writesThat(onImportRow) {
  const writeSync = fs.writeSync;
  let seen = 0;
  fs.writeSync = function (fd, data, ...rest) {
    if (typeof data === 'string' && data.includes('"source":"import"')) return onImportRow(++seen, () => writeSync.call(this, fd, data, ...rest));
    return writeSync.call(this, fd, data, ...rest);
  };
  return () => { fs.writeSync = writeSync; };
}

test('a run that wrote no rows is never reported as up to N, even when its record cannot be removed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const dir = path.dirname(config.dataFile);
  const restore = writesThat(() => {
    fs.chmodSync(dir, 0o500);
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  });
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { restore(); fs.chmodSync(dir, 0o700); }
  assert.deepEqual([result.status, result.written, result.code], ['write_failed', 0, 'ENOSPC']);
  assert.equal(result.record_left_unfinished, true, 'the command says the record it could not remove wrote nothing');
  assert.deepEqual(ledger(config), []);
  const check = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:claude');
  assert.doesNotMatch(check.detail, /up to \d+/, check.detail);
  assert.match(check.detail, /none of its rows are in the ledger/);
  assert.equal(check.status, 'info', 'nothing to undo');
});

test('an import whose rows all landed but whose record could not be finished names the exact undo instead of crashing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { sessions, config } = setup();
  twoSessions(sessions);
  const dir = path.dirname(config.dataFile);
  const restore = writesThat((seen, write) => {
    const written = write();
    if (seen === 3) fs.chmodSync(dir, 0o500);
    return written;
  });
  let result;
  try { result = await importHistory(config, { agent: 'claude', since: SINCE, acceptUnverified: true }); } finally { restore(); fs.chmodSync(dir, 0o700); }
  assert.deepEqual([result.status, result.written, result.of, result.exitCode], ['write_failed', 3, 3, 1]);
  assert.equal(ledger(config).length, 3);
  const [run] = loadImportRuns(config).runs;
  assert.deepEqual([run.run_id, run.finished_at, run.responses_written], [result.record.run_id, undefined, undefined], 'the record still holds only its plan');
  const check = runDoctor(config, '(test)', { env: {}, homeDir: tempDir() }).checks.find((entry) => entry.id === 'import:claude');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /3 rows of this run are in the ledger/);
  assert.ok(check.detail.endsWith(`--undo claude-jsonl-1 --run ${run.run_id}`), check.detail);
});

// #15: the skill branches on one JSON object. Every --check path prints it, with
// every documented field; a field that cannot exist on that path is null, never
// an invented zero.
const CHECK_FIELDS = ['diagnosis', 'session_dir', 'mapping_origin', 'errors', 'directory', 'mapping_paths', 'probe', 'overlap', 'summary_delta', 'would_write'];

test('--check --json always prints one JSON object with a diagnosis and every documented field', () => {
  const root = tempDir();
  const claudeDir = path.join(root, 'claude-config');
  twoSessions(path.join(claudeDir, 'projects'));
  const nowhere = path.join(root, 'nowhere');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const home = path.join(root, 'tw');
  const run = (configDir, ...args) => spawnSync(process.execPath, [cli, 'import', 'claude', '--since', '2026-09-01', '--check', '--json', ...args],
    { encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, CLAUDE_CONFIG_DIR: configDir } });
  const bundled = JSON.parse(fs.readFileSync(new URL('../src/import/mappings/claude.json', import.meta.url), 'utf8'));
  const write = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const invalid = write('invalid.json', { ...bundled, semantics: 'guess' });
  const outputs = {
    unverified: run(claudeDir),
    missingDirectory: run(nowhere),
    selectsNothing: run(claudeDir, '--mapping', write('selects-nothing.json', { ...bundled, record: { ...bundled.record, select: [{ path: 'type', equals: 'assistant_v2' }] } })),
    invalid: run(claudeDir, '--mapping', invalid),
    notJson: run(claudeDir, '--mapping', write('broken.json', `{"mapping_id": "${POISON[0]}`)),
    invalidAndMissing: run(nowhere, '--mapping', invalid)
  };
  const json = {};
  for (const [name, result] of Object.entries(outputs)) {
    assert.ok(result.stdout.trim(), `${name}: no JSON on stdout (stderr: ${result.stderr})`);
    json[name] = JSON.parse(result.stdout);
    assert.equal(typeof json[name].diagnosis, 'string', `${name}: a diagnosis`);
    for (const field of CHECK_FIELDS) assert.ok(field in json[name], `${name}: ${field} is missing`);
    assert.ok(Array.isArray(json[name].errors), `${name}: errors is always a list`);
    assertNoPoison(result.stdout + result.stderr, name);
  }
  assert.equal(outputs.unverified.status, 0);
  assert.deepEqual([json.unverified.diagnosis, json.unverified.errors, json.unverified.would_write.responses_written], ['no_overlap', [], 3]);

  const missing = json.missingDirectory;
  assert.equal(outputs.missingDirectory.status, 1);
  assert.deepEqual([missing.diagnosis, missing.session_dir, missing.mapping_origin, missing.errors], ['no_directory', path.join(nowhere, 'projects'), 'bundled', []]);
  assert.deepEqual([missing.directory, missing.probe, missing.overlap, missing.would_write], [null, null, null, null], 'nothing was read, so nothing is counted');

  const guard = json.selectsNothing;
  assert.deepEqual([guard.diagnosis, guard.session_dir, guard.mapping_origin, guard.errors], ['mapping_invalid', path.join(claudeDir, 'projects'), 'file', []]);
  assert.deepEqual([guard.overlap, guard.summary_delta, guard.would_write], [null, null, null], 'no overlap check ran and no row was chosen');
  assert.ok(guard.probe.paths.length && guard.mapping_paths.resolved.includes('type'));

  assert.deepEqual([json.invalid.diagnosis, json.invalid.errors, json.invalid.mapping_paths, json.invalid.would_write], ['mapping_invalid', ['semantics'], null, null]);
  assert.equal(json.invalid.session_dir, path.join(claudeDir, 'projects'));
  assert.deepEqual([json.notJson.diagnosis, json.notJson.errors], ['mapping_invalid', ['<file:not_json>']]);
  assert.deepEqual([json.invalidAndMissing.diagnosis, json.invalidAndMissing.errors], ['no_directory', ['semantics']],
    'the missing directory is the diagnosis, and the mapping is still named as invalid');
});

test('a mapping that cannot be read or parsed names why in errors, never an empty list', async () => {
  const { root, sessions, config } = setup();
  twoSessions(sessions);
  const write = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, text); return file; };
  const cases = {
    '<file:not_json>': write('broken.json', `{"note": "${POISON[0]}", `),
    '<file:unreadable>': path.join(root, 'missing.json'),
    '<file:too_large>': write('big.json', ' '.repeat(256 * 1024 + 1))
  };
  for (const [expected, mappingFile] of Object.entries(cases)) {
    for (const check of [true, false]) {
      const result = await importHistory(config, { agent: 'claude', since: SINCE, check, mappingFile });
      assert.deepEqual([result.status, result.errors], ['mapping_invalid', [expected]], `${expected}, check ${check}`);
      assertNoPoison(JSON.stringify(result), expected);
    }
  }
  assert.deepEqual(keepMapping(config, { agent: 'claude', file: cases['<file:not_json>'] }).errors, ['<file:not_json>'], 'keep names it the same way');
});

// #18: the reason on a row or a run record is the overlap check's verdict. A
// stopped run writes no row and keeps no record, so nothing else can be stored.
test('an imported row carries only a reason the overlap check can give', () => {
  assert.deepEqual([...IMPORT_REASONS].sort(), ['mismatch', 'no_live_tokens', 'no_overlap']);
  const row = (reason) => makeEvent({ agent: 'claude', source: 'import', kind: 'usage', session_id: 's-1', ts: SINCE,
    usage: { input_total: 1, output: 1, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'r-1', verification: 'unverified', reason } });
  for (const reason of IMPORT_REASONS) assert.equal(row(reason).import.reason, reason);
  for (const reason of ['mapping_invalid', 'data_directory_read_only']) assert.equal(row(reason).import.reason, undefined, `${reason} is a command's outcome, not a row's`);
});
