import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, CLAUDE_HOOK_EVENTS, COMPOSE_SHELLS, COPILOT_HOOK_EVENTS, INSTALL_VERSION, MANAGED_TAG, MAX_COMPOSE_COMMAND_CHARS, MAX_COMPOSE_COMMANDS, MAX_JSON_EDIT_BYTES, MAX_JSON_EDIT_DEPTH } from './constants.mjs';
import { atomicWriteJson, ensureDir, fileExists, identityPath, readJson, readJsonc, removeEmptyParents, resolvePath, writeTextAtomic } from './fs-util.mjs';
import { claudeSettingsChain, classifyStatusLineCommand, isTokenwatchStatusLine, statusLineAt, statusLineShadowMessage, winningClaudeStatusLine } from './claude-settings.mjs';
import { claudeShell, findOnPath } from './spawn.mjs';
import { applyInverse, editToValue, inverseEdits, parseJsonDocument } from './json-edit.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/tokenwatch.mjs', import.meta.url));
const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url));

// One argv, rendered for the shell that will parse it. A command string is only
// correct relative to a shell, and writing one form for every platform is what
// made Copilot deny every tool call on Windows: it runs hooks through
// PowerShell, which does not execute a quoted path without the `&` call
// operator, so the hook failed to parse before Tokenwatch's own fail-open code
// could run.
//
// - `posix`: single quotes, a quote closed, escaped and reopened. Bash and sh.
// - `powershell`: the `&` call operator and single-quoted arguments, where a
//   quote is escaped by doubling it. PowerShell also treats the typographic
//   quotes U+2018-U+201B as single quotes, so `O’Brien` in a profile path would
//   end the string early unless those are doubled too.
// - `cmd`: double quotes, the form cmd.exe accepts. Copilot CLI's Windows
//   status line.
// - `gitbash-or-powershell`: Claude Code on Windows, which runs a command
//   through Git Bash when installed and PowerShell otherwise, and Tokenwatch
//   cannot know which at the moment a command runs. A bare `node` first word
//   followed by double-quoted words reads back identically in both. The `&`
//   form PowerShell needs for a quoted first word is a Bash syntax error, exit
//   2, which Claude Code treats as a block on `UserPromptSubmit` and `Stop`, so
//   it is never written for Claude (intent 17, D2). A word only one of the two
//   shells would read unchanged is refused, not written (D3).
const POWERSHELL_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

// Characters Git Bash and PowerShell treat differently inside double quotes,
// or that end the quoted word early in one of them.
const PORTABLE_REFUSALS = [
  [/"/, 'U+0022 (quotation mark)'],
  [/\$/, 'U+0024 (dollar sign)'],
  [/`/, 'U+0060 (grave accent)'],
  [/\\\\/, 'two consecutive backslashes'],
  [/\\$/, 'a trailing backslash'],
  [/[\u0000-\u001f\u007f]/, 'a control character'],
  [/\u201c/, 'U+201C (left double quotation mark)'],
  [/\u201d/, 'U+201D (right double quotation mark)'],
  [/\u201e/, 'U+201E (double low-9 quotation mark)'],
  [/\u201f/, 'U+201F (double high-reversed-9 quotation mark)']
];
function portableWord(text) {
  for (const [pattern, name] of PORTABLE_REFUSALS) {
    if (pattern.test(text)) {
      throw new Error(`Cannot write a Claude Code command that Git Bash and PowerShell both read the same way: a path contains ${name}. Move Tokenwatch, or the project it is installed for, to a path without it.`);
    }
  }
  return `"${text}"`;
}
const QUOTERS = {
  posix: (text) => `'${text.replaceAll("'", `'\\''`)}'`,
  powershell: (text) => `'${text.replace(POWERSHELL_QUOTES, '$&$&')}'`,
  cmd: (text) => `"${text.replaceAll('"', '\\"')}"`,
  'gitbash-or-powershell': portableWord
};

export function renderCommand(argv, shell) {
  const quote = QUOTERS[shell];
  if (!quote) throw new Error(`Unknown shell: ${shell}`);
  if (shell === 'gitbash-or-powershell' && argv[0] !== 'node') {
    throw new Error('A command for both Git Bash and PowerShell starts with the bare word node');
  }
  const words = argv.map((value, index) => (shell === 'gitbash-or-powershell' && index === 0 ? 'node' : quote(String(value))));
  return shell === 'powershell' ? `& ${words.join(' ')}` : words.join(' ');
}

function defaultShell(platform = process.platform) {
  return platform === 'win32' ? 'cmd' : 'posix';
}

// Every command Tokenwatch writes for Claude Code, for a given Node, CLI path
// and platform, so a test can render the Windows forms on any operating system.
// Off Windows: the pinned Node and CLI, single-quoted, as always. On Windows:
// `node` from PATH, which is what makes one string parse in both shells; the
// CLI path stays verbatim, so runsThisCli still recognises every command.
export function claudeCommands({ node = process.execPath, cli = CLI_PATH, platform = process.platform, composeKey } = {}) {
  const commandShell = platform === 'win32' ? 'gitbash-or-powershell' : 'posix';
  const render = (parts) => renderCommand([commandShell === 'posix' ? node : 'node', cli, ...parts], commandShell);
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((eventName) => [eventName, render(['hook', 'claude', eventName])]));
  const status = render(['status', '--agent', 'claude', '--ingest-stdin', ...(composeKey ? ['--compose', composeKey] : [])]);
  return { hooks, status, commandShell };
}

// On Windows the installed commands run whichever `node` Claude Code's shell
// finds on PATH, not the one running this install. Said at install, never
// refused: the user may well fix PATH afterwards (intent 17, D10).
export function nodeOnPathWarning({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform !== 'win32') return undefined;
  const found = findOnPath('node', env, platform);
  if (found && identityPath(found) === identityPath(execPath)) return undefined;
  return `Claude Code will run Tokenwatch with the node found on PATH (${found ?? 'none'}), not the one running this install (${execPath}).${found ? '' : ' Install Node 20+ on PATH.'}`;
}

// Every command Tokenwatch writes for Copilot, for a given Node and CLI path.
// Exported with those as parameters so a test can render them for a Windows
// profile path with spaces and apostrophes on any operating system.
//
// Hook entries follow the hook reference
// (https://docs.github.com/en/copilot/reference/hooks-reference): "On POSIX
// systems, the `bash` field executes; on Windows, `powershell` executes", and
// the cross-platform `command` field is only a fallback, so it is not written.
// `timeoutSec` is the documented timeout key; a timeout is fail-open for every
// event, so it bounds how long a slow start can hold the agent up.
//
// The status line is not a hook. Copilot CLI 1.0.86's bundle (app.js, the
// status-line runner) spawns `statusLine.command` with Node's `shell: true` on
// Windows, which is cmd.exe rather than PowerShell, and on POSIX whenever the
// command is not a file path, which is /bin/sh. Nothing in GitHub's
// documentation states this, so it is read from the shipped code and the
// rendering follows it: the `&` form would not run under cmd.exe at all.
export function copilotCommands({ node = process.execPath, cli = CLI_PATH, platform = process.platform, composeKey } = {}) {
  const hooks = {};
  for (const eventName of COPILOT_HOOK_EVENTS) {
    const argv = [node, cli, 'hook', 'copilot', eventName];
    hooks[eventName] = [{
      type: 'command',
      bash: renderCommand(argv, 'posix'),
      powershell: renderCommand(argv, 'powershell'),
      timeoutSec: 5
    }];
  }
  const status = renderCommand([node, cli, 'status', '--agent', 'copilot', '--ingest-stdin', ...(composeKey ? ['--compose', composeKey] : [])], defaultShell(platform));
  return { hooks, status };
}

// True for a Copilot hook file Tokenwatch wrote itself, in this or an older
// version. A file every one of whose commands runs `tokenwatch … hook copilot …`
// must be rewritten rather than preserved: older versions registered the
// fail-closed `preToolUse`, and leaving that file in place, or recording it as
// the "prior" file to restore on uninstall, would keep the hook that denied
// every tool call.
//
// At user scope a file from any install path counts - an earlier install from a
// temporary or since-moved folder is still ours. At project scope the file may
// have arrived with a clone, written by someone else's Tokenwatch, so only one
// pointing at this installation's CLI counts, and anything else stays theirs.
const OWN_COPILOT_HOOK = /tokenwatch(?:\.mjs)?['"]?\s+['"]?hook['"]?\s+['"]?copilot['"]?\s/i;

function ownCopilotHooksFile(document, userScope) {
  const hooks = document?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const commands = Object.values(hooks).flatMap((entries) => (Array.isArray(entries) ? entries : [])
    .flatMap((entry) => [entry?.command, entry?.bash, entry?.powershell].filter((value) => value !== undefined)));
  return commands.length > 0 && commands.every((command) => typeof command === 'string'
    && OWN_COPILOT_HOOK.test(`${command} `) && (userScope || managedCommand(command)));
}

function normalizeAgents(input) {
  const values = !input || input === 'all' ? AGENTS : String(input).split(',').map((value) => value.trim()).filter(Boolean);
  for (const value of values) if (!AGENTS.includes(value)) throw new Error(`Unknown agent: ${value}`);
  return [...new Set(values)];
}

// Exported so a test names a record, and every doctor check id built from it,
// by the same rule install used, rather than by the path as it was typed.
export function installKey(scope, project) {
  // `identityPath`, not `path.resolve`: on Windows the same project reached
  // from `c:\dev\proj` and `C:\dev\proj` must be one install record, or an
  // uninstall from the other spelling reports nothing to remove.
  return scope === 'user' ? 'user' : `project:${identityPath(project)}`;
}

function loadInstallState(config) {
  return readJson(config.installStateFile, { version: INSTALL_VERSION, installs: {} });
}

// The install record as the two "what may Tokenwatch execute" resolvers read
// it, on the render and relay paths where nothing may fail the agent's own
// display: an unreadable record is no record, so nothing is executed and the
// caller carries on. install, uninstall and doctor keep the strict read, so a
// corrupt file is reported and never overwritten (intent 04 review, HIGH 1).
function recordedAgent(config, installIdentifier, agent) {
  try {
    return loadInstallState(config).installs?.[installIdentifier]?.[agent];
  } catch {
    return undefined;
  }
}

function saveInstallState(config, state) {
  atomicWriteJson(config.installStateFile, state);
}

function resolvedPaths(scope, project, options = {}) {
  const root = scope === 'user' ? os.homedir() : path.resolve(project);
  // Installed commands embed this machine's Node path and install directory, so a
  // project-scoped install belongs in the developer-local settings file rather
  // than the one committed and shared with the rest of the team.
  const claudeSettingsFile = scope === 'user' ? 'settings.json' : 'settings.local.json';
  return {
    claudeSettings: resolvePath(options.claudeSettings || path.join(root, '.claude', claudeSettingsFile)),
    claudeSkills: resolvePath(options.claudeSkills || path.join(root, '.claude', 'skills')),
    copilotConfig: resolvePath(options.copilotConfig || path.join(root, '.copilot', 'settings.json')),
    copilotHooks: resolvePath(options.copilotHooks || (scope === 'user'
      ? path.join(root, '.copilot', 'hooks', 'tokenwatch.json')
      : path.join(root, '.github', 'hooks', 'tokenwatch.json'))),
    sharedSkills: resolvePath(options.sharedSkills || path.join(root, '.agents', 'skills')),
    codexConfig: resolvePath(options.codexConfig || path.join(root, '.codex', 'config.toml'))
  };
}

// An agent's settings file is the user's, so it is edited in place, never
// re-serialised (intent 18). Decisions are still made on the parsed value, by
// the same code as before; src/json-edit.mjs then reaches the resulting value
// by changing only the spans it must. The record keeps what reverses the
// change exactly - hashes and the few spans Tokenwatch replaced - and never
// the file itself, which can hold credentials (decision D1).
const SETTINGS_REFUSALS = {
  unparseable: 'does not parse as JSON (comments allowed)',
  'duplicate-key': 'repeats a key Tokenwatch would edit',
  'too-deep': `nests deeper than ${MAX_JSON_EDIT_DEPTH} levels`,
  'too-large': `is larger than ${MAX_JSON_EDIT_BYTES / (1024 * 1024)} MiB`,
  'not-object': 'does not hold a JSON object at its top level',
  'edit-invariant': 'could not be edited without changing other content',
  comments: 'contains comments, and Claude Code ignores a settings file that does'
};

// Claude Code reads its settings as strict JSON: a file with a comment is
// ignored whole, so hooks written into it would never run (measured on Claude
// Code 2.1.282; a byte-order mark is accepted). Tokenwatch refuses to install
// there rather than report an install that collects nothing (decision D28).
export function settingsRefusalReason(category, agent) {
  return agent === 'claude' && category === 'unparseable' ? 'does not parse as JSON' : SETTINGS_REFUSALS[category] ?? category;
}

// `where` is the install's `{ scope, project }`. The remedy is the command to
// run again once the file is repaired, for that scope: a flat command, run by a
// project-scope user, acts at user scope and leaves the project as it was. It
// is the reinstall for install and a forced reinstall's teardown, and the
// uninstall itself for uninstall (`retry: 'uninstall'`), which a reinstall
// would not finish. The reason text is pinned (intent 18, D4); only the command
// carries the scope.
function settingsRefusal(file, category, agent, where) {
  const next = where?.retry === 'uninstall' ? uninstallCommand(where) : reinstallCommand(where, agent);
  return `${file} was not changed: it ${settingsRefusalReason(category, agent)}. Repair it, then run: ${next}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// The file as it stands: its text, whether it existed, its mode, and its value
// or the reason it cannot be edited. An empty or whitespace-only file holds {}.
function openSettings(file) {
  let text = '';
  let existed = false;
  let mode = null;
  try {
    const stat = fs.statSync(file);
    existed = true;
    mode = stat.mode & 0o777;
    // Refused on its size before it is read. A file that grows between the
    // stat and the read is still refused, by parseJsonDocument's own check.
    if (stat.size > MAX_JSON_EDIT_BYTES) return { text: '', existed, mode, refused: 'too-large' };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!text.trim()) return { text, existed, mode, value: {} };
  const doc = parseJsonDocument(text);
  if (doc.error) return { text, existed, mode, refused: doc.error };
  if (!doc.value || typeof doc.value !== 'object' || Array.isArray(doc.value)) return { text, existed, mode, refused: 'not-object' };
  return { text, existed, mode, value: doc.value, doc };
}

function editSettings(opened, target) {
  if (!opened.text.trim()) {
    const text = `${JSON.stringify(target, null, 2)}\n`;
    return { text, edits: [{ round: 0, order: 0, start: 0, end: opened.text.length, removed: opened.text, inserted: text }], created: Object.keys(target) };
  }
  return editToValue(opened.text, target);
}

// Writes `target` into the file by span edits, with the file's own mode
// (decision D3). Returns the edit result, or `{ refused }` with nothing written.
function writeSettings(file, opened, target, { followSymlink = false } = {}) {
  const edited = editSettings(opened, target);
  if (edited.refused) return edited;
  writeTextAtomic(file, edited.text, opened.mode ?? 0o600, { followSymlink });
  return edited;
}

// Containers Tokenwatch created, two levels deep, so uninstall removes only
// those and never a `"hooks": {}` the user had (risk R-07).
function createdPaths(created, target) {
  const paths = new Set();
  for (const path of created) {
    const parts = path.split('.');
    if (parts.length > 2) continue;
    paths.add(path);
    const value = parts.length === 1 ? target[parts[0]] : undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const key of Object.keys(value)) paths.add(`${path}.${key}`);
  }
  return [...paths];
}

function statusLineText(opened) {
  const member = opened.doc?.root.members.find((entry) => entry.key === 'statusLine');
  return member ? opened.text.slice(member.node.start, member.node.end) : undefined;
}

function fileRecord(opened, edited, target, { replacedStatusLine = false } = {}) {
  const priorStatusLineText = replacedStatusLine ? statusLineText(opened) : undefined;
  return {
    existed: opened.existed,
    priorSha256: opened.existed ? sha256(opened.text) : null,
    writtenSha256: sha256(edited.text),
    mode: opened.mode,
    newline: opened.doc?.newline === '\r\n' ? 'crlf' : 'lf',
    bom: Boolean(opened.doc?.bom),
    createdPaths: createdPaths(edited.created, target),
    inverse: inverseEdits(edited.edits),
    ...(priorStatusLineText !== undefined ? { priorStatusLineText } : {})
  };
}

// The exact pre-install bytes, when the file still holds exactly what
// Tokenwatch wrote; a file Tokenwatch created is removed (decision D2). Returns
// false to fall back to removing Tokenwatch's entries by key.
function restoreExactly(file, record, opened, followSymlink) {
  const saved = record?.file;
  if (!saved || !opened.existed || sha256(opened.text) !== saved.writtenSha256) return false;
  if (!saved.existed) {
    fs.unlinkSync(file);
    return true;
  }
  let prior;
  try { prior = applyInverse(opened.text, saved.inverse); } catch { prior = undefined; }
  if (prior === undefined || sha256(prior) !== saved.priorSha256) return false;
  writeTextAtomic(file, prior, saved.mode ?? 0o600, { followSymlink });
  return true;
}

// On the key-level path a restored status line gets back its original text,
// comments and all, when that text still holds the recorded prior value.
function withPriorStatusLineText(text, record) {
  const prior = record?.file?.priorStatusLineText;
  if (typeof prior !== 'string' || record.priorStatusLine === undefined) return text;
  const doc = parseJsonDocument(text);
  const member = doc.root?.members?.find((entry) => entry.key === 'statusLine');
  const priorValue = parseJsonDocument(prior).value;
  if (!member || !isDeepStrictEqual(member.node.value, priorValue)) return text;
  const spliced = text.slice(0, member.node.start) + prior + text.slice(member.node.end);
  return isDeepStrictEqual(parseJsonDocument(spliced).value, doc.value) ? spliced : text;
}

// Writes the key-level removal, only when it changes the value, keeping the
// file's mode. Returns `{ refused, warning }` when the file cannot be edited.
function removeByKey(file, opened, target, record, agent, followSymlink, where) {
  if (isDeepStrictEqual(opened.value, target)) return {};
  const edited = editSettings(opened, target);
  if (edited.refused) return { refused: edited.refused, warning: settingsRefusal(file, edited.refused, agent, where) };
  writeTextAtomic(file, withPriorStatusLineText(edited.text, record), opened.mode ?? record?.file?.mode ?? 0o600, { followSymlink });
  return {};
}

function managedCommand(command) {
  return runsThisCli(command);
}

// Whether a rendered command runs this very installation's CLI, not merely some
// Tokenwatch. `doctor` needs the narrow answer: it executes installed commands
// in probe mode, and only this CLI is known to honour the probe. A command
// written by an older installation, run the same way, records a real event.
//
// Compared case-insensitively on Windows: the recorded command and the one in
// the settings file can differ only by drive-letter case, which used to make
// our own status line read as a stranger's.
export function runsThisCli(command, { cliPath = CLI_PATH, platform = process.platform } = {}) {
  if (typeof command !== 'string') return false;
  const fold = (text) => platform === 'win32' ? text.toLowerCase() : text;
  return fold(command).includes(fold(cliPath)) && fold(command).includes('tokenwatch');
}

function addClaudeHook(settings, eventName, command) {
  settings.hooks ??= {};
  settings.hooks[eventName] ??= [];
  const entries = settings.hooks[eventName];
  const exists = entries.some((entry) => (entry.hooks ?? []).some((hook) => hook.type === 'command' && hook.command === command));
  if (!exists) entries.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  return !exists;
}

// An emptied container goes only if Tokenwatch created it; a `"hooks": {}` or
// `"Stop": []` the user had stays (intent 18, risk R-07). A record written
// before intent 18 lists nothing as created, so it removes no container.
function removeClaudeHook(settings, eventName, command, created = new Set()) {
  const entries = settings.hooks?.[eventName];
  if (!Array.isArray(entries)) return;
  settings.hooks[eventName] = entries.map((entry) => ({
    ...entry,
    hooks: Array.isArray(entry.hooks) ? entry.hooks.filter((hook) => !(hook.type === 'command' && hook.command === command)) : entry.hooks
  })).filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  if (!settings.hooks[eventName].length && created.has(`hooks.${eventName}`)) delete settings.hooks[eventName];
  if (settings.hooks && !Object.keys(settings.hooks).length && created.has('hooks')) delete settings.hooks;
}

// How each agent's shell runs a status line, recorded with a composed command
// so the replay uses the same one (intent 04, decision D5). Claude Code on
// Windows uses Git Bash when installed and PowerShell otherwise, per its
// status-line documentation; Copilot CLI uses Node's `shell: true`.
export function recordedComposeShell(agent, platform = process.platform, env = process.env) {
  if (platform === 'win32' && agent === 'copilot') return { shell: 'cmd' };
  return claudeShell({ platform, env });
}

// The entry `install --compose` adopts, or the reason it will not. Never one
// that runs Tokenwatch: that would ingest every payload twice and the composed
// command would recurse (decision D9).
function composeCandidate(statusLine, sourceFile, level) {
  const command = statusLine?.command;
  if (typeof command !== 'string' || !command.trim()) return { refused: `${sourceFile} sets a statusLine with no command to compose with.`, because: 'it has no command', sourceFile, level };
  if (command.length > MAX_COMPOSE_COMMAND_CHARS) return { refused: `the statusLine in ${sourceFile} is longer than ${MAX_COMPOSE_COMMAND_CHARS} characters, so it was not adopted.`, because: `it is longer than ${MAX_COMPOSE_COMMAND_CHARS} characters`, sourceFile, level };
  if (isTokenwatchStatusLine(statusLine) || runsThisCli(command)) {
    return { refused: `the statusLine in ${sourceFile} already runs Tokenwatch; composing with it would record every reading twice and could run itself. The status line was left unchanged.`, because: 'tokenwatch', sourceFile, level };
  }
  // Only mentioning the word is not running Tokenwatch: composed, and said so
  // without quoting the command (intent 16, D9).
  const warning = classifyStatusLineCommand(command) === 'mentions'
    ? `the statusLine in ${sourceFile} mentions Tokenwatch but does not run it, so it was composed; if it is a wrapper that itself runs tokenwatch status --ingest-stdin, Tokenwatch's rows will show twice. If it is, install it as the only status line instead.`
    : undefined;
  return { statusLine, sourceFile, level, ...(warning ? { warning } : {}) };
}

function composeRecord(candidate, agent, env = process.env) {
  const { command } = candidate.statusLine;
  return {
    command,
    ...recordedComposeShell(agent, process.platform, env),
    sourceFile: candidate.sourceFile,
    level: candidate.level,
    sha256: crypto.createHash('sha256').update(command).digest('hex'),
    adoptedAt: new Date().toISOString()
  };
}

// `install --compose` for Claude: the other status line is the one in the file
// being written, or - at project scope, when that slot is free - the one that
// outranks it in the project's settings chain, which is only ever read
// (FR-10, FR-11, decision D8).
function claudeComposeCandidate(existing, file, chainFrom) {
  if (existing && !managedCommand(existing.command)) return composeCandidate(existing, file, 'target');
  if (!chainFrom) return null;
  const { winner } = winningClaudeStatusLine(chainFrom);
  // The target itself winning means it holds Tokenwatch's own line (its slot is
  // free or managed by now): nothing to compose. A winner elsewhere goes through
  // composeCandidate, which refuses one that runs Tokenwatch with a warning that
  // says so, rather than "nothing to compose with" (decision D26).
  if (!winner || path.resolve(winner.file) === path.resolve(file)) return null;
  const line = statusLineAt(winner.file);
  // This CLI's own line elsewhere in the chain (a user-scope install, say) is
  // not another tool's: there is nothing to compose with.
  if (managedCommand(line?.command)) return null;
  return composeCandidate(line, winner.file, winner.level);
}

const NOTHING_TO_COMPOSE = 'nothing to compose with; installed the plain status line.';

// Every remedy Tokenwatch prints that runs `install` is built here, for the
// scope of the record it is about (`{ scope, project }`) and naming the agents
// it concerns. A flat `tokenwatch install --force` reinstalls every agent at
// user scope: on a project record that writes other files and leaves the
// project as it was (intent 17, D4, extended to every remedy).
export function installCommand(record, agents, flag) {
  const names = [agents].flat().filter(Boolean);
  return `tokenwatch install${names.length ? ` --agents ${names.join(',')}` : ''}${scopeFlags(record)} ${flag}`;
}

// The same scope, for the other command a remedy can name: an uninstall that
// stopped at a settings file it could not edit finishes with this, once the
// file is repaired. `uninstall` reads only the scope and project.
export function uninstallCommand(record) {
  return `tokenwatch uninstall${scopeFlags(record)}`;
}

function scopeFlags(record) {
  return record?.scope === 'project' ? ` --scope project --project "${record.project}"` : '';
}

// A forced reinstall of `agents` (one name or a list) at the record's scope.
export function reinstallCommand(record, agents) {
  return installCommand(record, agents, '--force');
}

// The command that repairs an agent's composed status line for the scope this
// record belongs to. doctor and install name exactly this string, always in
// full: `tokenwatch repair` is a different command that merges ledger
// fragments (intent 16, D12).
export function repairCommand(record, agent) {
  return installCommand(record, agent, '--repair');
}

const sameComposeEntry = (a, b) => a.sha256 === b.sha256 && a.shell === b.shell && (a.shellPath ?? '') === (b.shellPath ?? '');

// The previous record's entries as a repair carries them over (intent 16,
// D10): one taken from a lower-precedence file is re-read there, dropped when
// that file no longer sets a line or now sets Tokenwatch's, and refreshed when
// its command changed; one taken from the slot itself survives only in the
// record, so it is kept as recorded. `changed` says whether any of that moved.
function carriedComposeEntries(agentRecord) {
  let changed = false;
  const entries = [];
  for (const entry of composeEntries(agentRecord)) {
    if (entry.level === 'target') { entries.push(entry); continue; }
    const line = statusLineAt(entry.sourceFile);
    const command = line?.command;
    if (typeof command !== 'string' || !command.trim() || isTokenwatchStatusLine(line) || runsThisCli(command)) {
      changed = true;
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(command).digest('hex');
    if (sha256 === entry.sha256) { entries.push(entry); continue; }
    changed = true;
    entries.push({ ...entry, command, sha256, adoptedAt: new Date().toISOString() });
  }
  return { entries, changed };
}

// Whether `install --repair` has anything to do for one agent (D11): its slot
// no longer holds Tokenwatch's command, it never installed a status line, a
// carried entry moved, or a line elsewhere in Claude's chain is new.
function repairNeeded(previous, agent, carried, paths, { scope, project, homeDir }) {
  const record = previous?.[agent];
  if (!record?.statusInstalled || carried.changed) return true;
  const file = agent === 'claude' ? record.settingsPath ?? paths.claudeSettings : record.configPath ?? paths.copilotConfig;
  let slot;
  try {
    slot = readJsonc(file)?.statusLine;
  } catch {
    return true;
  }
  if (slot?.command !== record.statusCommand) return true;
  if (agent !== 'claude' || scope !== 'project') return false;
  const candidate = claudeComposeCandidate(slot, file, claudeSettingsChain({ projectDir: project, localFile: file, homeDir }));
  if (!candidate || candidate.refused) return false;
  const hash = crypto.createHash('sha256').update(candidate.statusLine.command).digest('hex');
  return !carried.entries.some((entry) => entry.sha256 === hash);
}

// Carried entries first, in their order, then the newly adopted one unless it
// duplicates one of them or the list is full (D10, FR-32, FR-33). An entry
// from the slot that no longer is what uninstall puts back is marked
// `carried`: doctor can no longer check it for drift (D13).
function mergedComposeEntries(carry, adopted, priorStatusLine) {
  const entries = [];
  for (const entry of carry) if (!entries.some((kept) => sameComposeEntry(kept, entry))) entries.push(entry);
  let warning;
  if (adopted && !entries.some((kept) => sameComposeEntry(kept, adopted))) {
    if (entries.length >= MAX_COMPOSE_COMMANDS) {
      warning = `${MAX_COMPOSE_COMMANDS} other status lines are already composed, which is the most Tokenwatch runs per render; the newest line was not adopted.`;
    } else {
      entries.push(adopted);
    }
  }
  const marked = entries.map((entry) => (entry.level === 'target' && entry.command !== priorStatusLine?.command ? { ...entry, carried: true } : entry));
  return { entries: marked, warning };
}

function notComposedAtRepair(candidate) {
  return `the statusLine in ${candidate.sourceFile} was not composed (${candidate.because === 'tokenwatch' ? 'it runs Tokenwatch' : candidate.because}); the lines composed before are kept.`;
}

function installClaude(paths, userScope = false, { mode = 'off', explicitCompose = false, carry = null, key, chainFrom, env = process.env, rendered, where } = {}) {
  const file = paths.claudeSettings;
  const commands = rendered?.plain ?? claudeCommands();
  const blank = () => ({ settingsPath: file, hooks: [], statusInstalled: false, priorStatusLine: undefined,
    commandShell: commands.commandShell, node: process.execPath });
  const opened = openSettings(file);
  if (opened.doc?.comments) opened.refused = 'comments';
  if (opened.refused) return { ...blank(), refused: opened.refused, warning: settingsRefusal(file, opened.refused, 'claude', where) };
  const settings = structuredClone(opened.value);
  const record = blank();
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const command = commands.hooks[eventName];
    if (addClaudeHook(settings, eventName, command)) record.hooks.push({ eventName, command });
  }
  let statusCommand = commands.status;
  const existing = settings.statusLine;
  const candidate = mode === 'compose' ? claudeComposeCandidate(existing, file, chainFrom) : null;
  // A line in a lower-precedence file that cannot be composed does not stop a
  // default install: Tokenwatch's own line goes into the free slot, which
  // outranks it, as a plain install always did. Only a typed --compose keeps
  // the refusal as the outcome (intent 16, D27).
  const passOver = Boolean(candidate?.refused) && !explicitCompose && candidate.level !== 'target';
  const adoptable = candidate && !candidate.refused && !passOver ? candidate : null;
  if (candidate?.refused && !passOver && !carry?.length) {
    record.warning = candidate.refused;
  } else if (adoptable || carry?.length) {
    statusCommand = (rendered?.composed ?? claudeCommands({ composeKey: key })).status;
    // Whatever the slot held that is not Tokenwatch's is what uninstall puts
    // back, including, at a repair, a line that replaced an earlier one (D10).
    if (existing && !managedCommand(existing.command)) record.priorStatusLine = existing;
    const merged = mergedComposeEntries(carry ?? [], adoptable ? composeRecord(adoptable, 'claude', env) : null, record.priorStatusLine);
    record.compose = merged.entries;
    record.warning = merged.warning ?? (candidate?.refused ? notComposedAtRepair(candidate) : adoptable?.warning);
    // A refreshInterval or padding set for the other line keeps applying to
    // the composed one, which renders it (decision D17).
    const { refreshInterval, padding } = adoptable?.statusLine ?? existing ?? {};
    settings.statusLine = { type: 'command', command: statusCommand,
      ...(refreshInterval !== undefined ? { refreshInterval } : {}), ...(padding !== undefined ? { padding } : {}) };
    record.statusInstalled = true;
  } else if (!existing || managedCommand(existing.command)) {
    settings.statusLine = { type: 'command', command: statusCommand };
    record.statusInstalled = true;
    if (explicitCompose) record.warning = NOTHING_TO_COMPOSE;
    else if (passOver && candidate.because !== 'tokenwatch') {
      record.warning = `the statusLine in ${candidate.sourceFile} could not be composed (${candidate.because}), so Tokenwatch's own status line was installed in ${file}, which takes precedence over it.`;
    }
  } else if (mode === 'hide') {
    record.priorStatusLine = existing;
    settings.statusLine = { type: 'command', command: statusCommand };
    record.statusInstalled = true;
  } else {
    record.warning = 'Claude statusLine already exists; hooks and skill were installed, but the status line was left unchanged. Use --compose to run it beside Tokenwatch\'s, or --force to replace it; uninstall restores it either way.';
  }
  const edited = writeSettings(file, opened, settings, { followSymlink: userScope });
  if (edited.refused) return { ...blank(), refused: edited.refused, warning: settingsRefusal(file, edited.refused, 'claude', where) };
  record.file = fileRecord(opened, edited, settings, { replacedStatusLine: record.priorStatusLine !== undefined });
  record.statusCommand = statusCommand;
  return record;
}

// A free slot in the file Tokenwatch wrote says nothing about the files Claude
// Code reads first. A user-scope install lands in the lowest-precedence file, so
// a project's own `.claude/settings.json` status line still wins there and
// Tokenwatch records hooks but never tokens - the first Windows install, exactly.
// Checked for the project directory the install runs in (a user-scope install
// cannot know every project it will be used from; `doctor` repeats the check
// wherever it is run). Nothing is changed: the other file is not ours to edit.
// When the status line was declined, the existing warning already names the
// same file, so this adds nothing then.
function warnIfStatusLineShadowed(claudeRecord, scope, project, paths) {
  if (!claudeRecord?.statusInstalled) return;
  const chain = claudeSettingsChain(scope === 'user'
    ? { projectDir: project, userFile: paths.claudeSettings }
    : { projectDir: project, localFile: paths.claudeSettings });
  const { winner } = winningClaudeStatusLine(chain);
  if (!winner || winner.tokenwatch) return;
  claudeRecord.warning = `${claudeRecord.warning ? `${claudeRecord.warning} ` : ''}${statusLineShadowMessage(winner, project)}`;
}

// Writes through a user-scope symlink, as install does, so a dotfiles link
// stays a link (risk R-03). Returns `{ refused, warning }` when the file cannot
// be edited; the caller keeps the record so a later retry still works.
function uninstallClaude(record, userScope = false, where) {
  if (!record?.settingsPath || !fileExists(record.settingsPath)) return {};
  if (wroteNothing(record)) return {};
  const opened = openSettings(record.settingsPath);
  if (restoreExactly(record.settingsPath, record, opened, userScope)) return {};
  if (opened.refused) return { refused: opened.refused, warning: settingsRefusal(record.settingsPath, opened.refused, 'claude', where) };
  const settings = structuredClone(opened.value);
  const created = new Set(record.file?.createdPaths ?? []);
  for (const hook of record.hooks ?? []) removeClaudeHook(settings, hook.eventName, hook.command, created);
  if (record.statusInstalled && settings.statusLine?.command === record.statusCommand) {
    if (record.priorStatusLine !== undefined) settings.statusLine = record.priorStatusLine;
    else delete settings.statusLine;
  }
  return removeByKey(record.settingsPath, opened, settings, record, 'claude', userScope, where);
}

// A record saved from a refused install: the settings file was never written,
// so there is nothing in it to take back, and uninstall or a forced reinstall
// must not be stopped by a file that is still broken. Only a record carrying
// the saved refusal and no `file` entry qualifies: a working install whose file
// broke later has both its entries and its `file`, and is held back instead
// (intent 18, D21).
function wroteNothing(record) {
  return Boolean(record?.refused) && !record.file;
}

function installCopilot(paths, force, userScope = false, { mode = 'off', explicitCompose = false, carry = null, key, where } = {}) {
  const configFile = paths.copilotConfig;
  const blank = () => ({
    configPath: configFile,
    hooksPath: paths.copilotHooks,
    hooksCreated: false,
    statusInstalled: false,
    priorStatusLine: undefined
  });
  const opened = openSettings(configFile);
  if (opened.refused) return { ...blank(), refused: opened.refused, warning: settingsRefusal(configFile, opened.refused, 'copilot', where) };
  const settings = structuredClone(opened.value);
  const record = blank();
  // Copilot CLI reads `statusLine.command` as a bare string and spawns it with
  // the status object on stdin. It has no `type` field - that shape is Claude's.
  const commands = copilotCommands();
  let statusCommand = commands.status;
  const existing = settings.statusLine;
  // Copilot's settings layering is not verified, so only the file being written
  // is ever composed with (FR-12, decision D10).
  const candidate = mode === 'compose' && existing && !managedCommand(existing.command)
    ? composeCandidate(existing, configFile, 'target') : null;
  if (candidate?.refused && !carry?.length) {
    record.warning = candidate.refused;
  } else if ((candidate && !candidate.refused) || carry?.length) {
    const adoptable = candidate && !candidate.refused ? candidate : null;
    statusCommand = copilotCommands({ composeKey: key }).status;
    if (existing && !managedCommand(existing.command)) record.priorStatusLine = existing;
    const merged = mergedComposeEntries(carry ?? [], adoptable ? composeRecord(adoptable, 'copilot') : null, record.priorStatusLine);
    record.compose = merged.entries;
    record.warning = merged.warning ?? (candidate?.refused ? notComposedAtRepair(candidate) : adoptable?.warning);
    settings.statusLine = { ...existing, command: statusCommand };
    record.statusInstalled = true;
  } else if (!existing || managedCommand(existing.command)) {
    settings.statusLine = { ...existing, command: statusCommand };
    record.statusInstalled = true;
    if (explicitCompose) record.warning = NOTHING_TO_COMPOSE;
  } else if (mode === 'hide') {
    record.priorStatusLine = existing;
    settings.statusLine = { ...existing, command: statusCommand };
    record.statusInstalled = true;
  } else {
    record.warning = 'Copilot statusLine.command already exists; hooks and skills were installed, but the status line was left unchanged. Use --compose to run it beside Tokenwatch\'s, or --force to replace it; uninstall restores it either way.';
  }
  // The custom footer item defaults to on, so this is only ever a repair of an
  // explicit opt-out: without it Copilot runs the command and prints nothing.
  if (record.statusInstalled && settings.footer?.showCustom === false) {
    record.priorShowCustom = false;
    settings.footer = { ...settings.footer, showCustom: true };
  }
  const edited = writeSettings(configFile, opened, settings, { followSymlink: userScope });
  if (edited.refused) return { ...blank(), refused: edited.refused, warning: settingsRefusal(configFile, edited.refused, 'copilot', where) };
  record.file = fileRecord(opened, edited, settings, { replacedStatusLine: record.priorStatusLine !== undefined });
  record.statusCommand = statusCommand;

  if (fileExists(paths.copilotHooks)) {
    const existingHooks = readJson(paths.copilotHooks, null);
    // Our own file, however old, is replaced without `--force` and never kept
    // as the file to restore: see `ownCopilotHooksFile`.
    if (!ownCopilotHooksFile(existingHooks, userScope)) {
      if (!force) {
        record.warning = `${record.warning ? `${record.warning} ` : ''}${paths.copilotHooks} already exists and was not overwritten.`;
        return record;
      }
      record.priorHooks = existingHooks;
    }
  }
  const hooks = { version: 1, hooks: commands.hooks };
  // The outermost folder this write creates, so uninstall can take it back
  // once it is empty; a folder that was already there is never removed.
  const createdDir = outermostMissingDir(path.dirname(paths.copilotHooks));
  atomicWriteJson(paths.copilotHooks, hooks);
  if (createdDir) record.hooksDirCreated = createdDir;
  record.hooksCreated = true;
  record.hooksHash = crypto.createHash('sha256').update(JSON.stringify(hooks)).digest('hex');
  return record;
}

function outermostMissingDir(dir) {
  let missing;
  for (let current = path.resolve(dir); !fs.existsSync(current); current = path.dirname(current)) {
    missing = current;
    if (path.dirname(current) === current) break;
  }
  return missing;
}

function uninstallCopilot(record, userScope = false, where) {
  let outcome = {};
  if (wroteNothing(record)) return outcome;
  if (record?.configPath && fileExists(record.configPath)) {
    const opened = openSettings(record.configPath);
    if (restoreExactly(record.configPath, record, opened, userScope)) {
      outcome = {};
    } else if (opened.refused) {
      // Nothing of this agent is touched, its hooks file included, so the record
      // still describes what is on disk when the user retries.
      return { refused: opened.refused, warning: settingsRefusal(record.configPath, opened.refused, 'copilot', where) };
    } else {
      const settings = structuredClone(opened.value);
      if (record.statusInstalled && settings.statusLine?.command === record.statusCommand) {
        if (record.priorStatusLine !== undefined) settings.statusLine = record.priorStatusLine;
        else delete settings.statusLine;
        if (record.priorShowCustom === false) settings.footer = { ...settings.footer, showCustom: false };
      }
      outcome = removeByKey(record.configPath, opened, settings, record, 'copilot', userScope, where);
    }
  }
  if (record?.hooksCreated && record.hooksPath && fileExists(record.hooksPath)) {
    const current = readJson(record.hooksPath, null);
    const currentHash = current ? crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex') : null;
    if (currentHash === record.hooksHash) {
      // A record written by an older version may name one of our own earlier
      // hook files as the prior one. Restoring it would bring back whatever it
      // registered, `preToolUse` included, so it is removed like our own file.
      if (record.priorHooks !== undefined && !ownCopilotHooksFile(record.priorHooks, userScope)) atomicWriteJson(record.hooksPath, record.priorHooks);
      else {
        fs.unlinkSync(record.hooksPath);
        // The folders install created for the file go too, while empty. A
        // record from before they were recorded names none, and keeps them.
        if (record.hooksDirCreated) removeEmptyParents(path.dirname(record.hooksPath), path.dirname(record.hooksDirCreated));
      }
    }
  }
  return outcome;
}

// TOML editing below is a scanner rather than a line regex on purpose. A value
// may legitimately span several lines:
//
//   notify = [
//     "/usr/bin/my-notifier",
//     "--flag"
//   ]
//
// A `^key\s*=.*$` match ends at the first newline, so replacing "the line" used
// to leave the remaining elements orphaned and the file invalid - and Codex
// then refuses to load config.toml at all and will not start. A telemetry tool
// must never be able to stop the agent it observes. The scanner also tracks
// bracket depth, so an array element written at the start of a line is never
// mistaken for a `[table]` header.

function endOfLine(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline + 1;
}

const TOML_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

// Reads the single-line TOML string opening at `index` - a `"basic"` string
// with escapes, or a `'literal'` one without - and returns the index just past
// its closing quote together with its decoded value. The one string lexer is
// shared by the bracket scanner, which only needs `end`, and the array reader
// below, which needs the value. `value` is undefined when a basic string holds
// an escape TOML 1.0 does not define, because guessing what it meant is how a
// path would come to be compared wrongly.
function readTomlString(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  let value = '';
  let valid = true;
  while (cursor < text.length && text[cursor] !== quote) {
    if (quote === '"' && text[cursor] === '\\') {
      const escape = text[cursor + 1];
      const width = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
      const hex = width ? text.slice(cursor + 2, cursor + 2 + width) : '';
      if (width && new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) valid = false;
        else value += String.fromCodePoint(code);
        cursor += 2 + width;
        continue;
      }
      if (TOML_ESCAPES[escape] === undefined) valid = false;
      else value += TOML_ESCAPES[escape];
      cursor += 2;
      continue;
    }
    value += text[cursor];
    cursor += 1;
  }
  return { end: cursor + 1, value: valid && cursor < text.length ? value : undefined };
}

// Given the index of an opening `[` or `{`, returns the index just past its
// match, or -1 when the value is unterminated. Quoted strings and comments are
// skipped so a bracket inside them does not change depth.
function endOfBracketedValue(text, openIndex) {
  const closers = { '[': ']', '{': '}' };
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      index = readTomlString(text, index).end;
      continue;
    }
    if (character === '#') { index = endOfLine(text, index); continue; }
    if (closers[character]) { depth += 1; index += 1; continue; }
    if (character === ']' || character === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return -1;
}

// Walks the document's top-level section, before the first table header.
// Returns where that section ends and, when `wanted` is given, the exact range
// of that key's assignment. `unterminated` means a value opened a bracket that
// never closed, in which case callers must refuse to edit rather than guess.
function scanTopLevel(text, wanted) {
  let index = 0;
  let sectionEnd = text.length;
  let found;
  while (index < text.length) {
    const lineStart = index;
    let cursor = index;
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
    const character = text[cursor];
    if (character === undefined) break;
    if (character === '\n' || character === '\r' || character === '#') { index = endOfLine(text, cursor); continue; }
    if (character === '[') { sectionEnd = lineStart; break; }
    const lineEnd = endOfLine(text, cursor);
    const equals = text.indexOf('=', cursor);
    if (equals === -1 || equals >= lineEnd) { index = lineEnd; continue; }
    let valueStart = equals + 1;
    while (valueStart < text.length && (text[valueStart] === ' ' || text[valueStart] === '\t')) valueStart += 1;
    let valueEnd;
    if (text[valueStart] === '[' || text[valueStart] === '{') {
      valueEnd = endOfBracketedValue(text, valueStart);
      if (valueEnd === -1) return { sectionEnd: text.length, found: undefined, unterminated: true };
    } else {
      valueEnd = lineEnd;
    }
    const key = text.slice(cursor, equals).trim();
    if (key === wanted && !found) found = { start: lineStart, end: valueEnd };
    index = Math.max(valueEnd, lineEnd > valueEnd ? valueEnd : lineEnd);
    if (index <= lineStart) index = lineEnd;
  }
  return { sectionEnd, found };
}

function topLevelLine(text, key) {
  const { found } = scanTopLevel(text, key);
  return found ? text.slice(found.start, found.end).replace(/\r?\n$/, '') : undefined;
}

// True when the document cannot be edited safely, i.e. a top-level value opens
// a bracket that never closes. Rewriting such a file would compound the damage.
function tomlIsUneditable(text) {
  return Boolean(scanTopLevel(text).unterminated);
}

function replaceTopLevelLine(text, key, newLine) {
  const { sectionEnd, found, unterminated } = scanTopLevel(text, key);
  if (unterminated) return text;
  if (found) {
    // The new line keeps whatever ended the value it replaces: a CRLF, or
    // nothing at the end of a file with no final newline. A newline of its own
    // there would come back on uninstall as a byte the user never wrote.
    const rest = text.slice(found.end);
    const endsLine = /\n$/.test(text.slice(found.start, found.end));
    const trailing = !endsLine && (rest === '' || /^\r?\n/.test(rest)) ? '' : '\n';
    return `${text.slice(0, found.start)}${newLine}${trailing}${rest}`;
  }
  const head = text.slice(0, sectionEnd);
  const tail = text.slice(sectionEnd);
  // Only a file with no table and no final newline gets here with a head that
  // does not end a line. The new line then starts a line of its own and ends
  // the file the way it was ended, without a newline, so `removeTopLevelLine`
  // can take back exactly the one line break added before it.
  if (head && !head.endsWith('\n')) return `${head}\n${newLine}${tail}`;
  return `${head}${newLine}\n${tail}`;
}

function removeTopLevelLine(text, key, expectedLine) {
  const { found, unterminated } = scanTopLevel(text, key);
  if (unterminated || !found) return text;
  const span = text.slice(found.start, found.end);
  const current = span.replace(/\r?\n$/, '');
  if (expectedLine && current.trim() !== expectedLine.trim()) return text;
  const rest = text.slice(found.end);
  // A last line with no newline of its own was appended after a line break
  // that `replaceTopLevelLine` added; that break goes with it.
  if (rest === '' && !/\n$/.test(span)) return text.slice(0, found.start).replace(/\r?\n$/, '');
  return `${text.slice(0, found.start)}${rest.replace(/^\r?\n/, '')}`;
}

function tomlArray(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(', ')}]`;
}

// Reads a `key = [ ... ]` assignment, as `topLevelLine` returns it, into its
// string values. The array may span lines and carry comments and a trailing
// comma; its extent comes from the same bracket scanner that edits the file.
// Anything that is not a flat array of single-line strings yields undefined
// rather than a best guess.
//
// This exists because deciding by searching the raw line for a path does not
// work: TOML escapes backslashes, so on Windows the file holds
// `C:\\Users\\...\\tokenwatch.mjs` while the path searched for is
// `C:\Users\...\tokenwatch.mjs`, and Tokenwatch failed to recognise its own
// relay there.
function tomlStringArray(line) {
  if (typeof line !== 'string') return undefined;
  let index = line.indexOf('=') + 1;
  if (index === 0) return undefined;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  if (line[index] !== '[') return undefined;
  const close = endOfBracketedValue(line, index);
  if (close === -1) return undefined;
  const values = [];
  let expectValue = true;
  index += 1;
  while (index < close - 1) {
    const character = line[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') { index += 1; continue; }
    if (character === '#') { index = endOfLine(line, index); continue; }
    if (character === ',' && !expectValue) { expectValue = true; index += 1; continue; }
    if ((character === '"' || character === "'") && expectValue && !line.startsWith(character.repeat(3), index)) {
      const { end, value } = readTomlString(line, index);
      if (value === undefined) return undefined;
      values.push(value);
      expectValue = false;
      index = end;
      continue;
    }
    return undefined;
  }
  return values;
}

// The one rule for "this notify argv is a Tokenwatch relay", used when
// installing, when uninstalling and when deciding what the relay may execute
// (`relaysToSelf` in cli.mjs adds its own, broader run-time check on top).
// Three copies of this decision drifted apart once already: the install-time
// ones searched raw TOML text and so never matched on Windows.
//
// An element is compared as a path normalised for the platform, and folded to
// lower case on Windows exactly as `identityPath` and `managedCommand` do,
// because `c:\users\...` and `C:\Users\...` are one file there. `cliPath` and
// `platform` are parameters so a Windows-shaped relay can be tested on any OS.
export function isTokenwatchRelay(argv, { cliPath = CLI_PATH, platform = process.platform } = {}) {
  if (!Array.isArray(argv)) return false;
  const windows = platform === 'win32';
  const identity = (value) => {
    const normalized = (windows ? path.win32 : path.posix).normalize(String(value));
    return windows ? normalized.toLowerCase() : normalized;
  };
  const self = identity(cliPath);
  return argv.some((value) => String(value) === 'notify-relay' || identity(value) === self);
}

// True when a recorded or existing `notify = [...]` line is one of our relays.
function isTokenwatchRelayLine(line) {
  return isTokenwatchRelay(tomlStringArray(line));
}

// What the top-level `notify` of a Codex config.toml says now, for `doctor`:
// `relay` (one of ours), `other` (someone else's notifier replaced it), `none`
// (no notify line), `missing` (no file) or `unreadable`. Codex runs whatever
// this line says after every turn, so a relay that was installed and later
// replaced or removed is a cause of "no Codex turns at all" that nothing else
// shows. Only the verdict is returned, never the line.
export function codexNotifyState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  const line = topLevelLine(text, 'notify');
  if (line === undefined) return 'none';
  return isTokenwatchRelayLine(line) ? 'relay' : 'other';
}

function otelBlock(config) {
  const endpoint = `http://${config.codex.otlpHost}:${config.codex.otlpPort}${config.codex.otlpPath}`;
  // `protocol` is required by Codex's exporter, and omitting it does not merely
  // disable telemetry - Codex refuses to load config.toml at all and will not
  // start. A telemetry tool must never be able to stop the agent it observes.
  const protocol = config.codex.otlpProtocol === 'binary' ? 'binary' : 'json';
  return [
    `# ${MANAGED_TAG} begin otel`,
    '[otel]',
    'environment = "local"',
    `exporter = { otlp-http = { endpoint = ${JSON.stringify(endpoint)}, protocol = ${JSON.stringify(protocol)} } }`,
    'log_user_prompt = false',
    `# ${MANAGED_TAG} end otel`
  ].join('\n');
}

// Removes exactly the span `installCodex` appended: the managed block from its
// begin line through its end line and that line's newline, plus the one line
// break install put between the file and the block. Nothing else is touched, so
// leading blank lines, spacing and a missing final newline come back as they
// were. A block an earlier version wrote (after the file's trimmed text and one
// blank line) loses the same span, and the head of the file stays as it is.
function removeManagedOtel(text) {
  const tag = MANAGED_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)# ${tag} begin otel[\\s\\S]*?# ${tag} end otel(\\r?\\n|$)`);
  const match = re.exec(text);
  if (!match) return text;
  const head = text.slice(0, match.index + match[1].length).replace(/\r?\n$/, '');
  return `${head}${text.slice(match.index + match[0].length)}`;
}

function installCodex(paths, config, force, installIdentifier, userScope = false, compose = false) {
  const file = paths.codexConfig;
  const original = fileExists(file) ? fs.readFileSync(file, 'utf8') : '';
  let text = original;
  // The relay carries the install it belongs to, so a notification fired by one
  // installation can never look up another installation's recorded notifier.
  const relayArgs = [process.execPath, CLI_PATH, 'notify-relay', '--agent', 'codex', '--install', installIdentifier];
  const notifyLine = `notify = ${tomlArray(relayArgs)}`;
  const existingNotify = topLevelLine(text, 'notify');
  const record = { configPath: file, notifyLine, otelInstalled: false };
  if (tomlIsUneditable(original)) {
    record.notifyLine = undefined;
    record.warning = 'config.toml has an unterminated value and was left untouched. Fix the file, then reinstall.';
    return record;
  }
  if (!existingNotify || isTokenwatchRelayLine(existingNotify)) {
    // Replacing our own relay, or writing a fresh one. Deliberately no
    // `priorNotifyLine`: recording our own relay line as the "previous"
    // notifier would make the relay invoke itself on every turn, forever, and
    // uninstall would then "restore" a relay into a package that may be gone.
    text = replaceTopLevelLine(text, 'notify', notifyLine);
  } else if (force || (compose && userScope && Array.isArray(tomlStringArray(existingNotify)))) {
    text = replaceTopLevelLine(text, 'notify', notifyLine);
    // Recorded so uninstall can put the user's own line back. Whether it may
    // also be *executed* is a separate question, answered in
    // `priorCodexNotify`: restoring a line is harmless, running one is not.
    record.priorNotifyLine = existingNotify;
  } else {
    // Nothing was installed, so nothing is remembered. Recording the prior line
    // here used to hand a repo-supplied `notify` argv to spawn() on every later
    // turn, from an install this branch had just declined to perform.
    record.warning = 'Codex notify is already configured; it was left unchanged. Use --compose at user scope to record turns and forward notifications to the existing notifier, or --force to replace it and restore it on uninstall.';
    record.notifyLine = undefined;
  }
  if (config.codex.installOtelConfig) {
    if (!/^\s*\[otel\]\s*$/m.test(text)) {
      // Appended after one line break, the file's own bytes left as they are,
      // so `removeManagedOtel` can take back exactly this span.
      text = `${text}${text ? '\n' : ''}${otelBlock(config)}\n`;
      record.otelInstalled = true;
    } else {
      record.warning = `${record.warning ? `${record.warning} ` : ''}An existing [otel] section was preserved; confirm that it exports OTLP/HTTP JSON to Tokenwatch.`;
    }
  }
  ensureDir(path.dirname(file));
  writeTextAtomic(file, text, 0o600, { followSymlink: userScope });
  return record;
}

// `userScope` mirrors `installCodex`: a user-scope config.toml linked into a
// dotfiles repository stays a link and is written through, while a project-scope
// link, which may have come with a checkout, is replaced and never followed.
// Returns `{ warning }` when the notifier `--force` displaced was not restored.
function uninstallCodex(record, userScope = false) {
  if (!record?.configPath || !fileExists(record.configPath)) return {};
  const original = fs.readFileSync(record.configPath, 'utf8');
  let text = original;
  let warning;
  if (record.notifyLine) {
    // A recorded predecessor that is itself one of our relays was never the
    // user's notifier. Earlier versions recorded one on Windows, where they
    // failed to recognise their own relay; restoring it would leave Codex
    // calling Tokenwatch, and once the package is removed, a missing script on
    // every turn. Such a record is dropped, so the relay is removed like any
    // other, and a reinstall with `--force` clears it the same way.
    const prior = record.priorNotifyLine && !isTokenwatchRelayLine(record.priorNotifyLine)
      ? record.priorNotifyLine : undefined;
    const current = topLevelLine(text, 'notify');
    if (prior && current !== undefined && isTokenwatchRelayLine(current)) {
      text = replaceTopLevelLine(text, 'notify', prior);
    } else if (prior) {
      // The slot no longer holds Tokenwatch's relay: the user set another
      // notifier, or removed the line, after install. That choice stands, as a
      // status line changed since install does for Claude and Copilot. Named
      // by file only; neither notifier is quoted.
      warning = `${record.configPath}: notify was changed since install, so it was left as it is and the notifier Tokenwatch replaced was not restored.`;
    } else {
      text = removeTopLevelLine(text, 'notify', record.notifyLine);
    }
  }
  if (record.otelInstalled) text = removeManagedOtel(text);
  if (text !== original) writeTextAtomic(record.configPath, text, 0o600, { followSymlink: userScope });
  return warning ? { warning, notifyChanged: true } : {};
}

function skillSource(name) {
  return path.join(SKILLS_ROOT, name, 'SKILL.md');
}

export function bundledSkills() {
  return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fileExists(skillSource(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

// How each agent's user runs an installed skill, printed by `install` but never
// stored: the install record holds only what uninstall needs. The three agents
// use different syntax, and every instruction used to be Claude Code's `/tw-…`,
// which Codex does not recognise. Sources, checked 2026-09-24:
// Claude Code https://code.claude.com/docs/en/skills (`/skill-name`);
// Codex https://learn.chatgpt.com/docs/build-skills ("Run `/skills` or type `$`
// to mention a skill"), `$` as the mention sigil in codex-rs/skills/src/mentions.rs,
// and `$HOME/.agents/skills` read from Codex 0.95.0 on (codex-rs, rust-v0.95.0);
// Copilot CLI https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
// (`/skill-name`, `/skills list`, `/skills reload`).
export function skillUsage(record) {
  const example = 'tw-retrospective-this-session';
  const usage = {};
  const agents = record?.agents ?? [];
  if (agents.includes('claude') && record.claudeSkills?.length) {
    usage.claude = `Type /tw-<name>, for example /${example}.`;
  }
  if (record?.sharedSkills?.length) {
    if (agents.includes('codex')) {
      usage.codex = `Type $tw-<name>, for example $${example}, or pick one from /skills. Codex 0.95.0 or later reads this location; restart Codex if the skills are not listed.`;
    }
    // A Copilot refused at install reads these skills but has no hooks or
    // status line feeding them, so its usage line is not printed.
    if (agents.includes('copilot') && !record.copilot?.refused) {
      usage.copilot = `Type /tw-<name>, for example /${example}. /skills list shows them, and /skills reload loads them into a running session.`;
    }
  }
  return usage;
}

function skillDigest(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// Where a skill's replaced text is kept: beside the install record, owner-only,
// so the record and `install`'s output carry a hash and a path, never the text.
export function skillBackupDir(config) {
  return path.join(path.dirname(config.installStateFile), 'backups', 'skills');
}

// Named by the replaced text's hash and the destination, so two skills that
// held the same text never share one backup, and a later install over a file
// edited since cannot overwrite a backup still waiting to be restored.
function skillBackupFile(backupDir, destination, priorSha256) {
  const where = crypto.createHash('sha256').update(identityPath(destination), 'utf8').digest('hex').slice(0, 16);
  return path.join(backupDir, `${priorSha256}-${where}.md`);
}

function installSkills(destinationDir, force = false, backupDir) {
  return bundledSkills().map((name) => {
    const destination = path.join(destinationDir, name, 'SKILL.md');
    const content = fs.readFileSync(skillSource(name), 'utf8');
    // A skill destination that is a symlink is never touched, and never read.
    // The bundled skill names are public, and a project-scope install writes
    // into a directory that may have arrived with a clone, so this path can be
    // chosen by a repository rather than by the user. Reading through the link
    // would put the target's contents into the install record and onto stdout;
    // writing through it would overwrite the target and relax its mode. Both
    // happened: a committed `.claude/skills/<bundled-name>/SKILL.md` pointing
    // at `~/.ssh/id_rsa` disclosed the key and then destroyed it.
    let linked = false;
    try { linked = fs.lstatSync(destination).isSymbolicLink(); } catch {}
    if (linked) {
      return { name, path: destination, installed: false, warning: `${destination} is a symbolic link and was left untouched. Remove it and reinstall if you want the bundled skill there.` };
    }
    const prior = fileExists(destination) ? fs.readFileSync(destination, 'utf8') : undefined;
    if (prior !== undefined && prior !== content && !force) {
      return { name, path: destination, installed: false, warning: `${destination} already exists and was not overwritten. Pass --force to replace it with the bundled version.` };
    }
    // The text --force replaces can be a customised skill with a team's notes
    // in it, and it used to be stored whole in the record and printed by
    // `install`, into a CI log. It goes to an owner-only backup instead, and
    // the record keeps its hash and where the backup is, as a settings file's
    // record keeps hashes and spans, never the file (intent 18). Written before
    // the skill, so a failed backup leaves the user's text where it was.
    const saved = {};
    if (prior !== undefined) {
      saved.priorSha256 = skillDigest(prior);
      if (prior !== content) {
        saved.backup = skillBackupFile(backupDir, destination, saved.priorSha256);
        ensureDir(backupDir);
        writeTextAtomic(saved.backup, prior, 0o600, { followSymlink: false });
      }
    }
    ensureDir(path.dirname(destination));
    writeTextAtomic(destination, content, 0o644, { followSymlink: false });
    return { name, path: destination, installed: true, sha256: skillDigest(content), ...saved };
  });
}

// Installations made before the bundle held more than one skill recorded a single
// object. Normalize so uninstall still reverses them exactly.
function skillRecords(record, key, legacyKey) {
  if (Array.isArray(record?.[key])) return record[key];
  const legacy = record?.[legacyKey];
  return legacy?.path ? [{ name: 'token-cost-audit', ...legacy }] : [];
}

// The text a forced install replaced, read back only when the backup is a
// regular file (never through a link), inside the backup directory, and still
// hashes to what was recorded. Anything else is a reason, never a guess.
function readSkillBackup(record, backupDir) {
  if (!record.backup || path.dirname(path.resolve(record.backup)) !== path.resolve(backupDir)) return { reason: 'is not where Tokenwatch keeps skill backups' };
  let stat;
  try { stat = fs.lstatSync(record.backup); } catch { return { reason: 'is missing' }; }
  if (!stat.isFile()) return { reason: 'is not a regular file' };
  const text = fs.readFileSync(record.backup, 'utf8');
  if (skillDigest(text) !== record.priorSha256) return { reason: 'no longer matches the text it replaced' };
  return { text };
}

// Returns a warning per skill whose replaced text could not be put back. A
// warning names the files and never quotes either text.
function uninstallSkills(records, backupDir) {
  const warnings = [];
  for (const record of records ?? []) {
    if (!record?.installed || !record.path || !fileExists(record.path)) continue;
    // Only remove a file that still matches what was installed, so edits survive.
    // Compare against the digest recorded at install time, not against the current
    // bundle: after the bundled skill is updated they differ by definition, and
    // comparing to the bundle would mistake our own stale copy for a user edit and
    // pin the install to the old text forever.
    const current = fs.readFileSync(record.path, 'utf8');
    if (record.sha256) {
      if (skillDigest(current) !== record.sha256) {
        // The edit wins, but the text --force replaced must not vanish unseen.
        if (record.backup && record.priorSha256 !== record.sha256) {
          warnings.push(`${record.path} was left in place because it changed after install; the text it replaced is still in ${record.backup}.`);
        }
        continue;
      }
    } else {
      // Records written before the digest existed can only fall back to the bundle.
      const source = fileExists(skillSource(record.name)) ? fs.readFileSync(skillSource(record.name), 'utf8') : undefined;
      if (source !== undefined && current !== source) continue;
    }
    // Records written before backups existed carry the replaced text inline.
    if (record.prior !== undefined) writeTextAtomic(record.path, record.prior, 0o644);
    else if (record.priorSha256 !== undefined) {
      // The file held the bundled text already before install: it stays.
      if (record.priorSha256 === record.sha256) continue;
      const backup = readSkillBackup(record, backupDir);
      if (backup.text === undefined) {
        warnings.push(`${record.path} was left in place: the backup of the text it replaced, ${record.backup}, ${backup.reason}.`);
        continue;
      }
      writeTextAtomic(record.path, backup.text, 0o644, { followSymlink: false });
      fs.unlinkSync(record.backup);
    } else {
      fs.unlinkSync(record.path);
      removeEmptyParents(path.dirname(record.path), path.dirname(path.dirname(path.dirname(record.path))));
    }
  }
  return warnings;
}

export function install(config, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const project = resolvePath(options.project || process.cwd());
  const state = loadInstallState(config);
  const key = installKey(scope, project);
  const previous = state.installs[key];
  // `--repair` is a reinstall of the status-line agents with what they composed
  // carried over, so it needs a previous record and does not need --force
  // (intent 16, D3, D28).
  const repair = options.repair === true;
  if (repair && options.compose === false) throw new Error('--repair composes; --no-compose leaves the slot alone; pass one of them');
  if (repair && !previous) throw new Error(`nothing to repair for ${key}; run tokenwatch install`);
  const agents = repair
    ? normalizeAgents(options.agents ?? previous.agents?.join(',')).filter((agent) => agent === 'claude' || agent === 'copilot')
    : normalizeAgents(options.agents);
  // Nothing evaluated is not "nothing to repair" (review, H3; D32).
  if (repair && !agents.length) throw new Error('--repair acts on claude and copilot, the agents with a command-backed status line; none of them is named or recorded for this install');
  // Where this install lands, for every remedy it prints.
  const where = { scope, project: scope === 'project' ? project : undefined };
  // Assessed before anything is written: every command below embeds this path,
  // so the time to say it will not last is before it is copied into each agent.
  // Its remedy reinstalls these agents at this scope from a durable copy.
  const location = runningInstallLocation({ rerun: reinstallCommand(where, agents) });
  // A repair edits the files the install recorded, unless a path is typed:
  // the defaults would name a different file after a custom-path install.
  // A record written before `paths` was kept still names every file a repair
  // touches: its settings files in its agent records, and its skill folders in
  // its skill records (each `<folder>/<skill>/SKILL.md`). codexConfig is not
  // edited by a repair, which leaves Codex alone, but is carried so the saved
  // `paths` still names Codex's file (review, H3; D32, D33, D34).
  const skillRoot = (records) => (records[0]?.path ? path.dirname(path.dirname(records[0].path)) : undefined);
  const recorded = previous?.paths ?? Object.fromEntries(Object.entries({
    claudeSettings: previous?.claude?.settingsPath,
    copilotConfig: previous?.copilot?.configPath,
    copilotHooks: previous?.copilot?.hooksPath,
    codexConfig: previous?.codex?.configPath,
    claudeSkills: skillRoot(skillRecords(previous, 'claudeSkills', 'claudeSkill')),
    sharedSkills: skillRoot(skillRecords(previous, 'sharedSkills', 'sharedSkill'))
  }).filter(([, value]) => value));
  const paths = repair
    ? Object.fromEntries(Object.entries(resolvedPaths(scope, project, options)).map(([name, value]) => [name, options[name] ? value : recorded[name] ?? value]))
    : resolvedPaths(scope, project, options);
  // `--force` hides the other status line and `--compose` keeps it; on a first
  // install they contradict each other. With a previous record, `--force` only
  // means "reinstall" (FR-14, FR-15).
  if (options.compose === true && options.force && !previous) {
    throw new Error('--compose keeps the existing status line and --force hides it; pass one of them');
  }
  // What a taken status-line slot gets (intent 16, D1): composed by default,
  // left alone with --no-compose, hidden with --force unless --compose or
  // --repair was typed too.
  const composeMode = options.compose === false ? 'off'
    : options.repair === true ? 'compose'
      : options.force && options.compose !== true ? 'hide' : 'compose';
  const explicitCompose = options.compose === true;
  const reinstall = Boolean(options.force) || repair;
  if (previous && !reinstall) throw new Error(`Tokenwatch is already installed for ${key}. Run uninstall first or pass --force.`);
  // Taken before the teardown, which forgets them (D10).
  const carried = repair ? Object.fromEntries(agents.map((agent) => [agent, carriedComposeEntries(previous[agent])])) : {};
  if (repair && agents.every((agent) => !repairNeeded(previous, agent, carried[agent], paths, { scope, project, homeDir: options.homeDir }))) {
    // Nothing moved: nothing is written, so a healthy install's settings files
    // and record stay byte for byte as they were (D11).
    return { repaired: false, reason: 'nothing to repair', key };
  }
  // Tear down only what is about to be reinstalled. Installing one agent used to
  // uninstall the others sharing this scope - their hooks removed, their status
  // lines reverted - because a scope holds one record for every agent. Adding an
  // agent later is the documented path, so this silently undid earlier installs.
  const sharedUsers = ['copilot', 'codex'];
  // Rendered, and so refused if a path cannot be written for both Windows
  // shells, before anything is torn down: a refusal leaves the previous install
  // working rather than removed (intent 17, review).
  const env = options.env ?? process.env;
  const renderFor = { platform: options.platform ?? process.platform, ...(options.cliPath ? { cli: options.cliPath } : {}) };
  const rendered = agents.includes('claude')
    ? { plain: claudeCommands(renderFor), composed: composeMode === 'compose' ? claudeCommands({ ...renderFor, composeKey: key }) : undefined }
    : undefined;
  // A settings file the teardown cannot edit holds that agent back: its old
  // record and entries stay exactly as they were, it is not reinstalled, and
  // the refusal is reported, so repairing the file and running install again
  // still finds everything Tokenwatch wrote (intent 18 review, H1).
  const heldBack = {};
  const backupDir = skillBackupDir(config);
  const skillWarnings = [];
  const teardownWarnings = [];
  if (previous && reinstall) {
    if (agents.includes('claude')) {
      const outcome = uninstallClaude(previous.claude, scope === 'user', where);
      if (outcome.refused) heldBack.claude = outcome;
      else skillWarnings.push(...uninstallSkills(skillRecords(previous, 'claudeSkills', 'claudeSkill'), backupDir));
    }
    if (agents.includes('copilot')) {
      const outcome = uninstallCopilot(previous.copilot, scope === 'user', where);
      if (outcome.refused) heldBack.copilot = outcome;
    }
    if (agents.includes('codex')) {
      // A notify line changed since install is the user's choice. The teardown
      // leaves it, and the reinstall below displaces it under --force and
      // records it as the notifier uninstall restores, so the one install
      // displaced first is no longer recorded. Said, never silently dropped;
      // neither notifier is quoted.
      const outcome = uninstallCodex(previous.codex, scope === 'user');
      if (outcome.notifyChanged) {
        teardownWarnings.push(`${previous.codex.configPath}: notify was changed since install, so the notifier Tokenwatch replaced then was not restored and is no longer recorded. The notify setting found now is what uninstall restores.`);
      }
    }
    if (sharedUsers.some((agent) => agents.includes(agent)) && !heldBack.copilot) {
      skillWarnings.push(...uninstallSkills(skillRecords(previous, 'sharedSkills', 'sharedSkill'), backupDir));
    }
  }
  const reinstalling = (agent) => agents.includes(agent) && !heldBack[agent];
  // Agents left alone keep the records that describe how to remove them later.
  const retained = previous && reinstall
    ? Object.fromEntries(Object.entries({
      claude: reinstalling('claude') ? undefined : previous.claude,
      claudeSkills: reinstalling('claude') ? undefined : previous.claudeSkills ?? previous.claudeSkill,
      copilot: reinstalling('copilot') ? undefined : previous.copilot,
      codex: agents.includes('codex') ? undefined : previous.codex,
      sharedSkills: sharedUsers.some((agent) => agents.includes(agent)) && !heldBack.copilot
        ? undefined : previous.sharedSkills ?? previous.sharedSkill
    }).filter(([, value]) => value !== undefined))
    : {};
  // A settings file refused at install is install state (owner decision,
  // option B, amending intent 18 D4 and D25): the agent's record is saved with
  // `refused` and `warning`, it gets no skills, and `doctor` reports it until an
  // install succeeds. A held-back teardown is different: its record describes
  // a working install whose file broke later, so that refusal is this
  // command's result only, returned and never saved (D21, D25).
  const refusals = { ...heldBack };
  const stillInstalled = (previous?.agents ?? []).filter((agent) => !agents.includes(agent));
  const record = {
    ...retained,
    version: INSTALL_VERSION,
    scope,
    project: scope === 'project' ? project : undefined,
    paths,
    agents: [...new Set([...stillInstalled, ...agents])],
    installedAt: new Date().toISOString()
  };
  // A user-scope path was chosen by the user, so following a symlink there is
  // the dotfiles pattern working as intended. A project-scope path may have
  // arrived with a clone, so following a link there would let a repository
  // pick what this installer overwrites.
  const userScope = scope === 'user';
  try {
    if (reinstalling('claude')) {
      record.claude = installClaude(paths, userScope, {
        mode: composeMode,
        explicitCompose,
        carry: carried.claude?.entries ?? null,
        key,
        chainFrom: scope === 'project' ? claudeSettingsChain({ projectDir: project, localFile: paths.claudeSettings, homeDir: options.homeDir }) : undefined,
        env,
        rendered,
        where
      });
      // A refused Claude has no hooks and no status line, so it gets no skills
      // either: they would send the user to data that is not being collected.
      if (!record.claude.refused) {
        warnIfStatusLineShadowed(record.claude, scope, project, paths);
        const nodeWarning = nodeOnPathWarning({ platform: renderFor.platform, env });
        if (nodeWarning) {
          record.claude.nodeWarning = nodeWarning;
          record.claude.warning = `${record.claude.warning ? `${record.claude.warning} ` : ''}${nodeWarning}`;
        }
        record.claudeSkills = installSkills(paths.claudeSkills, Boolean(options.force), backupDir);
      }
    }
    if (reinstalling('copilot')) {
      record.copilot = installCopilot(paths, Boolean(options.force), userScope, { mode: composeMode, explicitCompose, carry: carried.copilot?.entries ?? null, key, where });
    }
    if (agents.includes('codex')) record.codex = installCodex(paths, config, Boolean(options.force), key, userScope, explicitCompose);
    // The shared skills, once, when this run touched an agent that reads them
    // and one that is instrumented still does: Codex, or a Copilot whose
    // settings file was not refused. A retained Codex keeps its skills even
    // when this run's Copilot is refused, since the teardown above removed them.
    const readsShared = (record.codex !== undefined) || (record.copilot !== undefined && !record.copilot.refused);
    if (record.sharedSkills === undefined && readsShared && (reinstalling('copilot') || agents.includes('codex'))) {
      record.sharedSkills = installSkills(paths.sharedSkills, Boolean(options.force), backupDir);
    }
  } finally {
    // Whatever succeeded before a failure is still recorded, so `uninstall` can
    // undo it. A malformed config for the second agent used to abort the whole
    // function after the first agent's hooks were already written, leaving
    // changes on disk that nothing knew about and nothing could remove.
    state.installs[key] = record;
    saveInstallState(config, state);
  }
  const result = { ...record };
  // A replaced skill the teardown could not put back, or a Codex notifier it
  // could not restore, is reported with this command's result, like a
  // refusal, and never saved.
  if (skillWarnings.length) result.skillWarnings = skillWarnings;
  if (teardownWarnings.length) result.warnings = teardownWarnings;
  // How to run the skills, per agent, is read from the record as saved,
  // before a retained agent's refusal is left out of the result below: that
  // agent is still refused, and is not told to use skills that read nothing.
  // Output only, never stored in the record.
  result.skillUsage = skillUsage(record);
  // An agent this command left alone carries its saved refusal in the record,
  // but it is not this command's news: printing it again would report an old
  // refusal as if it had just happened (D25). `doctor` keeps reporting it.
  for (const agent of ['claude', 'copilot']) {
    if (!agents.includes(agent) && result[agent]?.refused) {
      const { refused, warning, ...rest } = result[agent];
      result[agent] = rest;
    }
  }
  for (const [agent, { refused, warning }] of Object.entries(refusals)) result[agent] = { ...result[agent], refused, warning };
  if (repair) {
    result.repaired = true;
    for (const agent of agents) if (result[agent]) result[agent] = { ...result[agent], composeEntryCount: composeEntries(result[agent]).length };
  }
  // --force over a composed install hides what it composed; say how to keep it (FR-34, D17).
  for (const agent of ['claude', 'copilot']) {
    if (composeMode === 'hide' && reinstalling(agent) && composeEntries(previous?.[agent]).length && result[agent]) {
      const n = composeEntries(previous[agent]).length;
      const note = `the previous install composed ${n} other status line(s); --force hides them. To keep them, run: ${repairCommand(record, agent)}`;
      result[agent] = { ...result[agent], warning: `${result[agent].warning ? `${result[agent].warning} ` : ''}${note}` };
    }
  }
  // Reported with the result but not saved in the record: it is not needed to
  // reverse the install, and `doctor` re-assesses the recorded path anyway.
  return location.status === 'ok' ? result : { ...result, installLocation: location };
}

export function uninstall(config, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const project = resolvePath(options.project || process.cwd());
  const state = loadInstallState(config);
  const key = installKey(scope, project);
  const record = state.installs[key];
  if (!record) return { removed: false, key };
  // A file it cannot edit names this uninstall, at this scope, as the command
  // to run once the file is repaired: the record it keeps is for exactly that.
  const where = { scope, project: scope === 'project' ? project : undefined, retry: 'uninstall' };
  const claude = uninstallClaude(record.claude, scope === 'user', where);
  const copilot = uninstallCopilot(record.copilot, scope === 'user', where);
  const codex = uninstallCodex(record.codex, scope === 'user');
  // A settings file that could not be edited keeps its agent's record and
  // skills, so repairing the file and running uninstall again finishes the job
  // (intent 18, FR-12); every other agent is removed as usual.
  const backupDir = skillBackupDir(config);
  const skillWarnings = [
    ...(claude.refused ? [] : uninstallSkills(skillRecords(record, 'claudeSkills', 'claudeSkill'), backupDir)),
    ...(copilot.refused ? [] : uninstallSkills(skillRecords(record, 'sharedSkills', 'sharedSkill'), backupDir))
  ];
  const kept = Object.entries({ claude, copilot }).filter(([, outcome]) => outcome.refused).map(([agent]) => agent);
  if (kept.length) {
    state.installs[key] = {
      ...Object.fromEntries(Object.entries(record).filter(([name]) => !['claude', 'claudeSkills', 'claudeSkill', 'copilot', 'codex', 'sharedSkills', 'sharedSkill'].includes(name))),
      agents: kept,
      ...(claude.refused ? { claude: record.claude, claudeSkills: record.claudeSkills ?? record.claudeSkill } : {}),
      ...(copilot.refused ? { copilot: record.copilot, sharedSkills: record.sharedSkills ?? record.sharedSkill } : {})
    };
  } else {
    delete state.installs[key];
  }
  saveInstallState(config, state);
  const warnings = [claude.warning, copilot.warning, codex.warning].filter(Boolean);
  return { removed: true, key, record, ...(kept.length ? { kept } : {}), ...(warnings.length ? { warnings } : {}), ...(skillWarnings.length ? { skillWarnings } : {}) };
}

export function listInstalls(config) {
  return loadInstallState(config).installs;
}

// Resolves the notifier Tokenwatch displaced for ONE installation, so the
// result can be spawned. This function decides what gets executed, so every
// condition below is a security check rather than a convenience.
//
// It used to scan every install record in insertion order with no scope filter
// and no check that anything had been installed. A repository carrying a
// committed `.codex/config.toml` could therefore get its `notify` argv recorded
// by a project-scope install that explicitly declined to install it, and then
// executed on every later turn of an unrelated user-scope session.
// The other half of a composed status line: the one other program Tokenwatch
// runs for a status render (intent 04, FR-03). It sits beside priorCodexNotify
// so the two rules for "what may Tokenwatch execute" are read together. It
// differs from that function's project-scope refusal on consent: a composed
// command was adopted by someone typing `install --compose` for exactly this
// install key, and it is the command the agent already runs for that project
// behind its own workspace-trust prompt. A notifier line was merely found.
// Since intent 16 it returns every entry the record composes with, in order,
// at most MAX_COMPOSE_COMMANDS of them, or null when there is none.
export function composedStatusCommand(config, installIdentifier, agent) {
  if (!installIdentifier || (agent !== 'claude' && agent !== 'copilot')) return null;
  const record = recordedAgent(config, installIdentifier, agent);
  if (!record?.statusInstalled) return null;
  const specs = composeEntries(record).map(composeSpec).filter(Boolean).slice(0, MAX_COMPOSE_COMMANDS);
  return specs.length ? specs : null;
}

// Every entry an agent's record composes with, in adoption order: a list since
// intent 16, one object before it, which is read for as long as such records
// exist (D4). This is the only reader of `compose`.
export function composeEntries(agentRecord) {
  const compose = agentRecord?.compose;
  const entries = Array.isArray(compose) ? compose : compose ? [compose] : [];
  return entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

// What a render may run for one entry, or null when the gate refuses it.
export function composeSpec(entry) {
  const { command, shell, shellPath } = entry ?? {};
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMPOSE_COMMAND_CHARS) return null;
  // Never compose with ourselves: a wrapper around `tokenwatch status` would
  // ingest every payload twice, and the composed command would recurse (D9).
  if (isTokenwatchStatusLine({ command }) || runsThisCli(command)) return null;
  if (!COMPOSE_SHELLS.includes(shell)) return null;
  // A bash record names the Git Bash it was installed for; a bare `bash` would
  // resolve on Windows to whatever bash.exe comes first on PATH, WSL's
  // included, which is what findGitBash exists to avoid.
  if (shell === 'bash' && (typeof shellPath !== 'string' || !/(^|[\\/])bash(\.exe)?$/i.test(shellPath))) return null;
  return { command, shell, ...(shell === 'bash' ? { shellPath } : {}) };
}

export function priorCodexNotify(config, installIdentifier) {
  if (!installIdentifier) return null;
  const record = recordedAgent(config, installIdentifier, 'codex');
  // No relay of our own was installed, so no notifier was displaced and there
  // is nothing this installation is entitled to run.
  if (!record?.notifyLine || !record.priorNotifyLine) return null;
  // A line that is not a flat array of strings is not an argv this function
  // can vouch for, so it is not run.
  const argv = tomlStringArray(record.priorNotifyLine);
  if (!argv?.length) return null;
  // Never relay into ourselves, which would respawn forever. `installCodex`
  // refuses to record such a line, but earlier versions recorded one on
  // Windows, where they searched raw TOML text for a path TOML had escaped.
  // Refusing it here makes a record already on disk inert.
  if (isTokenwatchRelay(argv)) return null;
  // A project-scope `.codex/config.toml` can arrive with a clone, so the argv
  // in it was chosen by whoever wrote the repository. Uninstall still restores
  // that line, because it is the user's file and removing it would lose their
  // own notifier - but nothing here will execute it. Adopting a notifier is a
  // user-scope act.
  if (installIdentifier !== 'user') return null;
  return argv;
}

// Where the installed commands point.
//
// Every hook, status line and notify relay embeds the absolute path of this
// CLI. `npm install -g .` from a source folder, like `npm link`, installs a
// link to that folder rather than a copy, and Node resolves the link before it
// loads anything, so the path written into each agent's configuration is the
// source folder itself. On the first Windows install that folder was in
// %TEMP%, so every agent's hooks would have broken the moment it was cleaned
// up, with nothing to say why. It was noticed by accident.
//
// This is reported, not refused. A temporary directory is the one case where
// refusing would be defensible, but the installer never decides for the user
// elsewhere either - a conflict is left alone with a warning - and a refusal
// would need an override flag whose only use is to say "I know". The warning
// names the command that installs a real copy instead.

// `rerun` is the reinstall for the install concerned (`reinstallCommand`); the
// bare form is left only where no single install is meant, as for the CLI
// that is running `doctor`.
const saferInstall = (rerun = 'tokenwatch install --force') => `Install a copy instead: in the source folder run \`npm pack\`, then \`npm install -g ./agent-tokenwatch-<version>.tgz\` (or \`npm install -g agent-tokenwatch\`), and re-run \`${rerun}\` from that copy.`;

const SEVERITY = { ok: 0, info: 1, warn: 2, error: 3 };

// Containment for a path of either platform's shape, on any OS, so a
// Windows-shaped case is tested on Linux too. Folded to lower case on Windows,
// as `identityPath` does, because `C:\Users\Me` and `c:\users\me` are one
// folder there.
function locatedInside(child, parent, platform) {
  if (!parent) return false;
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value) => {
    const normalized = flavour.normalize(String(value));
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const relative = flavour.relative(fold(parent), fold(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(relative));
}

function temporaryRoots(platform, tmpdirs, home) {
  // A temp directory configured to contain the home directory would make every
  // install look temporary, which is a configuration to ignore, not report.
  const configured = tmpdirs.filter((dir) => dir && !locatedInside(home, dir, platform));
  if (platform === 'win32') {
    return [...configured, home && path.win32.join(home, 'AppData', 'Local', 'Temp'), 'C:\\Windows\\Temp'];
  }
  // macOS keeps each user's temp directory under /var/folders, reached as
  // /private/var/folders once resolved.
  return [...configured, '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders', '/dev/shm'];
}

// The heuristics, as a pure function of the path and the facts about the
// machine it is judged against, so each platform's shapes are tested on any
// OS. `cliPath` is the real path the commands embed; `linkedVia` is the link
// the CLI was reached through, if any, and `gitCheckout` the checkout it lives
// in - both found on disk by `inspectInstallLocation`. `rerun` is the
// reinstall the warning names.
export function assessInstallLocation(cliPath, {
  linkedVia, gitCheckout, platform = process.platform, tmpdir = os.tmpdir(), home = os.homedir(), rerun
} = {}) {
  const findings = [];
  if (linkedVia) {
    findings.push({ id: 'linked', status: 'warn',
      detail: `it is reached through a link at ${linkedVia} - what \`npm install -g .\` and \`npm link\` create - so every hook depends on the linked folder staying where it is.` });
  }
  const temporary = temporaryRoots(platform, [].concat(tmpdir), home).find((root) => locatedInside(cliPath, root, platform));
  if (temporary) {
    findings.push({ id: 'temporary', status: 'warn',
      detail: `it is inside the temporary directory ${temporary}, which the system or a cleanup tool may empty at any time.` });
  }
  const downloads = home && (platform === 'win32' ? path.win32 : path.posix).join(home, 'Downloads');
  if (downloads && locatedInside(cliPath, downloads, platform)) {
    findings.push({ id: 'downloads', status: 'warn',
      detail: `it is inside ${downloads}, a folder people routinely clear out.` });
  }
  // A checkout is where the maintainer develops from, so it is noted rather
  // than warned about: legitimate, but hooks follow whatever is checked out.
  if (gitCheckout) {
    findings.push({ id: 'git-checkout', status: 'info',
      detail: `it is inside the git checkout ${gitCheckout}. Fine for developing Tokenwatch; the hooks run whatever is checked out and break if the checkout moves.` });
  }
  const status = findings.reduce((worst, finding) => SEVERITY[finding.status] > SEVERITY[worst] ? finding.status : worst, 'ok');
  const warned = findings.filter((finding) => finding.status === 'warn');
  const detail = findings.length
    ? `${cliPath}: ${findings.map((finding) => finding.detail).join(' Also, ')}${warned.length ? ` ${saferInstall(rerun)}` : ''}`
    : `${cliPath} is an installed copy outside any temporary, download or checkout folder.`;
  return { status, path: cliPath, findings, detail };
}

function realPathOf(file) {
  try { return fs.realpathSync(file); } catch { return undefined; }
}

// The entry the CLI was invoked through, with file-level links followed: npm's
// POSIX `bin/tokenwatch` is itself a link to the package's own entry, which is
// normal. Only the package folder being a link is the fragile case.
function followEntryLinks(entry) {
  let current = path.resolve(entry);
  for (let hops = 0; hops < 8; hops += 1) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return undefined; }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  return undefined;
}

// The nearest enclosing folder that holds a `.git` entry (a directory, or a
// file in a worktree). The walk stops at a `node_modules` folder, because a
// package installed inside some project is a copy of Tokenwatch, not its
// source, and before the home directory, which may itself be a dotfiles repo.
function enclosingCheckout(file, home) {
  let dir = path.dirname(file);
  while (true) {
    if (path.basename(dir) === 'node_modules') return undefined;
    if (home && identityPath(dir) === identityPath(home)) return undefined;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Gathers what the pure assessment needs from the disk. `cliPath` is a path as
// written into a command; `invokedPath` is how this process was started, which
// Node does not resolve (`process.argv[1]`), and is the only place a linked
// package folder is still visible once Node has resolved the modules.
export function inspectInstallLocation(cliPath, { invokedPath, rerun } = {}) {
  const real = realPathOf(cliPath);
  if (real === undefined) {
    return { status: 'error', path: cliPath, findings: [{ id: 'missing', status: 'error', detail: 'it no longer exists.' }],
      detail: `${cliPath} no longer exists, so every hook and status line that runs it does nothing. ${saferInstall(rerun)}` };
  }
  let linkedVia;
  if (identityPath(cliPath) !== identityPath(real)) linkedVia = cliPath;
  else if (invokedPath) {
    const entry = followEntryLinks(invokedPath);
    const packageRoot = entry && path.dirname(path.dirname(entry));
    let linked = false;
    try { linked = Boolean(packageRoot) && fs.lstatSync(packageRoot).isSymbolicLink(); } catch {}
    if (linked && identityPath(realPathOf(entry) ?? '') === identityPath(real)) linkedVia = packageRoot;
  }
  const home = os.homedir();
  const raw = os.tmpdir();
  // Both resolutions: on Windows the temp directory is often spelled with an
  // 8.3 short name, which only the native resolver expands.
  let native;
  try { native = fs.realpathSync.native(raw); } catch {}
  const tmpdir = [...new Set([raw, realPathOf(raw), native].filter(Boolean))];
  return assessInstallLocation(real, { linkedVia, gitCheckout: enclosingCheckout(real, home), platform: process.platform, tmpdir, home, rerun });
}

// The CLI that is running now: the path `install` is about to write.
export function runningInstallLocation({ rerun } = {}) {
  return inspectInstallLocation(CLI_PATH, { invokedPath: process.argv[1], rerun });
}
