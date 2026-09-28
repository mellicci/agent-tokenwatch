import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assessInstallLocation, bundledSkills, claudeCommands, composedStatusCommand, install, runsThisCli, skillUsage, uninstall } from '../src/installer.mjs';
import { AGENTS, FAIL_CLOSED_HOOK_EVENTS } from '../src/constants.mjs';
import { identityPath, readJsonc } from '../src/fs-util.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { symlinkUnavailable, tempDir, testConfig, windowsPath } from './helpers.mjs';

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

// homeDir pins the user level of Claude Code's settings chain inside the test
// root: without it a project-scope --compose would read the real ~/.claude.
function options(root, extra = {}) {
  return { agents: 'all', scope: 'project', project: root, homeDir: path.join(root, 'home'), ...paths(root), ...extra };
}

test('install/uninstall preserves unrelated settings and removes managed entries', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const claudeOriginal = {
    permissions: { allow: ['Read'] },
    hooks: { Stop: [{ matcher: 'special', hooks: [{ type: 'command', command: 'existing-stop' }] }] }
  };
  const copilotOriginal = { theme: 'dark' };
  const codexOriginal = 'model = "test-model"\n';
  fs.writeFileSync(p.claudeSettings, JSON.stringify(claudeOriginal));
  fs.writeFileSync(p.copilotConfig, JSON.stringify(copilotOriginal));
  fs.writeFileSync(p.codexConfig, codexOriginal);

  const record = install(config, options(root));
  assert.ok(record.claude.statusInstalled);
  assert.ok(record.copilot.statusInstalled);
  assert.ok(record.codex.otelInstalled);
  const skills = bundledSkills();
  assert.ok(skills.length > 1, 'the bundle ships more than one skill');
  for (const name of skills) {
    assert.ok(fs.existsSync(path.join(p.claudeSkills, name, 'SKILL.md')), `${name} installed for Claude`);
    assert.ok(fs.existsSync(path.join(p.sharedSkills, name, 'SKILL.md')), `${name} installed for shared agents`);
  }
  assert.ok(fs.existsSync(p.copilotHooks));
  assert.match(fs.readFileSync(p.codexConfig, 'utf8'), /tokenwatch:v1 begin otel/);

  const result = uninstall(config, { scope: 'project', project: root });
  assert.equal(result.removed, true);
  // Untouched between install and uninstall, so the bytes come back (intent 18).
  assert.equal(fs.readFileSync(p.claudeSettings, 'utf8'), JSON.stringify(claudeOriginal));
  assert.equal(fs.readFileSync(p.copilotConfig, 'utf8'), JSON.stringify(copilotOriginal));
  assert.equal(fs.existsSync(p.copilotHooks), false);
  for (const name of skills) {
    assert.equal(fs.existsSync(path.join(p.claudeSkills, name, 'SKILL.md')), false, `${name} removed for Claude`);
    assert.equal(fs.existsSync(path.join(p.sharedSkills, name, 'SKILL.md')), false, `${name} removed for shared agents`);
  }
  const codexAfter = fs.readFileSync(p.codexConfig, 'utf8');
  assert.match(codexAfter, /model = "test-model"/);
  assert.doesNotMatch(codexAfter, /tokenwatch|\[otel\]|^notify\s*=/m);
});

// Intent 17: the record says which rendering its commands use and which Node
// installed them, and every command keeps this CLI's path verbatim, so
// Tokenwatch still recognises its own entries whatever the platform rendering.
test('a Claude install records the shell kind its commands were rendered for and the CLI path verbatim', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const record = install(config, options(root, { agents: 'claude' }));
  assert.equal(record.claude.commandShell, process.platform === 'win32' ? 'gitbash-or-powershell' : 'posix');
  assert.equal(record.claude.node, process.execPath);
  for (const command of [...record.claude.hooks.map((hook) => hook.command), record.claude.statusCommand]) {
    assert.equal(runsThisCli(command), true, command);
  }
  const cli = 'C:\\Users\\Seán O\'Brien\\AppData\\Roaming\\npm\\node_modules\\agent-tokenwatch\\bin\\tokenwatch.mjs';
  const windows = claudeCommands({ cli, platform: 'win32' });
  for (const command of [...Object.values(windows.hooks), windows.status]) {
    assert.equal(runsThisCli(command, { cliPath: cli, platform: 'win32' }), true, command);
  }
});

// A reinstall that would have to refuse the new commands must refuse before it
// removes the old ones, or a working install is left with nothing (review).
test('a forced Claude reinstall that refuses its new commands leaves the previous install in place', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'claude' }));
  const settingsBefore = fs.readFileSync(paths(root).claudeSettings, 'utf8');
  const stateBefore = fs.readFileSync(config.installStateFile, 'utf8');

  assert.throws(() => install(config, options(root, { agents: 'claude', force: true, platform: 'win32', cliPath: 'C:\\tw\\$x\\tokenwatch.mjs' })),
    /U\+0024 \(dollar sign\)\. Move Tokenwatch, or the project it is installed for/);
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), settingsBefore, 'the settings file was not touched');
  assert.equal(fs.readFileSync(config.installStateFile, 'utf8'), stateBefore, 'the install record was not touched');
});

// Intent 18: an agent's settings file is the user's, so install touches only
// its own keys and uninstall gives the exact bytes back. Buffer equality, not
// value equality: a value-level round trip passed for years while every
// install reformatted the file and deleted Copilot's comments.
function installThenUninstall(root, config, file, text, extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const record = install(config, options(root, extra));
  const installed = fs.readFileSync(file, 'utf8');
  uninstall(config, { scope: 'project', project: root });
  return { record, installed, after: fs.readFileSync(file) };
}

test('install then uninstall returns a commented Copilot settings file byte for byte', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const text = '{\n    // managed by Copilot CLI\n    /* theme block */\n    "theme": "dark",\n    "model": "x" // chosen by me\n}\n';
  const { installed, after } = installThenUninstall(root, config, paths(root).copilotConfig, text, { agents: 'copilot' });
  assert.ok(installed.includes('// managed by Copilot CLI') && installed.includes('// chosen by me'), 'comments survive install');
  assert.equal(Buffer.compare(after, Buffer.from(text)), 0);
});

test('install then uninstall returns a formatted Claude settings file byte for byte', () => {
  const variants = {
    'an existing hook entry': '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "my-own-hook" } ] }\n    ]\n  }\n}\n',
    'an empty hooks object': '{\n  "hooks": {}\n}\n',
    'CRLF line endings': '{\r\n  "model": "sonnet"\r\n}\r\n',
    'a byte-order mark': '﻿{\n  "model": "sonnet"\n}\n',
    'no trailing newline': '{"model":"sonnet"}'
  };
  for (const [name, text] of Object.entries(variants)) {
    const root = tempDir();
    const config = testConfig(path.join(root, 'state'));
    const { installed, after } = installThenUninstall(root, config, paths(root).claudeSettings, text, { agents: 'claude' });
    assert.ok(installed.includes('hook'), `${name}: installed`);
    assert.equal(Buffer.compare(after, Buffer.from(text)), 0, `${name}: byte for byte`);
  }
});

test('install adds only its own lines to a Claude settings file', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  // my settings\n  "model": "sonnet",\n  "permissions": {\n    "allow": []\n  }\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  const before = text.split('\n');
  const after = fs.readFileSync(file, 'utf8').split('\n');
  let index = 0;
  const added = [];
  for (const line of after) {
    // One separator change is allowed: a comma after the line that was last.
    if (index < before.length && (line === before[index] || line === `${before[index]},`)) index += 1;
    else added.push(line);
  }
  assert.equal(index, before.length, 'every original line is still there, in order');
  for (const line of added) {
    assert.ok(/tokenwatch/.test(line) || /^\s*([{}\[\],]+|"[A-Za-z]+": [{\[]|"(type|timeout)": .*|"hooks": \[)\s*,?\s*$/.test(line),
      `an added line that is neither Tokenwatch's nor structure: ${JSON.stringify(line)}`);
  }
});

test('a settings file edited after install keeps the edit and loses only Tokenwatch\'s entries', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).copilotConfig;
  const text = '{\n  // managed by Copilot CLI\n  "theme": "dark"\n}\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'copilot' }));
  const marker = '  // managed by Copilot CLI\n';
  const edit = (content) => content.replace(marker, `${marker}  // added later\n  "font": 12,\n`);
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), edit(text));
});

test('a forced reinstall still uninstalls to the original bytes', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n    "model": "sonnet"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  install(config, options(root, { agents: 'claude', force: true }));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a settings file keeps its mode through install and uninstall', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '{}\n');
  fs.chmodSync(file, 0o644);
  install(config, options(root, { agents: 'claude' }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'after install');
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'after uninstall');
});

test('a settings file that is not a JSON object is refused for that agent, and the others install', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '[1, 2]\n');
  const record = install(config, options(root, { agents: 'claude,copilot' }));
  assert.equal(record.claude.refused, 'not-object');
  assert.match(record.claude.warning, /does not hold a JSON object at its top level/);
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), '[1, 2]\n');
  assert.ok(record.copilot.statusInstalled, 'Copilot installed anyway');
  const saved = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0];
  assert.equal(saved.claude.refused, 'not-object', 'the refusal is saved, so doctor can report it (owner decision B, amending D25)');
});

// Found by the live test (D28): Claude Code ignores a settings file with a
// comment, so installing into one would report hooks that never run. Copilot
// reads comments, so the same file content installs there.
test('a Claude settings file with comments is refused, because Claude Code would ignore it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const text = '{\n  // mine\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(paths(root).claudeSettings, text);
  fs.writeFileSync(paths(root).copilotConfig, text);
  const record = install(config, options(root, { agents: 'claude,copilot' }));
  assert.equal(record.claude.refused, 'comments');
  assert.ok(record.claude.warning.endsWith(`was not changed: it contains comments, and Claude Code ignores a settings file that does. Repair it, then run: tokenwatch install --agents claude --scope project --project "${root}" --force`), record.claude.warning);
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), text, 'the Claude file is untouched');
  assert.equal(record.copilot.refused, undefined, 'Copilot reads comments, so it installs');
  assert.ok(record.copilot.statusInstalled);
  fs.writeFileSync(paths(root).claudeSettings, '{\n  "model": "sonnet",\n}\n');
  assert.match(install(config, options(root, { agents: 'claude', force: true })).claude.warning, /it does not parse as JSON\. Repair/,
    'a broken Claude file is not told that comments are allowed');
});

// Removing Tokenwatch's own entries from a file the user has since commented
// is still right: the refusal above is about an install that would not run.
test('uninstall still removes Tokenwatch\'s entries from a Claude file the user has since commented', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '{\n  "model": "sonnet"\n}\n');
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('{\n', '{\n  // added later\n'));
  const removed = uninstall(config, { scope: 'project', project: root });
  assert.equal(removed.kept, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  // added later\n  "model": "sonnet"\n}\n');
});

test('a Claude record written before intent 18 is removed by key and leaves the user\'s containers', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '{\n  "hooks": {}\n}\n');
  install(config, options(root, { agents: 'claude' }));
  // An older record has no `file` sub-record: no hashes, no created paths.
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  delete Object.values(state.installs)[0].claude.file;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  uninstall(config, { scope: 'project', project: root });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.statusLine, undefined);
  assert.ok(after.hooks && typeof after.hooks === 'object', 'no container is removed for an older record');
  assert.equal(JSON.stringify(after).includes('tokenwatch'), false, 'Tokenwatch\'s entries are gone');
});

test('a settings file Tokenwatch created but the user then edited is kept, with only Tokenwatch\'s entries removed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  install(config, options(root, { agents: 'claude' }));
  const edited = fs.readFileSync(file, 'utf8').replace('{\n', '{\n  "model": "mine",\n');
  fs.writeFileSync(file, edited);
  uninstall(config, { scope: 'project', project: root });
  assert.ok(fs.existsSync(file), 'the edited file is not deleted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'mine' }, 'the containers Tokenwatch created are gone, the edit stays');
});

test('a Claude settings file edited after install keeps the edit, and loses the hooks Tokenwatch created', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  const edit = (content) => content.replace('  "model": "sonnet"', '  // mine\n  "model": "sonnet"');
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), edit(text));
});

test('a replaced status line comes back with its own text, spacing included, even after an edit elsewhere', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  // --force replaces the whole status line, so its `padding` member and its
  // own spacing leave the file; the key-level uninstall must put back the
  // original text, not a re-rendered copy.
  const text = '{\n  "statusLine": {\n    "type": "command",\n    "command": "my-status",\n    "padding" :  2\n  }\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude', force: true }));
  const edit = (content) => content.replace('{\n', '{\n  "model": "x",\n');
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), edit(text));
});

test('a user\'s own empty hook array survives the key-level uninstall', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  "hooks": {\n    "Stop": []\n  }\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  const edit = (content) => content.replace('{\n', '{\n  "model": "x",\n');
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), edit(text));
});

test('a record whose restore spans were tampered with falls back to removing entries by key, never writing garbage', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  for (const group of Object.values(state.installs)[0].claude.file.inverse) for (const edit of group) edit.text = 'GARBAGE';
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  uninstall(config, { scope: 'project', project: root });
  const after = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /GARBAGE/);
  assert.deepEqual(JSON.parse(after), { model: 'sonnet' });
});

test('an uninstall that cannot edit a settings file keeps that agent\'s record, so a retry finishes the job', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude,copilot' }));
  const installed = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${installed.trimEnd()},`);
  const first = uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(first.kept, ['claude']);
  assert.match(first.warnings[0], /was not changed: it does not parse/);
  assert.equal(fs.existsSync(paths(root).copilotHooks), false, 'the other agent was removed');
  assert.ok(Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0].claude, 'Claude\'s record is kept');
  fs.writeFileSync(file, installed);
  const second = uninstall(config, { scope: 'project', project: root });
  assert.equal(second.kept, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the retry restores the original bytes');
});

// Review H1: the refusal message tells the user to repair the file and run
// install --force. That forced reinstall must not discard the record of what
// Tokenwatch already wrote, or its hooks stay in the file with nothing able
// to remove them.
test('a forced reinstall over a settings file it cannot edit keeps the record, and a retry after repair finishes cleanly', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const text = '{\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'claude' }));
  const installed = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${installed.trimEnd()},`);
  const refused = install(config, options(root, { agents: 'claude', force: true }));
  assert.equal(refused.claude.refused, 'unparseable');
  assert.match(refused.claude.warning, /was not changed/);
  const saved = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0].claude;
  assert.equal(saved.hooks.length, 7, 'the record of Tokenwatch\'s hooks is kept');
  assert.ok(saved.file, 'and so is what restores the file');
  assert.ok(saved.statusCommand, 'and the status line it installed');
  assert.equal(saved.refused, undefined, 'the refusal is reported, not saved');
  fs.writeFileSync(file, installed);
  install(config, options(root, { agents: 'claude', force: true }));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a forced Copilot reinstall over a settings file it cannot edit leaves its hooks file and record alone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).copilotConfig;
  const text = '{\n  // mine\n  "theme": "dark"\n}\n';
  fs.writeFileSync(file, text);
  install(config, options(root, { agents: 'copilot' }));
  const installed = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${installed.trimEnd()},`);
  const refused = install(config, options(root, { agents: 'copilot', force: true }));
  assert.equal(refused.copilot.refused, 'unparseable');
  assert.ok(fs.existsSync(paths(root).copilotHooks), 'the hooks file still matches the kept record');
  fs.writeFileSync(file, installed);
  install(config, options(root, { agents: 'copilot', force: true }));
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.existsSync(paths(root).copilotHooks), false);
});

// Review 2, M1 (D25): a refusal is the result of the command that met it. A
// later install for another agent must not print it again as if it were new.
test('a held-back refusal is not reported again by a later install for another agent', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '{\n  "model": "sonnet"\n}\n');
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trimEnd()},`);
  assert.equal(install(config, options(root, { agents: 'claude', force: true })).claude.refused, 'unparseable');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const later = spawnSync(process.execPath, [cli, 'install', '--agents', 'copilot', '--force', '--scope', 'project', '--project', root,
    '--claude-settings', file, '--claude-skills', paths(root).claudeSkills,
    '--copilot-config', paths(root).copilotConfig, '--copilot-hooks', paths(root).copilotHooks, '--shared-skills', paths(root).sharedSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'state') }
  });
  assert.equal(later.status, 0, later.stderr);
  assert.doesNotMatch(later.stderr, /claude-settings/);
  assert.equal(JSON.parse(later.stdout).claude.refused, undefined);
  assert.equal(JSON.parse(later.stdout).claude.hooks.length, 7, 'Claude\'s record is still carried');
});

test('a hook group the user adds under hooks Tokenwatch created survives uninstall', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '{\n  "model": "sonnet"\n}\n');
  install(config, options(root, { agents: 'claude' }));
  const settings = readJsonc(file);
  settings.hooks.MyOwnEvent = [{ hooks: [{ type: 'command', command: 'mine' }] }];
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'sonnet', hooks: { MyOwnEvent: [{ hooks: [{ type: 'command', command: 'mine' }] }] } });
});

test('a settings file over the size cap is refused and left untouched', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1));
  const record = install(config, options(root, { agents: 'claude' }));
  assert.equal(record.claude.refused, 'too-large');
  assert.match(record.claude.warning, /is larger than 4 MiB/);
  assert.equal(fs.statSync(file).size, 4 * 1024 * 1024 + 1, 'untouched');
});

test('a settings refusal is reported on stderr, not only in the install record', () => {
  const root = tempDir();
  fs.writeFileSync(paths(root).claudeSettings, '[1]\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'install', '--agents', 'claude', '--scope', 'project', '--project', root,
    '--claude-settings', paths(root).claudeSettings, '--claude-skills', paths(root).claudeSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'home') }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^WARN claude-settings: .* was not changed: it does not hold a JSON object at its top level\./m);
});

// The refusal names the command to run once the file is repaired. Printed flat,
// a project-scope user who followed it literally installed at user scope and
// left the project uninstrumented. The reason text is intent 18's (D4); only
// the command carries the scope.
test('a refused settings file names a remedy for the scope it was installed at', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{ "model": "sonnet", }\n');
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  const project = install(config, options(root, { agents: 'claude,copilot' }));
  const scoped = `--scope project --project "${root}" --force`;
  assert.ok(project.claude.warning.endsWith(`it does not parse as JSON. Repair it, then run: tokenwatch install --agents claude ${scoped}`), project.claude.warning);
  assert.ok(project.copilot.warning.endsWith(`it does not hold a JSON object at its top level. Repair it, then run: tokenwatch install --agents copilot ${scoped}`), project.copilot.warning);

  const userRoot = tempDir();
  const userConfig = testConfig(path.join(userRoot, 'state'));
  fs.writeFileSync(paths(userRoot).claudeSettings, '[1]\n');
  const user = install(userConfig, { ...paths(userRoot), agents: 'claude', scope: 'user', homeDir: path.join(userRoot, 'home') });
  assert.ok(user.claude.warning.endsWith('Repair it, then run: tokenwatch install --agents claude --force'), user.claude.warning);
});

// An uninstall that meets a file broken after install keeps that agent's record
// so a retry finishes the job. The retry is the uninstall, for the same scope:
// the reinstall it used to name would put Tokenwatch back rather than take it out.
test('an uninstall that cannot edit a settings file names the uninstall to run once it is repaired, for its own scope', () => {
  const broken = (root, config, scope) => {
    fs.writeFileSync(paths(root).claudeSettings, '{}\n');
    install(config, scope === 'user'
      ? { ...paths(root), agents: 'claude', scope: 'user', homeDir: path.join(root, 'home') }
      : options(root, { agents: 'claude' }));
    const installed = fs.readFileSync(paths(root).claudeSettings, 'utf8');
    fs.writeFileSync(paths(root).claudeSettings, `${installed.trimEnd()},`);
    return installed;
  };
  const project = tempDir();
  const projectConfig = testConfig(path.join(project, 'state'));
  const installed = broken(project, projectConfig, 'project');
  const removed = uninstall(projectConfig, { scope: 'project', project });
  assert.deepEqual(removed.kept, ['claude']);
  assert.ok(removed.warnings[0].endsWith(`was not changed: it does not parse as JSON. Repair it, then run: tokenwatch uninstall --scope project --project "${project}"`), removed.warnings[0]);

  const user = tempDir();
  const userConfig = testConfig(path.join(user, 'state'));
  broken(user, userConfig, 'user');
  const userRemoved = uninstall(userConfig, { scope: 'user' });
  assert.ok(userRemoved.warnings[0].endsWith('Repair it, then run: tokenwatch uninstall'), userRemoved.warnings[0]);

  // Followed as printed, once the file is repaired, it finishes the job.
  fs.writeFileSync(paths(project).claudeSettings, installed);
  const retried = uninstall(projectConfig, { scope: 'project', project });
  assert.equal(retried.kept, undefined, JSON.stringify(retried.warnings));
  assert.equal(fs.readFileSync(paths(project).claudeSettings, 'utf8'), '{}\n');
});

// Owner decision (option B, amending intent 18 D4 and D25): a refusal is
// install state. The saved record says so, and an agent Tokenwatch could not
// instrument gets no skills either: they would invite a user to ask a skill
// about data that is not being collected.
test('a refused settings file is saved as refused, and that agent gets no skills', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{ "model": "sonnet", }\n');
  const result = install(config, options(root, { agents: 'claude,copilot' }));
  const saved = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0];
  assert.equal(saved.claude.refused, 'unparseable', `saved claude record: ${JSON.stringify(saved.claude)}`);
  assert.equal(saved.claude.warning, result.claude.warning, 'the saved warning is the one printed');
  assert.equal(saved.claudeSkills, undefined, `no Claude skills recorded, got ${JSON.stringify(saved.claudeSkills)}`);
  assert.equal(fs.existsSync(paths(root).claudeSkills), false, 'no Claude skill was written');
  assert.ok(saved.copilot.statusInstalled, 'Copilot installed anyway');
  assert.equal(saved.sharedSkills.length, bundledSkills().length, 'and has its skills');
});

test('a refused Copilot gets no shared skills, unless Codex installed in the same run uses them', () => {
  const alone = tempDir();
  const aloneConfig = testConfig(path.join(alone, 'state'));
  fs.writeFileSync(paths(alone).copilotConfig, '[1]\n');
  const refused = install(aloneConfig, options(alone, { agents: 'copilot' }));
  assert.equal(refused.copilot.refused, 'not-object');
  assert.equal(refused.sharedSkills, undefined, `got ${JSON.stringify(refused.sharedSkills)}`);
  assert.equal(fs.existsSync(paths(alone).sharedSkills), false, 'no shared skill was written');

  const withCodex = tempDir();
  const codexConfig = testConfig(path.join(withCodex, 'state'));
  fs.writeFileSync(paths(withCodex).copilotConfig, '[1]\n');
  const both = install(codexConfig, options(withCodex, { agents: 'copilot,codex' }));
  assert.equal(both.copilot.refused, 'not-object');
  assert.equal(both.sharedSkills.filter((skill) => skill.installed).length, bundledSkills().length, 'Codex reads the shared skills');
  for (const name of bundledSkills()) assert.ok(fs.existsSync(path.join(paths(withCodex).sharedSkills, name, 'SKILL.md')), `${name} installed for Codex`);
  assert.deepEqual(Object.keys(skillUsage(both)), ['codex'], 'install tells only Codex how to run them');
});

// Tokenwatch wrote nothing into a refused file, so there is nothing of it to
// remove: uninstall finishes even while the file is still broken, and leaves it
// byte for byte as it was.
test('a refused install uninstalls cleanly while its settings file is still broken', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const claudeText = '{ "model": "sonnet", }\n';
  fs.writeFileSync(paths(root).claudeSettings, claudeText);
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  install(config, options(root, { agents: 'claude,copilot' }));
  const result = uninstall(config, { scope: 'project', project: root });
  assert.equal(result.removed, true);
  assert.equal(result.kept, undefined, `nothing is kept: ${JSON.stringify(result.warnings)}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs, {}, 'the record is gone');
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), claudeText);
  assert.equal(fs.readFileSync(paths(root).copilotConfig, 'utf8'), '[1]\n');
});

// The remedy the refusal names, followed after the repair, installs the agent
// and a later uninstall returns the repaired file exactly, leaving no folder
// Tokenwatch made.
test('the remedy a refusal names installs the agent once the file is repaired, and uninstall leaves nothing behind', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{ "model": "sonnet", }\n');
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  install(config, options(root, { agents: 'claude,copilot' }));
  const repairedClaude = '{ "model": "sonnet" }\n';
  fs.writeFileSync(paths(root).claudeSettings, repairedClaude);
  fs.writeFileSync(paths(root).copilotConfig, '{}\n');
  const fixed = install(config, options(root, { agents: 'claude,copilot', force: true }));
  assert.equal(fixed.claude.refused, undefined, fixed.claude.warning);
  assert.ok(fixed.claude.statusInstalled && fixed.copilot.statusInstalled);
  const saved = Object.values(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs)[0];
  assert.equal(saved.claude.refused, undefined, 'a successful install clears the saved refusal');
  assert.equal(saved.claudeSkills.length, bundledSkills().length);
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8'), repairedClaude);
  assert.equal(fs.readFileSync(paths(root).copilotConfig, 'utf8'), '{}\n');
  assert.equal(fs.existsSync(path.dirname(paths(root).copilotHooks)), false, 'the hooks folder Tokenwatch made is gone');
});

test('uninstall removes a Copilot hooks folder Tokenwatch created, and keeps one that was already there', () => {
  const made = tempDir();
  const madeConfig = testConfig(path.join(made, 'state'));
  install(madeConfig, options(made, { agents: 'copilot' }));
  uninstall(madeConfig, { scope: 'project', project: made });
  assert.equal(fs.existsSync(path.dirname(paths(made).copilotHooks)), false, `${path.dirname(paths(made).copilotHooks)} was left behind`);

  const theirs = tempDir();
  const theirsConfig = testConfig(path.join(theirs, 'state'));
  fs.mkdirSync(path.dirname(paths(theirs).copilotHooks));
  install(theirsConfig, options(theirs, { agents: 'copilot' }));
  uninstall(theirsConfig, { scope: 'project', project: theirs });
  assert.equal(fs.existsSync(paths(theirs).copilotHooks), false);
  assert.ok(fs.existsSync(path.dirname(paths(theirs).copilotHooks)), 'a folder that was there before install stays');
});

// A saved refusal belongs to the install that met it. A later install for
// another agent carries the record but does not print it again as news (D25).
test('a saved refusal is not printed again by a later install for another agent', () => {
  const root = tempDir();
  const file = paths(root).claudeSettings;
  fs.writeFileSync(file, '[1]\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const run = (agents, ...extra) => spawnSync(process.execPath, [cli, 'install', '--agents', agents, ...extra, '--scope', 'project', '--project', root,
    '--claude-settings', file, '--claude-skills', paths(root).claudeSkills,
    '--copilot-config', paths(root).copilotConfig, '--copilot-hooks', paths(root).copilotHooks, '--shared-skills', paths(root).sharedSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'state') }
  });
  const first = run('claude');
  assert.match(first.stderr, /^WARN claude-settings: /m, first.stderr);
  const later = run('copilot', '--force');
  assert.equal(later.status, 0, later.stderr);
  assert.doesNotMatch(later.stderr, /claude-settings/, later.stderr);
  const saved = Object.values(JSON.parse(fs.readFileSync(path.join(root, 'state', 'install-state.json'), 'utf8')).installs)[0];
  assert.equal(saved.claude.refused, 'not-object', 'the refusal stays saved for doctor');
});

// Leaving a retained agent's old refusal out of the printed result must not
// make it look instrumented: the usage lines are about what the agents can
// use, so a refused Copilot, carried along by a later Codex reinstall, is still
// not told to type /tw-<name> into a session Tokenwatch records nothing from.
test('a later install for another agent does not tell a refused Copilot how to run the skills', () => {
  const root = tempDir();
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const run = (agents, ...extra) => spawnSync(process.execPath, [cli, 'install', '--agents', agents, ...extra, '--scope', 'project', '--project', root,
    '--copilot-config', paths(root).copilotConfig, '--copilot-hooks', paths(root).copilotHooks,
    '--codex-config', paths(root).codexConfig, '--shared-skills', paths(root).sharedSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'state') }
  });
  const first = run('copilot,codex');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(Object.keys(JSON.parse(first.stdout).skillUsage), ['codex'], first.stdout);
  const later = run('codex', '--force');
  assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(Object.keys(JSON.parse(later.stdout).skillUsage), ['codex'], later.stdout);
  const saved = Object.values(JSON.parse(fs.readFileSync(path.join(root, 'state', 'install-state.json'), 'utf8')).installs)[0];
  assert.equal(saved.copilot.refused, 'not-object', 'Copilot is still refused');
});

test('the file entry of a record that replaced a status line stays within its bound too', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const filler = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key${index}`, 'x'.repeat(20)]));
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'someone-else --flag' }, ...filler }, null, 2));
  const record = install(config, options(root, { agents: 'claude', force: true }));
  const replaced = Buffer.byteLength(record.claude.file.priorStatusLineText ?? '');
  assert.ok(replaced > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(record.claude.file)) <= 2048 + replaced);
});

test('the install record\'s file entry stays small', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).claudeSettings;
  const filler = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key${index}`, 'x'.repeat(20)]));
  fs.writeFileSync(file, JSON.stringify(filler, null, 2));
  assert.ok(fs.statSync(file).size > 2048);
  const record = install(config, options(root, { agents: 'claude' }));
  assert.ok(Buffer.byteLength(JSON.stringify(record.claude.file)) <= 2048, `${Buffer.byteLength(JSON.stringify(record.claude.file))} bytes`);
});

// Intent 16, R-14: the old default, now under --no-compose. The new default
// composes (see 'a default install into a taken slot composes it').
test('existing status lines are preserved under --no-compose, and hidden only with --force', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const priorClaude = { type: 'command', command: 'my-claude-status' };
  const priorCopilot = { command: 'my-copilot-status' };
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: priorClaude }));
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ statusLine: priorCopilot }));
  fs.writeFileSync(p.codexConfig, 'notify = ["existing-notifier"]\n');

  let record = install(config, options(root, { compose: false }));
  assert.match(record.claude.warning, /statusLine already exists; hooks and skill were installed, but the status line was left unchanged/, 'today\'s text, verbatim (NFR-22)');
  assert.match(record.copilot.warning, /statusLine.command already exists; hooks and skills were installed, but the status line was left unchanged/);
  assert.equal(record.claude.compose, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine, priorClaude);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).statusLine, priorCopilot);
  assert.match(fs.readFileSync(p.codexConfig, 'utf8'), /existing-notifier/);
  uninstall(config, { scope: 'project', project: root });

  record = install(config, options(root, { force: true }));
  assert.notDeepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine, priorClaude);
  assert.notDeepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).statusLine, priorCopilot);
  assert.doesNotMatch(fs.readFileSync(p.codexConfig, 'utf8').split('\n')[0], /existing-notifier/);
  uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine, priorClaude);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).statusLine, priorCopilot);
  assert.match(fs.readFileSync(p.codexConfig, 'utf8'), /notify = \["existing-notifier"\]/);
});

// Uninstall owes the user the notifier `--force` displaced, but only while the
// slot still holds Tokenwatch's relay. A notifier the user chose after install
// is their decision, and restoring the old one over it would undo it silently.
test('uninstall keeps a notify line the user changed since install, and says so without quoting it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.codexConfig, 'model = "o3"\nnotify = ["/usr/bin/old-notifier"]\n');
  const record = install(config, { ...options(root), agents: 'codex', force: true });
  assert.ok(record.codex.priorNotifyLine, 'the displaced notifier is recorded for restore');
  const installed = fs.readFileSync(p.codexConfig, 'utf8');
  const chosen = 'notify = ["/usr/bin/NEW-TOOL-POISON", "--flag"]';
  fs.writeFileSync(p.codexConfig, installed.replace(/^notify = \[.*\]$/m, chosen));

  const result = uninstall(config, { scope: 'project', project: root });
  const after = fs.readFileSync(p.codexConfig, 'utf8');
  assert.match(after, /^notify = \["\/usr\/bin\/NEW-TOOL-POISON", "--flag"\]$/m, 'the user\'s newer notifier stays');
  assert.doesNotMatch(after, /old-notifier/, 'the old notifier is not written over it');
  assert.doesNotMatch(after, /tokenwatch:v1|\[otel\]/, 'the managed block is still removed');
  assert.equal(after, 'model = "o3"\nnotify = ["/usr/bin/NEW-TOOL-POISON", "--flag"]\n', `got ${JSON.stringify(after)}`);
  assert.equal(result.removed, true);
  assert.equal(result.warnings?.length, 1, `one warning, got ${JSON.stringify(result.warnings)}`);
  assert.match(result.warnings[0], new RegExp(p.codexConfig.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'the warning names the file');
  assert.doesNotMatch(result.warnings[0], /NEW-TOOL-POISON|old-notifier/, 'and quotes neither notifier');
  assert.equal(listStateKeys(config).length, 0, 'the Codex record is still removed');
});

// The same change met by a forced reinstall's teardown. The teardown leaves the
// newer notifier, the reinstall displaces it under --force and records it, so
// the one install displaced first is no longer recorded. That used to happen
// in silence: the teardown's warning was dropped. The newer notifier is the
// user's latest choice, so it is the one uninstall brings back.
test('a forced Codex reinstall over a notify line changed since install says so, and restores the newer notifier on uninstall', () => {
  const root = tempDir();
  const p = paths(root);
  fs.writeFileSync(p.codexConfig, 'notify = ["/usr/bin/FIRST-POISON"]\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--scope', 'project', '--project', root], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'state') }
  });
  const forced = (...extra) => run('install', '--agents', 'codex', '--force', '--codex-config', p.codexConfig, '--shared-skills', p.sharedSkills, ...extra);
  assert.equal(forced().status, 0);
  fs.writeFileSync(p.codexConfig, fs.readFileSync(p.codexConfig, 'utf8').replace(/^notify = \[.*\]$/m, 'notify = ["/usr/bin/SECOND-POISON"]'));

  const again = forced();
  assert.equal(again.status, 0, again.stderr);
  const warning = again.stderr.split('\n').find((line) => line.startsWith('WARN settings: '));
  assert.ok(warning, `the teardown's warning is printed, got ${JSON.stringify(again.stderr)}`);
  assert.ok(warning.includes(p.codexConfig), warning);
  assert.match(warning, /no longer recorded/, warning);
  assert.doesNotMatch(`${again.stderr}${again.stdout}`, /FIRST-POISON|SECOND-POISON/, 'neither notifier is quoted');
  assert.deepEqual(JSON.parse(again.stdout).warnings, [warning.slice('WARN settings: '.length)]);

  assert.equal(run('uninstall').status, 0);
  assert.equal(fs.readFileSync(p.codexConfig, 'utf8'), 'notify = ["/usr/bin/SECOND-POISON"]\n', 'uninstall restores the notifier set since the first install');
});

test('uninstall does not bring back a replaced notifier after the user removed the relay line', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.codexConfig, 'notify = ["/usr/bin/old-notifier"]\nmodel = "o3"\n');
  install(config, { ...options(root), agents: 'codex', force: true });
  const installed = fs.readFileSync(p.codexConfig, 'utf8');
  fs.writeFileSync(p.codexConfig, installed.replace(/^notify = \[.*\]\n/m, ''));

  const result = uninstall(config, { scope: 'project', project: root });
  const after = fs.readFileSync(p.codexConfig, 'utf8');
  assert.equal(after, 'model = "o3"\n', `the file keeps the user's removal, got ${JSON.stringify(after)}`);
  assert.equal(result.warnings?.length, 1, `the skipped restore is reported, got ${JSON.stringify(result.warnings)}`);
});

// The managed [otel] block is appended at install; uninstall used to strip all
// leading whitespace from the file and collapse its trailing blank lines, so a
// config.toml that did not start and end exactly the way Tokenwatch would have
// written it never came back byte for byte.
test('install then uninstall returns a config.toml with leading blank lines, comments and a user notify line byte for byte', () => {
  const body = [
    '',
    '',
    '# my Codex settings',
    '   ',
    'model = "o3"   # inline comment',
    'notify = ["/usr/bin/my-notifier", "--flag"]',
    '',
    '[profiles.fast]',
    'model = "o4-mini"'
  ].join('\n');
  const originals = {
    'a trailing newline': `${body}\n`,
    'a trailing blank line': `${body}\n\n`,
    'no trailing newline': body,
    'CRLF line endings': `${body.replaceAll('\n', '\r\n')}\r\n`
  };
  for (const [name, original] of Object.entries(originals)) {
    const root = tempDir();
    const config = testConfig(path.join(root, 'state'));
    const p = paths(root);
    fs.writeFileSync(p.codexConfig, original);
    const record = install(config, { ...options(root), agents: 'codex', force: true });
    assert.ok(record.codex.otelInstalled, `${name}: the managed block was installed`);
    assert.ok(record.codex.priorNotifyLine, `${name}: the user's notifier was displaced`);
    const installed = fs.readFileSync(p.codexConfig, 'utf8');
    assert.ok(installed.startsWith('\n\n# my Codex settings') || installed.startsWith('\r\n\r\n# my Codex settings'),
      `${name}: install keeps the leading lines`);
    uninstall(config, { scope: 'project', project: root });
    assert.equal(fs.readFileSync(p.codexConfig, 'utf8'), original, `${name}: uninstall returns the original bytes`);
  }
});

// With no notify line and no table, the relay is appended at the end of the
// file, and a file without a final newline used to get one it never had.
test('install then uninstall returns a config.toml with no notify line and no final newline byte for byte', () => {
  for (const original of ['model = "o3"', '\n\n# only a comment', 'model = "o3"\n', '']) {
    const root = tempDir();
    const config = testConfig(path.join(root, 'state'));
    const p = paths(root);
    fs.writeFileSync(p.codexConfig, original);
    const record = install(config, { ...options(root), agents: 'codex' });
    assert.ok(record.codex.notifyLine && record.codex.otelInstalled, `${JSON.stringify(original)}: both were installed`);
    uninstall(config, { scope: 'project', project: root });
    const after = fs.readFileSync(p.codexConfig, 'utf8');
    assert.equal(after, original, `${JSON.stringify(original)}: got ${JSON.stringify(after)}`);
  }
});

// A block written by an earlier version sits after the file's trimmed text and
// one blank line. Removing it must still leave the head of the file alone.
test('a managed block written by an earlier version is removed without touching the head of the file', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.codexConfig, 'model = "o3"\n');
  install(config, { ...options(root), agents: 'codex' });
  const block = fs.readFileSync(p.codexConfig, 'utf8').match(/# tokenwatch:v1 begin otel[\s\S]*# tokenwatch:v1 end otel/)[0];
  uninstall(config, { scope: 'project', project: root });
  const head = '\n\n# leading comment\nmodel = "o3"';
  fs.writeFileSync(p.codexConfig, `${head}\n\n${block}\n`);
  const state = { version: 1, installs: { [`project:${identityPath(root)}`]: {
    version: 1, scope: 'project', project: root, agents: ['codex'], paths: p, installedAt: '2026-09-01T00:00:00.000Z',
    codex: { configPath: p.codexConfig, otelInstalled: true }
  } } };
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const result = uninstall(config, { scope: 'project', project: root });
  assert.equal(result.removed, true, `the legacy record is found, got ${JSON.stringify(result)}`);
  assert.equal(fs.readFileSync(p.codexConfig, 'utf8'), `${head}\n`);
});

function listStateKeys(config) {
  return Object.keys(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs);
}

test('a stale installed skill is refreshed by force but a user edit is not clobbered', () => {
  const root = tempDir();
  const config = testConfig(root);
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');

  install(config, options(root, { agents: 'claude' }));
  const bundled = fs.readFileSync(installed, 'utf8');

  // Simulate the bundled skill having moved on since this install: the file on
  // disk is our own older copy, not something the user wrote.
  fs.writeFileSync(installed, `${bundled}\nstale copy\n`, 'utf8');
  const record0 = install(config, options(root, { agents: 'claude', force: true }));
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'force must replace a stale bundled skill');

  assert.ok(record0.claudeSkills.every((entry) => entry.installed));
});

test('a first install does not overwrite a skill file someone already wrote', () => {
  const root = tempDir();
  const config = testConfig(root);
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, 'hand written\n', 'utf8');

  const record = install(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'hand written\n');
  const entry = record.claudeSkills.find((row) => row.name === skill);
  assert.equal(entry.installed, false);
  assert.match(entry.warning, /--force/);
});

test('uninstall leaves a hand-edited skill in place', () => {
  const root = tempDir();
  const config = testConfig(root);
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');

  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(installed, 'hand written\n', 'utf8');
  uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'hand written\n');
});

// A skill `--force` replaces is often a customised one: team notes, internal
// URLs, a repository's own committed copy. Its whole text used to be stored in
// the install record and printed by `install`, so one `install --force` in CI
// put it in the build log. The record now keeps a hash and the path of an
// owner-only backup beside the install record, as it does for settings files
// (intent 18: "hashes and inverse spans, never the file").
const SKILL_POISON = 'TEAM NOTES: deploy key lives at vault/ci-deploy-7f3a';

function skillBackupsDir(config) {
  return path.join(path.dirname(config.installStateFile), 'backups', 'skills');
}

function forceOverHandWrittenSkill(text = `${SKILL_POISON}\n`) {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, text, 'utf8');
  const record = install(config, options(root, { agents: 'claude', force: true }));
  const entry = record.claudeSkills.find((row) => row.name === skill);
  return { root, config, skill, installed, record, entry };
}

test('a skill text replaced by --force is kept in an owner-only backup, never in the install record', () => {
  const { config, installed, record, entry } = forceOverHandWrittenSkill();
  const bundled = fs.readFileSync(installed, 'utf8');
  assert.notEqual(bundled, `${SKILL_POISON}\n`, 'the bundled text replaced the hand-written one');

  assert.doesNotMatch(fs.readFileSync(config.installStateFile, 'utf8'), /TEAM NOTES|vault\/ci-deploy/, 'the record on disk never holds the replaced text');
  assert.doesNotMatch(JSON.stringify(record), /TEAM NOTES|vault\/ci-deploy/, 'nor does the record install returns');
  assert.equal(Object.hasOwn(entry, 'prior'), false, 'no inline prior text');
  assert.equal(entry.priorSha256, crypto.createHash('sha256').update(`${SKILL_POISON}\n`, 'utf8').digest('hex'));

  assert.equal(path.dirname(entry.backup), skillBackupsDir(config), 'the backup sits beside the install record');
  assert.equal(fs.readFileSync(entry.backup, 'utf8'), `${SKILL_POISON}\n`, 'the backup holds the replaced text exactly');
  assert.equal(fs.lstatSync(entry.backup).isFile(), true);
  // Windows keeps the profile ACL and reports 0o666 for what POSIX calls 0o600.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(entry.backup).mode & 0o777, 0o600, 'the backup is owner-only');
    assert.equal(fs.statSync(skillBackupsDir(config)).mode & 0o777, 0o700, 'and so is its directory');
  }
  // Only a skill whose text differed gets a backup: the others were absent.
  assert.equal(fs.readdirSync(skillBackupsDir(config)).length, 1);
});

test('uninstall after a forced install puts the exact replaced skill bytes back and removes the backup', () => {
  // CRLF, no trailing newline, non-ASCII: anything a text round trip could alter.
  const original = `${SKILL_POISON}\r\nnotes für das Team – ✓\r\nlast line`;
  const { root, config, installed, entry } = forceOverHandWrittenSkill(original);
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(result.removed, true);
  assert.equal(result.skillWarnings, undefined, 'a clean restore warns about nothing');
  assert.deepEqual(fs.readFileSync(installed), Buffer.from(original, 'utf8'), 'byte for byte');
  assert.equal(fs.existsSync(entry.backup), false, 'a restored backup is removed');
  assert.deepEqual(fs.readdirSync(skillBackupsDir(config)), []);
});

test('a tampered skill backup is not restored, and uninstall says so', () => {
  const { root, config, installed, entry } = forceOverHandWrittenSkill();
  const bundled = fs.readFileSync(installed, 'utf8');
  fs.writeFileSync(entry.backup, 'something else entirely\n');
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'the current file is left in place, never replaced by a guess');
  assert.equal(result.skillWarnings?.length, 1, JSON.stringify(result.skillWarnings));
  assert.ok(result.skillWarnings[0].includes(installed), result.skillWarnings[0]);
  assert.ok(result.skillWarnings[0].includes(entry.backup), result.skillWarnings[0]);
  assert.match(result.skillWarnings[0], /no longer matches/);
  assert.doesNotMatch(result.skillWarnings[0], /something else|TEAM NOTES/, 'a warning never quotes either text');
  assert.equal(fs.readFileSync(entry.backup, 'utf8'), 'something else entirely\n', 'a backup that was not restored is not deleted');
});

test('a missing skill backup is not restored, and uninstall says so', () => {
  const { root, config, installed, entry } = forceOverHandWrittenSkill();
  const bundled = fs.readFileSync(installed, 'utf8');
  fs.unlinkSync(entry.backup);
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(result.removed, true);
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'the current file is left in place');
  assert.equal(result.skillWarnings?.length, 1, JSON.stringify(result.skillWarnings));
  assert.ok(result.skillWarnings[0].includes(installed), result.skillWarnings[0]);
  assert.match(result.skillWarnings[0], /missing/);
});

test('a force-installed skill edited since keeps the edit, and uninstall names the backup still holding the text it replaced', () => {
  const { root, config, installed, entry } = forceOverHandWrittenSkill();
  fs.writeFileSync(installed, 'edited after install\n');
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'edited after install\n', 'the edit survives');
  assert.equal(fs.readFileSync(entry.backup, 'utf8'), `${SKILL_POISON}\n`, 'the replaced text is not deleted');
  assert.equal(result.skillWarnings?.length, 1, JSON.stringify(result.skillWarnings));
  assert.ok(result.skillWarnings[0].includes(entry.backup), result.skillWarnings[0]);
  assert.doesNotMatch(result.skillWarnings[0], /edited after install\n|TEAM NOTES/);
});

test('a skill backup that is a symbolic link is neither written through nor restored from', { skip: symlinkUnavailable() }, () => {
  const { root, config, installed, entry } = forceOverHandWrittenSkill();
  uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), `${SKILL_POISON}\n`);
  // Plant a link where the next forced install writes the same backup.
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'victim\n');
  fs.symlinkSync(victim, entry.backup);
  const again = install(config, options(root, { agents: 'claude', force: true })).claudeSkills.find((row) => row.name === entry.name);
  assert.equal(again.backup, entry.backup);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim\n', 'the link target is untouched');
  assert.equal(fs.lstatSync(again.backup).isSymbolicLink(), false, 'the link was replaced by the backup itself');
  assert.equal(fs.readFileSync(again.backup, 'utf8'), `${SKILL_POISON}\n`);

  // A link planted after install, even to a file with the right text, is not read.
  const lookalike = path.join(root, 'lookalike.txt');
  fs.writeFileSync(lookalike, `${SKILL_POISON}\n`);
  fs.rmSync(again.backup);
  fs.symlinkSync(lookalike, again.backup);
  const bundled = fs.readFileSync(installed, 'utf8');
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'nothing restored through a link');
  assert.equal(result.skillWarnings?.length, 1, JSON.stringify(result.skillWarnings));
  assert.equal(fs.readFileSync(lookalike, 'utf8'), `${SKILL_POISON}\n`, 'and nothing deleted through it');
});

// A forced reinstall tears the skills down before it writes them again, through
// the same restore uninstall uses. A backup it cannot restore from is reported
// by the reinstall too, on stderr as `WARN skills:`, not only by uninstall.
test('a forced reinstall that cannot restore a replaced skill says so on stderr', () => {
  const { root, installed, entry } = forceOverHandWrittenSkill();
  fs.writeFileSync(entry.backup, 'something else entirely\n');
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const again = spawnSync(process.execPath, [cli, 'install', '--agents', 'claude', '--force', '--scope', 'project', '--project', root,
    '--claude-settings', paths(root).claudeSettings, '--claude-skills', paths(root).claudeSkills], {
    encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: path.join(root, 'state') }
  });
  assert.equal(again.status, 0, again.stderr);
  const warnings = again.stderr.split('\n').filter((line) => line.startsWith('WARN skills: '));
  assert.equal(warnings.length, 1, again.stderr);
  assert.ok(warnings[0].includes(installed) && warnings[0].includes(entry.backup), warnings[0]);
  assert.match(warnings[0], /no longer matches the text it replaced/);
  assert.doesNotMatch(again.stderr, /something else|TEAM NOTES/, 'a warning never quotes either text');
  assert.deepEqual(JSON.parse(again.stdout).skillWarnings, [warnings[0].slice('WARN skills: '.length)]);
});

test('a forced reinstall that cannot restore a replaced shared skill reports it too', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const skill = bundledSkills()[0];
  const installed = path.join(paths(root).sharedSkills, skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, `${SKILL_POISON}\n`);
  const entry = install(config, options(root, { agents: 'codex', force: true })).sharedSkills.find((row) => row.name === skill);
  fs.unlinkSync(entry.backup);
  const again = install(config, options(root, { agents: 'codex', force: true }));
  assert.equal(again.skillWarnings?.length, 1, JSON.stringify(again.skillWarnings));
  assert.ok(again.skillWarnings[0].includes(installed) && again.skillWarnings[0].includes(entry.backup), again.skillWarnings[0]);
  assert.match(again.skillWarnings[0], /is missing/);
});

// A backup is restored only from where Tokenwatch keeps them. A record that
// names a file elsewhere, even one holding exactly the text it replaced, is
// never read or deleted: an install record is data, and whoever can write it
// could otherwise make uninstall copy any file into a skill and then remove it.
test('a skill backup named outside the backup directory is neither restored from nor deleted', () => {
  const { root, config, installed, entry } = forceOverHandWrittenSkill();
  const elsewhere = path.join(root, 'elsewhere.md');
  fs.writeFileSync(elsewhere, `${SKILL_POISON}\n`);
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  Object.values(state.installs)[0].claudeSkills.find((row) => row.name === entry.name).backup = elsewhere;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const bundled = fs.readFileSync(installed, 'utf8');
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'nothing restored from outside the backup directory');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), `${SKILL_POISON}\n`, 'and nothing deleted there');
  assert.equal(result.skillWarnings?.length, 1, JSON.stringify(result.skillWarnings));
  assert.match(result.skillWarnings[0], /is not where Tokenwatch keeps skill backups/);
});

// A refused Copilot gets no shared skills of its own, but a Codex installed
// earlier still reads them. A forced Copilot reinstall tears the shared skills
// down and, with Copilot refused again, must put them back for that Codex.
test('a forced reinstall of a refused Copilot keeps the shared skills an installed Codex reads', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  const result = install(config, options(root, { agents: 'copilot', force: true }));
  assert.equal(result.copilot.refused, 'not-object');
  assert.equal(result.sharedSkills?.filter((skill) => skill.installed).length, bundledSkills().length, JSON.stringify(result.sharedSkills));
  for (const name of bundledSkills()) assert.ok(fs.existsSync(path.join(paths(root).sharedSkills, name, 'SKILL.md')), `${name} is still there for Codex`);
  assert.deepEqual(Object.keys(result.skillUsage), ['codex']);
});

test('a skill record written before backups existed still restores its inline prior text', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');
  install(config, options(root, { agents: 'claude' }));
  // Rewrite the entry the way older versions saved it: the replaced text inline.
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const entry = Object.values(state.installs)[0].claudeSkills.find((row) => row.name === skill);
  entry.prior = 'legacy hand-written text\n';
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(result.removed, true);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'legacy hand-written text\n');
});

test('a skill that already held the bundled text is left in place by uninstall, with no backup made', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const skill = bundledSkills()[0];
  const installed = path.join(root, 'claude-skills', skill, 'SKILL.md');
  const bundled = fs.readFileSync(fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url)), 'utf8');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, bundled, 'utf8');
  const record = install(config, options(root, { agents: 'claude' }));
  const entry = record.claudeSkills.find((row) => row.name === skill);
  assert.equal(entry.backup, undefined);
  assert.equal(fs.existsSync(skillBackupsDir(config)), false, 'no backup of text Tokenwatch ships');
  const result = uninstall(config, options(root, { agents: 'claude' }));
  assert.equal(fs.readFileSync(installed, 'utf8'), bundled, 'it was there before install, so it stays');
  assert.equal(result.skillWarnings, undefined, 'and nothing is missing, so nothing is reported');
});

// Copilot CLI reads `statusLine.command` as a string and spawns it with the
// status object on stdin; `type` is Claude's shape and Copilot ignores it.
test('the Copilot status line is written where Copilot reads it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const record = install(config, options(root));

  const settings = JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8'));
  assert.equal(typeof settings.statusLine.command, 'string');
  assert.match(settings.statusLine.command, /status.+--agent.+copilot.+--ingest-stdin/);
  assert.equal(settings.statusLine.command, record.copilot.statusCommand);
  uninstall(config, { scope: 'project', project: root });
  // Tokenwatch created the file, so uninstall removes it again (intent 18, D2).
  assert.equal(fs.existsSync(p.copilotConfig), false);
});

// The footer item defaults to on, so an explicit opt-out is the only way the
// command runs and prints nothing. Repair it, and put it back on uninstall.
test('an explicit footer opt-out is repaired and restored', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ footer: { showCustom: false, showBranch: true } }));

  install(config, options(root));
  const settings = JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8'));
  assert.equal(settings.footer.showCustom, true);
  assert.equal(settings.footer.showBranch, true, 'unrelated footer settings survive');

  uninstall(config, { scope: 'project', project: root });
  assert.equal(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).footer.showCustom, false);
});

// JSONC, because Copilot writes comments into its own settings file.
test('a settings file with comments is read rather than rejected', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.copilotConfig, '// managed by Copilot CLI\n{ "theme": "dark" }\n');

  install(config, options(root));
  const text = fs.readFileSync(p.copilotConfig, 'utf8');
  const settings = readJsonc(p.copilotConfig);
  assert.equal(settings.theme, 'dark', 'the existing setting survives');
  assert.ok(settings.statusLine.command);
  assert.ok(text.startsWith('// managed by Copilot CLI\n'), 'and so does the comment (intent 18)');
});

// Copilot reads ~/.copilot/settings.json; config.json holds its own app state.
test('the default Copilot path is the settings file, not the app state file', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const record = install(config, { agents: 'copilot', scope: 'project', project: root });

  assert.equal(record.copilot.configPath, path.join(root, '.copilot', 'settings.json'));
  assert.ok(JSON.parse(fs.readFileSync(record.copilot.configPath, 'utf8')).statusLine.command);
  uninstall(config, { scope: 'project', project: root });
});

// Copilot CLI 1.0.85 exposes subagent, compaction, and turn-boundary hooks.
// Without them the Subagents row and the compaction count are dark for Copilot
// however much it actually does.
test('the Copilot hook file covers subagents, compaction, and turn boundaries', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  install(config, options(root));

  const hooks = JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')).hooks;
  for (const event of ['subagentStart', 'subagentStop', 'preCompact', 'agentStop', 'postToolUseFailure']) {
    assert.ok(hooks[event]?.length, `Copilot hook ${event} must be registered`);
  }
  uninstall(config, { scope: 'project', project: root });
});

// A scope holds one record covering every agent, so a per-agent reinstall used
// to tear down the agents it was not asked about: their hooks removed and their
// status lines reverted. Adding an agent later is the documented path.
test('installing one agent leaves the others installed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);

  install(config, { ...options(root), agents: 'claude,copilot' });
  const claudeBefore = JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8'));
  const copilotBefore = JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8'));
  assert.ok(claudeBefore.statusLine.command);
  assert.ok(fs.existsSync(p.copilotHooks));

  // Add a third agent, the way someone installs Codex after the fact.
  const record = install(config, { ...options(root), agents: 'codex', force: true });

  const claudeAfter = JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8'));
  assert.deepEqual(claudeAfter.statusLine, claudeBefore.statusLine, 'Claude keeps its status line');
  assert.deepEqual(Object.keys(claudeAfter.hooks ?? {}).sort(), Object.keys(claudeBefore.hooks ?? {}).sort(),
    'Claude keeps its hooks');
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).statusLine, copilotBefore.statusLine,
    'Copilot keeps its status line');
  assert.ok(fs.existsSync(p.copilotHooks), 'Copilot keeps its hook file');
  assert.ok(record.codex.configPath, 'and Codex is installed');
  assert.deepEqual([...record.agents].sort(), ['claude', 'codex', 'copilot']);

  // The retained records are what uninstall needs; all three must still go.
  uninstall(config, { scope: 'project', project: root });
  // Both settings files were created by Tokenwatch, so they go entirely (D2).
  assert.equal(fs.existsSync(p.claudeSettings), false);
  assert.equal(fs.existsSync(p.copilotConfig), false);
  assert.ok(!fs.existsSync(p.copilotHooks));
  assert.doesNotMatch(fs.readFileSync(p.codexConfig, 'utf8'), /tokenwatch/);
});

// A free slot in the user settings file says nothing about the project's own
// settings, which Claude Code reads first. On the first Windows install the
// project's shared .claude/settings.json held another tool's status line, and
// install reported success with no hint that its status line would never run.
test('install warns when a higher-precedence project settings file already sets another status line', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const shadowing = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shadowing), { recursive: true });
  fs.writeFileSync(shadowing, JSON.stringify({ statusLine: { type: 'command', command: 'other-statusline --fancy' } }));
  const userOptions = {
    agents: 'claude', scope: 'user', project,
    claudeSettings: path.join(home, '.claude', 'settings.json'), claudeSkills: path.join(home, '.claude', 'skills')
  };

  const record = install(config, userOptions);
  assert.equal(record.claude.statusInstalled, true, 'the user-level slot was free, so it was written');
  assert.ok(record.claude.warning?.includes(shadowing), `the winning file must be named, got: ${record.claude.warning}`);
  assert.doesNotMatch(record.claude.warning, /other-statusline/, 'the other command is never quoted');
  assert.deepEqual(JSON.parse(fs.readFileSync(shadowing, 'utf8')).statusLine.command, 'other-statusline --fancy',
    'the other file is reported, never edited');
  uninstall(config, { scope: 'user' });

  // A project-scope install writes the project-local file, which outranks the
  // shared one, so there is nothing to warn about.
  const local = install(config, { ...userOptions, scope: 'project', claudeSettings: path.join(project, '.claude', 'settings.local.json') });
  assert.equal(local.claude.warning, undefined, `got: ${local.claude.warning}`);
});

// The hooks and status lines Tokenwatch writes embed the path of this CLI, and
// `npm install -g .` from a source folder links to that folder instead of
// copying it. On the first Windows install that folder was in %TEMP%, so every
// agent's hooks pointed into a directory the system was free to empty.
const where = (cliPath, facts) => assessInstallLocation(cliPath, facts);
const ids = (result) => result.findings.map((finding) => finding.id);

test('a CLI inside a temporary directory is warned about, however Windows spells it', () => {
  const windows = { platform: 'win32', tmpdir: 'c:\\users\\me\\appdata\\local\\temp', home: windowsPath('Users', 'Me') };
  const inTemp = where(windowsPath('Users', 'Me', 'AppData', 'Local', 'Temp', 'agent-tokenwatch', 'bin', 'tokenwatch.mjs'), windows);
  assert.equal(inTemp.status, 'warn', `a drive-letter or case difference must not hide %TEMP%, got ${JSON.stringify(inTemp)}`);
  assert.deepEqual(ids(inTemp), ['temporary']);
  assert.match(inTemp.detail, /npm pack/, 'the warning names the safer command');
  assert.match(inTemp.detail, /npm install -g \.\/agent-tokenwatch-<version>\.tgz/);

  const posix = { platform: 'linux', tmpdir: '/tmp', home: '/home/me' };
  assert.deepEqual(ids(where('/tmp/agent-tokenwatch/bin/tokenwatch.mjs', posix)), ['temporary']);
  assert.deepEqual(ids(where('/var/tmp/src/bin/tokenwatch.mjs', posix)), ['temporary']);
  // macOS: the per-user temp directory once resolved, whatever TMPDIR says.
  const mac = { platform: 'darwin', tmpdir: '/var/folders/xy/abc/T/', home: '/Users/me' };
  assert.deepEqual(ids(where('/private/var/folders/xy/abc/T/agent-tokenwatch/bin/tokenwatch.mjs', mac)), ['temporary']);
});

test('a normal global install location produces no warning', () => {
  const cases = [
    ['/usr/local/lib/node_modules/agent-tokenwatch/bin/tokenwatch.mjs', { platform: 'linux', tmpdir: '/tmp', home: '/home/me' }],
    ['/home/me/.nvm/versions/node/v22.1.0/lib/node_modules/agent-tokenwatch/bin/tokenwatch.mjs', { platform: 'linux', tmpdir: '/tmp', home: '/home/me' }],
    ['/opt/homebrew/lib/node_modules/agent-tokenwatch/bin/tokenwatch.mjs', { platform: 'darwin', tmpdir: '/var/folders/xy/abc/T', home: '/Users/me' }],
    [windowsPath('Users', 'Me', 'AppData', 'Roaming', 'npm', 'node_modules', 'agent-tokenwatch', 'bin', 'tokenwatch.mjs'),
      { platform: 'win32', tmpdir: windowsPath('Users', 'Me', 'AppData', 'Local', 'Temp'), home: windowsPath('Users', 'Me') }],
    // Near misses: a sibling that only shares a prefix is not inside the folder.
    ['/tmpfs-mirror/lib/node_modules/agent-tokenwatch/bin/tokenwatch.mjs', { platform: 'linux', tmpdir: '/tmp', home: '/home/me' }],
    [windowsPath('Users', 'Me', 'Downloads-archive', 'npm', 'agent-tokenwatch', 'bin', 'tokenwatch.mjs'),
      { platform: 'win32', tmpdir: windowsPath('Users', 'Me', 'AppData', 'Local', 'Temp'), home: windowsPath('Users', 'Me') }]
  ];
  for (const [cliPath, facts] of cases) {
    const result = where(cliPath, facts);
    assert.equal(result.status, 'ok', `${cliPath} is a durable location, got ${JSON.stringify(result.findings)}`);
    assert.deepEqual(result.findings, []);
  }
});

// A TMPDIR pointed at a folder that holds the home directory would otherwise
// make every install on the machine look temporary.
test('a temp directory that contains the home directory does not mark everything temporary', () => {
  const result = where('/home/me/.local/lib/node_modules/agent-tokenwatch/bin/tokenwatch.mjs',
    { platform: 'linux', tmpdir: '/home', home: '/home/me' });
  assert.equal(result.status, 'ok', `got ${JSON.stringify(result.findings)}`);
});

test('a download folder or a linked package is warned about, while a checkout is only noted', () => {
  const windows = { platform: 'win32', tmpdir: windowsPath('Users', 'Me', 'AppData', 'Local', 'Temp'), home: windowsPath('Users', 'Me') };
  const downloaded = where(windowsPath('users', 'me', 'downloads', 'agent-tokenwatch-0.1.0', 'agent-tokenwatch', 'bin', 'tokenwatch.mjs'), windows);
  assert.deepEqual(ids(downloaded), ['downloads'], `got ${JSON.stringify(downloaded)}`);
  assert.equal(downloaded.status, 'warn');

  // The maintainer develops from a checkout: legitimate, so never above info.
  const checkout = where('/home/me/src/agent-tokenwatch/bin/tokenwatch.mjs',
    { platform: 'linux', tmpdir: '/tmp', home: '/home/me', gitCheckout: '/home/me/src/agent-tokenwatch' });
  assert.deepEqual(ids(checkout), ['git-checkout']);
  assert.equal(checkout.status, 'info', 'a checkout is noted, not warned about');
  assert.doesNotMatch(checkout.detail, /npm pack/, 'and it is not told to reinstall');

  const linked = where('/home/me/src/agent-tokenwatch/bin/tokenwatch.mjs',
    { platform: 'linux', tmpdir: '/tmp', home: '/home/me', linkedVia: '/usr/local/lib/node_modules/agent-tokenwatch' });
  assert.equal(linked.status, 'warn', 'a linked package folder is fragile wherever it points');
  assert.deepEqual(ids(linked), ['linked']);
});

// The whole failure, reproduced: a source folder in the temp directory,
// installed as a link the way `npm install -g .` does, then used to install.
// A junction on Windows is what npm creates there, and needs no privilege.
test('a CLI reached through a linked folder in a temp directory is warned about at install time and in doctor', () => {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const root = tempDir();
  const source = path.join(root, 'source');
  for (const part of ['bin', 'src', 'skills', 'package.json']) {
    fs.cpSync(path.join(repo, part), path.join(source, part), { recursive: true });
  }
  const linked = path.join(root, 'global', 'node_modules', 'agent-tokenwatch');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(source, linked, 'junction');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = { ...process.env, TOKENWATCH_HOME: path.join(root, 'home') };
  const run = (...args) => spawnSync(process.execPath, [path.join(linked, 'bin', 'tokenwatch.mjs'), ...args], { encoding: 'utf8', env });

  const installed = run('install', '--agents', 'claude', '--scope', 'project', '--project', project);
  assert.equal(installed.status, 0, installed.stderr);
  const record = JSON.parse(installed.stdout);
  assert.equal(record.installLocation?.status, 'warn', `got ${JSON.stringify(record.installLocation)}`);
  assert.deepEqual(ids(record.installLocation).sort(), ['linked', 'temporary']);
  assert.match(installed.stderr, /WARN install-location: .*npm pack/, 'the warning is printed, not only buried in JSON');
  assert.ok(record.installLocation.detail.endsWith(`re-run \`tokenwatch install --agents claude --scope project --project "${project}" --force\` from that copy.`),
    `the reinstall is this install's own: ${record.installLocation.detail}`);

  // Not part of what uninstall needs, so not saved with the install record.
  const state = JSON.parse(fs.readFileSync(path.join(root, 'home', 'install-state.json'), 'utf8'));
  assert.equal(Object.values(state.installs)[0].installLocation, undefined);

  const doctor = run('doctor', '--json');
  const running = JSON.parse(doctor.stdout).checks.find((check) => check.id === 'install-location');
  assert.equal(running?.status, 'warn', `doctor run through the link, got ${JSON.stringify(running)}`);
  assert.match(running.detail, /reached through a link/);
  assert.match(running.detail, /temporary directory/);

  // Doctor run from anywhere else still judges where the recorded hooks point.
  const config = testConfig(path.join(root, 'home'));
  const recorded = runDoctor(config, config.installStateFile).checks.filter((check) => check.id.endsWith(':install-location'));
  assert.equal(recorded.length, 1, `got ${JSON.stringify(recorded)}`);
  assert.equal(recorded[0].status, 'warn');
  assert.match(recorded[0].detail, /temporary directory/);
});

// Copilot's `preToolUse` is fail-closed: "a crash or non-zero exit denies the
// tool call" (https://docs.github.com/en/copilot/reference/hooks-reference).
// On Windows the hook did not parse in PowerShell, so every tool call Copilot
// tried was denied. Tokenwatch observes and never decides, so no agent may
// register an event whose failure blocks it - checked against what install
// actually writes, not against the constants that feed it.
test('no agent registers a hook event that fails closed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  install(config, options(root));

  assert.deepEqual(Object.keys(FAIL_CLOSED_HOOK_EVENTS).sort(), [...AGENTS].sort(),
    `every agent needs a decided fail-closed list, got ${Object.keys(FAIL_CLOSED_HOOK_EVENTS).join(', ')}`);
  const registered = {
    claude: Object.keys(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).hooks ?? {}),
    copilot: Object.keys(JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')).hooks ?? {}),
    // Codex gets a `notify` program and an [otel] block, and no hook events.
    codex: [...fs.readFileSync(p.codexConfig, 'utf8').matchAll(/^\[hooks[.\]]/gm)].map((match) => match[0])
  };
  for (const agent of AGENTS) {
    assert.ok(agent === 'codex' || registered[agent].length > 0, `${agent} registered no hooks at all`);
    const blocking = registered[agent].filter((eventName) => FAIL_CLOSED_HOOK_EVENTS[agent].includes(eventName));
    assert.deepEqual(blocking, [], `${agent} registers fail-closed hook events: ${blocking.join(', ')}`);
  }
  uninstall(config, { scope: 'project', project: root });
});

// A single cross-platform `command` string cannot be right for both shells:
// PowerShell needs the `&` call operator before a quoted path, and Bash would
// run `&` as "background the previous command". The hook reference runs `bash`
// on POSIX and `powershell` on Windows, so both are written, with the
// documented `timeoutSec`.
test('each Copilot hook carries a Bash and a PowerShell command instead of one cross-platform string', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  install(config, options(root));

  const hooks = JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')).hooks;
  for (const [eventName, entries] of Object.entries(hooks)) {
    assert.equal(entries.length, 1, `${eventName}: one entry, got ${entries.length}`);
    const [entry] = entries;
    assert.equal(entry.type, 'command');
    assert.equal(entry.command, undefined, `${eventName} still writes a cross-platform command: ${entry.command}`);
    assert.match(entry.bash, new RegExp(`'hook' 'copilot' '${eventName}'$`), `${eventName} bash: ${entry.bash}`);
    assert.match(entry.powershell, new RegExp(`^& '.*' 'hook' 'copilot' '${eventName}'$`), `${eventName} powershell: ${entry.powershell}`);
    assert.equal(entry.timeoutSec, 5, `${eventName} timeoutSec: ${entry.timeoutSec}`);
  }
  uninstall(config, { scope: 'project', project: root });
});

// The file an older version wrote registered `preToolUse`. Declining to touch
// it because it "already exists" - which is what happens when the install
// record is gone but the file is not, or when the first install ran from a
// temporary folder - would keep the hook that denied every tool call, however
// often the user reinstalled.
test('an older Tokenwatch hook file is rewritten without preToolUse rather than preserved', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const userScope = { ...p, agents: 'copilot', scope: 'user' };
  const legacyCommand = (eventName) => `"C:\\Users\\someone\\AppData\\Local\\Temp\\tw\\node.exe" "C:\\Users\\someone\\AppData\\Local\\Temp\\tw\\bin\\tokenwatch.mjs" "hook" "copilot" "${eventName}"`;
  const legacy = { version: 1, hooks: Object.fromEntries(['sessionStart', 'preToolUse', 'postToolUse'].map((eventName) =>
    [eventName, [{ type: 'command', command: legacyCommand(eventName), timeout: 5 }]])) };
  fs.mkdirSync(path.dirname(p.copilotHooks), { recursive: true });
  fs.writeFileSync(p.copilotHooks, JSON.stringify(legacy));

  const record = install(config, userScope);
  const hooks = JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')).hooks;
  assert.equal(hooks.preToolUse, undefined, 'the fail-closed hook from the older file survived the reinstall');
  assert.ok(hooks.postToolUse?.[0]?.powershell, 'the file was rewritten in the current form');
  assert.equal(record.copilot.priorHooks, undefined, 'our own older file must not become the file uninstall restores');

  uninstall(config, userScope);
  assert.equal(fs.existsSync(p.copilotHooks), false, 'uninstall removes the file rather than bringing the old one back');
});

// A hook file this project did not write is still somebody else's, and stays
// untouched without --force exactly as before.
test('a foreign Copilot hook file is still left alone without force', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const foreign = { version: 1, hooks: { preToolUse: [{ type: 'command', bash: './policy.sh', powershell: '.\\policy.ps1' }] } };
  fs.mkdirSync(path.dirname(p.copilotHooks), { recursive: true });
  fs.writeFileSync(p.copilotHooks, JSON.stringify(foreign));

  const record = install(config, { ...options(root), agents: 'copilot' });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')), foreign);
  assert.match(record.copilot.warning, /already exists and was not overwritten/, `warning: ${record.copilot.warning}`);
  uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')), foreign);
});

// A project-scope hook file can arrive with a clone. One written by somebody
// else's Tokenwatch, pointing at their machine, is still their file: it is left
// alone without --force, and restored exactly on uninstall after --force.
test('a cloned project hook file from another Tokenwatch installation is not taken over', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const theirs = { version: 1, hooks: { sessionStart: [{ type: 'command',
    command: `'/home/colleague/node' '/home/colleague/tw/bin/tokenwatch.mjs' 'hook' 'copilot' 'sessionStart'`, timeout: 5 }] } };
  fs.mkdirSync(path.dirname(p.copilotHooks), { recursive: true });
  fs.writeFileSync(p.copilotHooks, JSON.stringify(theirs));

  const record = install(config, { ...options(root), agents: 'copilot' });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')), theirs);
  assert.match(record.copilot.warning, /already exists and was not overwritten/, `warning: ${record.copilot.warning}`);
  uninstall(config, { scope: 'project', project: root });

  install(config, { ...options(root), agents: 'copilot', force: true });
  uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')), theirs, 'their file comes back exactly');
});

// Install records outlive the version that wrote them. One written before this
// change names the older hook file by its hash; `install --force` must replace
// that file, and uninstall must still reverse the record exactly - including a
// record that kept one of our own older files as the "prior" one to restore,
// which would otherwise bring `preToolUse` back on uninstall.
test('reinstall and uninstall reverse a Copilot install recorded by an older version', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const userScope = { ...p, agents: 'copilot', scope: 'user' };
  const oldCommand = (eventName) => `'/opt/old/node' '/opt/old/bin/tokenwatch.mjs' 'hook' 'copilot' '${eventName}'`;
  const oldFile = (events) => ({ version: 1, hooks: Object.fromEntries(events.map((eventName) =>
    [eventName, [{ type: 'command', command: oldCommand(eventName), timeout: 5 }]])) });
  const written = oldFile(['sessionStart', 'preToolUse', 'postToolUse']);
  const oldStatus = `'/opt/old/node' '/opt/old/bin/tokenwatch.mjs' 'status' '--agent' 'copilot' '--ingest-stdin'`;
  const settings = { theme: 'dark' };
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ ...settings, statusLine: { command: oldStatus } }));
  fs.mkdirSync(path.dirname(p.copilotHooks), { recursive: true });
  fs.writeFileSync(p.copilotHooks, JSON.stringify(written));
  // A real install supplies the record's key and envelope; only the Copilot
  // part is replaced with what an older version wrote.
  install(config, { ...userScope, force: true });
  const current = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const [key] = Object.keys(current.installs);
  const olderRecord = () => ({
    ...current.installs[key],
    copilot: {
      configPath: p.copilotConfig, hooksPath: p.copilotHooks, hooksCreated: true,
      hooksHash: crypto.createHash('sha256').update(JSON.stringify(written)).digest('hex'),
      statusInstalled: true, statusCommand: oldStatus,
      priorHooks: oldFile(['preToolUse'])
    }
  });
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ ...settings, statusLine: { command: oldStatus } }));
  fs.writeFileSync(p.copilotHooks, JSON.stringify(written));
  fs.writeFileSync(config.installStateFile, JSON.stringify({ ...current, installs: { [key]: olderRecord() } }));

  // Plain uninstall of the older record: the file goes, and our own older
  // "prior" file is not written back in its place.
  uninstall(config, userScope);
  assert.equal(fs.existsSync(p.copilotHooks), false,
    `uninstall restored ${fs.existsSync(p.copilotHooks) ? fs.readFileSync(p.copilotHooks, 'utf8') : ''}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')), settings);

  // Same older state, reinstalled over instead of removed.
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ ...settings, statusLine: { command: oldStatus } }));
  fs.writeFileSync(p.copilotHooks, JSON.stringify(written));
  fs.writeFileSync(config.installStateFile, JSON.stringify({ ...current, installs: { [key]: olderRecord() } }));
  install(config, { ...userScope, force: true });
  const hooks = JSON.parse(fs.readFileSync(p.copilotHooks, 'utf8')).hooks;
  assert.equal(hooks.preToolUse, undefined, `reinstall kept preToolUse: ${JSON.stringify(hooks.preToolUse)}`);
  assert.ok(hooks.sessionStart[0].bash && hooks.sessionStart[0].powershell);
  uninstall(config, userScope);
  assert.equal(fs.existsSync(p.copilotHooks), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')), settings);
});

// ---- Intent 04: install --compose ------------------------------------------
test('a composed install keeps the existing status line, runs it beside Tokenwatch\'s, and uninstall restores it exactly', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const priorClaude = { type: 'command', command: 'my-claude-status --x', refreshInterval: 5 };
  const priorCopilot = { command: 'my-copilot-status', extra: true };
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: priorClaude, other: 1 }));
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ statusLine: priorCopilot }));
  const before = { claude: fs.readFileSync(p.claudeSettings), copilot: fs.readFileSync(p.copilotConfig) };

  const record = install(config, options(root, { agents: 'claude,copilot', compose: true }));
  const key = `project:${root}`;
  const claudeLine = JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine;
  const copilotLine = JSON.parse(fs.readFileSync(p.copilotConfig, 'utf8')).statusLine;
  for (const [agent, line, prior] of [['claude', claudeLine, priorClaude], ['copilot', copilotLine, priorCopilot]]) {
    assert.equal(record[agent].statusInstalled, true, `${agent}: composed`);
    assert.match(line.command, /tokenwatch/i);
    assert.ok(line.command.includes('--compose'), `${agent}: the installed command composes`);
    assert.equal(record[agent].statusCommand, line.command, `${agent}: uninstall compares against exactly this`);
    assert.equal(record[agent].compose[0].command, prior.command);
    assert.equal(record[agent].compose[0].level, 'target');
    assert.equal(record[agent].compose[0].sha256, crypto.createHash('sha256').update(prior.command).digest('hex'));
    assert.ok(['posix', 'cmd', 'bash', 'powershell'].includes(record[agent].compose[0].shell));
    assert.deepEqual(record[agent].priorStatusLine, prior);
    assert.equal(record[agent].warning, undefined, `${agent}: ${record[agent].warning}`);
    assert.deepEqual(composedStatusCommand(config, key, agent)?.map((spec) => spec.command), [prior.command], `${agent}: the render path resolves it`);
  }
  assert.equal(claudeLine.refreshInterval, 5, 'a refresh timer set for the other line keeps applying (D17)');
  assert.equal(copilotLine.extra, true, 'other Copilot statusLine fields are kept');

  uninstall(config, { scope: 'project', project: root });
  assert.equal(Buffer.compare(fs.readFileSync(p.claudeSettings), before.claude), 0, 'exactly: byte for byte (intent 18)');
  assert.equal(Buffer.compare(fs.readFileSync(p.copilotConfig), before.copilot), 0);
  assert.equal(composedStatusCommand(config, key, 'claude'), null, 'nothing is composable once uninstalled');
});

// Intent 16, D8/D9: a status line in a checkout named agent-tokenwatch used to
// be refused as Tokenwatch's own. It is composed now, and the warning names
// the file without quoting the command.
test('a status line that only mentions tokenwatch is composed, with a warning that quotes nothing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const command = '/home/me/agent-tokenwatch/bin/mystatus.sh --secret-flag';
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command } }));
  const record = install(config, options(root, { agents: 'claude', compose: true }));
  assert.equal(record.claude.compose?.[0]?.command, command);
  assert.match(record.claude.warning, /mentions Tokenwatch but does not run it, so it was composed/);
  assert.ok(record.claude.warning.includes(p.claudeSettings), 'names the file');
  assert.doesNotMatch(record.claude.warning, /mystatus|secret-flag/, 'never the command');
  assert.deepEqual(composedStatusCommand(config, `project:${root}`, 'claude')?.map((spec) => spec.command), [command]);
});

test('composing into a project whose shared settings outrank Tokenwatch writes only the local file and never touches the shared one', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const project = path.join(root, 'project');
  const shared = path.join(project, '.claude', 'settings.json');
  const local = path.join(project, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'acme-bar statusline' } }, null, 2) + '\n');
  const sharedBytes = fs.readFileSync(shared);
  const opts = { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills'), compose: true };

  const record = install(config, opts);
  assert.equal(Buffer.compare(fs.readFileSync(shared), sharedBytes), 0, 'the shared file is only ever read');
  assert.equal(record.claude.compose[0].level, 'project');
  assert.equal(record.claude.compose[0].sourceFile, shared);
  assert.equal(record.claude.compose[0].command, 'acme-bar statusline');
  assert.equal(record.claude.priorStatusLine, undefined, 'nothing was displaced in the file Tokenwatch wrote');
  assert.match(JSON.parse(fs.readFileSync(local, 'utf8')).statusLine.command, /--compose/);
  assert.equal(record.claude.warning, undefined, `the composed line now wins, so there is no shadow warning: ${record.claude.warning}`);

  uninstall(config, { scope: 'project', project });
  assert.equal(Buffer.compare(fs.readFileSync(shared), sharedBytes), 0);
  assert.equal(fs.existsSync(local), false, 'the local file Tokenwatch created is gone, so the shared line wins again');
});

test('compose refuses a status line that already runs Tokenwatch, and says so', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const wrapper = { type: 'command', command: 'bash ~/bin/both.sh # runs tokenwatch status --ingest-stdin' };
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: wrapper }));
  const record = install(config, options(root, { agents: 'claude', compose: true }));
  assert.equal(record.claude.compose, undefined);
  assert.equal(record.claude.statusInstalled, false);
  assert.match(record.claude.warning, /already runs Tokenwatch/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine, wrapper, 'left unchanged');
});

// Intent 16, D1/D2 (SM-01): a taken slot is composed without any flag, the
// first render records a reading, and uninstall gives the file back exactly.
test('a default install into a taken slot composes it, records tokens on the first render, and uninstall restores the file byte for byte', () => {
  const root = tempDir();
  const home = path.join(root, 'state');
  const config = testConfig(home);
  const p = paths(root);
  // Outside the test root: its name contains "tokenwatch", which would make
  // the command only mention Tokenwatch and draw D9's warning.
  const script = path.join(fs.mkdtempSync(path.join(path.dirname(root), 'other-line-')), 'other.mjs');
  fs.writeFileSync(script, "process.stdout.write('OTHER-ROW\\n');\n");
  const other = `"${process.execPath}" "${script}"`;
  fs.writeFileSync(p.claudeSettings, `{\n  "statusLine": ${JSON.stringify({ type: 'command', command: other })}\n}\n`);
  fs.writeFileSync(p.copilotConfig, `{\n  // mine\n  "statusLine": ${JSON.stringify({ command: other })}\n}\n`);
  const before = { claude: fs.readFileSync(p.claudeSettings), copilot: fs.readFileSync(p.copilotConfig) };
  const record = install(config, options(root, { agents: 'claude,copilot' }));
  for (const agent of ['claude', 'copilot']) {
    assert.equal(record[agent].compose?.length, 1, `${agent}: composed without a flag`);
    assert.equal(record[agent].warning, undefined, `${agent}: ${record[agent].warning}`);
  }
  const line = JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command;
  assert.match(line, /--compose/);
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const payload = fs.readFileSync(fileURLToPath(new URL('./fixtures/claude-status-1.json', import.meta.url)));
  const render = spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', `project:${root}`],
    { input: payload, encoding: 'utf8', env: { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_COMPOSED: '', NO_COLOR: '1' } });
  assert.equal(render.status, 0, render.stderr);
  assert.match(render.stdout, /OTHER-ROW/, 'the other line renders');
  assert.ok(fs.readdirSync(path.join(home, 'sessions')).length >= 1, 'the first render recorded a reading');
  uninstall(config, { scope: 'project', project: root });
  assert.equal(Buffer.compare(fs.readFileSync(p.claudeSettings), before.claude), 0);
  assert.equal(Buffer.compare(fs.readFileSync(p.copilotConfig), before.copilot), 0);
});

test('without --compose, a free slot gets no warning, and --force alone hides a taken one on a first install', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const free = install(config, options(root, { agents: 'claude' }));
  assert.equal(free.claude.warning, undefined, 'nothing to compose is said only when --compose was typed');
  uninstall(config, { scope: 'project', project: root });
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'other-status' } }));
  const hidden = install(config, options(root, { agents: 'claude', force: true }));
  assert.equal(hidden.claude.compose, undefined, '--force hides, it does not compose');
  assert.deepEqual(hidden.claude.priorStatusLine, { type: 'command', command: 'other-status' });
  assert.doesNotMatch(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command, /--compose/);
});

// Intent 16, D27: a lower-precedence line that cannot be composed does not
// leave a default install without a status line.
test('a default project install passes over a lower line it cannot compose and installs its own', () => {
  for (const [userLine, warns] of [['/opt/old-checkout/bin/tokenwatch.mjs status --ingest-stdin', false], ['x'.repeat(4097), 'it is longer than 4096 characters'], ['', 'it has no command']]) {
    const root = tempDir();
    const config = testConfig(path.join(root, 'state'));
    const p = paths(root);
    fs.mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: userLine } }));
    const record = install(config, options(root, { agents: 'claude' }));
    assert.equal(record.claude.statusInstalled, true, 'Tokenwatch\'s own line is installed in the free slot');
    assert.equal(record.claude.compose, undefined);
    if (warns) assert.ok(record.claude.warning.includes(`could not be composed (${warns}), so Tokenwatch's own status line was installed`), record.claude.warning);
    else assert.equal(record.claude.warning, undefined, 'another Tokenwatch line below is passed over quietly');
    const explicit = install(testConfig(path.join(root, 'state2')), options(root, { agents: 'claude', compose: true, claudeSettings: path.join(root, 'other.json') }));
    assert.equal(explicit.claude.statusInstalled, false, 'a typed --compose keeps the refusal as the outcome');
  }
});

// Intent 16, D3/D10/D11 (SM-06): install --repair.
function repairOptions(root, extra = {}) {
  // No path options: a repair edits the files the install recorded.
  return { scope: 'project', project: root, homeDir: path.join(root, 'home'), repair: true, ...extra };
}

test('install --repair keeps what it composed, adopts what replaced the slot, and uninstall restores the newest line', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a --line' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b --line' } }));
  const repaired = install(config, repairOptions(root));
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.claude.composeEntryCount, 2);
  assert.deepEqual(repaired.claude.compose.map((entry) => entry.command), ['tool-a --line', 'tool-b --line'], 'A kept, B adopted, in that order');
  assert.equal(repaired.claude.compose[0].carried, true, 'A now lives only in the record');
  assert.equal(repaired.claude.compose[1].carried, undefined);
  assert.equal(repaired.claude.priorStatusLine.command, 'tool-b --line', 'uninstall puts back what the slot held at this repair');
  assert.match(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command, /--compose/);
  assert.deepEqual(composedStatusCommand(config, `project:${root}`, 'claude').map((spec) => spec.command), ['tool-a --line', 'tool-b --line']);
  uninstall(config, { scope: 'project', project: root });
  assert.equal(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command, 'tool-b --line');
});

test('install --repair with nothing to repair writes nothing, and a second repair in a row is a no-op too', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, '{\n  "statusLine": { "type": "command", "command": "tool-a" }\n}\n');
  fs.writeFileSync(p.copilotConfig, '{\n  // mine\n  "statusLine": { "command": "tool-c" }\n}\n');
  install(config, options(root, { agents: 'claude,copilot' }));
  const snapshot = () => [p.claudeSettings, p.copilotConfig, config.installStateFile].map((file) => fs.readFileSync(file));
  const before = snapshot();
  assert.deepEqual(install(config, repairOptions(root)), { repaired: false, reason: 'nothing to repair', key: `project:${root}` });
  snapshot().forEach((bytes, index) => assert.equal(Buffer.compare(bytes, before[index]), 0, `file ${index} unchanged`));
  fs.writeFileSync(p.claudeSettings, '{\n  "statusLine": { "type": "command", "command": "tool-b" }\n}\n');
  assert.equal(install(config, repairOptions(root)).repaired, true);
  const after = snapshot();
  assert.equal(install(config, repairOptions(root)).repaired, false, 'repairing again finds nothing');
  snapshot().forEach((bytes, index) => assert.equal(Buffer.compare(bytes, after[index]), 0));
  // Copilot has no settings chain: only its own slot can show the drift.
  fs.writeFileSync(p.copilotConfig, '{\n  "statusLine": { "command": "tool-d" }\n}\n');
  const copilot = install(config, repairOptions(root));
  assert.equal(copilot.repaired, true, 'a Copilot slot taken over is a repair');
  assert.deepEqual(copilot.copilot.compose.map((entry) => entry.command), ['tool-c', 'tool-d']);
});

test('install --repair needs a previous install, refuses --no-compose, and does not need --force', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  assert.throws(() => install(config, repairOptions(root)), new RegExp(`nothing to repair for project:.*; run tokenwatch install`));
  install(config, options(root, { agents: 'claude' }));
  assert.throws(() => install(config, repairOptions(root, { compose: false })), /--repair composes; --no-compose leaves the slot alone; pass one of them/);
  assert.doesNotThrow(() => install(config, repairOptions(root)), 'no --force needed');
});

test('install --repair refreshes a line taken from a shared file when that file changed, and drops one that is gone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const shared = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'shared-tool --v1' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'shared-tool --v2' } }));
  const refreshed = install(config, repairOptions(root));
  assert.deepEqual(refreshed.claude.compose.map((entry) => [entry.command, entry.level]), [['shared-tool --v2', 'project']]);
  fs.writeFileSync(shared, JSON.stringify({}));
  const dropped = install(config, repairOptions(root));
  assert.equal(dropped.repaired, true);
  assert.equal(dropped.claude.compose, undefined, 'nothing left to compose with');
  assert.equal(dropped.claude.statusInstalled, true, 'Tokenwatch\'s own line stays');
});

test('install --repair keeps at most four lines and says so when a fifth arrives', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-1' } }));
  install(config, options(root, { agents: 'claude' }));
  for (const n of [2, 3, 4]) {
    fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: `tool-${n}` } }));
    install(config, repairOptions(root));
  }
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-5' } }));
  const full = install(config, repairOptions(root));
  assert.deepEqual(full.claude.compose.map((entry) => entry.command), ['tool-1', 'tool-2', 'tool-3', 'tool-4']);
  assert.match(full.claude.warning, /4 other status lines are already composed, which is the most Tokenwatch runs per render; the newest line was not adopted/);
  assert.match(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command, /--compose/, 'the slot is still Tokenwatch\'s');
});

test('--force over a composed install hides it and names the repair that would keep it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  const hidden = install(config, options(root, { agents: 'claude', force: true }));
  assert.equal(hidden.claude.compose, undefined);
  assert.match(hidden.claude.warning, new RegExp(`the previous install composed 1 other status line\\(s\\); --force hides them\\. To keep them, run: tokenwatch install --agents claude --scope project --project ".*" --repair$`));
});

// Intent 16, D16 (SM-08): a repair is something the user asks for. Nothing on
// the agent's own paths writes another tool's settings file.
test('a hook and a composed render never repair, and leave a drifted install exactly as they found it', () => {
  const root = tempDir();
  const home = path.join(root, 'state');
  const config = testConfig(home);
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const before = [p.claudeSettings, config.installStateFile].map((file) => fs.readFileSync(file));
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const env = { ...process.env, TOKENWATCH_HOME: home, TOKENWATCH_COMPOSED: '' };
  const payload = fs.readFileSync(fileURLToPath(new URL('./fixtures/claude-status-1.json', import.meta.url)));
  const hook = spawnSync(process.execPath, [cli, 'hook', 'claude', 'Stop'], { input: JSON.stringify({ session_id: 's-1', hook_event_name: 'Stop' }), env });
  assert.equal(hook.status, 0);
  const render = spawnSync(process.execPath, [cli, 'status', '--agent', 'claude', '--ingest-stdin', '--compose', `project:${root}`], { input: payload, env });
  assert.equal(render.status, 0);
  [p.claudeSettings, config.installStateFile].forEach((file, index) => assert.equal(Buffer.compare(fs.readFileSync(file), before[index]), 0, `${file} unchanged`));
});

// Review H3 (D32): a repair that can act on nothing says so, instead of
// reporting a healthy install.
test('install --repair refuses when no status-line agent is named or recorded, rather than reporting nothing to repair', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const before = [p.claudeSettings, config.installStateFile].map((file) => fs.readFileSync(file));
  assert.throws(() => install(config, repairOptions(root, { agents: 'codex' })), /--repair acts on claude and copilot/);
  [p.claudeSettings, config.installStateFile].forEach((file, index) => assert.equal(Buffer.compare(fs.readFileSync(file), before[index]), 0, `${file} unchanged by the refusal`));
  const codexRoot = tempDir();
  const codexConfig = testConfig(path.join(codexRoot, 'state'));
  install(codexConfig, options(codexRoot, { agents: 'codex' }));
  const codexState = fs.readFileSync(codexConfig.installStateFile);
  assert.throws(() => install(codexConfig, repairOptions(codexRoot)), /none of them is named or recorded for this install/);
  assert.equal(Buffer.compare(fs.readFileSync(codexConfig.installStateFile), codexState), 0);
});

test('install --repair on a record written before paths were kept edits the file that record names', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  delete Object.values(state.installs)[0].paths;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const repaired = install(config, repairOptions(root, { agents: 'claude' }));
  assert.equal(repaired.claude.settingsPath, p.claudeSettings, 'the recorded file, not the default');
  assert.deepEqual(repaired.claude.compose.map((entry) => entry.command), ['tool-a', 'tool-b']);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.local.json')), false, 'the default file is never created');
  // Review 2 (D33): the skills go back where the install put them, too.
  assert.ok(fs.existsSync(path.join(p.claudeSkills, 'tw-explain-statusline', 'SKILL.md')), 'skills in the recorded folder');
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills')), false, 'never in the default folder');
  // Review 3 (D34): and uninstall takes them out of that folder again.
  uninstall(config, { scope: 'project', project: root });
  assert.equal(fs.existsSync(path.join(p.claudeSkills, 'tw-explain-statusline', 'SKILL.md')), false, 'removed from the recorded folder');
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills')), false);
});

test('a repaired record without paths keeps naming Codex\'s own file in its saved paths', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude,codex' }));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  delete Object.values(state.installs)[0].paths;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const repaired = install(config, repairOptions(root, { agents: 'claude' }));
  assert.equal(repaired.paths.codexConfig, repaired.codex.configPath, 'the saved paths and the Codex record agree');
  assert.equal(repaired.paths.codexConfig, p.codexConfig);
});

test('a repair of a record holding the legacy single skill entry finds that skill\'s folder', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const record = Object.values(state.installs)[0];
  delete record.paths;
  // Records written before per-skill arrays held one entry, `claudeSkill`.
  const [first] = record.claudeSkills;
  delete record.claudeSkills;
  record.claudeSkill = first;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  install(config, repairOptions(root, { agents: 'claude' }));
  assert.ok(fs.existsSync(path.join(p.claudeSkills, 'tw-explain-statusline', 'SKILL.md')), 'the legacy entry\'s folder is used');
  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills')), false);
});

test('install --repair on a Copilot record without paths edits the settings and hooks files it names', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ statusLine: { command: 'tool-a' } }));
  install(config, options(root, { agents: 'copilot' }));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  delete Object.values(state.installs)[0].paths;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  fs.writeFileSync(p.copilotConfig, JSON.stringify({ statusLine: { command: 'tool-b' } }));
  const repaired = install(config, repairOptions(root));
  assert.equal(repaired.copilot.configPath, p.copilotConfig);
  assert.equal(repaired.copilot.hooksPath, p.copilotHooks);
  assert.deepEqual(repaired.copilot.compose.map((entry) => entry.command), ['tool-a', 'tool-b']);
  for (const fallback of [path.join(root, '.copilot'), path.join(root, '.github'), path.join(root, '.agents')]) {
    assert.equal(fs.existsSync(fallback), false, `${fallback} is never created`);
  }
});

// D28: a mixed request repairs the agents that have a status line and keeps
// the others' records as they were.
test('install --repair --agents claude,codex repairs Claude and leaves the Codex record alone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  const first = install(config, options(root, { agents: 'claude,codex' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const codexBefore = fs.readFileSync(p.codexConfig);
  const repaired = install(config, repairOptions(root, { agents: 'claude,codex' }));
  assert.deepEqual(repaired.claude.compose.map((entry) => entry.command), ['tool-a', 'tool-b']);
  assert.deepEqual(repaired.codex, first.codex, 'the Codex record is kept as it was');
  assert.equal(Buffer.compare(fs.readFileSync(p.codexConfig), codexBefore), 0, 'and config.toml is untouched');
});

// Review H4 (FR-35): the repair's own refusal path.
test('install --repair keeps what it composed when the new line runs Tokenwatch, and says so without quoting it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a --secret' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: '/opt/other-checkout/bin/tokenwatch.mjs status --ingest-stdin' } }));
  const repaired = install(config, repairOptions(root));
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.claude.compose.map((entry) => entry.command), ['tool-a --secret'], 'the carried line survives; Tokenwatch\'s own is not adopted');
  assert.match(repaired.claude.warning, /was not composed \(it runs Tokenwatch\); the lines composed before are kept/);
  assert.doesNotMatch(repaired.claude.warning, /tool-a|secret|other-checkout/);
  assert.match(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine.command, /--compose/);
});

test('install --repair with --force still repairs rather than hiding (D1)', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-a' } }));
  install(config, options(root, { agents: 'claude' }));
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'tool-b' } }));
  const repaired = install(config, repairOptions(root, { force: true }));
  assert.deepEqual(repaired.claude.compose.map((entry) => entry.command), ['tool-a', 'tool-b']);
});

test('--compose with --force on a first install is refused before anything is written', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
  const before = fs.readFileSync(p.claudeSettings);
  assert.throws(() => install(config, options(root, { agents: 'claude', compose: true, force: true })), /--compose keeps the existing status line and --force hides it/);
  assert.equal(Buffer.compare(fs.readFileSync(p.claudeSettings), before), 0);
  assert.equal(fs.existsSync(config.installStateFile), false, 'no install record either');
});

test('compose with nothing to compose installs the plain status line and says so', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const record = install(config, options(root, { agents: 'claude', compose: true }));
  assert.equal(record.claude.statusInstalled, true);
  assert.equal(record.claude.compose, undefined);
  assert.doesNotMatch(record.claude.statusCommand, /--compose/);
  assert.match(record.claude.warning, /nothing to compose with/);
});

test('reinstalling with --force --compose restores the other line first and composes it afresh', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  const prior = { type: 'command', command: 'mine --v1' };
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: prior }));
  install(config, options(root, { agents: 'claude', compose: true }));
  const again = install(config, options(root, { agents: 'claude', compose: true, force: true }));
  assert.equal(again.claude.compose[0].command, 'mine --v1', 'the restored line is composed again, not the composed one');
  assert.deepEqual(again.claude.priorStatusLine, prior);
  uninstall(config, { scope: 'project', project: root });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, 'utf8')).statusLine, prior);
});

test('a user-scope --compose never adopts one project\'s status line to run in every project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const shared = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'project-only-status' } }));
  const record = install(config, {
    agents: 'claude', scope: 'user', project, compose: true,
    claudeSettings: path.join(home, '.claude', 'settings.json'), claudeSkills: path.join(home, '.claude', 'skills')
  });
  assert.equal(record.claude.compose, undefined, 'a project file is composed only by a project-scope install');
  assert.match(record.claude.warning, /nothing to compose with/);
  assert.ok(record.claude.warning.includes(shared), 'the shadowing project file is still named');
  assert.match(record.claude.warning, /--scope project --project "[^"]*" \(uninstall restores/, 'with the project-scope install, which composes by default (intent 16)');
});

test('a higher-precedence status line that runs Tokenwatch is refused by name, not reported as nothing to compose', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const project = path.join(root, 'project');
  const shared = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/bin/both.sh # tokenwatch status --ingest-stdin' } }));
  const record = install(config, { agents: 'claude', scope: 'project', project, compose: true, homeDir: path.join(root, 'home'),
    claudeSettings: path.join(project, '.claude', 'settings.local.json'), claudeSkills: path.join(project, '.claude', 'skills') });
  assert.equal(record.claude.compose, undefined);
  assert.match(record.claude.warning, /already runs Tokenwatch/);
  assert.doesNotMatch(record.claude.warning, /nothing to compose with/);
});

test('reinstalling --compose over a project-local Tokenwatch line composes nothing new', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const project = path.join(root, 'project');
  const local = path.join(project, '.claude', 'settings.local.json');
  const opts = { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills') };
  install(config, opts);
  const again = install(config, { ...opts, compose: true, force: true });
  assert.equal(again.claude.compose, undefined, 'the target winning with Tokenwatch\'s own line is not a line to compose with');
  assert.match(again.claude.warning, /nothing to compose with/);
});

test('a user-scope Tokenwatch line beneath a project-scope --compose is nothing to compose, not a refusal', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  install(config, { agents: 'claude', scope: 'user', project, claudeSettings: path.join(home, '.claude', 'settings.json'), claudeSkills: path.join(home, '.claude', 'skills') });
  const record = install(config, { agents: 'claude', scope: 'project', project, compose: true, homeDir: home,
    claudeSettings: path.join(project, '.claude', 'settings.local.json'), claudeSkills: path.join(project, '.claude', 'skills') });
  assert.equal(record.claude.statusInstalled, true);
  assert.equal(record.claude.compose, undefined);
  assert.match(record.claude.warning, /nothing to compose with/);
});
