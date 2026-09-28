import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { install, isTokenwatchRelay, priorCodexNotify, uninstall } from '../src/installer.mjs';
import { startOtlpServer } from '../src/otlp-server.mjs';
import { looksSensitive } from '../src/privacy.mjs';
import { assertPrivacySafe, makeEvent } from '../src/schema.mjs';
import { eventsToCsv } from '../src/export.mjs';
import { normalizeOtlp } from '../src/normalize/index.mjs';
import { decodeOtlpLogsExportRequest } from '../src/otlp-protobuf.mjs';
import { loadState, sessionStateFile } from '../src/store.mjs';
import { identityPath } from '../src/fs-util.mjs';
import { symlinkUnavailable, tempDir, testConfig } from './helpers.mjs';

function paths(root) {
  return {
    claudeSettings: path.join(root, 'claude-settings.json'),
    claudeSkills: path.join(root, 'claude-skills'),
    copilotConfig: path.join(root, 'copilot-config.json'),
    copilotHooks: path.join(root, 'copilot-hooks', 'tokenwatch.json'),
    codexConfig: path.join(root, 'codex-config.toml'),
    sharedSkills: path.join(root, 'agents-skills')
  };
}

function options(root, extra = {}) {
  return { agents: 'codex', scope: 'project', project: root, ...paths(root), ...extra };
}

async function withServer(config, run) {
  const server = await startOtlpServer(config, { quiet: true, host: '127.0.0.1', port: 0 });
  try {
    return await run(server.address.port);
  } finally {
    await server.close().catch(() => {});
  }
}

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', () => resolve('(error)'));
  });
}

// A malformed Host header used to reach `new URL()` outside any try/catch, so
// one request from any local process terminated the receiver - and under the
// `tokenwatch-codex` wrapper that process is also supervising Codex.
test('a malformed Host header does not take the receiver down', async () => {
  const config = testConfig(tempDir());
  await withServer(config, async (port) => {
    for (const host of ['[', 'a b', '%', 'foo:99999999999999', 'foo:-1']) {
      const status = await rawRequest(port, `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.match(status, /200/, `Host: ${host} should still be answered`);
    }
    const alive = await rawRequest(port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(alive, /200/, 'the server must still be listening afterwards');
  });
});

// `contentType.includes('json')` also matched `text/plain;charset=json`, which
// is a CORS-simple type: a web page could POST forged telemetry with no
// preflight. An exact media type forces a preflight that gets no CORS headers.
test('a CORS-simple content type cannot smuggle telemetry in', async () => {
  const config = testConfig(tempDir());
  await withServer(config, async (port) => {
    const body = '{"resourceLogs":[]}';
    const smuggled = await rawRequest(port, [
      'POST /v1/logs HTTP/1.1', 'Host: 127.0.0.1',
      'Content-Type: text/plain;charset=json',
      `Content-Length: ${body.length}`, 'Connection: close', '', body
    ].join('\r\n'));
    assert.match(smuggled, /415/);
    const legitimate = await rawRequest(port, [
      'POST /v1/logs HTTP/1.1', 'Host: 127.0.0.1',
      'Content-Type: application/json',
      `Content-Length: ${body.length}`, 'Connection: close', '', body
    ].join('\r\n'));
    assert.match(legitimate, /200/, 'real OTLP/HTTP JSON must still be accepted');
  });
});

// The body cap counts compressed bytes, so it never bounded what a gzip bomb
// expanded to. Decompression was synchronous, which stalled the event loop too.
test('a gzip bomb is refused instead of being expanded', async () => {
  const config = testConfig(tempDir());
  const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024));
  await withServer(config, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: bomb
    });
    assert.equal(response.status, 413);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, 'the receiver must still be serving');
  });
});

// A repository can carry a committed `.codex/config.toml`. Recording its
// `notify` argv from an install that declined to install it handed that argv to
// spawn() on every later turn, in unrelated sessions.
test('a notifier the installer declined to replace is never recorded', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).codexConfig, 'notify = ["/bin/sh", "-c", "touch /tmp/pwned"]\n');
  const record = install(config, options(root));
  assert.equal(record.codex.notifyLine, undefined, 'nothing was installed');
  assert.equal(record.codex.priorNotifyLine, undefined, 'so nothing may be remembered to run');
  assert.ok(record.codex.warning, 'the user is told the file was left alone');
  assert.equal(priorCodexNotify(config, `project:${identityPath(root)}`), null);
});

test('a displaced notifier is relayed only for a user-scope install', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).codexConfig, 'notify = ["/usr/bin/my-notifier", "--flag"]\n');
  install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  assert.deepEqual(priorCodexNotify(config, 'user'), ['/usr/bin/my-notifier', '--flag']);
  // Scoped: another installation's notification must not reach this notifier.
  assert.equal(priorCodexNotify(config, `project:${identityPath(root)}`), null);
  assert.equal(priorCodexNotify(config, undefined), null);
});

// A project's `.codex/config.toml` can arrive with a clone, so the argv in it
// was chosen by whoever wrote the repository. The line is still recorded,
// because uninstall owes the user their own notifier back and dropping it
// would lose it - but recording a line and running one are different acts, and
// only the first is safe here.
test('a notifier displaced from a checkout is restored but never executed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const original = 'notify = ["/usr/bin/their-notifier", "--flag"]\n';
  fs.writeFileSync(paths(root).codexConfig, original);
  const record = install(config, options(root, { force: true }));

  assert.ok(record.codex.priorNotifyLine, 'the displaced line is remembered for restore');
  assert.equal(priorCodexNotify(config, `project:${identityPath(root)}`), null, 'but it is never handed to spawn');

  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(paths(root).codexConfig, 'utf8'), original,
    'and the user gets their own notifier back');
});

// Recording our own relay line as the "previous" notifier made the relay invoke
// itself on every turn, without bound.
test('the relay is never recorded as its own predecessor', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root));
  assert.match(fs.readFileSync(paths(root).codexConfig, 'utf8'), /notify-relay/);
  // Losing the install state while the relay line remains in config.toml is the
  // sequence that used to arm the loop: the second install reads our own line
  // out of the file and, with no record to contradict it, remembers it as the
  // "previous" notifier. Every turn would then relay into another relay.
  fs.rmSync(config.installStateFile, { force: true });
  const again = install(config, options(root, { force: true }));
  assert.equal(again.codex.priorNotifyLine, undefined, 'our own relay is not a predecessor');
  assert.equal(priorCodexNotify(config, `project:${identityPath(root)}`), null, 'so nothing is spawned');
});

// The relay line exactly as Tokenwatch writes it on Windows. `tomlArray`
// serialises each element as a TOML basic string, which doubles every
// backslash, so the file holds `C:\\Users\\...` while the path is `C:\Users\...`.
// Built explicitly so the Windows behaviour is tested on every OS.
const WINDOWS_CLI = 'C:\\Users\\carhe\\AppData\\Roaming\\npm\\node_modules\\agent-tokenwatch\\bin\\tokenwatch.mjs';
const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
function windowsRelayLine(installIdentifier) {
  const argv = [WINDOWS_NODE, WINDOWS_CLI, 'notify-relay', '--agent', 'codex', '--install', installIdentifier];
  return `notify = [${argv.map((value) => JSON.stringify(value)).join(', ')}]`;
}

// First hands-on Windows run: the installer searched the raw TOML text for its
// own path, never found it because TOML had escaped the backslashes, and on a
// reinstall recorded its own relay as the user's previous notifier.
test('a relay written in Windows form is never recorded as the user\'s notifier', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const relayLine = windowsRelayLine('user');
  assert.equal(relayLine.includes(WINDOWS_CLI), false,
    `the escaped line does not contain the raw path, which is why a text search failed: ${relayLine}`);
  const original = 'model = "o3"\n';
  // The install record is gone but the relay line is still in config.toml.
  fs.writeFileSync(paths(root).codexConfig, `${relayLine}\n${original}`);
  const record = install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  assert.equal(record.codex.priorNotifyLine, undefined,
    `our own relay is not a predecessor, got ${record.codex.priorNotifyLine}`);
  assert.equal(priorCodexNotify(config, 'user'), null, 'so nothing is spawned');
  uninstall(config, { scope: 'user' });
  const after = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.equal(after, original, `no relay is restored on uninstall, got ${JSON.stringify(after)}`);
});

// What an earlier version left behind on Windows: the relay in config.toml, and
// an install record naming that same relay as the notifier it displaced.
function misrecordedRelay(config, root, original) {
  const relayLine = windowsRelayLine('user');
  fs.writeFileSync(paths(root).codexConfig, `${relayLine}\n${original}`);
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: { user: {
    version: 1, scope: 'user', agents: ['codex'], paths: paths(root),
    codex: { configPath: paths(root).codexConfig, notifyLine: relayLine, priorNotifyLine: relayLine, otelInstalled: false }
  } } }));
}

// A machine that ran an earlier version on Windows already carries such a
// record. It must be inert: never run, and never put back by uninstall, which
// would leave Codex calling a script that disappears with the package.
test('a relay already mis-recorded as its own predecessor is never run and never restored', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const original = '# my settings\nmodel = "o3"\n';
  misrecordedRelay(config, root, original);

  const prior = priorCodexNotify(config, 'user');
  assert.equal(prior, null, `a recorded relay is never handed to spawn, got ${JSON.stringify(prior)}`);

  uninstall(config, { scope: 'user' });
  const after = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.equal(after, original, `the mis-recorded relay is dropped, not restored, got ${JSON.stringify(after)}`);
});

// The success metric for the Windows defect: a forced reinstall over a
// Windows-form relay, then uninstall, hands the user back the exact bytes they
// had. Before the fix the forced reinstall restored the mis-recorded relay,
// recorded it as the predecessor all over again, and uninstall wrote it back.
test('a forced reinstall over a Windows-form relay, then uninstall, leaves config.toml byte-identical', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const original = '# my settings\nmodel = "o3"\n\n[profiles.fast]\nmodel = "o4-mini"\n';
  misrecordedRelay(config, root, original);

  const again = install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  assert.equal(again.codex.priorNotifyLine, undefined,
    `the reinstall records no predecessor, got ${again.codex.priorNotifyLine}`);
  const installed = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.equal(installed.match(/^notify\s*=/gm)?.length, 1, `exactly one notify line, got ${JSON.stringify(installed)}`);

  uninstall(config, { scope: 'user' });
  const after = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.equal(after, original, `config.toml differs after the round trip: ${JSON.stringify(after)}`);
});

// Path identity on Windows is case-insensitive and separator-agnostic, the
// same folding `identityPath` applies to project identity. POSIX paths are not.
test('the CLI path is recognised in any Windows spelling, and case matters only off Windows', () => {
  const win32 = { cliPath: WINDOWS_CLI, platform: 'win32' };
  assert.equal(isTokenwatchRelay([WINDOWS_NODE, WINDOWS_CLI.toLowerCase()], win32), true, 'drive and folder case is folded');
  assert.equal(isTokenwatchRelay([WINDOWS_NODE, WINDOWS_CLI.replaceAll('\\', '/')], win32), true, 'forward slashes are the same path');
  assert.equal(isTokenwatchRelay([WINDOWS_NODE, 'C:\\Tools\\notify.exe', '--flag'], win32), false, 'a stranger\'s notifier is not ours');
  const posix = { cliPath: '/home/carhe/tw/bin/tokenwatch.mjs', platform: 'linux' };
  assert.equal(isTokenwatchRelay(['/usr/bin/node', '/home/carhe/tw/lib/../bin/tokenwatch.mjs'], posix), true, 'the path is normalised');
  assert.equal(isTokenwatchRelay(['/usr/bin/node', '/home/Carhe/tw/bin/tokenwatch.mjs'], posix), false, 'POSIX paths are case-sensitive');
  assert.equal(isTokenwatchRelay(['/usr/bin/my-notifier', 'notify-relay'], posix), true, 'the relay subcommand alone marks our relay');
});

// A user's own notifier written in Windows form is still theirs: it is restored
// exactly, and its argv is read as TOML rather than by a regex over the text, so
// escapes, literal strings, a trailing comma and a comment that happens to hold
// a quoted word all come out right.
test('a user\'s Windows-form notifier is decoded as TOML and restored exactly', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const original = [
    'model = "o3"',
    'notify = [',
    '  "C:\\\\Tools\\\\notify.exe", # "--not-an-argument"',
    '  \'C:\\Tools\\sounds\\done.wav\',',
    '  "say \\"done\\"",',
    ']',
    ''
  ].join('\n');
  fs.writeFileSync(paths(root).codexConfig, original);
  install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  const prior = priorCodexNotify(config, 'user');
  assert.deepEqual(prior, ['C:\\Tools\\notify.exe', 'C:\\Tools\\sounds\\done.wav', 'say "done"'],
    `got ${JSON.stringify(prior)}`);
  install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  uninstall(config, { scope: 'user' });
  assert.equal(fs.readFileSync(paths(root).codexConfig, 'utf8'), original);
});

// `^key\s*=.*$` ends at the first newline, so replacing "the line" left the
// rest of a multi-line array orphaned and the file invalid. Codex then refuses
// to load config.toml at all and will not start.
test('a multi-line notify array survives install and uninstall intact', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const original = 'notify = [\n  "/usr/bin/my-notifier",\n  "--flag"\n]\nmodel = "o3"\n';
  fs.writeFileSync(paths(root).codexConfig, original);
  install(config, options(root, { force: true }));
  const installed = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.match(installed, /^notify = \["/m, 'the whole array is replaced, not its first line');
  assert.doesNotMatch(installed, /^\s+"--flag"/m, 'no orphaned array elements are left behind');
  assert.match(installed, /model = "o3"/, 'unrelated keys are preserved');
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(paths(root).codexConfig, 'utf8'), original);
});

test('an array element at the start of a line is not mistaken for a table header', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).codexConfig, 'notify = [\n  ["a", "b"],\n  "c"\n]\nmodel = "o3"\n');
  install(config, options(root, { force: true }));
  const text = fs.readFileSync(paths(root).codexConfig, 'utf8');
  assert.doesNotMatch(text, /^\s+\["a", "b"\],/m);
  assert.match(text, /model = "o3"/);
});

// The install-state record was written only after every agent succeeded, so a
// failure partway left changes on disk that `uninstall` knew nothing about.
// Since intent 18 a settings file Tokenwatch cannot edit is refused for that
// agent alone, by name, and left byte for byte; the other agents install.
test('a partial install is still recorded, so it can still be removed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.mkdirSync(path.dirname(paths(root).copilotConfig), { recursive: true });
  fs.writeFileSync(paths(root).copilotConfig, '{ this is not json');
  const record = install(config, options(root, { agents: 'claude,copilot' }));
  assert.equal(record.copilot.refused, 'unparseable');
  assert.ok(record.copilot.warning.endsWith(`was not changed: it does not parse as JSON (comments allowed). Repair it, then run: tokenwatch install --agents copilot --scope project --project "${root}" --force`), record.copilot.warning);
  assert.equal(fs.readFileSync(paths(root).copilotConfig, 'utf8'), '{ this is not json', 'the file it could not edit is untouched');
  assert.ok(JSON.parse(fs.readFileSync(paths(root).claudeSettings, 'utf8')).statusLine, 'Claude still installed');
  const removed = uninstall(config, { scope: 'project', project: root });
  assert.equal(removed.removed, true, 'what succeeded is removable');
  assert.equal(fs.existsSync(paths(root).claudeSettings), false, 'the Claude file Tokenwatch created was undone');
});

test('identifier values that look like secrets, paths or prose are dropped', () => {
  const event = makeEvent({
    agent: 'claude-code',
    kind: 'usage',
    source: 'statusline',
    session_id: '/home/someone/clients/acme/.env',
    model: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    event_name: 'Refactor the auth module to bypass the license check',
    tool_name: 'C:\\Users\\someone\\.ssh\\id_rsa',
    status: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });
  for (const field of ['session_id', 'model', 'event_name', 'tool_name', 'status']) {
    assert.equal(event[field], undefined, `${field} must not be stored`);
  }
  const serialized = JSON.stringify(event);
  for (const secret of ['acme', 'sk-ant', 'ghp_', 'id_rsa', 'bypass']) {
    assert.ok(!serialized.includes(secret), `${secret} must not reach the event`);
  }
  // The event itself still exists: one poisoned field does not lose the turn.
  assert.equal(event.agent, 'claude-code');
});

test('ordinary identifiers are untouched by those checks', () => {
  for (const value of [
    'claude-sonnet-4-5', 'models/gemini-2.5-pro', 'anthropic/claude-opus',
    'agent-turn-complete', 'codex.api_request', 'PreToolUse', 'gpt-5-codex',
    '3f9a1c22-7b4e-4f0a-9c1d-2b8e5a6f0d13', 'Read', 'agent_turn_complete'
  ]) {
    assert.equal(looksSensitive(value), false, `${value} must still be recorded`);
  }
  const event = makeEvent({ agent: 'claude-code', kind: 'usage', source: 'statusline', model: 'claude-sonnet-4-5', tool_name: 'Read' });
  assert.equal(event.model, 'claude-sonnet-4-5');
  assert.equal(event.tool_name, 'Read');
});

// The check was a key-name denylist, so a secret under an allowed key passed.
test('assertPrivacySafe inspects values and not only field names', () => {
  assert.throws(() => assertPrivacySafe({ session_id: '/home/someone/secrets/keys.txt' }), /Unsafe value/);
  assert.throws(() => assertPrivacySafe({ nested: { model: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' } }), /Unsafe value/);
  assert.throws(() => assertPrivacySafe({ prompt: 'anything' }), /Unsafe field/);
  assert.equal(assertPrivacySafe({ agent: 'claude-code', model: 'claude-sonnet-4-5' }), true);
});

// A session id comes from the agent, and it used to become a filename, which
// shows up in `ls`, backup manifests and cloud-sync indexes.
test('session state filenames do not contain the session id', () => {
  const config = testConfig(tempDir());
  const hostile = '/home/someone/clients/acme/merger-plan.md';
  const file = sessionStateFile(config, hostile);
  const name = path.basename(file);
  assert.ok(!name.includes('acme'));
  assert.ok(!name.includes('merger'));
  assert.match(name, /^s_[0-9a-f]{32}\.json$/);
  assert.equal(sessionStateFile(config, 'A'), sessionStateFile(config, 'A'), 'stable for one session');
  assert.notEqual(sessionStateFile(config, 'A'), sessionStateFile(config, 'B'));
});

// Hashing the name changes where a running session's state lives, so the old
// name is read once. Without this an upgrade mid-session would lose the
// cumulative-cost baseline and the status line would restart from zero.
test('state written under the old session filename is still found', () => {
  const root = tempDir();
  const config = testConfig(root);
  const sessionId = '3f9a1c22-7b4e-4f0a-9c1d-2b8e5a6f0d13';
  const key = `claude-code|${sessionId}`;
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sessions', `${sessionId}.json`),
    JSON.stringify({ version: 2, cumulativeCosts: { [key]: 12.34 }, recent: {}, latest: {} })
  );
  assert.notEqual(path.basename(sessionStateFile(config, sessionId)), `${sessionId}.json`);
  assert.equal(loadState(config, sessionId).cumulativeCosts[key], 12.34);
});

test('exported CSV cells cannot start a spreadsheet formula', () => {
  const events = ['=1+1', '+1+1', '@SUM', '-cmd', '\tx'].map((value) => ({
    ts: '2026-09-21T00:00:00Z', agent: 'claude-code', kind: 'usage', source: 'statusline', model: value
  }));
  const rows = eventsToCsv(events).split('\n').slice(1).filter(Boolean);
  for (const row of rows) {
    const modelCell = row.split(',')[7];
    assert.ok(modelCell.startsWith("'") || modelCell.startsWith('"'), `${modelCell} must not be evaluated`);
  }
  // A genuine negative number is left alone rather than quoted as text.
  const numeric = eventsToCsv([{ ts: '2026-09-21T00:00:00Z', agent: 'claude-code', cost: { delta_usd: -0.5 } }]);
  assert.match(numeric, /,-0\.5,/);
});

// The dotfiles pattern: the user symlinks their own `~/.claude/settings.json`
// into a tracked repository. That is a user-scope path, chosen by them.
//
// Skipped only where this account cannot make a symlink at all, which on
// Windows means Developer Mode is off and the shell is not elevated. There the
// user could not have made one either, so the case this protects cannot arise.
test('a symlinked user-scope config is written through, not replaced', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const real = path.join(root, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify({ mine: true }));
  fs.mkdirSync(path.dirname(paths(root).claudeSettings), { recursive: true });
  fs.symlinkSync(real, paths(root).claudeSettings);
  install(config, { agents: 'claude', scope: 'user', ...paths(root) });
  assert.ok(fs.lstatSync(paths(root).claudeSettings).isSymbolicLink(), 'the link must survive');
  const written = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.equal(written.mine, true, 'their own settings are preserved');
  assert.ok(written.statusLine, 'and the install landed in the tracked file');
});

// Uninstall must follow the same user-scope link install wrote through, or the
// dotfiles repository keeps Tokenwatch's hooks while the link is replaced by a
// plain file (intent 18, risk R-03).
test('a symlinked user-scope config survives uninstall as a link, with its bytes restored', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const real = path.join(root, 'dotfiles-settings.json');
  const text = '{\n  "mine": true\n}\n';
  fs.writeFileSync(real, text);
  fs.mkdirSync(path.dirname(paths(root).claudeSettings), { recursive: true });
  fs.symlinkSync(real, paths(root).claudeSettings);
  install(config, { agents: 'claude', scope: 'user', ...paths(root) });
  uninstall(config, { scope: 'user' });
  assert.ok(fs.lstatSync(paths(root).claudeSettings).isSymbolicLink(), 'the link survives uninstall too');
  assert.equal(fs.readFileSync(real, 'utf8'), text, 'the tracked file is back to its own bytes');
});

// The same dotfiles pattern for Codex: `~/.codex/config.toml` linked into a
// tracked repository. Install always wrote through the link; uninstall wrote a
// plain file over it, so the dotfiles copy kept Tokenwatch's relay and [otel]
// block while later edits to ~/.codex/config.toml stopped reaching it.
test('uninstall keeps a user-scope config.toml symlink a symlink', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const real = path.join(root, 'dotfiles-config.toml');
  const original = '# tracked in my dotfiles\nmodel = "o3"\n';
  fs.writeFileSync(real, original);
  fs.symlinkSync(real, paths(root).codexConfig);
  install(config, { agents: 'codex', scope: 'user', ...paths(root) });
  assert.ok(fs.lstatSync(paths(root).codexConfig).isSymbolicLink(), 'install writes through the link');
  assert.match(fs.readFileSync(real, 'utf8'), /notify-relay/, 'and the install landed in the tracked file');
  uninstall(config, { scope: 'user' });
  assert.ok(fs.lstatSync(paths(root).codexConfig).isSymbolicLink(), 'the link survives uninstall');
  assert.equal(fs.readFileSync(real, 'utf8'), original, 'the tracked file is back to its own bytes');
});

// A forced reinstall tears the old install down first, through the same
// uninstall path, so it replaced the link with a plain file as well.
test('a forced reinstall keeps a user-scope config.toml symlink a symlink', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const real = path.join(root, 'dotfiles-config.toml');
  const original = 'model = "o3"\n';
  fs.writeFileSync(real, original);
  fs.symlinkSync(real, paths(root).codexConfig);
  install(config, { agents: 'codex', scope: 'user', ...paths(root) });
  install(config, { agents: 'codex', scope: 'user', ...paths(root), force: true });
  assert.ok(fs.lstatSync(paths(root).codexConfig).isSymbolicLink(), 'the link survives the forced reinstall');
  assert.equal((fs.readFileSync(real, 'utf8').match(/notify-relay/g) ?? []).length, 1,
    'the tracked file holds exactly one relay');
  uninstall(config, { scope: 'user' });
  assert.ok(fs.lstatSync(paths(root).codexConfig).isSymbolicLink(), 'and survives uninstall');
  assert.equal(fs.readFileSync(real, 'utf8'), original, 'the tracked file is back to its own bytes');
});

// At project scope the path comes with a checkout, so a committed or pulled-in
// symlink chooses what gets written. Uninstall must replace the link, never
// write through it, even when the link's target holds Tokenwatch's own lines.
test('a project-scope config.toml symlink is never written through at uninstall', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).codexConfig, 'model = "o3"\n');
  install(config, options(root));
  const installed = fs.readFileSync(paths(root).codexConfig, 'utf8');
  // A later checkout turns the file into a link to something outside the
  // project that happens to hold the installed text.
  const victim = path.join(root, 'outside', 'victim.toml');
  fs.mkdirSync(path.dirname(victim), { recursive: true });
  fs.writeFileSync(victim, installed);
  fs.rmSync(paths(root).codexConfig);
  fs.symlinkSync(victim, paths(root).codexConfig);
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(victim, 'utf8'), installed, 'the link target is never written');
  assert.ok(!fs.lstatSync(paths(root).codexConfig).isSymbolicLink(), 'the link is replaced by a plain file');
});

// A settings file the editor cannot parse is left exactly as it is and named,
// never quoted: at project scope it may be someone else's, and it may hold a
// credential (intent 18, D4).
test('a settings file the editor cannot parse is left untouched and named without being quoted', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const text = '{ "env": { "TOKEN": "POISON-SETTINGS-VALUE" }, }';
  fs.writeFileSync(paths(root).claudeSettings, text);
  const record = install(config, options(root, { agents: 'claude' }));
  assert.equal(record.claude.refused, 'unparseable');
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), text);
  assert.doesNotMatch(JSON.stringify(record), /POISON-SETTINGS-VALUE/);
  assert.doesNotMatch(fs.readFileSync(config.installStateFile, 'utf8'), /POISON-SETTINGS-VALUE/);
});

test('a settings file nested deeper than the cap is refused, not parsed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const text = `{"a":${'['.repeat(100)}${']'.repeat(100)}}`;
  fs.writeFileSync(paths(root).claudeSettings, text);
  const record = install(config, options(root, { agents: 'claude' }));
  assert.equal(record.claude.refused, 'too-deep');
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), text);
});

// The record keeps hashes and the spans Tokenwatch replaced, never the file:
// a Claude settings file can carry credentials in `env` (intent 18, D1).
test('the install record and install output never carry a settings value Tokenwatch did not replace', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const settings = { env: { TOKEN: 'POISON-SETTINGS-VALUE' }, statusLine: { type: 'command', command: 'someone-else' } };
  fs.writeFileSync(paths(root).claudeSettings, JSON.stringify(settings, null, 2));
  fs.writeFileSync(paths(root).copilotConfig, '{\n  // POISON-SETTINGS-VALUE in a comment\n  "theme": "dark"\n}\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const home = path.join(root, 'home');
  const result = spawnSync(process.execPath, [cli, 'install', '--agents', 'claude,copilot', '--scope', 'project', '--project', root, '--force',
    '--claude-settings', paths(root).claudeSettings, '--copilot-config', paths(root).copilotConfig, '--copilot-hooks', paths(root).copilotHooks,
    '--claude-skills', paths(root).claudeSkills, '--shared-skills', paths(root).sharedSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /POISON-SETTINGS-VALUE/, 'install output');
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'install-state.json'), 'utf8'), /POISON-SETTINGS-VALUE/, 'install record');
  // The status line it replaced is kept in the record, so uninstall can put it
  // back, and never printed: install's output is read back into a model
  // (intent 16, D32).
  assert.match(fs.readFileSync(path.join(home, 'install-state.json'), 'utf8'), /someone-else/);
  assert.doesNotMatch(result.stdout, /someone-else/);
});

// The same behaviour at project scope is a weapon, because the path can arrive
// with a clone. A repository that commits a skill destination as a symlink used
// to have its target read into the install record, printed to stdout, then
// overwritten with skill markdown and chmodded 0644. Demonstrated with
// `~/.ssh/id_rsa`.
//
// Skipped where no symlink can be created, for the reason above; Git for
// Windows then checks a committed link out as a plain file holding the target
// path, so the attack has nothing to follow.
test('a symlinked skill destination in a checkout is refused, not followed', { skip: symlinkUnavailable() }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const secret = path.join(root, 'id_rsa');
  const secretText = '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYMATERIAL\n';
  fs.writeFileSync(secret, secretText, { mode: 0o600 });
  // Compared with itself rather than with 0o600: Windows keeps only a
  // read-only bit, so the same file reports 0o666 there, and the property is
  // that the installer did not change the mode, whatever the platform calls it.
  const modeBefore = fs.statSync(secret).mode;
  const destination = path.join(paths(root).claudeSkills, 'tw-cost-drivers-basics', 'SKILL.md');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(secret, destination);

  const record = install(config, options(root, { agents: 'claude', force: true }));

  assert.equal(fs.readFileSync(secret, 'utf8'), secretText, 'the link target must be untouched');
  const modeAfter = fs.statSync(secret).mode;
  assert.equal(modeAfter, modeBefore,
    `and must keep its mode: was ${modeBefore.toString(8)}, now ${modeAfter.toString(8)}`);
  const entry = (record.claudeSkills ?? []).find((skill) => skill.name === 'tw-cost-drivers-basics');
  assert.equal(entry.installed, false, 'the skill must be skipped');
  assert.equal(entry.prior, undefined, 'and its target must never be read into the record');
  assert.ok(!JSON.stringify(record).includes('KEYMATERIAL'), 'no target content may reach the record or stdout');
});

// The first version of this check anchored every path pattern at the start of
// the string, so it saw an absolute path and nothing else. `/` and `.` both
// survive sanitization, which meant a relative path, a traversal or a UNC
// share reached the ledger verbatim: `../../home/someone/.ssh/id_rsa` was
// stored exactly as written.
test('relative, traversal and UNC paths are caught, not only absolute ones', () => {
  const paths = [
    '/home/someone/secret.md',
    'C:\\Users\\someone\\secret.md',
    '~/clients/acme/plan.md',
    'src/clients/acme/merger-plan.md',
    '../../home/someone/.ssh/id_rsa',
    './secret/notes.md',
    '\\\\fileserver\\finance\\q4.xlsx',
    'clients/acme/merger-plan.md',
    'docs/notes.txt',
    'a/b/c'
  ];
  for (const value of paths) {
    assert.equal(looksSensitive(value), true, `${value} must be recognised as a path`);
    const event = makeEvent({ agent: 'claude-code', kind: 'usage', source: 'statusline', session_id: value });
    assert.equal(event.session_id, undefined, `${value} must not be stored`);
  }
});

// The one legitimate reason an identifier carries a slash is a namespaced model
// name. Blocking those would drop real telemetry, which is its own bug.
test('a namespaced model name is not mistaken for a path', () => {
  for (const value of ['models/gemini-2.5-pro', 'anthropic/claude-opus', 'openai/gpt-4o',
    'claude-sonnet-4-5', 'codex.api_request', 'agent-turn-complete', 'PreToolUse', 'Read']) {
    assert.equal(looksSensitive(value), false, `${value} must still be recorded`);
  }
  const event = makeEvent({ agent: 'codex', kind: 'usage', source: 'otlp', model: 'models/gemini-2.5-pro' });
  assert.equal(event.model, 'models/gemini-2.5-pro');
});

// Codex puts a Rust source location in its OTLP event names. Those are file
// paths, so they must not be stored - but dropping the field outright would
// leave the event nameless, so the fallback has to take over instead.
test('a path-shaped OTLP event name falls back rather than vanishing', () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [{
      timeUnixNano: '1758000000000000000',
      attributes: [
        { key: 'event.name', value: { stringValue: 'otel/src/events/session_telemetry.rs:570' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '42' } }
      ]
    }] }] }]
  };
  const config = { privacy: { storeModelNames: true, storeToolNames: true, storeDurations: true }, projectSalt: 'x' };
  const [event] = normalizeOtlp('/v1/logs', payload, config);
  assert.equal(event.event_name, 'otel.log', 'the source location must not become the name');
  assert.equal(event.usage.input_total, 42, 'the measurement it carried is still kept');
});

// The record cap used to be tested against the length of the normalized
// result, so the work it was meant to bound had already been done: every
// record built, every identity hashed, every event retained, and only then the
// request refused. A few-kilobyte request reached thousands of state files.
test('an oversized OTLP request is refused before any record is built', async () => {
  const root = tempDir();
  const config = testConfig(root);
  const record = (index) => ({
    timeUnixNano: '1758000000000000000',
    attributes: [
      { key: 'session_id', value: { stringValue: `s${index}` } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } }
    ]
  });
  const body = { resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 5000 }, (unused, index) => record(index)) }] }] };
  await withServer(config, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 413);
  });
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false, 'no session state may be created');
  assert.equal(fs.existsSync(config.dataFile), false, 'and nothing may reach the ledger');
});

// `MAX_FIELDS` bounds one protobuf message. A document is a tree of messages,
// so a body whose every message stayed under that limit still decoded to an
// unbounded number of nodes in total.
test('a protobuf document is bounded in total, not only per message', () => {
  const varint = (value) => {
    const out = [];
    do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value);
    return Buffer.from(out);
  };
  const message = (field, payload) => Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
  const leaf = Buffer.concat(Array.from({ length: 50 }, () => message(1, Buffer.from([0x08, 0x01]))));
  const many = Buffer.concat(Array.from({ length: 6000 }, () => message(1, leaf)));
  assert.throws(() => decodeOtlpLogsExportRequest(many), /document field limit/);
  // An ordinary document is unaffected, and the budget resets per request.
  assert.doesNotThrow(() => decodeOtlpLogsExportRequest(message(1, message(1, Buffer.from([0x08, 0x01])))));
  assert.doesNotThrow(() => decodeOtlpLogsExportRequest(message(1, message(1, Buffer.from([0x08, 0x01])))));
});

// Intent 04, FR-03 / D9: the resolver is the only gate between a recorded
// string and its execution on every status render.
test('the compose resolver runs only what was composed for that exact key, and never Tokenwatch itself', async () => {
  const { composedStatusCommand } = await import('../src/installer.mjs');
  const root = tempDir('tw-compose-resolver-');
  const config = testConfig(root);
  const good = { statusInstalled: true, statusCommand: 'x', compose: { command: 'other-status --line', shell: 'posix' } };
  const write = (installs) => fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs }));
  write({ user: { claude: good } });
  assert.deepEqual(composedStatusCommand(config, 'user', 'claude'), [{ command: 'other-status --line', shell: 'posix' }], 'a record written before intent 16 holds one object');
  assert.equal(composedStatusCommand(config, 'project:/elsewhere', 'claude'), null, 'another key');
  assert.equal(composedStatusCommand(config, 'user', 'copilot'), null, 'another agent');
  assert.equal(composedStatusCommand(config, 'user', 'codex'), null, 'an agent with no command-backed status line');
  assert.equal(composedStatusCommand(config, undefined, 'claude'), null, 'no key');
  const refused = {
    'status line not installed': { ...good, statusInstalled: false },
    'nothing composed': { ...good, compose: undefined },
    'a wrapper around tokenwatch': { ...good, compose: { command: 'bash ~/bin/both.sh | tokenwatch status', shell: 'posix' } },
    'this CLI': { ...good, compose: { command: `"${process.execPath}" "${fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url))}" status`, shell: 'posix' } },
    'an empty command': { ...good, compose: { command: '   ', shell: 'posix' } },
    'a command over the length cap': { ...good, compose: { command: 'x'.repeat(4097), shell: 'posix' } },
    'an unknown shell': { ...good, compose: { command: 'other', shell: '/bin/zsh' } },
    'a bash path that is not bash': { ...good, compose: { command: 'other', shell: 'bash', shellPath: 'C:\\evil\\payload.exe' } },
    'a bash record without its Git Bash path': { ...good, compose: { command: 'other', shell: 'bash' } }
  };
  for (const [why, record] of Object.entries(refused)) {
    write({ user: { claude: record } });
    assert.equal(composedStatusCommand(config, 'user', 'claude'), null, why);
  }
  write({ user: { claude: { ...good, compose: { command: 'other', shell: 'bash', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' } } } });
  assert.deepEqual(composedStatusCommand(config, 'user', 'claude'),
    [{ command: 'other', shell: 'bash', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }]);
});

// Intent 16, D8 (intent 04's F2): Tokenwatch is recognised by what a command
// runs, not by the word appearing somewhere in it.
test('the compose resolver refuses what runs Tokenwatch and runs what only mentions it', async () => {
  const { composedStatusCommand } = await import('../src/installer.mjs');
  const { classifyStatusLineCommand } = await import('../src/claude-settings.mjs');
  const root = tempDir('tw-compose-shape-');
  const config = testConfig(root);
  const runs = (command) => {
    fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'x', compose: [{ command, shell: 'posix' }] } } } }));
    return composedStatusCommand(config, 'user', 'claude') !== null;
  };
  for (const command of ['node /home/u/agent-tokenwatch-fork/tools/status.mjs', '/home/me/agent-tokenwatch/bin/mystatus.sh', 'my-tokenwatcher-free-line']) {
    assert.equal(runs(command), true, `composed: ${command}`);
  }
  for (const command of ['tokenwatch.cmd status', '"C:\\Users\\me\\AppData\\Roaming\\npm\\tokenwatch.cmd" status', 'bash ~/bin/both.sh | tokenwatch status',
    'npx tokenwatch status', '$(tokenwatch status)', '"/opt/node" "/x/bin/tokenwatch.mjs" status', 'tokenwatch-codex exec']) {
    assert.equal(runs(command), false, `refused: ${command}`);
  }
  assert.equal(classifyStatusLineCommand('TOKENWATCH.CMD status', { platform: 'win32' }), 'tokenwatch', 'Windows folds case');
  assert.equal(classifyStatusLineCommand('TOKENWATCH.CMD status', { platform: 'linux' }), 'mentions');
  assert.equal(classifyStatusLineCommand('other-status'), 'other');
});

// Intent 16, D4/D5: a list record, read entry by entry; the object form
// written before it keeps resolving, and at most MAX_COMPOSE_COMMANDS run.
test('the compose resolver reads a list entry by entry, drops what it refuses and runs at most four, in order', async () => {
  const { composedStatusCommand } = await import('../src/installer.mjs');
  const { MAX_COMPOSE_COMMANDS } = await import('../src/constants.mjs');
  assert.equal(MAX_COMPOSE_COMMANDS, 4);
  const root = tempDir('tw-compose-list-');
  const config = testConfig(root);
  const entry = (command, extra = {}) => ({ command, shell: 'posix', ...extra });
  const resolve = (compose) => {
    fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: { user: { claude: { statusInstalled: true, statusCommand: 'x', compose } } } }));
    return composedStatusCommand(config, 'user', 'claude')?.map((spec) => spec.command) ?? null;
  };
  assert.deepEqual(resolve([entry('one'), entry('bash ~/bin/both.sh | tokenwatch status'), entry('three')]), ['one', 'three'], 'a refused entry is dropped, the others kept in order');
  assert.deepEqual(resolve(['1', '2', '3', '4', '5'].map((n) => entry(`cmd-${n}`))), ['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'], 'the first four, never reordered');
  assert.deepEqual(resolve([entry('x', { shell: '/bin/zsh' }), '1', null, ['nested'], entry('ok')]), ['ok'], 'junk in the list is skipped, not fatal');
  assert.equal(resolve([entry('   ')]), null, 'a list with nothing runnable runs nothing');
  assert.equal(resolve([]), null);
});

test('both execution resolvers treat an unreadable install record as no record', async () => {
  const { composedStatusCommand } = await import('../src/installer.mjs');
  const root = tempDir('tw-resolver-corrupt-');
  const config = testConfig(root);
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, '{ truncated');
  assert.equal(composedStatusCommand(config, 'user', 'claude'), null);
  assert.equal(priorCodexNotify(config, 'user'), null);
  assert.throws(() => install(config, { agents: 'claude', scope: 'user', claudeSettings: path.join(root, 's.json'), claudeSkills: path.join(root, 'sk') }),
    /Cannot read JSON/, 'install still refuses to overwrite a record it cannot read');
});
