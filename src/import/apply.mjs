import { finiteNonNegative, hmacIdentity, identifierOrUndefined } from '../privacy.mjs';
import { getPath } from '../normalize/common.mjs';

// Applies one part of a mapping (its per-call `record`, its `summary`, or a
// `context` entry) to one parsed session-file line. Everything that leaves this
// module is a number, an identifier that passed the identifier guard, a
// timestamp, or an HMAC of a project path; the raw line is never returned
// (intent 06, D6, D10).

export function matches(line, select) {
  return select.every(({ path, equals }) => getPath(line, path) === equals);
}

function timestampOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = typeof value === 'number' && value > 1e15 ? new Date(Math.floor(value / 1e6)) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function numbers(line, spec) {
  if (!spec) return undefined;
  const out = {};
  for (const [target, { path, scale = 1 }] of Object.entries(spec)) {
    const value = finiteNonNegative(getPath(line, path));
    // Rounded to 15 significant digits, so a scale of 1e-9 gives the same
    // figure the live adapter's division by 1e9 does (17184730000 -> 17.18473).
    if (value !== undefined) out[target] = Number((value * scale).toPrecision(15));
  }
  return Object.keys(out).length ? out : undefined;
}

// What a context line (the session header, a turn header) tells later lines:
// their session id, model and project, when those lines do not carry them.
export function readContext(line, entries, { projectSalt }) {
  const found = {};
  for (const entry of entries ?? []) {
    if (!matches(line, entry.select)) continue;
    if (entry.session_id) found.session_id = identifierOrUndefined(getPath(line, entry.session_id)) ?? found.session_id;
    if (entry.model) found.model = identifierOrUndefined(getPath(line, entry.model)) ?? found.model;
    if (entry.project_path) {
      const raw = getPath(line, entry.project_path);
      if (typeof raw === 'string' && raw) found.project_id = hmacIdentity(raw, projectSalt, 'project');
    }
  }
  return found;
}

// One line under one record spec, or undefined when the line is not such a
// record. `rejected` is set when the line is one, but its session id failed the
// identifier guard: it is counted and dropped, never stored scrubbed.
export function applyMapping(line, spec, { context = {}, projectSalt }) {
  if (!matches(line, spec.select)) return undefined;
  const pick = (key) => {
    if (!spec[key]) return undefined;
    const raw = getPath(line, spec[key]);
    return raw === undefined ? undefined : { value: identifierOrUndefined(raw), present: true };
  };
  const session = pick('session_id');
  const sessionId = session ? session.value : context.session_id;
  // A session id that is present but not an identifier is rejected, not
  // replaced by the context's: `session.value` is then undefined.
  if (!sessionId) return { rejected: true };
  const response = pick('response_id');
  const model = pick('model');
  let projectId = context.project_id;
  if (spec.project_path) {
    const raw = getPath(line, spec.project_path);
    if (typeof raw === 'string' && raw) projectId = hmacIdentity(raw, projectSalt, 'project');
  }
  const ts = timestampOf(getPath(line, spec.ts));
  if (!ts) return { rejected: true };
  return {
    ts,
    session_id: sessionId,
    response_id: response?.value,
    model: model ? model.value : context.model,
    project_id: projectId,
    usage: numbers(line, spec.usage),
    usage_cumulative: numbers(line, spec.usage_cumulative),
    billing: numbers(line, spec.billing),
    billing_cumulative: numbers(line, spec.billing_cumulative)
  };
}
