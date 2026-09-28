import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, symlinkUnavailable, tempDir, testConfig } from './helpers.mjs';
import { collectEvents, loadState, sessionStateFile, storeEvent, subagentWindowKey, tryFlushPendingTurns } from '../src/store.mjs';
import { acquireStateLock, releaseStateLock, stateLockFile } from '../src/state-lock.mjs';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { repairLedger } from '../src/repair.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'tokenwatch.mjs');

// Every hook is its own short-lived process, and Claude Code starts them as
// the events happen: two background subagents launched together are two
// SubagentStart hooks at the same instant. Each process reads the session's
// state file, changes it and writes it back. Without a lock one of two
// simultaneous starts was lost, so `active` reached 1, the first stop
// completed it and every later stop was ignored as having nothing running:
// measured live on Windows as "1 completed" for two subagents, and reproduced
// here as 9, 7 and 7 of 10 starts.
//
// Each hook runs under TOKENWATCH_DEBUG=1, which makes one that had to store
// without the lock say so on its stderr. That is the count the assertions
// trust: the state file's own `unlocked_writes` is kept in the very file an
// overlapping write can overwrite, so it can undercount, while a process's
// stderr cannot be lost.
const UNLOCKED = /stored without it/;

function hook(home, event, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'hook', 'claude', event, JSON.stringify(payload), '--strict'], {
      env: { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_DEBUG: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

function subagentPayload(event, session, index) {
  return {
    session_id: session,
    prompt_id: 'race-prompt',
    hook_event_name: event,
    agent_type: 'general-purpose',
    // Distinct instants, so no two hooks share a fingerprint and every one of
    // them is a real, separate observation the store must keep.
    timestamp: `2026-09-28T10:00:${String(index).padStart(2, '0')}.000Z`
  };
}

// The lock makes the state exact only while every write held it. A write that
// ran out of budget is stored without it, may then lose an update, and says so;
// so the exact count is asserted whenever no hook said so, and otherwise every
// shortfall must come with an unlocked write to explain it and nothing may be
// counted that did not happen. On a loaded machine that branch is what keeps
// this test honest rather than flaky; code without the lock never says so and
// loses updates, and fails the exact branch.
test('simultaneous subagent hooks for one session lose no update to its state while every write holds the lock', async (t) => {
  const home = tempDir();
  const session = 'race-s1';
  const count = 16;
  const opened = spawnSync(process.execPath, [cli, 'hook', 'claude', 'SessionStart',
    JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }), '--strict'], { env: { ...process.env, TOKENWATCH_HOME: home } });
  assert.equal(opened.status, 0, String(opened.stderr));

  const config = testConfig(home);
  const stateFile = sessionStateFile(config, session);
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const window = () => state().subagentWindows[subagentWindowKey('claude-code', session)];
  const rows = () => fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((row) => row.kind === 'subagent');

  const starts = await Promise.all(Array.from({ length: count }, (_, i) => hook(home, 'SubagentStart', subagentPayload('SubagentStart', session, i))));
  for (const result of starts) assert.equal(result.status, 0, result.stderr);
  const unlockedStarts = starts.filter((result) => UNLOCKED.test(result.stderr)).length;
  assert.equal(rows().length, count, 'the ledger keeps every start, locked or not');
  if (unlockedStarts === 0) {
    assert.equal(window().active, count, `every start is still running in state, got ${window().active} of ${count}`);
  } else {
    t.diagnostic(`${unlockedStarts} of ${count} starts ran out of lock budget on this machine`);
    assert.ok(window().active <= count && window().active >= 1, `no start is invented, got ${window().active} of ${count}`);
  }

  const stops = await Promise.all(Array.from({ length: count }, (_, i) => hook(home, 'SubagentStop', subagentPayload('SubagentStop', session, 30 + i))));
  for (const result of stops) assert.equal(result.status, 0, result.stderr);
  const unlocked = unlockedStarts + stops.filter((result) => UNLOCKED.test(result.stderr)).length;
  assert.equal(rows().length, count * 2, 'the ledger keeps every stop');
  const counted = Number(state().counters.unlocked_writes ?? 0);
  assert.ok(counted <= unlocked, `the state counts no unlocked write that did not happen (${counted} counted, ${unlocked} said so)`);

  if (unlocked === 0) {
    assert.equal(window().completed, count, `every subagent is counted once, got ${window().completed} of ${count}`);
    assert.equal(window().active, 0);
    assert.equal(counted, 0);
    const status = spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', '--json', '--session', session], {
      encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home }
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).subagent_count, count, 'the status line reports what the ledger holds');
  } else {
    t.diagnostic(`${unlocked} of ${count * 2} hooks ran out of lock budget on this machine`);
    assert.ok(window().completed <= count, `no subagent is completed twice, got ${window().completed}`);
    assert.ok(window().active >= 0);
  }
  const leftovers = fs.readdirSync(path.dirname(stateFile)).filter((name) => !name.endsWith('.json'));
  assert.deepEqual(leftovers, [], 'no lock, takeover guard or temporary file is left behind');
});

// The cases below plant a lock file the way another Tokenwatch process would
// leave one, and drive the store in-process. None of them waits on a clock: a
// budget of 0 means "no waiting at all", so a lock that is taken over was
// taken over on sight, and one that is not shows up as an unlocked write.
//
// A live holder other than this process is the test runner that started it
// (`process.ppid`): a lock carrying this process's own id is, by design, one a
// previous process with the same id left behind.
const LIVE_OTHER = process.ppid;

function subagentStart(config, session = 'lock-s1', index = 0) {
  return normalizeClaude('SubagentStart', subagentPayload('SubagentStart', session, index), config, 'hook')[0];
}

// A lock exactly as another process on this machine would hold it: taken for
// real, then handed to `holder.pid` under a token this test never releases.
function plantLock(stateFile, holder, file) {
  const lock = acquireStateLock(stateFile);
  assert.equal(lock.held, true);
  const record = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
  const target = file ?? lock.file;
  if (target !== lock.file) fs.unlinkSync(lock.file);
  fs.writeFileSync(target, JSON.stringify({ ...record, token: 'planted', ...holder }));
  return target;
}

function ageFile(file, ms = 60_000) {
  const old = new Date(Date.now() - ms);
  fs.utimesSync(file, old, old);
}

function exitedPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function ledgerRows(config) {
  if (!fs.existsSync(config.dataFile)) return [];
  return fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function nonStateFiles(stateFile) {
  return fs.readdirSync(path.dirname(stateFile)).filter((name) => !name.endsWith('.json'));
}

test('a lock left by a process that has exited is taken over at once, not waited out', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: exitedPid() });

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  const state = loadState(config, 'lock-s1');
  assert.equal(state.counters.unlocked_writes, undefined, 'the dead holder\'s lock was taken, so the write was locked');
  assert.equal(state.subagentWindows[subagentWindowKey('claude-code', 'lock-s1')].active, 1);
  assert.equal(fs.existsSync(lock), false, 'the lock is released after the write, and no other file is left');
  assert.deepEqual(nonStateFiles(stateFile), []);
});

// Windows hands out a process id again soon after its process exits. A lock
// with this process's id was not taken by this process, which holds no lock
// on the file while it asks for one, so its holder has exited.
test('a lock carrying this process\'s id but another token is taken over at once as left by an exited process', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: process.pid });

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, undefined, 'the write held the lock');
  assert.equal(fs.existsSync(lock), false);
});

test('a lock held longer than any write takes is taken over even while its holder runs', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  // The holder is alive, so only the lock's age can make it stale.
  const lock = plantLock(stateFile, { pid: LIVE_OTHER });
  ageFile(lock);

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, undefined);
  assert.equal(fs.existsSync(lock), false);
});

test('a live holder\'s lock a few seconds old is not taken over: only past twice the hook timeout does age alone make a lock stale', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: LIVE_OTHER });
  ageFile(lock, 5_000);

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1, 'the write went ahead without the lock');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'planted', 'and the holder keeps it');
});

// Telemetry must not break the session it watches: a hook that cannot get the
// lock in time still records the event, rather than blocking or dropping it.
test('a lock another process holds does not stop the event: its row is appended, its state written, and the write counted', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: LIVE_OTHER });

  const result = storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(result.stored, true);
  assert.equal(result.unlocked, true, 'the caller is told the write went without the lock');
  assert.equal(ledgerRows(config).filter((row) => row.kind === 'subagent').length, 1, 'the ledger row is appended without the lock');
  const state = loadState(config, 'lock-s1');
  assert.equal(state.subagentWindows[subagentWindowKey('claude-code', 'lock-s1')].active, 1, 'the state is still updated');
  assert.equal(state.counters.unlocked_writes, 1, 'and the unlocked write is counted');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'planted', 'another holder\'s lock is never removed');

  const report = runDoctor(config, path.join(path.dirname(config.dataFile), 'config.json'));
  const check = report.checks.find((entry) => entry.id === 'session-state:unlocked-writes');
  assert.ok(check, 'doctor names the unlocked write');
  assert.equal(check.status, 'info');
  assert.match(check.detail, /^1 state update\(s\) in 1 session state file\(s\) were stored without the session lock since the last repair/);
  assert.equal(report.ok, true);
});

// End to end, as an agent runs it: a hook facing a lock a live process holds
// waits out its budget, records the event anyway, exits 0, and says why under
// debug.
test('a hook facing a lock held by a live process still records its event, exits 0, and says under debug that it went without the lock', () => {
  const home = tempDir();
  const config = testConfig(home);
  const stateFile = sessionStateFile(config, 'lock-s1');
  plantLock(stateFile, { pid: LIVE_OTHER });

  const run = spawnSync(process.execPath, [cli, 'hook', 'claude', 'SubagentStart', JSON.stringify(subagentPayload('SubagentStart', 'lock-s1', 0))], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_DEBUG: '1' }
  });

  assert.equal(run.status, 0);
  assert.match(run.stderr, UNLOCKED);
  assert.equal(ledgerRows(config).filter((row) => row.kind === 'subagent').length, 1);
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1);
});

test('doctor says nothing about unlocked writes when every write held the lock', () => {
  const config = testConfig(tempDir());
  const result = storeEvent(subagentStart(config), config);
  assert.equal(result.unlocked, undefined);
  const report = runDoctor(config, path.join(path.dirname(config.dataFile), 'config.json'));
  assert.equal(report.checks.find((entry) => entry.id === 'session-state:unlocked-writes'), undefined);
});

// A holder whose lock was judged stale and taken over no longer owns it; its
// release must leave the new holder's lock in place.
test('a holder whose lock was taken over as stale does not remove its successor\'s lock when it finishes', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const first = acquireStateLock(stateFile);
  assert.equal(first.held, true);
  ageFile(first.file);
  const second = acquireStateLock(stateFile, { budgetMs: 0 });
  assert.equal(second.held, true, 'the aged lock was taken over');

  releaseStateLock(first);

  assert.equal(fs.existsSync(second.file), true, 'the successor still holds its lock');
  assert.equal(JSON.parse(fs.readFileSync(second.file, 'utf8')).token, second.token);
  releaseStateLock(second);
  assert.equal(fs.existsSync(second.file), false);
});

// Taking over is done by one process at a time: while another holds the
// takeover guard, a stale lock is left for it rather than removed twice.
test('a stale lock is not taken over while another process is already taking it over', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: exitedPid() });
  const guard = plantLock(sessionStateFile(config, 'guard-source'), { pid: LIVE_OTHER, token: 'guard' }, `${lock}.takeover`);

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1, 'the write did not take the lock');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'planted', 'the stale lock is left to the takeover in progress');
  assert.equal(JSON.parse(fs.readFileSync(guard, 'utf8')).token, 'guard');
});

test('a takeover guard left by a process that exited does not stop the next takeover', () => {
  const config = testConfig(tempDir());
  const stateFile = sessionStateFile(config, 'lock-s1');
  const lock = plantLock(stateFile, { pid: exitedPid() });
  const guard = plantLock(sessionStateFile(config, 'guard-source'), { pid: exitedPid(), token: 'guard' }, `${lock}.takeover`);

  storeEvent(subagentStart(config), config, { lock: { budgetMs: 0 } });

  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, undefined, 'the write held the lock');
  assert.equal(fs.existsSync(guard), false);
  assert.deepEqual(nonStateFiles(stateFile), []);
});

// Two flushers appending the same pending turn would put it in the ledger twice
// for good. A report that finds the session busy leaves the turn pending and
// shows it from memory, exactly as it does where the directory is read-only.
test('a pending turn is not flushed while its session is locked elsewhere, and is still returned for the report', () => {
  const config = testConfig(tempDir());
  storeEvent(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline')[0], config);
  const stateFile = sessionStateFile(config, 'claude-session-1');
  const lock = plantLock(stateFile, { pid: LIVE_OTHER });

  const busy = tryFlushPendingTurns(config, { lock: { budgetMs: 0 } });
  assert.equal(busy.flushed, 0);
  assert.equal(busy.busy, 1);
  assert.equal(busy.refused, undefined, 'a busy session is not a read-only directory');
  assert.equal(busy.unflushed.length, 1, 'the turn is handed back for the report to include');
  assert.equal(ledgerRows(config).length, 0, 'nothing was appended without the lock');

  fs.unlinkSync(lock);
  const free = tryFlushPendingTurns(config);
  assert.equal(free.flushed, 1);
  assert.equal(ledgerRows(config).length, 1, 'the turn is written once the session is free');
  assert.equal(fs.existsSync(stateLockFile(stateFile)), false);
});

// The process holding a busy session's lock can have appended a turn it
// flushed and not yet rewritten the state that still lists it as pending. The
// report read that turn from state and reads it again from the ledger; it is
// one turn.
test('a turn the busy session\'s holder has already appended is counted once by the report, not again from pending state', async () => {
  const config = testConfig(tempDir());
  storeEvent(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline')[0], config);
  const stateFile = sessionStateFile(config, 'claude-session-1');
  plantLock(stateFile, { pid: LIVE_OTHER });
  const busy = tryFlushPendingTurns(config, { lock: { budgetMs: 0 } });
  assert.equal(busy.unflushed.length, 1);
  // What the holder had done at that moment: appended the turn, state not yet
  // rewritten.
  fs.appendFileSync(config.dataFile, `${JSON.stringify(busy.unflushed[0])}\n`);

  const events = await collectEvents(config, {}, { pending: busy.unflushed });

  assert.equal(events.length, 1, `one turn, got ${events.length}`);
  assert.equal(events[0].event_id, busy.unflushed[0].event_id);
});

test('an in-flight turn not yet in the ledger is still included from pending state', async () => {
  const config = testConfig(tempDir());
  storeEvent(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline')[0], config);
  plantLock(sessionStateFile(config, 'claude-session-1'), { pid: LIVE_OTHER });
  const busy = tryFlushPendingTurns(config, { lock: { budgetMs: 0 } });

  const events = await collectEvents(config, {}, { pending: busy.unflushed });

  assert.equal(events.length, 1);
});

// A lock a writable run left behind, found by a process that can read the data
// directory but not write it - Codex's default sandbox, a read-only mount. No
// wait can end with the lock held and the write after it is refused anyway, so
// a hook or a status render does not spend its budget finding that out.
const readOnlySkip = process.platform === 'win32' ? 'directory modes do not make a directory read-only on Windows'
  : process.getuid?.() === 0 ? 'running as root, which writes through directory permissions' : false;

test('a lock left in a data directory this process cannot write is reported unavailable at once, not waited out', { skip: readOnlySkip }, (t) => {
  const config = testConfig(tempDir());
  const live = sessionStateFile(config, 'lock-live');
  const dead = sessionStateFile(config, 'lock-dead');
  plantLock(live, { pid: LIVE_OTHER });
  plantLock(dead, { pid: exitedPid() });
  const dir = path.dirname(live);
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));

  // A budget this test would notice: code that waited it out would answer
  // `timeout`, and only after a minute.
  for (const stateFile of [live, dead]) {
    const lock = acquireStateLock(stateFile, { budgetMs: 60_000 });
    assert.equal(lock.held, false);
    assert.equal(lock.reason, 'unavailable', `${path.basename(stateFile)}: a read-only directory is not contention`);
    assert.match(lock.error?.code ?? '', /^(EACCES|EPERM|EROFS)$/);
  }
  assert.throws(() => storeEvent(subagentStart(config, 'lock-dead'), config, { lock: { budgetMs: 60_000 } }),
    (error) => ['EACCES', 'EPERM', 'EROFS'].includes(error.code), 'the store fails the way a refused write always has, for the caller to degrade');
});

test('a symbolic link at the lock path is never written through', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'home'));
  const target = path.join(root, 'elsewhere.txt');
  fs.writeFileSync(target, 'not a lock');
  const stateFile = sessionStateFile(config, 'lock-s1');
  const link = stateLockFile(stateFile);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);

  // Fresh, it is someone's lock as far as anyone can tell: waited for, then
  // written around.
  storeEvent(subagentStart(config, 'lock-s1', 0), config, { lock: { budgetMs: 0 } });
  assert.equal(fs.readFileSync(target, 'utf8'), 'not a lock');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1);

  // Stale, the link itself is removed - never what it points at.
  const old = new Date(Date.now() - 60_000);
  fs.lutimesSync(link, old, old);
  storeEvent(subagentStart(config, 'lock-s1', 1), config, { lock: { budgetMs: 0 } });
  assert.equal(fs.readFileSync(target, 'utf8'), 'not a lock');
  assert.equal(fs.existsSync(link), false);
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1, 'the second write held the lock');
});

// `doctor` recommends `tokenwatch repair` for unlocked writes; once the repair
// has rebuilt what the ledger can restore, the recommendation is spent.
function unlockedWrite(config, session, index) {
  const stateFile = sessionStateFile(config, session);
  const lock = plantLock(stateFile, { pid: LIVE_OTHER });
  const result = storeEvent(subagentStart(config, session, index), config, { lock: { budgetMs: 0 } });
  assert.equal(result.unlocked, true);
  return lock;
}

test('repair resets the unlocked-write count it was recommended for, and doctor stops recommending it', async () => {
  const config = testConfig(tempDir());
  storeEvent(subagentStart(config, 'lock-s1', 0), config);
  fs.unlinkSync(unlockedWrite(config, 'lock-s1', 1));
  const doctor = () => runDoctor(config, path.join(path.dirname(config.dataFile), 'config.json'))
    .checks.find((entry) => entry.id === 'session-state:unlocked-writes');
  assert.ok(doctor());

  const preview = await repairLedger(config, { dryRun: true });
  assert.equal(preview.unlocked_writes_cleared, 1, 'a dry run says what it would reset');
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1, 'and resets nothing');

  const repaired = await repairLedger(config);
  assert.equal(repaired.subagent_counts_corrected, 0, 'the counts already agree with the ledger');
  assert.equal(repaired.unlocked_writes_cleared, 1, 'the count is reset even so');
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, undefined);
  assert.equal(loadState(config, 'lock-s1').subagentWindows[subagentWindowKey('claude-code', 'lock-s1')].active, 2, 'nothing else in the state changed');
  assert.equal(doctor(), undefined, 'doctor no longer reports writes the repair has dealt with');
});

test('repair leaves a session whose lock stays busy uncorrected, keeps its count and says so', async () => {
  const config = testConfig(tempDir());
  const lock = unlockedWrite(config, 'lock-s1', 0);
  const stateFile = sessionStateFile(config, 'lock-s1');
  const before = fs.readFileSync(stateFile);

  const repaired = await repairLedger(config, { lock: { budgetMs: 0 } });

  assert.equal(repaired.state_files_busy, 1);
  assert.equal(repaired.unlocked_writes_cleared, 0);
  assert.deepEqual(fs.readFileSync(stateFile), before, 'the busy file is not rewritten');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'planted');
});
