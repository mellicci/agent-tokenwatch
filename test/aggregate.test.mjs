import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEvents } from '../src/aggregate.mjs';
import { compactionSummary } from '../src/rank.mjs';
import { analyzeEvents, formatAuditMarkdown } from '../src/analyze.mjs';
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
  assert.match(observation.evidence, /3 readings/);
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

// F3: a status-line group is render-only - not a turn - only when nothing in it
// moved. These pin the edges of that rule.
function claudeRender({ turn, ts, usage, cost, session = 's' }) {
  return makeEvent({
    agent: 'claude', kind: 'usage', source: 'statusline', event_name: 'status', session_id: session, turn_id: turn, ts,
    usage: usage && { ...usage, semantics: 'components', basis: 'sample' },
    cost: cost === undefined ? { cumulative_usd: 1, basis: 'provider_reported', currency: 'USD' }
      : { cumulative_usd: 1, delta_usd: cost, basis: 'provider_reported', currency: 'USD' },
    context: { percent: 10 }
  });
}

test('a zero-cost render whose gauge moved is still counted as a turn', () => {
  const events = [
    claudeRender({ turn: 'p1', ts: '2026-09-28T10:00:00.000Z', usage: { input_total: 100, output: 5 }, cost: 0.02 }),
    // No cost moved, but the gauge describes a different call than the turn before.
    claudeRender({ turn: 'p2', ts: '2026-09-28T10:01:00.000Z', usage: { input_total: 140, output: 9 }, cost: 0 })
  ];
  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.turns, 2);
  assert.equal(aggregate.render_only_readings, 0);
});

test('the first render of a prompt is a turn even when its cost is only a baseline', () => {
  const prompt = makeEvent({ agent: 'claude', kind: 'lifecycle', source: 'hook', event_name: 'UserPromptSubmit', session_id: 's', turn_id: 'p1', ts: '2026-09-28T10:00:00.000Z' });
  // The first cumulative observation is a baseline and carries no delta.
  const render = claudeRender({ turn: 'p1', ts: '2026-09-28T10:00:05.000Z', usage: { input_total: 100, output: 5 } });
  assert.equal(aggregateEvents([prompt, render]).turns, 1, 'a prompt hook with the same turn id backs it');
  assert.equal(aggregateEvents([render]).turns, 0, 'alone, a first render with no cost is a baseline render');
  assert.equal(aggregateEvents([render]).context_percent_samples.turns, 1);
});

test('imported, Codex and hook-carried turns are never render-only, even at zero cost', () => {
  const imported = makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 'h', turn_id: 'r1', ts: '2026-09-01T10:00:00.000Z',
    usage: { input_total: 50, output: 5, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'run-1', verification: 'verified' }
  });
  const codex = makeEvent({
    agent: 'codex', kind: 'usage', source: 'otlp', event_name: 'codex.sse_event', session_id: 'c', turn_id: 't1', ts: '2026-09-01T11:00:00.000Z',
    usage: { input_total: 0, output: 0, semantics: 'cached_subset', basis: 'increment' }
  });
  const compact = makeEvent({
    agent: 'claude', kind: 'compact', source: 'hook', event_name: 'PreCompact', session_id: 's', turn_id: 'k', ts: '2026-09-01T12:00:00.000Z',
    context: { percent: 80 }
  });
  const aggregate = aggregateEvents([imported, codex, compact]);
  assert.equal(aggregate.turns, 3);
  assert.equal(aggregate.render_only_readings, 0);
});

test('the audit says how many renders were not counted as turns', () => {
  const events = [
    claudeRender({ turn: 'p1', ts: '2026-09-28T10:00:00.000Z', usage: { input_total: 100, output: 5 }, cost: 0.02 }),
    claudeRender({ turn: 'slash', ts: '2026-09-28T10:01:00.000Z', usage: { input_total: 100, output: 5 }, cost: 0 })
  ];
  const report = analyzeEvents(events, testConfig(tempDir()));
  assert.equal(report.aggregate.turns, 1);
  assert.match(report.observations.find((row) => row.id === 'coverage').evidence,
    /1 status-line renders with no model call behind them \(a slash command or a baseline render\) are not counted as turns; their context readings are kept\./);
  assert.match(formatAuditMarkdown(report), /1 status-line renders with no model call behind them are not counted/);
});

// L2 (review): since render-only readings stopped being turns, the gauge
// counts beside the turn count are counts of readings. "1 turns ... 2 carry
// latest-call gauge samples" read as two of one turn.
test('gauge counts that include render-only readings are called readings, not turns', () => {
  const events = [
    claudeRender({ turn: 'p1', ts: '2026-09-28T10:00:00.000Z', usage: { input_total: 100, output: 5 }, cost: 0.02 }),
    claudeRender({ turn: 'slash', ts: '2026-09-28T10:01:00.000Z', usage: { input_total: 100, output: 5 }, cost: 0 })
  ];
  const report = analyzeEvents(events, testConfig(tempDir()));
  assert.equal(report.aggregate.turns, 1);
  assert.equal(report.aggregate.context_samples.turns, 2, 'the field keeps its name; it counts readings');
  const coverage = report.observations.find((row) => row.id === 'coverage').evidence;
  assert.match(coverage, /^1 turns across 1 identified sessions; 0 carry additive token counts, 1 have provider-reported cost and 0 have configured estimates\. 2 latest-call gauge readings were recorded, including any that are not turns\./);
  assert.doesNotMatch(coverage, /carry latest-call gauge samples/);
  assert.match(report.observations.find((row) => row.id === 'context-percent').evidence, /^Context-window percent: 2 readings;/);
  const markdown = formatAuditMarkdown(report);
  assert.match(markdown, /- Latest-call gauge samples \(2 readings\):/);
  assert.match(markdown, /- Context-window percent \(2 readings\):/);
  assert.doesNotMatch(markdown, /\(2 turns\)/);
});

// L7 (review): a status-line reading that moved billing units is a turn even
// when it moved no dollars, repeats the previous gauge and no prompt hook backs
// it: Copilot bills in AI units. Nothing held the billing half of the rule.
test('a reading that moved billing units is a turn even with no dollars and an unchanged gauge', () => {
  const reading = (turn, ts, billing) => makeEvent({
    agent: 'copilot', kind: 'usage', source: 'statusline', event_name: 'status', session_id: 'u', turn_id: turn, ts,
    usage: { input_total: 100, output: 5, semantics: 'cached_subset', basis: 'sample' },
    billing, context: { percent: 10 }
  });
  const events = [
    reading('r1', '2026-09-28T10:00:00.000Z', { aiu: 0.2 }),
    reading('r2', '2026-09-28T10:01:00.000Z', { aiu: 0.3, premium_requests: 1 }),
    reading('r3', '2026-09-28T10:02:00.000Z', undefined)
  ];
  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.turns, 2, 'the two readings that moved units');
  assert.equal(aggregate.render_only_readings, 1, 'the one that moved nothing');
  assert.deepEqual(aggregate.turns_data.map((turn) => turn.turn_id), ['r1', 'r2']);
});

// M2, Windows live test: Claude Code reported a one-hour TTL, but the audit
// judged idle gaps against the configured 300 s and flagged six as cold.
function ttlTurn({ session, turn, ts, ttl }) {
  return makeEvent({
    agent: 'claude', kind: 'usage', source: 'statusline', session_id: session, turn_id: turn, ts,
    usage: { input_total: 10000 + Number(turn.slice(1)) * 10, input_fresh: 10, cache_read: 9990, output: 50, semantics: 'components', basis: 'sample' },
    cost: { delta_usd: 0.01, basis: 'provider_reported', currency: 'USD' },
    cache: ttl ? { ttl_seconds: ttl, ttl_source: 'provider_reported' } : undefined
  });
}

test('a gap inside the provider-reported cache TTL is not flagged as cold', () => {
  const events = [
    ttlTurn({ session: 'a', turn: 't1', ts: '2026-09-28T10:00:00.000Z', ttl: 3600 }),
    ttlTurn({ session: 'a', turn: 't2', ts: '2026-09-28T10:10:00.000Z', ttl: 3600 })
  ];
  const report = analyzeEvents(events, { ...testConfig(tempDir()), cacheTtlSeconds: 300 });
  assert.equal(report.observations.find((row) => row.id === 'ttl-gaps'), undefined,
    'a 10-minute gap under a reported 1-hour TTL is warm');
});

test('a session with no reported TTL is judged against the configured TTL, and the finding says so', () => {
  const events = [
    ttlTurn({ session: 'a', turn: 't1', ts: '2026-09-28T10:00:00.000Z', ttl: 3600 }),
    ttlTurn({ session: 'a', turn: 't2', ts: '2026-09-28T11:10:00.000Z', ttl: 3600 }), // 70 min: past 1 h
    ttlTurn({ session: 'b', turn: 't1', ts: '2026-09-28T10:00:00.000Z' }),
    ttlTurn({ session: 'b', turn: 't2', ts: '2026-09-28T10:10:00.000Z' }) // 10 min: past 300 s
  ];
  const config = { ...testConfig(tempDir()), cacheTtlSeconds: 300 };
  const report = analyzeEvents(events, config);
  const finding = report.observations.find((row) => row.id === 'ttl-gaps');
  assert.ok(finding, 'both gaps are flagged');
  assert.deepEqual(finding.ttl_sources, {
    provider_reported_gaps: 1, provider_ttl_seconds: [3600],
    configured_gaps: 1, configured_ttl_seconds: 300
  });
  assert.match(finding.evidence,
    /^2 within-session gaps exceeded the cache TTL: 1 the provider-reported TTL \(3600s\), 1 the configured 300s TTL, an assumption used where no TTL was reported;/);
  assert.equal(report.methodology.cache_ttl_basis, 'provider_reported_per_session_else_configured');

  const configuredOnly = analyzeEvents(events.filter((event) => event.session_id === 'b'), config);
  assert.match(configuredOnly.observations.find((row) => row.id === 'ttl-gaps').evidence,
    /^1 within-session gaps exceeded the configured 300s cache TTL, an assumption: no TTL was reported for these sessions;/);
});

// L7 (review): a gap after a turn that ended before the session's first TTL
// report is judged against that first report - still the provider's own value
// for the session - not against the configured assumption.
test('a gap before the session\'s first TTL report is judged against that report, not the configured TTL', () => {
  const events = [
    ttlTurn({ session: 'a', turn: 't1', ts: '2026-09-28T10:00:00.000Z' }),               // no cache block yet
    ttlTurn({ session: 'a', turn: 't2', ts: '2026-09-28T10:10:00.000Z', ttl: 3600 })   // 10 min later, 1 h TTL
  ];
  const report = analyzeEvents(events, { ...testConfig(tempDir()), cacheTtlSeconds: 300 });
  assert.equal(report.observations.find((row) => row.id === 'ttl-gaps'), undefined,
    'a 10-minute gap in a session that reports a 1-hour TTL is warm');
});

// L11 (review): the maxima were taken by spreading every reading into one
// Math.max call, which throws a RangeError past roughly 125,000 arguments. Every
// render-only reading is kept since F3, so a long period reaches that.
test('a period with more readings than one function call can take still reports its maxima', () => {
  const count = 200_000;
  const start = Date.parse('2026-09-01T00:00:00.000Z');
  const events = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      schema: 'tokenwatch.event/v1', agent: 'claude-code', kind: 'usage', source: 'statusline', event_name: 'status',
      session_id: 'long', turn_id: `p${index}`, ts: new Date(start + index * 1000).toISOString(),
      usage: { input_total: 1000 + (index % 5000), output: 5, semantics: 'components', basis: 'sample' },
      cost: { delta_usd: 0.001, basis: 'provider_reported', currency: 'USD' },
      context: { percent: index % 97 }
    });
  }
  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.turns, count);
  assert.equal(aggregate.context_samples.input_max, 5999);
  assert.equal(aggregate.context_percent_samples.percent_max, 96);

  const compactions = events.map((event) => ({ ...event, kind: 'compact', event_name: 'PreCompact' }));
  assert.equal(compactionSummary(compactions).context_percent_max, 96);
});
