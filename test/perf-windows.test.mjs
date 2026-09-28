import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findGitBash, findOnPath, shellLineInvocation } from '../src/spawn.mjs';

// A measurement, not a gate. During a hands-on Windows 11 test with Claude Code
// and Copilot CLI running side by side the machine froze for seconds at a time,
// and Tokenwatch starts a process per hook, per status render and per doctor
// probe. This file measures what those processes cost on a real Windows machine
// and whether any of them outlives the command that started it. It prints a
// table and asserts only what must hold everywhere: every invocation exits 0,
// and a hook or a plain status render leaves no process behind.
//
// Opt-in, so `npm run check` stays as fast as it was: it runs on Windows when
// TOKENWATCH_PERF=1, or when the file is named in TW_FILES (how the by-hand
// Windows workflow passes the files it was asked to run); anywhere else only
// with TOKENWATCH_PERF=1, which gives the same table for comparison.
const optIn = process.env.TOKENWATCH_PERF === '1' || /perf-windows/.test(process.env.TW_FILES ?? '');
const win = process.platform === 'win32';
// Out of the gate, the file is one skipped line rather than a column of them.
const measure = optIn ? test : () => {};
if (!optIn) test('Windows cost measurements', { skip: 'opt-in measurement: set TOKENWATCH_PERF=1 to run it' }, () => {});

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'tokenwatch.mjs');
// Every process this file starts carries the run id on its command line, so a
// leftover can be found by it and by nothing else running on the machine.
const runId = `twperf${crypto.randomBytes(4).toString('hex')}`;
const rows = [];

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tw-perf-'));
}

function pct(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function row(name, times, note = '') {
  const entry = { name, n: times.length, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)), note };
  rows.push(entry);
  return entry;
}

// Starts a process and resolves when it has exited and its pipes closed, with
// its wall time measured from spawn to exit.
function run(file, args, { input, env, shell = false, stdin = 'pipe', cwd } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let exitedAt;
    const child = spawn(file, args, { env: { ...process.env, ...env }, shell, windowsHide: true, cwd, stdio: [stdin, 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: -1, stdout, stderr: String(error), ms: 0 }));
    child.on('exit', () => { exitedAt = process.hrtime.bigint(); });
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Number((exitedAt ?? process.hrtime.bigint()) - started) / 1e6 }));
    if (stdin === 'pipe') child.stdin.end(input ?? '');
  });
}

const tw = (args, options) => run(process.execPath, [cli, ...args, '--tw-perf', runId], options);

function claudeStatus(session, cost) {
  return JSON.stringify({
    session_id: session, prompt_id: `${session}-prompt`, model: { id: 'claude-perf-model' }, workspace: { current_dir: '/perf/project' },
    cost: { total_cost_usd: cost, total_duration_ms: 1000 },
    context_window: { context_window_size: 200000, used_percentage: 40, current_usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 + Math.round(cost * 100), output_tokens: 50 } }
  });
}

function hookPayload(session, event, index) {
  return JSON.stringify({ session_id: session, prompt_id: `${session}-prompt`, hook_event_name: event, agent_type: 'general-purpose', timestamp: new Date(Date.UTC(2026, 8, 28, 10, 0, 0, index)).toISOString() });
}

// Processes whose command line carries this run's id: a Tokenwatch invocation
// or a composed command this file started. On Windows through CIM, the only
// built-in way to read another process's command line.
function leftovers() {
  if (win) {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${runId}*' -and $_.ProcessId -ne $PID } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const text = result.stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({ pid: entry.ProcessId, name: entry.Name }));
  }
  const result = spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' });
  return result.stdout.split('\n').filter((line) => line.includes(runId) && !line.includes(' ps '))
    .map((line) => line.trim().split(/\s+/)).map(([pid, name]) => ({ pid: Number(pid), name }))
    .filter((entry) => entry.pid !== process.pid);
}

function killAll(list) {
  for (const { pid } of list) {
    if (win) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

// How many processes of each kind the machine runs, sampled while a section
// runs. Short-lived processes can fall between samples, so this is a lower
// bound on the peak.
function sampler() {
  const kinds = ['node', 'conhost', 'bash', 'pwsh', 'powershell', 'cmd', 'sh'];
  const peak = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  let stopped = false;
  const sample = () => new Promise((resolve) => {
    const [file, args] = win ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-eo', 'comm=']];
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (!error) {
        const names = win ? stdout.split('\n').map((line) => line.split('","')[0].replace(/^"/, '').toLowerCase().replace(/\.exe$/, '')) : stdout.split('\n').map((line) => line.trim());
        for (const kind of kinds) peak[kind] = Math.max(peak[kind], names.filter((name) => name === kind).length);
      }
      resolve();
    });
  });
  const loop = (async () => { while (!stopped) await sample(); })();
  return { stop: async () => { stopped = true; await loop; return peak; } };
}

function peakOverlap(intervals) {
  const points = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) { current += delta; peak = Math.max(peak, current); }
  return peak;
}

measure('a bare node start and a Tokenwatch start with its whole module graph', async () => {
  const bare = [];
  const version = [];
  for (let i = 0; i < 10; i += 1) {
    bare.push((await run(process.execPath, ['-e', '0', runId])).ms);
    const result = await tw(['version']);
    assert.equal(result.status, 0, result.stderr);
    version.push(result.ms);
  }
  row('node -e 0 (process start only)', bare);
  row('tokenwatch version (start + module graph)', version, `graph ~${Math.round(pct(version, 0.5) - pct(bare, 0.5))} ms`);
});

measure('hooks one after another, each a process of its own, exit 0 and leave nothing running', async () => {
  const dir = home();
  const events = ['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact'];
  const times = [];
  for (let i = 0; i < 50; i += 1) {
    const event = events[i % events.length];
    const result = await tw(['hook', 'claude', event], { input: hookPayload('perf-seq', event, i), env: { TOKENWATCH_HOME: dir } });
    assert.equal(result.status, 0, result.stderr);
    times.push(result.ms);
  }
  const state = fs.readdirSync(path.join(dir, 'sessions')).filter((name) => name.endsWith('.json'));
  row('hook, sequential (claude)', times, `state file ${Math.round(fs.statSync(path.join(dir, 'sessions', state[0])).size / 1024)} KiB`);
  assert.deepEqual(leftovers(), []);
});

measure('sixteen hooks of one session at once all exit 0 and leave nothing running', async () => {
  const dir = home();
  await tw(['version'], { env: { TOKENWATCH_HOME: dir } });
  const watch = sampler();
  const origin = process.hrtime.bigint();
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => {
    const started = Number(process.hrtime.bigint() - origin) / 1e6;
    return tw(['hook', 'claude', 'SubagentStart'], { input: hookPayload('perf-burst', 'SubagentStart', index), env: { TOKENWATCH_HOME: dir, TOKENWATCH_DEBUG: '1' } })
      .then((result) => ({ ...result, started }));
  }));
  const wall = Number(process.hrtime.bigint() - origin) / 1e6;
  const peak = await watch.stop();
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const unlocked = results.filter((result) => /stored without it/.test(result.stderr)).length;
  const overlap = peakOverlap(results.map((result) => [result.started, result.started + result.ms]));
  row('hook, 16 at once (one session)', results.map((result) => result.ms),
    `wall ${Math.round(wall)} ms, ${overlap} overlapping, sampled peak node ${peak.node} conhost ${peak.conhost}, unlocked ${unlocked}`);
  assert.deepEqual(leftovers(), []);
});

measure('status renders one after another exit 0 and leave nothing running', async () => {
  const dir = home();
  const times = [];
  for (let i = 0; i < 30; i += 1) {
    const result = await tw(['status', '--agent', 'claude', '--ingest-stdin'], { input: claudeStatus('perf-status', 1 + i / 100), env: { TOKENWATCH_HOME: dir } });
    assert.equal(result.status, 0, result.stderr);
    times.push(result.ms);
  }
  row('status render (claude, no compose)', times);
  assert.deepEqual(leftovers(), []);
});

// What one hook or render costs as the agent actually starts it: through Git
// Bash for Claude Code, PowerShell for Copilot CLI's hooks and cmd.exe for its
// status line. The shell is started for every event, so its start-up is part of
// the price of each one. Copilot's own PowerShell start may load a profile;
// this measures -NoProfile, the floor.
measure('hooks and renders through the shell each agent starts them with', { skip: !win && 'Windows shells' }, async () => {
  const dir = home();
  const env = { TOKENWATCH_HOME: dir };
  const line = (args) => `node "${cli}" ${args} --tw-perf ${runId}`;
  const shells = [];
  const gitBash = findGitBash();
  if (gitBash) shells.push(['Git Bash', { shell: 'bash', shellPath: gitBash }]);
  shells.push(['PowerShell 5.1', { shell: 'powershell' }]);
  const pwsh = findOnPath('pwsh');
  for (const [name, spec] of shells) {
    const times = [];
    for (let i = 0; i < 10; i += 1) {
      const { file, args, shell } = shellLineInvocation(line('hook claude Stop'), spec);
      const result = await run(file, args, { shell, env, stdin: 'ignore' });
      assert.equal(result.status, 0, result.stderr);
      times.push(result.ms);
    }
    row(`hook via ${name}`, times);
  }
  if (pwsh) {
    const times = [];
    for (let i = 0; i < 10; i += 1) {
      const script = `& '${process.execPath}' '${cli}' 'hook' 'copilot' 'postToolUse' '--tw-perf' '${runId}'`;
      const result = await run(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, stdin: 'ignore' });
      assert.equal(result.status, 0, result.stderr);
      times.push(result.ms);
    }
    row('hook via pwsh 7 (Copilot hook)', times);
  }
  const statusTimes = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await run(`"${process.execPath}" "${cli}" status --agent copilot --ingest-stdin --tw-perf ${runId}`, [], { shell: true, env, input: claudeStatus('perf-cmd', 1 + i / 100) });
    assert.equal(result.status, 0, result.stderr);
    statusTimes.push(result.ms);
  }
  row('status via cmd.exe (Copilot status line)', statusTimes);
  if (gitBash) {
    const times = [];
    for (let i = 0; i < 10; i += 1) {
      const { file, args } = shellLineInvocation(line('status --agent claude --ingest-stdin'), { shell: 'bash', shellPath: gitBash });
      const result = await run(file, args, { env, input: claudeStatus('perf-bash', 1 + i / 100) });
      assert.equal(result.status, 0, result.stderr);
      times.push(result.ms);
    }
    row('status via Git Bash (Claude status line)', times);
  }
  assert.deepEqual(leftovers(), []);
});

// A composed status line runs another tool's command on every render. The
// timeout kills what it started; this records whether that includes what the
// other command started in turn, and whether the render's own process exits
// once it has printed, when the other command does not finish.
measure('a composed status line: a quick other command, and one that does not finish in time', async () => {
  const dir = home();
  const shell = win ? 'cmd' : 'posix';
  const record = (command) => fs.writeFileSync(path.join(dir, 'install-state.json'), JSON.stringify({
    version: 1, installs: { user: { claude: { statusInstalled: true, compose: [{ command, shell }] } } }
  }));
  const args = ['status', '--agent', 'claude', '--ingest-stdin', '--compose', 'user'];
  record(`"${process.execPath}" -e "process.stdout.write('other line\\n')" ${runId}`);
  const quick = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await tw(args, { input: claudeStatus('perf-compose', 1 + i / 100), env: { TOKENWATCH_HOME: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /other line/);
    quick.push(result.ms);
  }
  row('status --compose, quick other command', quick);

  // The other command starts a process of its own that outlives it: a node
  // started by the shell. It never finishes within the 1 s compose timeout.
  record(`"${process.execPath}" -e "setTimeout(() => {}, 12000)" ${runId}`);
  const started = process.hrtime.bigint();
  let printedAt;
  const child = spawn(process.execPath, [cli, ...args, '--tw-perf', runId], { env: { ...process.env, TOKENWATCH_HOME: dir }, windowsHide: true });
  child.stdout.once('data', () => { printedAt = Number(process.hrtime.bigint() - started) / 1e6; });
  child.stdin.end(claudeStatus('perf-compose', 2));
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20_000);
    child.on('exit', () => { clearTimeout(timer); resolve(Number(process.hrtime.bigint() - started) / 1e6); });
  });
  const remaining = leftovers();
  row('status --compose, other command hangs', [exited ?? 20_000],
    `printed after ${Math.round(printedAt ?? NaN)} ms; process ${exited === undefined ? 'still running at 20 s' : `exited after ${Math.round(exited)} ms`}; ${remaining.length} process(es) left: ${remaining.map((entry) => entry.name).join(', ') || 'none'}`);
  killAll(remaining);
  if (exited === undefined) child.kill();
});

// Claude Code cancels a status script still running when the next update
// arrives (it debounces at 300 ms). On Windows it runs the script through Git
// Bash, and ending that bash is what a cancel can reach. This records what is
// left of a composed render after its shell is ended at 300 ms.
measure('a composed render whose shell is ended mid-render, as a cancelled Claude Code render is', { skip: (!win && 'Windows kill semantics') || (!findGitBash() && 'no Git Bash') }, async () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, 'install-state.json'), JSON.stringify({
    version: 1, installs: { user: { claude: { statusInstalled: true, compose: [{ command: `"${process.execPath}" -e "setTimeout(() => {}, 8000)" ${runId}`, shell: 'cmd' }] } } }
  }));
  const { file, args } = shellLineInvocation(`node "${cli}" status --agent claude --ingest-stdin --compose user --tw-perf ${runId}`, { shell: 'bash', shellPath: findGitBash() });
  const shellProcess = spawn(file, args, { env: { ...process.env, TOKENWATCH_HOME: dir }, windowsHide: true });
  shellProcess.stdin.end(claudeStatus('perf-cancel', 3));
  await new Promise((resolve) => setTimeout(resolve, 300));
  shellProcess.kill();
  const seen = [];
  const started = Date.now();
  let lastSeen = 0;
  while (Date.now() - started < 15_000) {
    const now = leftovers();
    seen.push(now.length);
    if (now.length) lastSeen = Date.now() - started;
    if (!now.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const remaining = leftovers();
  row('compose render, shell ended at 300 ms', [lastSeen], `processes seen after the cancel: ${seen.join(',')}; ${remaining.length} still running at the end`);
  killAll(remaining);
});

// doctor proves each installed command runs by starting it through the shell
// its agent uses. With Claude Code and Copilot CLI installed that is several
// shells and a Node process per hook; this counts them and times the run.
measure('doctor with Claude Code and Copilot CLI installed: its shells, its Node processes, its time', async () => {
  const dir = home();
  const agentHome = path.join(dir, 'home');
  fs.mkdirSync(agentHome, { recursive: true });
  const env = { TOKENWATCH_HOME: path.join(dir, 'tw'), HOME: agentHome, USERPROFILE: agentHome };
  const installed = await run(process.execPath, [cli, 'install', '--agents', 'claude,copilot',
    '--claude-settings', path.join(agentHome, '.claude', 'settings.json'), '--claude-skills', path.join(agentHome, '.claude', 'skills'),
    '--copilot-config', path.join(agentHome, '.copilot', 'settings.json'), '--copilot-hooks', path.join(agentHome, '.copilot', 'hooks', 'tokenwatch.json'),
    '--shared-skills', path.join(agentHome, '.agents', 'skills')], { env, cwd: dir });
  assert.equal(installed.status, 0, installed.stderr);
  // Two small preloads, written for this run: one wraps spawnSync in the doctor
  // process itself to count the shells it starts; the other, through
  // NODE_OPTIONS, which every probe inherits, logs each Node process started.
  const spawnLog = path.join(dir, 'spawns.json');
  const nodeLog = path.join(dir, 'nodes.log');
  const counter = path.join(dir, 'count-spawns.cjs');
  const nodeCounter = path.join(dir, 'count-nodes.cjs');
  fs.writeFileSync(counter, `const cp = require('node:child_process'); const path = require('node:path');
const original = cp.spawnSync; const stats = {};
cp.spawnSync = function (file, args, options) {
  const started = process.hrtime.bigint();
  try { return original.apply(this, arguments); } finally {
    const key = options && options.shell ? 'shell:true' : path.basename(String(file)).toLowerCase();
    const entry = stats[key] || (stats[key] = { n: 0, ms: 0 });
    entry.n += 1; entry.ms += Number(process.hrtime.bigint() - started) / 1e6;
  }
};
require('node:module').syncBuiltinESMExports();
process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(stats)));
`);
  fs.writeFileSync(nodeCounter, `require('node:fs').appendFileSync(${JSON.stringify(nodeLog)}, process.pid + '\\n');\n`);
  const watch = sampler();
  const result = await run(process.execPath, ['--require', counter, cli, 'doctor', '--json', '--tw-perf', runId], {
    env: { ...env, NODE_OPTIONS: `--require ${JSON.stringify(nodeCounter)}` }, cwd: dir
  });
  const peak = await watch.stop();
  const report = JSON.parse(result.stdout);
  const spawns = JSON.parse(fs.readFileSync(spawnLog, 'utf8'));
  const nodes = fs.readFileSync(nodeLog, 'utf8').trim().split('\n').length - 1;
  const shells = Object.entries(spawns).map(([name, entry]) => `${name} x${entry.n} ${Math.round(entry.ms)} ms`).join(', ');
  const counts = report.checks.reduce((all, check) => ({ ...all, [check.status]: (all[check.status] ?? 0) + 1 }), {});
  row('doctor (claude + copilot installed)', [result.ms], `${shells}; ${nodes} Node probes; sampled peak node ${peak.node} pwsh ${peak.pwsh} powershell ${peak.powershell}; checks ${JSON.stringify(counts)}`);
  for (const check of report.checks.filter((entry) => entry.status === 'error')) console.log(`doctor error: ${check.id}: ${check.detail}`);
  assert.deepEqual(leftovers(), []);
});

measure('the measurements, as a table', () => {
  // Real-time scanning inspects every file a process creates and every
  // executable it starts, so whether it was on changes what these numbers mean.
  const defender = win
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpComputerStatus).RealTimeProtectionEnabled'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout.trim() || 'unknown'
    : 'n/a';
  const lines = [
    `platform ${process.platform} ${os.release()}, node ${process.version}, ${os.cpus().length} CPUs, Defender real-time protection: ${defender}`,
    `${'measurement'.padEnd(44)} ${'n'.padStart(3)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'max'.padStart(6)}  note`,
    ...rows.map((entry) => `${entry.name.padEnd(44)} ${String(entry.n).padStart(3)} ${String(entry.p50).padStart(6)} ${String(entry.p95).padStart(6)} ${String(entry.max).padStart(6)}  ${entry.note}`)
  ];
  console.log(`\n${lines.join('\n')}\n`);
});
