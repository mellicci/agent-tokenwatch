import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, isWriteRefused } from './fs-util.mjs';

// One lock per session state file, so the read-modify-write of that file is
// done by one process at a time.
//
// Every hook and status render is its own short-lived process, and an agent
// starts them as things happen: two subagents launched together are two
// SubagentStart hooks in the same instant. Each read the state file, changed it
// and wrote it back whole, so whichever wrote second erased the other's update.
// Measured live, two subagents ended as "1 completed". The ledger kept both
// rows; only the state lost one.
//
// The lock is a file created with `wx` (O_CREAT|O_EXCL), which exists on
// Windows as it does on POSIX, and which refuses an existing path - a symlink
// included - rather than opening through it. Nothing here follows a link.
//
// A hook must never block or break the agent, so waiting is bounded; then the
// caller decides what to do without the lock (see `storeEvent` and
// `tryFlushPendingTurns`). The bound is a trade between two failures. Too short,
// and a loaded machine - many hooks starting at once on a busy CPU - runs out of
// it while the holder is merely waiting for a CPU, and the write that follows
// without the lock can lose an update: 300 ms did, 2 in 5 runs of sixteen
// simultaneous hooks pinned to one CPU. Too long, and the wait eats into the
// time the agent gives the hook: Tokenwatch installs every Claude Code and
// Copilot CLI hook with a 5 s timeout (`timeout: 5`, `timeoutSec: 5`,
// `src/installer.mjs`), after which the agent kills it and the event is lost
// altogether. 2 s leaves 3 s of that for starting Node, reading the payload and
// writing, which Windows needs most.
export const STATE_LOCK_BUDGET_MS = 2000;

// A status render is not a hook: nothing waits on it, but the reading is on
// screen only once it finishes, and Claude Code cancels a status script still
// running when the next update arrives (it debounces updates at 300 ms). It
// waits no longer for its own lock than it already waits for another tool's
// composed status line by default (`status.composeTimeoutMs`, 1000 ms).
export const STATUS_LOCK_BUDGET_MS = 1000;

// A holder keeps the lock for the few milliseconds one reduction takes. A lock
// is judged by its age only where its holder's process cannot be checked (it
// ran on another machine, or its record is unreadable) or still runs past any
// time a write could take. Twice the 5 s hook timeout: by then every hook that
// could have held it has been killed by its agent, so an age-based takeover
// never takes a lock from a hook that is still writing.
export const STATE_LOCK_STALE_MS = 10_000;

const MAX_HOLDER_BYTES = 512;
const MAX_TAKEOVERS = 4;

// `sessions/s_<hash>.json` is locked by `sessions/s_<hash>.lock`, the shared
// `state.json` by `state.lock`. Not `.json`, so nothing that lists state files
// ever mistakes a lock for one.
export function stateLockFile(stateFile) {
  return stateFile.endsWith('.json') ? `${stateFile.slice(0, -'.json'.length)}.lock` : `${stateFile}.lock`;
}

// Taking over a stale lock is itself done by one process at a time, under this
// second, short-lived lock beside it (see `takeOverIfStale`).
function takeoverGuardFile(lockFile) {
  return `${lockFile}.takeover`;
}

// Which machine a holder ran on, so a pid is only checked where it means
// something (a data directory can sit on a shared drive). A hash, so the lock
// file adds no machine name to the data directory, even for the moment it
// exists.
function hostTag() {
  return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Signal 0 tests for a process without touching it, on Windows too. EPERM
// means it exists and belongs to someone else.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// What a lock file says about its holder. Only a small regular file is read,
// and never through a link where the platform can refuse one; anything else
// says nothing, and is then judged by its age alone.
function readHolder(file) {
  let fd;
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_HOLDER_BYTES) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(MAX_HOLDER_BYTES);
    const length = fs.readSync(fd, buffer, 0, MAX_HOLDER_BYTES, 0);
    const holder = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    return holder && typeof holder === 'object' ? holder : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function createLock(file, token) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: hostTag(), token, at: new Date().toISOString() }));
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
    throw error;
  }
  fs.closeSync(fd);
}

// Removes a lock (or a takeover guard) only while it still carries `token`.
function releaseOwned(file, token) {
  try {
    if (readHolder(file)?.token === token) fs.unlinkSync(file);
  } catch {}
}

// Whether the process that holds `file` is known to be gone: it ran on this
// machine and its pid no longer runs, or its pid is this process's own. A
// process never holds two locks on one file at once, so a lock carrying this
// process's id is not this process's (it would be releasing it, not looking at
// it): it was left by an earlier process that had the same id, which Windows
// and a wrapped-around pid counter both hand out again.
function holderGone(holder) {
  if (holder?.host !== hostTag() || !Number.isInteger(holder?.pid) || holder.pid <= 0) return false;
  return holder.pid === process.pid || !processAlive(holder.pid);
}

// A snapshot of a lock file: `gone` when there is none, otherwise whether it is
// stale - its holder is gone, or it is older than `staleMs` whoever holds it -
// and what it was (inode, mtime, token), so a later step can tell whether the
// file it finds is still this one.
function inspectLock(file, staleMs) {
  let info;
  try { info = fs.lstatSync(file); } catch (error) { return error?.code === 'ENOENT' ? { gone: true } : { stale: false }; }
  const holder = info.isFile() ? readHolder(file) : undefined;
  const stale = holderGone(holder) || Date.now() - info.mtimeMs >= staleMs;
  return { gone: false, stale, info, token: holder?.token };
}

// Deletes `file` only if it is still the lock `judged` describes. It is moved
// aside first, which is atomic, and compared once moved; a different file
// caught by the move - a fresh lock that took the stale one's place - is linked
// back under its name, never deleted. `taken` when the judged lock is gone,
// `gone` when there was nothing to move, false otherwise.
function removeJudged(file, judged) {
  const aside = `${file}.${crypto.randomBytes(6).toString('hex')}.stale`;
  try { fs.renameSync(file, aside); } catch (error) { return error?.code === 'ENOENT' ? 'gone' : false; }
  let moved;
  try { moved = fs.lstatSync(aside); } catch {}
  const same = Boolean(moved) && moved.ino === judged.info.ino && moved.mtimeMs === judged.info.mtimeMs
    && (moved.isFile() ? readHolder(aside)?.token === judged.token : true);
  if (!same) { try { fs.linkSync(aside, file); } catch {} }
  try { fs.unlinkSync(aside); } catch {}
  return same ? 'taken' : false;
}

// Enters the takeover guard, first removing one its holder left behind.
function enterGuard(guard, token, staleMs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      createLock(guard, token);
      return true;
    } catch (error) {
      if (!contended(error, guard)) return false;
    }
    const judged = inspectLock(guard, staleMs);
    if (judged.gone) continue;
    if (!judged.stale || removeJudged(guard, judged) !== 'taken') return false;
  }
  return false;
}

// A stale lock is removed so the caller can try to create its own. Two waiters
// can judge the same lock stale at once, and between one's judgement and its
// removal the other may already have removed it and created a fresh lock in
// its place, which must never be removed. So a takeover is made under a guard
// (`takeoverGuardFile`) that only one process holds at a time, and the lock is
// judged again once the guard is held: no other takeover can then change it,
// and a lock whose holder is gone cannot be released by that holder, so the
// lock that is removed is the lock that was judged. The one change still
// possible - a live holder judged only by its age releasing in that instant,
// and a newcomer creating a fresh lock - is caught by `removeJudged`, which
// puts that fresh lock back. `gone` when the lock disappeared on its own
// (released), `taken` when it was stale and is removed, false otherwise.
function takeOverIfStale(file, staleMs, token) {
  const first = inspectLock(file, staleMs);
  if (first.gone) return 'gone';
  if (!first.stale) return false;
  const guard = takeoverGuardFile(file);
  if (!enterGuard(guard, token, staleMs)) return false;
  try {
    const judged = inspectLock(file, staleMs);
    if (judged.gone) return 'gone';
    if (!judged.stale) return false;
    return removeJudged(file, judged);
  } finally {
    releaseOwned(guard, token);
  }
}

// On Windows a name whose file is being deleted cannot be created again until
// the last handle on it closes, and that is reported as EPERM or EACCES rather
// than EEXIST. While a lock file is present that is contention, not a
// read-only directory. POSIX reports an existing path as EEXIST whatever the
// directory's permissions, so there the second rule never applies.
function contended(error, file) {
  if (error?.code === 'EEXIST') return true;
  if (!['EPERM', 'EACCES'].includes(error?.code)) return false;
  try { fs.lstatSync(file); return true; } catch (probe) { return probe?.code !== 'ENOENT'; }
}

// Whether `dir` refuses new files. A lock can be present in a directory this
// process cannot write - one a writable run left behind, read now from inside
// Codex's sandbox or from a read-only mount - and then no waiting or takeover
// can succeed, and the write after it will be refused anyway. Creating a file
// is the permission the lock, the takeover and the state rewrite all need, so
// that is what is tried, once, rather than the directory's mode bits, which a
// sandbox does not show.
function writeRefusal(dir) {
  const probe = path.join(dir, `.tokenwatch-lock-probe-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.closeSync(fs.openSync(probe, 'wx', 0o600));
  } catch (error) {
    return isWriteRefused(error) ? error : undefined;
  }
  try { fs.unlinkSync(probe); } catch {}
  return undefined;
}

// `held: true` when this process now holds the lock. Otherwise `reason` is
// `timeout` (another process held it for the whole budget) or `unavailable`
// (it could not be created at all, as in a read-only data directory, where the
// write that follows fails the way it always has). A read-only directory is
// recognised at once, not after the budget, even when a lock is left in it.
export function acquireStateLock(stateFile, { budgetMs = STATE_LOCK_BUDGET_MS, staleMs = STATE_LOCK_STALE_MS } = {}) {
  const file = stateLockFile(stateFile);
  const token = crypto.randomBytes(12).toString('hex');
  try { ensureDir(path.dirname(file)); } catch (error) { return { held: false, reason: 'unavailable', file, error }; }
  const deadline = Date.now() + budgetMs;
  let wait = 1;
  let takeovers = 0;
  let probed = false;
  for (;;) {
    try {
      createLock(file, token);
      return { held: true, file, token };
    } catch (error) {
      if (!contended(error, file)) return { held: false, reason: 'unavailable', file, error };
    }
    if (!probed) {
      probed = true;
      const refused = writeRefusal(path.dirname(file));
      if (refused) return { held: false, reason: 'unavailable', file, error: refused };
    }
    // A released lock is tried again at once while the budget lasts. Taking
    // over is bounded too, so a stream of locks that each look stale - a peer
    // whose clock runs behind, say - cannot keep this loop from ever reaching
    // its deadline.
    const outcome = takeovers < MAX_TAKEOVERS ? takeOverIfStale(file, staleMs, token) : false;
    if (outcome === 'taken') { takeovers += 1; continue; }
    if (outcome === 'gone' && Date.now() < deadline) continue;
    const left = deadline - Date.now();
    if (left <= 0) return { held: false, reason: 'timeout', file };
    // Jitter, so waiters that collided once do not collide again in step.
    sleep(Math.max(1, Math.min(left, wait + Math.floor(Math.random() * wait))));
    wait = Math.min(wait * 2, 20);
  }
}

// Removes the lock only while it is still this holder's: one taken over as
// stale belongs to its new holder now.
export function releaseStateLock(lock) {
  if (!lock?.held) return;
  releaseOwned(lock.file, lock.token);
}

export function withStateLock(stateFile, fn, options = {}) {
  const lock = acquireStateLock(stateFile, options);
  try {
    return fn(lock);
  } finally {
    releaseStateLock(lock);
  }
}
