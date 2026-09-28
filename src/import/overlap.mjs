// Does the import agree with what live capture recorded for the same sessions?
// The answer is numbers, not a verdict: every compared field is listed when it
// differs (intent 06, D5). Rows here are the import's in-memory rows and the
// live ledger rows of one agent, both already limited to the same window.

const SUM_FIELDS = ['input_total', 'cache_read', 'cache_write', 'output'];
const MAX_LISTED = 50;

const byTs = (a, b) => a.ts.localeCompare(b.ts);

function groupBySession(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!row.session_id) continue;
    if (!out.has(row.session_id)) out.set(row.session_id, []);
    out.get(row.session_id).push(row);
  }
  for (const list of out.values()) list.sort(byTs);
  return out;
}

function sums(rows, fields) {
  const out = {};
  for (const row of rows) {
    for (const field of fields) {
      const value = row.usage?.[field];
      if (Number.isFinite(value)) out[field] = (out[field] ?? 0) + value;
    }
  }
  return out;
}

// Claude: each live turn is one collapsed status-line sample, the usage of the
// last model call as the status line last saw it. That call is found by its
// input figures anywhere in the session up to the next live turn:
// - the transcript stamps a call's line when the message completes, which can
//   be after the last render;
// - a turn that begins before its first call completes re-shows the previous
//   call.
// The gauge may have caught the call mid-stream, so its output can only be
// behind the final figure, never ahead. A turn whose figures no call has is
// compared with the latest call before it (or skipped when no call precedes
// it), and its differences reported. One call may stand for several live
// turns: that is the re-shown call, and it is intended. A
// gauge of zeros (a render before any call, as after /clear) describes no call
// and is not compared (D5, FR-18, amended by D28 from the live test).
const INPUT_FIELDS = ['input_total', 'cache_read', 'cache_write'];
const TURN_FIELDS = [...INPUT_FIELDS, 'output'];

function lastCallPerTurn(liveRows, importedRows, report) {
  const turns = liveRows.filter((row) => row.usage?.basis === 'sample');
  if (!turns.length) return false;
  let compared = false;
  turns.forEach((turn, index) => {
    if (!TURN_FIELDS.some((field) => turn.usage[field] > 0)) return;
    const to = turns[index + 1]?.ts;
    const reachable = importedRows.filter((row) => to === undefined || row.ts <= to);
    const sameInput = reachable.filter((row) => INPUT_FIELDS.every((field) => !Number.isFinite(turn.usage[field]) || (row.usage?.[field] ?? 0) === turn.usage[field]));
    const call = sameInput.at(-1) ?? reachable.filter((row) => row.ts <= turn.ts).at(-1);
    if (!call) return;
    compared = true;
    report.turns_compared += 1;
    const boundary = index === 0 || index === turns.length - 1;
    let same = true;
    for (const field of TURN_FIELDS) {
      const live = turn.usage[field];
      const imported = call.usage?.[field] ?? 0;
      if (!Number.isFinite(live)) continue;
      if (field === 'output' ? live <= imported : live === imported) continue;
      same = false;
      report.mismatch(turn.session_id, turn.ts, field, live, imported, boundary);
    }
    if (same) report.matched += 1;
  });
  return compared;
}

// Codex and Copilot: the session's imported total against live capture's. The
// live total is the session's last running-total snapshot where it keeps one
// (Copilot), else the sum of its increments (Codex) (D5, D24).
function sessionSum(liveRows, importedRows, report) {
  const snapshots = liveRows.filter((row) => row.usage_cumulative);
  const increments = liveRows.filter((row) => row.usage?.basis === 'increment');
  if (!snapshots.length && !increments.length) {
    report.no_live_tokens += 1;
    return false;
  }
  const live = snapshots.length ? snapshots.at(-1).usage_cumulative : sums(increments, SUM_FIELDS);
  const imported = sums(importedRows, SUM_FIELDS);
  const last = (snapshots.length ? snapshots : increments).at(-1);
  report.turns_compared += 1;
  let same = true;
  for (const field of SUM_FIELDS) {
    if (!Number.isFinite(live[field])) continue;
    if (live[field] === (imported[field] ?? 0)) continue;
    same = false;
    report.mismatch(last.session_id, last.ts, field, live[field], imported[field] ?? 0, false);
  }
  if (same) report.matched += 1;
  return true;
}

export function overlapCheck(mapping, importedRows, liveEvents) {
  const live = groupBySession(liveEvents.filter((row) => row.source !== 'import'));
  const imported = groupBySession(importedRows);
  const mismatches = [];
  const report = {
    turns_compared: 0, matched: 0, no_live_tokens: 0,
    mismatch(sessionId, turnTs, field, liveValue, importedValue, boundary) {
      mismatches.push({ session_id: sessionId, turn_ts: turnTs, field, live: liveValue, imported: importedValue, boundary });
    }
  };
  let sessionsCompared = 0;
  let sessionsOverlapping = 0;
  for (const [sessionId, liveRows] of live) {
    const importedRowsOfSession = imported.get(sessionId);
    if (!importedRowsOfSession) continue;
    sessionsOverlapping += 1;
    const compared = mapping.overlap.compare === 'last_call_per_turn'
      ? lastCallPerTurn(liveRows, importedRowsOfSession, report)
      : sessionSum(liveRows, importedRowsOfSession, report);
    if (compared) sessionsCompared += 1;
  }
  const decisive = mismatches.filter((entry) => !entry.boundary).length;
  let reason;
  if (!sessionsCompared) reason = sessionsOverlapping && report.no_live_tokens === sessionsOverlapping ? 'no_live_tokens' : 'no_overlap';
  else if (decisive) reason = 'mismatch';
  return {
    verification: reason ? 'unverified' : 'verified',
    ...(reason ? { reason } : {}),
    sessions_overlapping: sessionsOverlapping,
    sessions_compared: sessionsCompared,
    turns_compared: report.turns_compared,
    matched: report.matched,
    mismatch_count: mismatches.length,
    boundary_mismatches: mismatches.length - decisive,
    // Per field, the non-boundary mismatches, counted before the list is cut:
    // a mapping that reads the wrong field shows up as one field that always
    // differs (intent 19, FR-10).
    by_field: Object.fromEntries(TURN_FIELDS.map((field) => [field, mismatches.filter((entry) => !entry.boundary && entry.field === field).length])),
    mismatches: mismatches.slice(0, MAX_LISTED)
  };
}
