import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { runCodexWrapper } from '../src/codex-wrapper.mjs';
import { spawnPortable } from '../src/spawn.mjs';
import { tempDir, testConfig, fixture } from './helpers.mjs';

// A real child posts an OTLP batch to the endpoint Codex receives. Only the
// Codex executable is substituted; receiver, normalization and storage run.
function postingChild(config, inspect = () => {}) {
  return (command, args, options) => {
    assert.equal(args[0], '-c');
    assert.equal(args[2], '-c');
    assert.equal(args[3], 'otel.log_user_prompt=false');
    const endpoint = JSON.parse(/endpoint = ("[^"]+")/.exec(args[1])[1]);
    assert.match(args[1], /protocol = "json"/);
    assert.ok(new URL(endpoint).port !== '0');
    inspect(args, endpoint);
    const script = `const response = await fetch(process.argv[1], {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: process.argv[2]
    }); if (!response.ok) process.exit(7);`;
    return spawnPortable(process.execPath, ['--input-type=module', '-e', script, endpoint,
      JSON.stringify(fixture('codex-otlp.json'))], options);
  };
}

test('wrapper captures usage without an installed Codex config, with an OS-assigned port', async () => {
  const config = testConfig(tempDir());
  const userArgs = ['exec', '--json', 'a prompt with spaces and "quotes"'];
  const code = await runCodexWrapper(userArgs, { config,
    spawn: postingChild(config, (args) => assert.deepEqual(args.slice(4), userArgs)) });
  assert.equal(code, 0);
  const events = fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.usage?.input_total > 0), 'OTLP reaches the ledger');
});

test('an occupied port gets an independent receiver rather than an unknown listener', async (t) => {
  let requests = 0;
  const unrelated = http.createServer((req, res) => { requests += 1; res.end('{}'); });
  await new Promise((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const config = testConfig(tempDir());
  config.codex.otlpPort = unrelated.address().port;
  assert.equal(await runCodexWrapper(['exec', 'OK'], { config,
    spawn: postingChild(config, (args, endpoint) => assert.notEqual(Number(new URL(endpoint).port), config.codex.otlpPort)) }), 0);
  assert.equal(requests, 0);
  assert.ok(fs.existsSync(config.dataFile));
});

test('a synchronous spawn failure releases the receiver too', async () => {
  const config = testConfig(tempDir());
  let port;
  await assert.rejects(runCodexWrapper([], { config, spawn: (command, args) => {
    port = Number(new URL(JSON.parse(/endpoint = ("[^"]+")/.exec(args[1])[1])).port);
    throw new Error('spawn failed');
  } }), /spawn failed/);
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
});
