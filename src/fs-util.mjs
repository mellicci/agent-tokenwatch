import fs from 'node:fs';
import { parseJsonDocument } from './json-edit.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

// Git Bash and MSYS spell drives as `/c/Users/me`, and `$HOME` there is that
// shape, so it is a natural thing to type into TOKENWATCH_HOME. Windows
// `path.isAbsolute` accepts it, which meant it normalised to `\c\Users\me` on
// whatever the current drive happened to be, silently and with no warning.
function fromMsysPath(input) {
  const match = /^\/([A-Za-z])\/(.*)$/.exec(input);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}` : input;
}

export function resolvePath(input, base = process.cwd()) {
  let expanded = expandHome(input);
  if (process.platform === 'win32' && typeof expanded === 'string') expanded = fromMsysPath(expanded);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

// For identity and comparison only, never for writing. Windows filesystems are
// case-insensitive and `path.resolve` does not canonicalise the drive letter,
// so `c:\dev\proj` and `C:\Dev\proj` are one directory spelled two ways. Left
// unfolded, that split a single project into two `project_id`s in the ledger,
// and an install recorded under one spelling could not be removed from the
// other. Case is preserved everywhere a path is actually used.
export function identityPath(input, base = process.cwd()) {
  const resolved = resolvePath(input, base);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function ensureDir(dir) {
  // `mkdirSync` returns the first path it had to create, or undefined when the
  // directory was already there. Only what we created gets tightened: silently
  // chmodding a pre-existing `~/.claude` or `~/.codex` changes another tool's
  // directory without being asked. `doctor` reports a loose Tokenwatch home
  // instead, the same way it reports rather than deletes orphaned skills.
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  return dir;
}

// The error codes a filesystem uses to say "you may read this but not write it":
// a POSIX permission (`EACCES`), an operation the platform or a sandbox refuses
// (`EPERM`, which is what Windows and Codex's sandbox both report), and a
// read-only mount (`EROFS`). Reporting commands degrade on exactly these and on
// nothing else - a full disk or a corrupt file is still an error worth seeing.
const WRITE_REFUSED = new Set(['EPERM', 'EACCES', 'EROFS']);

export function isWriteRefused(error) {
  return WRITE_REFUSED.has(error?.code);
}

// A leading UTF-8 byte-order mark is not part of the JSON: Windows editors
// (and PowerShell 5.1's `Out-File`) write one, and JSON.parse rejects it.
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

// JSON with // and /* */ comments, as Copilot CLI writes its settings. The one
// grammar the installer also edits with (src/json-edit.mjs), so a file read
// here is a file the installer can change. The error names the reason, never
// the text: a parse message quotes part of the file, which at project scope
// can be someone else's.
export function readJsonc(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.code ?? error.name}`);
  }
  const doc = parseJsonDocument(text);
  if (doc.error) throw new Error(`Cannot read JSON ${file}: ${doc.error}`);
  return doc.value;
}

// A config file that is a symlink is the ordinary dotfiles pattern: the user
// keeps `~/.claude/settings.json` pointing into a tracked repository. Renaming
// over it would replace the link with a regular file and quietly detach their
// config from that repository, so a user-scope write follows the link.
//
// It is opt-in, not the default, because the same behaviour is a weapon when
// the path is chosen by someone else. A project-scope install writes into a
// directory that may have arrived with a clone, and a committed symlink there
// would have the installer overwrite whatever it points at, at the installer's
// chosen mode. Callers writing a path the user did not choose pass false.
function resolveWriteTarget(file, followSymlink) {
  if (!followSymlink) return file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return fs.realpathSync(file);
  } catch {}
  return file;
}

// On Windows a replace-by-rename fails when any other process holds a
// non-sharing handle on the destination for a moment - a virus scanner, the
// search indexer, a sync client, a backup agent. The hook and status-line paths
// swallow write failures by design, so without a retry this surfaced as
// intermittent unexplained gaps in the ledger, which is the hardest kind of
// report to act on. A few short attempts cover the transient case; a genuine
// permission problem still raises after them.
export function renameWithRetry(from, to, attempts = 5) {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !transient.has(error?.code)) throw error;
      // Synchronous by necessity: every caller here is synchronous, and the
      // waits involved are single-digit milliseconds.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5);
    }
  }
}

// `wx` is O_CREAT|O_EXCL: it refuses a path that already exists rather than
// opening through it. The temp name used to be the pid plus `Math.random`,
// which is guessable, and the plain write followed a symlink planted there -
// so the write landed on the link's target and then chmodded it. That matters
// because project-scope installs write into repository directories, which on a
// shared checkout are not exclusively the user's.
function writeAtomic(file, contents, mode, followSymlink) {
  const target = resolveWriteTarget(file, followSymlink);
  ensureDir(path.dirname(target));
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, contents, { mode, flag: 'wx' });
      try { fs.chmodSync(temp, mode); } catch {}
      renameWithRetry(temp, target);
      try { fs.chmodSync(target, mode); } catch {}
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Cannot create a temporary file beside ${target}: ${lastError?.code ?? 'EEXIST'}`);
}

// Publishes a JSON file only if none exists yet, and says whether this call did.
// The text is written whole under a temporary name and hard-linked into place,
// which fails with EEXIST when another process got there first, so no reader
// ever sees half a file and no writer replaces another's. Where the link cannot
// be made for any other reason - FAT and exFAT volumes, some network shares -
// it falls back to an exclusive create, which a reader can catch half-written;
// readJsonSettled covers that window.
export function createJsonExclusively(file, value, mode = 0o600) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let linkFailed = false;
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' });
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    linkFailed = true;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  if (!linkFailed) return false;
  try {
    fs.writeFileSync(file, text, { mode, flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

// Reads a JSON file another process may be creating right now without a link
// (see createJsonExclusively): a parse failure is retried for a moment before
// it counts. A missing file is `fallback` at once.
export function readJsonSettled(file, fallback = null, { attempts = 20, waitMs = 10 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return readJson(file, fallback);
    } catch (error) {
      if (attempt >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

// `followSymlink` defaults to false: the safe behaviour is to write exactly the
// path you were given. Only a caller that knows the path came from the user -
// a user-scope config file - should opt into following a link.
export function atomicWriteJson(file, value, mode = 0o600, { followSymlink = false } = {}) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode, followSymlink);
}

export function writeTextAtomic(file, text, mode = 0o600, { followSymlink = false } = {}) {
  writeAtomic(file, text, mode, followSymlink);
}

export function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function removeEmptyParents(start, stop) {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (current.startsWith(boundary) && current !== boundary) {
    try {
      if (fs.readdirSync(current).length !== 0) return;
      fs.rmdirSync(current);
    } catch { return; }
    current = path.dirname(current);
  }
}

export function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
