import { effectiveEventCost, TURN_OPENING_EVENTS } from './store.mjs';

function sum(values) { return values.reduce((total, value) => total + (Number(value) || 0), 0); }
function average(values) { return values.length ? sum(values) / values.length : 0; }
// A loop, not Math.max(...values): spreading every reading of a period into one
// call throws a RangeError past roughly 125,000 of them.
export function maximum(values) {
  let max;
  for (const value of values) if (max === undefined || value > max) max = value;
  return max;
}
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// Every row's position in time: parsed once, then the indexes sorted by time,
// ties in file order. A ledger is not always in time order - repair merges
// ledgers, an import appends old rows late - and nothing grouped from it may
// depend on the order rows sit in the file.
function timeOrder(events) {
  const times = events.map((event) => {
    const time = Date.parse(event.ts);
    return Number.isFinite(time) ? time : 0;
  });
  const order = events.map((_, index) => index).sort((a, b) => (times[a] - times[b]) || (a - b));
  return { times, order };
}

function turnKey(event, index) {
  if (event.turn_id) return `${event.agent}|${event.session_id ?? '-'}|${event.turn_id}`;
  return `${event.agent}|${event.session_id ?? '-'}|event:${index}`;
}

// A turn is one prompt and the whole answer to it, however many model calls
// that answer takes. Claude names each prompt (its prompt id is the turn id);
// Copilot names none, so each of its model calls - one movement of its
// cumulative counters - used to be a turn of its own: 16 turns for a session of
// three prompts in the Windows live test. The prompt hook is what marks a
// prompt, so a row with no turn id belongs to the turn the latest prompt hook
// of its session opened, in time order rather than file order (repair merges
// ledgers, an import appends old rows late). Applied when reading, so a ledger
// written before this rule is regrouped without a migration.
//
// Not delimited, and so one turn per row as before: a row before the first
// prompt hook of its session in the rows read (a hook-less install, or a
// period that starts mid-reply), a row with no session id (sessions cannot be
// told apart), and an imported row, which is one response or one session
// summary by its own definition (intent 06). A row with a turn id keeps it; a
// prompt hook that carries one still marks the boundary for rows without.
// Returns the segment key of every delimited row, by index; `order` is the
// rows' time order (timeOrder).
function promptSegments(events, order) {
  const current = new Map();
  const segments = new Map();
  for (const index of order) {
    const event = events[index];
    if (!event.session_id || event.source === 'import') continue;
    const session = `${event.agent}|${event.session_id}`;
    if (TURN_OPENING_EVENTS.has(event.event_name)) current.set(session, `${session}|prompt:${index}`);
    if (!event.turn_id && current.has(session)) segments.set(index, current.get(session));
  }
  return segments;
}

// A status-line reading that carries no additive counter: a gauge sample, or a
// render with no usage at all. Records written before usage.basis existed are
// read as samples when they came from the status line, as below.
function isStatusLineReading(event) {
  if (event.source !== 'statusline') return false;
  if (!event.usage) return true;
  return (event.usage.basis ?? 'sample') === 'sample';
}

function sameGauge(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]
    .filter((key) => Number.isFinite(a[key]) || Number.isFinite(b[key])));
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function movedUnits(billing) {
  return Object.values(billing ?? {}).some((value) => Number(value) > 0);
}

// F3: Claude Code gives a slash command (/status, /cost, /context), the render
// after /compact, and the render before the first prompt a prompt id of their
// own, with no model call behind it. Grouped by that id, each read as a turn
// that cost nothing. A reading is render-only - a context reading, not a turn -
// only when every one of these holds:
// - it is made of status-line readings alone (never an increment, an imported
//   row or anything Codex sends, none of which comes from a status line);
// - no prompt hook carries its turn id (a prompt is a turn, even one that has
//   not moved its cost yet);
// - it moved no provider cost, no estimate and no billing units;
// - its token gauge, if it has one, equals the previous reading's in the same
//   session, so no new call is behind it. The first reading of a session has
//   nothing to compare with and is render-only when it moved no cost: the
//   first cumulative cost observation is a baseline by design.
// A Copilot render moves nothing exactly when its cumulative counters did not
// change, which leaves it with no usage, no billing and no cost.
// The same rule serves the report (groupTurns) and the live status line
// (rollingStatusFromState). Each view is { session, statusLineOnly,
// promptOpened, cost, billing, gauge }, in time order; the answer is one flag
// per view.
function renderOnlyFlags(views) {
  const lastGauge = new Map();
  return views.map((view) => {
    const previous = lastGauge.get(view.session);
    if (view.gauge) lastGauge.set(view.session, view.gauge);
    if (!view.statusLineOnly || view.promptOpened) return false;
    if (view.cost > 0 || movedUnits(view.billing)) return false;
    return !view.gauge || !previous || sameGauge(view.gauge, previous);
  });
}

function numericGauge(usage) {
  const gauge = {};
  for (const [key, value] of Object.entries(usage ?? {})) if (Number.isFinite(value)) gauge[key] = value;
  return Object.keys(gauge).length ? gauge : undefined;
}

// Every reading of the period - each turn, and each render-only reading -
// grouped once. A report hands the same readings to each of its sections
// (aggregateEvents, analyzeEvents, rankGroups, turnConcentration,
// comparePeriods) rather than have each group the whole period again.
// Rows are taken in time order, so what a group keeps as its latest - the
// sample gauge, the context reading, the model - is the latest in time, as the
// grouping itself is.
export function turnReadings(events) {
  const groups = new Map();
  const lastTimes = new Map();
  // Groups holding any row that is not a status-line reading. Kept beside the
  // groups, not on them: deleting a working field from 100,000 group objects
  // afterwards slowed every later read of them.
  const notStatusLineOnly = new Set();
  const promptKeys = new Set(events
    .filter((event) => event.turn_id && TURN_OPENING_EVENTS.has(event.event_name))
    .map((event) => turnKey(event)));
  const { times, order } = timeOrder(events);
  const segments = promptSegments(events, order);
  for (const index of order) {
    const event = events[index];
    // A render that moved no tokens still carries a valid context-window
    // reading, and used to be dropped here entirely - discarding that reading
    // along with the (correctly) absent usage. Keep it: context is a
    // point-in-time gauge, independent of whether this event's own tokens were
    // additive, sampled, or absent.
    if (!event.usage && effectiveEventCost(event) === undefined && event.context?.percent === undefined) continue;
    const segment = event.turn_id ? undefined : segments.get(index);
    const key = segment ?? turnKey(event, index);
    const group = groups.get(key) ?? {
      key, agent: event.agent, session_id: event.session_id, turn_id: event.turn_id,
      model: event.model, project_id: event.project_id, first_ts: event.ts, last_ts: event.ts,
      usage: {}, provider_cost_usd: 0, estimated_cost_usd: 0, has_provider_cost: false,
      has_estimated_cost: false, context_percent: undefined, events: 0, basis: undefined,
      billing: {},
      // What made these rows one turn: the provider's turn id, a prompt hook,
      // or nothing, in which case the row is a turn of its own.
      delimited_by: event.turn_id ? 'turn_id' : segment ? 'prompt_hook' : 'row',
      context_readings: [], render_only: false
    };
    group.events += 1;
    if (!isStatusLineReading(event)) notStatusLineOnly.add(group);
    // Min and max: rows of one prompt-delimited turn need not sit in time order.
    if (event.ts < group.first_ts) group.first_ts = event.ts;
    if (!(event.ts < group.last_ts)) group.last_ts = event.ts;
    if (event.context?.percent !== undefined) group.context_readings.push(event.context.percent);
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
    // Rows arrive in time order, so the last one seen is the group's latest.
    lastTimes.set(group, times[index]);
  }
  const readings = [...groups.values()].sort((a, b) => lastTimes.get(a) - lastTimes.get(b));
  const flags = renderOnlyFlags(readings.map((group) => ({
    session: `${group.agent}|${group.session_id ?? '-'}`,
    statusLineOnly: !notStatusLineOnly.has(group),
    promptOpened: promptKeys.has(group.key) || group.delimited_by === 'prompt_hook',
    cost: Math.max(group.provider_cost_usd, group.estimated_cost_usd),
    billing: group.billing,
    gauge: group.basis === 'sample' ? numericGauge(group.usage) : undefined
  })));
  readings.forEach((group, index) => { group.render_only = flags[index]; });
  return readings;
}

// The turns of `readings` (turnReadings): render-only readings are not turns,
// so no turn count, per-turn cost, ranking or comparison may see them.
export function turnsOf(readings) {
  return readings.filter((group) => !group.render_only);
}

// Render-only readings are left out unless asked for. Only the context-reading
// series in aggregateEvents() asks for them.
export function groupTurns(events, { includeRenderOnly = false } = {}) {
  const readings = turnReadings(events);
  return includeRenderOnly ? readings : turnsOf(readings);
}

// `readings` is turnReadings(events), when the caller has already grouped them.
export function aggregateEvents(events, { readings = turnReadings(events) } = {}) {
  // Render-only readings are not turns, but each is still a true context
  // reading, so the two gauge series below keep them and nothing else does.
  const turns = turnsOf(readings);
  const usageKeys = ['input_total', 'input_fresh', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output', 'reasoning', 'total'];
  // Only increments may be summed. Gauge samples describe the same context
  // repeatedly, so adding them would multiply one turn by the observation count.
  const incrementTurns = turns.filter((turn) => turn.basis !== 'sample');
  const sampleTurns = readings.filter((turn) => turn.basis === 'sample');
  const tokens = Object.fromEntries(usageKeys.map((key) => [key, sum(incrementTurns.map((turn) => turn.usage[key]))]));
  const sampleInputs = sampleTurns.map((turn) => turn.usage.input_total ?? 0).filter((value) => value > 0);
  const sampleOutputs = sampleTurns.map((turn) => turn.usage.output ?? 0).filter((value) => value > 0);
  const contextSamples = {
    turns: sampleTurns.length,
    input_last: sampleInputs.at(-1),
    input_median: sampleInputs.length ? percentile(sampleInputs, 0.5) : undefined,
    input_p95: sampleInputs.length ? percentile(sampleInputs, 0.95) : undefined,
    input_max: maximum(sampleInputs),
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
  // A turn a prompt hook delimited holds every render of that reply, each its
  // own reading, so each is kept; a turn with an id keeps the one reading it
  // always contributed, its last.
  const contextPercents = readings
    .flatMap((turn) => (turn.delimited_by === 'prompt_hook' ? turn.context_readings : [turn.context_percent]))
    .filter((value) => Number.isFinite(value));
  const contextPercentSamples = {
    turns: contextPercents.length,
    percent_last: contextPercents.at(-1),
    percent_median: contextPercents.length ? percentile(contextPercents, 0.5) : undefined,
    percent_p95: contextPercents.length ? percentile(contextPercents, 0.95) : undefined,
    percent_max: maximum(contextPercents)
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
    // Status-line readings with no model call behind them (F3): kept in the
    // two context series, counted in no turn figure.
    render_only_readings: readings.length - turns.length,
    // Turns neither a turn id nor a prompt hook in the rows read delimited, so
    // each is one ledger row: for Copilot, one model call. A hook-less install,
    // or a period that starts mid-reply; said, never merged by guesswork.
    undelimited_turns: turns.filter((turn) => turn.delimited_by === 'row' && !turn.imported).length,
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

// The prompt number the store gave an entry with no turn id (`seq:N`,
// turnKeyFor in src/store.mjs), or undefined: an entry with a turn id, or one
// before any prompt hook (`seq:0`), is a reply of its own.
function promptSeq(entry) {
  if (entry.turn_id) return undefined;
  const match = /\|seq:(\d+)$/.exec(entry.turn_key ?? '');
  const seq = match ? Number(match[1]) : 0;
  return seq > 0 ? seq : undefined;
}

// A reply's cost is the sum of its calls' per-call amounts, in one basis; a
// reply mixing provider figures and estimates keeps its newest call's cost
// rather than adding the two.
function replyCost(entries) {
  const costed = entries.filter((entry) => effectiveEventCost(entry) !== undefined);
  const last = entries.at(-1);
  if (!costed.length) return last.cost;
  const basis = costed.at(-1).cost.basis;
  if (costed.some((entry) => entry.cost.basis !== basis)) return last.cost ?? costed.at(-1).cost;
  const amount = costed.reduce((sum, entry) => sum + Number(effectiveEventCost(entry)), 0);
  const { amount_usd: _amount, delta_usd: _delta, ...rest } = last.cost ?? costed.at(-1).cost;
  return { ...rest, basis, delta_usd: Number(amount.toFixed(12)) };
}

// A reply rebuilt from the ring, with the cost and units of the running total
// the store kept for it (replyTotals, src/store.mjs), which still counts the
// calls the ring has dropped or a report flushed. A reply that mixed provider
// figures and estimates keeps the ring's cost, its newest call's.
function withReplyTotal(reply, total) {
  if (!total) return reply;
  let cost = reply.cost;
  if (total.cost && !total.mixed) {
    const { amount_usd: _amount, delta_usd: _delta, ...rest } = reply.cost ?? {};
    cost = { ...rest, basis: total.cost.basis, delta_usd: total.cost.delta_usd };
  }
  return { ...reply, billing: total.billing, cost };
}

// Entries, in ring order, folded into replies: the entries of one prompt-numbered
// turn, or of any turn the store kept a running total for, become one reply
// carrying the newest entry's gauges and the reply's units and cost; every other
// entry stays a reply of its own. Replies are ordered by their newest entry. A
// reply the ring holds no entry of any more, but whose total the store kept, is
// older than everything the ring holds, so it comes first.
function replyUnits(entries, totals = {}, scope) {
  const totalOf = (key) => (Object.hasOwn(totals, key ?? '') ? totals[key] : undefined);
  const units = new Map();
  entries.forEach((entry, index) => {
    const whole = promptSeq(entry) !== undefined || totalOf(entry.turn_key) !== undefined;
    const key = whole ? entry.turn_key : `entry:${index}`;
    const unit = units.get(key) ?? { entries: [], last: index, total: whole ? totalOf(key) : undefined };
    unit.entries.push(entry);
    unit.last = index;
    units.set(key, unit);
  });
  const dropped = Object.entries(totals)
    .filter(([key, total]) => total.calls > 0 && !units.has(key) && (!scope || total.session_id === scope))
    .map(([key, total]) => withReplyTotal({ turn_key: key, session_id: total.session_id, turn_id: total.turn_id, ts: total.ts }, total));
  const held = [...units.values()]
    .sort((a, b) => a.last - b.last)
    .map(({ entries: unit, total }) => {
      if (unit.length === 1) return withReplyTotal(unit[0], total);
      let billing;
      for (const entry of unit) {
        for (const [name, value] of Object.entries(entry.billing ?? {})) {
          if (!Number.isFinite(value)) continue;
          billing ??= {};
          billing[name] = Number(((billing[name] ?? 0) + value).toFixed(6));
        }
      }
      return withReplyTotal({ ...unit.at(-1), billing, cost: replyCost(unit) }, total);
    });
  return [...dropped, ...held];
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
  const allRecent = all.filter((event) => !scope || event.session_id === scope);
  // A render with no model call behind it (/status, /cost, the render after
  // /compact, F3) is not a reply: it may neither become the reply in flight or
  // the previous reply, nor take a slot in the averaging window. It stays the
  // newest reading for the gauges below (`latest`, context, session cost).
  // The running totals of this state's replies; each was opened by a prompt.
  const totals = state.replyTotals?.[normalizedAgent] ?? {};
  const promptKeys = new Set([
    ...allRecent.filter((event) => TURN_OPENING_EVENTS.has(event.event_name)).map((event) => event.turn_key),
    ...Object.keys(totals)
  ]);
  const renderOnly = renderOnlyFlags(recent.map((event) => ({
    session: event.session_id ?? '-',
    statusLineOnly: isStatusLineReading(event),
    promptOpened: promptKeys.has(event.turn_key),
    cost: Number(effectiveEventCost(event)) || 0,
    billing: event.billing,
    gauge: event.usage && isStatusLineReading(event) ? numericGauge(event.usage) : undefined
  })));
  // One reply is the prompt and every call behind it. A provider with no turn id
  // (Copilot) records one entry per model call; the store numbers them by prompt
  // hook, so the entries of one prompt are one reply here, as they are one turn
  // in `analyze` (promptSegments above).
  const replies = replyUnits(recent.filter((_, index) => !renderOnly[index]), totals, scope);
  // The newest entry is the turn still in flight, whose cost is only partial.
  // Comparing a partial against completed turns is what makes the figure look
  // implausibly low, so the two are reported separately. A prompt-numbered reply
  // is open until the next prompt, as a held Claude turn is.
  const pendingKeys = new Set(Object.keys(state.pending?.[normalizedAgent] ?? {}));
  const openSeq = state.turnSeq?.[normalizedAgent];
  const open = (reply) => pendingKeys.has(reply.turn_key) || (promptSeq(reply) !== undefined && promptSeq(reply) === openSeq);
  const inFlight = replies.filter(open).at(-1);
  const completed = replies.filter((reply) => !open(reply));
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
