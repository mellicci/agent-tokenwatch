import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledSkills } from '../src/installer.mjs';

const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url));

function frontmatter(name) {
  const text = fs.readFileSync(path.join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${name} must open with a frontmatter block`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

// `>= 4` passed on any bundle that had not shrunk below four, and the other
// cases here are loops that pass on any non-empty bundle. A skill silently
// dropping out of the install - which is what a missing directory or a typo in
// a rename looks like - was therefore green. The bundle is a published
// interface: the skills are named in the README, referenced by each other, and
// invoked by users as `/tw-*` (or `$tw-*` in Codex), so the exact set is the
// thing to assert.
test('the bundle is exactly the seven published skills', () => {
  assert.deepEqual(bundledSkills().slice().sort(), [
    'tw-cost-audit-define-experiment',
    'tw-cost-drivers-basics',
    'tw-explain-statusline',
    'tw-import-history',
    'tw-retrospective-overall',
    'tw-retrospective-this-session',
    'tw-token-cost-coach'
  ]);
});

test('every bundled skill declares a name matching its directory', () => {
  const names = bundledSkills();
  assert.ok(names.length >= 4, `expected the full bundle, got ${names.join(', ')}`);
  for (const name of names) {
    const { fields } = frontmatter(name);
    assert.equal(fields.name, name, `${name}: frontmatter name must match the directory`);
  }
});

test('every bundled skill has a description that can trigger it', () => {
  for (const name of bundledSkills()) {
    const { fields, body } = frontmatter(name);
    assert.ok(fields.description, `${name} must declare a description`);
    assert.ok(fields.description.length >= 40,
      `${name}: description is too short to route on (${fields.description.length} chars)`);
    assert.ok(body.trim().length > 0, `${name} must have a body`);
  }
});

test('skills reference only commands the CLI actually implements', () => {
  const help = fs.readFileSync(new URL('../src/help.mjs', import.meta.url), 'utf8');
  const known = new Set(['install', 'uninstall', 'status', 'hook', 'notify-relay', 'otlp',
    'agents', 'analyze', 'experiment', 'export', 'prune', 'repair', 'doctor', 'config', 'paths', 'version', 'codex', 'import']);
  for (const command of known) {
    assert.ok(help.includes(command), `help text should document ${command}`);
  }
  for (const name of bundledSkills()) {
    const { body } = frontmatter(name);
    for (const [, invoked] of body.matchAll(/^\s*tokenwatch\s+([a-z-]+)/gm)) {
      assert.ok(known.has(invoked), `${name} invokes unknown command: tokenwatch ${invoked}`);
    }
  }
});

// Skills tell a model exactly what to type. A flag that was renamed or never
// existed turns into a failed command mid-conversation, so every option the
// skills document is checked against the parser's own option names.
test('skills reference only command-line options the CLI actually parses', () => {
  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const camel = (flag) => flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  for (const name of bundledSkills()) {
    // Join shell line continuations first, so a command split across lines is
    // checked in full rather than truncated at the first backslash.
    const body = frontmatter(name).body.replace(/\\\r?\n\s*/g, ' ');
    for (const block of body.matchAll(/tokenwatch .*/g)) {
      for (const [, flag] of block[0].matchAll(/--([a-z][a-z-]*)/g)) {
        if (flag === 'help' || flag === 'version') continue;
        assert.ok(cli.includes(`options.${camel(flag)}`),
          `${name} documents --${flag}, which the CLI does not read`);
      }
    }
  }
});

// Intent 16, D12/D16 (SM-12): the status-line skill offers the repair in its
// full form and runs it only with the user's yes.
test('the status-line skill offers install --repair, in full, only after the user agrees', () => {
  const { body } = frontmatter('tw-explain-statusline');
  assert.match(body, /```sh\n[^`]*tokenwatch install [^`\n]*--repair\n[^`]*```/, 'the repair is shown as a command to run');
  assert.match(body, /after the user says yes/);
  assert.doesNotMatch(body, /--compose --force|--force --compose/, 'the old repair is gone');
  assert.match(body, /examples\/statusline-wrapper\.mjs/, 'the template is named as the fallback');
});

// One installation serves every agent from one ledger, so a skill invoked inside
// Copilot that reads Claude's sessions reports somebody else's work. Every skill
// that reports numbers has to establish its host agent before reading any.
test('reporting skills establish which agent they are reporting on', () => {
  for (const name of ['tw-cost-audit-define-experiment', 'tw-retrospective-overall',
    'tw-retrospective-this-session', 'tw-token-cost-coach']) {
    const { body } = frontmatter(name);
    assert.match(body, /tokenwatch agents/, `${name} must resolve the host agent first`);
    assert.match(body, /--agent <host>/, `${name} must scope its commands to that agent`);
    assert.doesNotMatch(body, /tokenwatch status --agent claude/,
      `${name} must not default to Claude`);
    assert.doesNotMatch(body, /tokenwatch analyze --since \d+d --group-by model --compare --format json\r?\n/,
      `${name} must not analyze every agent at once without saying so`);
  }
});

// A hand-run `status` without a session id reports whichever session wrote
// last, and says so in `session_scope` (intent 15). A skill that reads the
// snapshot as "this session" without checking that would present another
// open session's figures as the user's own.
test('skills that read the status snapshot check whose session it is', () => {
  const readers = [];
  for (const name of bundledSkills()) {
    const body = frontmatter(name).body.replace(/\\\r?\n\s*/g, ' ');
    if (!/tokenwatch status [^\n`]*--json/.test(body)) continue;
    readers.push(name);
    assert.ok(body.includes('--session') || body.includes('session_scope'),
      `${name} reads status --json without --session or session_scope`);
  }
  assert.deepEqual(readers.sort(), ['tw-cost-audit-define-experiment', 'tw-explain-statusline',
    'tw-retrospective-this-session', 'tw-token-cost-coach']);
  const { body } = frontmatter('tw-retrospective-this-session');
  assert.match(body, /most_recent_fallback/);
  assert.doesNotMatch(body, /needs no session filter|already scoped to this session|is already one/);
});

// The same six files are installed for three agents, and each agent's loader
// decides on its own whether a file is a skill. Codex drops a file it cannot
// parse without saying so in the session, and `/skills` simply lists fewer
// entries, so a constraint only one agent enforces is still a missing skill.
// Every rule below is the stricter of the documented or implemented limits:
// - Agent Skills spec, which Claude Code follows (https://agentskills.io/specification,
//   https://code.claude.com/docs/en/skills): `name` 1-64 of a-z 0-9 and single
//   hyphens, matching the directory; `description` 1-1024 characters; only
//   `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`
//   outside Claude Code.
// - Codex (https://learn.chatgpt.com/docs/build-skills: "must include `name` and
//   `description`"; source https://github.com/openai/codex, codex-cli 0.154.0 checked
//   2026-09-24): the first line must be `---` after a trim that keeps U+FEFF
//   (skills/src/parser.rs), `name` at most 64 characters (MAX_NAME_LEN),
//   `description` at most 1024 in 0.95.0-0.140.0 (MAX_DESCRIPTION_LEN), and a
//   `$name` mention only matches [A-Za-z0-9_:-] (skills/src/mentions.rs).
// - Both parse YAML, so each value is a plain scalar neither parser can read
//   differently: no `: ` or ` #` inside, no leading indicator character. Codex
//   repairs some invalid scalars and Claude Code's parser does not.
test('every bundled skill satisfies both Claude Code and Codex frontmatter rules', () => {
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const name of bundledSkills()) {
    const text = fs.readFileSync(path.join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${name}: a byte-order mark hides the frontmatter from Codex`);
    const lines = text.split(/\r?\n/);
    assert.equal(lines[0], '---', `${name}: first line must be exactly ---, got ${JSON.stringify(lines[0])}`);
    const end = lines.indexOf('---', 1);
    assert.ok(end > 1, `${name}: frontmatter must be closed by a --- line`);
    const fields = {};
    for (const line of lines.slice(1, end)) {
      const pair = line.match(/^([a-z_-]+): (.+)$/);
      assert.ok(pair, `${name}: frontmatter line is not a single-line key: value pair: ${JSON.stringify(line)}`);
      assert.ok(allowed.has(pair[1]), `${name}: ${pair[1]} is not an Agent Skills field`);
      const value = pair[2];
      assert.doesNotMatch(value, /^[-?:,[\]{}#&*!|>'"%@`]/, `${name}: ${pair[1]} starts with a YAML indicator`);
      assert.doesNotMatch(value, /: | #|:$/, `${name}: ${pair[1]} is not a plain YAML scalar both agents read alike`);
      fields[pair[1]] = value;
    }
    assert.match(fields.name ?? '', /^[a-z0-9]+(-[a-z0-9]+)*$/, `${name}: name must be lower-case letters, digits and single hyphens, got ${fields.name}`);
    assert.ok([...fields.name].length <= 64, `${name}: name is ${[...fields.name].length} characters, over 64`);
    assert.equal(fields.name, name, `${name}: name must match the directory`);
    assert.ok(fields.description, `${name}: description is required by Codex`);
    assert.ok([...fields.description].length <= 1024,
      `${name}: description is ${[...fields.description].length} characters, over 1024`);
  }
});

// Codex lists every skill's name and description inside a budget of "2% of the
// model's context window, or 8,000 characters when the context window is
// unknown" (https://learn.chatgpt.com/docs/build-skills), shared with the
// user's own skills and Codex's built-in ones. The bundle must never be the
// thing that pushes a listing over it on its own.
test('the bundle takes well under the listing budget Codex gives all skills', () => {
  let used = 0;
  for (const name of bundledSkills()) used += name.length + frontmatter(name).fields.description.length;
  assert.ok(used <= 4000, `the six skills take ${used} of Codex's 8000-character fallback budget`);
});

// The skills hand off to each other by name, and the model reading one tells
// the user what to type next. Claude Code and Copilot CLI take `/tw-…`; Codex
// does not, and takes `$tw-…` or its `/skills` list. A skill that only says
// `/tw-…` sends a Codex user to a command that does not exist.
test('a skill that hands off to a sibling names it in each agent\'s own syntax', () => {
  const names = bundledSkills();
  for (const name of names) {
    const { body } = frontmatter(name);
    const siblings = names.filter((other) => other !== name && body.includes(other));
    if (!siblings.length) continue;
    assert.match(body, /`\/tw-<name>` in Claude Code and Copilot CLI/, `${name} names ${siblings[0]} without Claude Code's syntax`);
    assert.match(body, /`\$tw-<name>` in\s+Codex/, `${name} names ${siblings[0]} without Codex's syntax`);
    assert.match(body, /`\/skills`/, `${name} does not mention Codex's skill list`);
  }
});

// The reporting skills summarise the ledger, and a ledger that is quietly not
// collecting - hooks arriving, the status line never delivering - reads as a
// cheap week. `doctor` now says when that is happening; each reporting skill
// has to run it and caveat rather than summarise a partial ledger as complete.
test('reporting skills check collection with doctor and caveat rather than summarise a partial ledger', () => {
  for (const name of ['tw-cost-audit-define-experiment', 'tw-retrospective-overall',
    'tw-retrospective-this-session', 'tw-token-cost-coach']) {
    const { body } = frontmatter(name);
    assert.match(body, /^tokenwatch doctor/m, `${name} must run doctor`);
    assert.match(body, /collection:<host>/, `${name} must say which doctor line to read`);
    assert.match(body, /do not\s+summarise as though the data were complete/i, `${name} must caveat a failing collection check`);
  }
});

// Intent 06: a skill that teaches the usage bases must teach every basis the
// schema accepts, or a model reads imported `transcript` totals as live usage.
test('a skill that explains usage bases names every basis the schema accepts', async () => {
  const { cleanUsage } = await import('../src/schema.mjs');
  const bases = ['increment', 'sample', 'transcript'];
  for (const basis of bases) assert.equal(cleanUsage({ basis }).basis, basis, `the schema accepts ${basis}`);
  assert.equal(cleanUsage({ basis: 'other' }).basis, 'increment', 'and nothing else');
  let explained = 0;
  for (const name of fs.readdirSync(SKILLS_ROOT)) {
    const file = path.join(SKILLS_ROOT, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/`sample`/.test(text) || !/`increment`/.test(text)) continue;
    explained += 1;
    for (const basis of bases) assert.ok(text.includes(`\`${basis}\``), `${name} explains the bases but not ${basis}`);
    assert.ok(text.includes('imported_turns'), `${name} must say where imported turns are counted`);
  }
  assert.ok(explained >= 1, 'at least one skill explains the bases');
});

// Intent 19, D1/D2: the one skill that runs the import holds its privacy
// boundary in words, so each rule is a sentence this test can find (FR-19,
// FR-20, SM-10). The agent has its own file tools; only the skill forbids them.
test('the history-import skill states every rule that keeps session files out of the agent\'s context', () => {
  const { body } = frontmatter('tw-import-history');
  const rules = {
    'resolves the agent first': /^tokenwatch agents$/m,
    'checks before anything is written': /tokenwatch import <agent> --check --json/,
    'branches on the diagnosis field': /Read `diagnosis` first/,
    'imports only with a yes': /Import only after the user says yes/,
    'keeps a repair only with a yes': /keep a repaired mapping only\s+after the user says yes/,
    'the unverified gate': /after the user has typed or said the word unverified/,
    'three proposals at most': /Three proposals at most/,
    'never opens a session file': /Never open, read, list or search a session file or directory with your own\s+tools/,
    'nothing but command output': /Pass the model nothing from a session file except the output of the\s+commands below/,
    'never edits code or bundled mappings': /Never edit anything under `src\/`, a bundled mapping, or an installed\s+package/,
    'changes only paths': /change only paths/,
    'never guesses a value': /Never change a\s+predicate's `equals` value/,
    'never changes what the numbers mean': /never change\s+`semantics`, `usage_mode`, `authority`, `overlap` or `agent`/,
    'names the repair': /`<bundled-id>-r<N>`/,
    'records where it came from': /evidence\.repaired_from/,
    'undoes before replacing': /Run `--undo <id>` before replacing a kept mapping's rows/,
    'repairs only an unfit mapping': /`mismatch` with `mapping_paths\.unresolved` empty[^]*Do not propose a mapping/,
    'a renamed value is not repairable': /cannot be repaired from the shape/,
    'tells the user about changed meaning': /differs_from_bundled/,
    'shares as data': /--export-mapping/,
    'leaves paths out of an issue': /Leave out `session_dir` and any file name/,
    'a damaged install is not a repair': /`bundled_mapping_broken: true`[^]*reinstall Tokenwatch/
  };
  for (const [rule, pattern] of Object.entries(rules)) assert.match(body, pattern, `tw-import-history must state: ${rule}`);
  assert.doesNotMatch(body, /--values/, 'no value enumeration (D1)');
});

// #15: a model following the skill branches on what `--check --json` prints. A
// diagnosis the skill does not name, or an `errors` token it does not explain,
// leaves the model to guess. Both lists are read from the code that emits them.
test('the history-import skill names every diagnosis and errors token --check can print, and what null means', () => {
  const { body } = frontmatter('tw-import-history');
  const read = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const run = read('import/run.mjs');
  const reasons = read('schema.mjs').match(/IMPORT_REASONS = \[([^\]]*)\]/)[1].match(/'[a-z_]+'/g).map((quoted) => quoted.slice(1, -1));
  const own = [...run.matchAll(/'(verified|no_directory|glob_matches_nothing|paths_unresolved|mapping_invalid)'/g)].map((match) => match[1]);
  const diagnoses = [...new Set([...reasons, ...own])].sort();
  assert.deepEqual(diagnoses, ['glob_matches_nothing', 'mapping_invalid', 'mismatch', 'no_directory', 'no_live_tokens', 'no_overlap', 'paths_unresolved', 'verified']);
  for (const diagnosis of diagnoses) assert.match(body, new RegExp('`' + diagnosis + '`'), `the skill must say what ${diagnosis} means`);
  const tokens = [...read('import/mapping.mjs').matchAll(/'(<file:[a-z_]+>)'/g)].map((match) => match[1]);
  assert.equal(tokens.length, 3);
  for (const token of tokens) assert.ok(body.includes(`\`${token}\``), `the skill must explain ${token}`);
  assert.match(body, /`errors` is always a list/);
  assert.match(body, /never read `null` as zero/);
  assert.match(body, /with an empty `errors`/);
});
