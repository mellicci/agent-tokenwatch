#!/usr/bin/env node
// A status-line wrapper for cases `tokenwatch install` cannot compose on its
// own: a status tool that needs a particular shell, an environment variable,
// or anything else a plain command line does not carry.
//
// Tokenwatch never runs this file. To use it, copy it somewhere of your own,
// edit COMMANDS below, and set it as your agent's status line, for example:
//
//   Claude Code (.claude/settings.json):
//     "statusLine": { "type": "command", "command": "node /path/to/statusline-wrapper.mjs" }
//
// It reads the agent's status payload from stdin once, gives the same bytes to
// every command on its stdin (never on the command line, never on disk), and
// prints what each prints, in order. Tokenwatch's own rows come last. When
// Tokenwatch itself runs this wrapper as a composed line (TOKENWATCH_COMPOSED
// is 1), it skips its own `tokenwatch status`, because the outer Tokenwatch is
// already recording and printing: running it again would print its rows twice.
//
// Every path exits 0: a status line must render whatever its parts do.
import { spawn } from 'node:child_process';

// Your status commands, in the order their rows should appear. `shell` is how
// each line is run: 'posix' (sh on macOS and Linux, cmd.exe on Windows), 'cmd',
// 'bash' (give `shellPath`, the bash to use), or 'powershell'.
const COMMANDS = [
  // { command: 'my-status-tool --line', shell: 'posix' },
  // { command: 'git-status-line', shell: 'bash', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
];

// The agent this wrapper serves ('claude' or 'copilot') and how Tokenwatch is
// started here. Use the full command from your install if `tokenwatch` is not
// on PATH.
const AGENT = 'claude';
const TOKENWATCH = 'tokenwatch';

// The same bounds Tokenwatch applies to a composed status line.
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 1000;

function invocation({ command, shell, shellPath }) {
  switch (shell) {
    case 'bash':
      return shellPath ? { file: shellPath, args: ['-c', command], shell: false } : null;
    case 'powershell':
      return {
        file: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        shell: false
      };
    case 'posix':
    case 'cmd':
    default:
      return { file: command, args: [], shell: true };
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function run(spec, bytes) {
  return new Promise((resolve) => {
    const out = [];
    let size = 0;
    let child;
    const how = invocation(spec);
    if (!how) { resolve({ child: undefined, done: Promise.resolve(Buffer.alloc(0)) }); return; }
    try {
      child = spawn(how.file, how.args, { shell: how.shell, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch {
      resolve({ child: undefined, done: Promise.resolve(Buffer.alloc(0)) });
      return;
    }
    const done = new Promise((finish) => {
      child.on('error', () => finish(Buffer.alloc(0)));
      child.on('close', () => finish(Buffer.concat(out, size)));
    });
    child.stdout.on('data', (chunk) => {
      const room = MAX_OUTPUT_BYTES - size;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      out.push(kept);
      size += kept.length;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
    resolve({ child, done });
  });
}

function kill(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

async function main() {
  const bytes = await readStdin();
  if (!bytes?.length) return;
  const specs = [...COMMANDS];
  if (process.env.TOKENWATCH_COMPOSED !== '1') specs.push({ command: `${TOKENWATCH} status --agent ${AGENT} --ingest-stdin`, shell: 'posix' });
  const runs = await Promise.all(specs.map((spec) => run(spec, bytes)));
  const finished = runs.map(() => false);
  runs.forEach((each, index) => each.done.then(() => { finished[index] = true; }));
  const stopped = runs.map(() => false);
  const timer = setTimeout(() => {
    runs.forEach((each, index) => {
      if (finished[index]) return;
      stopped[index] = true;
      kill(each.child);
    });
  }, TIMEOUT_MS);
  const outputs = await Promise.all(runs.map(({ done }) => done));
  clearTimeout(timer);
  const parts = [];
  outputs.forEach((output, index) => {
    // A command stopped at the timeout printed an unfinished line; it is left out.
    if (!output.length || stopped[index]) return;
    parts.push(output.at(-1) === 0x0a ? output : Buffer.concat([output, Buffer.from('\n')]));
  });
  if (parts.length) process.stdout.write(Buffer.concat(parts));
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
