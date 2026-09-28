import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { repairLedger } from '../src/repair.mjs';
import { tempDir, testConfig } from './helpers.mjs';

function writeLedger(config, events) {
  fs.writeFileSync(config.dataFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function readLedger(config) {
  return fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').map(JSON.parse);
}
function fragment(config, promptId, cumulative, delta, output) {
  const [event] = normalizeClaude('status', {
    session_id: 's', prompt_id: promptId, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cumulative },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: output } }
  }, config, 'statusline');
  event.cost.delta_usd = delta;
  return event;
}

test('repair merges exchange fragments without changing total cost', async () => {
  const config = testConfig(tempDir());
  // One exchange written as three fragments, plus a separate exchange.
  writeLedger(config, [
    fragment(config, 'A', 1.0, 0.4, 10),
    fragment(config, 'A', 1.5, 0.5, 20),
    fragment(config, 'A', 2.0, 0.5, 30),
    fragment(config, 'B', 2.6, 0.6, 40)
  ]);
  const before = readLedger(config).reduce((sum, e) => sum + (e.cost?.delta_usd ?? 0), 0);

  const result = await repairLedger(config, {});
  assert.equal(result.fragments_merged, 2);
  assert.equal(result.records_after, 2, 'three fragments collapse into one exchange');
  assert.ok(fs.existsSync(result.backup), 'the original ledger is backed up');

  const after = readLedger(config);
  const total = after.reduce((sum, e) => sum + (e.cost?.delta_usd ?? 0), 0);
  assert.ok(Math.abs(total - before) < 1e-9, `cost must be preserved: ${before} -> ${total}`);
  const merged = after.find((e) => e.turn_id === 'A');
  assert.ok(Math.abs(merged.cost.delta_usd - 1.4) < 1e-9, 'fragment deltas are summed');
  assert.equal(merged.usage.output, 30, 'the final gauge reading wins');
  assert.equal(merged.cost.cumulative_usd, 2.0);
});

test('repair leaves records without a turn id alone', async () => {
  const config = testConfig(tempDir());
  const [hook] = normalizeClaude('UserPromptSubmit', { session_id: 's' }, config, 'hook');
  writeLedger(config, [hook, hook, fragment(config, 'A', 1, 0.1, 5)]);
  const result = await repairLedger(config, {});
  assert.equal(result.fragments_merged, 0);
  assert.equal(result.records_after, 3, 'untagged records are never merged');
});

test('a dry run reports without writing', async () => {
  const config = testConfig(tempDir());
  writeLedger(config, [fragment(config, 'A', 1, 0.4, 10), fragment(config, 'A', 2, 0.6, 20)]);
  const result = await repairLedger(config, { dryRun: true });
  assert.equal(result.fragments_merged, 1);
  assert.equal(result.backup, undefined);
  assert.equal(readLedger(config).length, 2, 'the ledger is untouched');
});
