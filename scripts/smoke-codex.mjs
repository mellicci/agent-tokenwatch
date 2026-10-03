// Optional integration check: real Codex CLI, local Responses API fixture.
// No API key, remote inference, or user's Codex/Tokenwatch settings are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { install, uninstall } from '../src/installer.mjs';
import { runCodexWrapper } from '../src/codex-wrapper.mjs';
import { spawnPortable } from '../src/spawn.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwatch-codex-smoke-'));
const codexHome = path.join(root, 'codex');
const twHome = path.join(root, 'tokenwatch');
fs.mkdirSync(codexHome);
const canary = 'TW_CODEX_SMOKE_PRIVATE_CANARY';
const notified = path.join(root, 'notified.json');
const notifier = path.join(root, 'notifier.mjs');
fs.writeFileSync(notifier, `import fs from 'node:fs';
const payload = JSON.parse(process.argv.at(-1));
fs.writeFileSync(${JSON.stringify(notified)}, JSON.stringify({ok: payload.type === 'agent-turn-complete'}));\n`);
const configPath = path.join(codexHome, 'config.toml');
// The wrapper must override a pre-existing exporter without editing it.
const original = `notify = ${JSON.stringify([process.execPath, notifier])}\n`
  + '[otel]\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:9/v1/logs", protocol = "json" } }\n'
  + 'log_user_prompt = true\n';
fs.writeFileSync(configPath, original);
const { config } = loadConfig({ env: { ...process.env, TOKENWATCH_HOME: twHome } });
config.codex.otlpPort = 0;
config.codex.otlpProtocol = process.argv.includes('--binary') ? 'binary' : 'json';

let requests = 0;
const api = http.createServer(async (req, res) => {
  for await (const chunk of req) { /* Consume without retaining the prompt. */ }
  if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
  requests += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = { id: `msg_${requests}`, type: 'message', role: 'assistant',
    status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const response = { id: `resp_${requests}`, object: 'response', created_at: 1,
    model: 'codex-smoke', status: 'completed', output: [item],
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 800 },
      output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1250 } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response }
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});

try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  install(config, { agents: 'codex', scope: 'user', compose: true,
    codexConfig: configPath, sharedSkills: path.join(root, 'skills') });
  const version = await new Promise((resolve, reject) => {
    const child = spawnPortable('codex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(text.trim()) : reject(new Error('Codex is not installed')));
  });
  const code = await runCodexWrapper(['-c', 'model_provider="tokenwatch_smoke"',
    '-c', `model_providers.tokenwatch_smoke={ name="Tokenwatch local fixture", base_url="http://127.0.0.1:${api.address().port}/v1", wire_api="responses", requires_openai_auth=false }`,
    '-c', 'model="codex-smoke"', '-c', 'model_reasoning_effort="low"',
    'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
    '-C', root, `Reply OK without tools. ${canary}`], { config,
    spawn: (command, args, options) => {
      const child = spawnPortable(command, args, { ...options,
        env: { ...options.env, CODEX_HOME: codexHome, TOKENWATCH_HOME: twHome },
        stdio: ['ignore', 'pipe', 'pipe'] });
      // Drain without printing or saving potentially sensitive agent output.
      child.stdout.resume();
      child.stderr.resume();
      const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
      child.once('exit', () => clearTimeout(timeout));
      child.once('error', () => clearTimeout(timeout));
      return child;
    } });
  assert.equal(code, 0, 'Codex must finish the local fixture turn');
  assert.equal(requests, 1, 'exactly one local model request');
  // Codex launches notify asynchronously. Allow its Node process to finish.
  const until = Date.now() + 5000;
  while (!fs.existsSync(notified) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(JSON.parse(fs.readFileSync(notified, 'utf8')).ok, true, 'the prior notifier ran');
  assert.ok(fs.readFileSync(configPath, 'utf8').includes('http://127.0.0.1:9/v1/logs'), 'the persistent exporter is preserved');
  const ledger = fs.readFileSync(config.dataFile, 'utf8');
  assert.ok(!ledger.includes(canary), 'prompt content never reaches the ledger');
  const rows = ledger.trim().split('\n').map(JSON.parse);
  const usage = rows.filter((row) => row.usage);
  assert.ok(usage.some((row) => row.usage.input_total === 1200 && row.usage.cache_read === 800
    && row.usage.output === 50 && row.usage.reasoning === 20), 'Codex exports the fixture usage exactly');
  for (const [field, expected] of Object.entries({ input_total: 1200, cache_read: 800, output: 50, reasoning: 20 })) {
    assert.equal(usage.reduce((sum, row) => sum + (row.usage[field] ?? 0), 0), expected,
      `${field} must not be counted twice`);
  }
  assert.ok(rows.some((row) => row.source === 'notify'), 'turn boundary is recorded');
  uninstall(config, { scope: 'user' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), original, 'uninstall restores the notifier');
  console.log(JSON.stringify({ ok: true, codex: version, provider: 'local fixture',
    protocol: config.codex.otlpProtocol,
    input: 1200, cached: 800, output: 50, reasoning: 20, notifierForwarded: true, privacyCanaryAbsent: true }));
} finally {
  await new Promise((resolve) => api.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
