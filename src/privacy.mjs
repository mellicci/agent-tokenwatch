import crypto from 'node:crypto';
import path from 'node:path';

export function hmacIdentity(value, salt, prefix = 'p') {
  if (!value) return undefined;
  // Case-folded on Windows so one project reached by two spellings of its
  // path hashes to one identity instead of being counted twice.
  const resolved = path.resolve(String(value));
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHmac('sha256', salt).update(normalized).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

export function safeString(value, max = 160) {
  if (value === undefined || value === null) return undefined;
  // Only a primitive can be a name. Stringifying a container yields either
  // "[object Object]", which pollutes model and tool tallies, or - worse - an
  // array of strings joined into one, which is content this must never store.
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

// The event schema is a strict allowlist of which FIELDS may be stored and how
// long each may be. It says nothing about what a provider puts inside one, and
// identifier fields - session id, model, tool name, event name - are passed
// through as the agent reports them. That is where a filesystem path, a
// credential, or a fragment of a prompt would actually land, so the values get
// checked too and not only the field names.
const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(^|[^A-Za-z0-9])gh[opusr]_[A-Za-z0-9]{16,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /(^|[^A-Za-z0-9])AKIA[0-9A-Z]{12,}/,
  /(^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/,
  /(^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/,
  /(^|[^A-Za-z0-9])ya29[._]/,
  /BEGIN[ _][A-Z _]*PRIVATE[ _]KEY/
];

// Both the natural and the post-sanitization spelling, because this also runs
// against already-stored events, where every separator has become `_`.
//
// Anchoring only on an absolute prefix was not enough: `/` and `.` both survive
// sanitization, so a relative path, a traversal, or a UNC share reached the
// ledger verbatim. `../../home/someone/.ssh/id_rsa` was stored intact.
const PATH_PATTERNS = [
  /^\/[A-Za-z0-9_.-]+[\\/]/,
  /^~[\\/_]/,
  /^[A-Za-z]:[\\/_]/,
  /^_(home|Users|var|etc|tmp|opt|srv|root)_/,
  /^\/(home|Users|var|etc|tmp|opt|srv|root)\//,
  // A relative path or a traversal. Never how a model or tool is named.
  /^\.\.?[\\/]/,
  /(^|[\\/_])\.\.[\\/]/,
  // A UNC share, before and after sanitization.
  /^\\\\[A-Za-z0-9]/,
  /^__[A-Za-z0-9][A-Za-z0-9.-]*_/
];

// Two separate shapes that a bare `^`-anchored pattern cannot see. Kept apart
// from PATH_PATTERNS because both have to tolerate the one legitimate reason an
// identifier contains a slash: a namespaced model name such as
// `models/gemini-2.5-pro` or `anthropic/claude-opus`, which has exactly one
// separator and no file extension.
function looksLikeRelativePath(text) {
  const separators = (text.match(/[\\/]/g) ?? []).length;
  if (separators === 0) return false;
  // `a/b/c` and deeper. A namespaced model name stops at one separator.
  if (separators >= 2) return true;
  // `dir/file.ext`. The extension must run to the end, which `claude-3.5-sonnet`
  // does not do because its trailing segment carries a hyphen.
  return /[\\/][^\\/\s]*\.[A-Za-z0-9]{1,8}$/.test(text);
}

// An identifier is not a sentence. Sanitization turns spaces into underscores,
// so a prompt fragment arrives as a long run of word-like tokens. Six is
// deliberately conservative: real event names top out at two or three, as in
// `agent_turn_complete` or `codex.api_request`.
function looksLikeProse(text) {
  const words = text.split(/[_\s]+/).filter((token) => /^[A-Za-z]{2,}$/.test(token));
  return words.length >= 6;
}

// A secret or a path, without the prose heuristic: for text that is prose by
// design, such as a mapping's evidence note (intent 19, D4).
export function looksSecretOrPath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (PATH_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return looksLikeRelativePath(value);
}

export function looksSensitive(value) {
  if (typeof value !== 'string' || !value) return false;
  return looksSecretOrPath(value) || looksLikeProse(value);
}

export function safeIdentifier(value, max = 128) {
  const text = safeString(value, max);
  if (!text) return undefined;
  // Checked before the charset scrub, while slashes, backslashes and spaces
  // are still intact and a path or a sentence is still recognisable. Returning
  // undefined drops this one field; the rest of the event is still recorded.
  if (looksSensitive(text)) return undefined;
  return text.replace(/[^A-Za-z0-9_.:@/+\-=[\]]/g, '_').slice(0, max);
}

// An identifier read from an agent's session file by `tokenwatch import` is
// kept only when it has an identifier's shape and does not look like a secret,
// a path or prose; otherwise it is rejected, never scrubbed (intent 06, D6).
// Deliberately separate from the OTLP identifier shape, which the live Codex
// path keeps unchanged.
export const IMPORT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,159}$/;

export function identifierOrUndefined(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return undefined;
  const text = String(value);
  return IMPORT_IDENTIFIER.test(text) && !looksSensitive(text) ? text : undefined;
}

export function finiteNonNegative(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function integerNonNegative(value) {
  const number = finiteNonNegative(value);
  return number === undefined ? undefined : Math.round(number);
}

export function redactForDebug(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    keys: Object.keys(value).slice(0, 50),
    byteLength: Buffer.byteLength(JSON.stringify(value), 'utf8')
  };
}
