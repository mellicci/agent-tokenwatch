import { effectiveEventCost } from './store.mjs';

function sum(values) { return values.reduce((total, value) => total + (Number(value) || 0), 0); }
function average(values) { return values.length ? sum(values) / values.length : 0; }
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function turnKey(event, index) {
  if (event.turn_id) return `${event.agent}|${event.session_id ?? '-'}|${event.turn_id}`;
  return `${event.agent}|${event.session_id ?? '-'}|event:${index}`;
}

export function groupTurns(events) {
  const groups = new Map();
  events.forEach((event, index) => {
    // A render that moved no tokens still carries a valid context-window
    // reading, and used to be dropped here entirely - discarding that reading
    // along with the (correctly) absent usage. Keep it: context is a
    // point-in-time gauge, independent of whether this event's own tokens were
    // additive, sampled, or absent.
    if (!event.usage && effectiveEventCost(event) === undefined && event.context?.percent === undefined) return;
    const key = turnKey(event, index);
    const group = groups.get(key) ?? {
      key, agent: event.agent, session_id: event.session_id, turn_id: event.turn_id,
      model: event.model, project_id: event.project_id, first_ts: event.ts, last_ts: event.ts,
      usage: {}, provider_cost_usd: 0, estimated_cost_usd: 0, has_provider_cost: false,
      has_estimated_cost: false, context_percent: undefined, events: 0, basis: undefined,
      billing: {}
    };
    group.events += 1;
    group.last_ts = event.ts;
    // Imported history reads as tokens only, with no provider cost, so every
    // report that includes it says so (intent 06, D4).
    if (event.source === 'import') {
      group.imported = true;
      group.import_verification = event.import?.verification ?? 'unverified';
    }
    group.model = event.model ?? group.model;
    // Records written before usage.basis existed carry no tag. A status line is a
    // gauge whatever the schema version, so infer from the source rather than
    // silently summing historical samples.
    const basis = event.usage
      ? (event.usage.basis ?? (event.source === 'statusline' ? 'sample' : 'increment'))
      : undefined;
    if (basis) group.basis = group.basis && group.basis !== basis ? 'mixed' : basis;
    if (basis === 'sample') {
      // A sample describes the latest call, not an additional one. Keep the most
      // recent reading rather than accumulating repeated observations.
      const latest = {};
      for (const [keyName, value] of Object.entries(event.usage ?? {})) {
        if (Number.isFinite(value)) latest[keyName] = value;
      }
      group.usage = latest;
    } else {
      for (const [keyName, value] of Object.entries(event.usage ?? {})) {
        if (!Number.isFinite(value)) continue;
        group.usage[keyName] = (group.usage[keyName] ?? 0) + value;
      }
    }
    const cost = effectiveEventCost(event);
    if (cost !== undefined) {
      if (event.cost?.basis === 'configured_estimate') {
        group.estimated_cost_usd += cost;
        group.has_estimated_cost = true;
      } else {
        group.provider_cost_usd += cost;
        group.has_provider_cost = true;
      }
    }
    if (event.context?.percent !== undefined) group.context_percent = event.context.percent;
    // A provider that bills in units rather than currency (Copilot's AI units
    // and premium requests). `event.billing` is always a real per-call delta by
    // construction - the store only ever attaches it as the movement between
    // two cumulative snapshots - so it is safe to sum unconditionally, unlike
    // usage, which needs the sample/increment distinction above.
    for (const [unitName, value] of Object.entries(event.billing ?? {})) {
      if (Number.isFinite(value)) group.billing[unitName] = (group.billing[unitName] ?? 0) + value;
    }
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => new Date(a.last_ts) - new Date(b.last_ts));
}

export function aggregateEvents(events) {
  const turns = groupTurns(events);
  const usageKeys = ['input_total', 'input_fresh', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output', 'reasoning', 'total'];
  // Only increments may be summed. Gauge samples describe the same context
  // repeatedly, so adding them would multiply one turn by the observation count.
  const incrementTurns = turns.filter((turn) => turn.basis !== 'sample');
  const sampleTurns = turns.filter((turn) => turn.basis === 'sample');
  const tokens = Object.fromEntries(usageKeys.map((key) => [key, sum(incrementTurns.map((turn) => turn.usage[key]))]));
  const sampleInputs = sampleTurns.map((turn) => turn.usage.input_total ?? 0).filter((value) => value > 0);
  const sampleOutputs = sampleTurns.map((turn) => turn.usage.output ?? 0).filter((value) => value > 0);
  const contextSamples = {
    turns: sampleTurns.length,
    input_last: sampleInputs.at(-1),
    input_median: sampleInputs.length ? percentile(sampleInputs, 0.5) : undefined,
    input_p95: sampleInputs.length ? percentile(sampleInputs, 0.95) : undefined,
    input_max: sampleInputs.length ? Math.max(...sampleInputs) : undefined,
    output_median: sampleOutputs.length ? percentile(sampleOutputs, 0.5) : undefined,
    output_p95: sampleOutputs.length ? percentile(sampleOutputs, 0.95) : undefined
  };
  // Independent of usage.basis: context-window fullness is a gauge whatever
  // kind of token data (additive, sampled, or none) rides alongside it on the
  // same event. Tying this to usage.basis - as context_samples above does, for
  // the token-count fields that genuinely must not double with increments -
  // silently dropped nearly every context reading for a provider whose token
  // deltas are correctly tagged 'increment', such as Copilot's cumulative
  // counters. This reports the percent series that basis-gating was losing.
  const contextPercents = turns.map((turn) => turn.context_percent).filter((value) => Number.isFinite(value));
  const contextPercentSamples = {
    turns: contextPercents.length,
    percent_last: contextPercents.at(-1),
    percent_median: contextPercents.length ? percentile(contextPercents, 0.5) : undefined,
    percent_p95: contextPercents.length ? percentile(contextPercents, 0.95) : undefined,
    percent_max: contextPercents.length ? Math.max(...contextPercents) : undefined
  };
  const providerTurns = turns.filter((turn) => turn.has_provider_cost);
  const estimatedTurns = turns.filter((turn) => turn.has_estimated_cost);
  const sessions = new Set(events.map((event) => event.session_id).filter(Boolean));
  const models = {};
  for (const turn of turns) {
    const name = turn.model ?? 'unknown';
    const row = models[name] ?? { turns: 0, input_total: 0, output: 0, provider_cost_usd: 0, estimated_cost_usd: 0 };
    row.turns += 1;
    row.input_total += turn.usage.input_total ?? 0;
    row.output += turn.usage.output ?? 0;
    row.provider_cost_usd += turn.provider_cost_usd;
    row.estimated_cost_usd += turn.estimated_cost_usd;
    models[name] = row;
  }
  // Ratios are scale-free, so they stay meaningful for gauge samples whose totals
  // must not be added. Decompose each turn's input into the three shares that sum
  // to one: served from cache, newly written to cache, and genuinely fresh.
  // Counting writes as cache hits is what made this read 100% on every turn.
  const cacheRatios = turns
    .filter((turn) => (turn.usage.input_total ?? 0) > 0)
    .map((turn) => ({
      read: (turn.usage.cache_read ?? 0) / turn.usage.input_total,
      write: (turn.usage.cache_write ?? 0) / turn.usage.input_total,
      fresh: (turn.usage.input_fresh ?? 0) / turn.usage.input_total
    }));
  const inputValues = turns.map((turn) => turn.usage.input_total ?? 0).filter((value) => value > 0);
  const outputValues = turns.map((turn) => turn.usage.output ?? 0).filter((value) => value > 0);
  return {
    events: events.length,
    turns: turns.length,
    session_count: sessions.size,
    // Min and max, not the ends of the array: an import appends old history
    // after newer rows, so file order is no longer time order (intent 06, D4).
    first_ts: events.length ? events.reduce((min, event) => (event.ts < min ? event.ts : min), events[0].ts) : undefined,
    last_ts: events.length ? events.reduce((max, event) => (event.ts > max ? event.ts : max), events[0].ts) : undefined,
    tokens,
    increment_turns: incrementTurns.length,
    imported_turns: turns.filter((turn) => turn.imported).length,
    imported_sessions: new Set(turns.filter((turn) => turn.imported).map((turn) => turn.session_id).filter(Boolean)).size,
    imported_unverified_turns: turns.filter((turn) => turn.imported && turn.import_verification !== 'verified').length,
    context_samples: contextSamples,
    context_percent_samples: contextPercentSamples,
    cache: {
      read_share: average(cacheRatios.map((row) => row.read)),
      write_share: average(cacheRatios.map((row) => row.write)),
      fresh_share: average(cacheRatios.map((row) => row.fresh)),
      ratio_turns: cacheRatios.length
    },
    cost: {
      provider_reported_usd: sum(providerTurns.map((turn) => turn.provider_cost_usd)),
      configured_estimate_usd: sum(estimatedTurns.map((turn) => turn.estimated_cost_usd)),
      provider_turns: providerTurns.length,
      estimated_turns: estimatedTurns.length,
      average_provider_turn_usd: average(providerTurns.map((turn) => turn.provider_cost_usd)),
      average_estimated_turn_usd: average(estimatedTurns.map((turn) => turn.estimated_cost_usd))
    },
    distribution: {
      input_average: average(inputValues), input_median: percentile(inputValues, 0.5), input_p95: percentile(inputValues, 0.95),
      output_average: average(outputValues), output_median: percentile(outputValues, 0.5), output_p95: percentile(outputValues, 0.95)
    },
    models,
    turns_data: turns
  };
}

export function rollingStatusFromState(state, config, agent) {
  const normalizedAgent = agent === 'claude' ? 'claude-code'
    : agent === 'codex' ? 'codex-cli'
      : agent === 'copilot' ? 'github-copilot-cli' : agent;
  const all = state.recent?.[normalizedAgent] ?? [];
  // The ring holds every session that shares this state file. Scope it to the
  // session being rendered, or another session's turns leak into these figures.
  const newest = all.filter((event) => event.usage || event.billing || effectiveEventCost(event) !== undefined).at(-1)
    ?? state.latest?.[normalizedAgent];
  const scope = newest?.session_id;
  const recent = all.filter((event) => (event.usage || event.billing || effectiveEventCost(event) !== undefined)
    && (!scope || event.session_id === scope));
  const latest = recent.at(-1) ?? newest;
  // The newest entry is the turn still in flight, whose cost is only partial.
  // Comparing a partial against completed turns is what makes the figure look
  // implausibly low, so the two are reported separately.
  const pendingKeys = new Set(Object.keys(state.pending?.[normalizedAgent] ?? {}));
  const inFlight = recent.filter((event) => pendingKeys.has(event.turn_key)).at(-1);
  const completed = recent.filter((event) => !pendingKeys.has(event.turn_key));
  const lastCompleted = completed.at(-1);

  const window = completed.slice(-Math.max(1, Number(config.averagingWindow) || 10));
  // Average over turns that actually incurred a charge. Including turns whose
  // delta is zero would report an average far below any real turn's cost.
  const costRows = window.filter((event) => Number(effectiveEventCost(event)) > 0);
  const provider = costRows.filter((event) => event.cost?.basis !== 'configured_estimate');
  const estimated = costRows.filter((event) => event.cost?.basis === 'configured_estimate');
  const lastPromptCost = lastCompleted ? effectiveEventCost(lastCompleted) : undefined;
  const inFlightCost = inFlight ? effectiveEventCost(inFlight) : undefined;
  const currentBasis = lastCompleted?.cost?.basis ?? latest?.cost?.basis;
  const sessionCost = latest?.cost?.cumulative_usd;
  const session = latest?.session_id;
  const allRecent = all.filter((event) => !scope || event.session_id === scope);
  // Token counts must come from the newest event that actually moved them, but
  // context and model are gauges: they are true as of the newest render, whether
  // or not tokens moved. A provider that reports cumulative counters emits many
  // no-movement renders, and reading context off the last movement would keep
  // showing the old window after a compaction or a clear - the one reading this
  // is meant to prevent. Sampled-usage providers are unaffected: for them every
  // render carries usage, so the newest render is the newest movement.
  const newestRender = allRecent.at(-1);
  const subagentWindowState = state.subagentWindows?.[[normalizedAgent, session ?? 'no-session'].join('|')]
    ?? state.subagentWindows?.[normalizedAgent];
  // Prefer the maintained counter; the ring is capped and under-reports once it
  // fills. Fall back to scanning only for state written before the counter existed.
  const subagentCount = subagentWindowState?.session === session && Number.isFinite(subagentWindowState?.completed)
    ? subagentWindowState.completed
    // Fallback for state written before the counter existed. Counts starts, not
    // stops: Claude Code emits many more SubagentStop events than it spawns
    // subagents, while starts match the transcript one for one.
    : allRecent.filter((event) => event.kind === 'subagent'
      && (!session || event.session_id === session)
      && !/stop|end|complete/i.test(event.event_name ?? '')).length;
  // Cache warmth is only reported when the provider supplied a TTL. A configured
  // default is an assumption and must not be rendered as an observation.
  let cacheAgeSeconds;
  let cacheTtlSeconds;
  let cacheTtlSource;
  if (latest?.cache?.ttl_source === 'provider_reported' && Number.isFinite(latest.cache.ttl_seconds)) {
    cacheTtlSeconds = latest.cache.ttl_seconds;
    cacheTtlSource = 'provider_reported';
    const observedAge = Number.isFinite(latest.cache.age_seconds) ? latest.cache.age_seconds : 0;
    const elapsed = Math.max(0, (Date.now() - new Date(latest.ts).getTime()) / 1000);
    cacheAgeSeconds = observedAge + elapsed;
  }
  const subagentCost = Number.isFinite(subagentWindowState?.accumulatedUsd) && subagentWindowState.accumulatedUsd > 0
    ? subagentWindowState.accumulatedUsd : undefined;
  // The same window, measured in the provider's own unit when it reports no money.
  const subagentUnits = Number.isFinite(subagentWindowState?.accumulatedUnits) && subagentWindowState.accumulatedUnits > 0
    ? subagentWindowState.accumulatedUnits : undefined;
  const sessionUnits = (newestRender?.billing_cumulative ?? latest?.billing_cumulative)?.aiu;

  const displayed = latest && newestRender && newestRender !== latest
    ? { ...latest, context: newestRender.context ?? latest.context, model: newestRender.model ?? latest.model }
    : latest;

  return {
    agent: normalizedAgent,
    latest: displayed,
    // Cost accrued while at least one subagent was active. Parallel subagents
    // share one window, so this is co-occurring cost, not per-subagent spend.
    subagent_cost_usd: subagentCost,
    subagent_cost_share: subagentCost !== undefined && Number.isFinite(sessionCost) && sessionCost > 0
      ? subagentCost / sessionCost
      : subagentUnits !== undefined && Number.isFinite(sessionUnits) && sessionUnits > 0
        ? subagentUnits / sessionUnits : undefined,
    // Providers that bill in units rather than currency. Kept apart from the USD
    // fields so nothing can add the two together or print one as the other.
    session_billing: newestRender?.billing_cumulative ?? latest?.billing_cumulative,
    last_prompt_billing: lastCompleted?.billing,
    in_flight_billing: inFlight?.billing,
    last_prompt_cost_usd: lastPromptCost,
    in_flight_cost_usd: Number(inFlightCost) > 0 ? inFlightCost : undefined,
    current_cost_basis: currentBasis,
    session_cost_usd: sessionCost,
    cache_ttl_source: cacheTtlSource,
    average_provider_cost_usd: provider.length ? average(provider.map(effectiveEventCost)) : undefined,
    average_estimated_cost_usd: estimated.length ? average(estimated.map(effectiveEventCost)) : undefined,
    average_window: costRows.length,
    subagent_count: subagentCount,
    cache_age_seconds: cacheAgeSeconds,
    cache_ttl_seconds: cacheTtlSeconds
  };
}
