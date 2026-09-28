import crypto from 'node:crypto';
import { hmacIdentity, integerNonNegative, safeIdentifier, safeString } from '../privacy.mjs';

export function getPath(value, dotted) {
  return dotted.split('.').reduce((cursor, part) => cursor?.[part], value);
}

export function firstValue(value, paths) {
  for (const candidate of paths) {
    const found = getPath(value, candidate);
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return undefined;
}

export function firstNumber(value, paths) {
  for (const candidate of paths) {
    const found = getPath(value, candidate);
    const parsed = Number(found);
    if (found !== undefined && found !== null && found !== '' && Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function firstString(value, paths, max = 160) {
  return safeString(firstValue(value, paths), max);
}

export function firstId(value, paths, max = 160) {
  return safeIdentifier(firstValue(value, paths), max);
}

export function byteLength(value) {
  if (value === undefined || value === null) return undefined;
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

export function itemCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return undefined;
}

export function projectIdentity(payload, config) {
  const cwd = firstValue(payload, [
    'workspace.project_dir', 'workspace.current_dir', 'project_dir', 'cwd',
    'working_directory', 'workingDirectory', 'context.cwd', 'context.workingDirectory'
  ]);
  return cwd ? hmacIdentity(String(cwd), config.projectSalt, 'project') : undefined;
}

export function modelIdentity(payload) {
  return firstId(payload, [
    'model.id', 'model.name', 'model.display_name', 'model', 'model_name',
    'modelName', 'active_model', 'activeModel', 'request.model', 'response.model'
  ]);
}

export function sessionIdentity(payload) {
  return firstId(payload, [
    'session_id', 'sessionId', 'thread_id', 'threadId', 'thread-id',
    'conversation_id', 'conversationId', 'conversation.id'
  ]);
}

export function turnIdentity(payload) {
  return firstId(payload, [
    'prompt_id', 'promptId',
    'turn_id', 'turnId', 'turn-id', 'request_id', 'requestId',
    'message_id', 'messageId', 'response_id', 'responseId'
  ]);
}

export function timestamp(payload) {
  const raw = firstValue(payload, ['timestamp', 'ts', 'time', 'created_at', 'createdAt']);
  if (raw === undefined) return undefined;
  const date = typeof raw === 'number' && raw > 1e15
    ? new Date(Math.floor(raw / 1e6))
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function fingerprint(parts) {
  return crypto.createHash('sha256')
    .update(parts.map((part) => part === undefined ? '' : JSON.stringify(part)).join('|'))
    .digest('hex').slice(0, 32);
}

export function contextFields(payload) {
  const used = firstNumber(payload, [
    'context_window.used', 'contextWindow.used', 'context.used_tokens',
    'context.usedTokens', 'usage.context_tokens', 'usage.contextTokens',
    // Copilot CLI leaves `used`/`used_percentage` null and fills these instead.
    'context_window.current_context_tokens'
  ]);
  const limit = firstNumber(payload, [
    'context_window.context_window_size', 'context_window.limit',
    'context_window.displayed_context_limit',
    'contextWindow.size', 'contextWindow.limit', 'context.limit_tokens',
    'context.limitTokens'
  ]);
  let percent = firstNumber(payload, [
    'context_window.used_percentage', 'contextWindow.usedPercentage',
    'context_window.current_context_used_percentage',
    'context.percent', 'context.percentage', 'usage.context_percent'
  ]);
  if (percent !== undefined && percent <= 1) percent *= 100;
  if (percent === undefined && used !== undefined && limit) percent = (used / limit) * 100;
  return { used, limit, percent };
}

// `basis` records whether these counters may be added to other observations.
// 'increment' describes one distinct model call. 'sample' describes a gauge that
// is re-reported on every refresh (a status line re-render), so summing repeated
// samples would multiply one turn by the render rate.
export function canonicalUsage({
  inputTotal, inputFresh, cacheRead, cacheWrite, cacheWrite5m,
  cacheWrite1h, output, reasoning, semantics = 'unknown', basis = 'increment'
} = {}) {
  const usage = {
    input_total: integerNonNegative(inputTotal),
    input_fresh: integerNonNegative(inputFresh),
    cache_read: integerNonNegative(cacheRead),
    cache_write: integerNonNegative(cacheWrite),
    cache_write_5m: integerNonNegative(cacheWrite5m),
    cache_write_1h: integerNonNegative(cacheWrite1h),
    output: integerNonNegative(output),
    reasoning: integerNonNegative(reasoning),
    semantics,
    basis
  };
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}

export function hasUsage(usage) {
  return Object.entries(usage ?? {}).some(([key, value]) => key !== 'semantics' && Number.isFinite(value));
}
