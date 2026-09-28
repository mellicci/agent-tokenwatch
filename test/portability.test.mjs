import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runCodexWrapper } from '../src/codex-wrapper.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeCommands, copilotCommands, install, nodeOnPathWarning, recordedComposeShell, renderCommand, runsThisCli } from '../src/installer.mjs';
import { CLAUDE_HOOK_EVENTS, CODEX_WRAPPER_ENV, COPILOT_HOOK_EVENTS, PROBE_ENV, PROBE_MARKER } from '../src/constants.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { claudeShell, findGitBash, quoteForCmd, shellLineInvocation, spawnPortable, spawnShellLine } from '../src/spawn.mjs';
import { createJsonExclusively, identityPath, readJson, resolvePath } from '../src/fs-util.mjs';
import { tempDir, testConfig, windowsPath } from './helpers.mjs';
import { listSessionFiles, resolveSessionDir } from '../src/import/sessions.mjs';

// Binds port 0, notes what the OS assigned, and releases it. A later bind can
// still lose a race for that port, but it beats asserting on a number nobody
// checked was free.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}


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

// Binding the port ourselves is the proof that the receiver let it go. Running
// the wrapper again proves nothing: it reads EADDRINUSE as "a receiver is
// already running" and carries on regardless.
function bindOnce(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

// What the wrapper did, as data: it either rejected or resolved an exit code.
// Neither is a hang, which is what these cases exist to rule out.
function settle(promise) {
  return promise.then((code) => ({ code }), (error) => ({ error }));
}

// The receiver keeps the event loop alive, so skipping its close on the failure
// path left `tokenwatch codex` hanging forever, holding the OTLP port. Windows
// hits this by default, because npm installs Codex as a `.cmd` shim that the
// old `spawn(..., { shell: false })` could not execute at all.
//
// How "that program is not there" reaches the wrapper is spawnPortable's
// business and differs by platform. POSIX spawns the name directly and the OS
// refuses it with ENOENT. On Windows a name with no `.exe` is run through
// cmd.exe, which does start, says the program is not recognised on the
// inherited stderr, and exits non-zero, so there is no ENOENT to observe.
// Asserting ENOENT everywhere made this case fail on every Windows run while
// the wrapper was doing the right thing.
test('the Codex wrapper gives up instead of hanging when the child cannot start', async () => {
  const config = testConfig(tempDir());
  config.codex = { ...config.codex, command: 'tokenwatch-definitely-not-installed', otlpPort: 0 };
  const result = await settle(runCodexWrapper(['--version'], { config }));
  if (process.platform === 'win32') {
    assert.equal(result.error, undefined, `cmd.exe itself starts, so nothing is thrown; got ${result.error?.code}`);
    assert.ok(result.code > 0, `the missing program must fail the run, got exit code ${result.code}`);
  } else {
    assert.equal(result.error?.code, 'ENOENT', `the spawn failure must surface, got ${JSON.stringify(result)}`);
  }
});

test('the Codex wrapper releases the receiver port on that failure', async () => {
  const config = testConfig(tempDir());
  // Asked of the OS rather than hard-coded: a fixed port makes this case fail
  // on any machine where something else holds it, and makes two concurrent
  // runs of the suite collide with each other.
  const port = await freePort();
  config.codex = { ...config.codex, command: 'tokenwatch-definitely-not-installed', otlpPort: port };
  const result = await settle(runCodexWrapper(['--version'], { config }));
  assert.ok(result.error || result.code > 0, `the run must fail, got ${JSON.stringify(result)}`);
  await bindOnce(port);
});

// The shape a missing Codex takes on Windows - a child that started and then
// failed - run here with a real child on every platform, so the wrapper's
// handling of it is not verified only where cmd.exe exists.
test('a Codex child that starts and fails is reported by its exit code, and the receiver is released', async () => {
  const config = testConfig(tempDir());
  const port = await freePort();
  config.codex = { ...config.codex, command: process.execPath, otlpPort: port };
  const result = await settle(runCodexWrapper(['-e', 'process.exit(3)'], { config }));
  assert.deepEqual(result, { code: 3 }, `the child's own exit code must come back, got ${JSON.stringify(result)}`);
  await bindOnce(port);
});

// On the first Windows run nothing inside the Codex session could tell whether
// it had been started through the wrapper - the only way Codex tokens reach
// Tokenwatch. The wrapper now marks the Codex it launches, under a name Codex's
// default shell-environment filter (*KEY*, *SECRET*, *TOKEN*) lets through.
test('the Codex wrapper marks the Codex it launches, under a name Codex passes on to its shell', async () => {
  const config = testConfig(tempDir());
  const port = await freePort();
  config.codex = { ...config.codex, command: process.execPath, otlpPort: port };
  const probe = `process.exit(process.env.${CODEX_WRAPPER_ENV} === '1' ? 5 : 6)`;
  const result = await settle(runCodexWrapper(['-e', probe], { config }));
  assert.deepEqual(result, { code: 5 }, `the child must see ${CODEX_WRAPPER_ENV}=1, got ${JSON.stringify(result)}`);
  assert.doesNotMatch(CODEX_WRAPPER_ENV, /KEY|SECRET|TOKEN/i, 'Codex strips such names from the commands it runs');
});

// A ChildProcess emitting 'error' with no listener is an uncaught exception.
// On Windows the recorded notifier is commonly an npm `.cmd` shim, so this
// fired on every Codex turn.
test('a missing prior notifier does not crash the relay', () => {
  const child = spawnPortable('tokenwatch-definitely-not-installed', ['x'], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  assert.ok(child, 'spawning a missing binary must not throw synchronously');
});

test('spawnPortable runs a real executable unchanged on this platform', async () => {
  const child = spawnPortable(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 7);
});

// Every installed command hard-codes the Node that ran `install`. Under nvm,
// fnm or volta that path is version-specific, so switching or removing a
// version silently stops all collection while `doctor` reported all-green.
test('doctor reports an installed command whose interpreter has gone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, { agents: 'claude', scope: 'project', project: root, ...paths(root) });
  const healthy = runDoctor(config, path.join(root, 'config.json'));
  assert.equal(healthy.checks.some((check) => check.id.endsWith(':executable')), false);

  let broken;
  if (process.platform === 'win32') {
    // On Windows Claude Code's commands start the `node` found on PATH, not the
    // Node that ran install (intent 17), so the interpreter that can go is that
    // one: a PATH with no `node` on it.
    const record = readJson(config.installStateFile).installs[`project:${identityPath(root)}`].claude;
    assert.match(record.statusCommand, /^node "/, 'a bare node, resolved on PATH');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = tempDir('tw-no-node-');
    broken = runDoctor(config, path.join(root, 'config.json'), { env });
  } else {
    const stateFile = config.installStateFile;
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8')
      .replaceAll(JSON.stringify(process.execPath).slice(1, -1), '/nowhere/node/v20.11.0/bin/node'));
    broken = runDoctor(config, path.join(root, 'config.json'));
  }
  const finding = broken.checks.find((check) => check.id.endsWith(':executable'));
  assert.ok(finding, 'the missing interpreter must be reported');
  assert.equal(finding.status, 'error');
  if (process.platform === 'win32') assert.match(finding.detail, /`node` is not on PATH here/);
  assert.equal(broken.ok, false, 'and it must make the whole report fail');
});

test('a Git Bash style drive path is only reinterpreted on Windows', () => {
  const input = '/c/Users/someone/.tokenwatch';
  const resolved = resolvePath(input);
  if (process.platform === 'win32') {
    assert.match(resolved, /^C:\\Users\\someone\\\.tokenwatch$/i);
  } else {
    // On POSIX `/c/Users/...` is an ordinary absolute path and must be left alone.
    assert.equal(resolved, input);
  }
});

// On Windows an argument crosses two parsers in sequence: cmd.exe reads the
// line, then the child's own C runtime reconstructs argv from what cmd passed
// on. They disagree about `\"` - that is a C runtime convention cmd knows
// nothing about - so escaping an inner quote that way leaves cmd with an odd
// quote count and its quote state inverted for the rest of the line. Anything
// after that point which cmd treats specially stops being inert, and a Codex
// notify payload is JSON, which is nothing but inner quotes.
//
// Both parsers are modelled here because the real ones are not available on
// this platform, and the property that matters is a relationship between them:
// cmd must expose no metacharacter and must finish balanced, and the child
// must reconstruct the original argument byte for byte.

// cmd.exe: `^X` yields a literal X; outside quotes a metacharacter is live.
function throughCmd(line) {
  let out = '';
  let inQuote = false;
  const exposed = [];
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '^') { out += line[++i] ?? ''; continue; }
    if (character === '"') { inQuote = !inQuote; out += character; continue; }
    if (!inQuote && '&|<>'.includes(character)) exposed.push(character);
    out += character;
  }
  return { out, balanced: !inQuote, exposed };
}

// CommandLineToArgvW, for a single quoted argument.
function throughArgv(text) {
  let out = '';
  let index = 0;
  let inQuote = false;
  while (index < text.length) {
    if (text[index] === '\\') {
      let slashes = 0;
      while (text[index] === '\\') { slashes += 1; index += 1; }
      if (text[index] === '"') {
        out += '\\'.repeat(slashes >> 1);
        if (slashes % 2) { out += '"'; index += 1; } else { inQuote = !inQuote; index += 1; }
      } else out += '\\'.repeat(slashes);
      continue;
    }
    if (text[index] === '"') { inQuote = !inQuote; index += 1; continue; }
    out += text[index];
    index += 1;
  }
  return out;
}

test('a Windows argument survives cmd.exe and the child argv parser unchanged', () => {
  const cases = [
    '{"type":"agent-turn-complete"}',
    '{"type":"x","note":"a & b | c"}',
    '{"path":"C:\\Users\\me\\dir\\"}',
    'C:\\Program Files\\nodejs\\node.exe',
    '{"q":"he said \\"hi\\""}',
    'a"b&calc|dir>x',
    'plain-token',
    'has space',
    ''
  ];
  for (const original of cases) {
    const quoted = quoteForCmd(original);
    const cmd = throughCmd(quoted);
    assert.deepEqual(cmd.exposed, [], `cmd must see no live metacharacter in ${JSON.stringify(original)}`);
    assert.equal(cmd.balanced, true, `cmd quote state must stay balanced for ${JSON.stringify(original)}`);
    assert.equal(throughArgv(cmd.out), original,
      `the child must reconstruct ${JSON.stringify(original)} exactly`);
  }
});

// A reader for exactly the PowerShell subset the installer writes: the `&` call
// operator, then single-quoted words separated by one space, where a doubled
// quote character is one literal quote. PowerShell counts U+2018-U+201B as
// single quotes too. Anything else - an unquoted word, a stray quote, a missing
// call operator - is a parse error here, as it would be for PowerShell, so a
// well-formed rendering is proved on any operating system by reading it back.
const PS_QUOTE = /['\u2018\u2019\u201A\u201B]/;

function readPowerShellCall(text) {
  if (!text.startsWith('& ')) throw new Error(`no call operator: ${text}`);
  const words = [];
  let index = 2;
  while (index < text.length) {
    if (!PS_QUOTE.test(text[index])) throw new Error(`unquoted text at ${index}: ${text}`);
    index += 1;
    let word = '';
    for (;;) {
      if (index >= text.length) throw new Error(`unterminated string: ${text}`);
      if (PS_QUOTE.test(text[index])) {
        if (PS_QUOTE.test(text[index + 1] ?? '')) { word += text[index]; index += 2; continue; }
        index += 1;
        break;
      }
      word += text[index];
      index += 1;
    }
    words.push(word);
    if (index === text.length) break;
    if (text[index] !== ' ' || index + 1 === text.length) throw new Error(`expected one space at ${index}: ${text}`);
    index += 1;
  }
  return words;
}

// The same for POSIX single quotes: a quote is written as '\'' .
function readPosixWords(text) {
  const words = [];
  const pattern = /'((?:[^']|'\\'')*)'(?: |$)/y;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) words.push(match[1].replaceAll(`'\\''`, "'"));
  if (pattern.lastIndex !== text.length || !match) throw new Error(`not a sequence of quoted words: ${text}`);
  return words;
}

// On Windows Copilot runs hooks through PowerShell. The old command, a quoted
// path with no `&`, is a parse error there - it exits non-zero before Node
// starts, and for `preToolUse` that denied every tool call. Profile paths on
// Windows routinely contain spaces and apostrophes, typed or autocorrected.
test('every Copilot hook command renders for PowerShell with the call operator and survives spaces and apostrophes in its paths', () => {
  const runtimes = [
    { node: 'C:\\Program Files\\nodejs\\node.exe', cli: "C:\\Users\\Seán O'Brien\\AppData\\Roaming\\npm\\node_modules\\agent-tokenwatch\\bin\\tokenwatch.mjs" },
    { node: 'C:\\Users\\O\u2019Neil\\scoop\\apps\\nodejs\\current\\node.exe', cli: 'D:\\tools\\it\u2018s here\\bin\\tokenwatch.mjs' }
  ];
  for (const runtime of runtimes) {
    const { hooks } = copilotCommands({ ...runtime, platform: 'win32' });
    assert.deepEqual(Object.keys(hooks), COPILOT_HOOK_EVENTS);
    for (const [eventName, [entry]] of Object.entries(hooks)) {
      const expected = [runtime.node, runtime.cli, 'hook', 'copilot', eventName];
      assert.deepEqual(readPowerShellCall(entry.powershell), expected, `${eventName} powershell: ${entry.powershell}`);
      assert.deepEqual(readPosixWords(entry.bash), expected, `${eventName} bash: ${entry.bash}`);
    }
  }
  // The exact failing form from the Windows report, for contrast.
  assert.throws(() => readPowerShellCall('"C:\\node.exe" "C:\\tw\\bin\\tokenwatch.mjs" "hook" "copilot" "preToolUse"'), /no call operator/);
  assert.equal(renderCommand(["C:\\O'B\\node.exe", 'hook'], 'powershell'), "& 'C:\\O''B\\node.exe' 'hook'");
});

// Copilot 1.0.86 spawns `statusLine.command` with Node's `shell: true`, which is
// cmd.exe on Windows, not PowerShell - read from its shipped status-line runner.
// The `&` form would fail under cmd.exe, so the status line keeps the
// double-quoted form cmd.exe runs, while the hooks move to PowerShell's.
test('the Copilot status line on Windows is rendered for cmd.exe, the shell Copilot spawns it with', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cli = "C:\\Users\\Seán O'Brien\\tw\\bin\\tokenwatch.mjs";
  const { status } = copilotCommands({ node, cli, platform: 'win32' });
  assert.equal(status, `"${node}" "${cli}" "status" "--agent" "copilot" "--ingest-stdin"`);
  assert.equal(copilotCommands({ node: '/usr/bin/node', cli: "/home/o'b/tw.mjs", platform: 'linux' }).status,
    `'/usr/bin/node' '/home/o'\\''b/tw.mjs' 'status' '--agent' 'copilot' '--ingest-stdin'`);
});

// Intent 17. Claude Code on Windows runs a command through Git Bash when it is
// installed and PowerShell when it is not, and Tokenwatch cannot know which at
// the moment the command runs. So one string has to read back to the same argv
// in both: a bare `node`, then double-quoted words. A reader for exactly that
// subset stands in for both shells on any OS; real bash reads it below.
function readPortableWords(text) {
  if (!text.startsWith('node ')) throw new Error(`does not start with a bare node: ${text}`);
  const words = ['node'];
  const pattern = /"([^"]*)"(?: |$)/y;
  pattern.lastIndex = 5;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) words.push(match[1]);
  if (pattern.lastIndex !== text.length || !match) throw new Error(`not a sequence of double-quoted words: ${text}`);
  return words;
}

const CLAUDE_WINDOWS_RUNTIMES = [
  { node: 'C:\\Program Files\\nodejs\\node.exe', cli: "C:\\Users\\Seán O'Brien\\AppData\\Roaming\\npm\\node_modules\\agent-tokenwatch\\bin\\tokenwatch.mjs" },
  { node: 'C:\\Users\\O\u2019Neil\\scoop\\apps\\nodejs\\current\\node.exe', cli: 'D:\\tools\\it\u2018s here\\bin\\tokenwatch.mjs' },
  { node: 'C:\\nodejs\\node.exe', cli: 'C:\\tw\\bin\\tokenwatch.mjs' }
];

function claudeArgvs(cli, composeKey) {
  return [
    ...CLAUDE_HOOK_EVENTS.map((eventName) => ['node', cli, 'hook', 'claude', eventName]),
    ['node', cli, 'status', '--agent', 'claude', '--ingest-stdin'],
    ['node', cli, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', composeKey]
  ];
}

function claudeWindowsCommands(runtime) {
  const plain = claudeCommands({ ...runtime, platform: 'win32' });
  const composed = claudeCommands({ ...runtime, platform: 'win32', composeKey: 'project:C:\\work' });
  return [...CLAUDE_HOOK_EVENTS.map((eventName) => plain.hooks[eventName]), plain.status, composed.status];
}

test('every Claude Code command for Windows is one string that Git Bash and PowerShell both read back to the same argv', () => {
  for (const runtime of CLAUDE_WINDOWS_RUNTIMES) {
    const commands = claudeWindowsCommands(runtime);
    const expected = claudeArgvs(runtime.cli, 'project:C:\\work');
    assert.equal(claudeCommands({ ...runtime, platform: 'win32' }).commandShell, 'gitbash-or-powershell');
    commands.forEach((command, index) => {
      assert.deepEqual(readPortableWords(command), expected[index], command);
      assert.ok(!command.startsWith('& '), `never the PowerShell call operator: ${command}`);
      // The CLI path verbatim, so Tokenwatch still recognises its own entry.
      assert.equal(runsThisCli(command, { cliPath: runtime.cli, platform: 'win32' }), true, command);
    });
  }
});

// Bash itself, where it exists: a `node` function that prints its arguments
// stands in for Node, so bash parses each command exactly as Git Bash would and
// shows the argv it produced. A syntax error would exit 2, which Claude Code
// treats as blocking UserPromptSubmit and Stop (R1).
const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });

test('real bash reads every Claude Code command for Windows back to the argv it was rendered from', { skip: bash ? false : 'bash is not here' }, () => {
  for (const runtime of CLAUDE_WINDOWS_RUNTIMES) {
    const commands = claudeWindowsCommands(runtime);
    const expected = claudeArgvs(runtime.cli, 'project:C:\\work');
    commands.forEach((command, index) => {
      const result = spawnSync(bash, ['-c', `node() { printf '%s\\0' node "$@"; }\n${command}`], { encoding: 'utf8' });
      assert.equal(result.status, 0, `bash exited ${result.status} on ${command}: ${result.stderr}`);
      assert.deepEqual(result.stdout.split('\0').slice(0, -1), expected[index], command);
    });
  }
});

// Off Windows nothing changes: the pinned Node and CLI, single-quoted, byte for
// byte what the old renderer wrote (D14).
test('Claude Code commands off Windows are exactly the POSIX form they always were', () => {
  const node = '/home/o\'b/.nvm/versions/node/v22/bin/node';
  const cli = '/opt/tw/bin/tokenwatch.mjs';
  for (const platform of ['linux', 'darwin']) {
    const plain = claudeCommands({ node, cli, platform });
    assert.equal(plain.commandShell, 'posix');
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      assert.equal(plain.hooks[eventName], renderCommand([node, cli, 'hook', 'claude', eventName], 'posix'));
    }
    assert.equal(plain.status, renderCommand([node, cli, 'status', '--agent', 'claude', '--ingest-stdin'], 'posix'));
    assert.equal(claudeCommands({ node, cli, platform, composeKey: 'user' }).status,
      renderCommand([node, cli, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', 'user'], 'posix'));
  }
});

// A path one of the two shells would read differently is refused at install,
// with the character named, rather than written into a command that runs in
// one shell only (D3). Everything else, the Windows profile paths people really
// have, passes.
test('a Claude Code path that Git Bash and PowerShell would read differently is refused, and ordinary ones are not', () => {
  const refused = {
    'C:\\tw\\a"b\\tokenwatch.mjs': 'U+0022',
    'C:\\tw\\$HOME\\tokenwatch.mjs': 'U+0024',
    'C:\\tw\\a`b\\tokenwatch.mjs': 'U+0060',
    '\\\\server\\share\\tokenwatch.mjs': 'two consecutive backslashes',
    'C:\\tw\\': 'a trailing backslash',
    'C:\\tw\\a\tb\\tokenwatch.mjs': 'a control character',
    'C:\\tw\\\u201cq\u201d\\tokenwatch.mjs': 'U+201C',
    'C:\\tw\\q\u201d\\tokenwatch.mjs': 'U+201D',
    'C:\\tw\\q\u201e\\tokenwatch.mjs': 'U+201E',
    'C:\\tw\\q\u201f\\tokenwatch.mjs': 'U+201F'
  };
  for (const [cli, name] of Object.entries(refused)) {
    assert.throws(() => claudeCommands({ cli, platform: 'win32' }),
      (error) => error.message.includes(name) && !error.message.includes(cli), `${JSON.stringify(cli)} should be refused naming ${name}`);
  }
  for (const cli of ["C:\\Users\\Seán O'Brien\\tw.mjs", 'C:\\Users\\O\u2019Neil\\it\u2018s\\tw.mjs', 'C:\\Program Files\\tw\\tw.mjs', 'C:\\Users\\Müller\\tw.mjs']) {
    assert.doesNotThrow(() => claudeCommands({ cli, platform: 'win32' }), cli);
  }
});

test('install warns on Windows when the node on PATH is missing or is not the one that installed', () => {
  assert.equal(nodeOnPathWarning({ platform: 'linux', env: { PATH: '' } }), undefined, 'off Windows the pinned Node runs');
  const dir = tempDir();
  const node = path.join(dir, 'node.exe');
  fs.writeFileSync(node, '');
  // Lower-case PATHEXT so the lookup matches on a case-sensitive file system too.
  const env = { PATH: dir, PATHEXT: '.exe' };
  assert.equal(nodeOnPathWarning({ platform: 'win32', env, execPath: node }), undefined, 'the same Node is fine');
  assert.match(nodeOnPathWarning({ platform: 'win32', env, execPath: '/elsewhere/node.exe' }),
    /with the node found on PATH \(.*node\.exe\), not the one running this install \(\/elsewhere\/node\.exe\)\.$/);
  assert.match(nodeOnPathWarning({ platform: 'win32', env: { PATH: tempDir() }, execPath: node }), /\(none\).*Install Node 20\+ on PATH\.$/);
});

// One rule, asked by install (the compose record) and by doctor (the probe).
test('Claude Code uses /bin/sh off Windows, Git Bash on Windows when installed, and PowerShell otherwise', () => {
  assert.deepEqual(claudeShell({ platform: 'linux', env: {} }), { shell: 'posix' });
  assert.deepEqual(claudeShell({ platform: 'win32', env: { PATH: tempDir() } }), { shell: 'powershell' });
  const bashFile = path.join(tempDir(), 'bash.exe');
  fs.writeFileSync(bashFile, '');
  assert.deepEqual(claudeShell({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: bashFile } }), { shell: 'bash', shellPath: bashFile });
  // A composed line replays through its agent's own shell: Copilot's is cmd.exe
  // on Windows, never the rule above, which is Claude Code's (intent 04, D5).
  assert.deepEqual(recordedComposeShell('copilot', 'win32'), { shell: 'cmd' });
  assert.deepEqual(recordedComposeShell('copilot', 'linux'), { shell: 'posix' });
  assert.deepEqual(recordedComposeShell('claude', 'linux'), { shell: 'posix' });
});

// The structural reader above is the proof that runs everywhere. Where
// PowerShell is actually installed - every GitHub-hosted CI runner has `pwsh` -
// the rendered hooks are also executed, all in one PowerShell process, in probe
// mode so nothing is stored.
const pwsh = String(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)
  .flatMap((directory) => ['pwsh', 'pwsh.exe'].map((name) => path.join(directory, name)))
  .find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });

test('every Copilot hook command runs under PowerShell where PowerShell is installed', { skip: pwsh ? false : 'pwsh is not on PATH here' }, () => {
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const { hooks } = copilotCommands({ node: process.execPath, cli });
  const script = Object.values(hooks).map(([entry]) => entry.powershell).join('\n');
  const home = tempDir();
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, [PROBE_ENV]: '1' }, timeout: 60_000
  });
  assert.equal(result.status, 0, `pwsh exited ${result.status}: ${result.stderr}`);
  for (const eventName of COPILOT_HOOK_EVENTS) {
    assert.ok(result.stdout.includes(`${PROBE_MARKER} hook copilot ${eventName}`), `${eventName} did not reach Tokenwatch: ${result.stdout}`);
  }
  assert.deepEqual(fs.readdirSync(home), [], 'a probe must not write anything');
});

test('every Claude Code command for Windows runs under PowerShell where PowerShell is installed', { skip: pwsh ? false : 'pwsh is not on PATH here' }, () => {
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const commands = claudeCommands({ cli, platform: 'win32' });
  const script = Object.values(commands.hooks).join('\n');
  const home = tempDir();
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, [PROBE_ENV]: '1' }, timeout: 60_000
  });
  assert.equal(result.status, 0, `pwsh exited ${result.status}: ${result.stderr}`);
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    assert.ok(result.stdout.includes(`${PROBE_MARKER} hook claude ${eventName}`), `${eventName} did not reach Tokenwatch: ${result.stdout}`);
  }
  // The status line's input has to arrive through PowerShell too. The count is
  // printed so the SM-08 run records what PowerShell actually hands on.
  const status = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(commands.status, 'utf16le').toString('base64')], {
    input: '{}', encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, [PROBE_ENV]: '1' }, timeout: 60_000
  });
  const arrived = / stdin=(\d+)$/m.exec(status.stdout)?.[1];
  assert.ok(Number(arrived) > 0, `the status line's stdin did not arrive under PowerShell: ${status.stdout}`);
  console.log(`# PowerShell handed the status line ${arrived} bytes for a 2-byte payload`);
  assert.deepEqual(fs.readdirSync(home), [], 'a probe must not write anything');
});

// Intent 04. A displaced status line is one shell line; replaying it must hand
// the shell that exact line, and the bytes on stdin must arrive untouched.
test('a composed status line is replayed through the shell verbatim, with a quoted path containing a space, and receives stdin byte for byte', async () => {
  const root = tempDir('tw-shell-line-');
  const scriptDir = path.join(root, 'dir with space');
  fs.mkdirSync(scriptDir);
  const script = path.join(scriptDir, 'echo.mjs');
  const sink = path.join(root, 'received.bin');
  fs.writeFileSync(script, `import fs from 'node:fs';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
fs.writeFileSync(${JSON.stringify(sink)}, Buffer.concat(chunks));
process.stdout.write('other ' + process.argv.slice(2).join(','));
`);
  const shell = process.platform === 'win32' ? 'cmd' : 'posix';
  const command = `"${process.execPath}" "${script}" --flag one`;
  const sent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"model":{"id":"ünïcode"}}  \n', 'utf8'), Buffer.from([0xff])]);
  const child = spawnShellLine(command, { shell }, { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stdin.end(sent);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(Buffer.concat(out).toString(), 'other --flag,one');
  assert.equal(Buffer.compare(fs.readFileSync(sink), sent), 0, 'the other command must receive exactly the bytes the agent sent');
});

test('each compose shell kind is invoked the way its agent runs a status line', () => {
  assert.deepEqual(shellLineInvocation('x --y', { shell: 'posix' }, 'linux'), { file: 'x --y', args: [], shell: true });
  assert.deepEqual(shellLineInvocation('x --y', { shell: 'cmd' }, 'win32'), { file: 'x --y', args: [], shell: true });
  assert.deepEqual(shellLineInvocation('x --y', { shell: 'bash', shellPath: 'C:\\Git\\bin\\bash.exe' }, 'win32'),
    { file: 'C:\\Git\\bin\\bash.exe', args: ['-c', 'x --y'], shell: false });
  // Encoded, so double quotes in the line survive the Windows command-line
  // round trip unchanged (intent 17, D8); it decodes to exactly the line.
  const line = 'node "C:\\Users\\Seán O\'Brien\\tokenwatch.mjs" "status"';
  const powershell = shellLineInvocation(line, { shell: 'powershell' }, 'win32');
  assert.equal(powershell.file, 'powershell.exe');
  assert.equal(powershell.shell, false);
  assert.deepEqual(powershell.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(powershell.args[3], 'base64').toString('utf16le'), line);
  assert.equal(powershell.args.length, 4);
  assert.throws(() => shellLineInvocation('x', { shell: '/usr/bin/evil' }), /Unknown compose shell/, 'only a named shell kind is ever used');
  assert.throws(() => shellLineInvocation('x', { shell: 'bash' }, 'win32'), /Git Bash it was recorded with/,
    'never a bare bash, which Windows could resolve to WSL\'s');
});

test('Git Bash is found beside git.exe, never as WSL\'s bash.exe in System32', () => {
  const files = new Set([
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe'
  ]);
  const exists = (file) => files.has(file);
  const env = { PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' };
  assert.equal(findGitBash({ env, exists }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(findGitBash({ env: { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe' }, exists }),
    'C:\\Windows\\System32\\bash.exe', 'an explicit CLAUDE_CODE_GIT_BASH_PATH wins, as it does for Claude Code');
  assert.equal(findGitBash({ env: { PATH: 'C:\\Windows\\System32' }, exists }), null,
    'WSL bash alone means no Git Bash: Claude Code then uses PowerShell');
});

// Intent 06, FR-46: session directories resolve through the same path rules as
// every other configured path, and the file glob matches names only, so a
// Windows separator never reaches the pattern.
test('a session directory resolves like any configured path, and the glob matches file names on any separator', () => {
  const configured = windowsPath('Users', 'me', '.claude', 'projects');
  const config = { import: { claude: { sessionDir: configured }, codex: { sessionDir: '~/.codex/sessions' } } };
  assert.equal(resolveSessionDir('claude', config, {}), resolvePath(configured));
  if (process.platform === 'win32') assert.equal(resolveSessionDir('claude', config, {}), configured);
  assert.equal(resolveSessionDir('codex', config, {}), resolvePath('~/.codex/sessions'));
  assert.equal(resolveSessionDir('codex', config, { CODEX_HOME: windowsPath('codex-home') }), resolvePath(path.join(windowsPath('codex-home'), 'sessions')),
    'CODEX_HOME wins over the configured directory');
  assert.equal(resolveSessionDir('copilot', {}, {}), undefined, 'no configured directory is an honest absence');

  const root = tempDir();
  const nested = path.join(root, '2026', '09', '10');
  fs.mkdirSync(nested, { recursive: true });
  for (const name of ['rollout-2026-09-10T09-00-00-a.jsonl', 'rollout-b.jsonl.bak', 'notes.jsonl', 'rollout-c.json']) fs.writeFileSync(path.join(nested, name), '{}\n');
  const found = listSessionFiles(root, '**/rollout-*.jsonl').map((file) => path.basename(file));
  assert.deepEqual(found, ['rollout-2026-09-10T09-00-00-a.jsonl']);
});

// Windows editors and PowerShell 5.1's Out-File save UTF-8 with a byte-order
// mark. The mark is not JSON, and JSON.parse rejects it, so a config or record
// file a user touched on Windows used to read as corrupt.
test('a JSON file saved with a byte-order mark reads as the JSON it holds', () => {
  const file = path.join(tempDir(), 'bom.json');
  fs.writeFileSync(file, '﻿{"retentionDays": 30}\r\n');
  assert.deepEqual(readJson(file), { retentionDays: 30 });
  fs.writeFileSync(file, '{"a": "﻿ inside a string stays"}');
  assert.equal(readJson(file).a, '﻿ inside a string stays', 'only a leading mark is dropped');
});

// FAT and exFAT volumes, and some network shares, cannot make hard links, and
// Windows reports that as EISDIR or EINVAL rather than EPERM. config.json was
// then never created, and every command failed. Real bytes cannot stage a
// filesystem without links, so fs.linkSync is replaced for this one case and
// every other call goes to the real fs (disclosed in the test principles).
test('a volume that cannot hard-link still gets config.json created exactly once', () => {
  const dir = tempDir('tokenwatch-nolink-');
  const file = path.join(dir, 'config.json');
  const original = fs.linkSync;
  for (const code of ['EISDIR', 'EINVAL']) {
    fs.rmSync(file, { force: true });
    fs.linkSync = () => { throw Object.assign(new Error(`simulated ${code}`), { code }); };
    try {
      assert.equal(createJsonExclusively(file, { projectSalt: 'first' }), true, `${code}: the file is created without a link`);
      assert.equal(createJsonExclusively(file, { projectSalt: 'second' }), false, `${code}: a second creator does not replace it`);
    } finally {
      fs.linkSync = original;
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projectSalt, 'first');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], `${code}: no temporary file is left`);
  }
});

// A config.json holding no settings (`null`) was replaced before; while it was
// treated as "someone else created it", every run drew a new project salt.
test('a config.json that holds no settings is replaced once, and its salt then stays', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const home = tempDir('tokenwatch-nullconfig-');
  fs.writeFileSync(path.join(home, 'config.json'), 'null\n');
  const first = loadConfig({ env: { TOKENWATCH_HOME: home } }).config.projectSalt;
  const second = loadConfig({ env: { TOKENWATCH_HOME: home } }).config.projectSalt;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first, 'the salt written on repair is the one every later run uses');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).projectSalt, first);
});
