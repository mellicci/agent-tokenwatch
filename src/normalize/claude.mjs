import { makeEvent } from '../schema.mjs';
import { parseDuration } from '../time.mjs';
import {
  byteLength, canonicalUsage, contextFields, fingerprint, firstNumber,
  firstString, firstValue, hasUsage, itemCount, modelIdentity,
  projectIdentity, sessionIdentity, timestamp, turnIdentity
} from './common.mjs';

function claudeUsage(payload, basis) {
  const current = firstValue(payload, [
    'context_window.current_usage', 'contextWindow.currentUsage',
    'usage', 'token_usage', 'tokenUsage'
  ]) ?? {};
  const fresh = firstNumber(current, ['input_tokens', 'inputTokens', 'uncached_input_tokens', 'uncachedInputTokens']);
  const cacheRead = firstNumber(current, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens']);
  const cache5m = firstNumber(current, [
    'cache_creation.ephemeral_5m_input_tokens',
    'cache_creation_input_tokens_5m', 'cacheCreationInputTokens5m'
  ]);
  const cache1h = firstNumber(current, [
    'cache_creation.ephemeral_1h_input_tokens',
    'cache_creation_input_tokens_1h', 'cacheCreationInputTokens1h'
  ]);
  const undifferentiatedWrite = firstNumber(current, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
  const output = firstNumber(current, ['output_tokens', 'outputTokens']);
  const reasoning = firstNumber(current, ['thinking_tokens', 'thinkingTokens', 'reasoning_tokens', 'reasoningTokens']);
  const cacheWrite = cache5m === undefined && cache1h === undefined ? undifferentiatedWrite : undefined;
  const inputTotal = [fresh, cacheRead, cacheWrite, cache5m, cache1h]
    .some((part) => part !== undefined)
    ? (fresh ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (cache5m ?? 0) + (cache1h ?? 0)
    : firstNumber(payload, ['context_window.total_input_tokens', 'usage.total_input_tokens']);
  return canonicalUsage({
    inputTotal,
    inputFresh: fresh,
    cacheRead,
    cacheWrite,
    cacheWrite5m: cache5m,
    cacheWrite1h: cache1h,
    output,
    reasoning,
    semantics: 'components',
    basis
  });
}

// Claude reports cache state directly. Prefer it over the locally configured
// guess, and record which of the two produced the numbers shown.
function claudeCache(payload) {
  const reported = firstValue(payload, ['prompt_cache', 'promptCache']);
  if (!reported || typeof reported !== 'object') return undefined;
  const cache = {};
  const rawTtl = firstValue(reported, ['ttl', 'ttl_seconds', 'ttlSeconds']);
  let ttlSeconds;
  if (typeof rawTtl === 'number') ttlSeconds = rawTtl;
  else if (typeof rawTtl === 'string') {
    try { ttlSeconds = parseDuration(rawTtl) / 1000; } catch { ttlSeconds = undefined; }
  }
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    cache.ttl_seconds = ttlSeconds;
    cache.ttl_source = 'provider_reported';
  }
  const expiresAt = firstValue(reported, ['expires_at', 'expiresAt']);
  if (expiresAt !== undefined && Number.isFinite(cache.ttl_seconds)) {
    const expiryMs = new Date(typeof expiresAt === 'number' && expiresAt < 1e12 ? expiresAt * 1000 : expiresAt).getTime();
    if (!Number.isNaN(expiryMs)) {
      const remaining = Math.max(0, (expiryMs - Date.now()) / 1000);
      cache.age_seconds = Math.max(0, cache.ttl_seconds - remaining);
    }
  }
  const hitRate = firstNumber(reported, ['hit_ratio', 'hitRatio', 'hit_rate', 'hitRate']);
  if (hitRate !== undefined) cache.hit_rate = hitRate > 1 ? hitRate / 100 : hitRate;
  return Object.keys(cache).length ? cache : undefined;
}

function structuralMetrics(payload, eventName, config) {
  const metrics = {};
  const prompt = firstValue(payload, ['prompt', 'user_prompt', 'userPrompt']);
  const toolInput = firstValue(payload, ['tool_input', 'toolInput']);
  const toolOutput = firstValue(payload, ['tool_response', 'toolResponse', 'tool_output', 'toolOutput']);
  const customInstructions = firstValue(payload, ['custom_instructions', 'customInstructions']);
  const promptBytes = byteLength(prompt);
  const inputBytes = byteLength(toolInput);
  const outputBytes = byteLength(toolOutput);
  const instructionBytes = byteLength(customInstructions);
  if (promptBytes !== undefined) metrics.prompt_bytes = promptBytes;
  if (inputBytes !== undefined) metrics.tool_input_bytes = inputBytes;
  if (outputBytes !== undefined) metrics.tool_output_bytes = outputBytes;
  if (instructionBytes !== undefined) metrics.compact_instruction_bytes = instructionBytes;
  const files = firstValue(payload, ['files', 'file_paths', 'filePaths']);
  const count = itemCount(files);
  if (count !== undefined) metrics.file_count = count;
  const duration = firstNumber(payload, ['duration_ms', 'durationMs', 'cost.total_duration_ms']);
  if (config.privacy.storeDurations && duration !== undefined) metrics.duration_ms = duration;
  if (eventName === 'SubagentStop') {
    const last = firstValue(payload, ['last_assistant_message', 'lastAssistantMessage']);
    const bytes = byteLength(last);
    if (bytes !== undefined) metrics.subagent_result_bytes = bytes;
  }
  return metrics;
}

export function normalizeClaude(eventName, payload, config, source = 'hook') {
  const actualName = firstString(payload, ['hook_event_name', 'hookEventName'], 100) || eventName || 'unknown';
  const isStatus = source === 'statusline' || eventName === 'status';
  const usage = claudeUsage(payload, isStatus ? 'sample' : 'increment');
  const cumulativeCost = firstNumber(payload, [
    'cost.total_cost_usd', 'cost.totalCostUsd', 'total_cost_usd',
    'totalCostUsd', 'session_cost_usd', 'sessionCostUsd'
  ]);
  const directCost = firstNumber(payload, ['cost_usd', 'costUsd', 'usage.cost_usd']);
  const context = contextFields(payload);
  const session = sessionIdentity(payload);
  const turn = turnIdentity(payload);
  const model = config.privacy.storeModelNames ? modelIdentity(payload) : undefined;
  const project = projectIdentity(payload, config);
  const toolName = config.privacy.storeToolNames
    ? firstString(payload, ['tool_name', 'toolName'], 120) : undefined;
  const subagentType = firstString(payload, ['agent_type', 'agentType', 'subagent_type'], 120);
  const cost = cumulativeCost !== undefined
    ? { cumulative_usd: cumulativeCost, basis: 'provider_reported', currency: 'USD' }
    : directCost !== undefined
      ? { amount_usd: directCost, basis: 'provider_reported', currency: 'USD' }
      : undefined;
  const metrics = structuralMetrics(payload, actualName, config);
  // duration_ms tracks wall-clock session age, so it changes on every status
  // refresh. Including it would give each re-render of one turn a distinct
  // fingerprint and defeat deduplication entirely.
  const { duration_ms: _volatile, ...stableMetrics } = metrics;
  const event = makeEvent({
    agent: 'claude',
    ts: timestamp(payload),
    source,
    kind: isStatus ? 'usage' : actualName.startsWith('Subagent') ? 'subagent' : actualName === 'PreCompact' ? 'compact' : 'lifecycle',
    event_name: actualName,
    session_id: session,
    turn_id: turn,
    model,
    project_id: project,
    tool_name: toolName,
    subagent_type: subagentType,
    status: firstString(payload, ['reason', 'status', 'trigger'], 80),
    usage: hasUsage(usage) ? usage : undefined,
    cost,
    context,
    cache: claudeCache(payload),
    metrics,
    flags: {
      cost_cumulative: cumulativeCost !== undefined,
      stop_hook_active: Boolean(firstValue(payload, ['stop_hook_active', 'stopHookActive']))
    },
    fingerprint: (isStatus || turn || firstValue(payload, ['timestamp', 'ts', 'event_id', 'eventId']))
      ? fingerprint([
        'claude', actualName, session, turn, model, usage, cumulativeCost, directCost,
        firstValue(payload, ['timestamp', 'ts', 'event_id', 'eventId']), toolName, subagentType,
        context, stableMetrics
      ])
      : undefined
  });
  return [event];
}
