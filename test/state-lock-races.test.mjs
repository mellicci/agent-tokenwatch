import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, tempDir, testConfig } from './helpers.mjs';
import { loadState, sessionStateFile, storeEvent, subagentWindowKey, tryFlushPendingTurns } from '../src/store.mjs';
import { acquireStateLock, releaseStateLock, stateLockFile } from '../src/state-lock.mjs';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { repairLedger } from '../src/repair.mjs';

// The lock's safeguards are about what another process does in the instant
// between two of this one's system calls: a takeover in progress, a lock
// released and created again, a hook that writes the state while a report or a
// repair waits for it. Real processes cannot be made to land in that instant on
// demand, so these cases put the other process's step there themselves: a
// wrapper around one real `fs` function runs that step - with the real
// functions, on real files - just before calling through to the original, and
// every other call goes straight through. One case instead replaces a call's
// result: the EPERM Windows gives for a lock file pending deletion, which POSIX
// never produces (principles §2.5 lists this file as a disclosed exception).
function interpose(name, step) {
  const real = fs[name];
  let inside = false;
  fs[name] = function wrapped(...args) {
    if (inside) return real.apply(this, args);
    inside = true;
    try {
      step(...args);
    } finally {
      inside = false;
    }
    return real.apply(this, args);
  };
  return () => { fs[name] = real; };
}

const LIVE_OTHER = process.ppid;

let host;
function hostTag() {
  if (!host) {
    const probe = sessionStateFile(testConfig(tempDir()), 'host-probe');
    const lock = acquireStateLock(probe);
    host = JSON.parse(fs.readFileSync(lock.file, 'utf8')).host;
    releaseStateLock(lock);
  }
  return host;
}

// A lock file exactly as another Tokenwatch process on this machine writes it.
function writeLock(file, { pid, token }) {
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ pid, host: hostTag(), token, at: new Date().toISOString() }));
  fs.closeSync(fd);
}

function tokenAt(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).token;
}

function exitedPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function lockedFile(config, session = 'race-s1') {
  const stateFile = sessionStateFile(config, session);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  return { stateFile, lockFile: stateLockFile(stateFile) };
}

function subagent(config, event, session, index) {
  return normalizeClaude(event, {
    session_id: session, prompt_id: 'race-prompt', hook_event_name: event, agent_type: 'general-purpose',
    timestamp: `2026-09-28T10:00:${String(index).padStart(2, '0')}.000Z`
  }, config, 'hook')[0];
}

// The race that gave two holders: waiter B judged the lock stale; before B
// removed it, waiter A took it over and created a fresh lock; B then moved A's
// fresh lock aside, a third waiter C created its own in the name B had freed,
// B could not put A's back, and A and C both held the lock.
test('a waiter that judged a lock stale does not remove the fresh lock another waiter created in its place', () => {
  const config = testConfig(tempDir());
  const { stateFile, lockFile } = lockedFile(config);
  writeLock(lockFile, { pid: exitedPid(), token: 'L1' });
  const guard = `${lockFile}.takeover`;
  // A's whole takeover lands right after B's judgement, at B's next step
  // towards removing L1: entering the takeover guard, or moving L1 aside where
  // there is no guard.
  const takeOverAsA = () => {
    if (!fs.existsSync(lockFile) || tokenAt(lockFile) !== 'L1') return;
    fs.unlinkSync(lockFile);
    writeLock(lockFile, { pid: LIVE_OTHER, token: 'A' });
  };
  const restore = [
    interpose('openSync', (file, flags) => { if (file === guard && flags === 'wx') takeOverAsA(); }),
    interpose('renameSync', (from) => { if (from === lockFile) takeOverAsA(); }),
    // C creates its lock the moment the name is free, before any link back.
    interpose('linkSync', (_from, to) => {
      if (to === lockFile && !fs.existsSync(lockFile)) writeLock(lockFile, { pid: LIVE_OTHER, token: 'C' });
    })
  ];
  let lock;
  try {
    lock = acquireStateLock(stateFile, { budgetMs: 0 });
  } finally {
    for (const undo of restore) undo();
  }

  assert.equal(lock.held, false, 'B does not hold the lock');
  assert.equal(lock.reason, 'timeout');
  assert.equal(tokenAt(lockFile), 'A', 'A still holds its fresh lock, and nobody else does');
  assert.equal(fs.existsSync(guard), false, 'the takeover guard is released');
});

// Judged again under the guard, a lock can still change in one way: its holder,
// alive but judged by age, releases it, and a newcomer creates a fresh one in
// the instant before the takeover moves it. The move catches the fresh lock,
// which is recognised as not the one judged and put back.
test('a fresh lock caught by a takeover\'s move is put back under its name, never deleted', () => {
  const config = testConfig(tempDir());
  const { stateFile, lockFile } = lockedFile(config);
  writeLock(lockFile, { pid: LIVE_OTHER, token: 'aged' });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  const restore = interpose('renameSync', (from) => {
    if (from !== lockFile || tokenAt(lockFile) !== 'aged') return;
    fs.unlinkSync(lockFile);
    writeLock(lockFile, { pid: LIVE_OTHER, token: 'X' });
  });
  let lock;
  try {
    lock = acquireStateLock(stateFile, { budgetMs: 0 });
  } finally {
    restore();
  }

  assert.equal(lock.held, false);
  assert.equal(tokenAt(lockFile), 'X', 'the newcomer keeps its lock');
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)).filter((name) => !name.endsWith('.json') && !name.endsWith('.lock')), [],
    'nothing moved aside is left behind');
});

// A peer whose every lock looks stale - its clock runs behind, or it reuses an
// id - must not keep a writer taking over forever: the writer stops after a
// few takeovers and falls back as it would for any lock it cannot get.
test('a stream of locks that each look stale is taken over a bounded number of times, then waited out', () => {
  const config = testConfig(tempDir());
  const { stateFile, lockFile } = lockedFile(config);
  let planted = 0;
  const restore = interpose('openSync', (file, flags) => {
    if (file !== lockFile || flags !== 'wx' || fs.existsSync(lockFile) || planted >= 50) return;
    planted += 1;
    // This process's own id under another token: left by an exited process.
    writeLock(lockFile, { pid: process.pid, token: `peer-${planted}` });
  });
  let lock;
  try {
    lock = acquireStateLock(stateFile, { budgetMs: 0 });
  } finally {
    restore();
  }

  assert.equal(lock.held, false);
  assert.equal(lock.reason, 'timeout');
  assert.equal(planted, 5, `four takeovers after the first lock, then no more; saw ${planted} locks`);
});

// On Windows a lock file being deleted still occupies its name, and creating it
// again fails with EPERM or EACCES, not EEXIST. That is another process's lock
// on its way out - contention - never a read-only directory.
test('EPERM while a lock file is present is contention: the write waits and is counted, not treated as a read-only directory', () => {
  const config = testConfig(tempDir());
  const { lockFile } = lockedFile(config, 'lock-s1');
  writeLock(lockFile, { pid: LIVE_OTHER, token: 'deleting' });
  const real = fs.openSync;
  fs.openSync = function openSync(file, flags, ...rest) {
    if (file === lockFile && flags === 'wx' && fs.existsSync(lockFile)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: 'EPERM' });
    }
    return real.call(this, file, flags, ...rest);
  };
  let result;
  try {
    result = storeEvent(subagent(config, 'SubagentStart', 'lock-s1', 0), config, { lock: { budgetMs: 0 } });
  } finally {
    fs.openSync = real;
  }

  assert.equal(result.unlocked, true, 'the store knew it wrote without the lock');
  assert.equal(loadState(config, 'lock-s1').counters.unlocked_writes, 1);
});

// A report peeks at every state file without a lock, to skip the ones with
// nothing pending, then flushes under the lock. A hook of that session can
// flush the same turn in between; what the report flushes is what it reads
// once it holds the lock.
test('a report flushes what the state holds once it has the lock, not what it saw before, so a turn a hook just flushed is not appended twice', () => {
  const config = testConfig(tempDir());
  storeEvent(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline')[0], config);
  const lockFile = stateLockFile(sessionStateFile(config, 'claude-session-1'));
  let hooked = false;
  const restore = interpose('openSync', (file, flags) => {
    if (file !== lockFile || flags !== 'wx' || hooked) return;
    hooked = true;
    // The next prompt's hook flushes the turn under its own lock.
    storeEvent(normalizeClaude('UserPromptSubmit', { session_id: 'claude-session-1', prompt_id: 'next', hook_event_name: 'UserPromptSubmit' }, config, 'hook')[0], config);
  });
  let flush;
  try {
    flush = tryFlushPendingTurns(config);
  } finally {
    restore();
  }

  assert.equal(hooked, true);
  assert.equal(flush.flushed, 0, 'nothing was left to flush');
  const rows = fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const turns = rows.filter((row) => row.source === 'statusline');
  assert.equal(turns.length, 1, `the turn is in the ledger once, got ${turns.length}`);
});

// Repair reads every state file to decide what to correct, then rewrites each
// under its lock. A hook writing that session in between must not be erased by
// the copy repair read first.
test('repair rewrites the state it reads under the lock, so a hook that wrote the session meanwhile keeps its update', async () => {
  const config = testConfig(tempDir());
  const session = 'lock-s1';
  const { lockFile } = lockedFile(config, session);
  storeEvent(subagent(config, 'SubagentStart', session, 0), config);
  // An unlocked write, so repair has a count to reset and rewrites the file.
  writeLock(lockFile, { pid: LIVE_OTHER, token: 'busy' });
  assert.equal(storeEvent(subagent(config, 'SubagentStart', session, 1), config, { lock: { budgetMs: 0 } }).unlocked, true);
  fs.unlinkSync(lockFile);

  let hooked = false;
  const restore = interpose('openSync', (file, flags) => {
    if (file !== lockFile || flags !== 'wx' || hooked) return;
    hooked = true;
    storeEvent(subagent(config, 'SubagentStart', session, 2), config);
  });
  let repaired;
  try {
    repaired = await repairLedger(config);
  } finally {
    restore();
  }

  assert.equal(hooked, true);
  assert.equal(repaired.unlocked_writes_cleared, 1);
  const state = loadState(config, session);
  assert.equal(state.subagentWindows[subagentWindowKey('claude-code', session)].active, 3, 'the start written during the repair is kept');
  assert.equal(state.counters.unlocked_writes, undefined);
});
