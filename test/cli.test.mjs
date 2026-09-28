import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killSpy, processGone, staleKills, tempDir } from './helpers.mjs';
import { parseJsonPayload } from '../src/input.mjs';
import { formatStatus } from '../src/format.mjs';
import { agentActivity, costLabel, detectHostAgent, hostSessionId } from '../src/host.mjs';
import { composeSettings, defaultConfig } from '../src/config.mjs';
import { MAX_COMPOSE_OUTPUT_BYTES, MAX_STDIN_BYTES } from '../src/constants.mjs';
import { findGitBash } from '../src/spawn.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'tokenwatch.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TOKENWATCH_HOME: tempDir(), ...env }
  });
}

test('version and help work without dependencies', () => {
  const version = run(['version']);
  assert.equal(version.status, 0, version.stderr);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version, 'the CLI reports the version package.json declares');
  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /metadata-only token and cost telemetry/i);
});

test('status with no events is stable', () => {
  const result = run(['status', '--agent', 'claude']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no local usage yet/);
});

// Windows PowerShell 5.1 can put a UTF-8 byte-order mark in front of what it
// pipes to a program. Node decodes it as U+FEFF and `JSON.parse` refuses it, so
// a hook fed that way would record nothing and, failing open, say nothing.
// Strict mode is what makes a parse failure visible here.
test('a payload piped with a byte-order mark is parsed, not rejected as malformed', () => {
  const home = tempDir();
  const payload = JSON.stringify({ session_id: 'bom-session', prompt_id: 'bom-prompt' });
  const result = spawnSync(process.execPath, [cli, 'hook', 'claude', 'UserPromptSubmit', '--strict', '--json'], {
    input: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload)]),
    env: { ...process.env, TOKENWATCH_HOME: home }
  });
  assert.equal(result.status, 0, `strict mode must not see a parse error: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).stored, 1, `the event must be stored, got ${result.stdout}`);
  const ledger = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8');
  assert.match(ledger, /"session_id":"bom-session"/, 'the payload itself was read, not replaced by an empty one');
});

// The same mark reaching the parser by any other route, such as `--payload`,
// which does not pass through the stdin reader's trim.
test('parseJsonPayload ignores a leading byte-order mark', () => {
  assert.deepEqual(parseJsonPayload('\uFEFF{"session_id":"s"}'), { session_id: 's' });
  assert.deepEqual(parseJsonPayload('\uFEFF'), {}, 'a mark alone is an empty payload, like an empty string');
  assert.throws(() => parseJsonPayload('\uFEFF{bad json', 'stdin'), /^Error: Invalid JSON stdin$/,
    'a malformed payload is still refused, without quoting it');
});

test('hook fails open on malformed JSON and strict mode fails closed', () => {
  const home = tempDir();
  let result = spawnSync(process.execPath, [cli, 'hook', 'claude', 'Stop'], {
    input: '{bad json', encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home }
  });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync(process.execPath, [cli, 'hook', 'claude', 'Stop', '--strict'], {
    input: '{bad json', encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home }
  });
  assert.notEqual(result.status, 0);
});

// Copilot CLI trims the command's stdout and renders nothing for a blank line,
// which is indistinguishable from a status line that was never configured. A
// lifecycle-only event used to produce exactly that.
test('the status line never renders as an empty string', () => {
  const config = defaultConfig({ HOME: '/home/example' });
  for (const layout of ['multi', 'single']) {
    const withLayout = { ...config, status: { ...config.status, layout } };
    assert.match(formatStatus({ agent: 'github-copilot-cli', latest: undefined }, withLayout, {}),
      /no local usage yet/);
    const lifecycleOnly = {
      agent: 'github-copilot-cli',
      latest: { turn_key: 'x', kind: 'usage', source: 'statusline', event_name: 'status' },
      subagent_count: 0
    };
    const rendered = formatStatus(lifecycleOnly, withLayout, {});
    assert.ok(rendered.trim().length > 0, `${layout}: a lifecycle-only event rendered nothing`);
  }
});

// A skill running inside one agent must report on that agent. Detection is by
// environment marker, with an explicit override, and it declines to guess.
// Every marker here was confirmed live: `codex exec` and `copilot -p` were each
// run for real and their spawned shell command's own environment inspected,
// rather than guessed from documentation. An earlier version of this detection
// shipped guessed names (COPILOT_CLI_VERSION, COPILOT_AGENT_MODEL,
// COPILOT_SESSION_ID, bare CODEX_SANDBOX) that Copilot and Codex never actually
// set, so `tokenwatch agents` silently reported every Copilot session as
// unknown from the day it shipped.
test('the host agent is detected, overridable, and never guessed', () => {
  assert.equal(detectHostAgent({ CLAUDECODE: '1' }).agent, 'claude');
  assert.equal(detectHostAgent({ CLAUDE_CODE_SESSION_ID: 'abc' }).agent, 'claude');
  assert.equal(detectHostAgent({ COPILOT_CLI: '1' }).agent, 'copilot');
  assert.equal(detectHostAgent({ COPILOT_CLI_BINARY_VERSION: '1.0.85' }).agent, 'copilot');
  assert.equal(detectHostAgent({ COPILOT_AGENT_SESSION_ID: 'abc' }).agent, 'copilot');
  assert.equal(detectHostAgent({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }).agent, 'codex');
  assert.equal(detectHostAgent({ CODEX_THREAD_ID: 'abc' }).agent, 'codex');
  assert.equal(detectHostAgent({ CODEX_SESSION_ID: 'abc' }).agent, 'codex');
  // An explicit answer wins over any marker.
  assert.equal(detectHostAgent({ TOKENWATCH_AGENT: 'copilot', CLAUDECODE: '1' }).agent, 'copilot');
  assert.equal(detectHostAgent({ TOKENWATCH_AGENT: 'nonsense' }).agent, undefined);
  // Nothing recognisable: say so rather than picking one.
  const unknown = detectHostAgent({ HOME: '/home/example' });
  assert.equal(unknown.agent, undefined);
  assert.equal(unknown.basis, 'unknown');
  // Nested agents: an outer agent's markers are still ambient in an inner
  // agent's spawned shell. Detection cannot see past that; list order decides,
  // and this documents which side wins rather than leaving it unspecified.
  assert.equal(detectHostAgent({ CLAUDECODE: '1', CODEX_SESSION_ID: 'abc' }).agent, 'claude');
});

// A hand-run `status` may take its session from the agent's environment, but
// only from a variable checked against a real session (intent 15, D6): an
// unverified one would trade one confident misattribution for another. And the
// lookup is keyed on the agent asked about, so Claude's id never answers for
// a Copilot or Codex status (FR-05).
test('the host session id is read only from a verified marker of the agent asked about', () => {
  assert.deepEqual(hostSessionId('claude', { CLAUDE_CODE_SESSION_ID: 'abc' }),
    { sessionId: 'abc', basis: 'environment:CLAUDE_CODE_SESSION_ID' });
  assert.deepEqual(hostSessionId('claude-code', { CLAUDE_CODE_SESSION_ID: 'abc' }),
    { sessionId: 'abc', basis: 'environment:CLAUDE_CODE_SESSION_ID' });
  assert.deepEqual(hostSessionId('copilot', { COPILOT_AGENT_SESSION_ID: 'abc' }), { sessionId: undefined, basis: 'unknown' });
  assert.deepEqual(hostSessionId('codex', { CODEX_THREAD_ID: 'abc', CODEX_SESSION_ID: 'abc' }), { sessionId: undefined, basis: 'unknown' });
  assert.deepEqual(hostSessionId('copilot', { CLAUDE_CODE_SESSION_ID: 'abc' }), { sessionId: undefined, basis: 'unknown' });
  assert.deepEqual(hostSessionId('claude', { CLAUDE_CODE_SESSION_ID: '' }), { sessionId: undefined, basis: 'unknown' });
  assert.deepEqual(hostSessionId('nonsense', { CLAUDE_CODE_SESSION_ID: 'abc' }), { sessionId: undefined, basis: 'unknown' });
});

// Inside Codex, whether any tokens can be recorded depends on how Codex was
// started, and on the first Windows run the session could not say. `agents`
// now reports the wrapper's marker when it is there, says it is missing when it
// is not, and says nothing about it for any other agent. Every host marker is
// blanked first, because this suite may itself be running inside an agent.
test('agents inside Codex says whether the session was launched through tokenwatch-codex', () => {
  const blank = Object.fromEntries(['TOKENWATCH_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
    'COPILOT_CLI', 'COPILOT_CLI_BINARY_VERSION', 'COPILOT_AGENT_SESSION_ID', 'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'TW_CODEX_WRAPPER'].map((name) => [name, '']));
  const agents = (env, args = ['--json']) => {
    const result = run(['agents', ...args], { ...blank, ...env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const host = (env) => JSON.parse(agents(env)).host;
  const wrapped = host({ CODEX_THREAD_ID: 'thread-1', TW_CODEX_WRAPPER: '1' });
  assert.equal(wrapped.agent, 'codex');
  assert.equal(wrapped.codex_wrapper, true, `got ${JSON.stringify(wrapped)}`);
  assert.equal(host({ CODEX_THREAD_ID: 'thread-1' }).codex_wrapper, false, 'no marker is reported as no marker');
  assert.equal(host({ COPILOT_CLI: '1', TW_CODEX_WRAPPER: '1' }).codex_wrapper, undefined, 'only a Codex host is described this way');

  const text = agents({ CODEX_THREAD_ID: 'thread-1', TW_CODEX_WRAPPER: '1' }, []);
  assert.match(text, /^host: codex \(environment:CODEX_THREAD_ID\) · launched through tokenwatch-codex$/m, text);
});

// "no cost reported" read as a fact about the provider when the real fact was
// that Tokenwatch's status line had never run: hooks arrived, samples did not.
// That case is now stated as the count it is - and only that case, so Copilot's
// own billing units, and a status line that delivered usage without dollars,
// keep their honest labels.
test('agents says 0 status-line samples only when hooks arrived and the status line never did', () => {
  const event = (agent, source, extra = {}) => ({ agent, source, ts: '2026-09-23T09:00:00.000Z', session_id: 's', ...extra });
  const rows = Object.fromEntries(agentActivity([
    event('claude-code', 'hook'), event('claude-code', 'hook'),
    event('github-copilot-cli', 'hook'), event('github-copilot-cli', 'statusline', { billing_cumulative: { aiu: 17.18 } }),
    event('codex-cli', 'notify')
  ]).map((row) => [row.agent, row]));
  assert.equal(rows['claude-code'].status_samples, 0);
  assert.equal(costLabel(rows['claude-code']), '0 status-line samples');
  assert.equal(costLabel(rows['github-copilot-cli']), 'aiu', 'Copilot bills in its own unit, which is named');
  assert.equal(costLabel(rows['codex-cli']), 'no cost reported', 'Codex has no status line to blame');

  const delivered = agentActivity([event('github-copilot-cli', 'hook'), event('github-copilot-cli', 'statusline')])[0];
  assert.equal(costLabel(delivered), 'no cost reported', `a status line that ran is not reported as silent, got ${costLabel(delivered)}`);
  const paid = agentActivity([event('claude-code', 'statusline', { cost: { cumulative_usd: 1 } })])[0];
  assert.equal(costLabel(paid), 'USD');
});

// Intent 06, D4: imported history is counted apart and is never activity, so
// an import on a fresh install cannot make an agent look live, nor its status
// line look silent.
test('agents counts imported history apart from live activity', () => {
  const event = (source, extra = {}) => ({ agent: 'claude-code', source, ts: '2026-06-01T09:00:00.000Z', session_id: 'hist', ...extra });
  const [importOnly] = agentActivity([event('import'), event('import', { session_id: 'hist-2' }), event('import')]);
  assert.equal(importOnly.events, 0);
  assert.equal(importOnly.sessions, 0);
  assert.equal(importOnly.last_activity, undefined, 'history is not recent activity');
  assert.equal(importOnly.imported_events, 3);
  assert.equal(importOnly.imported_sessions, 2);
  assert.equal(costLabel(importOnly), 'no cost reported', 'never "0 status-line samples" on imported rows alone');
  const [mixed] = agentActivity([event('hook', { ts: '2026-09-23T09:00:00.000Z', session_id: 'live' }), event('import')]);
  assert.equal(mixed.events, 1);
  assert.equal(mixed.last_activity, '2026-09-23T09:00:00.000Z');
});

// `doctor` executes installed hook and status-line commands to prove they
// parse in the agent's shell. That run must be harmless: with the probe
// variable set, a hook given a real payload stores nothing, and not even a
// first-run config.json appears in an empty Tokenwatch home.
test('a probe run of a hook or status command stores nothing and loads no config', () => {
  const home = tempDir();
  const payload = JSON.stringify({ sessionId: 'probe-session', timestamp: 1767225600000, cwd: '/private/project' });
  const hook = spawnSync(process.execPath, [cli, 'hook', 'copilot', 'sessionStart'], {
    input: payload, encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_PROBE: '1' }
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, 'tokenwatch-probe-ok hook copilot sessionStart\n');
  const status = spawnSync(process.execPath, [cli, 'status', '--agent', 'copilot', '--ingest-stdin'], {
    input: payload, encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_PROBE: '1' }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, `tokenwatch-probe-ok status --agent copilot --ingest-stdin stdin=${Buffer.byteLength(payload)}\n`);
  assert.deepEqual(fs.readdirSync(home), [], `a probe wrote ${fs.readdirSync(home).join(', ')}`);
});

// Intent 04, FR-02: the raw read hands back exactly the bytes on stdin, where
// readStdin would decode and trim them.
test('the raw stdin read returns the agent\'s bytes untouched, byte-order mark and trailing newline included', () => {
  const inputModule = new URL('../src/input.mjs', import.meta.url).href;
  const sent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(' {"a":"ü"}\r\n', 'utf8'), Buffer.from([0xc3])]);
  const run = (mode) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { readStdin, readStdinBytes } from ${JSON.stringify(inputModule)};
     const value = ${mode === 'raw' ? 'await readStdinBytes({ optional: false })' : 'Buffer.from(await readStdin({ optional: false }), "utf8")'};
     process.stdout.write(value.toString('hex'));`], { input: sent });
  assert.equal(run('raw').stdout.toString(), sent.toString('hex'));
  assert.notEqual(run('text').stdout.toString(), sent.toString('hex'), 'the ordinary read does alter them, which is why the raw read exists');
  const limited = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { readStdinBytes } from ${JSON.stringify(inputModule)};
     try { await readStdinBytes({ optional: false, maxBytes: 4 }); } catch (error) { process.stdout.write(error.code); }`], { input: sent });
  assert.equal(limited.stdout.toString(), 'STDIN_LIMIT');
});

test('compose settings are bounded where they are read, and no setting chooses the shell', () => {
  assert.deepEqual(composeSettings(defaultConfig()), { order: 'last', timeoutMs: 1000 });
  assert.deepEqual(composeSettings({ status: { composeOrder: 'first', composeTimeoutMs: 5, composeShell: 'bash' } }),
    { order: 'first', timeoutMs: 250 }, 'a composeShell in config.json is ignored: the shell is recorded at install (D20)');
  assert.deepEqual(composeSettings({ status: { composeOrder: 'sideways', composeTimeoutMs: 1e9 } }), { order: 'last', timeoutMs: 30000 });
  assert.deepEqual(composeSettings({}), { order: 'last', timeoutMs: 1000 }, 'an injected config without status keys still gets the defaults');
  assert.equal('composeShell' in defaultConfig().status, false);
});

// ---- Intent 04: composing with another status line --------------------------
// These drive the real CLI in a subprocess, because the other half is a real
// child process and cli-dispatch's in-process run() does not spawn.
const cliBin = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
const composeShell = process.platform === 'win32' ? 'cmd' : 'posix';
const statusPayload = fs.readFileSync(new URL('./fixtures/claude-status-1.json', import.meta.url));

function composeHome(command, { status } = {}) {
  const home = tempDir('tw-compose-');
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify({
    version: 1,
    installs: { user: { claude: { statusInstalled: true, statusCommand: 'recorded', compose: { command, shell: composeShell } } } }
  }));
  if (status) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ status }));
  return home;
}

// A stand-in for the other tool: a Node script, run the way a recorded status
// command is, through the shell, with a quoted path.
function otherTool(home, body) {
  const script = path.join(home, 'other tool.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nconst dir = ${JSON.stringify(home)};\n${body}\n`);
  return `"${process.execPath}" "${script}"`;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', COLUMNS: '200', ...extra };
  for (const key of ['TOKENWATCH_DEBUG', 'TOKENWATCH_PROBE', 'TOKENWATCH_COMPOSED', 'TOKENWATCH_CONFIG', 'TOKENWATCH_DATA', 'TOKENWATCH_AGENT']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function composedRender(home, { input = statusPayload, args = [], env = {}, nodeArgs = [] } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [...nodeArgs, cliBin, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', 'user', ...args],
    { input, env: cleanEnv({ TOKENWATCH_HOME: home, ...env }), timeout: 20000 });
  return { ...result, stdout: result.stdout.toString(), elapsed: Date.now() - started };
}

function stateFiles(home) {
  const dir = path.join(home, 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const READS_STDIN = `const chunks = []; for await (const c of process.stdin) chunks.push(c);
fs.writeFileSync(dir + '/received.bin', Buffer.concat(chunks));`;

test('a composed status line forwards byte-identical stdin to the other command and prints both, the other first', () => {
  const home = tempDir('tw-compose-bytes-');
  const command = otherTool(home, `${READS_STDIN}\nprocess.stdout.write('OTHER ROW 1\\nOTHER ROW 2');`);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify({
    version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'recorded', compose: { command, shell: composeShell } } } }
  }));
  const sent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), statusPayload, Buffer.from('  \n')]);
  const result = composedRender(home, { input: sent });
  assert.equal(result.status, 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(home, 'received.bin')), sent), 0, 'the other command gets exactly what the agent sent');
  assert.ok(result.stdout.startsWith('OTHER ROW 1\nOTHER ROW 2\n'), `the other rows come first, joined by exactly one newline: ${JSON.stringify(result.stdout.slice(0, 60))}`);
  assert.match(result.stdout.slice('OTHER ROW 1\nOTHER ROW 2\n'.length), /session/i, 'Tokenwatch\'s rows follow');
  assert.equal(stateFiles(home).length, 1, 'Tokenwatch recorded the reading, BOM and all');
});

test('composeOrder first puts Tokenwatch\'s rows before the other status line', () => {
  const home = composeHome('', { status: { composeOrder: 'first' } });
  const command = otherTool(home, `process.stdout.write('OTHER\\n');`);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = command;
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const result = composedRender(home);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.endsWith('\nOTHER\n'), result.stdout);
  assert.doesNotMatch(result.stdout.split('\n')[0], /OTHER/);
});

for (const [name, body, expectOther] of [
  ['a command that does not exist', null, false],
  ['a command that prints and then exits non-zero', `process.stdout.write('PARTIAL\\n'); process.exit(3);`, true],
  ['a command that prints more than the output cap', `process.stdout.write('x'.repeat(1024 * 1024));`, true]
]) {
  test(`a composed status line still records and renders Tokenwatch's rows with ${name}`, () => {
    const home = composeHome('');
    const command = body === null ? `"${path.join(home, 'missing', 'nothing-here')}" --flag` : otherTool(home, body);
    const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
    state.installs.user.claude.compose.command = command;
    fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
    const result = composedRender(home);
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.match(result.stdout, /session/i, 'Tokenwatch\'s rows are always printed');
    assert.equal(stateFiles(home).length, 1, 'and the reading is always recorded');
    if (name.includes('non-zero')) assert.ok(result.stdout.startsWith('PARTIAL\n'), 'what it printed is still shown, as the agent would have shown it');
    if (name.includes('cap')) assert.ok(Buffer.byteLength(result.stdout) < MAX_COMPOSE_OUTPUT_BYTES + 4096, `output was not capped: ${Buffer.byteLength(result.stdout)} bytes`);
    if (!expectOther) assert.doesNotMatch(result.stdout, /nothing-here/, 'a failed command is never quoted');
  });
}

test('a composed command that runs past the limit is stopped, and Tokenwatch renders alone within the limit', async () => {
  const home = composeHome('', { status: { composeTimeoutMs: 300 } });
  const command = otherTool(home, `fs.writeFileSync(dir + '/pid', String(process.pid)); process.stdout.write('LATE\\n'); setTimeout(() => {}, 5000);`);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = command;
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const result = composedRender(home);
  assert.equal(result.status, 0);
  assert.ok(result.elapsed < 1500, `took ${result.elapsed} ms`);
  assert.doesNotMatch(result.stdout, /LATE/, "a timed-out command's partial output is not shown");
  assert.match(result.stdout, /session/i);
  const pid = Number(fs.readFileSync(path.join(home, 'pid'), 'utf8'));
  assert.ok(await processGone(pid), 'the timed-out command is not left running');
});

// A status line is a shell running a program, and the program can start more.
// Windows has no process group a kill reaches whole: stopping only the shell
// left the program running, holding the render open until it ended by itself,
// and then orphaned. Every shell a status line runs under here must lose the
// whole tree when the limit passes.
const gitBash = process.platform === 'win32' ? findGitBash() : undefined;
const treeShells = process.platform === 'win32'
  ? [{ shell: 'cmd' }, ...(gitBash ? [{ shell: 'bash', shellPath: gitBash }] : []), { shell: 'powershell' }]
  : [{ shell: 'posix' }];
for (const shellSpec of treeShells) {
  test(`a composed command under ${shellSpec.shell} that runs past the limit leaves nothing it started running`, async () => {
    const home = tempDir('tw-compose-tree-');
    const script = path.join(home, 'other tool.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(path.join(home, 'pids'))}, JSON.stringify([process.pid, grandchild.pid]));
process.stdout.write('LATE\\n');
setTimeout(() => {}, 20000);
`);
    const words = `"${process.execPath}" "${script}"`;
    const command = shellSpec.shell === 'powershell' ? `& ${words}` : words;
    fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify({
      version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'recorded', compose: [{ command, ...shellSpec }] } } }
    }));
    // The limit has to outlast the shell's own start-up, or nothing is running
    // yet when it passes and the tree kill is never exercised: Windows
    // PowerShell 5.1 and node together took over 2 s on a busy runner.
    const limit = shellSpec.shell === 'powershell' ? 8000 : 2000;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ status: { composeTimeoutMs: limit } }));
    const result = composedRender(home);
    assert.equal(result.status, 0);
    assert.ok(result.elapsed < limit + 4000, `the render waited ${result.elapsed} ms for a command stopped at ${limit} ms`);
    assert.doesNotMatch(result.stdout, /LATE/);
    assert.match(result.stdout, /session/i);
    assert.ok(fs.existsSync(path.join(home, 'pids')), 'the other command started within the limit');
    const [program, grandchild] = JSON.parse(fs.readFileSync(path.join(home, 'pids'), 'utf8'));
    assert.ok(await processGone(program), 'the program the shell started is not left running');
    assert.ok(await processGone(grandchild), 'nor is anything that program started');
  });
}

// A status command can start a program and return, and the program then
// holds the pipe after the shell has exited. Once Node has seen the shell
// exit, the shell's id is free, and Windows gives ids out again quickly: a
// timeout that then ran `taskkill /T /F /PID <id>`, or killed that id or its
// process group, stopped whatever unrelated program had been given the id,
// and everything that program had started. A preload in the render records
// what it starts and kills (killSpy, test/helpers.mjs).
test('a composed command whose shell has already exited is never killed by its old id, and the render still ends at the limit', async () => {
  const home = tempDir('tw-compose-exited-');
  const program = path.join(home, 'program.mjs');
  // It writes until a write fails: that is how it learns nobody reads it.
  fs.writeFileSync(program, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(home, 'pid'))}, String(process.pid));
setInterval(() => process.stdout.write('LATE\\n'), 100);
setTimeout(() => process.exit(0), 20000);
`);
  const launcher = path.join(home, 'launcher.mjs');
  // Detached on Windows only because Node puts every other child in a job
  // object that ends it when its parent (here the launcher) exits.
  fs.writeFileSync(launcher, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(program)}], { stdio: ['ignore', 'inherit', 'ignore'], detached: process.platform === 'win32', windowsHide: true }).unref();
`);
  const spy = killSpy(home);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify({
    version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'recorded', compose: [{ command: `"${process.execPath}" "${launcher}"`, shell: composeShell }] } } }
  }));
  const limit = process.platform === 'win32' ? 4000 : 1500;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ status: { composeTimeoutMs: limit } }));
  const result = composedRender(home, { nodeArgs: ['--require', spy.preload] });
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(path.join(home, 'pid')), 'the program started within the limit');
  const lines = spy.read();
  const spawned = lines.filter((line) => line.startsWith('spawn '));
  assert.equal(spawned.length, 1, `the render started only the other command's shell: ${lines.join(' | ')}`);
  assert.ok(lines.includes(`exit ${spawned[0].slice(6)}`), `the case needs the shell to exit before the limit: ${lines.join(' | ')}`);
  assert.deepEqual(staleKills(lines), [], `a kill went to an id Node had already seen exit: ${lines.join(' | ')}`);
  // The program held the pipe, so the render waited for the limit, and not
  // beyond it: nothing is left to wait for once the pipes are let go.
  assert.ok(result.elapsed < limit + 3000, `the render waited ${result.elapsed} ms for a limit of ${limit} ms`);
  assert.doesNotMatch(result.stdout, /LATE/, 'what a command printed past the limit is not shown');
  assert.match(result.stdout, /session/i);
  // What happens to it: nothing kills it, and its next write, to a pipe no one
  // reads any more, fails, which ends a program that keeps writing.
  const pid = Number(fs.readFileSync(path.join(home, 'pid'), 'utf8'));
  assert.ok(await processGone(pid, { timeoutMs: 5000 }), 'the program ended at its next write once the pipe was let go');
});

test('a composed render cancelled by the agent takes the other command with it', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
  const home = composeHome('');
  const command = otherTool(home, `fs.writeFileSync(dir + '/pid', String(process.pid)); setTimeout(() => {}, 5000);`);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = command;
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const { spawn } = await import('node:child_process');
  const parent = spawn(process.execPath, [cliBin, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', 'user'],
    { env: cleanEnv({ TOKENWATCH_HOME: home }), stdio: ['pipe', 'ignore', 'ignore'] });
  parent.stdin.end(statusPayload);
  const pidFile = path.join(home, 'pid');
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  parent.kill('SIGTERM');
  await new Promise((resolve) => parent.on('close', resolve));
  assert.ok(await processGone(pid), 'the other command must not outlive a cancelled render');
  assert.equal(stateFiles(home).length, 1, 'the reading was recorded before the render waited on the other command (D2)');
});

// Intent 16, D6/D7: several other status lines, one runner.
function listHome(bodies, { status } = {}) {
  const home = tempDir('tw-compose-list-');
  const compose = bodies.map((body, index) => {
    const script = path.join(home, `other ${index}.mjs`);
    fs.writeFileSync(script, `import fs from 'node:fs';\nconst dir = ${JSON.stringify(home)};\n${body}\n`);
    return { command: `"${process.execPath}" "${script}"`, shell: composeShell };
  });
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify({
    version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'recorded', compose } } }
  }));
  if (status) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ status }));
  return home;
}

test('three other status lines print in record order, and one that hangs leaves the others and Tokenwatch\'s rows intact', async () => {
  const bodies = [
    `fs.writeFileSync(dir + '/pid-a', String(process.pid)); process.stdout.write('A-LATE\\n'); setTimeout(() => {}, 20000);`,
    `process.stdout.write('B-ROW\\n'); process.exitCode = 3;`,
    `process.stdout.write('C-ROW');`
  ];
  // The limit is what the two quick commands need to start Node and print on a
  // loaded machine (300 ms was not always enough); the hung one would hold
  // the render for 20 s.
  const limit = 2000;
  for (const order of ['last', 'first']) {
    const home = listHome(bodies, { status: { composeTimeoutMs: limit, composeOrder: order } });
    const result = composedRender(home);
    assert.equal(result.status, 0);
    assert.ok(result.elapsed < limit + 4000, `${order}: the hung command held the render for ${result.elapsed} ms`);
    const own = result.stdout.replace('B-ROW\nC-ROW\n', '');
    assert.notEqual(own, result.stdout, `${order}: both finished commands print, in record order: ${JSON.stringify(result.stdout)}`);
    assert.match(own, /session/i, 'Tokenwatch\'s rows still print');
    assert.doesNotMatch(result.stdout, /A-LATE/, 'the hung command contributes nothing');
    if (order === 'last') assert.ok(result.stdout.startsWith('B-ROW\nC-ROW\n'), 'the block comes first');
    else assert.ok(result.stdout.endsWith('B-ROW\nC-ROW\n'), 'the block comes after Tokenwatch\'s rows');
    const pid = Number(fs.readFileSync(path.join(home, 'pid-a'), 'utf8'));
    assert.ok(await processGone(pid), 'the hung command is not left running');
  }
});

test('a composed render cancelled by the agent takes every other command with it', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
  const sleeper = (name) => `fs.writeFileSync(dir + '/pid-${name}', String(process.pid)); setTimeout(() => {}, 5000);`;
  const home = listHome([sleeper('a'), sleeper('b')]);
  const { spawn } = await import('node:child_process');
  const parent = spawn(process.execPath, [cliBin, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', 'user'],
    { env: cleanEnv({ TOKENWATCH_HOME: home }), stdio: ['pipe', 'ignore', 'ignore'] });
  parent.stdin.end(statusPayload);
  const pidFiles = ['a', 'b'].map((name) => path.join(home, `pid-${name}`));
  for (let i = 0; i < 100 && !pidFiles.every((file) => fs.existsSync(file)); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pids = pidFiles.map((file) => Number(fs.readFileSync(file, 'utf8')));
  parent.kill('SIGTERM');
  await new Promise((resolve) => parent.on('close', resolve));
  for (const pid of pids) assert.ok(await processGone(pid), 'no other command outlives a cancelled render');
  assert.equal(stateFiles(home).length, 1, 'the reading was recorded before the render waited (D2)');
});

test('a composed status never composes again from inside the other command, and --json never composes at all', () => {
  const home = composeHome('');
  const command = otherTool(home, `${READS_STDIN}\nprocess.stdout.write('OTHER\\n');`);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = command;
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const nested = composedRender(home, { env: { TOKENWATCH_COMPOSED: '1' } });
  assert.equal(nested.status, 0);
  assert.equal(fs.existsSync(path.join(home, 'received.bin')), false, 'inside a composed command, nothing is spawned');
  assert.doesNotMatch(nested.stdout, /OTHER/);
  const json = composedRender(home, { args: ['--json'] });
  assert.equal(json.status, 0);
  JSON.parse(json.stdout);
  assert.equal(fs.existsSync(path.join(home, 'received.bin')), false, '--json output stays one JSON document');
  const probe = composedRender(home, { env: { TOKENWATCH_PROBE: '1' } });
  assert.match(probe.stdout, /^tokenwatch-probe-ok status --agent claude --ingest-stdin --compose user/);
  assert.equal(fs.existsSync(path.join(home, 'received.bin')), false, 'a doctor probe of a composed command spawns nothing');
});

test('a composed render stores exactly what a plain render stores', () => {
  const strip = (value) => JSON.parse(JSON.stringify(value), (key, v) =>
    (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) || key === 'event_id' || key === 'project_id' ? undefined : v); // project_id is salted per home
  const plainHome = tempDir('tw-compose-plain-');
  const plain = spawnSync(process.execPath, [cliBin, 'status', '--agent', 'claude', '--ingest-stdin'],
    { input: statusPayload, env: cleanEnv({ TOKENWATCH_HOME: plainHome }) });
  assert.equal(plain.status, 0);
  const home = composeHome('');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = otherTool(home, `process.stdout.write('OTHER\\n');`);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  assert.equal(composedRender(home).status, 0);
  const [plainFile] = stateFiles(plainHome);
  const [composedFile] = stateFiles(home);
  assert.equal(composedFile, plainFile, 'the same session state file');
  assert.deepEqual(strip(JSON.parse(fs.readFileSync(path.join(home, 'sessions', composedFile)))),
    strip(JSON.parse(fs.readFileSync(path.join(plainHome, 'sessions', plainFile)))));
  assert.equal(fs.existsSync(path.join(home, 'events.jsonl')), fs.existsSync(path.join(plainHome, 'events.jsonl')));
});

// Intent 04 review, HIGH 1: nothing in the compose set-up may fail the render.
test('a corrupt install record under --compose still records and renders Tokenwatch\'s rows, and quotes nothing from the file', () => {
  const home = tempDir('tw-compose-corrupt-');
  fs.writeFileSync(path.join(home, 'install-state.json'), '{ "installs": { "user": { "claude": SECRET-IN-RECORD');
  const result = composedRender(home);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout, /session/i);
  assert.equal(stateFiles(home).length, 1);
  assert.doesNotMatch(result.stdout + result.stderr.toString(), /SECRET-IN-RECORD|Cannot read JSON/);
});

test('the notify relay survives a corrupt install record too, and relays nothing', () => {
  const home = tempDir('tw-relay-corrupt-');
  fs.writeFileSync(path.join(home, 'install-state.json'), '{ not json');
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'u1' });
  const result = spawnSync(process.execPath, [cliBin, 'notify-relay', '--install', 'user', payload],
    { env: cleanEnv({ TOKENWATCH_HOME: home }) });
  assert.equal(result.status, 0, result.stderr.toString());
});

test('an oversized payload under --compose forwards nothing, records nothing, and says so', () => {
  const home = composeHome('');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = otherTool(home, `${READS_STDIN}\nprocess.stdout.write('OTHER\\n');`);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const result = composedRender(home, { input: Buffer.alloc(MAX_STDIN_BYTES + 1, 0x20) });
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(home, 'received.bin')), false, 'nothing was forwarded');
  assert.match(result.stdout, /note: stdin exceeded the 2 MiB safety limit; nothing was ingested or forwarded/);
  assert.equal(stateFiles(home).length, 0, 'nothing was ingested');
});

test('a payload Tokenwatch cannot parse is still forwarded to the other command and its rows are still shown', () => {
  const home = composeHome('');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = otherTool(home, `${READS_STDIN}\nprocess.stdout.write('OTHER\\n');`);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const sent = Buffer.from('{ this is not json');
  const result = composedRender(home, { input: sent });
  assert.equal(result.status, 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(home, 'received.bin')), sent), 0);
  assert.ok(result.stdout.startsWith('OTHER\n'), result.stdout);
});

// FR-05: a command that exits without reading closes its stdin while Tokenwatch
// is still writing. The payload has to outgrow the pipe buffer for the write to
// fail at all, so it is padded (JSON allows trailing whitespace).
test('a composed command that exits without reading its stdin is the command declining input, not a failure', () => {
  const home = composeHome('');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install-state.json')));
  state.installs.user.claude.compose.command = otherTool(home, `process.stdout.write('NO-READ\\n');`);
  fs.writeFileSync(path.join(home, 'install-state.json'), JSON.stringify(state));
  const result = composedRender(home, { input: Buffer.concat([statusPayload, Buffer.alloc(1024 * 1024, 0x20)]) });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(result.stdout.startsWith('NO-READ\n'), result.stdout.slice(0, 80));
  assert.equal(stateFiles(home).length, 1);
});

// A shell tool, a CI step or `ssh -T` can hand a hand-run command a stdin pipe
// that is never closed. `status` used to read stdin whenever it was not a
// terminal, so it waited for an end that never came (Windows live test,
// 2026-09-28: a step hung for minutes). Only an explicit --ingest-stdin, which
// every installed status line passes, reads stdin now.
test('a hand-run status returns even when its stdin is a pipe nobody closes', async () => {
  const home = tempDir();
  const child = spawn(process.execPath, [cli, 'status', '--agent', 'claude', '--json'], {
    env: { ...process.env, TOKENWATCH_HOME: home, CLAUDE_CODE_SESSION_ID: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 8000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.destroy();
  assert.equal(outcome, 0, `status did not return while stdin stayed open (${outcome})`);
  assert.equal(JSON.parse(stdout).session_scope?.basis !== undefined, true, stdout);
});

test('status still ingests the payload piped to it with --ingest-stdin', () => {
  const home = tempDir();
  const payload = JSON.stringify({
    session_id: 'ingest-1', prompt_id: 'p1', model: { id: 'claude-test-model' },
    cost: { total_cost_usd: 0.25 },
    context_window: { used_percentage: 7, current_usage: { input_tokens: 3, cache_read_input_tokens: 90, output_tokens: 2 } }
  });
  const piped = spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', '--ingest-stdin', '--json'], {
    input: payload, encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home }
  });
  assert.equal(piped.status, 0, piped.stderr);
  const snapshot = JSON.parse(piped.stdout);
  assert.equal(snapshot.session_scope.session_id, 'ingest-1', piped.stdout);
  assert.equal(snapshot.session_scope.basis, 'stdin', piped.stdout);
});

// On a fresh install several hooks can start at once, and each used to create
// config.json with its own random projectSalt: the last rename won, and the
// hooks that lost had already hashed their project with a salt that no longer
// exists, so one project was recorded under two identities.
test('processes that create config.json together all end up with the one project salt it keeps', async () => {
  const home = tempDir();
  const script = `import(${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)}).then((m) => process.stdout.write(m.loadConfig().config.projectSalt))`;
  const runs = Array.from({ length: 12 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TOKENWATCH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', () => resolve(out));
  }));
  const salts = await Promise.all(runs);
  const kept = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).projectSalt;
  assert.match(kept, /^[0-9a-f]{64}$/);
  assert.deepEqual([...new Set(salts)], [kept], `${new Set(salts).size} different salts were used`);
});
