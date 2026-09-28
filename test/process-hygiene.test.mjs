import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The arguments of every call matched by `pattern` (which ends at the opening
// parenthesis) in `text`, as source text: from the parenthesis to its match,
// skipping quoted strings and template literals so a parenthesis inside one
// does not end the call early.
function callArguments(text, pattern) {
  const calls = [];
  const global = new RegExp(pattern.source, 'g');
  for (let match = global.exec(text); match; match = global.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
    // A mention in a comment is not a call.
    if (/^\s*(\/\/|\*)/.test(text.slice(text.lastIndexOf('\n', match.index) + 1, match.index))) continue;
    let depth = 0;
    let quote;
    let index = match.index + match[0].length - 1;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && (depth -= 1) === 0) break;
    }
    calls.push({ line: text.slice(0, match.index).split('\n').length, name: match[0].slice(0, -1).replace(/\s/g, ''), args: text.slice(match.index, index + 1) });
  }
  return calls;
}

const PROCESS_STARTERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const escapeName = (name) => name.replace(/[$]/g, '\\$&');

// Every call in `text` that starts a process: a child_process function called
// by its own name or a local alias (`import { spawn as run }`), through a
// namespace or default import or a `require`/`import()` of the module
// (`cp.spawn(`), and `spawnPortable`. A bare `exec(` that is not
// child_process's (a RegExp's `.exec(` is a method call) is not one.
function processStarts(text) {
  const names = new Set(['spawnPortable']);
  const namespaces = new Set();
  const module = String.raw`['"](?:node:)?child_process['"]`;
  const bindings = (list) => {
    for (const part of list.split(',')) {
      const [imported, local = imported] = part.split(/\s+as\s+|\s*:\s*/).map((word) => word.trim());
      if (PROCESS_STARTERS.includes(imported) && local) names.add(local);
    }
  };
  for (const match of text.matchAll(new RegExp(String.raw`import\s+([^;]*?)\s+from\s+${module}`, 'g'))) {
    const clause = match[1];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) bindings(named[1]);
    const star = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (star) namespaces.add(star[1]);
    const fallback = /^\s*([\w$]+)\s*(,|$)/.exec(clause);
    if (fallback) namespaces.add(fallback[1]);
  }
  for (const match of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:import|require)\(\s*${module}\s*\)`, 'g'))) {
    if (match[1].startsWith('{')) bindings(match[1].slice(1, -1));
    else namespaces.add(match[1]);
  }
  const calls = [];
  for (const name of names) calls.push(...callArguments(text, new RegExp(String.raw`(?<![\w$.])${escapeName(name)}\(`)));
  for (const namespace of namespaces) {
    calls.push(...callArguments(text, new RegExp(String.raw`(?<![\w$.])${escapeName(namespace)}\s*\.\s*(?:${PROCESS_STARTERS.join('|')})\(`)));
  }
  return calls.sort((a, b) => a.line - b.line);
}

// On Windows a console program started without `windowsHide` from a process
// that has no console of its own - a hook, a status render or a notify relay
// the agent started hidden - opens a console window of its own: it flashes on
// screen and can take the keyboard focus from whatever the user is typing in.
// Every process Tokenwatch starts is a background helper, so every one is
// started hidden. The one exception is the Codex wrapper, whose child is the
// user's interactive Codex in the user's own console. `spawnShellLine` hides
// what it starts itself; `spawnPortable` passes on whatever its caller asks.
test('every process Tokenwatch starts in the background is started hidden on Windows', () => {
  const src = path.join(root, 'src');
  const files = fs.readdirSync(src, { recursive: true }).filter((name) => name.endsWith('.mjs'));
  const unhidden = [];
  let calls = 0;
  for (const name of files) {
    for (const call of processStarts(fs.readFileSync(path.join(src, name), 'utf8'))) {
      // spawn.mjs is where spawnPortable and spawnShellLine are built; what
      // they start is decided by their callers, checked here.
      if (name === 'spawn.mjs' && call.name === 'spawn') continue;
      calls += 1;
      if (name === 'codex-wrapper.mjs' && call.name === 'spawnPortable') continue;
      if (!/windowsHide:\s*true/.test(call.args)) unhidden.push(`src/${name}:${call.line} ${call.name}()`);
    }
  }
  assert.ok(calls >= 4, `the scan found the process starts it is meant to check (${calls})`);
  assert.deepEqual(unhidden, []);
});

// The modules a file imports statically, and theirs, and so on: what Node
// loads and compiles before the first line of a command runs.
// `import … from`, `export … from` (a re-export loads the module just the
// same) and a bare `import '…'`, in either quote; `import()` is left out on
// purpose, since loading a module only when a command needs it is the point.
const STATIC_IMPORT = /^\s*(?:(?:import|export)\s[^;]*?\sfrom\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\1/gm;

function staticGraph(entry, base = root) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(STATIC_IMPORT)) visit(path.resolve(path.dirname(file), match[2]));
  };
  visit(entry);
  return [...seen].map((file) => path.relative(base, file).split(path.sep).join('/'));
}

// Every hook and status render is its own process, started for every event,
// and on Windows loading and compiling the whole module graph took about half
// of each one's time (91 of 174 ms on windows-latest). Doctor, the installer,
// the history import and the analysis are loaded by the commands that use
// them, and the path every hook takes stays small.
test('a hook or status render loads none of the modules only other commands use', () => {
  const graph = staticGraph(path.join(root, 'bin', 'tokenwatch.mjs'));
  assert.ok(graph.includes('src/store.mjs') && graph.includes('src/normalize/claude.mjs'), `the scan follows imports: ${graph.join(', ')}`);
  const heavy = graph.filter((file) => /^src\/(doctor|installer|analyze|rank|experiments|export|otlp-server|otlp-protobuf|repair|claude-settings)\.mjs$|^src\/import\//.test(file));
  assert.deepEqual(heavy, []);
});

// The two scans above are only as good as what they recognise. Each form a
// file could use to start a process or load a module, planted in a scratch
// file, must be found.
test('the hygiene scans recognise every way a file can start a process or load a module', () => {
  const planted = `import * as cp from 'node:child_process';
import childProcess, { spawn as run, execFile } from "child_process";
const { fork: start } = await import('node:child_process');
const req = require('child_process');
cp.spawn('a', [], {});
childProcess . execSync('b');
run('c', { windowsHide: true });
execFile('d');
start('e');
req.spawnSync('f');
/x/.exec('not a process');
// cp.spawn('only a comment');
`;
  const found = processStarts(planted).map((call) => `${call.line}:${call.name}:${/windowsHide:\s*true/.test(call.args) ? 'hidden' : 'shown'}`);
  assert.deepEqual(found, ['5:cp.spawn:shown', '6:childProcess.execSync:shown', '7:run:hidden', '8:execFile:shown', '9:start:shown', '10:req.spawnSync:shown']);

  const dir = tempDir('tokenwatch-graph-');
  const files = {
    'entry.mjs': "import { a } from './a.mjs';\nexport { b } from './b.mjs';\nexport * from \"./c.mjs\";\nimport './d.mjs';\nconst later = () => import('./lazy.mjs');\n",
    'a.mjs': 'export const a = 1;\n',
    'b.mjs': "import {\n  e\n} from './e.mjs';\nexport const b = e;\n",
    'c.mjs': 'export const c = 1;\n',
    'd.mjs': '',
    'e.mjs': 'export const e = 1;\n',
    'lazy.mjs': ''
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  assert.deepEqual(staticGraph(path.join(dir, 'entry.mjs'), dir).sort(), ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'entry.mjs']);
});
