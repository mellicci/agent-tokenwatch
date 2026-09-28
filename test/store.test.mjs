import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { normalizeCopilot } from '../src/normalize/copilot.mjs';
import { aggregateEvents, rollingStatusFromState } from '../src/aggregate.mjs';
import { comparePeriods, rankGroups, turnConcentration } from '../src/rank.mjs';
import { formatStatus } from '../src/format.mjs';
import { flushPendingTurns, loadState, resolveStatusSession, sessionStateFile, statusState, storeEvent, storeEvents, tryFlushPendingTurns } from '../src/store.mjs';
import { isWriteRefused } from '../src/fs-util.mjs';
import { fixture, tempDir, testConfig } from './helpers.mjs';
import { makeEvent } from '../src/schema.mjs';

function ledgerLines(config) {
  if (!fs.existsSync(config.dataFile)) return [];
  const text = fs.readFileSync(config.dataFile, 'utf8').trim();
  return text ? text.split('\n').map(JSON.parse) : [];
}

test('status renders of one turn collapse into a single ledger record', () => {
  const config = testConfig(tempDir());
  const [first] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  const [second] = normalizeClaude('status', fixture('claude-status-2.json'), config, 'statusline');
  const firstResult = storeEvent(first, config);
  const secondResult = storeEvent(second, config);

  assert.equal(firstResult.pending, true);
  assert.equal(secondResult.pending, true);
  assert.equal(ledgerLines(config).length, 0, 'renders are held, not appended per refresh');

  assert.equal(flushPendingTurns(config), 1);
  const lines = ledgerLines(config);
  assert.equal(lines.length, 1, 'one turn produces exactly one durable record');
  assert.ok(Math.abs(lines[0].cost.delta_usd - 0.03) < 1e-10, 'turn cost is the accumulated delta');
  assert.equal(lines[0].usage.basis, 'sample');
  // Fixture 1 totals 8000 and fixture 2 totals 8500. Summing would give 16500.
  assert.equal(lines[0].usage.input_total, 8500, 'the latest gauge wins rather than being summed');
});

test('a new prompt closes the previous turn and starts a new one', () => {
  const config = testConfig(tempDir());
  const [render] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  storeEvent(render, config);
  storeEvent(render, { ...config, dataFile: config.dataFile }); // duplicate render, same turn

  const [prompt] = normalizeClaude('UserPromptSubmit', { session_id: 'claude-session-1' }, config, 'hook');
  storeEvent(prompt, config);

  const lines = ledgerLines(config);
  assert.equal(lines.filter((line) => line.source === 'statusline').length, 1, 'previous turn flushed once');
  assert.equal(lines.filter((line) => line.event_name === 'UserPromptSubmit').length, 1);

  const [next] = normalizeClaude('status', fixture('claude-status-2.json'), config, 'statusline');
  storeEvent(next, config);
  assert.equal(flushPendingTurns(config), 1);
  assert.equal(ledgerLines(config).filter((line) => line.source === 'statusline').length, 2,
    'the second turn is a separate record');
});

test('first cumulative cost is a baseline and the next snapshot yields a delta', () => {
  const config = testConfig(tempDir());
  const [first] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  const [second] = normalizeClaude('status', fixture('claude-status-2.json'), config, 'statusline');
  assert.equal(storeEvent(first, config).event.cost.delta_usd, undefined);
  assert.ok(Math.abs(storeEvent(second, config).event.cost.delta_usd - 0.03) < 1e-10);

  const snapshot = rollingStatusFromState(statusState(config), config, 'claude');
  // Both renders belong to the turn still in flight, so nothing has completed yet.
  assert.ok(Math.abs(snapshot.in_flight_cost_usd - 0.03) < 1e-10);
  assert.equal(snapshot.last_prompt_cost_usd, undefined);
  assert.ok(Math.abs(snapshot.session_cost_usd - 1.28) < 1e-10, 'cumulative session cost is surfaced');
});

test('a configured cache TTL is never presented as an observation', () => {
  const config = testConfig(tempDir());
  const [event] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  const stored = storeEvent(event, config).event;
  assert.equal(stored.cache, undefined, 'no provider cache data means no cache block');
  const snapshot = rollingStatusFromState(statusState(config), config, 'claude');
  assert.equal(snapshot.cache_ttl_source, undefined);
  assert.equal(snapshot.cache_ttl_seconds, undefined);
});

test('provider-reported cache metadata is recorded as measured', () => {
  const config = testConfig(tempDir());
  const payload = fixture('claude-status-1.json');
  payload.prompt_cache = { ttl: '1h', hit_ratio: 0.82 };
  const [event] = normalizeClaude('status', payload, config, 'statusline');
  assert.equal(event.cache.ttl_seconds, 3600);
  assert.equal(event.cache.ttl_source, 'provider_reported');
  assert.ok(Math.abs(event.cache.hit_rate - 0.82) < 1e-10);
});

test('fingerprints deduplicate retried telemetry', () => {
  const config = testConfig(tempDir());
  const [event] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  storeEvent(event, config);
  assert.equal(storeEvent(event, config).duplicate, true);
});

test('a wall-clock duration does not change the fingerprint', () => {
  const config = testConfig(tempDir());
  const early = fixture('claude-status-1.json');
  const later = fixture('claude-status-1.json');
  later.cost.total_duration_ms = early.cost.total_duration_ms + 900_000;
  const [a] = normalizeClaude('status', early, config, 'statusline');
  const [b] = normalizeClaude('status', later, config, 'statusline');
  assert.equal(a.fingerprint, b.fingerprint,
    'session age must not make an unchanged turn look like a new observation');
});

test('pricing skips gauge samples and prices per-call increments', () => {
  const root = tempDir();
  const config = testConfig(root);
  config.pricingFile = path.join(root, 'pricing.json');
  fs.writeFileSync(config.pricingFile, JSON.stringify({
    version: 'test-v1',
    models: [{
      agent: 'claude-code', match: 'claude-test-*',
      input_per_million: 3, cache_read_per_million: 0.3,
      cache_write_per_million: 3.75, output_per_million: 15, reasoning_per_million: 15
    }]
  }));

  const samplePayload = fixture('claude-status-1.json');
  delete samplePayload.cost;
  const [sample] = normalizeClaude('status', samplePayload, config, 'statusline');
  assert.equal(storeEvent(sample, config).event.cost, undefined,
    'a repeatedly refreshed gauge must not be priced once per refresh');

  const incrementPayload = fixture('claude-status-1.json');
  delete incrementPayload.cost;
  const [increment] = normalizeClaude('Stop', incrementPayload, config, 'hook');
  const priced = storeEvent(increment, config).event;
  assert.equal(priced.cost.basis, 'configured_estimate');
  assert.ok(priced.cost.amount_usd > 0);
});

test('split cache writes are priced once, not alongside their synthesized total', () => {
  const root = tempDir();
  const config = testConfig(root);
  config.pricingFile = path.join(root, 'pricing.json');
  fs.writeFileSync(config.pricingFile, JSON.stringify({
    version: 'test-v1',
    models: [{
      agent: 'claude-code', match: 'claude-test-*',
      input_per_million: 3, cache_read_per_million: 0.3,
      cache_write_5m_per_million: 3.75, cache_write_1h_per_million: 6,
      cache_write_per_million: 3.75, output_per_million: 15
    }]
  }));
  const payload = {
    session_id: 'claude-session-1',
    model: { id: 'claude-test-model' },
    context_window: {
      context_window_size: 200000,
      current_usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 6500,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
        output_tokens: 900
      }
    }
  };
  const [event] = normalizeClaude('Stop', payload, config, 'hook');
  assert.equal(event.usage.cache_write, 3000, 'the split is still summarized for display');
  const priced = storeEvent(event, config).event;
  const expected = (1000 * 3 + 6500 * 0.3 + 1000 * 3.75 + 2000 * 6 + 900 * 15) / 1_000_000;
  assert.ok(Math.abs(priced.cost.amount_usd - expected) < 1e-9,
    `expected ${expected}, got ${priced.cost.amount_usd}`);
});

test('status refreshes do not overwrite subagent entries in the live ring', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 'claude-session-1',
    model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 10, current_usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }
  }, config, 'statusline')[0];
  const lifecycle = (name) => normalizeClaude(name, { session_id: 'claude-session-1', agent_type: 'probe' }, config, 'hook')[0];

  storeEvent(render(1), config);
  storeEvent(lifecycle('SubagentStart'), config);
  storeEvent(render(1.5), config);
  storeEvent(render(2), config);
  storeEvent(lifecycle('SubagentStop'), config);
  storeEvent(render(2.2), config);

  const snapshot = rollingStatusFromState(statusState(config), config, 'claude');
  assert.equal(snapshot.subagent_count, 1, 'a refresh must not clobber the subagent record');
  // Cost moved 1.00 -> 2.00 while the subagent ran; the 0.20 after it stopped is excluded.
  assert.ok(Math.abs(snapshot.subagent_cost_usd - 1) < 1e-9, `got ${snapshot.subagent_cost_usd}`);
  assert.ok(Math.abs(snapshot.subagent_cost_share - (1 / 2.2)) < 1e-9);
});

test('subagent cost excludes spend outside the window entirely', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 's', model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  storeEvent(render(5), config);
  storeEvent(render(9), config);
  const snapshot = rollingStatusFromState(statusState(config), config, 'claude');
  assert.equal(snapshot.subagent_cost_usd, undefined, 'no subagents means no attributed cost');
  assert.equal(snapshot.subagent_cost_share, undefined);
});

test('last prompt reports the last completed exchange, not the one in flight', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 's', model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  const prompt = () => normalizeClaude('UserPromptSubmit', { session_id: 's' }, config, 'hook')[0];

  storeEvent(prompt(), config);
  storeEvent(render(1), config);
  storeEvent(render(3), config);   // first exchange completes worth 2.00
  storeEvent(prompt(), config);
  storeEvent(render(3.25), config); // second exchange is still running, 0.25 so far

  const snapshot = rollingStatusFromState(statusState(config), config, 'claude');
  assert.ok(Math.abs(snapshot.last_prompt_cost_usd - 2) < 1e-9,
    `last completed exchange should be 2.00, got ${snapshot.last_prompt_cost_usd}`);
  assert.ok(Math.abs(snapshot.in_flight_cost_usd - 0.25) < 1e-9,
    `in-flight should be 0.25, got ${snapshot.in_flight_cost_usd}`);
  // The partial must not drag the average down.
  assert.ok(Math.abs(snapshot.average_provider_cost_usd - 2) < 1e-9,
    `average should exclude the partial, got ${snapshot.average_provider_cost_usd}`);
});

// A report flushes the reply in flight to the ledger mid-reply, and the renders
// after it start a new held row for the same prompt. The status line showed only
// what came after the flush (0.05 of a 0.15 reply); `analyze` always summed both
// rows. The reply's running total in session state survives the flush.
test('a report flushing the reply in flight does not shrink what the status line shows for it', () => {
  const config = testConfig(tempDir());
  const render = (cost, input) => storeEvent(normalizeClaude('status', {
    session_id: 's', prompt_id: 'p1', model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: input, output_tokens: 1 } }
  }, config, 'statusline')[0], config);
  render(1, 1);                   // baseline: 1.00 spent before this session was seen
  storeEvent(normalizeClaude('UserPromptSubmit', { session_id: 's', prompt_id: 'p1' }, config, 'hook')[0], config);
  render(1.05, 2);
  render(1.1, 3);
  tryFlushPendingTurns(config);   // `analyze`, `agents` or `export` ran mid-reply
  render(1.15, 4);

  const snapshot = rollingStatusFromState(statusState(config, 's'), config, 'claude');
  assert.ok(Math.abs(snapshot.in_flight_cost_usd - 0.15) < 1e-9,
    `the whole reply so far, got ${snapshot.in_flight_cost_usd}`);
  flushPendingTurns(config);
  const reply = aggregateEvents(ledgerLines(config)).turns_data.find((turn) => turn.turn_id === 'p1');
  assert.ok(Math.abs(reply.provider_cost_usd - 0.15) < 1e-9, `analyze agrees, got ${reply.provider_cost_usd}`);
});

// F3, Windows live test on Claude Code 2.1.283: 16 turns for 8 prompts plus 4
// billed background-agent notification turns. The other 4 were status-line
// renders with a new prompt id and nothing behind them - the baseline render
// before the first prompt, and the renders after /status, /cost and /compact -
// each counted as a zero-cost turn. The sequence below is that session's shape.
function claudeLiveSession(config) {
  const at = (minute) => `2026-09-28T12:${String(minute).padStart(2, '0')}:00.000Z`;
  const status = (prompt, minute, cost, percent, usage) => storeEvent(normalizeClaude('status', {
    session_id: 's', prompt_id: prompt, timestamp: at(minute), model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: percent, current_usage: usage ?? null }
  }, config, 'statusline')[0], config);
  const hook = (name, prompt, minute) => storeEvent(normalizeClaude(name, {
    session_id: 's', prompt_id: prompt, timestamp: at(minute)
  }, config, 'hook')[0], config);
  const first = { input_tokens: 3, cache_creation_input_tokens: 4000, cache_read_input_tokens: 36000, output_tokens: 20 };
  const second = { input_tokens: 2, cache_creation_input_tokens: 40, cache_read_input_tokens: 41000, output_tokens: 4 };
  const third = { input_tokens: 5, cache_creation_input_tokens: 5600, cache_read_input_tokens: 31800, output_tokens: 60 };

  status('boot', 0, 0, 0);                       // baseline render before the first prompt
  hook('UserPromptSubmit', 'p1', 1);
  status('p1', 2, 0.05, 4, first);               // a real call, 0.05
  hook('Stop', 'p1', 2);
  status('slash-status', 3, 0.05, 4, first);     // /status: new prompt id, same gauge, no cost
  hook('UserPromptSubmit', 'p2', 4);
  status('p2', 5, 0.12, 4, second);              // a real call, 0.07
  hook('Stop', 'p2', 5);
  status('slash-cost', 6, 0.12, 4, second);      // /cost and /context
  hook('PreCompact', 'compact', 7);
  hook('SessionStart', 'compact', 7);
  hook('SubagentStop', 'compact', 7);            // a late stop landed here in the live run
  status('compact', 8, 0.12, 3, second);         // the render after /compact
  hook('UserPromptSubmit', 'notify', 9);         // Claude Code's background-agent notification
  status('notify', 10, 0.15, 5, third);          // a real, billed call, 0.03
  hook('Stop', 'notify', 10);
  flushPendingTurns(config);
  return ledgerLines(config);
}

test('status-line renders with no model call behind them are not counted as turns', () => {
  const config = testConfig(tempDir());
  const events = claudeLiveSession(config);
  const aggregate = aggregateEvents(events);

  assert.equal(aggregate.turns, 3, `two prompts and one notification turn, got ${aggregate.turns}`);
  assert.equal(aggregate.render_only_readings, 4, 'the baseline, /status, /cost and post-compact renders');
  assert.ok(Math.abs(aggregate.cost.provider_reported_usd - 0.15) < 1e-9,
    `the session total is unchanged, got ${aggregate.cost.provider_reported_usd}`);
  assert.equal(aggregate.cost.provider_turns, 3, 'no zero-cost render is counted as a costed turn');
  assert.ok(Math.abs(aggregate.cost.average_provider_turn_usd - 0.05) < 1e-9,
    `got ${aggregate.cost.average_provider_turn_usd}`);
  assert.equal(Object.values(aggregate.models).reduce((sum, row) => sum + row.turns, 0), 3);
  assert.deepEqual(aggregate.turns_data.map((turn) => turn.turn_id), ['p1', 'p2', 'notify']);

  // Every render is still a context reading: nothing measured is thrown away.
  assert.equal(aggregate.context_percent_samples.turns, 7);
  assert.equal(aggregate.context_percent_samples.percent_last, 5);
  assert.equal(aggregate.context_samples.turns, 6, 'every render that carried a token gauge');

  const ranked = rankGroups(events, { by: 'session' });
  assert.equal(ranked.turns, 3);
  assert.equal(ranked.groups[0].turns, 3);
  assert.ok(Math.abs(ranked.groups[0].cost_per_turn_usd - 0.05) < 1e-9,
    `cost per turn divides by real turns, got ${ranked.groups[0].cost_per_turn_usd}`);
  assert.ok(Math.abs(ranked.total_provider_usd - 0.15) < 1e-9);
  assert.equal(turnConcentration(events).turns, 3);

  const comparison = comparePeriods(events, []);
  assert.equal(comparison.turns.current, 3);
  assert.ok(Math.abs(comparison.cost_per_turn_usd.current - 0.05) < 1e-9);
});

// The same renders on the live status line: a /status render became the "turn"
// in flight while idle, and once the next prompt flushed it, the "previous
// reply" at $0 and a slot in the averaging window.
test('a render with no model call behind it is never the previous reply or part of the average', () => {
  const config = { ...testConfig(tempDir()), averagingWindow: 2 };
  const gauge = (output) => ({ input_tokens: 2, cache_read_input_tokens: 9000, output_tokens: output });
  const status = (prompt, cost, usage) => storeEvent(normalizeClaude('status', {
    session_id: 's', prompt_id: prompt, model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: usage }
  }, config, 'statusline')[0], config);
  const prompt = (id) => storeEvent(normalizeClaude('UserPromptSubmit', { session_id: 's', prompt_id: id }, config, 'hook')[0], config);

  status('boot', 1, gauge(1));   // baseline: 1.00 already spent before this session was seen
  prompt('p1');
  status('p1', 1.05, gauge(10)); // 0.05
  prompt('p2');
  status('p2', 1.12, gauge(20)); // 0.07
  status('slash-status', 1.12, gauge(20));

  const idle = rollingStatusFromState(statusState(config), config, 'claude');
  assert.ok(Math.abs(idle.in_flight_cost_usd - 0.07) < 1e-9,
    `a /status render does not change what the line shows, got ${idle.in_flight_cost_usd}`);
  assert.ok(Math.abs(idle.last_prompt_cost_usd - 0.05) < 1e-9, `got ${idle.last_prompt_cost_usd}`);

  prompt('p3');
  status('p3', 1.2, gauge(30));  // 0.08, still in flight
  const next = rollingStatusFromState(statusState(config), config, 'claude');
  assert.ok(Math.abs(next.last_prompt_cost_usd - 0.07) < 1e-9,
    `the previous reply is p2, not the /status render, got ${next.last_prompt_cost_usd}`);
  assert.equal(next.average_window, 2, 'the window holds two charged turns');
  assert.ok(Math.abs(next.average_provider_cost_usd - 0.06) < 1e-9, `got ${next.average_provider_cost_usd}`);
  assert.ok(Math.abs(next.session_cost_usd - 1.2) < 1e-9, 'the session total still comes from the newest render');
});

// Copilot's counters are session-cumulative, so each call is the movement
// between two renders and every render is its own row. A render that moved
// nothing is only a context reading; recorded Copilot 1.0.85 payloads.
test('a Copilot render that moved no tokens or units is a context reading, not a turn', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const render = (payload) => storeEvents(normalizeCopilot('status', payload, config, 'statusline'), config);
  render(fixture('copilot-status-cumulative-1.json'));   // baseline: nothing to diff yet
  render(fixture('copilot-status-cumulative-2.json'));   // one call
  const still = fixture('copilot-status-cumulative-2.json');
  still.context_window.current_context_used_percentage = 12;
  render(still);                                         // no movement, a new context reading
  const aggregate = aggregateEvents(ledgerLines(config));
  assert.equal(aggregate.turns, 1, `one call, got ${aggregate.turns}`);
  assert.equal(aggregate.increment_turns, 1);
  assert.equal(aggregate.tokens.input_total, 118301);
  assert.equal(aggregate.render_only_readings, 2);
  assert.equal(aggregate.context_percent_samples.turns, 3, 'all three context readings are kept');
  assert.equal(aggregate.context_percent_samples.percent_last, 12);
  assert.ok(aggregate.turns_data[0].billing.aiu > 0, 'the units the call moved stay on the one turn');
});

test('a provider cumulative reset clears subagent cost accumulated on the old basis', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 's', model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  const lifecycle = (name) => normalizeClaude(name, { session_id: 's', agent_type: 'probe' }, config, 'hook')[0];

  storeEvent(render(10), config);
  storeEvent(lifecycle('SubagentStart'), config);
  storeEvent(render(14), config);
  storeEvent(lifecycle('SubagentStop'), config);
  assert.ok(Math.abs(rollingStatusFromState(statusState(config), config, 'claude').subagent_cost_usd - 4) < 1e-9);

  storeEvent(render(0.5), config); // counter restarts lower than before
  const after = rollingStatusFromState(statusState(config), config, 'claude');
  assert.equal(after.subagent_cost_usd, undefined, 'stale accumulation must not divide into the new total');
  assert.equal(after.subagent_cost_share, undefined);
});

test('interleaved prompt ids do not split either exchange into fragments', () => {
  const config = testConfig(tempDir());
  const render = (promptId, cost) => normalizeClaude('status', {
    session_id: 's', prompt_id: promptId, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];

  // Two exchanges reporting alternately, as concurrent prompt ids do in practice.
  storeEvent(render('A', 1), config);
  storeEvent(render('B', 2), config);
  storeEvent(render('A', 3), config);
  storeEvent(render('B', 4), config);
  storeEvent(render('A', 5), config);

  assert.equal(ledgerLines(config).length, 0, 'alternating turns must not flush each other');
  assert.equal(flushPendingTurns(config), 2, 'both open turns flush once');

  const lines = ledgerLines(config).filter((line) => line.source === 'statusline');
  assert.equal(lines.length, 2, `one record per exchange, got ${lines.length}`);
  const byTurn = Object.fromEntries(lines.map((line) => [line.turn_id, line.cost.delta_usd]));
  // Deltas are computed against whichever snapshot came before, so the two
  // exchanges together account for the full 1 -> 5 movement without overlap.
  const total = Object.values(byTurn).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 4) < 1e-9, `combined movement should be 4.00, got ${total}`);
});

test('a new prompt closes every exchange opened before it', () => {
  const config = testConfig(tempDir());
  const render = (promptId, cost) => normalizeClaude('status', {
    session_id: 's', prompt_id: promptId, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];

  storeEvent(render('A', 1), config);
  storeEvent(render('B', 2), config);
  storeEvent(normalizeClaude('UserPromptSubmit', { session_id: 's' }, config, 'hook')[0], config);
  assert.equal(ledgerLines(config).filter((line) => line.source === 'statusline').length, 2,
    'both prior exchanges are durable once a new prompt arrives');
});

test('concurrent sessions do not clobber each other in shared state', () => {
  const config = testConfig(tempDir());
  const render = (session, cost) => normalizeClaude('status', {
    session_id: session, prompt_id: `p-${session}`, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  const sub = (session, name) => normalizeClaude(name, { session_id: session, agent_type: 'probe' }, config, 'hook')[0];

  // Session A finishes two subagents, session B one, interleaved.
  storeEvent(render('A', 1), config);
  storeEvent(sub('A', 'SubagentStart'), config);
  storeEvent(sub('A', 'SubagentStop'), config);
  storeEvent(render('B', 2), config);
  storeEvent(sub('B', 'SubagentStart'), config);
  storeEvent(sub('B', 'SubagentStop'), config);
  storeEvent(sub('A', 'SubagentStart'), config);
  storeEvent(sub('A', 'SubagentStop'), config);
  storeEvent(render('A', 3), config);

  const snapshot = rollingStatusFromState(statusState(config, 'A'), config, 'claude');
  assert.equal(snapshot.latest.session_id, 'A');
  assert.equal(snapshot.subagent_count, 2, "session A's tally must not include session B's subagent");

  // Each session owns its own file, so neither can overwrite the other.
  assert.notEqual(sessionStateFile(config, 'A'), sessionStateFile(config, 'B'));
  assert.equal(loadState(config, 'A').subagentWindows['claude-code|A'].completed, 2);
  assert.equal(loadState(config, 'B').subagentWindows['claude-code|B'].completed, 1);
  assert.equal(loadState(config, 'A').subagentWindows['claude-code|B'], undefined,
    "session B's window must not appear in session A's state");
});

test('the live snapshot ignores turns belonging to another session', () => {
  const config = testConfig(tempDir());
  const render = (session, promptId, cost) => normalizeClaude('status', {
    session_id: session, prompt_id: promptId, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];

  storeEvent(render('A', 'a1', 1), config);
  storeEvent(render('A', 'a1', 2), config);   // A's first reply is worth 1.00
  storeEvent(render('B', 'b1', 50), config);  // another session, far more expensive
  // A's next prompt closes its first reply; B's turn must stay untouched.
  storeEvent(normalizeClaude('UserPromptSubmit', { session_id: 'A' }, config, 'hook')[0], config);
  storeEvent(render('A', 'a2', 3), config);   // A starts a second reply

  const snapshot = rollingStatusFromState(statusState(config, 'A'), config, 'claude');
  assert.equal(snapshot.latest.session_id, 'A');
  assert.ok(Math.abs(snapshot.last_prompt_cost_usd - 1) < 1e-9,
    `session A's previous reply is 1.00, got ${snapshot.last_prompt_cost_usd}`);
});

test('a stop with no subagent running is not counted as a completion', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 'S', prompt_id: 'p', model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  const sub = (name) => normalizeClaude(name, { session_id: 'S', agent_type: 'probe' }, config, 'hook')[0];

  // Measured behaviour: Claude Code emits SubagentStop far more often than it
  // spawns subagents. One start followed by many stops is one subagent, and
  // counting the stops is what reported 28 for a session that spawned three.
  storeEvent(render(1), config);
  storeEvent(sub('SubagentStart'), config);
  storeEvent(sub('SubagentStop'), config);
  for (let i = 0; i < 10; i += 1) storeEvent(sub('SubagentStop'), config);
  storeEvent(render(2), config);

  const snapshot = rollingStatusFromState(statusState(config, 'S'), config, 'claude');
  assert.equal(snapshot.subagent_count, 1);
  assert.equal(loadState(config, 'S').subagentWindows['claude-code|S'].active, 0);
});

test('a stray stop does not close the cost window of a subagent still running', () => {
  const config = testConfig(tempDir());
  const render = (cost) => normalizeClaude('status', {
    session_id: 'S', prompt_id: `p-${cost}`, model: { id: 'claude-test-model' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline')[0];
  const sub = (name) => normalizeClaude(name, { session_id: 'S', agent_type: 'probe' }, config, 'hook')[0];

  storeEvent(render(1), config);
  storeEvent(sub('SubagentStart'), config);
  storeEvent(sub('SubagentStart'), config);
  storeEvent(render(3), config);
  storeEvent(sub('SubagentStop'), config);
  storeEvent(sub('SubagentStop'), config);
  // Both are done; further stops must not reopen or re-close the window.
  storeEvent(sub('SubagentStop'), config);
  storeEvent(render(9), config);

  const window = loadState(config, 'S').subagentWindows['claude-code|S'];
  assert.equal(window.completed, 2);
  assert.equal(window.active, 0);
  // Cost accrued between the first start and the last real stop, and no more.
  assert.ok(window.accumulatedUsd > 0, 'the window must have accumulated the co-occurring cost');
  assert.ok(window.accumulatedUsd <= 3, `window must stop accruing after the last real stop, got ${window.accumulatedUsd}`);
});

function collectRecent(config) {
  return statusState(config).recent?.['github-copilot-cli'] ?? [];
}

// Copilot CLI sends no per-call gauge at all: `current_usage` is absent and the
// Claude-shaped fields are null. What it does send is session-cumulative
// counters, so one call's usage is the movement between two renders. Adding a
// running total to a period would count the whole session once per render.
test('cumulative Copilot counters become per-call increments', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const render = (name) => storeEvents(
    normalizeCopilot('status', fixture(name), config, 'statusline'), config
  );

  render('copilot-status-cumulative-1.json');
  const first = collectRecent(config);
  assert.equal(first.at(-1).usage, undefined, 'the first snapshot is a baseline, not a charge');

  render('copilot-status-cumulative-2.json');
  const usage = collectRecent(config).at(-1).usage;
  assert.equal(usage.basis, 'increment', 'a delta is additive, unlike the gauge it came from');
  // Cross-check: Copilot independently reports last_call_input_tokens 118301
  // and last_call_output_tokens 34 for this same call, which the adapter never
  // reads. The delta has to agree with them.
  assert.equal(usage.input_total, 118301);
  assert.equal(usage.output, 34);
  // ...and it recovers the cache split, which last_call_* does not carry.
  assert.equal(usage.cache_read, 118217);
  assert.equal(usage.cache_write, 81);
  assert.equal(usage.input_fresh, 3);
});

// A counter that goes backwards means the provider restarted it; the movement
// against the old basis is not a call that happened.
test('a restarted counter produces no phantom call', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  storeEvents(normalizeCopilot('status', fixture('copilot-status-cumulative-2.json'), config, 'statusline'), config);
  storeEvents(normalizeCopilot('status', fixture('copilot-status-cumulative-1.json'), config, 'statusline'), config);
  assert.equal(collectRecent(config).at(-1).usage, undefined);
});

test('the auto router records the model it chose, not the word "auto"', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const [event] = normalizeCopilot('status', fixture('copilot-status-cumulative-2.json'), config, 'statusline');
  assert.equal(event.model, 'gpt-5.6-luna');
  assert.equal(event.context.percent, 61);
  const serialized = JSON.stringify(event);
  for (const secret of ['SECRET SESSION TITLE', 'session-state', '/private/workspace']) {
    assert.ok(!serialized.includes(secret), `${secret} must not be persisted`);
  }
});

// Context is a gauge: true as of the newest render, not as of the last render
// that happened to move the token counters. With cumulative counters most
// renders move nothing, and a compaction or a clear shows up in exactly those.
test('context follows the newest render, not the last token movement', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const render = (payload) => storeEvents(normalizeCopilot('status', payload, config, 'statusline'), config);

  render(fixture('copilot-status-cumulative-1.json'));
  render(fixture('copilot-status-cumulative-2.json'));

  // A later render with no token movement, reporting a context that has been
  // compacted away.
  const compacted = fixture('copilot-status-cumulative-2.json');
  compacted.context_window.current_context_used_percentage = 12;
  compacted.context_window.current_context_tokens = 24000;
  render(compacted);

  const snapshot = rollingStatusFromState(statusState(config), config, 'copilot');
  assert.equal(snapshot.latest.context.percent, 12, 'the compaction must be visible immediately');
  // The token row still describes the call that produced it.
  assert.equal(snapshot.latest.usage.input_total, 118301);
  assert.equal(snapshot.latest.usage.output, 34);
});

// One installation serves every agent, so the newest session is frequently a
// different agent's. Asked for Copilot while a Claude session is the one
// writing, the fallback used to render "no local usage yet" over a session
// full of Copilot data.
// Intent 15: with two sessions open, a render that names no session gets the
// one that wrote last, and has to be told so; one that names a session gets it.
test('the fallback is marked and an explicit id is honoured when another session wrote last', () => {
  const config = testConfig(tempDir());
  const render = (session, cost, ts) => ({
    ...normalizeClaude('status', {
      session_id: session, prompt_id: `p-${session}-${cost}`, model: { id: 'claude-test-model' },
      cost: { total_cost_usd: cost },
      context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
    }, config, 'statusline')[0],
    ts
  });
  storeEvent(render('A', 1, '2026-09-24T10:00:00.000Z'), config);
  storeEvent(render('A', 2, '2026-09-24T10:00:01.000Z'), config);
  storeEvent(render('B', 5, '2026-09-24T10:00:02.000Z'), config);

  const fallback = resolveStatusSession(config, { agentName: 'claude-code' });
  assert.equal(fallback.resolution, 'most_recent_fallback');
  assert.equal(fallback.found, true);
  assert.equal(rollingStatusFromState(fallback.state, config, 'claude').latest.session_id, 'B');

  const asked = resolveStatusSession(config, { sessionId: 'A', agentName: 'claude-code' });
  assert.equal(asked.resolution, 'requested');
  assert.equal(asked.found, true);
  assert.equal(rollingStatusFromState(asked.state, config, 'claude').latest.session_id, 'A');

  // A session nobody stored is reported as absent, never replaced by another.
  const missing = resolveStatusSession(config, { sessionId: 'never-stored', agentName: 'claude-code' });
  assert.equal(missing.found, false);
  assert.equal(rollingStatusFromState(missing.state, config, 'claude').latest, undefined);

  // The unchanged entry point agrees with the resolver on both paths (D8).
  assert.deepEqual(statusState(config, 'A', 'claude-code'), asked.state);
  assert.deepEqual(statusState(config, undefined, 'claude-code'), fallback.state);
});

// Before per-session files, every session shared one state.json; loadState still
// slices a session's rows out of it. session_scope.state_found has to agree with
// that slice, or a skill reading it first says "nothing arrived" over real
// figures (intent 15 review, HIGH 1; D13).
test('a session kept only in the pre-migration combined state is found, and another session is not', () => {
  const config = testConfig(tempDir());
  const [event] = normalizeClaude('status', {
    session_id: 'X', prompt_id: 'p-X', model: { id: 'claude-test-model' }, cost: { total_cost_usd: 1 },
    context_window: { used_percentage: 5, current_usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, config, 'statusline');
  storeEvent(event, config);
  fs.renameSync(sessionStateFile(config, 'X'), config.stateFile);

  const kept = resolveStatusSession(config, { sessionId: 'X', agentName: 'claude-code' });
  assert.equal(kept.found, true);
  assert.equal(rollingStatusFromState(kept.state, config, 'claude').latest.session_id, 'X');

  // The combined file exists but holds nothing of Y: absent, and nothing renders.
  const other = resolveStatusSession(config, { sessionId: 'Y', agentName: 'claude-code' });
  assert.equal(other.found, false);
  assert.equal(rollingStatusFromState(other.state, config, 'claude').latest, undefined);
});

// found is a measurement of the read that produces the state, not a claim
// beside it: a ranked file that holds nothing is a fallback with nothing found.
// Tokenwatch never writes a bare `null`, but it stands in deterministically for
// a file emptied or removed between the ranking scan and the read (D21, D22).
test('a fallback whose file holds nothing reports it found nothing', () => {
  const config = testConfig(tempDir());
  fs.mkdirSync(path.dirname(sessionStateFile(config, 'X')), { recursive: true });
  fs.writeFileSync(sessionStateFile(config, 'X'), 'null');
  const resolved = resolveStatusSession(config, { agentName: 'claude-code' });
  assert.equal(resolved.resolution, 'most_recent_fallback');
  assert.equal(resolved.found, false);
  assert.equal(rollingStatusFromState(resolved.state, config, 'claude').latest, undefined);
});

test('with no session on disk the resolution is unknown, not a fallback', () => {
  const config = testConfig(tempDir());
  const resolved = resolveStatusSession(config, { agentName: 'claude-code' });
  assert.equal(resolved.resolution, 'unknown');
  assert.equal(resolved.found, false);
  assert.equal(rollingStatusFromState(resolved.state, config, 'claude').latest, undefined);
});

test('the on-demand view finds the asked-for agent, not just the newest session', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));

  const copilot = fixture('copilot-status-cumulative-1.json');
  storeEvents(normalizeCopilot('status', copilot, config, 'statusline'), config);
  storeEvents(normalizeCopilot('status', fixture('copilot-status-cumulative-2.json'), config, 'statusline'), config);

  // A Claude session writes afterwards, so it owns the most recent state file.
  storeEvents(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline'), config);

  const copilotView = rollingStatusFromState(statusState(config, undefined, 'github-copilot-cli'), config, 'copilot');
  assert.ok(copilotView.latest?.usage, 'Copilot data must be found behind a newer Claude session');
  assert.equal(copilotView.latest.usage.input_total, 118301);

  const claudeView = rollingStatusFromState(statusState(config, undefined, 'claude-code'), config, 'claude');
  assert.equal(claudeView.latest.agent, 'claude-code');
});

// Copilot bills in AI units and premium requests and reports no currency at all.
// Those are provider-reported counts, so they are recorded - but never as money.
test('billing units are diffed like cost and kept out of the USD fields', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const render = (name) => storeEvents(normalizeCopilot('status', fixture(name), config, 'statusline'), config);

  render('copilot-status-cumulative-1.json');
  const first = collectRecent(config).at(-1);
  assert.deepEqual(first.billing_cumulative, { aiu: 16.92, premium_requests: 8 });
  assert.equal(first.billing, undefined, 'the first snapshot is a baseline');
  assert.equal(first.cost, undefined, 'a unit that is not currency is never a cost');

  render('copilot-status-cumulative-2.json');
  const second = collectRecent(config).at(-1);
  assert.equal(second.billing.aiu, 0.26473);
  assert.equal(second.billing.premium_requests, 1);
  assert.equal(second.cost, undefined);

  const snapshot = rollingStatusFromState(statusState(config), config, 'copilot');
  assert.equal(snapshot.session_cost_usd, undefined, 'no dollars may be invented');
  // 17184730000 nano-units. Copilot's own footer displays this rounded to 17.18,
  // which is what the status line prints; the ledger keeps the exact figure.
  assert.deepEqual(snapshot.session_billing, { aiu: 17.18473, premium_requests: 9 });

  const line = formatStatus(snapshot, config, { NO_COLOR: '1', COLUMNS: '200' });
  assert.match(line, /17\.18 AIU/);
  assert.match(line, /9 premium reqs/);
  assert.doesNotMatch(line, /\$/, 'a non-currency unit must never render as money');
});

// The subagent window is "what accrued while at least one subagent ran". For a
// provider that reports no currency, that window has to be measured in whatever
// it does meter in, or the count shows and the share beside it stays blank.
test('the subagent window is measured in the provider\'s own billing unit', () => {
  const config = testConfig(path.join(tempDir(), 'state.json'));
  const render = (aiu, requests) => {
    const payload = fixture('copilot-status-cumulative-2.json');
    payload.session_id = 'sub-session';
    payload.ai_used = { total_nano_aiu: aiu * 1e9, formatted: String(aiu) };
    payload.cost.total_premium_requests = requests;
    storeEvents(normalizeCopilot('status', payload, config, 'statusline'), config);
  };
  const hook = (name) => storeEvents(
    normalizeCopilot(name, { session_id: 'sub-session', hookEventName: name }, config, 'hook'), config
  );

  render(10, 4);            // baseline
  render(12, 5);            // 12 AIU consumed so far
  hook('subagentStart');
  render(16, 7);            // 4 AIU accrued while the subagent ran
  hook('subagentStop');
  render(18, 8);            // 2 AIU after it finished

  const snapshot = rollingStatusFromState(statusState(config), config, 'copilot');
  assert.equal(snapshot.subagent_count, 1);
  assert.equal(snapshot.subagent_cost_usd, undefined, 'no dollars exist to report');
  // 4 of the session's 18 AIU accrued inside the window.
  assert.ok(Math.abs(snapshot.subagent_cost_share - 4 / 18) < 1e-6,
    `expected ~22%, got ${snapshot.subagent_cost_share}`);

  const line = formatStatus(snapshot, config, { NO_COLOR: '1', COLUMNS: '200' });
  assert.match(line, /1 completed/);
  assert.match(line, /22% of session cost/);
});

// The same check `test/cli-dispatch.test.mjs` makes: chmod only proves anything
// where this user is actually refused the write.
function readOnlyUnsupported(root) {
  if (process.platform === 'win32') return 'chmod cannot make a directory unwritable on Windows';
  if (process.getuid?.() === 0) return 'running as root, which writes through directory permissions';
  const probe = path.join(root, 'probe');
  fs.mkdirSync(probe);
  fs.chmodSync(probe, 0o500);
  try {
    fs.writeFileSync(path.join(probe, 'x'), '');
    return 'this filesystem does not enforce directory permissions';
  } catch {
    return undefined;
  } finally {
    fs.chmodSync(probe, 0o700);
  }
}

// A ledger that accepts the append beside a state directory that refuses the
// rewrite - `TOKENWATCH_DATA` pointed somewhere writable - would take the turn,
// then fail to record that it had, and take it again on every later report.
// The flush proves the state file can be replaced before appending anything.
test('a turn is never appended while its state file cannot record that it was', (t) => {
  const root = tempDir();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  const config = { ...testConfig(path.join(root, 'state')), dataFile: path.join(root, 'ledger', 'events.jsonl') };
  for (const name of ['claude-status-1.json', 'claude-status-2.json']) {
    storeEvents(normalizeClaude('status', fixture(name), config, 'statusline'), config);
  }
  const sessions = path.dirname(sessionStateFile(config, 'claude-session-1'));
  fs.chmodSync(sessions, 0o500);
  try {
    for (const attempt of [1, 2]) {
      const result = tryFlushPendingTurns(config);
      assert.ok(result.refused, `attempt ${attempt} is refused, got ${JSON.stringify(result)}`);
      assert.equal(result.flushed, 0);
      assert.equal(result.unflushed.length, 1, `the turn is handed back to show in memory, got ${result.unflushed.length}`);
      assert.equal(ledgerLines(config).length, 0, `attempt ${attempt} appended ${ledgerLines(config).length} rows`);
    }
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  assert.equal(flushPendingTurns(config), 1, 'once writable, the turn flushes exactly once');
  assert.equal(ledgerLines(config).length, 1);
});

// Only a refused write degrades. Anything else - here the ledger path is a
// directory - is still an error the user needs to see, not a quiet fallback.
test('a write that fails for any other reason than permission is never swallowed', () => {
  const root = tempDir();
  const config = testConfig(root);
  storeEvents(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline'), config);
  fs.mkdirSync(config.dataFile);
  assert.throws(() => tryFlushPendingTurns(config), (error) => {
    assert.equal(isWriteRefused(error), false, `a ${error.code} is not a refused write`);
    return true;
  });
});

// The strict form keeps its old contract for callers that need a complete
// ledger: a refused write is thrown, not reported.
test('the strict flush still throws when the data directory refuses the write', (t) => {
  const root = tempDir();
  const skip = readOnlyUnsupported(root);
  if (skip) { t.skip(skip); return; }
  const config = testConfig(path.join(root, 'state'));
  storeEvents(normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline'), config);
  const stateDir = path.join(root, 'state');
  const sessions = path.dirname(sessionStateFile(config, 'claude-session-1'));
  fs.chmodSync(sessions, 0o500);
  fs.chmodSync(stateDir, 0o500);
  try {
    assert.throws(() => flushPendingTurns(config), (error) => isWriteRefused(error));
  } finally {
    fs.chmodSync(stateDir, 0o700);
    fs.chmodSync(sessions, 0o700);
  }
});

// Intent 06, D2: the running-total rule, shared by the live store and the import.
test('diffCumulativeUsage yields nothing for a baseline or a restarted counter, and the delta otherwise', async () => {
  const { diffCumulativeUsage } = await import('../src/store.mjs');
  assert.equal(diffCumulativeUsage(undefined, { input_total: 10 }), undefined, 'the first snapshot is a baseline');
  assert.equal(diffCumulativeUsage({ input_total: 10, output: 5 }, { input_total: 4, output: 9 }), undefined, 'a counter went backwards');
  assert.equal(diffCumulativeUsage({ input_total: 10 }, { input_total: 10 }), undefined, 'nothing moved');
  assert.deepEqual(diffCumulativeUsage({ input_total: 100, cache_read: 40, output: 10 }, { input_total: 160, cache_read: 70, cache_write: 5, output: 25 }),
    { input_total: 60, cache_read: 30, cache_write: 5, output: 15, input_fresh: 25 });
});

// Intent 06, D2: imported history is appended beside live rows and touches no
// session state, and one bad row writes nothing at all.
test('appendImportedEvents appends imported rows only, writes no session state, and writes nothing when a row is unsafe', async () => {
  const { appendImportedEvents } = await import('../src/store.mjs');
  const root = tempDir();
  const config = testConfig(root);
  const row = (id) => makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 'hist-1', turn_id: id, ts: '2026-08-01T10:00:00.000Z',
    usage: { input_total: 10, output: 2, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'run-1', verification: 'unverified', reason: 'no_overlap' }
  });
  assert.deepEqual(appendImportedEvents([row('r1'), row('r2')], config), { written: 2 });
  assert.equal(fs.readFileSync(config.dataFile, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false, 'no session state file');
  assert.equal(fs.existsSync(config.stateFile), false);
  const before = fs.readFileSync(config.dataFile);
  const live = makeEvent({ agent: 'claude', kind: 'usage', source: 'statusline', session_id: 'x', usage: { input_total: 1 } });
  assert.throws(() => appendImportedEvents([row('r3'), live], config), /imported rows only/);
  const unsafe = row('r4');
  unsafe.metrics = { nested: { prompt: 'fix the login page' } };
  assert.throws(() => appendImportedEvents([row('r5'), unsafe], config), /Unsafe field/);
  assert.equal(Buffer.compare(fs.readFileSync(config.dataFile), before), 0, 'nothing was written by either refused batch');
});
