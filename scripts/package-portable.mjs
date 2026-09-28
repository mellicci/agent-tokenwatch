#!/usr/bin/env node
// Builds a self-contained archive: the source tree, the install guide, and the
// whole git history as one bundle file. Everything that goes in comes from
// `git ls-files`, so an untracked scratch file cannot leak into a handoff, and
// machine-specific installed state (`.claude/`) is excluded by construction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const name = `agent-tokenwatch-portable-${version}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: root, ...options });
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is not on PATH. Install zip, or build the archive on a machine that has it.`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : root;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwatch-portable-'));
const top = path.join(staging, `agent-tokenwatch-${version}`);
const source = path.join(top, 'agent-tokenwatch');
fs.mkdirSync(source, { recursive: true });

// The archive is a snapshot of committed work. Anything uncommitted would arrive
// on the other machine with no history explaining it, so say so and stop.
const dirty = run('git', ['status', '--porcelain']).trim();
if (dirty && !process.argv.includes('--allow-dirty')) {
  throw new Error(`the working tree has uncommitted changes:\n${dirty}\n`
    + 'Commit them, or pass --allow-dirty to archive HEAD as it stands.');
}

// `.claude/` holds this machine's installed hooks and absolute Node paths, which
// are wrong everywhere else. The recipient regenerates them with `tokenwatch install`.
const tracked = run('git', ['ls-files', '-z']).split('\0')
  .filter(Boolean)
  .filter((file) => !file.startsWith('.claude/'));

for (const file of tracked) {
  const destination = path.join(source, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}

// A bundle is a whole repository in one file: `git clone <bundle>` restores the
// history, branches and all, with no server in between.
run('git', ['bundle', 'create', path.join(top, 'agent-tokenwatch.gitbundle'), '--all']);
fs.copyFileSync(path.join(root, 'INSTALL.md'), path.join(top, 'INSTALL.md'));

const archive = path.join(outDir, `${name}.zip`);
fs.rmSync(archive, { force: true });
fs.mkdirSync(outDir, { recursive: true });
run('zip', ['-q', '-r', archive, path.basename(top)], { cwd: staging });
fs.rmSync(staging, { recursive: true, force: true });

const size = fs.statSync(archive).size;
process.stdout.write(`${archive}\n${tracked.length} source files, ${(size / 1024).toFixed(0)} KB\n`);
