import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'tokenwatch-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(root) {
  return {
    version: 1,
    dataFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    installStateFile: path.join(root, 'install-state.json'),
    experimentsFile: path.join(root, 'experiments.jsonl'),
    pricingFile: null,
    projectSalt: 'a'.repeat(64),
    cacheTtlSeconds: 300,
    averagingWindow: 10,
    retentionDays: 90,
    status: {
      maxWidth: 140, showCost: true, showTokens: true,
      showCache: true, showContext: true, showSubagents: true
    },
    privacy: {
      projectIdentity: 'hmac-sha256', storeToolNames: true,
      storeModelNames: true, storeDurations: true
    },
    codex: {
      // 0, not Codex's real 4318: a test that starts a receiver from this
      // config without its own port would otherwise bind the port a
      // developer's running Codex may be using.
      command: 'codex', otlpHost: '127.0.0.1', otlpPort: 0,
      otlpPath: '/v1/logs', installOtelConfig: true
    },
    paths: {}
  };
}

export function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

// A Windows path spelled out with backslashes and a drive letter, rather than
// built with `path.join`, so a case about how Windows writes a path runs, and
// means the same thing, on every OS. `windowsPath('Users', 'me', 'cli.mjs')`
// is `C:\Users\me\cli.mjs`.
export function windowsPath(...segments) {
  return ['C:', ...segments].join('\\');
}

// The same value as it appears inside a TOML basic string, such as a Codex
// `notify = ["..."]` line: every backslash doubled and every quote escaped.
// Written out by the TOML rule rather than borrowed from `JSON.stringify`,
// which is what the installer itself uses and so could not check it.
export function tomlEscaped(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Whether process `pid` has ended, waiting up to `timeoutMs` for it. A kill
// takes effect a moment after it is sent, and the process that sent it may
// exit first, so checking at once reads a process that is about to go as one
// left running. On Linux a killed process whose parent has not reaped it yet
// is a zombie: `kill(pid, 0)` still finds it, but it runs nothing, so it
// counts as ended.
export async function processGone(pid, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processRuns(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processRuns(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw error;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

// A preload for a Node process that starts and stops children: it records
// each child the process starts, each exit Node sees, and each kill it sends
// (process.kill, ChildProcess#kill, one line per taskkill.exe run), calling
// through to all of them. A kill that lands on an id the system has given to
// another program cannot be seen from outside, so it is recorded here.
// `read()` returns the lines, and `staleKills` the ids killed after Node had
// already seen them exit.
export function killSpy(dir) {
  const log = path.join(dir, 'kill-spy.log');
  const preload = path.join(dir, 'kill-spy.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const cp = require('node:child_process');
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
const kill = process.kill;
process.kill = function (pid) { note('kill ' + Math.abs(pid)); return kill.apply(this, arguments); };
const childKill = cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill = function () { note('kill ' + this.pid); return childKill.apply(this, arguments); };
const start = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function () {
  const result = start.apply(this, arguments);
  if (this.pid) { note('spawn ' + this.pid); this.once('exit', () => note('exit ' + this.pid)); }
  return result;
};
const spawnSync = cp.spawnSync;
cp.spawnSync = function (file, args = []) {
  if (/taskkill(\\.exe)?$/i.test(String(file))) note('taskkill ' + args.filter((arg, i) => args[i - 1] === '/PID').join(' '));
  return spawnSync.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();
`);
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { preload, read };
}

export function staleKills(lines) {
  const exited = new Set();
  const stale = [];
  for (const line of lines) {
    const [what, ...pids] = line.split(' ').map((word, index) => (index ? Number(word) : word));
    if (what === 'exit') exited.add(pids[0]);
    if (what === 'kill' || what === 'taskkill') stale.push(...pids.filter((pid) => exited.has(pid)));
  }
  return stale;
}

// Windows lets an account create a symbolic link only with Developer Mode on
// or from an elevated shell, so a test whose subject is a symlink cannot set
// up its own premise there. Returns the skip reason in that case, and false
// everywhere a link can be made. Only Windows is probed: anywhere else a
// failure to link is a real failure and should surface as one.
export function symlinkUnavailable() {
  if (process.platform !== 'win32') return false;
  const root = tempDir('tokenwatch-symlink-probe-');
  try {
    fs.writeFileSync(path.join(root, 'target'), '');
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'));
    return false;
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    return 'this Windows account cannot create symbolic links (EPERM); enable Developer Mode or run elevated to exercise it';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
