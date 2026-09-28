import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { estimateEventCost } from '../src/pricing.mjs';
import { isLoopbackHost } from '../src/otlp-server.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { main } from '../src/cli.mjs';
import { spawnSync } from 'node:child_process';
import { claudeCommands, renderCommand } from '../src/installer.mjs';
import { CLAUDE_HOOK_EVENTS } from '../src/constants.mjs';
import { tempDir, testConfig } from './helpers.mjs';

// This project states a set of things it refuses to do, and treats "a refusal
// we care about gets a test" as a working principle. Three of them had none,
// which is how a refusal quietly becomes a preference: the code still declines,
// but nothing notices when a later change stops it declining.

// Refusing to price from an incomplete rule is the sharper half of "ships no
// prices": a partial rule would produce a number that looks like the others on
// the line and is silently missing a component.
test('an incomplete pricing rule produces no estimate, and names what is missing', () => {
  const event = {
    model: 'test-model',
    usage: { input_fresh: 1_000_000, output: 1_000_000, basis: 'increment' }
  };
  const pricing = { models: [{ match: 'test-model', input_per_million: 3 }], _version: 'test' };
  const result = estimateEventCost(event, pricing);
  assert.equal(result.complete, false, 'a rule missing output_per_million must not price');
  assert.deepEqual(result.missing, ['output_per_million'], 'and must say which rate was absent');
  assert.equal(result.amount_usd, undefined, 'no partial amount may be reported');
});

test('a rule that prices nothing the event used is also incomplete', () => {
  const event = { model: 'test-model', usage: { basis: 'increment' } };
  const pricing = { models: [{ match: 'test-model', input_per_million: 3 }], _version: 'test' };
  const result = estimateEventCost(event, pricing);
  assert.equal(result.complete, false);
  assert.equal(result.amount_usd, undefined);
});

// Pricing a gauge would charge for the whole context once per status refresh.
test('a sample-basis gauge is never priced', () => {
  const event = {
    model: 'test-model',
    usage: { input_fresh: 1_000_000, output: 1000, basis: 'sample' }
  };
  const pricing = { models: [{ match: 'test-model', input_per_million: 3, output_per_million: 15 }], _version: 'test' };
  assert.equal(estimateEventCost(event, pricing), null, 'a re-reported gauge is not a billable call');
});

// The receiver is unauthenticated. Binding it anywhere but loopback hands that
// to the network, so both guards that say so need to keep saying so.
test('loopback is recognised, and anything else is not', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, `${host} is not loopback and must not pass as it`);
  }
});

test('doctor warns when the OTLP receiver is not bound to loopback', () => {
  const root = tempDir();
  const safe = testConfig(root);
  const safeCheck = runDoctor(safe, path.join(root, 'config.json'))
    .checks.find((check) => check.id === 'otlp-bind');
  assert.equal(safeCheck.status, 'ok', 'the loopback default is fine');

  const exposed = testConfig(root);
  exposed.codex = { ...exposed.codex, otlpHost: '0.0.0.0' };
  const exposedCheck = runDoctor(exposed, path.join(root, 'config.json'))
    .checks.find((check) => check.id === 'otlp-bind');
  assert.equal(exposedCheck.status, 'warn', 'binding every interface must be reported');
  assert.match(exposedCheck.detail, /0\.0\.0\.0/);
});

// Deleting history is something you ask for. `retentionDays` is advisory and
// prune deliberately does not fall back to it, so a bare `prune` must refuse
// rather than quietly remove three months of ledger.
test('prune refuses to run without an explicit window', async () => {
  const root = tempDir();
  const config = testConfig(root);
  await assert.rejects(
    main(['prune'], { config, configFile: path.join(root, 'config.json') }),
    /older-than/,
    'a bare prune must say what it needs rather than choose a window itself'
  );
});

// `--retention` is what makes the configured `retentionDays` do something. It
// stays opt-in: a bare `prune` must still refuse rather than inherit a window
// and delete months of history nobody asked it to.
test('prune uses the configured window only when explicitly asked', async () => {
  const root = tempDir();
  const config = testConfig(root);
  const write = (isoTimestamp) => `${JSON.stringify({
    schema: 'tokenwatch.event/v1', event_id: isoTimestamp, ts: isoTimestamp,
    agent: 'claude-code', kind: 'usage', source: 'statusline'
  })}\n`;
  fs.writeFileSync(config.dataFile,
    write(new Date(Date.now() - 200 * 86_400_000).toISOString())
    + write(new Date(Date.now() - 2 * 86_400_000).toISOString()));

  await main(['prune', '--retention'], { config, configFile: path.join(root, 'config.json') });
  const remaining = fs.readFileSync(config.dataFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(remaining.length, 1, 'only the event outside the 90d window is removed');
});

// Claude Code runs a hook through Git Bash on Windows when it is installed. The
// PowerShell `& '...'` form is a Bash syntax error, exit 2, and Claude Code
// treats exit 2 from UserPromptSubmit and Stop as a block: every prompt would be
// refused. So that form is never written for Claude, on any platform (intent 17,
// R1), and this test says why by running it.
test('a Claude Code hook is never written in the PowerShell call-operator form, which Bash exits 2 on', () => {
  const cli = 'C:\\Users\\Seán O\'Brien\\tw\\bin\\tokenwatch.mjs';
  for (const platform of ['win32', 'linux', 'darwin']) {
    const commands = claudeCommands({ node: 'C:\\nodejs\\node.exe', cli, platform });
    for (const command of [...Object.values(commands.hooks), commands.status]) {
      assert.ok(!command.startsWith('&'), `${platform}: ${command}`);
    }
  }
  const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) => fs.existsSync(candidate));
  if (!bash) return;
  const powershellForm = renderCommand(['C:\\nodejs\\node.exe', cli, 'hook', 'claude', CLAUDE_HOOK_EVENTS[0]], 'powershell');
  assert.equal(spawnSync(bash, ['-c', powershellForm], { encoding: 'utf8' }).status, 2, 'the & form is a Bash syntax error');
});
