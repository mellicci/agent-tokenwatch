import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { assertPrivacySafe, cleanUsage } from './schema.mjs';
import { atomicWriteJson, ensureDir, isWriteRefused, readJson, writeTextAtomic } from './fs-util.mjs';
import { estimateEventCost, loadPricing } from './pricing.mjs';
import { withStateLock } from './state-lock.mjs';

const STATE_VERSION = 2;
const RECENT_LIMIT = 200;
const FINGERPRINT_LIMIT = 1200;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_PENDING_TURNS = 8;
// Running totals kept for the newest replies (openReplyTotal below); older
// replies fall back to what the ring still holds, as every reply used to.
const REPLY_TOTAL_LIMIT = 50;

// A status line re-renders many times per turn. These events open a new turn, so
// they are the boundary at which the previous turn's final sample is durable.
// Codex has no lifecycle hook for this, but its OTLP stream names the moment a
// prompt is submitted, which is the same boundary. Without it every Codex
// observation was its own turn. Aggregation reads the same set: a turn one of
// these opened is a prompt, never a render-only reading (src/aggregate.mjs).
export const TURN_OPENING_EVENTS =new Set(['UserPromptSubmit', 'userPromptSubmitted', 'codex.user_prompt']);
const SESSION_CLOSING_EVENTS = new Set(['SessionEnd', 'sessionEnd']);

function blankState() {
  return {
    version: STATE_VERSION,
    cumulativeCosts: {},
    cumulativeUsage: {},
    cumulativeBilling: {},
    recentFingerprints: [],
    recent: {},
    latest: {},
    cacheActivity: {},
    subagentWindows: {},
    turnSeq: {},
    replyTotals: {},
    pending: {},
    counters: { written: 0, duplicates: 0, errors: 0, collapsed: 0, unkeyed: 0 }
  };
}

// One state file per session. The ledger is append-only and safe to share, but
// state is read-modify-write: with every session writing the same file, one could
// silently overwrite another's update. A file per session gives each a single
// writer and removes the contention entirely.
//
// The name is a hash of the session id, not the id itself. A session id comes
// from the agent, and whatever is in it used to end up in `ls` output, in backup
// manifests and in cloud-sync indexes - places a secret outlives the file. Only
// this function ever builds these names; readers discover them by listing the
// directory, so the hash costs nothing.
export function sessionStateFile(config, sessionId) {
  if (!sessionId) return config.stateFile;
  const digest = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
  return path.join(path.dirname(config.stateFile), 'sessions', `s_${digest}.json`);
}

// Where this session's state lived before the names were hashed. Read on
// upgrade so a session running across the change keeps its cumulative-cost
// baseline instead of restarting from a blank state file.
function legacySessionStateFile(config, sessionId) {
  if (!sessionId) return undefined;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(path.dirname(config.stateFile), 'sessions', `${safe}.json`);
}

export function listSessionStateFiles(config) {
  const dir = path.join(path.dirname(config.stateFile), 'sessions');
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { entries = []; }
  const files = entries.map((name) => path.join(dir, name));
  if (fs.existsSync(config.stateFile)) files.push(config.stateFile);
  return files;
}

// Carry a session's slice out of the single shared file the previous layout used,
// so an upgrade does not blank the live status line.
function sliceLegacyState(legacy, sessionId) {
  const state = blankState();
  if (!legacy || !sessionId) return state;
  state.counters = legacy.counters ?? state.counters;
  state.recentFingerprints = legacy.recentFingerprints ?? [];
  for (const [agent, list] of Object.entries(legacy.recent ?? {})) {
    const mine = (list ?? []).filter((entry) => entry.session_id === sessionId);
    if (mine.length) state.recent[agent] = mine;
  }
  for (const [agent, entry] of Object.entries(legacy.latest ?? {})) {
    if (entry?.session_id === sessionId) state.latest[agent] = entry;
  }
  for (const [key, value] of Object.entries(legacy.cumulativeBilling ?? {})) {
    if (key.includes(sessionId)) state.cumulativeBilling[key] = value;
  }
  for (const [key, value] of Object.entries(legacy.cumulativeUsage ?? {})) {
    if (key.includes(sessionId)) state.cumulativeUsage[key] = value;
  }
  for (const [key, value] of Object.entries(legacy.cumulativeCosts ?? {})) {
    if (key.includes(sessionId)) state.cumulativeCosts[key] = value;
  }
  for (const [key, value] of Object.entries(legacy.cacheActivity ?? {})) {
    if (key.includes(sessionId)) state.cacheActivity[key] = value;
  }
  for (const [key, value] of Object.entries(legacy.subagentWindows ?? {})) {
    if (key.includes(sessionId) || value?.session === sessionId) state.subagentWindows[key] = value;
  }
  for (const [agent, turns] of Object.entries(legacy.pending ?? {})) {
    const mine = Object.fromEntries(Object.entries(turns ?? {}).filter(([turnKey]) => turnKey.includes(sessionId)));
    if (Object.keys(mine).length) state.pending[agent] = mine;
  }
  state.turnSeq = legacy.turnSeq ?? {};
  return state;
}

export function loadState(config, sessionId) {
  return loadSessionState(config, sessionId).state;
}

// The one lookup of a session's stored state, tier by tier, and whether any
// tier held that session. `found` comes from the same read that produces the
// state, so a status render can never show figures its session_scope calls
// absent (intent 15, D13). A slice of the pre-migration combined file always
// yields a state (it carries the shared counters), so it counts as found only
// when it holds a row of this session. With no sessionId it describes the
// shared state file, where a payload without an id is filed (D14).
export function loadSessionState(config, sessionId) {
  const file = sessionStateFile(config, sessionId);
  let raw = readJson(file, null);
  let found = Boolean(raw);
  if (!raw && sessionId) {
    raw = readJson(legacySessionStateFile(config, sessionId), null);
    found = Boolean(raw);
  }
  if (!raw && sessionId) {
    raw = sliceLegacyState(readJson(config.stateFile, null), sessionId);
    found = Object.keys(raw.recent).length > 0 || Object.keys(raw.latest).length > 0;
  }
  const state = { ...blankState(), ...(raw ?? blankState()) };
  // Pending used to be a single turn per agent; it is now keyed by turn.
  for (const [agent, entry] of Object.entries(state.pending ?? {})) {
    if (entry && typeof entry === 'object' && typeof entry.turnKey === 'string') {
      state.pending[agent] = { [entry.turnKey]: { event: entry.event, costDelta: entry.costDelta, firstTs: entry.firstTs } };
    }
  }
  return { state, found };
}

function costStateKey(event) {
  return [event.agent, event.session_id ?? event.project_id ?? 'no-session'].join('|');
}

// A running total is only meaningful against the session it belongs to. Without
// a session id every session of one agent shares the `no-session` bucket, so two
// running side by side interleave their totals: each reads as the other
// restarting its counter, and the diff then spans both. Measured on four
// readings from two sessions, that reported 9 where the truth was 4, silently,
// with the status line rendering the wrong figure as confidently as the right
// one.
//
// `project_id` is no better a discriminator - one project runs many sessions at
// once - so it is not accepted here either, though `costStateKey` still falls
// back to it for the caches that are keyed per model rather than per turn.
//
// A cumulative record with no session identity is therefore not diffed at all.
// The turn loses its delta, exactly as the first snapshot of any session does,
// rather than gaining one that was never spent. The count is kept so the
// condition is observable instead of silent; `doctor` reports it.
function cumulativeKey(event, state) {
  if (event.session_id) return costStateKey(event);
  state.counters.unkeyed = (state.counters.unkeyed ?? 0) + 1;
  return undefined;
}

function cacheStateKey(event) {
  return [event.agent, event.session_id ?? 'no-session', event.model ?? 'no-model'].join('|');
}

function eventCostAmount(event) {
  return event.cost?.delta_usd ?? event.cost?.amount_usd;
}

function isSample(event) {
  return event.usage?.basis === 'sample';
}

// Subagent lifecycle events carry no tokens or cost of their own, so per-subagent
// spend is not recoverable. What is measurable is the provider's cumulative-cost
// movement while at least one subagent was running. Nested and parallel subagents
// share one window, so this is co-occurring cost, not per-subagent attribution.
export function subagentWindowKey(agent, sessionId) {
  return [agent, sessionId ?? 'no-session'].join('|');
}

function trackSubagentWindow(event, state) {
  if (event.kind !== 'subagent') return;
  const agent = event.agent;
  // Several Claude Code sessions share one state file, so this is keyed by
  // session as well as agent. Keyed by agent alone, whichever session acted last
  // overwrote the others and every session reported the wrong tally.
  const key = subagentWindowKey(agent, event.session_id);
  const window = state.subagentWindows[key]
    ?? { active: 0, startCumulative: null, accumulatedUsd: 0, completed: 0, session: event.session_id ?? null };
  // Whatever this provider meters in. Copilot reports no currency, so the window
  // that shows what subagents cost would otherwise stay dark for it while the
  // count beside it is reported perfectly well.
  const costKey = costStateKey(event);
  const cumulative = state.cumulativeCosts[costKey];
  const cumulativeUnits = state.cumulativeBilling?.[costKey]?.aiu;
  const meteredInUnits = !Number.isFinite(cumulative) && Number.isFinite(cumulativeUnits);
  const closing = /stop|end|complete/i.test(event.event_name ?? '');
  // A stop that arrives with nothing running did not close a subagent. Claude
  // Code emits SubagentStop far more often than it emits SubagentStart — 29
  // stops against 3 starts in one measured session, where the transcript held
  // exactly 3 Agent calls — so counting stops alone inflated the tally roughly
  // tenfold. Starts are the signal that matches reality; a stop is only believed
  // while a start is outstanding.
  if (closing && window.active === 0) {
    state.subagentWindows[key] = window;
    return;
  }
  if (closing) {
    // Counted here rather than by scanning the recent ring, which is a capped
    // sliding window and silently drops older subagents as newer turns arrive.
    window.completed = (window.completed ?? 0) + 1;
    window.active = Math.max(0, window.active - 1);
    if (window.active === 0 && Number.isFinite(window.startCumulative)) {
      if (meteredInUnits) {
        window.accumulatedUnits = Number(((window.accumulatedUnits ?? 0)
          + Math.max(0, cumulativeUnits - window.startCumulative)).toFixed(6));
        window.unit = 'aiu';
      } else if (Number.isFinite(cumulative)) {
        window.accumulatedUsd = Number((window.accumulatedUsd + Math.max(0, cumulative - window.startCumulative)).toFixed(12));
      }
      window.startCumulative = null;
    }
  } else {
    if (window.active === 0) {
      const opening = meteredInUnits ? cumulativeUnits : cumulative;
      window.startCumulative = Number.isFinite(opening) ? opening : null;
    }
    window.active += 1;
  }
  state.subagentWindows[key] = window;
}

// Without a provider turn id a turn is numbered by the session's own prompt
// counter: `seq:0` before any prompt hook, `seq:N` for everything after the Nth.
// A local counter, never derived from the payload, and kept in state only: the
// ledger carries no synthetic id, because analysis re-derives the same turns
// from the prompt hooks when it reads (src/aggregate.mjs, promptSegments), which
// also corrects a ledger written before this rule. The status line reads these
// keys to count a reply as the prompt and every call behind it.
function turnKeyFor(event, state) {
  const seq = state.turnSeq?.[event.agent] ?? 0;
  const turn = event.turn_id ?? `seq:${seq}`;
  return [event.agent, event.session_id ?? 'no-session', turn].join('|');
}

function recentSummary(event, turnKey) {
  return {
    turn_key: turnKey,
    ts: event.ts,
    agent: event.agent,
    kind: event.kind,
    source: event.source,
    event_name: event.event_name,
    session_id: event.session_id,
    turn_id: event.turn_id,
    model: event.model,
    project_id: event.project_id,
    usage: event.usage,
    cost: event.cost,
    billing: event.billing,
    billing_cumulative: event.billing_cumulative,
    context: event.context,
    cache: event.cache,
    metrics: event.metrics,
    subagent_type: event.subagent_type,
    status: event.status
  };
}

function applyCumulativeCost(event, state) {
  if (!event.flags?.cost_cumulative || event.cost?.cumulative_usd === undefined) return;
  const key = cumulativeKey(event, state);
  if (!key) return;
  const current = event.cost.cumulative_usd;
  const previous = state.cumulativeCosts[key];
  if (Number.isFinite(previous) && current >= previous) {
    const delta = current - previous;
    if (delta >= 0) event.cost.delta_usd = Number(delta.toFixed(12));
  } else if (Number.isFinite(previous) && current < previous) {
    // The provider restarted its counter mid-session, so anything accumulated
    // against the old basis no longer divides into the new total.
    const window = state.subagentWindows?.[subagentWindowKey(event.agent, event.session_id)];
    if (window) Object.assign(window, { active: 0, startCumulative: null, accumulatedUsd: 0 });
  }
  state.cumulativeCosts[key] = current;
}

// Copilot CLI reports session-cumulative token counters rather than the per-call
// gauge Claude sends, so the movement between two renders is the call that
// happened between them. This is the token twin of applyCumulativeCost, and it
// is what makes these counts summable: adding a running total to a period would
// count the whole session once per render.
function applyCumulativeUsage(event, state) {
  if (!event.flags?.usage_cumulative || !event.usage_cumulative) return;
  const key = cumulativeKey(event, state);
  if (!key) return;
  const current = event.usage_cumulative;
  const previous = state.cumulativeUsage[key];
  state.cumulativeUsage[key] = current;
  const delta = diffCumulativeUsage(previous, current);
  if (delta) event.usage = cleanUsage({ ...delta, semantics: 'cached_subset', basis: 'increment' });
}

// What one running-total snapshot adds to the previous one, or undefined when
// it adds nothing a ledger should record. Pure, so the live store and a history
// import (which keeps its baselines in memory, never in a state file) share one
// rule (intent 06, D2).
export function diffCumulativeUsage(previous, current) {
  // The first snapshot of a session is a baseline, not a charge - the same rule
  // cumulative cost follows.
  if (!previous || typeof previous !== 'object' || !current || typeof current !== 'object') return undefined;
  // A counter that went backwards means the provider restarted it; the old
  // basis no longer divides into the new total.
  const keys = ['input_total', 'cache_read', 'cache_write', 'output', 'reasoning'];
  if (keys.some((name) => (current[name] ?? 0) < (previous[name] ?? 0))) return undefined;
  const delta = {};
  for (const name of keys) {
    const moved = (current[name] ?? 0) - (previous[name] ?? 0);
    if (moved > 0) delta[name] = moved;
  }
  if (!Object.keys(delta).length) return undefined;
  // Copilot's input total contains both cache halves, so fresh input is what is
  // left after each of them.
  if (delta.input_total !== undefined) {
    delta.input_fresh = Math.max(0, delta.input_total - (delta.cache_read ?? 0) - (delta.cache_write ?? 0));
  }
  return delta;
}

// The same baseline-and-diff rule as cost and tokens, for providers that bill in
// something that is not currency.
function applyCumulativeBilling(event, state) {
  if (!event.flags?.billing_cumulative || !event.billing_cumulative) return;
  const key = cumulativeKey(event, state);
  if (!key) return;
  const current = event.billing_cumulative;
  const previous = state.cumulativeBilling[key];
  state.cumulativeBilling[key] = current;
  if (!previous || typeof previous !== 'object') return;
  const delta = {};
  for (const [unit, value] of Object.entries(current)) {
    const before = previous[unit];
    if (!Number.isFinite(before) || !Number.isFinite(value) || value < before) continue;
    const moved = Number((value - before).toFixed(6));
    if (moved > 0) delta[unit] = moved;
  }
  if (Object.keys(delta).length) event.billing = delta;
}

function addUnits(before, moved) {
  if (!before) return moved;
  if (!moved) return before;
  const total = { ...before };
  for (const [unit, value] of Object.entries(moved)) {
    if (Number.isFinite(value)) total[unit] = Number(((total[unit] ?? 0) + value).toFixed(6));
  }
  return total;
}

function applyPricing(event, config) {
  if (event.cost?.amount_usd !== undefined || event.cost?.delta_usd !== undefined) return;
  if (!config.pricingFile) return;
  const pricing = loadPricing(config.pricingFile);
  const estimate = estimateEventCost(event, pricing);
  if (estimate?.complete) {
    event.cost = {
      amount_usd: Number(estimate.amount_usd.toFixed(12)),
      basis: estimate.basis,
      currency: estimate.currency,
      price_version: estimate.price_version
    };
  }
}

// Record that caching happened, but never invent cache metadata. A configured
// TTL is a local assumption; presenting it as an observation is what produced
// the fabricated "cache warm" readings this reducer is meant to avoid.
function applyCache(event, state) {
  const cacheTokens = (event.usage?.cache_read ?? 0) + (event.usage?.cache_write ?? 0);
  if (!cacheTokens) return;
  state.cacheActivity[cacheStateKey(event)] = event.ts;
}

// The one writer for imported history. It appends rows and touches nothing
// else: no session state file, no fingerprint window, no pending turn, because
// historical rows must not disturb the live reduction (intent 06, D2). Every row
// is checked before any is written, so a bad row writes nothing. A write that
// fails part-way throws with `written`, the whole rows already appended; a
// short write counts as a failure, and its fragment is ended with a newline
// where the disk allows, so the next append starts a line of its own (D26, D27).
// The guard every imported row passes before the ledger is opened. The import
// runs it before it records its plan as well, so a row the guard refuses never
// leaves a run record behind that claims rows (#14).
export function assertImportedRows(rows) {
  for (const row of rows) {
    if (row?.source !== 'import' || !row.import?.run_id) throw new Error('appendImportedEvents writes imported rows only.');
    assertPrivacySafe(row);
  }
}

export function appendImportedEvents(rows, config) {
  assertImportedRows(rows);
  if (!rows.length) return { written: 0 };
  ensureDir(path.dirname(config.dataFile));
  let written = 0;
  let fd;
  try {
    fd = fs.openSync(config.dataFile, 'a', 0o600);
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      if (fs.writeSync(fd, line, null, 'utf8') !== Buffer.byteLength(line)) {
        try { fs.writeSync(fd, '\n', null, 'utf8'); } catch {}
        throw Object.assign(new Error('the ledger took only part of a row'), { code: 'ESHORTWRITE' });
      }
      written += 1;
    }
    const open = fd;
    fd = undefined;
    fs.closeSync(open);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    error.written = written;
    throw error;
  }
  try { fs.chmodSync(config.dataFile, 0o600); } catch {}
  return { written };
}

function appendToLedger(event, config) {
  ensureDir(path.dirname(config.dataFile));
  const line = `${JSON.stringify(event)}\n`;
  const fd = fs.openSync(config.dataFile, 'a', 0o600);
  try { fs.writeSync(fd, line, null, 'utf8'); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(config.dataFile, 0o600); } catch {}
}

// The single decision about what flushing a pending turn writes. Both the
// durable flush and the read-only view of an unflushed turn go through here, so
// what a report shows from pending state is, by construction, the record a
// flush would have appended - never a second rendering of it that could drift.
//
// The event was checked by `storeEvent` on the way in, but it has since been
// serialised to the per-session state file and read back, so nothing in this
// process saw what actually came off disk. The guard is cheap and the ledger is
// the durable artefact, so it is re-run here rather than assumed. A failure
// drops the turn instead of writing it, matching the rule everywhere else: an
// event that cannot be shown to be safe is not recorded, and not shown either.
function flushableEvent(pending) {
  if (!pending?.event) return { event: undefined, unsafe: false };
  try {
    assertPrivacySafe(pending.event);
  } catch {
    return { event: undefined, unsafe: true };
  }
  return { event: pending.event, unsafe: false };
}

// Moves a pending turn onto `ledger`, a list of rows the caller appends once the
// whole reduction is done. Appending here, mid-reduction, meant a write that
// failed half-way left the state and the ledger disagreeing about which turns
// were durable; collecting first lets a caller that cannot write keep the list
// in memory instead.
function flushTurn(agent, turnKey, state, ledger) {
  const pending = state.pending?.[agent]?.[turnKey];
  const { event, unsafe } = flushableEvent(pending);
  if (unsafe) {
    state.counters.errors = (state.counters.errors ?? 0) + 1;
    delete state.pending[agent][turnKey];
    return false;
  }
  if (!event) return false;
  ledger.push(event);
  state.counters.written = (state.counters.written ?? 0) + 1;
  delete state.pending[agent][turnKey];
  return true;
}

function flushAgent(agent, state, ledger) {
  let flushed = 0;
  for (const turnKey of Object.keys(state.pending?.[agent] ?? {})) {
    if (flushTurn(agent, turnKey, state, ledger)) flushed += 1;
  }
  return flushed;
}

// Several turns can be open at once when prompt identifiers interleave. Holding
// one slot per agent meant any change of turn flushed the other, splitting a
// single exchange across many records, so each turn now accumulates in its own
// slot and is only written out at a real boundary.
function reapPending(agent, state, ledger) {
  const open = state.pending?.[agent];
  if (!open) return;
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  for (const [turnKey, entry] of Object.entries(open)) {
    if (entry?.firstTs && new Date(entry.firstTs).getTime() < cutoff) flushTurn(agent, turnKey, state, ledger);
  }
  const keys = Object.keys(open);
  if (keys.length > MAX_PENDING_TURNS) {
    const oldest = keys
      .sort((a, b) => new Date(open[a]?.firstTs ?? 0) - new Date(open[b]?.firstTs ?? 0))
      .slice(0, keys.length - MAX_PENDING_TURNS);
    for (const turnKey of oldest) flushTurn(agent, turnKey, state, ledger);
  }
}

function updateState(event, state, turnKey, { replaceLast = false } = {}) {
  const agent = event.agent;
  const summary = recentSummary(event, turnKey);
  state.latest[agent] = summary;
  const list = state.recent[agent] ?? [];
  // Collapse consecutive refreshes of one turn, but only onto another sample.
  // Lifecycle and subagent entries share a turn key with the samples around them,
  // and overwriting those would erase them from the live snapshot.
  if (replaceLast) {
    const index = list.findLastIndex((entry) => entry.turn_key === turnKey && entry.usage?.basis === 'sample');
    if (index !== -1) list.splice(index, 1);
  }
  list.push(summary);
  state.recent[agent] = list.slice(-RECENT_LIMIT);
  if (event.fingerprint) {
    state.recentFingerprints.push(event.fingerprint);
    state.recentFingerprints = state.recentFingerprints.slice(-FINGERPRINT_LIMIT);
  }
}

// The status line shows a reply - a prompt and every call behind it - and used
// to rebuild it from the live ring, which keeps only the newest RECENT_LIMIT
// entries of the session: idle renders and tool hooks take slots too, so a long
// Copilot reply lost its oldest calls (0.66 AIU shown for 1.20), and a report
// that flushed a held Claude reply mid-way left only the renders after it. Each
// reply a prompt hook opens now keeps a running total in state instead, the way
// `pending` keeps `costDelta` for the ledger row: its calls, its billing units
// and its cost, added from each event's own per-call amounts. A reply that mixes
// provider figures and estimates is marked `mixed` rather than added across.
// `replyTotals` is absent from state written before it; the status line then
// sums the ring as before.
function openReplyTotal(state, agent, turnKey, event) {
  state.replyTotals ??= {};
  const totals = (state.replyTotals[agent] ??= {});
  if (totals[turnKey]) return;
  totals[turnKey] = { session_id: event.session_id, turn_id: event.turn_id, ts: event.ts, calls: 0 };
  const keys = Object.keys(totals);
  for (const key of keys.slice(0, Math.max(0, keys.length - REPLY_TOTAL_LIMIT))) delete totals[key];
}

function addToReplyTotal(state, agent, turnKey, event) {
  const total = state.replyTotals?.[agent]?.[turnKey];
  if (!total) return;
  const cost = eventCostAmount(event);
  if (!event.usage && !event.billing && cost === undefined) return;
  total.calls += 1;
  total.ts = event.ts;
  if (event.billing) total.billing = addUnits(total.billing, event.billing);
  if (Number.isFinite(cost)) {
    total.cost ??= { basis: event.cost.basis, delta_usd: 0 };
    // Provider figures and estimates are never added together; such a reply
    // shows its newest call's cost, as the ring's sum always did.
    if (event.cost.basis !== total.cost.basis) total.mixed = true;
    else total.cost.delta_usd = Number((total.cost.delta_usd + cost).toFixed(12));
  }
}

// Folds one event into `state` and collects, in `ledger`, the rows that storing
// it makes durable. Nothing here touches the disk, which is what lets the same
// reduction serve a real store and a read-only preview of one.
function reduceEvent(inputEvent, config, state, ledger) {
  const event = structuredClone(inputEvent);
  assertPrivacySafe(event);
  if (event.fingerprint && state.recentFingerprints.includes(event.fingerprint)) {
    state.counters.duplicates = (state.counters.duplicates ?? 0) + 1;
    return { stored: false, duplicate: true, event: null };
  }
  applyCumulativeCost(event, state);
  applyCumulativeUsage(event, state);
  applyCumulativeBilling(event, state);
  applyPricing(event, config);
  applyCache(event, state);
  trackSubagentWindow(event, state);
  assertPrivacySafe(event);

  const agent = event.agent;
  state.pending[agent] ??= {};
  reapPending(agent, state, ledger);
  if (TURN_OPENING_EVENTS.has(event.event_name)) {
    // A new prompt means every exchange opened before it has finished.
    flushAgent(agent, state, ledger);
    state.turnSeq[agent] = (state.turnSeq[agent] ?? 0) + 1;
  }

  const turnKey = turnKeyFor(event, state);
  let stored = true;
  // Before the held-sample branch below replaces this render's cost and units
  // with the accumulated ones.
  if (TURN_OPENING_EVENTS.has(event.event_name)) openReplyTotal(state, agent, turnKey, event);
  addToReplyTotal(state, agent, turnKey, event);

  if (isSample(event)) {
    // Gauge samples are re-reported on every refresh. Hold the newest one for its
    // own turn and write a single durable record when that turn ends, so the
    // ledger carries one row per turn instead of one per render.
    const open = state.pending[agent][turnKey];
    const accumulated = Number(((open?.costDelta ?? 0) + (event.cost?.delta_usd ?? 0)).toFixed(12));
    if (event.cost && accumulated > 0) event.cost.delta_usd = accumulated;
    // Billing units are per-render deltas like cost, so they accumulate across
    // the held renders too. Keeping only the newest render's units lost every
    // earlier movement of the same reply when it was written.
    const units = addUnits(open?.event?.billing, event.billing);
    if (units) event.billing = units;
    state.pending[agent][turnKey] = { event, costDelta: accumulated, firstTs: open?.firstTs ?? event.ts };
    if (open) state.counters.collapsed = (state.counters.collapsed ?? 0) + 1;
    updateState(event, state, turnKey, { replaceLast: true });
    stored = false;
  } else {
    ledger.push(event);
    state.counters.written = (state.counters.written ?? 0) + 1;
    updateState(event, state, turnKey);
    if (SESSION_CLOSING_EVENTS.has(event.event_name)) flushAgent(agent, state, ledger);
  }
  return { stored, duplicate: false, pending: !stored, event };
}

// The read, the reduction, the ledger rows it makes durable and the rewrite of
// the state file all happen under the session's lock (`src/state-lock.mjs`), so
// two hooks of one session in the same instant are applied one after the
// other instead of the second erasing the first.
//
// Telemetry must not break the session it watches, so a lock another process
// holds past the budget does not stop this event: it is stored as it always
// was, without the lock, and `counters.unlocked_writes` records that it was.
// The ledger row is appended either way; the ledger is the source of truth,
// and the worst an unlocked write can do is what every write did before the
// lock existed - lose one update to the live state if another write overlaps
// it. Skipping the state update instead would lose this event's contribution
// every time rather than only on an actual overlap. `doctor` reports the count.
export function storeEvent(inputEvent, config, { lock: lockOptions } = {}) {
  const stateFile = sessionStateFile(config, inputEvent?.session_id);
  return withStateLock(stateFile, (lock) => {
    const state = loadState(config, inputEvent?.session_id);
    const ledger = [];
    const result = reduceEvent(inputEvent, config, state, ledger);
    const unlocked = lock.reason === 'timeout';
    if (unlocked) state.counters.unlocked_writes = (state.counters.unlocked_writes ?? 0) + 1;
    for (const row of ledger) appendToLedger(row, config);
    atomicWriteJson(stateFile, state);
    return unlocked ? { ...result, unlocked: true } : result;
  }, lockOptions);
}

// What storing `events` would leave in a session's state, computed in memory and
// written nowhere. `status` renders from this when the data directory refuses
// the write, so the reading on screen is the one it was just handed rather than
// whatever the last writable run saved.
export function previewSessionState(events, config, sessionId) {
  const target = sessionStateFile(config, sessionId);
  const states = new Map();
  for (const event of events) {
    const file = sessionStateFile(config, event.session_id);
    if (!states.has(file)) states.set(file, loadState(config, event.session_id));
    reduceEvent(event, config, states.get(file), []);
  }
  return states.get(target) ?? loadState(config, sessionId);
}

// Proves a state file could be replaced before any of its turns are appended to
// the ledger. Without this, a ledger that accepts the append beside a state
// directory that refuses the rewrite - `TOKENWATCH_DATA` pointed somewhere
// writable, say - would append the turn, fail to record that it had, and append
// it again on every later report. Creating and removing a file beside the state
// file is exactly the permission the atomic rewrite needs, and touches nothing
// another writer could be relying on.
function assertStateReplaceable(file) {
  const probe = path.join(path.dirname(file), `.tokenwatch-probe-${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  fs.unlinkSync(probe);
}

// One session state file with its pending turns moved onto `ledger`, in memory:
// the rows a flush of that file would append, and the state it would save.
function pendingFlushOf(file) {
  const state = { ...blankState(), ...(readJson(file, null) ?? blankState()) };
  const ledger = [];
  for (const agent of Object.keys(state.pending ?? {})) flushAgent(agent, state, ledger);
  return { state, ledger };
}

// The rows `tryFlushPendingTurns` would append now, computed and written
// nowhere, for a preview that must not change the ledger it describes.
export function pendingTurnRows(config) {
  return listSessionStateFiles(config).flatMap((file) => pendingFlushOf(file).ledger);
}

// Durable-write any turn still being sampled. Reports read the ledger, so this
// has to run before them or the in-flight turn is invisible.
//
// It is an optimisation, never a precondition. When the data directory can be
// read but not written - Codex's default sandbox, a read-only mount - the turns
// that could not be flushed come back in `unflushed`, exactly the rows a flush
// would have appended, for the caller to include in memory. `refused` carries
// the error code so the report can say which of the two happened. Any error that
// is not a refused write is still thrown: only that one class degrades.
//
// Each file is flushed under its session's lock, and read again once the lock is
// held: a hook of that session may have flushed or changed the same turns in
// the meantime. When the lock stays busy past its budget the file's turns are
// not flushed - two flushers appending one pending turn would put it in the
// ledger twice, for good - and they come back in `unflushed` like a refused
// write's, counted in `busy`, for the next report to flush.
export function tryFlushPendingTurns(config, { lock: lockOptions } = {}) {
  const result = { flushed: 0, unflushed: [], refused: undefined, busy: 0 };
  for (const file of listSessionStateFiles(config)) {
    // Most files have nothing pending; they are not worth taking a lock for.
    if (!pendingFlushOf(file).ledger.length) continue;
    // Once one write has been refused the rest would be too; asking again per
    // file only multiplies the failures.
    if (result.refused) { result.unflushed.push(...pendingFlushOf(file).ledger); continue; }
    withStateLock(file, (lock) => {
      const { state, ledger } = pendingFlushOf(file);
      if (!ledger.length) return;
      if (lock.reason === 'timeout') {
        result.busy += 1;
        result.unflushed.push(...ledger);
        return;
      }
      try {
        assertStateReplaceable(file);
        for (const row of ledger) appendToLedger(row, config);
      } catch (error) {
        if (!isWriteRefused(error)) throw error;
        result.refused = { code: error.code, error };
        result.unflushed.push(...ledger);
        return;
      }
      atomicWriteJson(file, state);
      result.flushed += ledger.length;
    }, lockOptions);
  }
  return result;
}

// The strict form, for callers that must know the ledger is complete: a refused
// write is an error here, as it always was.
export function flushPendingTurns(config) {
  const result = tryFlushPendingTurns(config);
  if (result.refused) throw result.refused.error;
  return result.flushed;
}

// `options.lock` is passed to every `storeEvent`: a status render waits less
// for its session's lock than a hook does (`STATUS_LOCK_BUDGET_MS`).
export function storeEvents(events, config, options = {}) {
  const results = [];
  for (const event of events) results.push(storeEvent(event, config, options));
  return results;
}

// One filter for the ledger and for turns held in memory, so a report scoped
// with `--since` or `--agent` scopes both the same way.
function eventFilter({ since, until, agents, projectId } = {}) {
  const sinceMs = since ? new Date(since).getTime() : -Infinity;
  const untilMs = until ? new Date(until).getTime() : Infinity;
  const agentSet = agents?.length ? new Set(agents) : null;
  return (event) => {
    const time = new Date(event.ts).getTime();
    if (time < sinceMs || time > untilMs) return false;
    if (agentSet && !agentSet.has(event.agent) && !agentSet.has(event.agent?.replace('-cli', ''))) return false;
    if (projectId && event.project_id !== projectId) return false;
    return true;
  };
}

export async function* readEvents(config, filter = {}) {
  if (!fs.existsSync(config.dataFile)) return;
  const matches = eventFilter(filter);
  const stream = fs.createReadStream(config.dataFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (matches(event)) yield event;
  }
}

// `pending` is what `tryFlushPendingTurns` could not write. Those rows go after
// the ledger's, which is where a successful flush would have appended them, so a
// report reads the same whether or not the flush was allowed to happen.
// One whose row is already in the ledger is not added again: a flush
// that found its session busy read that turn from state while the process
// holding the lock had already appended it and not yet rewritten the state, and
// counting it from both would count it twice. A flushed turn is the pending
// event itself (`flushableEvent`), so its `event_id` identifies it exactly.
export async function collectEvents(config, filter = {}, { pending = [] } = {}) {
  const events = [];
  for await (const event of readEvents(config, filter)) events.push(event);
  const matches = eventFilter(filter);
  const recorded = pending.length ? new Set(events.map((event) => event.event_id)) : undefined;
  for (const event of pending) if (matches(event) && !recorded.has(event.event_id)) events.push(event);
  return events;
}

export async function pruneEvents(config, cutoff) {
  if (!fs.existsSync(config.dataFile)) return { kept: 0, removed: 0 };
  const cutoffMs = new Date(cutoff).getTime();
  const keptLines = [];
  let kept = 0;
  let removed = 0;
  const stream = fs.createReadStream(config.dataFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (new Date(event.ts).getTime() >= cutoffMs) {
        keptLines.push(JSON.stringify(event));
        kept += 1;
      } else removed += 1;
    } catch { removed += 1; }
  }
  writeTextAtomic(config.dataFile, keptLines.length ? `${keptLines.join('\n')}\n` : '');
  return { kept, removed };
}

// Without an ingested payload there is no session to render, so fall back to
// whichever session wrote most recently. One installation serves every agent, so
// the most recent session is frequently a different agent's: asked for Copilot
// while a Claude session is the one writing, an agent-blind fallback renders
// "no local usage yet" over a session full of data. Prefer the newest session
// that holds events for the agent being asked about.
const SESSION_SCAN_LIMIT = 40;

export function mostRecentSession(config, agentName) {
  const files = listSessionStateFiles(config)
    .map((file) => { try { return { file, at: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  if (!agentName) return files[0]?.file;
  // File mtime is the wrong ranking: a state file can be newer yet hold nothing
  // but a stale, usage-less event for this agent, which renders as though the
  // agent had never run. Rank by that agent's own newest activity, preferring a
  // session that has something to show.
  let best;
  for (const { file } of files.slice(0, SESSION_SCAN_LIMIT)) {
    const rows = readJson(file, null)?.recent?.[agentName];
    if (!Array.isArray(rows) || !rows.length) continue;
    const renderable = rows.filter((row) => row.usage || row.cost || row.billing);
    const newest = renderable.at(-1) ?? rows.at(-1);
    const candidate = { file, showable: renderable.length > 0, at: Date.parse(newest?.ts ?? '') || 0 };
    if (!best || candidate.showable > best.showable
      || (candidate.showable === best.showable && candidate.at > best.at)) best = candidate;
  }
  return best?.file ?? files[0]?.file;
}

// Which session a status render will describe, and on what grounds (intent 15).
// `requested`: the caller named it. `most_recent_fallback`: nobody did, so it is
// whichever session last wrote renderable rows for this agent - possibly not the
// caller's. `unknown`: no session file at all. `found` says whether that
// session's state exists, so "no data" is never shown as "cost nothing". Every
// resolution carries the `state` it read beside `found`, so the two always
// describe one read (D13, D21).
export function resolveStatusSession(config, { sessionId, agentName } = {}) {
  if (sessionId) {
    const { state, found } = loadSessionState(config, sessionId);
    return { sessionId, resolution: 'requested', file: sessionStateFile(config, sessionId), found, state };
  }
  const file = mostRecentSession(config, agentName);
  if (file) {
    const raw = readJson(file, null);
    return { sessionId: undefined, resolution: 'most_recent_fallback', file, found: Boolean(raw), state: { ...blankState(), ...(raw ?? blankState()) } };
  }
  return { sessionId: undefined, resolution: 'unknown', file: config.stateFile, ...loadSessionState(config) };
}

export function statusState(config, sessionId, agentName) {
  if (sessionId) return loadState(config, sessionId);
  return resolveStatusSession(config, { agentName }).state;
}

// What a status render shows when there is nothing it may honestly show: a
// rejected --session or a resolution that failed (intent 15, D1 and D12).
export function emptyStatusState() {
  return blankState();
}

export function effectiveEventCost(event) {
  return eventCostAmount(event);
}
