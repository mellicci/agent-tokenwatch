import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectEvents, flushPendingTurns, loadState, storeEvent } from '../src/store.mjs';
import { makeEvent } from '../src/schema.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { main } from '../src/cli.mjs';
import { tempDir, testConfig } from './helpers.mjs';

function cumulative(sessionId, amount, turn) {
  return makeEvent({
    agent: 'claude-code', kind: 'usage', source: 'statusline', event_name: 'status',
    session_id: sessionId, turn_id: `t${turn}`,
    cost: { cumulative_usd: amount, basis: 'provider_reported', currency: 'USD' },
    flags: { cost_cumulative: true },
    usage: { input_total: 100, basis: 'sample' }
  });
}

async function spendFrom(config, readings) {
  readings.forEach(([sessionId, amount], index) => storeEvent(cumulative(sessionId, amount, index), config));
  flushPendingTurns(config);
  const events = await collectEvents(config, {});
  const deltas = events.map((event) => event.cost?.delta_usd).filter((value) => value !== undefined);
  return Number(deltas.reduce((total, value) => total + value, 0).toFixed(6));
}

// Two sessions of one agent, A going 10 to 12 and B going 3 to 5, so four
// dollars of real spend.
const INTERLEAVED = [['A', 10], ['B', 3], ['A', 12], ['B', 5]];

test('interleaved sessions each diff against their own baseline', async () => {
  const config = testConfig(tempDir());
  assert.equal(await spendFrom(config, INTERLEAVED), 4);
});

// Without a session id every session of one agent shared the `no-session`
// bucket, so the readings above interleaved: each looked like the other
// restarting its counter and the diff spanned both, reporting 9 against a true
// 4. Silently, with the status line as confident either way.
test('a cumulative record with no session id is not diffed at all', async () => {
  const config = testConfig(tempDir());
  const unkeyed = INTERLEAVED.map(([, amount]) => [undefined, amount]);
  assert.equal(await spendFrom(config, unkeyed), 0, 'no spend may be invented from an unkeyable record');
});

// Losing a delta is the safe direction, but it must not be the quiet one: a
// count of zero here is what tells you the agents are still sending session ids.
test('refusing to diff is counted, not swallowed', async () => {
  const config = testConfig(tempDir());
  await spendFrom(config, INTERLEAVED.map(([, amount]) => [undefined, amount]));
  assert.equal(loadState(config, undefined).counters.unkeyed, 4);

  const report = runDoctor(config, path.join(path.dirname(config.dataFile), 'config.json'));
  const check = report.checks.find((entry) => entry.id === 'cumulative-session-keys');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /4 cumulative record/);
});

test('a healthy ledger reports the check as ok', async () => {
  const config = testConfig(tempDir());
  await spendFrom(config, INTERLEAVED);
  const report = runDoctor(config, path.join(path.dirname(config.dataFile), 'config.json'));
  const check = report.checks.find((entry) => entry.id === 'cumulative-session-keys');
  assert.equal(check.status, 'ok');
});

// `appendToLedger` has two callers. `storeEvent` guards its own write twice;
// `flushTurn` writes an event that has since round-tripped through the state
// file on disk, so nothing in the process saw what actually came back.
test('a turn flushed from state is re-checked before it reaches the ledger', async () => {
  const config = testConfig(tempDir());
  storeEvent(cumulative('A', 1, 0), config);

  // Tamper with the buffered turn exactly as something with local write access
  // to the state file could, then flush it.
  const stateFile = path.join(path.dirname(config.stateFile), 'sessions',
    fs.readdirSync(path.join(path.dirname(config.stateFile), 'sessions'))[0]);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const turnKey = Object.keys(state.pending['claude-code'])[0];
  state.pending['claude-code'][turnKey].event.prompt = 'content that must never be recorded';
  fs.writeFileSync(stateFile, JSON.stringify(state));

  flushPendingTurns(config);
  const ledger = fs.existsSync(config.dataFile) ? fs.readFileSync(config.dataFile, 'utf8') : '';
  assert.equal(ledger.includes('must never be recorded'), false, 'the tampered turn must not be written');
  assert.equal(ledger.trim(), '', 'and it is dropped rather than written stripped');
});

// `retentionDays` was a documented default that nothing read.
test('doctor reports a ledger older than the configured retention', () => {
  const root = tempDir();
  const config = testConfig(root);
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  fs.writeFileSync(config.dataFile, `${JSON.stringify({
    schema: 'tokenwatch.event/v1', event_id: 'a', ts: old,
    agent: 'claude-code', kind: 'usage', source: 'statusline'
  })}\n`);
  const check = runDoctor(config, path.join(root, 'config.json')).checks.find((entry) => entry.id === 'retention');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /200d old/);
  assert.match(check.detail, /prune --retention/);
});

test('a ledger inside the window reports retention as ok', () => {
  const root = tempDir();
  const config = testConfig(root);
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  fs.writeFileSync(config.dataFile, `${JSON.stringify({
    schema: 'tokenwatch.event/v1', event_id: 'a', ts: recent,
    agent: 'claude-code', kind: 'usage', source: 'statusline'
  })}\n`);
  const check = runDoctor(config, path.join(root, 'config.json')).checks.find((entry) => entry.id === 'retention');
  assert.equal(check.status, 'ok');
});

// Found by tripping over it: `main` accepted `{ config }` and ignored it,
// loading from the environment instead. A test that passed a scratch config
// believed it was sandboxed while driving a destructive command against the
// caller's real `~/.tokenwatch`. The ledger survived here only because it was
// younger than the retention window.
test('main operates on an injected config rather than the environment', async () => {
  const root = tempDir();
  const config = testConfig(root);
  const stamp = (iso) => `${JSON.stringify({
    schema: 'tokenwatch.event/v1', event_id: iso, ts: iso,
    agent: 'claude-code', kind: 'usage', source: 'statusline'
  })}\n`;
  fs.writeFileSync(config.dataFile,
    stamp(new Date(Date.now() - 200 * 86_400_000).toISOString())
    + stamp(new Date(Date.now() - 2 * 86_400_000).toISOString()));

  const before = fs.existsSync(process.env.HOME ? `${process.env.HOME}/.tokenwatch/events.jsonl` : '/nonexistent')
    ? fs.statSync(`${process.env.HOME}/.tokenwatch/events.jsonl`).mtimeMs
    : undefined;

  await main(['prune', '--retention'], { config, configFile: path.join(root, 'config.json') });

  assert.equal(fs.readFileSync(config.dataFile, 'utf8').split('\n').filter(Boolean).length, 1,
    'the injected ledger is the one that was pruned');
  if (before !== undefined) {
    assert.equal(fs.statSync(`${process.env.HOME}/.tokenwatch/events.jsonl`).mtimeMs, before,
      'and the real ledger was not touched');
  }
});
