import { looksSensitive } from '../privacy.mjs';
import { makeEvent } from '../schema.mjs';
import {
  byteLength, canonicalUsage, fingerprint, firstNumber, firstString,
  firstValue, hasUsage, itemCount, modelIdentity, projectIdentity,
  sessionIdentity, timestamp, turnIdentity
} from './common.mjs';

export function normalizeCodexNotify(eventName, payload, config) {
  const actualName = firstString(payload, ['type', 'event_name', 'eventName'], 100)
    || eventName || 'agent-turn-complete';
  const inputMessages = firstValue(payload, ['input-messages', 'input_messages', 'inputMessages']);
  const assistant = firstValue(payload, ['last-assistant-message', 'last_assistant_message', 'lastAssistantMessage']);
  const metrics = {};
  const inputBytes = byteLength(inputMessages);
  const assistantBytes = byteLength(assistant);
  const count = itemCount(inputMessages);
  if (inputBytes !== undefined) metrics.input_message_bytes = inputBytes;
  if (assistantBytes !== undefined) metrics.assistant_output_bytes = assistantBytes;
  if (count !== undefined) metrics.input_message_count = count;
  return [makeEvent({
    agent: 'codex',
    ts: timestamp(payload),
    source: 'notify',
    kind: 'lifecycle',
    event_name: actualName,
    session_id: sessionIdentity(payload),
    turn_id: turnIdentity(payload),
    model: config.privacy.storeModelNames ? modelIdentity(payload) : undefined,
    project_id: projectIdentity(payload, config),
    status: firstString(payload, ['status', 'reason'], 80),
    metrics,
    fingerprint: fingerprint(['codex-notify', actualName, sessionIdentity(payload), turnIdentity(payload), timestamp(payload), inputBytes, assistantBytes])
  })];
}

function otelValue(anyValue) {
  if (anyValue === undefined || anyValue === null) return undefined;
  if (typeof anyValue !== 'object') return anyValue;
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) {
    if (anyValue[key] !== undefined) return anyValue[key];
  }
  if (Array.isArray(anyValue.arrayValue?.values)) return anyValue.arrayValue.values.map(otelValue);
  if (Array.isArray(anyValue.kvlistValue?.values)) {
    return Object.fromEntries(anyValue.kvlistValue.values.map((entry) => [entry.key, otelValue(entry.value)]));
  }
  return undefined;
}

function attributesToObject(attributes = []) {
  const out = {};
  for (const entry of attributes) {
    if (!entry || typeof entry.key !== 'string') continue;
    out[entry.key] = otelValue(entry.value);
  }
  return out;
}

const SAFE_BODY_KEYS = new Set([
  'event.name', 'event_name', 'name', 'model', 'model_name', 'request.model',
  'gen_ai.request.model', 'session_id', 'conversation_id', 'turn_id', 'request_id',
  'input_tokens', 'input_token_count', 'output_tokens', 'output_token_count',
  'cached_input_tokens', 'cached_input_token_count', 'reasoning_tokens',
  'reasoning_token_count', 'cost_usd', 'duration_ms'
]);

function safeBodyObject(body) {
  const value = otelValue(body);
  let object = value;
  if (typeof value === 'string' && value.length <= 16_384 && value.trim().startsWith('{')) {
    try { object = JSON.parse(value); } catch { object = null; }
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) return {};
  const out = {};
  for (const [key, child] of Object.entries(object)) {
    if (SAFE_BODY_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof child)) out[key] = child;
  }
  return out;
}

function attrValue(attrs, body, candidates) {
  for (const key of candidates) {
    if (attrs[key] !== undefined) return attrs[key];
    if (body[key] !== undefined) return body[key];
  }
  return undefined;
}

// Everything above copies attribute keys and values through unfiltered, and
// `attrValue` reads attributes before the allowlisted body, so the body
// allowlist alone does not bound what arrives here. The receiver is
// unauthenticated on loopback, which means any local process chooses these
// strings. Real Codex sends short semantic names like `codex.api_request` and
// UUID session ids, so anything that is not identifier-shaped is rejected
// outright rather than scrubbed into something that merely resembles one.
// Leading character must be alphanumeric, which rules out a path.
const OTLP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;

function otlpIdentifier(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (!OTLP_IDENTIFIER.test(text)) return undefined;
  // Codex emits source locations as event names - `otel/src/events/
  // session_telemetry.rs:570` appears throughout a real ledger. Those are file
  // paths, which this project promises not to store, and they are useless as
  // event names besides. Rejected here rather than later so the caller's
  // fallback chain still yields a usable name instead of no name at all.
  if (looksSensitive(text)) return undefined;
  return text;
}

function attrNumber(attrs, body, candidates) {
  const raw = attrValue(attrs, body, candidates);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nanosToIso(record) {
  // Codex sends timeUnixNano as 0 and puts the real instant in observedTime, so
  // a plain ?? chain dated every OTLP event to 1970 and hid them from --since.
  const candidates = [record.timeUnixNano, record.observedTimeUnixNano];
  const raw = candidates.find((value) => value !== undefined && value !== null
    && String(value) !== '0' && String(value) !== '');
  if (!raw) return undefined;
  try {
    const millis = Number(BigInt(String(raw)) / 1_000_000n);
    return new Date(millis).toISOString();
  } catch { return undefined; }
}

function normalizeLogRecord(record, resourceAttrs, scopeName, config) {
  const attrs = { ...resourceAttrs, ...attributesToObject(record.attributes) };
  const body = safeBodyObject(record.body);
  // Codex fills logRecord.eventName with a Rust source location - "event
  // otel/src/events/session_telemetry.rs:570" - and puts the semantic name in the
  // event.name attribute. Preferring the record field recorded its source tree in
  // our ledger and made every event look distinct.
  const eventName = otlpIdentifier(attrValue(attrs, body, [
    'event.name', 'event_name', 'name', 'codex.event.name', 'gen_ai.operation.name'
  ])) ?? otlpIdentifier(record.eventName) ?? otlpIdentifier(scopeName) ?? 'otel.log';
  const inputTotal = attrNumber(attrs, body, [
    'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'input_tokens',
    'input_token_count', 'codex.input_token_count', 'openai.input_tokens'
  ]);
  const cacheRead = attrNumber(attrs, body, [
    'gen_ai.usage.cached_input_tokens', 'cached_input_tokens',
    'cached_input_token_count', 'cached_token_count',
    'codex.cached_input_token_count', 'openai.cached_input_tokens'
  ]);
  const cacheWrite = attrNumber(attrs, body, [
    'gen_ai.usage.cache_creation_input_tokens', 'cache_write_token_count',
    'cache_creation_input_tokens', 'codex.cache_write_token_count'
  ]);
  const output = attrNumber(attrs, body, [
    'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'output_tokens',
    'output_token_count', 'codex.output_token_count', 'openai.output_tokens'
  ]);
  const reasoning = attrNumber(attrs, body, [
    'gen_ai.usage.reasoning_tokens', 'reasoning_tokens', 'reasoning_token_count',
    'codex.reasoning_token_count', 'openai.reasoning_tokens'
  ]);
  const usage = canonicalUsage({ inputTotal, cacheRead, cacheWrite, output, reasoning, semantics: 'cached_subset' });
  const amount = attrNumber(attrs, body, ['cost_usd', 'gen_ai.usage.cost_usd', 'codex.cost_usd']);
  const duration = attrNumber(attrs, body, ['duration_ms', 'gen_ai.client.operation.duration_ms', 'codex.duration_ms']);
  const session = otlpIdentifier(attrValue(attrs, body, [
    'session_id', 'conversation_id', 'conversation.id', 'thread_id', 'codex.conversation_id'
  ]));
  const turn = otlpIdentifier(attrValue(attrs, body, ['turn_id', 'turn.id', 'request_id', 'gen_ai.response.id', 'codex.turn_id']));
  const model = otlpIdentifier(attrValue(attrs, body, [
    'gen_ai.request.model', 'request.model', 'model', 'model_name', 'codex.model'
  ]));
  const projectRaw = attrValue(attrs, body, ['project.cwd', 'cwd', 'working_directory']);
  const payloadForProject = projectRaw ? { cwd: projectRaw } : {};
  const reported = attrValue(attrs, body, ['event.timestamp', 'event_timestamp']);
  const ts = nanosToIso(record)
    ?? (typeof reported === 'string' && !Number.isNaN(Date.parse(reported)) ? new Date(reported).toISOString() : undefined);
  return makeEvent({
    agent: 'codex',
    ts,
    source: 'otlp',
    kind: hasUsage(usage) || amount !== undefined ? 'usage' : 'telemetry',
    event_name: eventName,
    session_id: session,
    turn_id: turn,
    model: config.privacy.storeModelNames ? model : undefined,
    project_id: projectIdentity(payloadForProject, config),
    usage: hasUsage(usage) ? usage : undefined,
    cost: amount !== undefined ? { amount_usd: amount, basis: 'provider_reported', currency: 'USD' } : undefined,
    metrics: config.privacy.storeDurations && duration !== undefined ? { duration_ms: duration } : undefined,
    fingerprint: fingerprint(['codex-otlp', ts, eventName, session, turn, model, usage, amount, record.traceId, record.spanId])
  });
}

export function normalizeCodexOtlpLogs(payload, config) {
  const events = [];
  for (const resourceLog of payload.resourceLogs ?? []) {
    const resourceAttrs = attributesToObject(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs ?? resourceLog.instrumentationLibraryLogs ?? []) {
      const scopeName = scopeLog.scope?.name ?? scopeLog.instrumentationLibrary?.name;
      for (const record of scopeLog.logRecords ?? []) {
        events.push(normalizeLogRecord(record, resourceAttrs, scopeName, config));
      }
    }
  }
  return events;
}

function metricPoints(metric) {
  const kind = ['sum', 'gauge', 'histogram'].find((key) => metric[key]);
  if (!kind) return [];
  return metric[kind].dataPoints ?? [];
}

export function normalizeCodexOtlpMetrics(payload, config) {
  const events = [];
  for (const resourceMetric of payload.resourceMetrics ?? []) {
    const resourceAttrs = attributesToObject(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        for (const point of metricPoints(metric)) {
          const attrs = { ...resourceAttrs, ...attributesToObject(point.attributes) };
          const value = Number(point.asInt ?? point.asDouble ?? point.sum ?? point.count);
          if (!Number.isFinite(value) || value < 0) continue;
          const name = String(metric.name ?? 'otel.metric');
          const lower = name.toLowerCase();
          const usage = canonicalUsage({
            inputTotal: lower.includes('input') && lower.includes('token') ? value : undefined,
            cacheRead: lower.includes('cached') && lower.includes('token') ? value : undefined,
            output: lower.includes('output') && lower.includes('token') ? value : undefined,
            reasoning: lower.includes('reason') && lower.includes('token') ? value : undefined,
            semantics: 'cached_subset'
          });
          const ts = nanosToIso(point);
          // Same rule as the logs path: these come from whatever posted to the
          // receiver, so they are accepted only when identifier-shaped.
          const model = otlpIdentifier(attrs['gen_ai.request.model'] ?? attrs.model);
          const session = otlpIdentifier(attrs.session_id ?? attrs.conversation_id);
          const turn = otlpIdentifier(attrs.turn_id ?? attrs.request_id);
          events.push(makeEvent({
            agent: 'codex', ts, source: 'otlp', kind: hasUsage(usage) ? 'usage' : 'telemetry',
            event_name: otlpIdentifier(name) ?? 'otel.metric', session_id: session, turn_id: turn,
            model: config.privacy.storeModelNames ? model : undefined,
            usage: hasUsage(usage) ? usage : undefined,
            metrics: hasUsage(usage) ? undefined : { metric_value: value },
            fingerprint: fingerprint(['codex-metric', name, ts, session, turn, model, value])
          }));
        }
      }
    }
  }
  return events;
}
