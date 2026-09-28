import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Quoting for the Windows batch path below, which has to satisfy two parsers
// in sequence, not one.
//
// cmd.exe reads the line first and tracks quoting by counting `"`. It has no
// idea what `\"` means - that is a C runtime convention - so escaping an inner
// quote as `\"` leaves cmd with an odd quote count and its quote state
// inverted for the remainder of the line. Anything after that point which cmd
// treats specially, `&` or `|` most of the way, stops being inert. A Codex
// notify payload is JSON, so it is nothing but inner quotes.
//
// Doubling the quote instead does not compose: `""` and the C runtime's
// backslash rule fight over the same characters, and a path ending in a
// backslash comes out wrong.
//
// So the argument is built for the C runtime first - literal backslashes
// except before a quote, where each doubles, and the trailing run doubles so
// it cannot escape the closing quote - and then every character cmd treats
// specially is prefixed with `^`, including the structural quotes. cmd then
// never enters quote state at all: it strips the carets, passes everything
// through literally, and the child's own parser sees a correctly quoted
// argument. This is what cross-spawn does, for the same reason.
//
// Not handled, and not pretended otherwise: cmd expands `%VAR%` even when
// caret-escaped in some positions. The failure there is a mangled argument
// rather than an escape, since an undefined variable is left as written.
export function quoteForCmd(value) {
  const text = String(value);
  const quoted = text === ''
    ? '""'
    : `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(/[()%!^<>&|;, "]/g, '^$&');
}

// npm installs a global CLI on Windows as `codex.cmd`, never `codex.exe`, and
// libuv's executable search tries only the bare name, `.com` and `.exe`. It
// does not consult PATHEXT, and `CreateProcess` cannot execute a batch file at
// all. So `spawn('codex', args, { shell: false })` fails with ENOENT on exactly
// the install route the docs recommend.
//
// A name that already carries an executable extension, or any absolute path to
// a real binary, is spawned directly. Anything else on Windows goes through the
// command interpreter with each argument quoted for it. `windowsVerbatimArguments`
// stops Node re-quoting a string that is already correct.
//
// Deliberately not `shell: true`: Node does not quote arguments in that mode,
// it concatenates them, so any argument containing a space would break apart.
export function spawnPortable(command, args = [], options = {}) {
  const needsInterpreter = process.platform === 'win32'
    && !/\.(exe|com)$/i.test(String(command));
  if (!needsInterpreter) {
    return spawn(command, args, { ...options, shell: false });
  }
  const line = [command, ...args].map(quoteForCmd).join(' ');
  const interpreter = process.env.ComSpec || 'cmd.exe';
  return spawn(interpreter, ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true
  });
}

// A status line another tool owns is one shell line, not a program and argv,
// so composing with it (intent 04) replays the line through the shell its
// agent runs it with, verbatim and with nothing appended - never through
// spawnPortable, which would take the whole line for a program name. The
// shell kind is decided at install and recorded (decisions D4, D5):
//
// - `posix`: /bin/sh, Node's `shell: true` off Windows. Claude Code and
//   Copilot CLI on macOS and Linux.
// - `cmd`: %ComSpec%, Node's `shell: true` on Windows. Copilot CLI 1.0.86 runs
//   its status line that way (see copilotCommands in installer.mjs).
// - `bash`: Git Bash. Claude Code on Windows when Git Bash is installed.
// - `powershell`: Claude Code on Windows without Git Bash.
//
// Node concatenating arguments under `shell: true` (the reason spawnPortable
// avoids it) does not apply here: there is exactly one string and no argv.
export function shellLineInvocation(command, { shell, shellPath } = {}, platform = process.platform) {
  switch (shell) {
    case 'posix':
    case 'cmd':
      return { file: command, args: [], shell: true };
    case 'bash':
      if (!shellPath) throw new Error('A bash compose shell needs the path of the Git Bash it was recorded with');
      return { file: shellPath, args: ['-c', command], shell: false };
    case 'powershell':
      // Encoded, not `-Command <line>`: a line carrying double quotes goes
      // through CreateProcess and then PowerShell's own command-line re-parse,
      // which can strip them, so the line run would differ from the one the
      // agent runs (intent 17, D8).
      return {
        file: platform === 'win32' ? 'powershell.exe' : 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        shell: false
      };
    default:
      throw new Error(`Unknown compose shell: ${shell}`);
  }
}

// The shell Claude Code runs a hook or status-line command through, decided
// now rather than recorded: off Windows /bin/sh; on Windows Git Bash when
// installed, else PowerShell (https://code.claude.com/docs/en/hooks and
// /statusline, read 2026-09-24). `install` and `doctor` both ask this, so they
// cannot disagree about which shell a command must parse under (intent 17, D5).
export function claudeShell({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { shell: 'posix' };
  const bash = findGitBash({ env });
  return bash ? { shell: 'bash', shellPath: bash } : { shell: 'powershell' };
}

// The file a shell would start for a bare command name, or undefined. PATHEXT
// is honoured on Windows, where `node` means `node.exe`.
export function findOnPath(name, env = process.env, platform = process.platform) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const directories = String(pathKey ? env[pathKey] : '').split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export function spawnShellLine(command, shellSpec, options = {}) {
  const { file, args, shell } = shellLineInvocation(command, shellSpec);
  return spawn(file, args, { ...options, shell, windowsHide: true });
}

// Where Claude Code finds Git Bash on Windows: CLAUDE_CODE_GIT_BASH_PATH when
// set, otherwise the bash.exe that ships beside git.exe. The bash.exe in
// System32 is WSL's, not Git's, which is why PATH is searched for git.exe
// rather than bash.exe. Returns null when there is none, which means Claude
// Code runs status lines through PowerShell.
export function findGitBash({ env = process.env, exists = fs.existsSync } = {}) {
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit && exists(explicit)) return explicit;
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    if (!exists(path.win32.join(dir, 'git.exe'))) continue;
    for (const candidate of [path.win32.join(dir, '..', 'bin', 'bash.exe'), path.win32.join(dir, 'bash.exe')]) {
      if (exists(candidate)) return path.win32.normalize(candidate);
    }
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]) {
    if (!root) continue;
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}
