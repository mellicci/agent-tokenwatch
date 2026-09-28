import path from 'node:path';
import { atomicWriteJson, readJson } from './fs-util.mjs';

// The Codex notify relay fails open, and it has to: it runs after every Codex
// turn, and a relay that failed loudly would put a Tokenwatch error in front of
// the user's agent. But Codex starts `notify` with stdin, stdout and stderr all
// sent to the null device (codex-rs/hooks/src/legacy_notify.rs), so even
// `TOKENWATCH_DEBUG=1` printed into nothing. On the first Windows run Codex
// completed turns with the relay installed, no Codex event reached the ledger,
// and nothing anywhere said why.
//
// So the relay keeps a small record of its own runs beside Tokenwatch's state:
// when it last recorded a turn, and its recent failures. A failure is the time,
// the stage it failed at, where the payload came from, and the error's class
// and code - never its message, which for a JSON parse error quotes part of the
// payload, and never the payload itself. `doctor` reads it.
//
// Where the data directory cannot be written, the record cannot be written
// either, and there is nowhere honest to put it instead: a shared temporary
// folder is readable by other accounts and invites a planted link. The write is
// then skipped, like every other relay error. `doctor` infers that case from
// the absence of any record at all since install (verdict `relay-not-running`)
// and names it as one of the two causes.

export const RELAY_RECORD_VERSION = 1;
// Stages in the order a relay run passes them. `relay-spawn` is the user's own
// previous notifier failing to start, which does not stop Tokenwatch recording;
// the others each mean the turn was not recorded.
export const RELAY_STAGES = ['read', 'parse', 'normalize', 'store', 'relay-spawn'];
export const RECORDING_STAGES = new Set(['read', 'parse', 'normalize', 'store']);
// Enough to show a pattern ("every turn, same stage") without growing: this
// file is rewritten on every Codex turn.
const MAX_FAILURES = 20;
const PAYLOAD_SOURCES = new Set(['argument', 'stdin', 'none']);

export function relayRecordFile(config) {
  return path.join(path.dirname(config.stateFile), 'codex-relay.json');
}

// An error's class and, when it has one, its system code (`EPERM`, `ENOSPC`).
// Both are identifiers the runtime chose, not text derived from the payload;
// anything that does not look like one is dropped rather than stored.
export function errorClass(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(error.code) ? error.code : undefined;
  return { error: name, ...(code ? { code } : {}) };
}

// Never throws: a missing, unreadable or malformed record reads as none.
export function readRelayRecord(config) {
  try {
    const record = readJson(relayRecordFile(config), null);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

// Records one relay outcome: `{ ok: true }` for a turn recorded, or
// `{ ok: false, stage, error, payload }`. Returns whether the record was
// written. Never throws - this runs on the relay's error path, and an error
// here must not become the thing that breaks the relay. Two Codex sessions
// ending turns at the same instant can race on this file, and the losing
// write's entry is lost; it is a diagnostic, not the ledger, so that is
// accepted rather than locked against.
export function recordRelayOutcome(config, outcome, { now = new Date() } = {}) {
  try {
    const at = new Date(now).toISOString();
    const previous = readRelayRecord(config) ?? {};
    const failures = Array.isArray(previous.failures) ? previous.failures.slice(-MAX_FAILURES) : [];
    const record = {
      version: RELAY_RECORD_VERSION,
      last_success_at: typeof previous.last_success_at === 'string' ? previous.last_success_at : undefined,
      failure_count: Number.isSafeInteger(previous.failure_count) ? previous.failure_count : 0,
      failures
    };
    if (outcome?.ok) {
      record.last_success_at = at;
    } else {
      const stage = RELAY_STAGES.includes(outcome?.stage) ? outcome.stage : 'store';
      const entry = { at, stage, ...errorClass(outcome?.error) };
      if (PAYLOAD_SOURCES.has(outcome?.payload)) entry.payload = outcome.payload;
      record.failures = [...failures, entry].slice(-MAX_FAILURES);
      record.failure_count += 1;
    }
    atomicWriteJson(relayRecordFile(config), record);
    return true;
  } catch {
    return false;
  }
}

// What the record says about recording since `sinceMs`: the failures that
// stopped a turn being recorded and came after the last successful record, and
// the newest of them. `ran` is whether the relay left any trace at all since
// then, success or failure.
export function relayRecordSummary(record, sinceMs = -Infinity) {
  if (!record) return { ran: false, failing: [], last_success_at: undefined, spawn_failures: [] };
  const successMs = Date.parse(record.last_success_at ?? '');
  const lastSuccess = Number.isFinite(successMs) && successMs >= sinceMs ? record.last_success_at : undefined;
  const failures = (Array.isArray(record.failures) ? record.failures : [])
    .filter((entry) => Date.parse(entry?.at) >= sinceMs);
  const afterSuccess = (entry) => !Number.isFinite(successMs) || Date.parse(entry.at) > successMs;
  return {
    ran: Boolean(lastSuccess) || failures.length > 0,
    last_success_at: lastSuccess,
    failing: failures.filter((entry) => RECORDING_STAGES.has(entry.stage) && afterSuccess(entry)),
    spawn_failures: failures.filter((entry) => entry.stage === 'relay-spawn'),
    max_listed: MAX_FAILURES
  };
}

// One failure, for a doctor line: "at <time> in <stage> (<Class> <CODE>)".
export function describeRelayFailure(entry) {
  const cause = [entry.error, entry.code].filter(Boolean).join(' ');
  const source = entry.payload === 'none' ? '; no JSON argument, and nothing on stdin, reached the relay'
    : entry.payload === 'stdin' ? '; the payload came on stdin, not as the last argument'
      : '';
  return `at ${entry.at} in ${entry.stage} (${cause}${source})`;
}
