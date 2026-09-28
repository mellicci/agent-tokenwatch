import crypto from 'node:crypto';
import fs from 'node:fs';
import { AGENT_NAMES } from '../constants.mjs';
import { isWriteRefused } from '../fs-util.mjs';
import { fingerprint, getPath } from '../normalize/common.mjs';
import { cleanUsage, makeEvent } from '../schema.mjs';
import { appendImportedEvents, assertImportedRows, diffCumulativeUsage, readEvents, sessionStateFile } from '../store.mjs';
import { applyMapping, readContext } from './apply.mjs';
import { bundledMapping, resolveMapping } from './override.mjs';
import { mappingPaths, writableParts } from './mapping.mjs';
import { overlapCheck } from './overlap.mjs';
import { shapeProbe } from './probe.mjs';
import { readSessionRecords } from './reader.mjs';
import { forgetImportRun, writeImportRun } from './runs.mjs';
import { describeSessionDir, listSessionFiles, resolveSessionDir } from './sessions.mjs';

// `tokenwatch import <agent>`: an agent's own session files, read through a
// closed mapping, become tokens-only ledger rows labelled as imported history
// (intent 06). Nothing is written by --check or --dry-run, by a run whose
// overlap check is unverified without --accept-unverified, or for a session
// live capture already recorded.

const SUMMARY_RESPONSE_ID = 'session-summary';

function positive(values) {
  return Object.entries(values ?? {}).some(([key, value]) => key !== 'semantics' && key !== 'basis' && value > 0);
}

// One pass over every file: the per-call rows keyed per response (last line
// wins, D3/FR-07) and, where the mapping has one, each session's summary.
function readFiles(files, mapping, { projectSalt, sinceIso }) {
  const counts = {};
  const tally = {
    records_matched: 0, records_with_usage: 0, rejected_identifiers: 0,
    unkeyed_responses: 0, responses_without_usage: 0, files_with_records: 0
  };
  // Which of the mapping's paths any line in the window carries: exact, where
  // the probe is capped at three files and 500 paths (intent 19, FR-07).
  let pending = mappingPaths(mapping);
  const present = new Set();
  const responses = new Map();
  const summaries = new Map();
  const baselines = new Map();
  const usageOf = (row) => {
    if (mapping.usage_mode === 'per_call') return row.usage;
    const previous = baselines.get(row.session_id);
    if (row.usage_cumulative) baselines.set(row.session_id, row.usage_cumulative);
    return diffCumulativeUsage(previous, row.usage_cumulative);
  };
  for (const file of files) {
    let context = {};
    let fileHasRecords = false;
    for (const line of readSessionRecords(file, counts)) {
      if (pending.length) {
        for (const dotted of pending) if (getPath(line, dotted) !== undefined) present.add(dotted);
        pending = pending.filter((dotted) => !present.has(dotted));
      }
      context = { ...context, ...readContext(line, mapping.context, { projectSalt }) };
      for (const [spec, target] of [[mapping.record, 'record'], [mapping.summary, 'summary']]) {
        if (!spec) continue;
        const row = applyMapping(line, spec, { context, projectSalt });
        if (!row) continue;
        tally.records_matched += 1;
        if (row.rejected) { tally.rejected_identifiers += 1; continue; }
        // Only rows the mapping can write count towards "the mapping fits"; a
        // summary kept only as a self-check does not (D22, D25).
        const writable = target === 'record' ? mapping.authority !== 'summary' : mapping.authority !== 'per_call';
        if (writable && (row.usage || row.usage_cumulative || row.billing)) {
          tally.records_with_usage += 1;
          fileHasRecords = true;
        }
        const usage = target === 'record' ? usageOf(row) : row.usage;
        if (row.ts < sinceIso) continue;
        const empty = !positive(usage) && !positive(row.billing);
        const entry = {
          ts: row.ts, session_id: row.session_id, model: row.model, project_id: row.project_id,
          usage: cleanUsage({ ...usage, semantics: mapping.semantics, basis: 'transcript' }),
          billing: row.billing
        };
        if (target === 'summary') {
          if (empty) tally.responses_without_usage += 1;
          else summaries.set(row.session_id, { ...entry, response_id: SUMMARY_RESPONSE_ID });
          continue;
        }
        let responseId = row.response_id;
        if (!responseId && !empty) {
          if (mapping.authority !== 'summary') tally.unkeyed_responses += 1;
          responseId = `unkeyed-${fingerprint([row.ts, row.model, entry.usage])}`;
        }
        // A response spans several lines; the last carries its final figures,
        // and a last line with none takes the response out (D23).
        const key = `${row.session_id}|${responseId}`;
        if (empty) {
          tally.responses_without_usage += 1;
          responses.delete(key);
        } else {
          responses.set(key, { ...entry, response_id: responseId });
        }
      }
    }
    if (fileHasRecords) tally.files_with_records += 1;
  }
  return { counts, tally, responses, summaries, present };
}

// Which rows a session contributes, by the mapping's `authority` (D8, FR-20),
// and each field's per-call sum minus the summary where both exist.
function chooseRows(mapping, responses, summaries) {
  const perSession = new Map();
  for (const row of responses.values()) {
    if (!perSession.has(row.session_id)) perSession.set(row.session_id, []);
    perSession.get(row.session_id).push(row);
  }
  const rows = [];
  const summaryDelta = [];
  let sessionsWithoutUsage = 0;
  for (const sessionId of new Set([...perSession.keys(), ...summaries.keys()])) {
    const calls = perSession.get(sessionId) ?? [];
    const summary = summaries.get(sessionId);
    if (calls.length && summary) {
      const delta = {};
      for (const field of ['input_total', 'cache_read', 'cache_write', 'output']) {
        const sum = calls.reduce((total, row) => total + (row.usage[field] ?? 0), 0);
        if (summary.usage[field] !== undefined) delta[field] = sum - summary.usage[field];
      }
      summaryDelta.push({ session_id: sessionId, ...delta });
    }
    if (mapping.authority === 'summary' || (mapping.authority === 'per_call_else_summary' && !calls.length)) {
      if (summary) rows.push(summary);
      else sessionsWithoutUsage += 1;
    } else {
      rows.push(...calls);
    }
  }
  return { rows, summaryDelta, sessionsWithoutUsage };
}

// One pass over the ledger (D3): the sessions live capture recorded, the
// responses an earlier import already wrote, and the live rows of the window
// for the overlap check.
async function ledgerIndex(config, agent, sinceIso) {
  const liveSessions = new Set();
  const importedKeys = new Set();
  const liveRows = [];
  for await (const event of readEvents(config, { agents: [AGENT_NAMES[agent]] })) {
    if (!event.session_id) continue;
    if (event.source === 'import') {
      importedKeys.add(`${event.session_id}|${event.turn_id}`);
      continue;
    }
    liveSessions.add(event.session_id);
    if (event.ts >= sinceIso) liveRows.push(event);
  }
  return { liveSessions, importedKeys, liveRows };
}

function hasStateFile(config, sessionId) {
  try { return fs.existsSync(sessionStateFile(config, sessionId)); } catch { return false; }
}

export async function runImport(config, {
  agent, since, dryRun = false, check = false, acceptUnverified = false, mappingFile, env = process.env, now = new Date()
}) {
  const sinceIso = since ?? new Date(0).toISOString();
  const dir = resolveSessionDir(agent, config, env);
  let isDir = false;
  try { isDir = Boolean(dir) && fs.statSync(dir).isDirectory(); } catch {}
  let mapping;
  let mappingOrigin;
  try {
    ({ mapping, origin: mappingOrigin } = resolveMapping({ agent, file: mappingFile, config }));
  } catch (error) {
    if (error.code !== 'MAPPING_INVALID') throw error;
    // A broken bundled mapping is a damaged install, not a repair to make: the
    // flag says so in the JSON a skill reads (third review, D13).
    const invalid = { status: 'mapping_invalid', exitCode: 1, message: error.message, errors: error.errors, mapping_origin: error.origin, mapping_path: error.path,
      ...(error.origin === 'bundled' ? { bundled_mapping_broken: true } : {}) };
    // Under --check an invalid mapping still yields the files' shape, read with
    // the bundled glob, so a repair has something to work from (FR-13). With no
    // directory there is nothing to read: that is the diagnosis, and the
    // mapping's own errors still ride beside it (#15).
    if (!check) return invalid;
    if (!isDir) return { ...invalid, dir, diagnosis: 'no_directory' };
    const shipped = bundledMapping(agent);
    if (shipped.error) return { ...invalid, dir, diagnosis: 'mapping_invalid', bundled_mapping_broken: true, message: `${invalid.message}; the bundled ${agent} mapping is broken too (${shipped.error.message}), so no probe was built` };
    const glob = shipped.mapping.file.glob;
    const files = listSessionFiles(dir, glob, { sinceMs: new Date(sinceIso).getTime() });
    return { ...invalid, dir, diagnosis: 'mapping_invalid', directory: describeSessionDir(dir, glob), probe: shapeProbe(files) };
  }
  if (!isDir) return { status: 'no_directory', exitCode: 1, dir, mapping_origin: mappingOrigin, ...(check ? { diagnosis: 'no_directory' } : {}) };

  const files = listSessionFiles(dir, mapping.file.glob, { sinceMs: new Date(sinceIso).getTime() });
  const read = readFiles(files, mapping, { projectSalt: config.projectSalt, sinceIso });
  const { counts, tally } = read;
  const probe = () => shapeProbe(files);
  // A mapping that selects nothing, or whose numbers resolve nowhere, no longer
  // fits the format (FR-37). A rejected record is not counted as carrying
  // usage, so one whose every session id is prose stops here too (FR-45, D22).
  // What --check reports about the fit, all counts and key paths (FR-07, FR-09).
  // A path missing only from a part the mapping never writes does not count.
  //
  // An agent may simply omit a number field (a zero cache write), so a missing
  // number path alone is not a broken mapping. What is: a missing selector,
  // timestamp or id path; a part none of whose number paths resolve; or a
  // missing number path on exactly the field the overlap check disagrees on.
  const diagnostics = () => {
    const all = mappingPaths(mapping);
    const has = (dotted) => read.present.has(dotted);
    const parts = writableParts(mapping);
    const specs = [
      ...(parts.includes('record') ? [mapping.record] : []),
      ...(parts.includes('summary') && mapping.summary ? [mapping.summary] : [])
    ];
    const essential = [];
    const missingTargets = [];
    for (const spec of specs) {
      for (const dotted of [...spec.select.map((predicate) => predicate.path), spec.ts, spec.session_id, spec.response_id]) {
        if (dotted && !has(dotted)) essential.push(dotted);
      }
      const numbers = ['usage', 'usage_cumulative', 'billing', 'billing_cumulative']
        .flatMap((key) => Object.entries(spec[key] ?? {}).map(([target, source]) => [target, source.path]));
      if (numbers.length && !numbers.some(([, dotted]) => has(dotted))) essential.push(...numbers.map(([, dotted]) => dotted));
      for (const [target, dotted] of numbers) if (!has(dotted)) missingTargets.push(target);
    }
    for (const entry of parts.includes('context') ? mapping.context ?? [] : []) {
      for (const predicate of entry.select) if (!has(predicate.path)) essential.push(predicate.path);
    }
    return {
      directory: describeSessionDir(dir, mapping.file.glob),
      mapping_paths: { resolved: all.filter(has), unresolved: all.filter((dotted) => !has(dotted)) },
      essential: [...new Set(essential)],
      missingTargets
    };
  };
  if (files.length && !tally.records_with_usage) {
    const invalid = { status: 'mapping_invalid', exitCode: 1, dir, probe: probe(), reason: 'mapping_invalid', mapping_origin: mappingOrigin, ...tally };
    if (!check) return invalid;
    const { essential, missingTargets, ...found } = diagnostics();
    // Paths the files no longer carry can be repaired from the shape; a mapping
    // whose paths all resolve but selects nothing cannot (D1).
    return { ...invalid, ...found, diagnosis: essential.length ? 'paths_unresolved' : 'mapping_invalid' };
  }
  const { rows: candidates, summaryDelta, sessionsWithoutUsage } = chooseRows(mapping, read.responses, read.summaries);
  const index = await ledgerIndex(config, agent, sinceIso);
  const overlap = overlapCheck(mapping, candidates, index.liveRows);

  const skippedLive = new Set();
  let duplicates = 0;
  const writable = [];
  for (const row of candidates) {
    if (index.liveSessions.has(row.session_id) || hasStateFile(config, row.session_id)) { skippedLive.add(row.session_id); continue; }
    if (index.importedKeys.has(`${row.session_id}|${row.response_id}`)) { duplicates += 1; continue; }
    writable.push(row);
  }
  writable.sort((a, b) => a.ts.localeCompare(b.ts));

  const record = {
    run_id: crypto.randomUUID(),
    mapping_id: mapping.mapping_id,
    mapping_version: mapping.mapping_version,
    mapping_origin: mappingOrigin,
    ...(mapping.evidence?.repaired_from ? { repaired_from: mapping.evidence.repaired_from } : {}),
    agent,
    started_at: now.toISOString(),
    verification: overlap.verification,
    ...(overlap.reason ? { reason: overlap.reason } : {}),
    files_read: files.length,
    files_with_records: tally.files_with_records,
    sessions_imported: new Set(writable.map((row) => row.session_id)).size,
    sessions_skipped_live: skippedLive.size,
    sessions_without_usage: sessionsWithoutUsage,
    responses_written: writable.length,
    responses_skipped_duplicate: duplicates,
    unkeyed_responses: tally.unkeyed_responses,
    responses_without_usage: tally.responses_without_usage,
    oversized_lines: counts.oversized_lines ?? 0,
    malformed_lines: counts.malformed_lines ?? 0,
    rejected_identifiers: tally.rejected_identifiers,
    ...(writable.length ? { earliest_ts: writable[0].ts, latest_ts: writable.at(-1).ts } : {})
  };
  if (check) {
    const { essential, missingTargets, ...found } = diagnostics();
    // The one field the skill branches on (FR-12).
    let diagnosis = overlap.reason ?? 'verified';
    if (found.directory.matching_glob === 0) diagnosis = 'glob_matches_nothing';
    else if (overlap.verification !== 'verified'
      && (essential.length || missingTargets.some((target) => overlap.by_field?.[target] > 0))) diagnosis = 'paths_unresolved';
    const internal = summaryDelta.length
      ? { internally_consistent: summaryDelta.every((entry) => Object.entries(entry).every(([key, value]) => key === 'session_id' || value === 0)) }
      : {};
    return { status: 'check', exitCode: 0, dir, diagnosis, ...found, probe: probe(), overlap, summary_delta: summaryDelta, ...internal, record };
  }
  if (dryRun) return { status: 'dry_run', exitCode: 0, dir, overlap, record };
  if (overlap.verification !== 'verified' && !acceptUnverified) return { status: 'unverified', exitCode: 2, overlap, record };

  const events = writable.map((row) => makeEvent({
    agent, ts: row.ts, source: 'import', kind: 'usage', event_name: 'import.response',
    session_id: row.session_id, turn_id: row.response_id,
    model: config.privacy?.storeModelNames === false ? undefined : row.model,
    project_id: row.project_id, usage: row.usage, billing: row.billing,
    import: {
      mapping_id: mapping.mapping_id, mapping_version: mapping.mapping_version, run_id: record.run_id,
      verification: overlap.verification, reason: overlap.reason
    },
    fingerprint: fingerprint(['import', agent, row.session_id, row.response_id, row.usage])
  }));
  // The record goes down before the first row and again after the last, so a
  // run that stops part-way is visible and removable (D12). Before the rows it
  // holds only what is planned: a run killed part-way never states a count it
  // did not measure (D27).
  const refused = (error) => {
    if (error.code === 'IMPORTS_UNREADABLE') return { status: 'record_unreadable', exitCode: 1, record };
    if (!isWriteRefused(error)) throw error;
    return { status: 'read_only', exitCode: 1, reason: 'data_directory_read_only', record };
  };
  const { sessions_imported: sessionsPlanned, responses_written: responsesPlanned, earliest_ts: earliestPlanned, latest_ts: _latest, ...base } = record;
  const planned = { ...base, responses_planned: responsesPlanned, sessions_planned: sessionsPlanned, ...(earliestPlanned ? { earliest_planned_ts: earliestPlanned } : {}) };
  const measured = (count) => ({
    ...base,
    sessions_imported: new Set(writable.slice(0, count).map((row) => row.session_id)).size,
    responses_written: count,
    ...(count ? { earliest_ts: writable[0].ts, latest_ts: writable[count - 1].ts } : {})
  });
  // A row the guard refuses is a programming error, not a full disk: it
  // surfaces as itself, before any plan is recorded, so no record is left
  // claiming rows that were never written (#14).
  assertImportedRows(events);
  const code = (error) => (typeof error.code === 'string' ? error.code : 'unknown');
  try { writeImportRun(config, planned); } catch (error) { return refused(error); }
  try {
    appendImportedEvents(events, config);
  } catch (error) {
    // The writer reports how many whole rows reached the ledger before it
    // failed. None: the run leaves no record. Some: the record stays
    // unfinished with that count, so doctor names the undo (D26).
    const written = error.written ?? 0;
    if (!written) {
      // A disk that is still full cannot rewrite the record either. The plan
      // then stays, the command says it wrote nothing, and doctor counts the
      // run's rows in the ledger rather than repeat the plan (#14).
      let left = false;
      try { forgetImportRun(config, record.run_id); } catch { left = true; }
      if (error.written === undefined) throw error;
      if (isWriteRefused(error) && !left) return refused(error);
      return { status: 'write_failed', exitCode: 1, written: 0, of: events.length, code: code(error), record: measured(0), ...(left ? { record_left_unfinished: true } : {}) };
    }
    try { writeImportRun(config, measured(written)); } catch {}
    return { status: 'write_failed', exitCode: 1, written, of: events.length, code: code(error), record: measured(written) };
  }
  const finished = { ...measured(writable.length), finished_at: new Date().toISOString() };
  try {
    writeImportRun(config, finished);
  } catch (error) {
    // Every row is in the ledger, but the record still holds only the plan:
    // report the rows as written and name the undo, rather than crash (#14).
    return { status: 'write_failed', exitCode: 1, written: writable.length, of: events.length, code: code(error), record: measured(writable.length), record_left_unfinished: true };
  }
  return { status: 'written', exitCode: 0, overlap, record: finished };
}
