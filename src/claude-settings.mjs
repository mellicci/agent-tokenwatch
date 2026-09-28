import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code runs exactly one status-line command, and the status line is its
// only source of token and cost figures. When several settings files define a
// `statusLine`, the highest-precedence one wins outright, so a free slot in the
// file Tokenwatch wrote says nothing about whether Tokenwatch's command runs.
// That is how the first Windows install recorded hooks for days and no tokens:
// the project's shared `.claude/settings.json` carried another tool's status
// line, and it outranks the user file Tokenwatch had installed into.
//
// The order below is Claude Code's documented one, verified 2026-09-24 against
// https://code.claude.com/docs/en/settings ("Settings precedence"): managed
// settings, then command-line arguments, then project local
// `.claude/settings.local.json`, then shared project `.claude/settings.json`,
// then user `~/.claude/settings.json` - "a key at a higher level overrides the
// same key anywhere below it". `statusLine` may be set in "Any file"
// (https://code.claude.com/docs/en/settings-reference), and it is a single
// value rather than a list, so nothing merges it across levels.
//
// Deliberately not walked: managed settings, whose location depends on the
// platform and the organisation's delivery mechanism, and `claude --settings`,
// which exists only for one session. Nor is `~/.claude.json`: its per-project
// state could name every project Claude Code has opened, but it is Claude Code's
// private file ("it writes for itself; you don't need to edit it"), and reading
// another tool's private state to be more helpful is the trade this project
// declines elsewhere. The check therefore speaks for one project directory at a
// time - the current one unless told otherwise - and says which.
export function claudeSettingsChain({ projectDir = process.cwd(), homeDir, localFile, userFile } = {}) {
  return [
    { level: 'project-local', file: localFile ?? path.join(projectDir, '.claude', 'settings.local.json') },
    { level: 'project', file: path.join(projectDir, '.claude', 'settings.json') },
    { level: 'user', file: userFile ?? path.join(homeDir ?? os.homedir(), '.claude', 'settings.json') }
  ];
}

// A status line is Tokenwatch's when one of its shell words runs Tokenwatch:
// the `tokenwatch` executable, or a path ending in `tokenwatch`,
// `tokenwatch.mjs`, `.cmd` or `.exe` (and the same for `tokenwatch-codex`).
// A command that merely contains the word, such as a script in a checkout
// named agent-tokenwatch, is `mentions`: it is composed, with a warning, rather
// than refused as ours (intent 16, D8; intent 04's finding F2). Both execution
// gates also refuse whatever runsThisCli recognises (D26).
export function classifyStatusLineCommand(command, { platform = process.platform } = {}) {
  if (typeof command !== 'string') return 'other';
  const fold = (text) => (platform === 'win32' ? text.toLowerCase() : text);
  const runsTokenwatch = shellWords(command).some((word) => {
    const folded = fold(word);
    return folded === 'tokenwatch' || folded === 'tokenwatch-codex' || /(^|[\\/])tokenwatch(-codex)?(\.mjs|\.cmd|\.exe)?$/.test(folded);
  });
  if (runsTokenwatch) return 'tokenwatch';
  return /tokenwatch/i.test(command) ? 'mentions' : 'other';
}

export function isTokenwatchStatusLine(statusLine) {
  return classifyStatusLineCommand(statusLine?.command) === 'tokenwatch';
}

// The words of a shell line, quotes removed, split at whitespace and at the
// unquoted operators | & ; < > ( ), so `a|tokenwatch status` and
// `$(tokenwatch status)` both yield the word `tokenwatch`.
function shellWords(command) {
  const words = [];
  let word = '';
  let quoted = false;
  const flush = () => {
    if (word || quoted) words.push(word);
    word = '';
    quoted = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'" || character === '"') {
      const close = command.indexOf(character, index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      quoted = true;
      index = end;
    } else if (/\s/.test(character) || '|&;<>()'.includes(character)) {
      flush();
    } else {
      word += character;
    }
  }
  flush();
  return words;
}

// `undefined` for a file that does not exist, `null` for one that cannot be
// parsed. No error text is kept: a JSON parse message quotes part of the file.
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? undefined : null;
  }
  try {
    // A file saved by Windows PowerShell 5.1 can open with a byte-order mark,
    // which JSON.parse rejects and which would hide a status line that is there.
    const value = JSON.parse(text.replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The statusLine a settings file sets, for the installer adopting it under
// `install --compose` (intent 04). Kept apart from winningClaudeStatusLine so
// the object doctor reports on never carries the other command's text.
export function statusLineAt(file) {
  const settings = readSettings(file);
  return settings?.statusLine ?? undefined;
}

// Walks the chain from the top and stops at the first file that sets a
// `statusLine`, so a lower-precedence file is only read when every file above it
// leaves the key unset. `winner` is undefined when no file in the chain sets one.
// `unreadable` lists files above the winner whose contents could not be parsed:
// what they would set is unknown, and the caller should say so rather than
// report the winner as certain.
export function winningClaudeStatusLine(chain) {
  const unreadable = [];
  for (const entry of chain) {
    const settings = readSettings(entry.file);
    if (settings === null) { unreadable.push(entry.file); continue; }
    if (settings?.statusLine === undefined || settings.statusLine === null) continue;
    return { winner: { ...entry, tokenwatch: isTokenwatchStatusLine(settings.statusLine) }, unreadable };
  }
  return { winner: undefined, unreadable };
}

// The one sentence both `install` and `doctor` print when another tool's status
// line outranks Tokenwatch's, so the two cannot drift apart. It names the file
// that wins and never quotes the other command, which can hold a path or a
// secret of its own.
// One remedy, composing, because it needs no free slot. A project install
// composes by default (intent 16, D1); a project record that exists already is
// repaired rather than reinstalled, so the caller passes that command (D12).
export function statusLineShadowMessage(winner, projectDir, remedy = `tokenwatch install --agents claude --scope project --project "${projectDir}"`) {
  return `${winner.file} sets a statusLine that is not Tokenwatch's, and it takes precedence for ${projectDir}. `
    + 'Claude Code runs that command instead, so Tokenwatch records hook events there but no tokens or cost. '
    + `To run both in that project: ${remedy} `
    + '(uninstall restores what it replaced). --force instead hides the other status line; uninstall restores it.';
}
