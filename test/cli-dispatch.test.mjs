import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { normalizeAgentPayload } from '../src/normalize/index.mjs';
import { sessionStateFile, statusState, storeEvent, storeEvents } from '../src/store.mjs';
import { rollingStatusFromState } from '../src/aggregate.mjs';
import { bundledSkills, install } from '../src/installer.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { readRelayRecord, recordRelayOutcome, relayRecordFile, relayRecordSummary } from '../src/relay-record.mjs';
import { makeEvent } from '../src/schema.mjs';
import { HELP } from '../src/help.mjs';
import { fixture, tempDir, testConfig } from './helpers.mjs';

// `test/cli.test.mjs` drives `bin/tokenwatch.mjs` as a subprocess, which is the
// honest end-to-end check but is invisible to coverage: node's coverage does not
// follow a child process. That left the dispatcher - the path from argv to every
// module - at roughly a third covered while the modules themselves sat near 90%.
// These run `main()` in-process against an injected config, so every command's
// argv parsing, option wiring and output shape is exercised where it is measured.

// Only string writes are captured. Under `node --test` each file runs as a child
// process that reports its results to the runner over this same stdout, as
// binary buffers; swallowing those would lose results and corrupt the capture.
async function run(argv, config, env) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk !== 'string') return original.call(this, chunk, ...rest);
    chunks.push(chunk);
    return true;
  };
  try {
    const code = await main(argv, { config, configFile: '(test)', env });
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

function sandbox() {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return { root, config, env: { TOKENWATCH_HOME: path.join(root, 'home') } };
}

function seed(config) {
  for (const name of ['claude-status-1.json', 'claude-status-2.json']) {
    storeEvents(normalizeAgentPayload('claude', 'status', fixture(name), config, 'statusline'), config);
  }
}

// The seeded status samples belong to one turn that is still in flight, so they
// sit in pending state rather than the ledger. `agents` must flush them first:
// it is the command every reporting skill runs to decide which agent has data.
test('agents reports per-agent activity, including the turn still in flight', async () => {
  const { config, env } = sandbox();
  seed(config);
  const json = await run(['agents', '--json'], config, env);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.stdout);
  assert.ok(Array.isArray(report.agents));
  assert.ok(report.agents.some((row) => row.agent === 'claude-code' && row.events > 0));
  const text = await run(['agents'], config, env);
  assert.match(text.stdout, /^host: /);
  assert.match(text.stdout, /claude-code: last /);
});

test('analyze renders markdown by default, JSON on request, and ranks with --group-by', async () => {
  const { config, env } = sandbox();
  seed(config);
  const markdown = await run(['analyze'], config, env);
  assert.equal(markdown.code, 0);
  assert.match(markdown.stdout, /^#/m);
  const json = JSON.parse((await run(['analyze', '--json', '--group-by', 'model', '--agent', 'claude'], config, env)).stdout);
  assert.ok(json.ranking, 'group-by adds a ranking');
  assert.ok('concentration' in json);
  assert.ok('compactions' in json);
});

test('analyze --compare needs a window, and compares against an equal prior one', async () => {
  const { config, env } = sandbox();
  seed(config);
  await assert.rejects(run(['analyze', '--compare'], config, env), /--compare requires --since/);
  const json = JSON.parse((await run(['analyze', '--json', '--since', '30d', '--compare'], config, env)).stdout);
  assert.ok(json.comparison.prior_since < json.comparison.current_since);
});

test('analyze --output writes the report to a file instead of stdout', async () => {
  const { root, config, env } = sandbox();
  seed(config);
  const file = path.join(root, 'audit.md');
  const result = await run(['analyze', '--output', file], config, env);
  assert.equal(result.stdout, '');
  assert.match(fs.readFileSync(file, 'utf8'), /^#/m);
});

test('experiment add, list and close round-trip through the journal', async () => {
  const { config, env } = sandbox();
  const added = await run(['experiment', 'add', '--hypothesis', 'shorter prompts cut input',
    '--change', 'trim system prompt', '--baseline', '12k input tokens per turn',
    '--metric', 'input tokens per turn', '--id', 'exp-1'], config, env);
  assert.equal(added.stdout.trim(), 'exp-1');
  const open = JSON.parse((await run(['experiment', 'list', '--json'], config, env)).stdout);
  assert.deepEqual(open.map((row) => row.id), ['exp-1']);
  assert.equal((await run(['experiment'], config, env)).code, 0, 'list is the default subcommand');
  const closed = await run(['experiment', 'close', 'exp-1', '--result', 'adopted',
    '--outcome', 'input per turn fell to 9k'], config, env);
  assert.match(closed.stdout, /exp-1 closed as adopted/);
  assert.deepEqual(JSON.parse((await run(['experiment', 'list', '--json'], config, env)).stdout), []);
  assert.equal(JSON.parse((await run(['experiment', 'list', '--all', '--json'], config, env)).stdout).length, 1);
  await assert.rejects(run(['experiment', 'bogus'], config, env), /Unknown experiment subcommand/);
});

test('export emits JSON by default and CSV on request', async () => {
  const { config, env } = sandbox();
  seed(config);
  const json = JSON.parse((await run(['export'], config, env)).stdout);
  assert.ok(json.length > 0);
  const csv = (await run(['export', '--format', 'csv'], config, env)).stdout;
  assert.ok(csv.split('\n')[0].includes(','), 'CSV has a header row');
});

test('prune refuses a bare call, and honours --older-than and --retention', async () => {
  const { config, env } = sandbox();
  seed(config);
  await assert.rejects(run(['prune'], config, env), /prune requires --older-than/);
  const explicit = JSON.parse((await run(['prune', '--older-than', '3650d'], config, env)).stdout);
  assert.ok(explicit.cutoff);
  const retention = JSON.parse((await run(['prune', '--retention'], config, env)).stdout);
  const ageDays = (Date.now() - new Date(retention.cutoff).getTime()) / 86_400_000;
  assert.ok(Math.abs(ageDays - config.retentionDays) < 1, 'the cutoff is retentionDays ago');
});

test('repair --dry-run reports without failing', async () => {
  const { config, env } = sandbox();
  seed(config);
  const result = await run(['repair', '--dry-run'], config, env);
  assert.equal(result.code, 0);
  assert.equal(typeof JSON.parse(result.stdout), 'object');
});

test('config show, path, get and set, with their refusals', async () => {
  const { root, config, env } = sandbox();
  assert.equal(JSON.parse((await run(['config'], config, env)).stdout).retentionDays, 90);
  assert.equal((await run(['config', 'path'], config, env)).stdout.trim(), path.join(root, 'home', 'config.json'));
  assert.equal(JSON.parse((await run(['config', 'get', 'retentionDays'], config, env)).stdout), 90);
  const written = (await run(['config', 'set', 'retentionDays', '30'], config, env)).stdout.trim();
  assert.equal(JSON.parse(fs.readFileSync(written, 'utf8')).retentionDays, 30, 'a JSON value is stored typed');
  await run(['config', 'set', 'codex.command', 'my-codex'], config, env);
  assert.equal(config.codex.command, 'my-codex', 'a non-JSON value is stored as a string');
  await assert.rejects(run(['config', 'get'], config, env), /requires a dotted key/);
  await assert.rejects(run(['config', 'set', 'retentionDays'], config, env), /config set requires/);
  await assert.rejects(run(['config', 'bogus'], config, env), /Unknown config subcommand/);
});

test('paths reports the injected locations', async () => {
  const { config, env } = sandbox();
  const report = JSON.parse((await run(['paths'], config, env)).stdout);
  assert.equal(report.data, config.dataFile);
  assert.equal(report.state, config.stateFile);
  assert.deepEqual(report.managedInstalls, {});
});

// `paths` prints every install record. It used to print them raw: another
// tool's composed status command, the line the slot held, and a skill text an
// older version kept inline in the record. It shows them as install does.
test('paths shows install records the way install prints them, without another tool\'s command or a replaced skill\'s text', async () => {
  const { root, config, env } = sandbox();
  const settings = path.join(root, 'claude-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool --token OTHER-POISON' } }));
  await run(['install', '--agents', 'claude', '--scope', 'project', '--project', root,
    '--claude-settings', settings, '--claude-skills', path.join(root, 'claude-skills')], config, env);
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const [stored] = Object.values(state.installs);
  assert.match(JSON.stringify(stored.claude), /OTHER-POISON/, 'the record on disk keeps the composed command, as it must');
  stored.claudeSkills[0].prior = 'LEGACY-SKILL-POISON team notes\n';
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));

  const shown = Object.values(JSON.parse((await run(['paths'], config, env)).stdout).managedInstalls)[0];
  assert.doesNotMatch(JSON.stringify(shown), /OTHER-POISON|LEGACY-SKILL-POISON/, JSON.stringify(shown));
  assert.equal(shown.claude.compose.length, 1, 'the composed entry is still listed, by hash and file');
  assert.equal(shown.claude.compose[0].sha256, stored.claude.compose[0].sha256);
  assert.equal(shown.claudeSkills[0].sha256, stored.claudeSkills[0].sha256, 'the skill is still listed, by hash');
});

test('doctor emits a JSON report and exits by its verdict', async () => {
  const { config, env } = sandbox();
  const result = await run(['doctor', '--json'], config, env);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.checks));
  assert.equal(result.code, report.ok ? 0 : 1);
  const text = await run(['doctor'], config, env);
  assert.ok(text.stdout.length > 0);
});

test('install and uninstall dispatch with every path option wired through', async () => {
  const { root, config, env } = sandbox();
  const p = {
    claudeSettings: path.join(root, 'claude-settings.json'),
    claudeSkills: path.join(root, 'claude-skills'),
    copilotConfig: path.join(root, 'copilot-config.json'),
    copilotHooks: path.join(root, 'copilot-hooks', 'tokenwatch.json'),
    codexConfig: path.join(root, 'codex-config.toml'),
    sharedSkills: path.join(root, 'agents-skills')
  };
  const flags = Object.entries(p).flatMap(([key, value]) =>
    [`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value]);
  const installed = JSON.parse((await run(['install', '--agents', 'all', '--scope', 'project',
    '--project', root, ...flags], config, env)).stdout);
  assert.ok(installed.claude.statusInstalled);
  for (const name of bundledSkills()) {
    assert.ok(fs.existsSync(path.join(p.claudeSkills, name, 'SKILL.md')), `${name} landed at the --claude-skills path`);
  }
  assert.equal(Object.keys(JSON.parse((await run(['paths'], config, env)).stdout).managedInstalls).length, 1);
  const removed = JSON.parse((await run(['uninstall', '--scope', 'project', '--project', root], config, env)).stdout);
  assert.equal(removed.removed, true);
});

// Every instruction for running a skill used to be Claude Code's `/tw-…`,
// which Codex does not recognise: it takes `$tw-…` or its `/skills` list. The
// install output is the first place a user learns what to type, so it says it
// per agent. It is advice, not state, so the install record does not keep it.
test('install tells each agent\'s users how to invoke the skills, and does not store the advice', async () => {
  const { root, config, env } = sandbox();
  const flags = ['--claude-settings', path.join(root, 'claude-settings.json'),
    '--claude-skills', path.join(root, 'claude-skills'),
    '--copilot-config', path.join(root, 'copilot-config.json'),
    '--copilot-hooks', path.join(root, 'copilot-hooks', 'tokenwatch.json'),
    '--codex-config', path.join(root, 'codex-config.toml'),
    '--shared-skills', path.join(root, '.agents', 'skills')];
  const printed = JSON.parse((await run(['install', '--agents', 'all', '--scope', 'project',
    '--project', root, ...flags], config, env)).stdout);
  assert.match(printed.skillUsage.codex, /\$tw-retrospective-this-session/, printed.skillUsage.codex);
  assert.match(printed.skillUsage.codex, /\/skills/, printed.skillUsage.codex);
  assert.doesNotMatch(printed.skillUsage.codex, /Type \/tw-/, 'Codex is not told to use Claude Code\'s syntax');
  assert.match(printed.skillUsage.claude, /\/tw-retrospective-this-session/, printed.skillUsage.claude);
  assert.match(printed.skillUsage.copilot, /\/tw-retrospective-this-session/, printed.skillUsage.copilot);
  const stored = Object.values(JSON.parse((await run(['paths'], config, env)).stdout).managedInstalls)[0];
  assert.equal(stored.skillUsage, undefined, 'the install record keeps only what uninstall needs');

  const { root: codexRoot, config: codexConfig, env: codexEnv } = sandbox();
  const codexOnly = JSON.parse((await run(['install', '--agents', 'codex', '--scope', 'project',
    '--project', codexRoot, '--codex-config', path.join(codexRoot, 'codex-config.toml'),
    '--shared-skills', path.join(codexRoot, '.agents', 'skills')], codexConfig, codexEnv)).stdout);
  assert.deepEqual(Object.keys(codexOnly.skillUsage), ['codex'], 'only the installed agent is described');
});

test('hook stores a positional payload and reports it with --json', async () => {
  const { config, env } = sandbox();
  const payload = JSON.stringify(fixture('claude-status-1.json'));
  const result = await run(['hook', 'claude', 'status', payload, '--json'], config, env);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['ok', 'stored']);
  await assert.rejects(run(['hook'], config, env), /hook requires an agent name/);
});

test('notify-relay stores a Codex payload and relays nothing without --install', async () => {
  const { config, env } = sandbox();
  const payload = JSON.stringify(fixture('codex-notify.json'));
  const result = JSON.parse((await run(['notify-relay', payload, '--json'], config, env)).stdout);
  assert.deepEqual(result, { ok: true, priorNotifier: false });
});

test('otlp rejects an unknown subcommand, and an unknown command is refused', async () => {
  const { config, env } = sandbox();
  await assert.rejects(run(['otlp', 'bogus'], config, env), /Unknown otlp subcommand/);
  await assert.rejects(run(['bogus'], config, env), /Unknown command: bogus/);
});

// --- A data directory that can be read but not written ---------------------
//
// Codex runs an agent's shell commands in a sandbox that, by default, cannot
// write outside the workspace. On the first Windows run that made `tokenwatch
// agents` - the command every reporting skill runs first - fail with EPERM,
// because it flushes the in-flight turn into the ledger before reading it.
// These tests make the directory genuinely read-only rather than simulating a
// refusal, because what matters is what the real filesystem does.

// stdout and stderr both, strings only, for the same reason `run` captures only
// strings: the runner's own binary traffic shares stdout.
async function runCapturing(argv, injected) {
  const out = [];
  const err = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const capture = (sink, original) => function (chunk, ...rest) {
    if (typeof chunk !== 'string') return original.call(this, chunk, ...rest);
    sink.push(chunk);
    return true;
  };
  process.stdout.write = capture(out, originals.out);
  process.stderr.write = capture(err, originals.err);
  try {
    const code = await main(argv, injected);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  }
}

// chmod only takes away write access where the OS enforces it for this user.
// Root writes through directory permissions, and Windows ignores the POSIX
// write bits on directories, so on either the test would pass without proving
// anything. Rather than trust a list, it also checks that the filesystem here
// actually refuses the write.
function readOnlyUnsupported(root) {
  if (process.platform === 'win32') return 'chmod cannot make a directory unwritable on Windows';
  if (process.getuid?.() === 0) return 'running as root, which writes through directory permissions';
  const probe = path.join(root, 'probe');
  fs.mkdirSync(probe);
  fs.chmodSync(probe, 0o500);
  try {
    fs.writeFileSync(path.join(probe, 'x'), '');
    return 'this filesystem does not enforce directory permissions';
  } catch {
    return undefined;
  } finally {
    fs.chmodSync(probe, 0o700);
  }
}

// Directory write bits govern creating and renaming; appending to a file that
// already exists is governed by the file's own mode. Both are taken away, as a
// sandbox does. Returns the function that gives them back.
function makeReadOnly(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      entries.push({ full, dir: entry.isDirectory() });
    }
  };
  walk(dir);
  entries.push({ full: dir, dir: true });
  for (const { full, dir: isDir } of entries) fs.chmodSync(full, isDir ? 0o500 : 0o400);
  return () => {
    for (const { full, dir: isDir } of entries.slice().reverse()) fs.chmodSync(full, isDir ? 0o700 : 0o600);
  };
}

const READ_ONLY_NOTE = /in-flight turn included from pending state; data directory is read-only here, nothing was flushed/;

test('reporting commands on a read-only data directory exit 0, say nothing was flushed, and still include the in-flight turn', async (t) => {
  const { root, config, env } = sandbox();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  seed(config);
  const stateFile = sessionStateFile(config, 'claude-session-1');
  const stateBefore = fs.readFileSync(stateFile, 'utf8');
  const unlock = makeReadOnly(path.join(root, 'state'));
  try {
    const injected = { config, configFile: '(test)', env };

    const agents = await runCapturing(['agents', '--json'], injected);
    assert.equal(agents.code, 0, `agents exited ${agents.code}: ${agents.stderr}`);
    const agentsReport = JSON.parse(agents.stdout);
    assert.equal(agentsReport.degraded?.flushed, false, `got ${JSON.stringify(agentsReport.degraded)}`);
    assert.ok(['EACCES', 'EPERM', 'EROFS'].includes(agentsReport.degraded.code), `got ${agentsReport.degraded.code}`);
    const claude = agentsReport.agents.find((row) => row.agent === 'claude-code');
    assert.equal(claude?.events, 1, `the in-flight turn is reported, got ${JSON.stringify(agentsReport.agents)}`);
    const agentsText = await runCapturing(['agents'], injected);
    assert.match(agentsText.stdout, READ_ONLY_NOTE);
    assert.match(agentsText.stdout, /claude-code: last /);

    const analyze = await runCapturing(['analyze', '--json', '--agent', 'claude'], injected);
    assert.equal(analyze.code, 0, `analyze exited ${analyze.code}: ${analyze.stderr}`);
    const audit = JSON.parse(analyze.stdout);
    assert.equal(audit.degraded?.flushed, false, `got ${JSON.stringify(audit.degraded)}`);
    assert.equal(audit.aggregate.turns, 1, `the in-flight turn is analysed, got ${audit.aggregate.turns}`);
    const markdown = await runCapturing(['analyze'], injected);
    assert.match(markdown.stdout, READ_ONLY_NOTE);

    const exported = await runCapturing(['export'], injected);
    assert.equal(exported.code, 0, `export exited ${exported.code}: ${exported.stderr}`);
    const rows = JSON.parse(exported.stdout);
    assert.equal(rows.length, 1, `the in-flight turn is exported, got ${rows.length} rows`);
    assert.equal(rows[0].usage.input_total, 8500, 'the turn carries its latest gauge, as a flush would write it');
    assert.match(exported.stderr, READ_ONLY_NOTE, 'export says so where it cannot change the data it prints');

    assert.equal(fs.existsSync(config.dataFile), false, 'nothing was appended');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, 'the pending turn is still pending on disk');
  } finally {
    unlock();
  }
});

// The in-memory view and the flush share one function, so what a read-only run
// shows must be exactly what a writable run then writes and reads back - and a
// writable run's output must carry no trace of the degraded mode.
test('with the data directory writable, reports are unchanged and match what the read-only view showed', async (t) => {
  const { root, config, env } = sandbox();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  seed(config);
  const injected = { config, configFile: '(test)', env };
  const unlock = makeReadOnly(path.join(root, 'state'));
  let readOnly;
  try {
    readOnly = {
      agents: JSON.parse((await runCapturing(['agents', '--json'], injected)).stdout),
      analyze: JSON.parse((await runCapturing(['analyze', '--json'], injected)).stdout),
      exported: JSON.parse((await runCapturing(['export'], injected)).stdout)
    };
  } finally {
    unlock();
  }

  const agents = await runCapturing(['agents', '--json'], injected);
  const writable = JSON.parse(agents.stdout);
  assert.equal(writable.degraded, undefined, `a writable run reports no degraded mode, got ${JSON.stringify(writable.degraded)}`);
  assert.equal(fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').length, 1, 'the in-flight turn was flushed once');
  assert.deepEqual(writable.agents, readOnly.agents.agents);
  assert.doesNotMatch((await runCapturing(['agents'], injected)).stdout, /note:/);

  const analyze = await runCapturing(['analyze', '--json'], injected);
  const audit = JSON.parse(analyze.stdout);
  assert.equal(audit.degraded, undefined);
  assert.deepEqual(audit.aggregate, readOnly.analyze.aggregate);
  assert.deepEqual(audit.recommendations, readOnly.analyze.recommendations);

  const exported = await runCapturing(['export'], injected);
  assert.equal(exported.stderr, '', `a writable export prints no note, got ${exported.stderr}`);
  assert.deepEqual(JSON.parse(exported.stdout), readOnly.exported, 'the flushed record is the one the read-only view showed');
});

// Found while testing the above against a real home rather than an injected
// config: `loadConfig` writes merged defaults back whenever the file on disk is
// missing a key, which a config written by an older version always is. In a
// read-only home that made every command fail before it reached its handler.
test('a config written by an older version does not stop commands in a read-only home', async (t) => {
  const root = tempDir();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  const home = path.join(root, 'home');
  const env = { TOKENWATCH_HOME: home };
  const { config, file } = loadConfig({ env });
  storeEvents(normalizeAgentPayload('claude', 'status', fixture('claude-status-1.json'), config, 'statusline'), config);
  const older = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete older.status.layout;
  fs.writeFileSync(file, JSON.stringify(older));
  const unlock = makeReadOnly(home);
  try {
    const result = await runCapturing(['agents', '--json'], { env });
    assert.equal(result.code, 0, `agents exited ${result.code}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).degraded?.flushed, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status.layout, undefined, 'the config was left as it was');
  } finally {
    unlock();
  }
});

// `status` reads its payload from stdin, which an in-process `main()` cannot be
// handed without blocking on the runner's own stdin, so this one runs the real
// entry point as `test/cli.test.mjs` does.
test('status on a read-only data directory renders the reading it was handed and says it was not recorded', (t) => {
  const root = tempDir();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  const home = path.join(root, 'home');
  const { config } = loadConfig({ env: { TOKENWATCH_HOME: home } });
  storeEvents(normalizeAgentPayload('claude', 'status', fixture('claude-status-1.json'), config, 'statusline'), config);
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: home };
  delete env.TOKENWATCH_CONFIG;
  delete env.TOKENWATCH_DATA;
  const status = (args) => spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', ...args], {
    input: JSON.stringify(fixture('claude-status-2.json')), encoding: 'utf8', env
  });
  const stateFile = sessionStateFile(config, 'claude-session-1');
  const stateBefore = fs.readFileSync(stateFile, 'utf8');

  const unlock = makeReadOnly(home);
  let readOnly;
  let text;
  try {
    readOnly = status(['--json']);
    text = status([]);
  } finally {
    unlock();
  }
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const snapshot = JSON.parse(readOnly.stdout);
  assert.equal(snapshot.degraded?.recorded, false, `got ${JSON.stringify(snapshot.degraded)}`);
  // Fixture 1 reads 8000 and fixture 2 reads 8500: the render shows the payload
  // it was just handed, not the last reading a writable run managed to save.
  assert.equal(snapshot.latest.usage.input_total, 8500, `got ${snapshot.latest.usage.input_total}`);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /note: data directory is read-only here; this reading is shown but was not recorded/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, 'nothing was written');

  const writable = status(['--json']);
  assert.equal(writable.status, 0, writable.stderr);
  const stored = JSON.parse(writable.stdout);
  assert.equal(stored.degraded, undefined, 'a writable render reports no degraded mode');
  assert.equal(stored.latest.usage.input_total, snapshot.latest.usage.input_total);
  assert.doesNotMatch(status([]).stdout, /note:/);
});

// Intent 15: with two sessions on disk, a hand-run `status` reports the one it
// was asked for - by `--session` or by Claude Code's own session variable - and
// under the fallback it says the figures are whichever session wrote last. Real
// entry point, for the same stdin reason as above; `input: ''` is the hand run.
function twoSessionHome() {
  const home = path.join(tempDir(), 'home');
  const { config } = loadConfig({ env: { TOKENWATCH_HOME: home } });
  const render = (session, cost, ts) => ({
    ...normalizeAgentPayload('claude', 'status', {
      session_id: session, prompt_id: `p-${session}-${cost}`, model: { id: 'claude-test-model' },
      cost: { total_cost_usd: cost },
      context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
    }, config, 'statusline')[0],
    ts
  });
  storeEvent(render('A', 1, '2026-09-24T10:00:00.000Z'), config);
  storeEvent(render('A', 2, '2026-09-24T10:00:01.000Z'), config);
  storeEvent(render('B', 5, '2026-09-24T10:00:02.000Z'), config);
  return { home, config };
}

function statusRun(home, args, { input = '', env: extra = {} } = {}) {
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: home, ...extra };
  delete env.TOKENWATCH_CONFIG;
  delete env.TOKENWATCH_DATA;
  // The suite may itself run inside Claude Code; its own session id must not
  // leak into a run that means to test the fallback.
  if (!('CLAUDE_CODE_SESSION_ID' in extra)) delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', ...args], { input, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('a hand-run status reports the session it was asked for, and marks the fallback', () => {
  const { home } = twoSessionHome();
  const scoped = (args, options) => JSON.parse(statusRun(home, ['--json', ...args], options).stdout);

  const byOption = scoped(['--session', 'A']);
  assert.equal(byOption.latest.session_id, 'A');
  assert.deepEqual(byOption.session_scope, { session_id: 'A', basis: 'option', state_found: true });

  const byEnv = scoped([], { env: { CLAUDE_CODE_SESSION_ID: 'A' } });
  assert.equal(byEnv.latest.session_id, 'A');
  assert.equal(byEnv.session_scope.basis, 'environment:CLAUDE_CODE_SESSION_ID');

  // --session outranks the environment.
  assert.equal(scoped(['--session', 'B'], { env: { CLAUDE_CODE_SESSION_ID: 'A' } }).latest.session_id, 'B');

  const fallback = scoped([]);
  assert.equal(fallback.latest.session_id, 'B');
  assert.deepEqual(fallback.session_scope, { session_id: 'B', basis: 'most_recent_fallback', state_found: true });
  assert.match(statusRun(home, []).stdout,
    /^note: no session id given; showing the most recently active claude session \(B\)\. Pass --session <id> to choose one\.$/m);
  assert.doesNotMatch(statusRun(home, ['--session', 'A']).stdout, /note:/);

  // Claude's variable never answers for another agent (FR-21).
  const copilot = JSON.parse(statusRun(home, ['--json', '--agent', 'copilot'], { env: { CLAUDE_CODE_SESSION_ID: 'A' } }).stdout);
  assert.equal(copilot.session_scope.basis, 'most_recent_fallback');
  // No Copilot row anywhere, so no session id to name: the note drops the
  // parenthesis rather than naming a Claude session (FR-23).
  assert.match(statusRun(home, ['--agent', 'copilot']).stdout,
    /^note: no session id given; showing the most recently active copilot session\. Pass --session <id> to choose one\.$/m);
});

test('an explicit session that cannot be honoured reports nothing, never another session', () => {
  const { home } = twoSessionHome();
  const scoped = (args) => JSON.parse(statusRun(home, ['--json', ...args]).stdout);

  // A session nobody stored: absent, not replaced by the most recent one (FR-19).
  const missing = scoped(['--session', 'never-stored']);
  assert.equal(missing.latest, undefined);
  assert.deepEqual(missing.session_scope, { session_id: 'never-stored', basis: 'option', state_found: false });

  // A bare flag, an empty value, or one the identifier guard refuses (D1).
  for (const args of [['--session'], ['--session', ''], ['--session', '/home/user/project']]) {
    const rejected = scoped(args);
    assert.equal(rejected.latest, undefined, `${JSON.stringify(args)} must report nothing`);
    assert.deepEqual(rejected.session_scope, { basis: 'unknown', state_found: false, rejected_session_id: true },
      `${JSON.stringify(args)}: got ${JSON.stringify(rejected.session_scope)}`);
  }
  assert.match(statusRun(home, ['--session', '']).stdout, /^note: --session was not a usable session id; nothing was reported$/m);
});

// A status command must render whatever happens (FR-24): a session file that
// cannot be parsed yields an honest empty snapshot, never a failed status line.
test('a session that cannot be read renders an empty snapshot marked unknown', () => {
  const { home, config } = twoSessionHome();
  fs.writeFileSync(sessionStateFile(config, 'A'), '{ not json');
  for (const args of [['--session', 'A'], []]) {
    const snapshot = JSON.parse(statusRun(home, ['--json', ...args], { env: { CLAUDE_CODE_SESSION_ID: 'A' } }).stdout);
    assert.equal(snapshot.latest, undefined);
    assert.deepEqual(snapshot.session_scope, { basis: 'unknown', state_found: false });
  }
  // The piped branch reads the same file the store just failed on (D19).
  fs.mkdirSync(path.dirname(sessionStateFile(config, 'claude-session-1')), { recursive: true });
  fs.writeFileSync(sessionStateFile(config, 'claude-session-1'), '{ not json');
  const piped = JSON.parse(statusRun(home, ['--json'], { input: JSON.stringify(fixture('claude-status-1.json')) }).stdout);
  assert.equal(piped.latest, undefined);
  assert.deepEqual(piped.session_scope, { basis: 'unknown', state_found: false });
});

// The fallback note says "showing the most recently active session"; over a
// ranked file that held nothing there is nothing shown, so no note (FR-12, D22).
test('the fallback note is printed only over a session that was found', () => {
  const home = path.join(tempDir(), 'home');
  const { config } = loadConfig({ env: { TOKENWATCH_HOME: home } });
  fs.mkdirSync(path.dirname(sessionStateFile(config, 'X')), { recursive: true });
  fs.writeFileSync(sessionStateFile(config, 'X'), 'null');
  assert.deepEqual(JSON.parse(statusRun(home, ['--json']).stdout).session_scope,
    { basis: 'most_recent_fallback', state_found: false });
  assert.doesNotMatch(statusRun(home, []).stdout, /note:/);
});

test('a piped payload decides the session, and its render is unchanged apart from session_scope', () => {
  const { home, config } = twoSessionHome();
  const piped = JSON.parse(statusRun(home, ['--json', '--session', 'A'], {
    input: JSON.stringify(fixture('claude-status-1.json')), env: { CLAUDE_CODE_SESSION_ID: 'B' }
  }).stdout);
  assert.equal(piped.latest.session_id, 'claude-session-1');
  assert.deepEqual(piped.session_scope,
    { session_id: 'claude-session-1', basis: 'stdin', state_found: true, requested_session_id: 'A' });

  // A payload without a session id is filed under the shared state file, and the
  // render shows that reading - not session C, whose newest row is later still
  // and which the most-recent fallback would pick (D14).
  storeEvent({
    ...normalizeAgentPayload('claude', 'status', {
      session_id: 'C', prompt_id: 'p-C', model: { id: 'claude-test-model' }, cost: { total_cost_usd: 9 },
      context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
    }, config, 'statusline')[0],
    ts: '2099-01-01T00:00:00.000Z'
  }, config);
  const anonymous = { ...fixture('claude-status-1.json') };
  delete anonymous.session_id;
  const unkeyed = JSON.parse(statusRun(home, ['--json'], { input: JSON.stringify(anonymous) }).stdout);
  assert.deepEqual(unkeyed.session_scope, { basis: 'stdin', state_found: true });
  assert.equal(unkeyed.latest.session_id, undefined);
  assert.equal(unkeyed.latest.usage.input_total, 8000);
  assert.doesNotMatch(statusRun(home, [], { input: JSON.stringify(anonymous) }).stdout, /note:/);

  // D4: the piped path renders exactly what the unchanged statusState gives.
  const { session_scope: _scope, ...rest } = piped;
  const expected = rollingStatusFromState(statusState(config, 'claude-session-1', 'claude-code'), config, 'claude');
  assert.deepEqual(rest, JSON.parse(JSON.stringify(expected)));
});

// The Codex notify relay fails open, and Codex sends its stdout and stderr to
// the null device, so on the first Windows run a relay that recorded nothing
// left no trace anywhere. It now keeps a record of its own runs for `doctor`:
// the stage a run failed at and the error's class, never the payload.

// A Codex install record for `sandbox()`, backdated to a literal so the doctor
// checks below are judged at a fixed instant rather than the wall clock.
function installCodex(root, config, installedAt) {
  install(config, { agents: 'codex', scope: 'project', project: root, codexConfig: path.join(root, 'codex-config.toml') });
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  for (const record of Object.values(state.installs)) record.installedAt = installedAt;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
}

const doctorCheck = (report, id) => report.checks.find((entry) => entry.id === id);

test('a relay handed a payload it cannot parse records the stage and class, never the payload, and doctor names it after one turn', async () => {
  const { root, config, env } = sandbox();
  installCodex(root, config, '2000-01-01T00:00:00.000Z');
  // The shape of a JSON argument whose quotes did not survive a command line.
  const mangled = '{type:agent-turn-complete,input-messages:[SECRET USER TEXT]}';
  const result = await run(['notify-relay', '--agent', 'codex', mangled, '--json'], config, env);
  assert.equal(result.code, 0, 'the relay still fails open');
  assert.equal(fs.existsSync(config.dataFile), false, 'the premise: nothing was recorded');

  const text = fs.readFileSync(relayRecordFile(config), 'utf8');
  assert.doesNotMatch(text, /SECRET|agent-turn-complete|Invalid JSON/, `the record must hold no payload or message text: ${text}`);
  const record = JSON.parse(text);
  assert.equal(record.failure_count, 1);
  assert.equal(record.last_success_at, undefined, 'a relay that never recorded has no success time');
  const [failure] = record.failures;
  assert.deepEqual({ stage: failure.stage, payload: failure.payload, error: failure.error },
    { stage: 'parse', payload: 'argument', error: 'Error' }, `got ${JSON.stringify(failure)}`);

  const report = runDoctor(config, config.installStateFile, { now: '2000-01-01T03:00:00.000Z', projectDir: root, homeDir: path.join(root, 'home') });
  const collection = doctorCheck(report, 'collection:codex');
  assert.equal(collection?.status, 'warn', collection?.detail);
  assert.match(collection.detail, /relay ran and failed 1 time\(s\) since install, and has not recorded a turn; the latest at \S+ in parse \(Error\)/);
  assert.equal(doctorCheck(report, 'codex-relay')?.status, 'warn', doctorCheck(report, 'codex-relay')?.detail);
});

// Codex hands the payload over as the relay's last argument and gives it no
// stdin. When no argument arrives - the other shape a broken command line takes
// - the record says so. Such a run used to be stored as an empty turn, which
// made a relay that never received a payload look like one that worked.
test('a relay that receives no JSON argument records that none arrived', () => {
  const root = tempDir();
  const home = path.join(root, 'home');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: home };
  delete env.TOKENWATCH_CONFIG;
  delete env.TOKENWATCH_DATA;
  const result = spawnSync(process.execPath, [cli, 'notify-relay', '--agent', 'codex'], { input: '', encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const { config } = loadConfig({ env: { TOKENWATCH_HOME: home } });
  const [failure] = readRelayRecord(config)?.failures ?? [];
  assert.deepEqual({ stage: failure?.stage, payload: failure?.payload, error: failure?.error },
    { stage: 'read', payload: 'none', error: 'MissingPayload' }, `got ${JSON.stringify(failure)}`);
  assert.equal(fs.existsSync(config.dataFile), false, 'an empty run is not stored as a turn with no session');
});

test('a relay whose ledger write is refused records the refusal code, and the next good turn clears it', async (t) => {
  const { root, config, env } = sandbox();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  // Only the ledger's directory is read-only; the relay's record sits beside
  // the state files, which stay writable.
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir);
  fs.writeFileSync(path.join(ledgerDir, 'events.jsonl'), '');
  config.dataFile = path.join(ledgerDir, 'events.jsonl');
  const payload = JSON.stringify(fixture('codex-notify.json'));
  const unlock = makeReadOnly(ledgerDir);
  let refused;
  try {
    refused = await run(['notify-relay', payload], config, env);
  } finally {
    unlock();
  }
  assert.equal(refused.code, 0);
  const failure = readRelayRecord(config)?.failures?.[0];
  assert.deepEqual({ stage: failure?.stage, code: failure?.code }, { stage: 'store', code: 'EACCES' }, `got ${JSON.stringify(failure)}`);
  assert.equal(relayRecordSummary(readRelayRecord(config)).failing.length, 1);

  await run(['notify-relay', payload.replace('codex-turn-2', 'codex-turn-3')], config, env);
  const recovered = relayRecordSummary(readRelayRecord(config));
  assert.equal(recovered.failing.length, 0, `a recorded turn after the failure means recording works again, got ${JSON.stringify(recovered)}`);
  assert.equal(typeof recovered.last_success_at, 'string');
});

// Open question: where does the relay record a failure when the data directory
// itself cannot be written? Nowhere - a shared temporary folder would be worse
// than silence. It fails open with no record, and `doctor` infers the case from
// there being no relay run at all since install, which it names.
test('a relay that cannot write the data directory at all still exits 0, and doctor reads the missing record as the relay not recording', async (t) => {
  const { root, config, env } = sandbox();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  installCodex(root, config, '2000-01-01T00:00:00.000Z');
  const stateDir = path.dirname(config.stateFile);
  const unlock = makeReadOnly(stateDir);
  let result;
  let report;
  try {
    result = await run(['notify-relay', JSON.stringify(fixture('codex-notify.json'))], config, env);
    report = runDoctor(config, config.installStateFile, { now: '2000-01-01T03:00:00.000Z', projectDir: root, homeDir: path.join(root, 'home') });
  } finally {
    unlock();
  }
  assert.equal(result.code, 0, 'the relay fails open');
  assert.equal(fs.existsSync(relayRecordFile(config)), false, 'nothing could be written, the record included');
  const collection = doctorCheck(report, 'collection:codex');
  assert.equal(collection?.status, 'warn', collection?.detail);
  assert.match(collection.detail, /no notify relay run recorded, since install/);
  assert.match(collection.detail, /data-directory-write/);
  assert.equal(doctorCheck(report, 'data-directory-write')?.status, 'error', 'doctor sees the same refusal');
});

test('the relay record stays bounded, keeps no error message, and a failing notifier of the user\'s own is kept apart', () => {
  const config = testConfig(tempDir());
  for (let index = 0; index < 25; index += 1) {
    const error = Object.assign(new SyntaxError(`Unexpected token in SECRET USER TEXT ${index}`), { code: 'not a code' });
    recordRelayOutcome(config, { ok: false, stage: 'parse', error, payload: 'argument' }, { now: `2026-09-23T09:${String(index).padStart(2, '0')}:00.000Z` });
  }
  const text = fs.readFileSync(relayRecordFile(config), 'utf8');
  assert.doesNotMatch(text, /SECRET|Unexpected|not a code/, text);
  const record = JSON.parse(text);
  assert.equal(record.failures.length, 20, `the list is capped, got ${record.failures.length}`);
  assert.equal(record.failure_count, 25, 'the count is not');
  assert.equal(record.failures[0].error, 'SyntaxError');
  assert.equal(record.failures[0].code, undefined, 'a code that is not a system code is dropped');
  assert.equal(record.failures.at(-1).at, '2026-09-23T09:24:00.000Z');

  recordRelayOutcome(config, { ok: true }, { now: '2026-09-23T10:00:00.000Z' });
  recordRelayOutcome(config, { ok: false, stage: 'relay-spawn', error: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }) }, { now: '2026-09-23T10:00:01.000Z' });
  const summary = relayRecordSummary(readRelayRecord(config));
  assert.equal(summary.last_success_at, '2026-09-23T10:00:00.000Z');
  assert.deepEqual(summary.failing, [], 'the user\'s own notifier failing is not Tokenwatch failing to record');
  assert.equal(summary.spawn_failures.at(-1).code, 'ENOENT');
});

// Intent 16, D1/D2 (SM-02): composing is the default; --no-compose is the
// old behaviour, word for word.
test('a plain install composes with a taken slot, and --no-compose leaves it as it was', async () => {
  for (const [flags, composed] of [[[], true], [['--no-compose'], false]]) {
    const { root, config, env } = sandbox();
    const claudeSettings = path.join(root, 'claude-settings.json');
    fs.writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'other-status' } }));
    const installed = JSON.parse((await run(['install', '--agents', 'claude', '--scope', 'project', '--project', root,
      '--claude-settings', claudeSettings, '--claude-skills', path.join(root, 'claude-skills'), ...flags], config, env)).stdout);
    const line = JSON.parse(fs.readFileSync(claudeSettings, 'utf8')).statusLine.command;
    const recorded = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0].claude;
    if (composed) {
      assert.equal(recorded.compose?.[0]?.command, 'other-status', 'no flag: composed');
      assert.equal(installed.claude.compose?.length, 1);
      assert.equal(installed.claude.compose[0].command, undefined, 'install output names it by hash, never by command (D32)');
      assert.match(line, /--compose/);
      assert.equal(installed.claude.warning, undefined);
    } else {
      assert.equal(installed.claude.compose, undefined);
      assert.equal(line, 'other-status', '--no-compose: the slot is untouched');
      assert.match(installed.claude.warning, /left unchanged/);
    }
  }
});

// Intent 16, D14: a repair's stdout never carries another tool's command.
test('install --repair output names composed lines by hash and file, never by command', async () => {
  const { root, config, env } = sandbox();
  const claudeSettings = path.join(root, 'claude-settings.json');
  const flags = ['--agents', 'claude', '--scope', 'project', '--project', root, '--claude-settings', claudeSettings, '--claude-skills', path.join(root, 'claude-skills')];
  fs.writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a --secret-token' } }));
  await run(['install', ...flags], config, env);
  fs.writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b --secret-token' } }));
  const result = await run(['install', ...flags, '--repair'], config, env);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret-token|tool-a|tool-b/);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.repaired, true);
  assert.equal(shown.claude.compose.length, 2);
  assert.ok(shown.claude.compose.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256) && entry.command === undefined));
  const onDisk = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  assert.equal(Object.values(onDisk.installs)[0].claude.compose[1].command, 'tool-b --secret-token', 'the record keeps it');
});

// Review H5 (D32): no install output carries another tool's command, whatever
// the agent or the flag.
test('install output never prints another tool\'s status command, for Copilot or under --force', async () => {
  const { root, config, env } = sandbox();
  const copilotConfig = path.join(root, 'copilot-config.json');
  const claudeSettings = path.join(root, 'claude-settings.json');
  fs.writeFileSync(copilotConfig, JSON.stringify({ statusLine: { command: 'copilot-tool --secret-token' } }));
  fs.writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'claude-tool --secret-token' } }));
  const composed = await run(['install', '--agents', 'copilot', '--scope', 'project', '--project', root, '--copilot-config', copilotConfig,
    '--copilot-hooks', path.join(root, 'hooks', 'tw.json'), '--shared-skills', path.join(root, 'shared')], config, env);
  assert.doesNotMatch(composed.stdout, /secret-token|copilot-tool/);
  assert.equal(JSON.parse(composed.stdout).copilot.compose.length, 1);
  const hidden = await run(['install', '--agents', 'claude', '--force', '--scope', 'project', '--project', root, '--claude-settings', claudeSettings,
    '--claude-skills', path.join(root, 'claude-skills')], config, env);
  assert.doesNotMatch(hidden.stdout, /secret-token|claude-tool/, '--force hides it, and the displaced line is not printed either');
  const recorded = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0];
  assert.equal(recorded.claude.priorStatusLine.command, 'claude-tool --secret-token', 'the record keeps it for uninstall');
});

// Review 2 (D33): the other prior values --force keeps for uninstall are not
// printed either: a displaced Copilot hooks file and a displaced Codex notifier.
test('install --force output leaves out a displaced Copilot hooks file and Codex notifier', async () => {
  const { root, config, env } = sandbox();
  const hooks = path.join(root, 'hooks', 'tw.json');
  const codexConfig = path.join(root, 'config.toml');
  fs.mkdirSync(path.dirname(hooks), { recursive: true });
  fs.writeFileSync(hooks, JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'foreign-hook --secret-token' }] } }));
  fs.writeFileSync(codexConfig, 'notify = ["foreign-notifier", "--secret-token"]\n');
  const result = await run(['install', '--agents', 'copilot,codex', '--force', '--scope', 'project', '--project', root,
    '--copilot-config', path.join(root, 'copilot.json'), '--copilot-hooks', hooks, '--codex-config', codexConfig,
    '--shared-skills', path.join(root, 'shared')], config, env);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret-token|foreign-hook|foreign-notifier/);
  const recorded = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0];
  assert.match(JSON.stringify(recorded.copilot.priorHooks), /foreign-hook/, 'the record keeps the hooks file for uninstall');
  assert.match(recorded.codex.priorNotifyLine, /foreign-notifier/, 'and the notifier');
});

// A customised skill `--force` replaces can hold team notes or internal URLs,
// and `install --force` runs in CI, whose output is a build log. Neither
// command prints the replaced text, and the record on disk holds only its hash
// and the path of an owner-only backup.
test('install --force output never prints the skill text it replaced, and uninstall puts it back', async () => {
  const { root, config, env } = sandbox();
  const skills = path.join(root, 'claude-skills');
  const skill = bundledSkills()[0];
  const installed = path.join(skills, skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, 'TEAM NOTES: staging token rotates at vault/ci-7f3a\n');
  const flags = ['--agents', 'claude', '--scope', 'project', '--project', root,
    '--claude-settings', path.join(root, 'claude-settings.json'), '--claude-skills', skills];
  const result = await run(['install', '--force', ...flags], config, env);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /TEAM NOTES|vault\/ci-7f3a/, 'the replaced text is not printed');
  const printed = JSON.parse(result.stdout).claudeSkills.find((row) => row.name === skill);
  assert.equal(Object.hasOwn(printed, 'prior'), false);
  assert.match(printed.priorSha256, /^[0-9a-f]{64}$/, 'it is named by hash');
  assert.doesNotMatch(fs.readFileSync(config.installStateFile, 'utf8'), /TEAM NOTES|vault\/ci-7f3a/, 'nor stored in the record');

  const removed = await run(['uninstall', '--scope', 'project', '--project', root], config, env);
  assert.doesNotMatch(removed.stdout, /TEAM NOTES|vault\/ci-7f3a/, 'uninstall does not print it either');
  assert.equal(fs.readFileSync(installed, 'utf8'), 'TEAM NOTES: staging token rotates at vault/ci-7f3a\n', 'it is restored from the backup');
});

test('a skill record written before backups existed is restored, and its inline text is not printed', async () => {
  const { root, config, env } = sandbox();
  const skills = path.join(root, 'claude-skills');
  const skill = bundledSkills()[0];
  const flags = ['--scope', 'project', '--project', root];
  await run(['install', '--agents', 'claude', ...flags, '--claude-settings', path.join(root, 'claude-settings.json'), '--claude-skills', skills], config, env);
  // Older versions saved the replaced text inline, as `prior`.
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  Object.values(state.installs)[0].claudeSkills.find((row) => row.name === skill).prior = 'TEAM NOTES: legacy inline text\n';
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const removed = await run(['uninstall', ...flags], config, env);
  assert.doesNotMatch(removed.stdout, /TEAM NOTES/, 'uninstall output leaves the inline text out');
  assert.equal(JSON.parse(removed.stdout).removed, true);
  assert.equal(fs.readFileSync(path.join(skills, skill, 'SKILL.md'), 'utf8'), 'TEAM NOTES: legacy inline text\n', 'and still restores it');
});

test('install --compose is wired through from the command line to the install record', async () => {
  const { root, config, env } = sandbox();
  const claudeSettings = path.join(root, 'claude-settings.json');
  fs.writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'other-status' } }));
  const installed = JSON.parse((await run(['install', '--agents', 'claude', '--scope', 'project', '--project', root,
    '--claude-settings', claudeSettings, '--claude-skills', path.join(root, 'claude-skills'), '--compose'], config, env)).stdout);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0].claude.compose?.[0]?.command, 'other-status');
  assert.match(installed.claude.compose?.[0]?.sha256, /^[0-9a-f]{64}$/);
  assert.match(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')).statusLine.command, /--compose/);
});

// Intent 06, NFR-14: the session directories hold the user's prompts and code,
// and only `tokenwatch import` may open them. A preloaded spy records every
// filesystem call that reaches one; the import itself is the control that
// shows the spy sees what it should.
test('no hook, status render, doctor, agents or analyze run opens a session directory; only import does', () => {
  const root = tempDir();
  const home = path.join(root, 'home');
  const sessionDirs = [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions'), path.join(home, '.copilot', 'session-state')];
  for (const dir of sessionDirs) {
    fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'p', 'rollout-x.jsonl'), '{"type":"assistant"}\n');
    fs.writeFileSync(path.join(dir, 'p', 'events.jsonl'), '{"type":"session.start"}\n');
  }
  const spy = path.join(root, 'spy.mjs');
  const log = path.join(root, 'spy.log');
  fs.writeFileSync(spy, `
import fs from 'node:fs';
const dirs = JSON.parse(process.env.TW_SPY_DIRS);
const seen = new Set();
for (const name of ['readdirSync', 'opendirSync', 'openSync', 'statSync', 'lstatSync', 'readFileSync', 'existsSync', 'accessSync', 'createReadStream', 'readdir', 'open', 'stat', 'readFile']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function (target, ...rest) {
    const text = typeof target === 'string' ? target : target instanceof URL ? target.pathname : '';
    if (dirs.some((dir) => text.startsWith(dir))) seen.add(name);
    return original.call(this, target, ...rest);
  };
}
process.on('exit', () => fs.appendFileSync(process.env.TW_SPY_LOG, [...seen].join(',') + '\\n'));
`);
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TOKENWATCH_HOME: path.join(root, 'tw'), TW_SPY_DIRS: JSON.stringify(sessionDirs), TW_SPY_LOG: log };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) delete env[key];
  const touched = (args, input) => {
    fs.rmSync(log, { force: true });
    const result = spawnSync(process.execPath, ['--import', spy, cli, ...args], { encoding: 'utf8', env, input: input ?? '' });
    return { status: result.status, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '(no log)' };
  };
  const payload = JSON.stringify(fixture('claude-status-1.json'));
  for (const args of [['hook', 'claude', 'status', payload], ['doctor', '--json'], ['agents', '--json'], ['analyze', '--json'], ['export']]) {
    assert.equal(touched(args).calls, '', `${args[0]} reached a session directory`);
  }
  assert.equal(touched(['status', '--agent', 'claude', '--ingest-stdin'], payload).calls, '', 'status reached a session directory');
  for (const agent of ['claude', 'codex', 'copilot']) {
    assert.notEqual(touched(['import', agent, '--dry-run']).calls, '', `the control: import ${agent} is seen opening its directory`);
    // Intent 19: sharing or keeping a mapping never reads a session file.
    assert.equal(touched(['import', agent, '--export-mapping']).calls, '', `import ${agent} --export-mapping reached a session directory`);
    assert.equal(touched(['import', agent, '--export-mapping', '--check']).calls, '', `import ${agent} --export-mapping --check ran the import`);
  }
  const mappingFile = path.join(root, 'kept.json');
  fs.writeFileSync(mappingFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(new URL('../src/import/mappings/claude.json', import.meta.url), 'utf8')), mapping_id: 'claude-jsonl-1-r1' }));
  assert.equal(touched(['import', 'claude', '--keep-mapping', mappingFile]).calls, '', 'import --keep-mapping reached a session directory');
});

// `run()` above injects a config; these go through `loadConfig()` the way the
// real CLI does, against a Tokenwatch home that does not exist yet.
async function runFromHome(argv, env) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk !== 'string') return original.call(this, chunk, ...rest);
    chunks.push(chunk);
    return true;
  };
  try {
    return { code: await main(argv, { env }), stdout: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

// doctor is how someone checks a machine before trusting it, so it must not be
// what sets the machine up: it used to write `config.json`, with a fresh random
// project salt, and the data directory, then report the config it had just
// created as `ok`. Every other command still creates both on first use, because
// the salt it writes is what keeps HMAC project identities stable.
test('doctor on a fresh home creates neither config.json nor the data directory, and says the defaults are in use', async () => {
  const home = path.join(tempDir(), 'home');
  const env = { TOKENWATCH_HOME: home };
  const fresh = await runFromHome(['doctor', '--json'], env);
  assert.equal(fs.existsSync(home), false, `doctor created ${home}`);
  const report = JSON.parse(fresh.stdout);
  const config = report.checks.find((entry) => entry.id === 'config');
  assert.equal(config?.status, 'info', `a config file that is not there is not "ok": ${JSON.stringify(config)}`);
  assert.match(config.detail, /^.*config\.json \(not created yet; doctor used the defaults\./, config.detail);
  assert.equal(report.checks.find((entry) => entry.id === 'data-directory-write')?.status, 'info');
  assert.equal(fresh.code, 0, `nothing is broken on a machine that has not recorded yet: ${fresh.stdout}`);

  // The control: a recording command still creates the config and its salt.
  assert.equal((await runFromHome(['hook', 'claude', 'SessionStart', '{"session_id":"s1"}'], env)).code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.match(String(written.projectSalt), /^[0-9a-f]{64}$/, 'the first recording command persists the project salt');
  const after = JSON.parse((await runFromHome(['doctor', '--json'], env)).stdout);
  assert.equal(after.checks.find((entry) => entry.id === 'config')?.status, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).projectSalt, written.projectSalt, 'doctor never rewrites the salt');
});

// `import` writes its usage and refusals to stderr, which `run` above leaves
// alone; this captures both streams, strings only, for the same reason.
async function runBoth(argv, config, env) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk !== 'string') return originalOut.call(this, chunk, ...rest);
    out.push(chunk);
    return true;
  };
  process.stderr.write = function (chunk, ...rest) {
    if (typeof chunk !== 'string') return originalErr.call(this, chunk, ...rest);
    err.push(chunk);
    return true;
  };
  try {
    const code = await main(argv, { config, configFile: '(test)', env });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

// Every file under a directory, by relative name and bytes.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files[path.relative(dir, file)] = fs.readFileSync(file, 'base64');
    }
  };
  walk(dir);
  return files;
}

function importSandbox() {
  const box = sandbox();
  // Never the operator's own session files: a directory that does not exist.
  const none = path.join(box.root, 'no-sessions');
  box.config.import = { claude: { sessionDir: none }, codex: { sessionDir: none }, copilot: { sessionDir: none } };
  return box;
}

function importedRow(agent, mappingId, runId) {
  return makeEvent({
    agent, source: 'import', kind: 'usage', event_name: 'import.response', ts: '2026-09-10T09:00:00.000Z',
    session_id: `${agent}-imported-1`, turn_id: 'resp-1', usage: { input_total: 10, output: 2, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: mappingId, mapping_version: '1.0', run_id: runId, verification: 'unverified', reason: 'no_overlap' }
  });
}

// Intent 06 D12: an undo's dry run writes nothing. It used to flush the turn
// still in flight into the ledger first, so a preview changed the file it was
// previewing. The real undo still flushes - the rewrite must not lose a turn
// sitting in a state file - and the dry run counts that turn as kept, read from
// pending state in memory.
test('an undo dry run writes nothing to the ledger, and reports what the real undo keeps', async () => {
  const { config, env } = importSandbox();
  seed(config);
  fs.appendFileSync(config.dataFile, `${JSON.stringify(importedRow('claude', 'claude-jsonl-1', 'run-1'))}\n`);
  const dataDir = path.dirname(config.dataFile);
  const before = snapshot(dataDir);
  const ledgerBefore = fs.readFileSync(config.dataFile);

  const dry = await runBoth(['import', 'claude', '--undo', 'claude-jsonl-1', '--dry-run'], config, env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(fs.readFileSync(config.dataFile).equals(ledgerBefore), 'the ledger is byte for byte what it was');
  assert.deepEqual(snapshot(dataDir), before, 'no file under the data directory changed, the in-flight turn\'s state included');
  const preview = JSON.parse(dry.stdout);
  assert.deepEqual([preview.dry_run, preview.removed], [true, 1]);

  const real = await runBoth(['import', 'claude', '--undo', 'claude-jsonl-1'], config, env);
  assert.equal(real.code, 0, real.stderr);
  const done = JSON.parse(real.stdout);
  assert.equal(done.removed, 1);
  assert.equal(done.kept, preview.kept, 'the dry run counted the in-flight turn the real undo flushes and keeps');
  const rows = fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(rows.length > 0 && rows.every((row) => row.source !== 'import'), 'the real undo flushed the live turn and removed the imported row');
});

test('an undo never removes another agent\'s imported rows: its mapping id is refused at the command', async () => {
  const { config, env } = importSandbox();
  fs.writeFileSync(config.dataFile, `${JSON.stringify(importedRow('codex', 'codex-rollout-1', 'run-codex'))}\n`);
  const before = fs.readFileSync(config.dataFile);
  for (const extra of [['--dry-run'], []]) {
    const refused = await runBoth(['import', 'claude', '--undo', 'codex-rollout-1', ...extra], config, env);
    const label = extra.join(' ') || 'a real undo';
    assert.equal(refused.code, 1, `${label} is refused`);
    assert.equal(JSON.parse(refused.stdout).removed, 0, label);
    assert.match(refused.stderr, /nothing removed: .*codex/, label);
    assert.ok(fs.readFileSync(config.dataFile).equals(before), `${label}: the Codex history is untouched`);
  }
});

// `--no-export-mapping` parsed to `false`, and a `!== undefined` test read that
// as present, so it exported the mapping instead of importing.
test('--no-export-mapping does not export, and --json=false prints no JSON', async () => {
  const { root, config, env } = importSandbox();
  const empty = path.join(root, 'empty-sessions');
  fs.mkdirSync(empty);
  config.import.claude.sessionDir = empty;
  const noExport = await runBoth(['import', 'claude', '--no-export-mapping', '--dry-run', '--json'], config, env);
  assert.equal(noExport.code, 0, noExport.stderr);
  assert.doesNotMatch(noExport.stderr, /^mapping /m, 'no mapping was exported');
  assert.equal(JSON.parse(noExport.stdout).dry_run, true, 'the command ran the dry run it was asked for');
  const exported = await runBoth(['import', 'claude', '--export-mapping'], config, env);
  assert.equal(JSON.parse(exported.stdout).mapping_id, 'claude-jsonl-1', 'the control: --export-mapping still exports');
  const text = await runBoth(['import', 'claude', '--dry-run', '--json=false'], config, env);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^dry_run: true$/m, '--json=false prints key: value lines');
});

// Intent 06 D7: every import option is listed. The usage line printed for a
// missing or unknown agent left out --undo and --run.
test('the import usage line names every option the help lists for import', async () => {
  const { config, env } = importSandbox();
  const section = HELP.slice(HELP.indexOf('Import options'));
  const flags = [...section.slice(0, section.indexOf('\n\n')).matchAll(/^\s+(--[a-z-]+)/gm)].map((match) => match[1]);
  assert.ok(flags.includes('--undo') && flags.includes('--run'), `help lists the import options: ${flags.join(' ')}`);
  const usage = await runBoth(['import'], config, env);
  assert.equal(usage.code, 1);
  for (const flag of flags) assert.ok(usage.stderr.includes(flag), `the usage line names ${flag}: ${usage.stderr}`);
});
