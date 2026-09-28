import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

// Intent 16, D15 (SM-09): the shipped wrapper template, adapted the way a
// user adapts it - by editing COMMANDS and TOKENWATCH in a copy - and run
// the way an agent runs a status line.
const template = fileURLToPath(new URL('../examples/statusline-wrapper.mjs', import.meta.url));

function adapted(dir, { commands, tokenwatch, timeoutMs }) {
  let text = fs.readFileSync(template, 'utf8');
  const block = /const COMMANDS = \[[\s\S]*?\n\];/;
  assert.match(text, block, 'the template keeps its COMMANDS block');
  text = text.replace(block, `const COMMANDS = ${JSON.stringify(commands)};`);
  assert.ok(text.includes("const TOKENWATCH = 'tokenwatch';"));
  text = text.replace("const TOKENWATCH = 'tokenwatch';", `const TOKENWATCH = ${JSON.stringify(tokenwatch)};`);
  if (timeoutMs) text = text.replace('const TIMEOUT_MS = 1000;', `const TIMEOUT_MS = ${timeoutMs};`);
  const file = path.join(dir, 'wrapper.mjs');
  fs.writeFileSync(file, text);
  return file;
}

function script(dir, name, body) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs';\nconst dir = ${JSON.stringify(dir)};\n${body}\n`);
  return `"${process.execPath}" "${file}"`;
}

const READS = (name) => `const chunks = []; for await (const c of process.stdin) chunks.push(c); fs.writeFileSync(dir + '/${name}.bin', Buffer.concat(chunks));`;

test('the wrapper template gives every command the same stdin, prints them in order, then Tokenwatch, and exits 0 when one is missing', () => {
  const dir = tempDir('wrapper-');
  const payload = Buffer.from(JSON.stringify({ session_id: 's', model: { id: 'm' }, note: 'é "quoted" \\ back' }));
  const commands = [
    { command: script(dir, 'a', `${READS('a')} process.stdout.write('A-ROW\\n');`), shell: 'posix' },
    { command: `"${path.join(dir, 'no-such-tool')}"`, shell: 'posix' },
    { command: script(dir, 'b', `${READS('b')} process.stdout.write('B-ROW');`), shell: 'posix' }
  ];
  const tokenwatch = script(dir, 'tokenwatch-fake', `${READS('tw')} fs.writeFileSync(dir + '/tw-ran', process.argv.slice(2).join(' ')); process.stdout.write('TW-ROWS\\n');`);
  const wrapper = adapted(dir, { commands, tokenwatch });
  const result = spawnSync(process.execPath, [wrapper], { input: payload, env: { ...process.env, TOKENWATCH_COMPOSED: '' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), 'A-ROW\nB-ROW\nTW-ROWS\n');
  for (const name of ['a', 'b', 'tw']) assert.equal(Buffer.compare(fs.readFileSync(path.join(dir, `${name}.bin`)), payload), 0, `${name} got the bytes`);
  assert.equal(fs.readFileSync(path.join(dir, 'tw-ran'), 'utf8'), 'status --agent claude --ingest-stdin');
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files.filter((file) => !/\.(mjs|bin)$/.test(file) && file !== 'tw-ran'), [], 'nothing else is written');
});

test('run inside a composed Tokenwatch status line, the wrapper does not run Tokenwatch again', () => {
  const dir = tempDir('wrapper-composed-');
  const commands = [{ command: script(dir, 'a', `process.stdout.write('A-ROW\\n');`), shell: 'posix' }];
  const tokenwatch = script(dir, 'tokenwatch-fake', `fs.writeFileSync(dir + '/tw-ran', '1'); process.stdout.write('TW-ROWS\\n');`);
  const result = spawnSync(process.execPath, [adapted(dir, { commands, tokenwatch })], { input: '{"x":1}', env: { ...process.env, TOKENWATCH_COMPOSED: '1' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), 'A-ROW\n');
  assert.equal(fs.existsSync(path.join(dir, 'tw-ran')), false, 'the outer Tokenwatch already records and prints');
});

test('the wrapper template drops a command that runs past its timeout and leaves no process behind', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, () => {
  const dir = tempDir('wrapper-timeout-');
  const commands = [
    { command: script(dir, 'slow', `fs.writeFileSync(dir + '/pid', String(process.pid)); process.stdout.write('LATE'); setInterval(() => {}, 1000);`), shell: 'posix' },
    { command: script(dir, 'fast', `process.stdout.write('FAST\\n');`), shell: 'posix' }
  ];
  const result = spawnSync(process.execPath, [adapted(dir, { commands, tokenwatch: script(dir, 'tw', ''), timeoutMs: 300 })],
    { input: '{"x":1}', env: { ...process.env, TOKENWATCH_COMPOSED: '1' }, timeout: 10000 });
  // The slow command never ends by itself, so the wrapper exits only if it
  // stopped it: a wrapper that waited would be killed by spawnSync's timeout.
  assert.equal(result.status, 0, `the wrapper returned by itself (signal ${result.signal})`);
  assert.equal(result.stdout.toString(), 'FAST\n');
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Tokenwatch never runs the wrapper template: no source, bin or script file names it', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  for (const dir of ['src', 'bin', 'scripts']) {
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const file = path.join(at, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (fs.readFileSync(file, 'utf8').includes('statusline-wrapper')) offenders.push(path.relative(root, file));
      }
    };
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(offenders, []);
});
