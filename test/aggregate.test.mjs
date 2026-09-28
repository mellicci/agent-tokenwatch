import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEvents } from '../src/aggregate.mjs';
import { analyzeEvents } from '../src/analyze.mjs';
import { makeEvent } from '../src/schema.mjs';
import { tempDir, testConfig } from './helpers.mjs';

function usageEvent(turn, input, fresh, read, output, ts, model = 'model-a') {
  return makeEvent({
    agent: 'claude', kind: 'usage', source: 'statusline', session_id: 's', turn_id: String(turn), model, ts,
    usage: { input_total: input, input_fresh: fresh, cache_read: read, output, semantics: 'components' },
    cost: { amount_usd: 0.01, basis: 'provider_reported', currency: 'USD' }
  });
}

test('aggregate sums cached components once', () => {
  const events = [
    usageEvent(1, 10000, 2000, 8000, 500, '2026-08-22T00:00:00Z'),
    usageEvent(2, 12000, 3000, 9000, 700, '2026-08-22T00:01:00Z')
  ];
  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.tokens.input_total, 22000);
  assert.equal(aggregate.tokens.input_fresh, 5000);
  assert.equal(aggregate.tokens.cache_read, 17000);
  assert.equal(aggregate.turns, 2);
  assert.equal(aggregate.cost.provider_reported_usd, 0.02);
});

test('audit produces evidence-only recommendations and separates costs', () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    events.push(usageEvent(i, 10000 + i * 2000, 9000 + i * 1900, 1000 + i * 100, 500,
      new Date(Date.UTC(2026, 7, 22, 0, i)).toISOString(), i > 8 ? 'model-b' : 'model-a'));
  }
  events.push(makeEvent({ agent: 'claude', kind: 'lifecycle', event_name: 'PostToolUse', metrics: { tool_output_bytes: 100000 }, ts: '2026-08-22T00:20:00Z' }));
  const report = analyzeEvents(events, testConfig(tempDir()));
  assert.equal(report.methodology.content_inspected, false);
  assert.equal(report.aggregate.cost.configured_estimate_usd, 0);
  assert.ok(report.recommendations.some((row) => row.id === 'stabilize-prefix'));
  assert.ok(report.recommendations.some((row) => row.id === 'filter-or-delegate-output'));
  assert.ok(report.recommendations.every((row) => row.evidence && row.inference && row.action));
});

// A provider whose token deltas are correctly additive (basis: 'increment', via
// cumulative-counter diffing) used to lose its context-window reading twice
// over: an event with no usage was dropped by groupTurns entirely before it
// could become a turn, and even a turn that did form was excluded from
// context_samples because that field is deliberately gated on
// basis === 'sample'. Real ledger check: 1 of 66 genuine Copilot context
// readings survived into a report before this fix.
test('context percent is captured for increment-basis and usage-less turns alike', () => {
  const events = [
    // A baseline render: no usage at all (first observation, nothing to diff
    // yet), but a perfectly valid context reading.
    makeEvent({
      agent: 'copilot', kind: 'usage', source: 'statusline', session_id: 's', turn_id: '1',
      model: 'gpt-5.6-luna', ts: '2026-01-01T00:00:00.000Z',
      context: { percent: 10, limit: 200000 }
    }),
    // A real per-call delta, correctly tagged 'increment' - not a sample - with
    // its own context reading.
    makeEvent({
      agent: 'copilot', kind: 'usage', source: 'statusline', session_id: 's', turn_id: '2',
      model: 'gpt-5.6-luna', ts: '2026-01-01T00:05:00.000Z',
      usage: { input_total: 1000, cache_read: 900, output: 20, semantics: 'cached_subset', basis: 'increment' },
      context: { percent: 40, limit: 200000 }
    }),
    makeEvent({
      agent: 'copilot', kind: 'usage', source: 'statusline', session_id: 's', turn_id: '3',
      model: 'gpt-5.6-luna', ts: '2026-01-01T00:10:00.000Z',
      usage: { input_total: 1200, cache_read: 1100, output: 15, semantics: 'cached_subset', basis: 'increment' },
      context: { percent: 60, limit: 200000 }
    })
  ];
  const aggregate = aggregateEvents(events);

  // The old field stays exactly as gated - none of these are basis: 'sample',
  // so it correctly reports nothing, and must keep reporting nothing: mixing an
  // increment turn's input_total into a gauge distribution would double it
  // against aggregate.tokens, which already sums increments separately.
  assert.equal(aggregate.context_samples.turns, 0);

  // The new field recovers all three - context is a point-in-time gauge
  // regardless of what kind of token data, if any, rides with it.
  assert.equal(aggregate.context_percent_samples.turns, 3);
  assert.equal(aggregate.context_percent_samples.percent_last, 60);
  assert.equal(aggregate.context_percent_samples.percent_median, 40);
  assert.equal(aggregate.context_percent_samples.percent_max, 60);

  const report = analyzeEvents(events, testConfig(tempDir()), {});
  const observation = report.observations.find((o) => o.id === 'context-percent');
  assert.ok(observation, 'a context-percent observation must be produced');
  assert.match(observation.evidence, /3 turns/);
});

// Claude's status line is basis: 'sample' throughout, so context and the token
// gauge already travelled together before this fix. Confirms the two fields
// agree in turn count for that shape, rather than the new field silently
// double-counting what the old one already reported correctly.
test('context percent agrees with the existing gauge count for sample-basis turns', () => {
  const events = [
    usageEvent(1, 1000, 800, 200, 50, '2026-01-01T00:00:00.000Z'),
    usageEvent(2, 1500, 1200, 300, 60, '2026-01-01T00:05:00.000Z')
  ].map((event, index) => ({ ...event, usage: { ...event.usage, basis: 'sample' }, context: { percent: 20 + index * 10, limit: 200000 } }));
  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.context_samples.turns, 2);
  assert.equal(aggregate.context_percent_samples.turns, 2);
});

// Intent 06, D1: imported responses are additive. They are summed once, never
// treated as gauge samples, whatever their source.
test('transcript-basis turns are summed like increments and never counted as samples', () => {
  const row = (turn, input, output) => makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 's', turn_id: `r${turn}`, ts: `2026-09-01T10:0${turn}:00.000Z`,
    usage: { input_total: input, cache_read: 0, output, semantics: 'components', basis: 'transcript' }
  });
  const aggregate = aggregateEvents([row(1, 100, 10), row(2, 200, 20), row(3, 300, 30)]);
  assert.equal(aggregate.tokens.input_total, 600);
  assert.equal(aggregate.tokens.output, 60);
  assert.equal(aggregate.context_samples.turns, 0);
});

// Intent 06, D4: reports say which turns were imported, and read time from the
// rows, not from where an import appended them.
test('imported turns are counted apart, and first/last are the earliest and latest rows wherever they sit in the file', () => {
  const live = usageEvent(1, 100, 100, 0, 10, '2026-09-23T10:00:00.000Z');
  const imported = (n, ts, verification) => makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 'hist', turn_id: `r${n}`, ts,
    usage: { input_total: 50, output: 5, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'run-1', verification }
  });
  const aggregate = aggregateEvents([live, imported(1, '2026-06-01T10:00:00.000Z', 'verified'), imported(2, '2026-06-02T10:00:00.000Z', 'unverified')]);
  assert.equal(aggregate.imported_turns, 2);
  assert.equal(aggregate.imported_sessions, 1);
  assert.equal(aggregate.imported_unverified_turns, 1);
  assert.equal(aggregate.first_ts, '2026-06-01T10:00:00.000Z', 'the imported row appended last is still the earliest');
  assert.equal(aggregate.last_ts, '2026-09-23T10:00:00.000Z');
  const audit = analyzeEvents([live, imported(1, '2026-06-01T10:00:00.000Z', 'verified')], testConfig(tempDir()));
  assert.match(audit.observations.find((row) => row.id === 'coverage').evidence,
    /1 turns were imported from session files \(tokens only, no provider cost; 1 verified, 0 unverified\)/);
});
