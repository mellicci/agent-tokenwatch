import { groupTurns } from './aggregate.mjs';

// Ranked cost drivers, computed here rather than left to a reader to total up by
// eye. Every share in a retrospective should come from this module: a model
// asked to add a thousand CSV rows in its head will produce a plausible number,
// and a plausible number is worse than no number.

const GROUPINGS = new Set(['session', 'model', 'day', 'agent', 'project']);

function groupKey(turn, by) {
  if (by === 'session') return turn.session_id ?? 'unknown';
  if (by === 'model') return turn.model ?? 'unknown';
  if (by === 'agent') return turn.agent ?? 'unknown';
  if (by === 'project') return turn.project_id ?? 'unknown';
  return String(turn.last_ts ?? turn.first_ts ?? '').slice(0, 10) || 'unknown';
}

function share(part, whole) {
  return whole > 0 ? part / whole : undefined;
}

function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

// Provider-reported charges and locally configured estimates are ranked in
// separate columns and never summed, so a period mixing both cannot silently
// present an estimate as a bill.
export function rankGroups(events, { by = 'session', limit = 10 } = {}) {
  if (!GROUPINGS.has(by)) throw new Error(`Unknown grouping: ${by}. Use one of ${[...GROUPINGS].join(', ')}.`);
  const turns = groupTurns(events);
  const totalProvider = turns.reduce((sum, turn) => sum + turn.provider_cost_usd, 0);
  const totalEstimate = turns.reduce((sum, turn) => sum + turn.estimated_cost_usd, 0);
  // A provider that bills in units rather than currency - Copilot's AI units and
  // premium requests. Summed the same way cost is, per unit, so a period with no
  // USD at all is not left with nothing rankable.
  const totalBilling = {};
  for (const turn of turns) {
    for (const [unitName, value] of Object.entries(turn.billing ?? {})) {
      totalBilling[unitName] = (totalBilling[unitName] ?? 0) + value;
    }
  }
  const map = new Map();
  for (const turn of turns) {
    const key = groupKey(turn, by);
    const row = map.get(key) ?? {
      key, turns: 0, imported_turns: 0, provider_cost_usd: 0, estimated_cost_usd: 0, billing: {},
      first_ts: turn.first_ts, last_ts: turn.last_ts, models: new Set(), sessions: new Set()
    };
    row.turns += 1;
    // Imported turns carry no provider cost, so a group made of them would
    // otherwise rank as free (intent 06, D4).
    if (turn.imported) row.imported_turns += 1;
    row.provider_cost_usd += turn.provider_cost_usd;
    row.estimated_cost_usd += turn.estimated_cost_usd;
    for (const [unitName, value] of Object.entries(turn.billing ?? {})) {
      row.billing[unitName] = (row.billing[unitName] ?? 0) + value;
    }
    if (new Date(turn.first_ts) < new Date(row.first_ts)) row.first_ts = turn.first_ts;
    if (new Date(turn.last_ts) > new Date(row.last_ts)) row.last_ts = turn.last_ts;
    if (turn.model) row.models.add(turn.model);
    if (turn.session_id) row.sessions.add(turn.session_id);
    map.set(key, row);
  }
  // AIU is the closest billing-unit analog to spend: a continuous quantity that
  // scales with usage, unlike premium_requests, which is a coarser quota
  // counter. Used only as a sort key when there is no USD at all to rank by -
  // never mixed into provider_cost_usd, and never invented when absent.
  const rankByAiu = totalProvider === 0 && totalBilling.aiu > 0;
  const groups = [...map.values()]
    .map((row) => ({
      ...row,
      models: [...row.models].sort(),
      sessions: undefined,
      session_count: row.sessions.size,
      provider_share: share(row.provider_cost_usd, totalProvider),
      estimated_share: share(row.estimated_cost_usd, totalEstimate),
      billing_share: Object.fromEntries(
        Object.entries(row.billing).map(([unitName, value]) => [unitName, share(value, totalBilling[unitName])])
      ),
      turn_share: share(row.turns, turns.length),
      cost_per_turn_usd: row.turns ? row.provider_cost_usd / row.turns : 0
    }))
    .sort((a, b) => (rankByAiu
      ? (b.billing.aiu ?? 0) - (a.billing.aiu ?? 0)
      : b.provider_cost_usd - a.provider_cost_usd) || b.turns - a.turns);
  const shown = groups.slice(0, Math.max(1, limit));
  return {
    by,
    turns: turns.length,
    groups_total: groups.length,
    total_provider_usd: totalProvider,
    total_estimate_usd: totalEstimate,
    total_billing: Object.keys(totalBilling).length ? totalBilling : undefined,
    ranked_by: rankByAiu ? 'billing:aiu' : 'provider_cost_usd',
    // A ranking that hides the tail invites treating the visible rows as the
    // whole period, so what was cut off is reported alongside it.
    shown_provider_share: share(shown.reduce((sum, row) => sum + row.provider_cost_usd, 0), totalProvider),
    shown_billing_share: rankByAiu
      ? share(shown.reduce((sum, row) => sum + (row.billing.aiu ?? 0), 0), totalBilling.aiu)
      : undefined,
    groups: shown
  };
}

// How concentrated spend is. A period where the top tenth of turns carries most
// of the cost is a different problem from one where every turn is expensive.
export function turnConcentration(events) {
  const turns = groupTurns(events).filter((turn) => turn.provider_cost_usd > 0);
  const costs = turns.map((turn) => turn.provider_cost_usd);
  const total = costs.reduce((sum, value) => sum + value, 0);
  const sorted = [...costs].sort((a, b) => b - a);
  const decile = Math.max(1, Math.round(sorted.length / 10));
  return {
    turns: turns.length,
    total_provider_usd: total,
    median_usd: percentile(costs, 0.5),
    p95_usd: percentile(costs, 0.95),
    max_usd: sorted[0],
    top_decile_turns: sorted.length ? decile : 0,
    top_decile_share: share(sorted.slice(0, decile).reduce((sum, value) => sum + value, 0), total)
  };
}

// Compactions are the visible cold starts of a period: the prefix is replaced,
// so the turn after one repays the cache. They are recorded but were previously
// only reachable through the audit's own narrative.
export function compactionSummary(events) {
  const compactions = events.filter((event) => event.kind === 'compact' || /compact/i.test(event.event_name ?? ''));
  const percents = compactions.map((event) => event.context?.percent).filter(Number.isFinite);
  const sessions = new Set(compactions.map((event) => event.session_id).filter(Boolean));
  return {
    count: compactions.length,
    sessions: sessions.size,
    context_percent_median: percentile(percents, 0.5),
    context_percent_max: percents.length ? Math.max(...percents) : undefined,
    measured: percents.length
  };
}

function periodTotals(events) {
  const turns = groupTurns(events);
  const provider = turns.reduce((sum, turn) => sum + turn.provider_cost_usd, 0);
  const costed = turns.filter((turn) => turn.provider_cost_usd > 0);
  const sessions = new Set(turns.map((turn) => turn.session_id).filter(Boolean));
  return {
    turns: turns.length,
    imported_turns: turns.filter((turn) => turn.imported).length,
    sessions: sessions.size,
    provider_cost_usd: provider,
    cost_per_turn_usd: costed.length ? provider / costed.length : 0,
    compactions: compactionSummary(events).count
  };
}

function delta(current, prior) {
  const absolute = current - prior;
  return { current, prior, absolute, relative: prior > 0 ? absolute / prior : undefined };
}

// Period-over-period movement. A retrospective's actual question is "versus
// what", and an equal-length window immediately before the current one is the
// only comparison the ledger can support without assumptions.
export function comparePeriods(currentEvents, priorEvents) {
  const current = periodTotals(currentEvents);
  const prior = periodTotals(priorEvents);
  const byModel = new Map();
  for (const [label, events] of [['current', currentEvents], ['prior', priorEvents]]) {
    for (const row of rankGroups(events, { by: 'model', limit: Number.MAX_SAFE_INTEGER }).groups) {
      const entry = byModel.get(row.key) ?? { model: row.key, current: 0, prior: 0 };
      entry[label] = row.provider_cost_usd;
      byModel.set(row.key, entry);
    }
  }
  return {
    turns: delta(current.turns, prior.turns),
    imported_turns: delta(current.imported_turns, prior.imported_turns),
    sessions: delta(current.sessions, prior.sessions),
    provider_cost_usd: delta(current.provider_cost_usd, prior.provider_cost_usd),
    cost_per_turn_usd: delta(current.cost_per_turn_usd, prior.cost_per_turn_usd),
    compactions: delta(current.compactions, prior.compactions),
    models: [...byModel.values()]
      .map((row) => ({ ...row, ...delta(row.current, row.prior) }))
      .sort((a, b) => Math.abs(b.absolute) - Math.abs(a.absolute))
  };
}
