import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeCommands, install, installKey } from '../src/installer.mjs';
import { readRelayRecord, recordRelayOutcome } from '../src/relay-record.mjs';
import { claudeCommandChecks, collectionLiveness, runDoctor } from '../src/doctor.mjs';
import { makeEvent } from '../src/schema.mjs';
import { appendImportedEvents, sessionStateFile, storeEvent } from '../src/store.mjs';
import { markImportRunsUndone, writeImportRun } from '../src/import/runs.mjs';
import { claudeShell } from '../src/spawn.mjs';
import { tempDir, testConfig } from './helpers.mjs';

function installCopilot(root, config) {
  install(config, { ...options(root), agents: 'copilot' });
  return paths(root).copilotHooks;
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

// homeDir pins the user level of Claude Code's settings chain inside the test
// root: a project-scope install walks that chain by default since intent 16.
function options(root, extra = {}) {
  return { agents: 'claude', scope: 'project', project: root, homeDir: path.join(root, 'home'), ...paths(root), ...extra };
}

// A renamed or removed skill whose install-state record fell out of sync -
// which happens to installs that predate per-skill array tracking - leaves a
// stale file on disk that nothing ever revisits. It is still loadable, still
// looks live, and is easy to mistake for the current version of the skill.
test('doctor flags a skill directory the current install record no longer tracks', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  install(config, options(root));

  fs.mkdirSync(path.join(p.claudeSkills, 'status-line-guide'), { recursive: true });
  fs.writeFileSync(path.join(p.claudeSkills, 'status-line-guide', 'SKILL.md'),
    '---\nname: status-line-guide\ndescription: old copy\n---\n\nRun `tokenwatch status --agent claude --json`.\n');

  const report = runDoctor(config, config.installStateFile);
  const orphan = report.checks.find((check) => check.id.endsWith(':claude:orphaned-skill'));
  assert.ok(orphan, 'expected an orphaned-skill warning');
  assert.equal(orphan.status, 'warn');
  assert.match(orphan.detail, /status-line-guide/);
  // A warning does not fail doctor - this is informational, not broken.
  assert.equal(report.ok, true);
});

// A skill someone else put in the same shared folder, that never mentions
// `tokenwatch`, is not ours to flag.
test('doctor does not flag an unrelated skill in the same shared directory', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  install(config, options(root));

  fs.mkdirSync(path.join(p.claudeSkills, 'someones-other-skill'), { recursive: true });
  fs.writeFileSync(path.join(p.claudeSkills, 'someones-other-skill', 'SKILL.md'),
    '---\nname: someones-other-skill\ndescription: unrelated\n---\n\nDoes something else entirely.\n');

  const report = runDoctor(config, config.installStateFile);
  assert.equal(report.checks.some((check) => check.id.endsWith(':claude:orphaned-skill')), false);
});

// Once the current bundle's skills are installed and tracked, they are not
// orphans of themselves.
test('doctor does not flag the currently installed, tracked skills', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root));

  const report = runDoctor(config, config.installStateFile);
  assert.equal(report.checks.some((check) => check.id.endsWith('orphaned-skill')), false);
});

// Codex reads repository skills from `.agents/skills` under the project and
// user skills from `$HOME/.agents/skills`. Skills redirected anywhere else with
// `--shared-skills` were on disk, `doctor` was green, and `/skills` in Codex
// listed none of them.
test('doctor warns when shared skills sit where Codex does not look, and confirms them where it does', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const misplaced = runDoctor(config, config.installStateFile).checks
    .find((check) => check.id.endsWith(':shared-skills:location'));
  assert.equal(misplaced?.status, 'warn', `expected a location warning, got ${JSON.stringify(misplaced)}`);
  assert.match(misplaced.detail, /agents-skills/);
  assert.ok(misplaced.detail.includes(path.join(root, '.agents', 'skills')), misplaced.detail);

  const other = tempDir();
  const otherConfig = testConfig(path.join(other, 'state'));
  install(otherConfig, options(other, { agents: 'codex', sharedSkills: path.join(other, '.agents', 'skills') }));
  const checks = runDoctor(otherConfig, otherConfig.installStateFile).checks;
  assert.equal(checks.some((check) => check.id.endsWith(':shared-skills:location')), false,
    `no location warning expected, got ${checks.filter((check) => check.status === 'warn').map((check) => check.id).join(', ')}`);
  const healthy = checks.find((check) => check.id.endsWith(':shared-skills'));
  assert.equal(healthy?.status, 'ok');
  assert.match(healthy.detail, /\$tw-<name>/, 'the Codex invocation is Codex\'s own syntax');
  assert.match(healthy.detail, /\/skills/);
});

// Codex skips a SKILL.md it cannot parse and the session only shows a shorter
// list. A byte-order mark is enough: Codex's frontmatter check trims the first
// line with Rust's `trim()`, which keeps U+FEFF (observed with codex-cli 0.154.0).
// The file is the user's to fix; doctor says so and changes nothing.
test('doctor warns about a shared skill Codex would skip, and leaves the file alone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const shared = path.join(root, '.agents', 'skills');
  install(config, options(root, { agents: 'codex', sharedSkills: shared }));
  const file = path.join(shared, 'tw-retrospective-this-session', 'SKILL.md');
  const edited = `﻿${fs.readFileSync(file, 'utf8')}`;
  fs.writeFileSync(file, edited);

  const report = runDoctor(config, config.installStateFile);
  const skipped = report.checks.find((check) => check.id.endsWith(':tw-retrospective-this-session:codex'));
  assert.equal(skipped?.status, 'warn', `expected a Codex parse warning, got ${JSON.stringify(skipped)}`);
  assert.match(skipped.detail, /byte-order mark/);
  assert.equal(report.checks.some((check) => check.id.endsWith(':shared-skills')), false,
    'a set with a skill Codex skips is not reported healthy');
  assert.equal(fs.readFileSync(file, 'utf8'), edited, 'doctor never rewrites a skill');
  assert.equal(report.ok, true);
});

// A Windows checkout or editor can leave CRLF line endings. Codex splits lines
// with Rust's `lines()`, which drops the `\r`, so such a file loads; reporting
// it as broken would send a Windows user chasing a problem they do not have.
test('a shared skill saved with Windows line endings is not reported as one Codex would skip', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const shared = path.join(root, '.agents', 'skills');
  install(config, options(root, { agents: 'codex', sharedSkills: shared }));
  const file = path.join(shared, 'tw-cost-drivers-basics', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));

  const report = runDoctor(config, config.installStateFile);
  const flagged = report.checks.filter((check) => check.id.includes(':shared:') && check.id.endsWith(':codex'));
  assert.deepEqual(flagged, [], `CRLF must not read as unparseable: ${JSON.stringify(flagged)}`);
});

// The collection checks judge an install against the time it was made, so the
// record's real install time is replaced with a literal and every check below
// runs at a fixed `now`. Nothing here depends on the wall clock.
function backdateInstalls(config, installedAt) {
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  for (const record of Object.values(state.installs)) record.installedAt = installedAt;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
}

function hook(agent, eventName, ts, sessionId = 'session-1') {
  return makeEvent({ agent, source: 'hook', kind: 'lifecycle', event_name: eventName, session_id: sessionId, ts });
}

function statusSample(ts, sessionId = 'session-1') {
  return makeEvent({
    agent: 'claude', source: 'statusline', kind: 'usage', event_name: 'status', session_id: sessionId, ts,
    usage: { input_total: 8000, output: 900, semantics: 'components', basis: 'sample' },
    cost: { cumulative_usd: 1.5, basis: 'provider_reported', currency: 'USD' }
  });
}

function codexTurn(ts) {
  return makeEvent({ agent: 'codex', source: 'notify', kind: 'lifecycle', event_name: 'agent-turn-complete', session_id: 'codex-1', ts });
}

// A user-scope Claude install into a scratch home, used from a scratch project.
// `projectDir` and `homeDir` are passed to doctor explicitly, so neither this
// machine's own ~/.claude nor the directory the tests run in is ever read.
function userScopeClaude(root) {
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  return {
    home,
    project,
    options: {
      agents: 'claude', scope: 'user', project,
      claudeSettings: path.join(home, '.claude', 'settings.json'),
      claudeSkills: path.join(home, '.claude', 'skills')
    }
  };
}

const check = (report, id) => report.checks.find((entry) => entry.id === id);

// The install key a project record is filed under, and so the prefix of every
// check doctor emits for it, by install's own rule. On Windows that rule
// case-folds the path, so one project reached by two spellings is one record;
// the path as the test spelled it is not the key there.
const projectKey = (dir) => installKey('project', dir);

// The first Windows install, replayed: a project's shared settings file carried
// another tool's status line, which outranks the user file Tokenwatch installed
// into. Hooks kept firing - 15 events, 0 turns - so the ledger looked alive,
// and doctor printed nothing but OK while no token or cost was recorded.
test('a project status line that outranks Tokenwatch is a collection warning naming the file that wins', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  const shadowing = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shadowing), { recursive: true });
  fs.writeFileSync(shadowing, JSON.stringify({
    statusLine: { type: 'command', command: 'node C:\\tools\\acme-bar\\statusline.mjs' }
  }));
  install(config, installOptions);
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  const names = ['SessionStart', 'UserPromptSubmit', 'Stop'];
  for (let minute = 0; minute < 15; minute += 1) {
    storeEvent(hook('claude', names[minute % 3], `2026-09-23T09:${String(minute).padStart(2, '0')}:00.000Z`), config);
  }

  const report = runDoctor(config, config.installStateFile,
    { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home });
  const collection = check(report, 'collection:claude');
  assert.equal(collection?.status, 'warn', `collection was ${JSON.stringify(collection)}`);
  assert.match(collection.detail, /15 hook events but 0 status-line samples/);
  assert.match(collection.detail, / Run: tokenwatch install --agents claude --repair$/, 'the collection finding names the repair (intent 16, D12)');
  const shadow = check(report, 'user:claude-status-line');
  assert.equal(shadow?.status, 'warn', `the status-line check was ${JSON.stringify(shadow)}`);
  assert.ok(shadow.detail.includes(shadowing), `the winning file must be named, got: ${shadow.detail}`);
  assert.ok(shadow.detail.includes(`tokenwatch install --agents claude --scope project --project "${project}" (uninstall`),
    'a user-scope install has no project record to repair: the remedy is the project install, which composes by default');
  assert.doesNotMatch(shadow.detail, /acme-bar/, 'the other tool\'s command is never quoted');
  assert.equal(report.ok, true, 'a warning is not a failed install');
});

// Intent 16, D12: a project install whose own line no longer wins is repaired,
// not reinstalled.
test('doctor names the repair when a project install\'s own status line no longer wins', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { project, shared, local } = composedProject(root);
  fs.writeFileSync(shared, JSON.stringify({}));
  install(config, { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills') });
  const settings = JSON.parse(fs.readFileSync(local, 'utf8'));
  delete settings.statusLine;
  fs.writeFileSync(local, JSON.stringify(settings));
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'late-tool --secret' } }));
  const shadow = check(runDoctor(config, config.installStateFile, { projectDir: project, homeDir: path.join(root, 'home') }), `${projectKey(project)}:claude-status-line`);
  assert.equal(shadow?.status, 'warn', JSON.stringify(shadow));
  assert.ok(shadow.detail.includes(`To run both in that project: tokenwatch install --agents claude --scope project --project "${project}" --repair (uninstall`), shadow.detail);
  assert.doesNotMatch(shadow.detail, /late-tool|secret/);
});

// With no status line anywhere, the remedy is a forced reinstall of the
// record's own scope, in the `Run:` form the status-line skill looks for. It
// used to be a flat user-scope `Reinstall with:`, which on a project record
// reinstalls a different settings file.
test('with no status line set anywhere, doctor names the reinstall for the install\'s own scope after Run:', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const home = path.join(root, 'home');
  install(config, options(root));
  const file = paths(root).claudeSettings;
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.statusLine;
  fs.writeFileSync(file, JSON.stringify(settings));
  const project = check(runDoctor(config, config.installStateFile, { projectDir: root, homeDir: home }), `${projectKey(root)}:claude-status-line`);
  assert.equal(project?.status, 'warn', JSON.stringify(project));
  assert.ok(project.detail.endsWith(`Run: tokenwatch install --agents claude --scope project --project "${root}" --force`), project.detail);
  assert.doesNotMatch(project.detail, /Reinstall with/);

  const userRoot = tempDir();
  const userConfig = testConfig(path.join(userRoot, 'state'));
  const { home: userHome, project: userProject, options: userOptions } = userScopeClaude(userRoot);
  install(userConfig, userOptions);
  const userFile = userOptions.claudeSettings;
  const userSettings = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  delete userSettings.statusLine;
  fs.writeFileSync(userFile, JSON.stringify(userSettings));
  const user = check(runDoctor(userConfig, userConfig.installStateFile, { projectDir: userProject, homeDir: userHome }), 'user:claude-status-line');
  assert.equal(user?.status, 'warn', JSON.stringify(user));
  assert.ok(user.detail.endsWith('Run: tokenwatch install --agents claude --force'), user.detail);
});

// Owner decision (option B): a settings file refused at install is saved as
// refused, and doctor reports it, naming the file, the reason and the command
// for the record's scope, instead of leaving the gap to look like a quiet agent.
test('doctor reports a settings file refused at install, naming the file, the reason and the command for its scope', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{ "model": "sonnet", }\n');
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  install(config, options(root, { agents: 'claude,copilot' }));
  const report = runDoctor(config, config.installStateFile, { projectDir: root, homeDir: path.join(root, 'home') });
  const claude = check(report, `${projectKey(root)}:claude-settings`);
  assert.equal(claude?.status, 'warn', JSON.stringify(report.checks.filter((entry) => entry.id.includes('settings'))));
  assert.ok(claude.detail.includes(paths(root).claudeSettings), claude.detail);
  assert.match(claude.detail, /it does not parse as JSON/);
  assert.match(claude.detail, /no hooks, status line or skills/);
  assert.ok(claude.detail.endsWith(`Run: tokenwatch install --agents claude --scope project --project "${root}" --force`), claude.detail);
  const copilot = check(report, `${projectKey(root)}:copilot-settings`);
  assert.equal(copilot?.status, 'warn', JSON.stringify(copilot));
  assert.match(copilot.detail, /does not hold a JSON object at its top level/);
  assert.ok(copilot.detail.endsWith(`Run: tokenwatch install --agents copilot --scope project --project "${root}" --force`), copilot.detail);
  assert.equal(report.ok, true, 'a refusal is a warning, not a failed doctor');
});

// The other checks agree with the saved refusal. A file Tokenwatch refused is
// not "OK" for existing, an agent that got nothing installed cannot collect,
// so it is not told to run a session and check again, and a refused Copilot is
// not told to type /tw-<name> into a session nothing records.
test('a settings file refused at install is not reported OK by the file checks', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{ "model": "sonnet", }\n');
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  install(config, options(root, { agents: 'claude,copilot' }));
  const report = runDoctor(config, config.installStateFile, { projectDir: root, homeDir: path.join(root, 'home') });
  for (const [id, agent] of [['claudeSettings', 'claude'], ['copilotConfig', 'copilot']]) {
    const file = check(report, `${projectKey(root)}:${id}`);
    assert.notEqual(file?.status, 'ok', JSON.stringify(file));
    assert.ok(file.detail.includes(`${projectKey(root)}:${agent}-settings`), file.detail);
  }
});

test('an agent whose settings file was refused is reported as not collecting, not as waiting for a session', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '[1]\n');
  install(config, options(root, { agents: 'claude' }));
  const collection = check(runDoctor(config, config.installStateFile, { projectDir: root, homeDir: path.join(root, 'home') }), 'collection:claude');
  assert.equal(collection?.status, 'warn', JSON.stringify(collection));
  assert.doesNotMatch(collection.detail, /Run a session|check again/, collection.detail);
  assert.ok(collection.detail.includes(`${projectKey(root)}:claude-settings`), collection.detail);
});

test('shared skills installed for Codex beside a refused Copilot do not tell Copilot users how to run them', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).copilotConfig, '[1]\n');
  install(config, options(root, { agents: 'copilot,codex', sharedSkills: path.join(root, '.agents', 'skills') }));
  const shared = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:shared-skills`);
  assert.equal(shared?.status, 'ok', JSON.stringify(shared));
  assert.match(shared.detail, /\$tw-<name>/, 'Codex is still told');
  assert.doesNotMatch(shared.detail, /Copilot CLI type/, shared.detail);
});

// A forced install over an edited skill backs up the text it replaces; a second
// forced install over it, edited again, backs up the newer text and the record
// names only that one. The first backup, holding text a user wrote, is named
// by nothing. doctor reports it, by file name only, and never deletes it.
test('doctor reports a skill backup no install record names, and leaves it in place', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const installed = path.join(paths(root).claudeSkills, 'tw-explain-statusline', 'SKILL.md');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, 'FIRST-EDIT-POISON\n');
  const first = install(config, options(root, { force: true })).claudeSkills.find((skill) => skill.name === 'tw-explain-statusline');
  const at = { projectDir: root, homeDir: path.join(root, 'home') };
  assert.equal(runDoctor(config, config.installStateFile, at).checks.some((entry) => entry.id === 'skill-backups:orphaned'), false, 'a backup the record names is not reported');

  fs.writeFileSync(installed, 'SECOND-EDIT-POISON\n');
  const second = install(config, options(root, { force: true })).claudeSkills.find((skill) => skill.name === 'tw-explain-statusline');
  assert.notEqual(second.backup, first.backup);
  const report = runDoctor(config, config.installStateFile, at);
  const orphaned = check(report, 'skill-backups:orphaned');
  assert.equal(orphaned?.status, 'warn', JSON.stringify(orphaned));
  assert.ok(orphaned.detail.includes(first.backup), orphaned.detail);
  assert.ok(!orphaned.detail.includes(second.backup), 'the backup the record names is not reported');
  assert.doesNotMatch(JSON.stringify(report), /EDIT-POISON/, 'never quotes a backup');
  assert.equal(fs.readFileSync(first.backup, 'utf8'), 'FIRST-EDIT-POISON\n', 'doctor reports, never deletes');
});

// Every other reinstall doctor names carries the record's scope and agents
// too: a bare `tokenwatch install --force` installs every agent at user scope.
test('the reinstall doctor names for a changed skill or an old hook file is the record\'s own', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'claude,copilot' }));
  const skill = path.join(paths(root).claudeSkills, 'tw-explain-statusline', 'SKILL.md');
  fs.appendFileSync(skill, '\nedited\n');
  const hooksFile = paths(root).copilotHooks;
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  document.hooks.preToolUse = document.hooks.postToolUse;
  fs.writeFileSync(hooksFile, JSON.stringify(document));
  const report = runDoctor(config, config.installStateFile, { projectDir: root, homeDir: path.join(root, 'home') });
  const modified = check(report, `${projectKey(root)}:claude:tw-explain-statusline:modified`);
  assert.ok(modified?.detail.endsWith(`tokenwatch install --agents claude --scope project --project "${root}" --force`), JSON.stringify(modified));
  const failClosed = check(report, `${projectKey(root)}:copilot-fail-closed-hooks`);
  assert.ok(failClosed?.detail.endsWith(`tokenwatch install --agents copilot --scope project --project "${root}" --force`), JSON.stringify(failClosed));
});

// No false positives: the new checks are silent on an install that works.
test('a healthy install with status-line samples raises no collection or status-line warning', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  install(config, installOptions);
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T09:00:00.000Z'), config);
  storeEvent(hook('claude', 'UserPromptSubmit', '2026-09-23T09:01:00.000Z'), config);
  storeEvent(statusSample('2026-09-23T09:01:30.000Z'), config);
  storeEvent(hook('claude', 'UserPromptSubmit', '2026-09-23T09:05:00.000Z'), config);

  const report = runDoctor(config, config.installStateFile,
    { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home });
  assert.equal(check(report, 'collection:claude')?.status, 'ok', check(report, 'collection:claude')?.detail);
  assert.equal(check(report, 'user:claude-status-line')?.status, 'ok', check(report, 'user:claude-status-line')?.detail);
  const raised = report.checks.filter((entry) => entry.status === 'warn'
    && (entry.id.startsWith('collection:') || entry.id.endsWith(':claude-status-line')));
  assert.deepEqual(raised, []);
});

// Intent 06, D4: imported history is old rows appended after new ones, and
// never evidence that live capture works.
function importedRow(ts, n, sessionId = 'hist-1') {
  return makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', event_name: 'import.response', session_id: sessionId, turn_id: `r${n}`, ts,
    usage: { input_total: 100, output: 10, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'run-1', verification: 'unverified', reason: 'no_overlap' }
  });
}

test('a block of imported history appended after live rows does not stop the liveness scan', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  install(config, installOptions);
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T09:00:00.000Z'), config);
  storeEvent(statusSample('2026-09-23T09:01:30.000Z'), config);
  storeEvent(hook('claude', 'SessionEnd', '2026-09-23T09:05:00.000Z'), config);
  // Well over one backward-scan chunk of months-old history, written last.
  appendImportedEvents(Array.from({ length: 600 }, (_, n) => importedRow('2026-06-01T10:00:00.000Z', n)), config);
  const report = runDoctor(config, config.installStateFile, { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home });
  const collection = check(report, 'collection:claude');
  assert.equal(collection?.status, 'ok', collection?.detail);
  assert.match(collection.detail, /status-line samples/);
});

test('imported rows never make an agent with no live events read as collecting', () => {
  const recent = Array.from({ length: 5 }, (_, n) => importedRow('2026-09-23T10:00:00.000Z', n));
  const result = collectionLiveness('claude', recent, { installedAt: '2026-09-20T00:00:00.000Z', now: '2026-09-23T12:00:00.000Z' });
  assert.equal(result.verdict, 'no-events-since-install', result.detail);
  assert.equal(result.status, 'warn');
  assert.equal(result.imported_events, 5, 'counted apart');
  assert.equal(result.events, 0);
});

test('retention is judged on the oldest row, including history an import appended later', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  config.retentionDays = 90;
  storeEvent(hook('claude', 'SessionStart', new Date().toISOString()), config);
  const quiet = check(runDoctor(config, config.installStateFile), 'retention');
  assert.equal(quiet?.status, 'ok', quiet?.detail);
  writeImportRun(config, { run_id: 'run-1', mapping_id: 'claude-jsonl-1', agent: 'claude', earliest_ts: '2025-01-01T00:00:00.000Z', finished_at: '2026-09-23T10:00:00.000Z' });
  const old = check(runDoctor(config, config.installStateFile), 'retention');
  assert.equal(old?.status, 'warn', old?.detail);
  assert.match(old.detail, /past the configured retentionDays of 90/);
  // A run killed part-way recorded only its planned earliest row (D27); its
  // rows may be in the ledger, so that date counts too.
  writeImportRun(config, { run_id: 'run-1', mapping_id: 'claude-jsonl-1', agent: 'claude', earliest_planned_ts: '2025-01-01T00:00:00.000Z' });
  assert.equal(check(runDoctor(config, config.installStateFile), 'retention')?.status, 'warn', 'a planned earliest row counts');
});

// An undone import took its rows out of the ledger, so its earliest row no
// longer ages it: after an undo doctor said "oldest event is 5d old" of a ledger
// whose every row was from that day (Windows live test, 2026-09-28).
test('an undone import no longer counts towards the age of the ledger', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  config.retentionDays = 90;
  storeEvent(hook('claude', 'SessionStart', new Date().toISOString()), config);
  writeImportRun(config, { run_id: 'run-1', mapping_id: 'claude-jsonl-1', agent: 'claude', earliest_ts: '2025-01-01T00:00:00.000Z', finished_at: '2026-09-23T10:00:00.000Z' });
  assert.equal(check(runDoctor(config, config.installStateFile), 'retention')?.status, 'warn', 'the imported history counts while it is there');
  markImportRunsUndone(config, { agent: 'claude', mappingId: 'claude-jsonl-1' });
  const after = check(runDoctor(config, config.installStateFile), 'retention');
  assert.equal(after?.status, 'ok', after?.detail);
  assert.match(after.detail, /^oldest event is 0d old/, after.detail);
});

test('doctor reports the last import per agent, and names the exact undo for one that stopped part-way', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  writeImportRun(config, { run_id: 'run-old', mapping_id: 'claude-jsonl-1', agent: 'claude', started_at: '2026-09-20T10:00:00.000Z', finished_at: '2026-09-20T10:01:00.000Z', responses_written: 5, sessions_imported: 1, verification: 'verified' });
  assert.equal(check(runDoctor(config, config.installStateFile), 'import:claude')?.status, 'ok');
  writeImportRun(config, { run_id: 'run-2', mapping_id: 'claude-jsonl-1', agent: 'claude', started_at: '2026-09-23T10:00:00.000Z', responses_written: 40, sessions_imported: 3 });
  const stopped = check(runDoctor(config, config.installStateFile), 'import:claude');
  assert.equal(stopped?.status, 'warn');
  assert.match(stopped.detail, /did not finish: 40 responses from 3 sessions/);
  assert.match(stopped.detail, /run: tokenwatch import claude --undo claude-jsonl-1 --run run-2$/);
  // A later run that found nothing new says so, rather than "0 responses".
  writeImportRun(config, { run_id: 'run-3', mapping_id: 'claude-jsonl-1', agent: 'claude', started_at: '2026-09-24T10:00:00.000Z', finished_at: '2026-09-24T10:00:05.000Z', responses_written: 0, sessions_imported: 0, responses_skipped_duplicate: 45, verification: 'verified' });
  assert.match(check(runDoctor(config, config.installStateFile), 'import:claude').detail, /nothing new, 45 responses were already imported/);
  writeImportRun(config, { run_id: 'run-4', mapping_id: 'claude-jsonl-1', agent: 'claude', started_at: '2026-09-25T10:00:00.000Z', finished_at: '2026-09-25T10:00:05.000Z', responses_written: 0, sessions_imported: 0, responses_skipped_duplicate: 0 });
  const empty = check(runDoctor(config, config.installStateFile), 'import:claude').detail;
  assert.match(empty, /0 responses from 0 sessions/);
  assert.doesNotMatch(empty, /nothing new/, 'a run that found nothing at all is not described as duplicates');
});

// #14: a run that stopped before it could record a count holds only its plan.
// Doctor reports the rows of that run the ledger actually holds, and falls back
// to "up to N" only when it cannot read the whole ledger; a run measured at zero
// says it wrote nothing.
test('an unfinished run is reported by the rows the ledger holds, never as up to N it did not measure', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const planned = { run_id: 'run-p', mapping_id: 'claude-jsonl-1', agent: 'claude', started_at: '2026-09-23T10:00:00.000Z', responses_planned: 40, sessions_planned: 3 };
  writeImportRun(config, planned);
  const none = check(runDoctor(config, config.installStateFile), 'import:claude');
  assert.equal(none?.status, 'info', none?.detail);
  assert.match(none.detail, /none of its rows are in the ledger/);
  assert.doesNotMatch(none.detail, /up to \d+|may have been written/);

  const row = (n, runId) => makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', event_name: 'import.response', session_id: 'hist-1', turn_id: `r${n}`, ts: '2026-06-01T10:00:00.000Z',
    usage: { input_total: 100, output: 10, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: runId, verification: 'unverified', reason: 'no_overlap' }
  });
  appendImportedEvents([row(1, 'run-other'), row(2, 'run-p'), row(3, 'run-p')], config);
  const some = check(runDoctor(config, config.installStateFile), 'import:claude');
  assert.equal(some?.status, 'warn');
  assert.match(some.detail, /recorded no count; 2 rows of this run are in the ledger/);
  assert.match(some.detail, /run: tokenwatch import claude --undo claude-jsonl-1 --run run-p$/);

  // A ledger doctor cannot read is no evidence either way: the plan is all it has.
  const unreadable = testConfig(path.join(root, 'other'));
  fs.mkdirSync(unreadable.dataFile, { recursive: true });
  writeImportRun(unreadable, planned);
  assert.match(check(runDoctor(unreadable, unreadable.installStateFile), 'import:claude').detail, /recorded no count, and up to 40 responses from 3 sessions .* may have been written/);

  writeImportRun(config, { ...planned, run_id: 'run-z', started_at: '2026-09-24T10:00:00.000Z', responses_written: 0, sessions_imported: 0 });
  const zero = check(runDoctor(config, config.installStateFile), 'import:claude');
  assert.equal(zero?.status, 'info', zero?.detail);
  assert.match(zero.detail, /did not finish and wrote no rows/);
  assert.doesNotMatch(zero.detail, /--undo/, 'nothing to undo');
});

// The very first turn after an install has its hook events in the ledger and
// its status samples still buffered in the session's state file. Reading the
// ledger alone called that healthy turn "hooks without status samples".
test('a first turn whose samples are still buffered is not reported as hooks without samples', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  install(config, installOptions);
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T11:58:00.000Z'), config);
  storeEvent(hook('claude', 'UserPromptSubmit', '2026-09-23T11:58:30.000Z'), config);
  storeEvent(statusSample('2026-09-23T11:59:00.000Z'), config);
  assert.doesNotMatch(fs.readFileSync(config.dataFile, 'utf8'), /statusline/, 'the premise: the sample is not in the ledger yet');

  const report = runDoctor(config, config.installStateFile,
    { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home });
  const collection = check(report, 'collection:claude');
  assert.equal(collection?.status, 'ok', collection?.detail);
  assert.match(collection.detail, /1 status-line samples/);
});

// Samples from before the window must not vouch for a status line that has
// since stopped delivering.
test('status-line samples older than the window do not hide a status line that stopped delivering', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  install(config, installOptions);
  backdateInstalls(config, '2026-09-01T08:00:00.000Z');
  storeEvent(hook('claude', 'UserPromptSubmit', '2026-09-02T09:00:00.000Z', 'old'), config);
  storeEvent(statusSample('2026-09-02T09:00:30.000Z', 'old'), config);
  storeEvent(hook('claude', 'SessionEnd', '2026-09-02T09:10:00.000Z', 'old'), config);
  storeEvent(hook('claude', 'SessionStart', '2026-09-22T09:00:00.000Z', 'new'), config);
  storeEvent(hook('claude', 'UserPromptSubmit', '2026-09-22T09:01:00.000Z', 'new'), config);

  const collection = check(runDoctor(config, config.installStateFile,
    { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home }), 'collection:claude');
  assert.equal(collection?.status, 'warn', collection?.detail);
  assert.match(collection.detail, /2 hook events but 0 status-line samples/);
});

// Codex reports tokens only over OTLP, which it sends only when started through
// the wrapper. A plain `codex` session still records turns through the notify
// relay, so turns with no tokens name the missing wrapper.
test('codex turns without token counts are reported as not launched through tokenwatch-codex', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  for (const ts of ['2026-09-23T09:00:00.000Z', '2026-09-23T09:05:00.000Z', '2026-09-23T09:10:00.000Z']) {
    storeEvent(codexTurn(ts), config);
  }
  const at = { now: '2026-09-23T12:00:00.000Z', projectDir: root, homeDir: path.join(root, 'home') };
  const plain = check(runDoctor(config, config.installStateFile, at), 'collection:codex');
  assert.equal(plain?.status, 'warn', plain?.detail);
  assert.match(plain.detail, /3 Codex turns/);
  assert.match(plain.detail, /tokenwatch-codex/);

  storeEvent(makeEvent({
    agent: 'codex', source: 'otlp', kind: 'usage', event_name: 'codex.sse_event', session_id: 'codex-1',
    ts: '2026-09-23T09:10:05.000Z', usage: { input_total: 15268, cache_read: 11136, output: 5, semantics: 'cached_subset', basis: 'increment' }
  }), config);
  const wrapped = check(runDoctor(config, config.installStateFile, at), 'collection:codex');
  assert.equal(wrapped?.status, 'ok', wrapped?.detail);
});

// Installing and running doctor straight away is the documented first step; it
// must not raise an alarm. An agent still silent well after install is.
test('an install with nothing recorded is a warning only once it is no longer fresh', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root));
  backdateInstalls(config, '2026-09-23T11:45:00.000Z');
  const at = (now) => ({ now, projectDir: root, homeDir: path.join(root, 'home') });

  const fresh = check(runDoctor(config, config.installStateFile, at('2026-09-23T12:00:00.000Z')), 'collection:claude');
  assert.equal(fresh?.status, 'info', fresh?.detail);
  assert.match(fresh.detail, /no claude-code events yet/);

  const stale = check(runDoctor(config, config.installStateFile, at('2026-09-23T14:00:00.000Z')), 'collection:claude');
  assert.equal(stale?.status, 'warn', stale?.detail);
  assert.match(stale.detail, /no claude-code events at all since install/);
});

// The per-agent rule is exported for other collection checks to build on, so
// its result shape is part of the contract: counts, the window, a verdict.
test('collection liveness is a pure verdict over events, with counts and the window it judged', () => {
  const events = [
    hook('claude', 'UserPromptSubmit', '2026-09-20T09:00:00.000Z'),
    codexTurn('2026-09-20T09:00:00.000Z'),
    hook('claude', 'Stop', '2026-09-01T09:00:00.000Z')
  ];
  const result = collectionLiveness('claude', events, { installedAt: '2026-08-01T00:00:00.000Z', now: '2026-09-23T12:00:00.000Z' });
  assert.equal(result.verdict, 'hooks-without-status-samples');
  assert.equal(result.since, '2026-09-16T12:00:00.000Z', 'seven days back, since the install is older');
  assert.equal(result.events, 1, 'another agent and an event before the window are not counted');
  assert.equal(result.status_samples, 0);
  assert.equal(result.last_event_at, '2026-09-20T09:00:00.000Z');

  const unknown = collectionLiveness('copilot', [], { installedAt: '2026-08-01T00:00:00.000Z', now: '2026-09-23T12:00:00.000Z', complete: false });
  assert.equal(unknown.verdict, 'idle', 'a ledger not read back to the install cannot prove nothing arrived');
  assert.equal(unknown.last_event_at, undefined);
});

// Doctor reads the ledger backwards in fixed-size chunks so it stays cheap on a
// year of history. A record split across two chunks, or a multi-byte character
// split across the cut, must still be read exactly once.
test('the ledger is read from its end across chunk boundaries without losing or splitting a record', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { home, project, options: installOptions } = userScopeClaude(root);
  install(config, installOptions);
  backdateInstalls(config, '2026-08-01T00:00:00.000Z');
  const line = (fields) => `${JSON.stringify({ schema: 'tokenwatch.event/v1', agent: 'claude-code', session_id: 'long', ...fields })}\n`;
  let text = '';
  for (let index = 0; index < 2000; index += 1) {
    text += line({ event_id: `old-${index}`, ts: '2026-08-02T09:00:00.000Z', kind: 'lifecycle', source: 'hook', event_name: 'Stop' });
  }
  for (let index = 0; index < 300; index += 1) {
    text += line({ event_id: `hook-${index}`, ts: '2026-09-22T09:00:00.000Z', kind: 'lifecycle', source: 'hook', event_name: 'Stop' });
    text += line({ event_id: `sample-${index}`, ts: '2026-09-22T09:00:01.000Z', kind: 'usage', source: 'statusline',
      event_name: 'status', model: `modèle-ü-${'é'.repeat(index % 7)}`, usage: { input_total: 10, basis: 'sample' } });
  }
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, text);
  assert.ok(Buffer.byteLength(text) > 4 * 64 * 1024, 'the premise: the ledger spans several chunks');

  const collection = check(runDoctor(config, config.installStateFile,
    { now: '2026-09-23T12:00:00.000Z', projectDir: project, homeDir: home }), 'collection:claude');
  assert.equal(collection?.status, 'ok', collection?.detail);
  assert.match(collection.detail, /^600 claude-code events since 2026-09-16T12:00:00\.000Z: 300 hook events and 300 status-line samples\.$/);
});

// Doctor reads the script path out of each recorded command, in each form the
// installer writes one: single-quoted words on POSIX, double-quoted on Windows,
// and a Codex notify array. An install whose hooks run a script from a
// temporary folder is fragile; one whose script is gone is already broken.
test('doctor reports recorded commands that run a script from a temporary folder, or one that is gone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const script = (name) => {
    const file = path.join(root, name, "it's here", 'bin', 'tokenwatch.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  const posix = script('posix');
  const windows = script('windows');
  const notify = script('notify');
  const gone = path.join(root, 'removed', 'bin', 'tokenwatch.mjs');
  const single = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const double = (value) => `"${value.replaceAll('"', '\\"')}"`;
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: {
    user: {
      claude: { statusCommand: `${single(process.execPath)} ${single(posix)} status --agent claude --ingest-stdin`, hooks: [] },
      copilot: { statusCommand: `${double(process.execPath)} ${double(windows)} status --agent copilot --ingest-stdin` },
      codex: { notifyLine: `notify = ${JSON.stringify([process.execPath, notify, 'notify-relay', '--agent', 'codex'])}` }
    },
    'project:elsewhere': {
      claude: { statusCommand: `${single(process.execPath)} ${single(gone)} status --agent claude --ingest-stdin`, hooks: [] }
    }
  } }));

  const checks = runDoctor(config, config.installStateFile).checks.filter((check) => check.id.endsWith(':install-location'));
  const byScript = (file) => checks.find((check) => check.detail.startsWith(fs.realpathSync(file)));
  for (const file of [posix, windows, notify]) {
    const check = byScript(file);
    assert.equal(check?.status, 'warn', `${file} should be reported, got ${JSON.stringify(checks)}`);
    assert.match(check.detail, /temporary directory/);
    assert.equal(check.id, 'user:install-location');
  }
  const missing = checks.find((check) => check.id === 'project:elsewhere:install-location');
  assert.equal(missing?.status, 'error', `a recorded script that is gone must be an error, got ${JSON.stringify(checks)}`);
  assert.match(missing.detail, /no longer exists/);
});

// The reinstall that moves a fragile install onto a durable copy is the one for
// that install: its scope and its agents, not a bare `install --force`, which
// would install every agent at user scope.
test('a recorded script in a temporary folder names the reinstall for its own install', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = path.join(root, 'fragile', 'bin', 'tokenwatch.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: {
    [projectKey(project)]: { scope: 'project', project, agents: ['claude', 'codex'],
      claude: { statusCommand: `'${process.execPath}' '${file}' status --agent claude --ingest-stdin`, hooks: [] } }
  } }));
  const recorded = runDoctor(config, config.installStateFile).checks.find((entry) => entry.id === `${projectKey(project)}:install-location`);
  assert.equal(recorded?.status, 'warn', JSON.stringify(recorded));
  assert.ok(recorded.detail.endsWith(`re-run \`tokenwatch install --agents claude,codex --scope project --project "${project}" --force\` from that copy.`), recorded.detail);
});

// Doctor used to pass the Copilot hook check because the file existed, while
// on Windows every command in it failed to parse and Copilot denied every tool
// call. Each command now runs through the agent's shell in probe mode, and
// probe mode must leave no trace: no ledger, no state, nothing in the home.
test('doctor runs each installed Copilot command through its shell and stores nothing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installCopilot(root, config);
  const before = fs.readdirSync(path.join(root, 'state')).sort();

  const report = runDoctor(config, config.installStateFile);
  const hooksRun = report.checks.find((check) => check.id.endsWith(':copilot-hooks-run'));
  const statusRun = report.checks.find((check) => check.id.endsWith(':copilot-status-run'));
  assert.equal(hooksRun?.status, 'ok', `hooks: ${JSON.stringify(hooksRun)}`);
  assert.match(hooksRun.detail, /^10 Copilot hook command\(s\) ran through/, hooksRun.detail);
  assert.equal(statusRun?.status, 'ok', `status line: ${JSON.stringify(statusRun)}`);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === 'error')));
  assert.equal(fs.existsSync(config.dataFile), false, 'a probe wrote to the ledger');
  assert.deepEqual(fs.readdirSync(path.join(root, 'state')).sort(), before, 'a probe changed the Tokenwatch home');
});

// The Windows failure, reproduced in both shells: a quoted path with no `&` is
// a parse error in PowerShell, and an unterminated quote is one in Bash. Doctor
// has to say so before the agent runs into it.
test('doctor reports a Copilot hook command that fails in its shell before the agent runs it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const hooksFile = installCopilot(root, config);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const [entry] = document.hooks.sessionStart;
  // This CLI's own path, or doctor would rightly decline to run the command.
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  entry.powershell = `"${process.execPath}" "${cli}" "hook" "copilot" "sessionStart"`;
  entry.bash = `'${process.execPath}' '${cli}' 'hook' 'copilot' 'sessionStart`;
  fs.writeFileSync(hooksFile, JSON.stringify(document));

  const report = runDoctor(config, config.installStateFile);
  const failed = report.checks.find((check) => check.id.endsWith(':copilot-hook:sessionStart'));
  assert.equal(failed?.status, 'error', `expected an error for sessionStart, got ${JSON.stringify(report.checks.filter((check) => check.id.includes('copilot-hook')))}`);
  assert.match(failed.detail, /exited \d+ under/, failed.detail);
  assert.doesNotMatch(failed.detail, /tokenwatch\.mjs/, 'the detail names the event, not the command text');
  assert.equal(report.ok, false, 'a hook that cannot run fails doctor');
  assert.equal(report.checks.some((check) => check.id.endsWith(':copilot-hooks-run') && check.status === 'ok'), false);
});

// doctor starts one shell for every Copilot hook, where Copilot starts one per
// hook, so one hook must not be able to change what doctor says about another.
// Joined into one script, a hook that exited ended the script and the hooks
// after it were blamed; one that did not parse took the rest with it; one that
// hung was measured against the sum of every hook's limit; and a second entry
// for an event hid behind the first one's marker. Each case breaks one hook,
// subagentStart, in the middle of the file, and doctor must name that hook and
// no other, with the problem a shell of its own reports, as Copilot would see.
function editCopilotHooks(root, config, edit) {
  const hooksFile = installCopilot(root, config);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  edit(document.hooks);
  fs.writeFileSync(hooksFile, JSON.stringify(document));
}

const failedCopilotHooks = (report) => report.checks.filter((entry) => entry.id.includes(':copilot-hook:')).map((entry) => entry.id.split(':').at(-1));

test('a Copilot hook that overruns its own time limit is reported as timed out, whatever the other hooks allow', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    entry.timeoutSec = 1;
    entry.bash = `sleep 2; ${entry.bash}`;
    entry.powershell = `Start-Sleep -Seconds 2; ${entry.powershell}`;
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), ['subagentStart'], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.match(check(report, `${projectKey(root)}:copilot-hook:subagentStart`).detail, /^the subagentStart hook timed out after 1s under /);
  assert.equal(report.ok, false);
});

test('a Copilot hook that exits non-zero is the one named, not the hooks after it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    entry.bash = `${entry.bash}; exit 7`;
    entry.powershell = `${entry.powershell}; exit 7`;
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), ['subagentStart'], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.match(check(report, `${projectKey(root)}:copilot-hook:subagentStart`).detail, /^the subagentStart hook exited 7 under /);
});

test('a broken second entry for an event is named, though the first entry for it reaches Tokenwatch', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    hooks.subagentStart.push({ ...entry, bash: entry.bash.slice(0, -1), powershell: entry.powershell.slice(0, -1) });
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), ['subagentStart'], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.match(check(report, `${projectKey(root)}:copilot-hook:subagentStart`).detail, /^the subagentStart hook exited \d+ under /);
});

test('a Copilot hook that ends its shell with exit 0 after reaching Tokenwatch passes, and no other hook is blamed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    entry.bash = `${entry.bash}; exit 0`;
    entry.powershell = `${entry.powershell}; exit 0`;
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), [], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.equal(check(report, `${projectKey(root)}:copilot-hooks-run`)?.status, 'ok');
});

// PowerShell has no exec; there the hook is simply healthy.
test('a Copilot hook that replaces its shell with exec blames no other hook', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    entry.bash = `exec ${entry.bash}`;
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), [], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.equal(check(report, `${projectKey(root)}:copilot-hooks-run`)?.status, 'ok');
});

test('a Copilot hook that does not parse fails alone, not every hook after it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  editCopilotHooks(root, config, (hooks) => {
    const [entry] = hooks.subagentStart;
    entry.bash = entry.bash.slice(0, -1);
    entry.powershell = entry.powershell.slice(0, -1);
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), ['subagentStart'], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.match(check(report, `${projectKey(root)}:copilot-hook:subagentStart`).detail, /^the subagentStart hook exited \d+ under /);
});

// The point of one shell: ten PowerShell starts were about 9 s of a 16 s
// doctor on Windows. Each hook here also writes the id of the shell process
// running it (`$$` is the shell's own id in Bash, subshells included), so the
// file shows how many shells doctor started for ten healthy hooks.
test('doctor probes every healthy Copilot hook through one shell start', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const log = path.join(root, 'hook-shells.log');
  editCopilotHooks(root, config, (hooks) => {
    for (const [entry] of Object.values(hooks)) {
      entry.bash = `echo $$ >> '${log}'; ${entry.bash}`;
      entry.powershell = `Add-Content -LiteralPath '${log}' -Value $PID; ${entry.powershell}`;
    }
  });
  const report = runDoctor(config, config.installStateFile);
  assert.deepEqual(failedCopilotHooks(report), [], JSON.stringify(report.checks.filter((entry) => entry.id.includes('copilot-hook'))));
  assert.match(check(report, `${projectKey(root)}:copilot-hooks-run`)?.detail ?? '', /^10 Copilot hook command\(s\) ran through/);
  const shells = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.equal(shells.length, 10, `every hook ran once: ${shells.join(',')}`);
  assert.equal(new Set(shells).size, 1, `one shell for all ten: ${[...new Set(shells)].join(',')}`);
});

// Probe mode is honoured only by this CLI. A hook left by another Tokenwatch -
// an older version not yet reinstalled - ignores it, so executing that hook
// records a real event. Run after an upgrade against a real home, this check
// wrote a full round of empty Copilot events into the ledger each time. The
// stand-in below is an "older Tokenwatch" that leaves a mark when it runs.
test('doctor never executes a Copilot hook that runs a different Tokenwatch, and says so', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const hooksFile = installCopilot(root, config);
  const older = path.join(root, 'older', 'tokenwatch.mjs');
  const mark = path.join(root, 'older-tokenwatch-ran');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'ran\\n');\n`);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  for (const [eventName, [entry]] of Object.entries(document.hooks)) {
    entry.bash = `'${process.execPath}' '${older}' 'hook' 'copilot' '${eventName}'`;
    entry.powershell = `& '${process.execPath}' '${older}' 'hook' 'copilot' '${eventName}'`;
  }
  fs.writeFileSync(hooksFile, JSON.stringify(document));

  const report = runDoctor(config, config.installStateFile);
  assert.equal(fs.existsSync(mark), false, `the other Tokenwatch was executed: ${fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : ''}`);
  const hooksRun = report.checks.find((check) => check.id.endsWith(':copilot-hooks-run'));
  assert.equal(hooksRun?.status, 'warn', `got ${JSON.stringify(hooksRun)}`);
  assert.match(hooksRun.detail, /^10 Copilot hook command\(s\) run a different Tokenwatch than this one, so they were not executed/, hooksRun.detail);
  assert.equal(report.checks.some((check) => check.id.includes(':copilot-hook:')), false, 'nothing was run, so nothing is reported as failing');
});

// A machine without the shell cannot have its commands checked, and that is
// not a defect in the commands. Said plainly, not reported as a failure.
test('doctor says a missing hook shell was not checked rather than failing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installCopilot(root, config);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = tempDir('tokenwatch-empty-path-');

  const report = runDoctor(config, config.installStateFile, { env });
  const hooksRun = report.checks.find((check) => check.id.endsWith(':copilot-hooks-run'));
  assert.equal(hooksRun?.status, 'info', `got ${JSON.stringify(hooksRun)}`);
  assert.match(hooksRun.detail, /not on PATH here, so the 10 Copilot hook command\(s\) were not executed/, hooksRun.detail);
  assert.equal(report.checks.some((check) => check.id.includes(':copilot-hook:')), false, 'nothing was run, so nothing failed');
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === 'error')));
});

// Intent 17: Claude Code's commands get the same proof Copilot's have. Claude
// Code runs them through /bin/sh off Windows and Git Bash or PowerShell on it;
// a command that shell cannot parse records nothing and nothing else notices.
const THIS_CLI = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));

// The shell doctor probes Claude Code's commands through here, by the name it
// reports: /bin/sh off Windows; on Windows Git Bash where installed, else
// PowerShell, because that is the shell Claude Code itself would use there.
const CLAUDE_SHELL_NAME = { posix: '/bin/sh', bash: 'Git Bash', powershell: 'PowerShell' }[claudeShell().shell];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// This environment with its search path replaced. On Windows the variable is
// `Path`, and a copy of process.env with `PATH` added beside it holds both, so
// the old path stays in reach of whichever spelling a lookup finds first.
function envWithPath(value) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = value;
  return env;
}

function installClaudeHere(root, config) {
  install(config, options(root));
  return paths(root).claudeSettings;
}

// Doctor probes a command only while the settings file still holds exactly what
// the install record says it wrote, so a test changes both together.
function rewriteClaudeCommands(root, config, { hook, status, commandShell }) {
  const settingsFile = paths(root).claudeSettings;
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const record = Object.values(state.installs)[0].claude;
  for (const entry of record.hooks) {
    const next = hook?.(entry.eventName, entry.command);
    if (next === undefined) continue;
    for (const group of settings.hooks[entry.eventName]) {
      for (const candidate of group.hooks) if (candidate.command === entry.command) candidate.command = next;
    }
    entry.command = next;
  }
  if (commandShell) record.commandShell = commandShell;
  if (status) {
    const next = status(record.statusCommand);
    settings.statusLine.command = next;
    record.statusCommand = next;
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
}

test('doctor runs each installed Claude Code command through its shell and stores nothing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const before = fs.readdirSync(path.join(root, 'state')).sort();

  const report = runDoctor(config, config.installStateFile);
  const hooksRun = report.checks.find((check) => check.id.endsWith(':claude-hooks-run'));
  const statusRun = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(hooksRun?.status, 'ok', `hooks: ${JSON.stringify(hooksRun)}`);
  assert.match(hooksRun.detail, new RegExp(`^7 Claude Code hook command\\(s\\) ran through ${escapeRegExp(CLAUDE_SHELL_NAME)} `), hooksRun.detail);
  assert.equal(statusRun?.status, 'ok', `status line: ${JSON.stringify(statusRun)}`);
  assert.match(statusRun.detail, /received its 2-byte stdin intact/, statusRun.detail);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === 'error')));
  assert.equal(fs.existsSync(config.dataFile), false, 'a probe wrote to the ledger');
  assert.deepEqual(fs.readdirSync(path.join(root, 'state')).sort(), before, 'a probe changed the Tokenwatch home');
});

test('doctor reports a Claude Code command that fails in its shell before the agent runs it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  // An unterminated quote: this CLI's own path, so doctor does run it.
  rewriteClaudeCommands(root, config, {
    hook: (eventName, command) => (eventName === 'Stop' ? command.slice(0, -1) : undefined),
    status: (command) => command.slice(0, -1)
  });

  const report = runDoctor(config, config.installStateFile);
  const failed = report.checks.find((check) => check.id.endsWith(':claude-hook:Stop'));
  const status = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(failed?.status, 'error', JSON.stringify(report.checks.filter((check) => check.id.includes('claude-'))));
  assert.match(failed.detail, new RegExp(` under ${escapeRegExp(CLAUDE_SHELL_NAME)} before Tokenwatch could record anything`), failed.detail);
  assert.equal(status?.status, 'error', JSON.stringify(status));
  for (const detail of [failed.detail, status.detail]) {
    assert.doesNotMatch(detail, /tokenwatch\.mjs/, 'the detail names the event, not the command text');
    // The hint reinstalls the record's own scope, not the user scope (D4).
    assert.ok(detail.endsWith(`Reinstall with: tokenwatch install --agents claude --scope project --project "${root}" --force`), detail);
  }
  assert.equal(report.ok, false, 'a command that cannot run fails doctor');
  assert.equal(report.checks.some((check) => check.id.endsWith(':claude-hooks-run') && check.status === 'ok'), false);
});

// Parsing is not delivery: a status line that runs but whose shell does not
// hand it the payload renders nothing and records nothing (D7).
test('doctor reports a Claude Code status command that runs but never receives its stdin', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  rewriteClaudeCommands(root, config, { status: (command) => `${command} < /dev/null` });

  const report = runDoctor(config, config.installStateFile);
  const status = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(status?.status, 'error', JSON.stringify(status));
  assert.match(status.detail, /reached Tokenwatch but its stdin did not/, status.detail);
});

// A shell that re-encodes what it passes on (Windows PowerShell 5.1 can add a
// byte-order mark) still delivers a payload Tokenwatch can parse. doctor names
// the byte count it saw rather than calling that a failure (review HIGH 1).
test('doctor measures a Claude Code status stdin that arrives re-encoded and warns rather than failing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  rewriteClaudeCommands(root, config, { status: (command) => `{ printf '\\357\\273\\277'; cat; } | ${command}` });

  const report = runDoctor(config, config.installStateFile);
  const status = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(status?.status, 'warn', JSON.stringify(status));
  assert.match(status.detail, /stdin arrived as 5 bytes for a 2-byte payload/, status.detail);
});

// On Windows a Claude command starts the node on PATH. When a probe fails,
// doctor names which node that was, since an old one fails the same way (FR-26).
test('doctor names the node on PATH when a Windows-form Claude Code command fails', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  rewriteClaudeCommands(root, config, { commandShell: 'gitbash-or-powershell', status: (command) => command.slice(0, -1) });

  const report = runDoctor(config, config.installStateFile);
  const status = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(status?.status, 'error', JSON.stringify(status));
  assert.match(status.detail, /\(node on PATH: [^;]+; Tokenwatch needs Node 20\+\)/, status.detail);
});

// Windows with Git Bash: Git Bash is the shell that counts, and PowerShell is
// probed too, as information for the day Git Bash goes (D9). Real bash stands
// in for Git Bash; the "powershell.exe" here cannot start, so it is reported,
// but only as information.
// Staged with a real POSIX bash and a symlink, neither of which a Windows runner
// offers without privileges, so it runs off Windows only; the pwsh-gated
// portability cases cover the real Windows shells.
const stagingBash = process.platform === 'win32' ? undefined : ['/bin/bash', '/usr/bin/bash'].find((candidate) => fs.existsSync(candidate));

test('doctor on Windows probes PowerShell as well as Git Bash, and reports it only as information', { skip: stagingBash ? false : 'needs a POSIX bash to stand in for Git Bash' }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const { installs } = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const dir = tempDir('tokenwatch-fake-windows-');
  fs.symlinkSync(stagingBash, path.join(dir, 'bash.exe'));
  fs.writeFileSync(path.join(dir, 'powershell.exe'), '', { mode: 0o755 });
  const env = { PATH: dir, PATHEXT: '.exe', CLAUDE_CODE_GIT_BASH_PATH: path.join(dir, 'bash.exe') };

  const checks = claudeCommandChecks(installs, env, 'win32');
  assert.equal(checks.find((check) => check.id.endsWith(':claude-hooks-run'))?.status, 'ok', JSON.stringify(checks));
  assert.match(checks.find((check) => check.id.endsWith(':claude-hooks-run')).detail, /ran through Git Bash/);
  const other = checks.find((check) => check.id.endsWith(':claude-hooks-run:PowerShell'));
  assert.equal(other?.status, 'info', JSON.stringify(checks));
  assert.match(other.detail, /^8 of 8 Claude Code command\(s\) would not reach Tokenwatch under PowerShell\. Claude Code uses Git Bash on this machine/, other.detail);
  assert.equal(checks.some((check) => check.status === 'error'), false, 'the other shell never fails doctor');
});

test('doctor never executes a Claude Code command that runs a different Tokenwatch, and says so', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const older = path.join(root, 'older', 'tokenwatch.mjs');
  const mark = path.join(root, 'older-tokenwatch-ran');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'ran\\n');\n`);
  rewriteClaudeCommands(root, config, {
    hook: (eventName) => `'${process.execPath}' '${older}' 'hook' 'claude' '${eventName}'`,
    status: () => `'${process.execPath}' '${older}' 'status' '--agent' 'claude' '--ingest-stdin'`
  });

  const report = runDoctor(config, config.installStateFile);
  assert.equal(fs.existsSync(mark), false, 'the other Tokenwatch was executed');
  const hooksRun = report.checks.find((check) => check.id.endsWith(':claude-hooks-run'));
  const statusRun = report.checks.find((check) => check.id.endsWith(':claude-status-run'));
  assert.equal(hooksRun?.status, 'warn', JSON.stringify(hooksRun));
  assert.match(hooksRun.detail, /^7 Claude Code hook command\(s\) run a different Tokenwatch than this one, so they were not executed/, hooksRun.detail);
  assert.equal(statusRun?.status, 'warn', JSON.stringify(statusRun));
  assert.equal(report.checks.some((check) => check.id.includes(':claude-hook:')), false, 'nothing was run, so nothing failed');
});

test('doctor says a missing Claude Code shell was not checked rather than failing', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const { installs } = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  // Windows without Git Bash, and without powershell.exe on PATH here.
  const checks = claudeCommandChecks(installs, { PATH: tempDir('tokenwatch-empty-path-') }, 'win32');
  const hooksRun = checks.find((check) => check.id.endsWith(':claude-hooks-run'));
  assert.equal(hooksRun?.status, 'info', JSON.stringify(checks));
  assert.match(hooksRun.detail, /^PowerShell is not on PATH here, so the 8 Claude Code command\(s\) were not executed/, hooksRun.detail);
  assert.equal(checks.some((check) => check.status === 'error'), false, 'nothing was run, so nothing failed');
});

// A settings file saved by a Windows editor can start with a UTF-8 byte-order
// mark. Install edits it in place (the mark stays at offset 0), and Claude Code
// reads it, but doctor used to parse it with plain JSON.parse, which throws on
// the mark; an empty catch then skipped every command probe for that install
// without a word (Windows live test, 2026-09-28). An empty PATH on win32 makes
// the probe stop at "not executed", which is enough to show the file was read.
test('a settings file with a byte-order mark still gets its Claude Code commands probed', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '﻿{"env":{"X":"1"}}\n');
  installClaudeHere(root, config);
  assert.equal(fs.readFileSync(paths(root).claudeSettings, 'utf8').charCodeAt(0), 0xFEFF, 'install keeps the mark');
  const { installs } = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const checks = claudeCommandChecks(installs, { PATH: tempDir('tokenwatch-empty-path-') }, 'win32');
  const hooksRun = checks.find((check) => check.id.endsWith(':claude-hooks-run'));
  assert.equal(hooksRun?.status, 'info', `the probe was skipped: ${JSON.stringify(checks)}`);
  assert.match(hooksRun.detail, /^PowerShell is not on PATH here, so the 8 Claude Code command\(s\) were not executed/, hooksRun.detail);
});

// When the settings file really cannot be read, the probe is not silently
// dropped either: doctor says the commands were not run, and why, without
// quoting the file.
test('a settings file doctor cannot read is reported instead of silently skipping its command probes', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const settingsFile = installClaudeHere(root, config);
  fs.writeFileSync(settingsFile, '{"hooks": SECRET-SETTINGS-TEXT');
  const { installs } = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const checks = claudeCommandChecks(installs, { PATH: tempDir('tokenwatch-empty-path-') }, 'win32');
  const hooksRun = checks.find((check) => check.id.endsWith(':claude-hooks-run'));
  assert.equal(hooksRun?.status, 'warn', `an unreadable settings file must be named: ${JSON.stringify(checks)}`);
  assert.match(hooksRun.detail, /could not be read here \(unparseable\), so its Claude Code commands were not run/, hooksRun.detail);
  assert.ok(hooksRun.detail.includes(settingsFile), hooksRun.detail);
  assert.doesNotMatch(JSON.stringify(checks), /SECRET-SETTINGS-TEXT/, 'the file is named, never quoted');
});

// A settings file refused at install wrote nothing, and `<key>:claude-settings`
// already names it with its remedy. The probe must not add a second warning
// for the same file.
test('a settings file refused at install is reported once, not again by the command probe', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  fs.writeFileSync(paths(root).claudeSettings, '{"env": ');
  installClaudeHere(root, config);
  const { installs } = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  assert.equal(Object.values(installs)[0].claude?.refused, 'unparseable', JSON.stringify(installs));
  const checks = claudeCommandChecks(installs, { PATH: tempDir('tokenwatch-empty-path-') }, 'win32');
  assert.deepEqual(checks, [], 'the refusal line already covers this file');
  const report = runDoctor(config, config.installStateFile);
  assert.equal(report.checks.filter((check) => check.id.endsWith(':claude-settings')).length, 1, JSON.stringify(report.checks));
});

// The Windows form starts `node` from PATH. doctor resolves it there instead of
// calling a missing file, and a real /bin/sh runs the Windows form end to end.
test('doctor resolves a bare node on PATH and runs the Windows command form through a real shell', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const windows = claudeCommands({ cli: THIS_CLI, platform: 'win32' });
  rewriteClaudeCommands(root, config, { hook: (eventName) => windows.hooks[eventName], status: () => windows.status });
  const nodeDir = path.dirname(process.execPath);
  const withNode = envWithPath(`${nodeDir}${path.delimiter}/usr/bin${path.delimiter}/bin`);

  const report = runDoctor(config, config.installStateFile, { env: withNode });
  assert.equal(report.checks.some((check) => check.id.endsWith(':executable')), false,
    JSON.stringify(report.checks.filter((check) => check.id.endsWith(':executable'))));
  assert.equal(report.checks.find((check) => check.id.endsWith(':claude-hooks-run'))?.status, 'ok');
  assert.equal(report.checks.find((check) => check.id.endsWith(':claude-status-run'))?.status, 'ok');

  const withoutNode = envWithPath(tempDir('tokenwatch-no-node-'));
  const missing = runDoctor(config, config.installStateFile, { env: withoutNode })
    .checks.find((check) => check.id.endsWith(':executable'));
  assert.equal(missing?.status, 'error', 'a node that is nowhere on PATH is reported');
  assert.match(missing.detail, /^`node` is not on PATH here/, missing.detail);
  assert.ok(missing.detail.endsWith(`--scope project --project "${root}" --force`), missing.detail);
});

// A hook file written before this change still registers `preToolUse`, the one
// event that turns any hook failure into a denied tool call. Even while it
// happens to run, doctor names it and the command that rewrites it.
test('doctor warns about a Copilot hook file that still registers preToolUse', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const hooksFile = installCopilot(root, config);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  document.hooks.preToolUse = document.hooks.postToolUse.map((entry) => ({
    ...entry, bash: entry.bash.replace('postToolUse', 'preToolUse'), powershell: entry.powershell.replace('postToolUse', 'preToolUse')
  }));
  fs.writeFileSync(hooksFile, JSON.stringify(document));

  const report = runDoctor(config, config.installStateFile);
  const warning = report.checks.find((check) => check.id.endsWith(':copilot-fail-closed-hooks'));
  assert.equal(warning?.status, 'warn', `got ${JSON.stringify(warning)}`);
  assert.ok(/preToolUse/.test(warning.detail) && warning.detail.endsWith(`Rewrite it with: tokenwatch install --agents copilot --scope project --project "${root}" --force`), warning.detail);
});

// `otlp-bind` checks the configured host and nothing else, and on the Windows
// machine where no receiver was running it printed `OK otlp-bind:
// 127.0.0.1:4318`. The receiver is now asked directly, on its own line, and
// only where Codex is installed. Each receiver below is a real one in its own
// process: doctor probes synchronously, so a server inside this test process
// could not answer while it waited.
async function listeningChild(args, pattern) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TOKENWATCH_HOME: tempDir() }
  });
  let seen = '';
  const port = await new Promise((resolve, reject) => {
    const read = (chunk) => {
      seen += chunk;
      const match = pattern.exec(seen);
      if (match) resolve(Number(match[1]));
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => reject(new Error(`exited ${code} before listening: ${seen}`)));
  });
  return { port, stop: async () => { child.kill(); await once(child, 'exit'); } };
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function codexDoctor(root, config, port) {
  config.codex = { ...config.codex, otlpHost: '127.0.0.1', otlpPort: port };
  return runDoctor(config, config.installStateFile, { projectDir: root, homeDir: path.join(root, 'home') });
}

test('with no receiver running, doctor says so instead of an unqualified OK for the receiver', async () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const port = await closedPort();
  assert.equal(check(codexDoctor(root, config, port), 'otlp-receiver'), undefined, 'no receiver line where Codex is not installed');

  install(config, options(root, { agents: 'codex' }));
  const report = codexDoctor(root, config, port);
  const receiver = check(report, 'otlp-receiver');
  assert.equal(receiver?.status, 'info', `no receiver is normal while Codex is not in use, got ${JSON.stringify(receiver)}`);
  assert.match(receiver.detail, /no receiver on 127\.0\.0\.1:\d+ - Codex tokens are only captured while tokenwatch-codex is running/);
  const bind = check(report, 'otlp-bind');
  assert.equal(bind?.status, 'ok');
  assert.match(bind.detail, /^configured for 127\.0\.0\.1:\d+, a loopback address;.*not a sign that a receiver is running/, bind.detail);
});

test('a running Tokenwatch receiver is reported as running', async () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const cli = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
  const receiver = await listeningChild([cli, 'otlp', 'serve', '--host', '127.0.0.1', '--port', '0', '--quiet'], /listening on http:\/\/127\.0\.0\.1:(\d+)/);
  try {
    const line = check(codexDoctor(root, config, receiver.port), 'otlp-receiver');
    assert.equal(line?.status, 'ok', `got ${JSON.stringify(line)}`);
    assert.match(line.detail, /a Tokenwatch receiver is running on 127\.0\.0\.1:\d+/);
  } finally {
    await receiver.stop();
  }
});

// Direct exports to an occupied port still miss Tokenwatch, but the wrapper
// now starts an independent receiver instead of trusting an unknown listener.
test('a port held by something other than the receiver is a warning, not a running receiver', async () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const other = await listeningChild(['-e',
    "require('node:http').createServer((q, s) => { s.writeHead(404); s.end('nope'); }).listen(0, '127.0.0.1', function () { console.log('port ' + this.address().port); })"
  ], /port (\d+)/);
  try {
    const line = check(codexDoctor(root, config, other.port), 'otlp-receiver');
    assert.equal(line?.status, 'warn', `got ${JSON.stringify(line)}`);
    assert.match(line.detail, /something else answers there \(HTTP 404\), and it is not Tokenwatch's receiver/);
    assert.match(line.detail, /independent OS-assigned port/);
  } finally {
    await other.stop();
  }
});

// The two ways Codex yields no tokens are different faults with different
// fixes, and doctor now says which: turns without tokens mean the wrapper was
// not used (tested above); no turns at all, with no trace of the relay having
// run, mean Codex is not starting the relay, or it cannot record anything.
test('no Codex turns and no relay run since install is reported as the relay not running, not as an idle agent', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  const report = runDoctor(config, config.installStateFile, { now: '2026-09-23T12:00:00.000Z', projectDir: root, homeDir: path.join(root, 'home') });
  const collection = check(report, 'collection:codex');
  assert.equal(collection?.status, 'warn', collection?.detail);
  assert.match(collection.detail, /no codex-cli events, and no notify relay run recorded, since install at 2026-09-23T08:00:00\.000Z/);
  assert.match(collection.detail, /codex-notify/);
  assert.equal(check(report, 'codex-relay')?.status, 'info', check(report, 'codex-relay')?.detail);
  assert.equal(collectionLiveness('codex', [], { installedAt: '2026-09-23T08:00:00.000Z', now: '2026-09-23T12:00:00.000Z' }).verdict,
    'no-events-since-install', 'a caller that passes no relay record gets the verdict it always did');
});

// A relay that recorded turns yesterday and fails on every turn today still has
// turns in the window. Judged by the ledger alone that read as healthy, or as
// "wrapper not used"; the relay's own record names the real cause first.
test('a relay failing since its last good record is named as the cause, ahead of turns that look healthy', () => {
  const config = testConfig(tempDir());
  recordRelayOutcome(config, { ok: true }, { now: '2026-09-23T09:00:00.000Z' });
  recordRelayOutcome(config, { ok: false, stage: 'store', error: Object.assign(new Error('x'), { code: 'EPERM' }), payload: 'argument' },
    { now: '2026-09-23T10:00:00.000Z' });
  const events = [codexTurn('2026-09-23T09:00:00.000Z')];
  const at = { installedAt: '2026-09-23T08:00:00.000Z', now: '2026-09-23T12:00:00.000Z' };
  const failing = collectionLiveness('codex', events, { ...at, relay: readRelayRecord(config) });
  assert.equal(failing.verdict, 'relay-failing', failing.detail);
  assert.match(failing.detail, /failed 1 time\(s\) after its last recorded turn at 2026-09-23T09:00:00\.000Z; the latest at 2026-09-23T10:00:00\.000Z in store \(Error EPERM\)\..*data directory refused the write/);
  assert.equal(collectionLiveness('codex', events, at).verdict, 'turns-without-tokens', 'without the record, the ledger alone blames the wrapper');

  recordRelayOutcome(config, { ok: true }, { now: '2026-09-23T11:00:00.000Z' });
  assert.equal(collectionLiveness('codex', events, { ...at, relay: readRelayRecord(config) }).verdict, 'turns-without-tokens',
    'a good record after the failure means recording works again');
});

test('doctor reports the relay\'s last recorded turn and its latest failure', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  backdateInstalls(config, '2026-09-23T08:00:00.000Z');
  recordRelayOutcome(config, { ok: true }, { now: '2026-09-23T09:00:00.000Z' });
  const at = { now: '2026-09-23T12:00:00.000Z', projectDir: root, homeDir: path.join(root, 'home') };
  assert.deepEqual(check(runDoctor(config, config.installStateFile, at), 'codex-relay'),
    { id: 'codex-relay', status: 'ok', detail: 'last recorded turn: 2026-09-23T09:00:00.000Z.' });

  recordRelayOutcome(config, { ok: false, stage: 'read', error: { name: 'MissingPayload' }, payload: 'none' }, { now: '2026-09-23T10:00:00.000Z' });
  const relay = check(runDoctor(config, config.installStateFile, at), 'codex-relay');
  assert.equal(relay?.status, 'warn', relay?.detail);
  assert.equal(relay.detail, 'last recorded turn: 2026-09-23T09:00:00.000Z; 1 failed run(s) after it, the latest at 2026-09-23T10:00:00.000Z in read (MissingPayload; no JSON argument, and nothing on stdin, reached the relay).');
});

// Codex runs whatever `notify` says after every turn. A relay replaced by
// another tool, or removed by hand, after install leaves Codex never starting
// it - a cause of "no Codex turns at all" nothing else reported.
test('a notify line replaced after install is reported, because Codex then never starts the relay', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const [key] = Object.keys(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs);
  assert.equal(check(runDoctor(config, config.installStateFile, { projectDir: root }), `${key}:codex-notify`)?.status, 'ok');

  const file = paths(root).codexConfig;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^notify = .*$/m, 'notify = ["/usr/bin/other-notifier"]'));
  const replaced = check(runDoctor(config, config.installStateFile, { projectDir: root }), `${key}:codex-notify`);
  assert.equal(replaced?.status, 'warn', `got ${JSON.stringify(replaced)}`);
  assert.match(replaced.detail, /runs a different notifier, so Codex does not start Tokenwatch's relay/);
  assert.doesNotMatch(replaced.detail, /other-notifier/, 'the other notifier is never quoted');
});

// The more common case, found on a real machine: notify already belonged to
// another tool at install time, so install left it alone and never wrote a
// relay. doctor printed no codex-notify line at all, while collection:codex
// told the user to check that very line.
test('a relay that install declined to write over another notifier is reported, not passed over in silence', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const file = paths(root).codexConfig;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'notify = ["/usr/bin/other-notifier", "turn"]\n');
  const record = install(config, options(root, { agents: 'codex' }));
  assert.equal(record.codex.notifyLine, undefined, 'install must still leave the other notifier alone without --force');
  const [key] = Object.keys(JSON.parse(fs.readFileSync(config.installStateFile, 'utf8')).installs);

  const notify = check(runDoctor(config, config.installStateFile, { projectDir: root }), `${key}:codex-notify`);
  assert.equal(notify?.status, 'warn', `got ${JSON.stringify(notify)}`);
  assert.match(notify.detail, /Tokenwatch's Codex relay was never installed: .* already ran another notifier at install time/, notify.detail);
  // A project record's remedy reinstalls that project, not the user scope.
  assert.ok(notify.detail.includes(`To add the relay: tokenwatch install --agents codex --scope project --project "${root}" --force.`), notify.detail);
  assert.doesNotMatch(notify.detail, /other-notifier/, 'the other notifier is never quoted');
});

// ---- Intent 04: a composed status line ------------------------------------
function composedProject(root) {
  const project = path.join(root, 'project');
  const shared = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool status --secret-flag' } }));
  return { project, shared, local: path.join(project, '.claude', 'settings.local.json') };
}

test('doctor reports a composed status line whose source command changed since install, and never quotes it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { project, shared, local } = composedProject(root);
  install(config, { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills'), compose: true });
  const key = projectKey(project);
  const composeCheck = () => runDoctor(config, config.installStateFile).checks.find((check) => check.id === `${key}:claude-status-compose`);

  assert.equal(composeCheck()?.status, 'ok', JSON.stringify(composeCheck()));
  fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool status --new-version' } }));
  const drift = composeCheck();
  assert.equal(drift.status, 'warn');
  assert.match(drift.detail, /entry 1 of 1 \(.*\): changed since install/);
  assert.match(drift.detail, /Run: tokenwatch install --agents claude --scope project --project ".*" --repair$/);
  assert.doesNotMatch(drift.detail, /other-tool|secret-flag|new-version/, 'neither command is quoted');

  fs.writeFileSync(shared, JSON.stringify({}));
  assert.match(composeCheck().detail, /no longer sets a statusLine/);
});

test('doctor reports a composed record edited by hand and a recorded Git Bash that is gone', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { project, local } = composedProject(root);
  install(config, { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills'), compose: true });
  const key = projectKey(project);
  const edit = (change) => {
    const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
    change(state.installs[key].claude.compose[0]);
    fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  };
  const composeCheck = () => runDoctor(config, config.installStateFile).checks.find((check) => check.id === `${key}:claude-status-compose`);
  edit((compose) => { compose.command = 'something else entirely'; });
  assert.match(composeCheck().detail, /edited by hand \(it does not match its recorded hash\)/);
  edit((compose) => { compose.command = 'other-tool status --secret-flag'; compose.shell = 'bash'; compose.shellPath = path.join(root, 'no', 'bash.exe'); });
  const gone = composeCheck();
  assert.equal(gone.status, 'warn');
  assert.match(gone.detail, /Git Bash missing/);
});

// Intent 16, D13: one check per agent, however many entries, each named by
// its place and file, never by its command.
test('doctor reports every composed entry in one check, naming the one that drifted by its place', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { project, shared, local } = composedProject(root);
  install(config, { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills'), compose: true });
  const key = projectKey(project);
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const [first] = state.installs[key].claude.compose;
  const second = { ...first, command: 'second-tool --token-in-argv', sha256: crypto.createHash('sha256').update('second-tool --token-in-argv').digest('hex') };
  state.installs[key].claude.compose = [{ ...first, level: 'target', carried: true }, second];
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const checks = () => runDoctor(config, config.installStateFile).checks.filter((check) => check.id === `${key}:claude-status-compose`);
  assert.equal(checks().length, 1, 'one check for the agent');
  const [check] = checks();
  assert.equal(check.status, 'warn', JSON.stringify(check));
  assert.match(check.detail, /entry 1 of 2 \(.*\): kept from an earlier install/);
  assert.match(check.detail, new RegExp(`entry 2 of 2 \\(${shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): changed since install`));
  assert.doesNotMatch(check.detail, /second-tool|token-in-argv|other-tool/, 'no command is quoted');
  state.installs[key].claude.compose = [{ ...first, level: 'target', carried: true }];
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  assert.equal(checks()[0].status, 'info', 'an entry that can no longer be checked is not called healthy');
  state.installs[key].claude.compose = Array.from({ length: 5 }, () => ({ ...first, level: 'target' }));
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  assert.match(checks()[0].detail, /5 entries recorded; only the first 4 run/);
  assert.equal(checks()[0].status, 'warn');
});

test('doctor parses a composed status command to the same executable and script as a plain one', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const p = paths(root);
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: { type: 'command', command: 'other-status' } }));
  const record = install(config, options(root, { compose: true }));
  const plainRoot = tempDir();
  const plain = install(testConfig(path.join(plainRoot, 'state')), options(plainRoot));
  assert.ok(record.claude.statusCommand.startsWith(`${plain.claude.statusCommand} `),
    `the composed command must be the plain one with arguments appended: ${record.claude.statusCommand}`);
  assert.match(record.claude.statusCommand.slice(plain.claude.statusCommand.length), /--compose/);
  const executables = runDoctor(config, config.installStateFile).checks.filter((check) => check.id.endsWith(':node-executable') || /is recorded in an installed command/.test(check.detail));
  assert.equal(executables.filter((check) => check.status !== 'ok').length, 0, `a composed command must still start with Node and this CLI: ${JSON.stringify(executables)}`);
  const location = runDoctor(config, config.installStateFile).checks.filter((check) => check.id.endsWith(':install-location'));
  assert.ok(location.every((check) => !/no longer exists/.test(check.detail)), JSON.stringify(location));
});

test('doctor never calls a composed record healthy that the render refuses to run', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const { project, local } = composedProject(root);
  install(config, { agents: 'claude', scope: 'project', project, homeDir: path.join(root, 'home'), claudeSettings: local, claudeSkills: path.join(project, '.claude', 'skills'), compose: true });
  const key = projectKey(project);
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  state.installs[key].claude.compose[0].shell = 'bash';
  delete state.installs[key].claude.compose[0].shellPath;
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
  const check = runDoctor(config, config.installStateFile).checks.find((c) => c.id === `${key}:claude-status-compose`);
  assert.equal(check.status, 'warn', JSON.stringify(check));
  assert.match(check.detail, /refused by the render gate/);
  assert.doesNotMatch(check.detail, /other-tool|secret-flag/);
});

// A session state file cut short - a full disk, a crash mid-copy, a sync tool -
// used to stop `doctor` dead: `tokenwatch: Cannot read JSON ...`, exit 1, and no
// report at all, from the one command meant to explain what is wrong. The store
// cannot load such a file either, so that session silently stops recording;
// doctor now names the file instead of dying on it or skipping it.
test('a corrupt session state file is reported by name, not fatal to doctor', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T10:00:00.000Z', 'broken-session'), config);
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T10:00:00.000Z', 'healthy-session'), config);
  const broken = sessionStateFile(config, 'broken-session');
  const healthy = sessionStateFile(config, 'healthy-session');
  // A readable file still counts: its refusals must not vanish with the broken one.
  const readable = JSON.parse(fs.readFileSync(healthy, 'utf8'));
  readable.counters = { ...readable.counters, unkeyed: 2 };
  fs.writeFileSync(healthy, JSON.stringify(readable));
  fs.writeFileSync(broken, '{"counters":{"unkeyed":7},"note":"SECRET STATE TEXT');
  fs.writeFileSync(config.stateFile, '{"counters":');

  let report;
  assert.doesNotThrow(() => { report = runDoctor(config, config.installStateFile); }, 'doctor must report, not abort');
  const unreadable = check(report, 'session-state:unreadable');
  assert.equal(unreadable?.status, 'warn', `got ${JSON.stringify(unreadable)}`);
  assert.ok(unreadable.detail.includes(broken), `the broken file is named: ${unreadable.detail}`);
  assert.ok(unreadable.detail.includes(config.stateFile), `the shared state file is named too: ${unreadable.detail}`);
  assert.ok(!unreadable.detail.includes(healthy), `a readable file is not named: ${unreadable.detail}`);
  assert.doesNotMatch(unreadable.detail, /SECRET STATE TEXT|position \d/, 'no parser message quoting the file');
  const keys = check(report, 'cumulative-session-keys');
  assert.equal(keys?.status, 'warn', `got ${JSON.stringify(keys)}`);
  assert.match(keys.detail, /^2 cumulative record\(s\)/, `only the readable file's count, not the broken one's 7: ${keys.detail}`);
  assert.equal(report.ok, true, 'a warning, not a failure');
});

// A clean count beside an unreadable file must not read as "every cumulative
// record carried a session id": that would vouch for a file doctor never read.
test('with an unreadable state file, cumulative-session-keys does not vouch for it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  storeEvent(hook('claude', 'SessionStart', '2026-09-23T10:00:00.000Z', 'broken-session'), config);
  fs.writeFileSync(sessionStateFile(config, 'broken-session'), '{');
  const keys = check(runDoctor(config, config.installStateFile), 'cumulative-session-keys');
  assert.equal(keys?.status, 'ok', `got ${JSON.stringify(keys)}`);
  assert.match(keys.detail, /1 file\(s\) could not be read \(see session-state:unreadable\)/, keys.detail);
});

// `otlp-bind` kept its own list of loopback names while `otlp-receiver` asked
// `isLoopbackHost()`, so `LOCALHOST` was warned about on one line and connected
// to as loopback on the next. One definition now decides both.
test('otlp-bind and otlp-receiver agree on what counts as loopback', () => {
  const root = tempDir();
  for (const host of ['LOCALHOST', ' localhost ', '::ffff:127.0.0.1']) {
    const config = testConfig(path.join(root, 'state'));
    config.codex = { ...config.codex, otlpHost: host };
    const bind = check(runDoctor(config, config.installStateFile), 'otlp-bind');
    assert.equal(bind?.status, 'ok', `${JSON.stringify(host)} is loopback to the receiver check, so otlp-bind must agree: ${bind?.detail}`);
    assert.match(bind.detail, /a loopback address/, bind.detail);
  }
  const exposed = testConfig(path.join(root, 'state'));
  exposed.codex = { ...exposed.codex, otlpHost: '0.0.0.0' };
  assert.equal(check(runDoctor(exposed, exposed.installStateFile), 'otlp-bind')?.status, 'warn', 'every interface is still warned about');
});

// Every other time-dependent check is judged at the `now` doctor is handed;
// retention read the wall clock, so a replayed situation got today's verdict.
test('retention is judged at the instant doctor is given, not the wall clock', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  config.retentionDays = 90;
  storeEvent(hook('claude', 'SessionStart', '2026-01-01T00:00:00.000Z'), config);
  const inside = check(runDoctor(config, config.installStateFile, { now: '2026-02-01T00:00:00.000Z' }), 'retention');
  assert.equal(inside?.status, 'ok', `31 days is inside 90: ${inside?.detail}`);
  assert.match(inside.detail, /^oldest event is 31d old/, inside.detail);
  const past = check(runDoctor(config, config.installStateFile, { now: Date.parse('2026-06-01T00:00:00.000Z') }), 'retention');
  assert.equal(past?.status, 'warn', `151 days is past 90: ${past?.detail}`);
  assert.match(past.detail, /^oldest event is 151d old/, past.detail);
});

// doctor observes; it does not set up. Its write check used to create the data
// directory on a machine where nothing had recorded yet.
test('doctor does not create a missing data directory, and says it is not created yet', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'not-yet', 'state'));
  const report = runDoctor(config, config.installStateFile);
  assert.equal(fs.existsSync(path.join(root, 'not-yet')), false, 'doctor must not create the data directory');
  const write = check(report, 'data-directory-write');
  assert.equal(write?.status, 'info', `got ${JSON.stringify(write)}`);
  assert.match(write.detail, /not created yet/, write.detail);
  assert.ok(write.detail.includes(root), `names the existing directory it would be created in: ${write.detail}`);
  assert.equal(check(report, 'data-directory-permissions'), undefined, 'no mode to report for a directory that is not there');
});

test('a data directory that could not be created is an error, not a note', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs POSIX directory modes and a non-root user' : false }, () => {
  const root = tempDir();
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked, { mode: 0o500 });
  try {
    const config = testConfig(path.join(locked, 'home'));
    const write = check(runDoctor(config, config.installStateFile), 'data-directory-write');
    assert.equal(write?.status, 'error', `got ${JSON.stringify(write)}`);
    assert.ok(write.detail.includes(locked), write.detail);
    assert.equal(fs.existsSync(path.join(locked, 'home')), false, 'and nothing was created');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

// ---- Every remedy names the record's own scope --------------------------
// A bare `tokenwatch install --force` reinstalls every agent at user scope: on
// a project record it writes other files and leaves the project as it was.
// Each hint below was built scope-correctly with nothing to prove it, so
// reverting any one of them to a flat command left the suite green.
const projectReinstall = (root, agents) => `tokenwatch install --agents ${agents} --scope project --project "${root}" --force`;

// A test stand-in for another Tokenwatch: it leaves a mark if it is ever run.
function olderTokenwatch(root) {
  const older = path.join(root, 'older', 'tokenwatch.mjs');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(root, 'older-ran'))}, 'ran\\n');\n`);
  return older;
}

// Doctor probes Copilot's status line only while its settings file still holds
// the command the record says it wrote, so both change together.
function rewriteCopilotStatus(root, config, next) {
  const file = paths(root).copilotConfig;
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = JSON.parse(fs.readFileSync(config.installStateFile, 'utf8'));
  const record = Object.values(state.installs)[0].copilot;
  settings.statusLine.command = next(record.statusCommand);
  record.statusCommand = settings.statusLine.command;
  fs.writeFileSync(file, JSON.stringify(settings));
  fs.writeFileSync(config.installStateFile, JSON.stringify(state));
}

test('shared skills where Codex does not look name the reinstall for their own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const misplaced = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:shared-skills:location`);
  assert.ok(misplaced?.detail.endsWith(`Reinstall without --shared-skills: ${projectReinstall(root, 'codex')}`), JSON.stringify(misplaced));
});

test('a shared skill Codex would skip names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const shared = path.join(root, '.agents', 'skills');
  install(config, options(root, { agents: 'codex', sharedSkills: shared }));
  const file = path.join(shared, 'tw-retrospective-this-session', 'SKILL.md');
  fs.writeFileSync(file, `﻿${fs.readFileSync(file, 'utf8')}`);
  const skipped = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:shared:tw-retrospective-this-session:codex`);
  assert.ok(skipped?.detail.endsWith(`Reinstall the bundled text with: ${projectReinstall(root, 'codex')}`), JSON.stringify(skipped));
});

test('an edited shared skill names the reinstall for its own project and every agent that reads it', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'copilot,codex' }));
  fs.appendFileSync(path.join(paths(root).sharedSkills, 'tw-explain-statusline', 'SKILL.md'), '\nedited\n');
  const modified = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:shared:tw-explain-statusline:modified`);
  assert.ok(modified?.detail.endsWith(projectReinstall(root, 'copilot,codex')), JSON.stringify(modified));
});

test('a Copilot hook that fails in its shell names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const hooksFile = installCopilot(root, config);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const [entry] = document.hooks.sessionStart;
  entry.bash = entry.bash.slice(0, -1);
  entry.powershell = entry.powershell.slice(0, -1);
  fs.writeFileSync(hooksFile, JSON.stringify(document));
  const failed = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:copilot-hook:sessionStart`);
  assert.equal(failed?.status, 'error', JSON.stringify(failed));
  assert.ok(failed.detail.endsWith(`Reinstall with: ${projectReinstall(root, 'copilot')}`), failed.detail);
});

test('a Copilot status line that fails in its shell names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installCopilot(root, config);
  // A pipe with nothing after it: a syntax error for /bin/sh and cmd.exe alike.
  // Dropping the closing quote, as the hook case does, is not one for cmd.exe,
  // which runs a line whose last quote is unterminated, so Copilot would too.
  rewriteCopilotStatus(root, config, (command) => `${command} |`);
  const failed = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:copilot-status-run`);
  assert.equal(failed?.status, 'error', JSON.stringify(failed));
  assert.ok(failed.detail.endsWith(`Reinstall with: ${projectReinstall(root, 'copilot')}`), failed.detail);
});

test('Copilot hooks from a different Tokenwatch name the reinstall for their own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const hooksFile = installCopilot(root, config);
  const older = olderTokenwatch(root);
  const document = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  for (const [eventName, [entry]] of Object.entries(document.hooks)) {
    entry.bash = `'${process.execPath}' '${older}' 'hook' 'copilot' '${eventName}'`;
    entry.powershell = `& '${process.execPath}' '${older}' 'hook' 'copilot' '${eventName}'`;
  }
  fs.writeFileSync(hooksFile, JSON.stringify(document));
  const foreign = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:copilot-hooks-run`);
  assert.equal(foreign?.status, 'warn', JSON.stringify(foreign));
  assert.ok(foreign.detail.endsWith(`Reinstall with this version to check them: ${projectReinstall(root, 'copilot')}`), foreign.detail);
  assert.equal(fs.existsSync(path.join(root, 'older-ran')), false);
});

test('a Copilot status line from a different Tokenwatch names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installCopilot(root, config);
  const older = olderTokenwatch(root);
  rewriteCopilotStatus(root, config, () => `'${process.execPath}' '${older}' 'status' '--agent' 'copilot' '--ingest-stdin'`);
  const foreign = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:copilot-status-run`);
  assert.equal(foreign?.status, 'warn', JSON.stringify(foreign));
  assert.ok(foreign.detail.endsWith(`Reinstall with this version to check them: ${projectReinstall(root, 'copilot')}`), foreign.detail);
  assert.equal(fs.existsSync(path.join(root, 'older-ran')), false);
});

test('Claude Code hooks from a different Tokenwatch name the reinstall for their own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const older = olderTokenwatch(root);
  rewriteClaudeCommands(root, config, { hook: (eventName) => `'${process.execPath}' '${older}' 'hook' 'claude' '${eventName}'` });
  const foreign = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:claude-hooks-run`);
  assert.equal(foreign?.status, 'warn', JSON.stringify(foreign));
  assert.ok(foreign.detail.endsWith(`Reinstall with this version to check them: ${projectReinstall(root, 'claude')}`), foreign.detail);
  assert.equal(fs.existsSync(path.join(root, 'older-ran')), false);
});

test('a Claude Code status line from a different Tokenwatch names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  installClaudeHere(root, config);
  const older = olderTokenwatch(root);
  rewriteClaudeCommands(root, config, { status: () => `'${process.execPath}' '${older}' 'status' '--agent' 'claude' '--ingest-stdin'` });
  const foreign = check(runDoctor(config, config.installStateFile), `${projectKey(root)}:claude-status-run`);
  assert.equal(foreign?.status, 'warn', JSON.stringify(foreign));
  assert.ok(foreign.detail.endsWith(`Reinstall with this version to check them: ${projectReinstall(root, 'claude')}`), foreign.detail);
  assert.equal(fs.existsSync(path.join(root, 'older-ran')), false);
});

test('a notify line that no longer runs the relay names the reinstall for its own project', () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  install(config, options(root, { agents: 'codex' }));
  const file = paths(root).codexConfig;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^notify = .*$/m, 'notify = ["/usr/bin/other-notifier"]'));
  const replaced = check(runDoctor(config, config.installStateFile, { projectDir: root }), `${projectKey(root)}:codex-notify`);
  assert.equal(replaced?.status, 'warn', JSON.stringify(replaced));
  assert.ok(replaced.detail.endsWith(`Reinstall with: ${projectReinstall(root, 'codex')}`), replaced.detail);
});

test('a recorded executable that is no longer executable names the reinstall for its own project and the agents it starts', { skip: process.platform === 'win32' ? 'POSIX execute bits only' : false }, () => {
  const root = tempDir();
  const config = testConfig(path.join(root, 'state'));
  const node = path.join(root, 'versions', 'node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, '', { mode: 0o644 });
  const project = path.join(root, 'project');
  fs.mkdirSync(path.dirname(config.installStateFile), { recursive: true });
  fs.writeFileSync(config.installStateFile, JSON.stringify({ version: 1, installs: {
    [projectKey(project)]: { scope: 'project', project, agents: ['claude', 'codex'],
      claude: { statusCommand: `'${node}' '${THIS_CLI}' status --agent claude --ingest-stdin`, hooks: [] },
      codex: { notifyLine: `notify = ${JSON.stringify([node, THIS_CLI, 'notify-relay', '--agent', 'codex'])}` } }
  } }));
  const gone = check(runDoctor(config, config.installStateFile), `${projectKey(project)}:executable`);
  assert.equal(gone?.status, 'error', JSON.stringify(gone));
  assert.ok(gone.detail.endsWith(`Re-run: ${projectReinstall(project, 'claude,codex')}`), gone.detail);
});
