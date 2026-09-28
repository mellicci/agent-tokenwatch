import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultConfig } from '../src/config.mjs';
import { sessionStateFile } from '../src/store.mjs';
import { collectionLiveness, formatDoctor } from '../src/doctor.mjs';
import { statusLineShadowMessage } from '../src/claude-settings.mjs';
import { EVIDENCE_LEVELS, readSupportMatrix, renderSupportMatrix, supportMatrixSection } from '../scripts/support-matrix.mjs';

const read = (name) => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

function firstJsonBlock(markdown) {
  const match = markdown.match(/```json\r?\n([\s\S]*?)```/);
  assert.ok(match, 'expected a fenced JSON block');
  return JSON.parse(match[1]);
}

// The documented defaults are the first thing a new user copies. They drifted
// silently once; this makes the drift a test failure instead.
test('docs/configuration.md lists the defaults the code actually produces', () => {
  const documented = firstJsonBlock(read('docs/configuration.md'));
  const env = { HOME: '/home/example' };
  const actual = defaultConfig(env);
  delete actual.projectSalt;
  const home = '~/.tokenwatch';
  for (const key of ['dataFile', 'stateFile', 'installStateFile', 'experimentsFile']) {
    actual[key] = `${home}/${actual[key].split(/[\\/]/).pop()}`;
  }
  assert.deepEqual(documented, actual);
});

test('the example config only uses keys the schema knows', () => {
  const example = JSON.parse(read('examples/config.example.json'));
  const known = defaultConfig({});
  const walk = (documented, reference, path = '') => {
    for (const [key, value] of Object.entries(documented)) {
      const where = path ? `${path}.${key}` : key;
      assert.ok(key in reference, `examples/config.example.json sets unknown key ${where}`);
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, reference[key], where);
    }
  };
  walk(example, known);
});

test('the install guide covers each prerequisite tool', () => {
  const guide = read('INSTALL.md');
  for (const needle of ['node -v', 'gh auth login', 'npm pack',
    'npm install -g ./agent-tokenwatch-<version>.tgz', 'tokenwatch doctor', 'tokenwatch install --agents all --scope user',
    'tokenwatch uninstall --scope user']) {
    assert.ok(guide.includes(needle), `INSTALL.md must show \`${needle}\``);
  }
});

// The guide's whole purpose is a machine you are standing in front of, whichever
// one it is, with whichever agent you use.
test('the install guide covers every platform and every supported agent', () => {
  const guide = read('INSTALL.md');
  for (const platform of ['macOS', 'Linux', 'Windows', 'WSL', 'Homebrew', 'winget', 'apt', 'dnf', 'pacman']) {
    assert.ok(guide.toLowerCase().includes(platform.toLowerCase()),
      `INSTALL.md must cover ${platform}`);
  }
  for (const agent of ['claude --version', 'codex --version', 'copilot',
    '@openai/codex', '@github/copilot', 'claude.ai/install.sh']) {
    assert.ok(guide.includes(agent), `INSTALL.md must cover ${agent}`);
  }
});

// `npm install -g .` installs a link to the source folder, not a copy, so every
// hook runs the script inside that folder. The guide used to recommend it, and
// on the first Windows install the folder was in %TEMP%. A source install is a
// packed tarball; `npm link` belongs only under the development heading, where
// its caveat is stated.
test('the install guides never recommend installing a link to the source folder', () => {
  for (const name of ['INSTALL.md', 'README.md']) {
    const text = read(name);
    const commands = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].flatMap((block) => block[1].split(/\r?\n/));
    for (const line of commands) {
      assert.ok(!/^npm (install|i) (-g|--global) \.\/?\s*(#.*)?$/.test(line.trim()), `${name} shows \`${line.trim()}\`, which links rather than copies`);
    }
    let heading = '';
    for (const line of text.split(/\r?\n/)) {
      if (/^#{2,4} /.test(line)) heading = line;
      if (/^npm link\b/.test(line.trim())) {
        assert.match(heading, /develop/i, `${name} shows \`npm link\` under "${heading}", outside a development section`);
      }
    }
  }
});

// Every documentation drift this project has actually suffered has been in the
// prose files the tests above do not reach: a README paragraph, a risk area in
// the architecture doc, a path quoted in a skill, a sentence in the threat
// model. The tests cover the documents that are easy to check, and the drift
// went where the tests were not. These two close the specific gaps that bit.

// A session id comes from the agent and must never appear in a filename. Four
// documents kept quoting the old path for an hour after the code stopped
// writing it, including a skill, which means a model told users the wrong path
// with complete confidence.
test('no document quotes a session-state path the code does not write', () => {
  const config = { stateFile: '/tmp/tokenwatch/state.json' };
  const produced = path.basename(sessionStateFile(config, 'example-session-id'));
  assert.match(produced, /^s_[0-9a-f]{32}\.json$/, 'the filename must be a hash');
  const docs = ['README.md', 'docs/configuration.md', 'docs/architecture.md',
    'docs/high_level_architecture_tokenwatch.md', 'docs/event-schema.md',
    'skills/tw-explain-statusline/SKILL.md', 'skills/tw-retrospective-overall/SKILL.md'];
  for (const name of docs) {
    const text = read(name);
    // Both spellings: a Mermaid node HTML-escapes its angle brackets, which is
    // exactly where this drift survived the first correction.
    assert.ok(!/sessions\/(<|&lt;)session[-_]id(>|&gt;)/.test(text),
      `${name} still documents sessions/<session-id>.json; the code writes sessions/s_<hash>.json`);
  }
});

// The threat model said the receiver "accepts JSON only" while it had accepted
// protobuf for months. Understating what a listener will parse is the wrong
// direction for a security document to be wrong in.
test('the threat model names the media types the receiver actually accepts', () => {
  const server = read('src/otlp-server.mjs');
  const accepted = ['application/json', 'application/x-protobuf'];
  for (const type of accepted) {
    assert.ok(server.includes(`=== '${type}'`) || server.includes(`type === '${type}'`),
      `src/otlp-server.mjs should test for ${type}`);
  }
  const model = read('docs/privacy-threat-model.md');
  for (const type of accepted) {
    assert.ok(model.includes(type),
      `docs/privacy-threat-model.md must name ${type}, which the receiver accepts`);
  }
  assert.ok(!/accepts JSON only/.test(model),
    'docs/privacy-threat-model.md must not claim JSON only; protobuf logs are accepted');
});

// OpenAI moved the Codex documentation: every `developers.openai.com/codex/…`
// page now answers 308 to `learn.chatgpt.com/docs/…` (checked 2026-09-24). The
// interface map is what an adapter change is checked against, so it links the
// pages as they are, and tells a Codex user Codex's own skill syntax rather
// than Claude Code's.
test('the interface map links current Codex documentation and Codex\'s own skill syntax', () => {
  const map = read('docs/interfaces.md');
  assert.doesNotMatch(map, /https:\/\/developers\.openai\.com\/codex/,
    'docs/interfaces.md links a Codex page that now redirects');
  const codexRow = map.split('\n').find((line) => line.startsWith('| OpenAI Codex CLI |'));
  assert.ok(codexRow, 'the map has a Codex row');
  assert.match(codexRow, /\$HOME\/\.agents\/skills/, codexRow);
  assert.match(codexRow, /`\$<name>`/, codexRow);
  const readme = read('README.md');
  assert.match(readme, /\| Codex CLI[^|]*\| `\$tw-[a-z-]+` \|/, 'the README gives the Codex invocation');
});

// The support matrix is a set of claims about evidence: which agent, on which
// operating system, was seen working, with which version, and when. A claim
// that outlives its evidence is the drift this file exists to catch, so the
// README table is generated from docs/support-matrix.json and must be exactly
// what that file renders to. Fix a failure by editing the data file and running
// `node scripts/support-matrix.mjs --write`, never by editing the table.
test('the README support matrix is exactly what docs/support-matrix.json renders to', () => {
  const section = supportMatrixSection(read('README.md'));
  assert.ok(section !== undefined, 'README.md must carry the generated support-matrix block');
  assert.equal(section, renderSupportMatrix(readSupportMatrix()),
    'README.md support matrix has drifted from docs/support-matrix.json; run node scripts/support-matrix.mjs --write');
  assert.match(read('docs/publishing.md'), /support-matrix\.json/,
    'the release checklist in docs/publishing.md must ask for the support matrix to be updated');
});

// A level is only as good as what backs it. "Hands-on verified" with no agent
// version cannot be checked against the next release of that agent, and "tested
// in CI" with a date other than the last green run is a claim about a run that
// did not happen. An unknown version is written as "not recorded", on purpose,
// rather than left out or guessed.
test('every support-matrix cell carries an allowed evidence level and the date or version that level needs', () => {
  const data = readSupportMatrix();
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const realDate = (value) => isoDate.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  assert.ok(realDate(data.lastReviewed), `lastReviewed must be a YYYY-MM-DD date, got ${data.lastReviewed}`);
  assert.ok(realDate(data.ci.lastGreen) && data.ci.lastGreen <= data.lastReviewed,
    `ci.lastGreen must be a date no later than lastReviewed, got ${data.ci.lastGreen}`);
  assert.deepEqual(data.platforms, ['Linux', 'macOS', 'Windows', 'WSL']);
  assert.deepEqual(data.agents.map((row) => row.agent), ['Claude Code', 'Codex CLI', 'GitHub Copilot CLI'],
    'one row per supported agent, under its exact product name');
  for (const row of data.agents) {
    assert.deepEqual(Object.keys(row.cells).sort(), [...data.platforms].sort(), `${row.agent} must have one cell per platform`);
    for (const platform of data.platforms) {
      const cell = row.cells[platform];
      const where = `${row.agent} on ${platform}`;
      assert.ok(Object.hasOwn(EVIDENCE_LEVELS, cell.level), `${where}: unknown evidence level ${cell.level}`);
      for (const field of EVIDENCE_LEVELS[cell.level].requires) {
        assert.ok(typeof cell[field] === 'string' && cell[field].trim(), `${where}: level ${cell.level} needs a ${field}, got ${cell[field]}`);
      }
      if (cell.date !== undefined) {
        assert.ok(realDate(cell.date) && cell.date <= data.lastReviewed,
          `${where}: date must be a YYYY-MM-DD date no later than lastReviewed, got ${cell.date}`);
        assert.ok(cell.evidence.includes(cell.date), `${where}: the evidence must say what happened on ${cell.date}`);
      }
      if (cell.level === 'provisional' && cell.date !== undefined) {
        assert.ok(cell.version, `${where}: a provisional cell that names a date must name the version, or "not recorded"`);
      }
      if (cell.level === 'ci-only') {
        assert.equal(cell.date, data.ci.lastGreen, `${where}: a CI-only claim must be dated to the last green run`);
      }
      if (cell.level === 'hands-on' && cell.version !== 'not recorded') {
        assert.ok(cell.evidence.includes(cell.version), `${where}: the evidence must name version ${cell.version}`);
      }
      assert.ok(typeof cell.evidence === 'string' && cell.evidence.length >= 40,
        `${where}: every cell needs the evidence behind it, got ${JSON.stringify(cell.evidence)}`);
    }
  }
});

// The first Windows install collected nothing because a project-level status
// line outranked Tokenwatch's, and `doctor` said all was well. The guide now
// shows the two lines `doctor` prints for exactly that case, and a quoted
// diagnostic is only useful if it is what the tool really prints, so these are
// rendered from the same functions `doctor` uses rather than kept as prose.
test('the troubleshooting guide quotes the doctor lines the code prints for an outranked status line', () => {
  const dir = '/home/you/project';
  const hooks = Array.from({ length: 15 }, (_, i) => ({ agent: 'claude-code', source: 'hook', ts: `2026-09-23T10:${String(i).padStart(2, '0')}:00.000Z` }));
  const liveness = collectionLiveness('claude', hooks, { installedAt: '2026-09-23T09:00:00.000Z', now: '2026-09-23T12:00:00.000Z' });
  assert.equal(liveness.verdict, 'hooks-without-status-samples', `got ${liveness.verdict}`);
  const printed = formatDoctor({ checks: [
    { id: 'user:claude-status-line', status: 'warn', detail: statusLineShadowMessage({ file: `${dir}/.claude/settings.json`, level: 'project' }, dir) },
    { id: 'collection:claude', status: liveness.status, detail: liveness.detail }
  ] });
  const guide = read('INSTALL.md').replace(/\r\n/g, '\n');
  for (const line of printed.trim().split('\n')) {
    assert.ok(guide.includes(line), `INSTALL.md must quote the line doctor prints: ${line}`);
  }
});

// Intent 06: the history import is the documented exception to "never reads
// transcripts", so the exception is written down where users look, and the
// code that reads session files is reachable only from the command itself.
test('the history import is documented as the one explicit exception, with a mapping example that validates', async () => {
  const threat = read('docs/privacy-threat-model.md');
  const section = threat.slice(threat.indexOf('## An explicit history import'));
  assert.ok(threat.includes('## An explicit history import'), 'the threat model has its section');
  assert.match(section.slice(0, section.indexOf('\n## ', 5)), /`tokenwatch import/);
  assert.match(read('README.md'), /tokenwatch import <agent>/);
  assert.match(read('docs/limitations.md'), /tokenwatch import/);
  assert.match(read('CONTRIBUTING.md'), /probe date and an agent version/);
  const { validateMapping } = await import('../src/import/mapping.mjs');
  assert.deepEqual(validateMapping(JSON.parse(read('examples/mapping.example.json'))), []);
  const interfaces = read('docs/interfaces.md');
  for (const agent of ['claude', 'codex', 'copilot']) {
    const mapping = JSON.parse(read(`src/import/mappings/${agent}.json`));
    assert.deepEqual(validateMapping(mapping), [], `${agent}.json`);
    assert.ok(interfaces.includes(`\`${mapping.mapping_id}\``), `docs/interfaces.md names ${mapping.mapping_id}`);
    assert.ok(interfaces.includes(mapping.evidence.agent_version), `docs/interfaces.md names the version ${agent} was probed on`);
  }
  assert.match(interfaces, /undocumented; shape recorded/);
});

test('only the import command reaches the modules that open session files, and only the import skill runs it', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const reading = ['run.mjs', 'sessions.mjs', 'reader.mjs', 'probe.mjs', 'undo.mjs'];
  const importers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.mjs') || path.dirname(file) === path.join(src, 'import')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const name of reading) if (new RegExp(`import/${name.replace('.', '\\.')}`).test(text)) importers.push(`${path.relative(src, file)} -> ${name}`);
    }
  };
  walk(src);
  assert.deepEqual(importers.sort(), ['cli.mjs -> run.mjs', 'cli.mjs -> undo.mjs']);
  const skills = fileURLToPath(new URL('../skills/', import.meta.url));
  for (const skill of fs.readdirSync(skills)) {
    const file = path.join(skills, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    // Intent 19, D2: exactly one skill runs the import, when the user invokes
    // it; every other skill must not.
    if (skill === 'tw-import-history') assert.match(fs.readFileSync(file, 'utf8'), /tokenwatch import/);
    else assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /tokenwatch import/, `${skill} must not run the import`);
  }
});
