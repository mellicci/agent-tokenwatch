import test from 'node:test';
import assert from 'node:assert/strict';
import { rankGroups, turnConcentration, compactionSummary, comparePeriods } from '../src/rank.mjs';
import { makeEvent } from '../src/schema.mjs';
import { eventsToCsv } from '../src/export.mjs';

function turn({ ts, session, model, cost, basis = 'provider_reported' }) {
  return {
    agent: 'claude-code', session_id: session, turn_id: `${session}-${ts}`, model, ts,
    kind: 'usage', usage: { basis: 'increment', input_total: 100, output: 10 },
    cost: { amount_usd: cost, basis }
  };
}

const events = [
  turn({ ts: '2026-09-01T10:00:00.000Z', session: 'a', model: 'opus', cost: 8 }),
  turn({ ts: '2026-09-01T11:00:00.000Z', session: 'a', model: 'opus', cost: 2 }),
  turn({ ts: '2026-09-02T10:00:00.000Z', session: 'b', model: 'sonnet', cost: 1 }),
  turn({ ts: '2026-09-02T11:00:00.000Z', session: 'b', model: 'sonnet', cost: 1 })
];

test('groups rank by measured share of provider spend', () => {
  const ranked = rankGroups(events, { by: 'model' });
  assert.equal(ranked.total_provider_usd, 12);
  assert.equal(ranked.groups[0].key, 'opus');
  assert.equal(ranked.groups[0].provider_share, 10 / 12);
  // The point of ranking by model: half the turns, most of the money.
  assert.equal(ranked.groups[0].turn_share, 0.5);
  assert.equal(ranked.shown_provider_share, 1);
});

test('day grouping buckets on the UTC date and session grouping counts turns', () => {
  const byDay = rankGroups(events, { by: 'day' });
  assert.deepEqual(byDay.groups.map((row) => row.key), ['2026-09-01', '2026-09-02']);
  const bySession = rankGroups(events, { by: 'session' });
  assert.equal(bySession.groups[0].key, 'a');
  assert.equal(bySession.groups[0].turns, 2);
});

test('a truncated ranking reports how much of the period it covers', () => {
  const ranked = rankGroups(events, { by: 'session', limit: 1 });
  assert.equal(ranked.groups.length, 1);
  assert.equal(ranked.groups_total, 2);
  assert.equal(ranked.shown_provider_share, 10 / 12);
});

test('locally estimated cost is ranked separately and never folded into provider spend', () => {
  const mixed = [...events, turn({ ts: '2026-09-03T10:00:00.000Z', session: 'c', model: 'local', cost: 50, basis: 'configured_estimate' })];
  const ranked = rankGroups(mixed, { by: 'model' });
  assert.equal(ranked.total_provider_usd, 12);
  assert.equal(ranked.total_estimate_usd, 50);
});

test('an unknown grouping is refused rather than silently falling back', () => {
  assert.throws(() => rankGroups(events, { by: 'colour' }), /Unknown grouping/);
});

test('concentration measures how much of spend sits in the top decile', () => {
  const spread = Array.from({ length: 10 }, (_, i) => turn({
    ts: `2026-09-0${(i % 9) + 1}T1${i}:00:00.000Z`, session: `s${i}`, model: 'opus', cost: i === 0 ? 91 : 1
  }));
  const result = turnConcentration(spread);
  assert.equal(result.turns, 10);
  assert.equal(result.total_provider_usd, 100);
  assert.equal(result.top_decile_turns, 1);
  assert.equal(result.max_usd, 91);
  assert.equal(result.top_decile_share, 0.91);
});

test('compactions are summarised with their measured context percentage', () => {
  const summary = compactionSummary([
    { agent: 'claude-code', kind: 'compact', session_id: 'a', ts: '2026-09-01T12:00:00.000Z', context: { percent: 82 } },
    { agent: 'claude-code', kind: 'compact', session_id: 'a', ts: '2026-09-01T15:00:00.000Z', context: { percent: 90 } },
    { agent: 'claude-code', kind: 'usage', session_id: 'a', ts: '2026-09-01T16:00:00.000Z' }
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.context_percent_max, 90);
  assert.equal(summary.measured, 2);
});

test('period comparison reports absolute and relative movement per model', () => {
  const prior = [turn({ ts: '2026-08-25T10:00:00.000Z', session: 'p', model: 'opus', cost: 5 })];
  const comparison = comparePeriods(events, prior);
  assert.equal(comparison.provider_cost_usd.current, 12);
  assert.equal(comparison.provider_cost_usd.prior, 5);
  assert.equal(comparison.provider_cost_usd.absolute, 7);
  assert.equal(comparison.provider_cost_usd.relative, 1.4);
  const opus = comparison.models.find((row) => row.model === 'opus');
  assert.equal(opus.absolute, 5);
  // A model absent from the prior window is movement, not a missing row.
  const sonnet = comparison.models.find((row) => row.model === 'sonnet');
  assert.equal(sonnet.prior, 0);
  assert.equal(sonnet.relative, undefined);
});

// A provider that bills in units rather than currency - Copilot's AI units and
// premium requests. Before this, rankGroups never looked at billing at all, so
// a Copilot-only period fell back to turn-count ordering with no measured share
// of anything - "spend shares cannot be ranked" for the one thing that behaves
// like spend in that data.
function copilotTurn({ ts, session, model, aiu, premiumRequests }) {
  return {
    agent: 'github-copilot-cli', session_id: session, turn_id: `${session}-${ts}`, model, ts,
    kind: 'usage', usage: { basis: 'increment', input_total: 100, output: 10 },
    billing: { aiu, premium_requests: premiumRequests }
  };
}

test('with no USD at all, groups rank by AIU instead of falling back to turn count', () => {
  const events = [
    copilotTurn({ ts: '2026-09-01T10:00:00.000Z', session: 'a', model: 'gpt-5.6-luna', aiu: 0.5, premiumRequests: 1 }),
    copilotTurn({ ts: '2026-09-01T11:00:00.000Z', session: 'a', model: 'gpt-5.6-luna', aiu: 0.5, premiumRequests: 1 }),
    copilotTurn({ ts: '2026-09-01T12:00:00.000Z', session: 'a', model: 'gpt-5.6-luna', aiu: 0.5, premiumRequests: 1 }),
    // Fewer turns, but far more AIU - the point of the test: turn count alone
    // would have ranked this second, AIU correctly puts it first.
    copilotTurn({ ts: '2026-09-02T10:00:00.000Z', session: 'b', model: 'claude-sonnet-4.5', aiu: 10, premiumRequests: 1 })
  ];
  const ranked = rankGroups(events, { by: 'model' });

  assert.equal(ranked.total_provider_usd, 0);
  assert.equal(ranked.ranked_by, 'billing:aiu');
  assert.deepEqual(ranked.total_billing, { aiu: 11.5, premium_requests: 4 });

  assert.equal(ranked.groups[0].key, 'claude-sonnet-4.5', 'one expensive turn must outrank three cheap ones');
  assert.equal(ranked.groups[0].billing.aiu, 10);
  assert.ok(Math.abs(ranked.groups[0].billing_share.aiu - 10 / 11.5) < 1e-9);
  assert.equal(ranked.groups[0].turn_share, 0.25);

  assert.equal(ranked.groups[1].key, 'gpt-5.6-luna');
  assert.equal(ranked.groups[1].billing.aiu, 1.5);
  assert.ok(Math.abs(ranked.groups[1].billing_share.aiu - 1.5 / 11.5) < 1e-9);

  assert.ok(Math.abs(ranked.shown_billing_share - 1) < 1e-9, 'both groups are shown, so the full period is covered');
});

test('any USD in the period keeps cost as the sort key, never mixed with billing', () => {
  const events = [
    turn({ ts: '2026-09-01T10:00:00.000Z', session: 'a', model: 'opus', cost: 1 }),
    copilotTurn({ ts: '2026-09-02T10:00:00.000Z', session: 'b', model: 'gpt-5.6-luna', aiu: 50, premiumRequests: 9 })
  ];
  const ranked = rankGroups(events, { by: 'model' });
  assert.equal(ranked.ranked_by, 'provider_cost_usd');
  assert.equal(ranked.groups[0].key, 'opus', 'the only turn with a real cost still ranks first');
  // Billing is still recorded and shareable per unit - just not used to sort -
  // and never added into provider_cost_usd.
  assert.equal(ranked.groups[1].billing.aiu, 50);
  assert.equal(ranked.groups[0].provider_cost_usd, 1);
});

test('a period with neither cost nor billing data ranks by turn count, as before', () => {
  const events = [
    { agent: 'codex-cli', session_id: 'a', turn_id: 'a-1', model: 'gpt-5.6-sol', ts: '2026-09-01T10:00:00.000Z', kind: 'usage', usage: { basis: 'increment', input_total: 100, output: 10 } }
  ];
  const ranked = rankGroups(events, { by: 'model' });
  assert.equal(ranked.ranked_by, 'provider_cost_usd');
  assert.equal(ranked.total_billing, undefined);
  assert.equal(ranked.groups[0].key, 'gpt-5.6-sol');
});

// Intent 06, D4: an imported day has tokens but no provider cost; the ranking,
// the period comparison and the CSV all say which turns are imported.
test('rankings, period comparisons and the CSV mark imported turns', () => {
  const imported = (n, ts) => makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 'hist', turn_id: `r${n}`, ts, model: 'model-a',
    usage: { input_total: 50, output: 5, semantics: 'components', basis: 'transcript' },
    import: { mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: 'run-1', verification: 'verified' }
  });
  const rows = [imported(1, '2026-06-01T10:00:00.000Z'), imported(2, '2026-06-01T11:00:00.000Z')];
  const ranked = rankGroups(rows, { by: 'session' });
  assert.equal(ranked.groups[0].imported_turns, 2);
  assert.equal(ranked.groups[0].provider_cost_usd, 0);
  const compared = comparePeriods(rows, []);
  assert.deepEqual([compared.imported_turns.current, compared.imported_turns.prior], [2, 0]);
  const [header, first] = eventsToCsv(rows).trim().split('\n');
  const columns = header.split(',');
  const cells = first.split(',');
  assert.equal(cells[columns.indexOf('usage_basis')], 'transcript');
  assert.equal(cells[columns.indexOf('import_mapping')], 'claude-jsonl-1');
  assert.equal(cells[columns.indexOf('import_verification')], 'verified');
});
