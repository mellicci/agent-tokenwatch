import fs from 'node:fs';
import { collectEvents, listSessionStateFiles, subagentWindowKey } from './store.mjs';
import { atomicWriteJson, readJson, writeTextAtomic } from './fs-util.mjs';

// Before pending turns were keyed by turn, interleaved prompt identifiers made a
// single exchange flush repeatedly, leaving many partial records where one
// belongs. The fragments are non-overlapping increments, so merging them is
// lossless: sum the cost movement, keep the final gauge reading.
function mergeFragments(events) {
  const order = [];
  const groups = new Map();
  let merged = 0;

  for (const event of events) {
    const key = event.source === 'statusline' && event.turn_id
      ? ['turn', event.agent, event.session_id ?? '-', event.turn_id].join('|')
      : null;
    if (!key) { order.push({ standalone: event }); continue; }
    const existing = groups.get(key);
    if (!existing) {
      const row = { key, event: structuredClone(event) };
      groups.set(key, row);
      order.push(row);
      continue;
    }
    merged += 1;
    const target = existing.event;
    // Later record wins for everything that describes the latest call.
    target.ts = event.ts;
    if (event.usage) target.usage = event.usage;
    if (event.context) target.context = event.context;
    if (event.cache) target.cache = event.cache;
    if (event.metrics) target.metrics = event.metrics;
    if (event.model) target.model = event.model;
    const addition = event.cost?.delta_usd ?? 0;
    if (event.cost) {
      target.cost ??= { basis: event.cost.basis, currency: event.cost.currency };
      if (event.cost.cumulative_usd !== undefined) target.cost.cumulative_usd = event.cost.cumulative_usd;
      if (addition) {
        target.cost.delta_usd = Number(((target.cost.delta_usd ?? 0) + addition).toFixed(12));
      }
    }
  }
  return { events: order.map((row) => row.standalone ?? row.event), merged, turns: groups.size };
}

// The completed tally is maintained going forward, but state written before it
// existed - or clobbered by another session sharing this file - has nothing to
// show. Recount it from the ledger, which is the durable record.
// Replays the same start/stop pairing the live reducer uses, so a ledger written
// before stray stops were ignored is corrected to what the transcript shows.
function rebuildSubagentCounts(events, state) {
  const counts = new Map();
  const active = new Map();
  for (const event of events) {
    if (event.kind !== 'subagent') continue;
    const key = subagentWindowKey(event.agent, event.session_id);
    if (/stop|end|complete/i.test(event.event_name ?? '')) {
      // Unmatched stops are noise, not completions.
      if ((active.get(key) ?? 0) === 0) continue;
      active.set(key, active.get(key) - 1);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      active.set(key, (active.get(key) ?? 0) + 1);
    }
  }
  let corrected = 0;
  for (const [key, completed] of counts) {
    const window = state.subagentWindows[key]
      ?? { active: 0, startCumulative: null, accumulatedUsd: 0, completed: 0, session: key.split('|').slice(1).join('|') };
    if (window.completed !== completed) corrected += 1;
    window.completed = completed;
    state.subagentWindows[key] = window;
  }
  return corrected;
}

export async function repairLedger(config, { dryRun = false } = {}) {
  const events = await collectEvents(config, {});
  const before = events.length;
  const { events: repaired, merged, turns } = mergeFragments(events);
  const result = {
    file: config.dataFile,
    records_before: before,
    records_after: repaired.length,
    fragments_merged: merged,
    distinct_turns: turns,
    dry_run: dryRun
  };
  // Counters live in one file per session, so each is corrected against the
  // subset of the ledger that belongs to it.
  const states = listSessionStateFiles(config).map((file) => ({ file, state: readJson(file, null) }))
    .filter((entry) => entry.state);
  let corrected = 0;
  for (const entry of states) {
    entry.state.subagentWindows ??= {};
    corrected += rebuildSubagentCounts(repaired, entry.state);
  }
  result.subagent_counts_corrected = corrected;
  if (dryRun) return result;

  if (merged) {
    const backup = `${config.dataFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(config.dataFile, backup);
    writeTextAtomic(config.dataFile, repaired.map((event) => JSON.stringify(event)).join('\n') + '\n', 0o600);
    result.backup = backup;
  }
  if (corrected) for (const entry of states) atomicWriteJson(entry.file, entry.state);
  return result;
}
