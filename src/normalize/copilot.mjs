import { makeEvent } from '../schema.mjs';
import { safeIdentifier } from '../privacy.mjs';
import {
  byteLength, canonicalUsage, contextFields, fingerprint, firstNumber,
  firstString, firstValue, hasUsage, itemCount, modelIdentity,
  projectIdentity, sessionIdentity, timestamp, turnIdentity
} from './common.mjs';

function copilotUsage(payload, basis) {
  // Copilot CLI 1.0.85 sends its status line a Claude-shaped object whose token
  // counts live under context_window.current_usage. Earlier previews used
  // flatter names, kept here as fallbacks.
  const usage = firstValue(payload, [
    'context_window.current_usage', 'contextWindow.currentUsage',
    'usage', 'token_usage', 'tokenUsage', 'context.usage'
  ]) ?? {};
  const inputTotal = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'total_input_tokens']);
  const cacheRead = firstNumber(usage, ['cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens', 'cacheReadInputTokens']);
  const cacheWrite = firstNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_tokens', 'cacheWriteTokens']);
  const output = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const reasoning = firstNumber(usage, ['reasoning_tokens', 'reasoningTokens', 'thinking_tokens']);
  // Copilot's input total is `input + cache_read + cache_write`, so the fresh
  // part is what is left after both. The shared cached-subset rule subtracts
  // only reads, because the OpenAI shape it was written for reports no writes.
  const inputFresh = inputTotal !== undefined && cacheWrite !== undefined
    ? Math.max(0, inputTotal - (cacheRead ?? 0) - cacheWrite)
    : undefined;
  return canonicalUsage({
    inputTotal, inputFresh, cacheRead, cacheWrite, output, reasoning, semantics: 'cached_subset', basis
  });
}

// Copilot's auto router reports `model.id: "auto"` and names the model it
// actually chose in `display_name` ("Auto -> gpt-5.6-luna"). Recording "auto"
// collapses every model into one bucket, which is precisely the bucket a cost
// tool must not collapse.
function copilotModel(payload) {
  const resolved = firstString(payload, ['model.auto_tier.id', 'model.auto_tier'], 120);
  const display = firstString(payload, ['model.display_name', 'model.displayName'], 160);
  const id = firstString(payload, ['model.id'], 120);
  if (id && id !== 'auto') return modelIdentity(payload);
  const routed = display && /\s*(?:->|\u2192)\s*/.test(display)
    ? display.split(/\s*(?:->|\u2192)\s*/).pop().trim()
    : undefined;
  const chosen = safeIdentifier(resolved ?? routed ?? display ?? id);
  // Before the router picks, display_name is just "Auto". Recording that would
  // invent a model that never ran and split one model's cost across two groups.
  return chosen && chosen.toLowerCase() === 'auto' ? undefined : chosen;
}

// Copilot reports session-cumulative token counters rather than the per-call
// gauge Claude sends. The store diffs them into per-call increments, which is
// what makes them summable at all - a cumulative total added to a period is
// the whole session counted once per render.
function copilotCumulativeUsage(payload) {
  const window = firstValue(payload, ['context_window', 'contextWindow']) ?? {};
  const totals = {
    input_total: firstNumber(window, ['total_input_tokens']),
    cache_read: firstNumber(window, ['total_cache_read_tokens']),
    cache_write: firstNumber(window, ['total_cache_write_tokens']),
    output: firstNumber(window, ['total_output_tokens']),
    reasoning: firstNumber(window, ['total_reasoning_tokens'])
  };
  return Object.values(totals).some((value) => value !== undefined) ? totals : undefined;
}

// Copilot bills in AI units and premium requests, never currency. `total_nano_aiu`
// is nano-units: 17184730000 is the 17.18 its own footer displays.
function copilotBilling(payload) {
  const nano = firstNumber(payload, ['ai_used.total_nano_aiu', 'aiUsed.totalNanoAiu']);
  const premium = firstNumber(payload, ['cost.total_premium_requests', 'cost.totalPremiumRequests']);
  const out = {};
  if (nano !== undefined) out.aiu = nano / 1e9;
  if (premium !== undefined) out.premium_requests = premium;
  return Object.keys(out).length ? out : undefined;
}

function metrics(payload, config) {
  const out = {};
  for (const [key, paths] of Object.entries({
    prompt_bytes: ['prompt', 'user_prompt', 'userPrompt'],
    tool_input_bytes: ['tool_input', 'toolInput', 'arguments'],
    tool_output_bytes: ['tool_output', 'toolOutput', 'result'],
    assistant_output_bytes: ['last_assistant_message', 'lastAssistantMessage']
  })) {
    const bytes = byteLength(firstValue(payload, paths));
    if (bytes !== undefined) out[key] = bytes;
  }
  const files = itemCount(firstValue(payload, ['files', 'filePaths', 'file_paths']));
  if (files !== undefined) out.file_count = files;
  const duration = firstNumber(payload, ['duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs']);
  if (config.privacy.storeDurations && duration !== undefined) out.duration_ms = duration;
  return out;
}

export function normalizeCopilot(eventName, payload, config, source = 'hook') {
  const actualName = firstString(payload, ['hookEventName', 'hook_event_name', 'eventName', 'event_name'], 100)
    || eventName || 'unknown';
  const isStatus = source === 'statusline' || eventName === 'status';
  const usage = copilotUsage(payload, isStatus ? 'sample' : 'increment');
  // Only when the per-call gauge is absent, so a provider that reports both is
  // never counted twice.
  const cumulative = hasUsage(usage) ? undefined : copilotCumulativeUsage(payload);
  const billing = copilotBilling(payload);
  const amount = firstNumber(payload, ['cost_usd', 'costUsd', 'usage.cost_usd', 'usage.costUsd']);
  // Copilot's `cost` block holds durations, line counts, and premium-request
  // counts - no currency. Only an explicitly named USD field is a cost here.
  const cumulativeCost = firstNumber(payload, ['total_cost_usd', 'totalCostUsd', 'cost.total_cost_usd']);
  const session = sessionIdentity(payload);
  const turn = turnIdentity(payload);
  const model = config.privacy.storeModelNames ? copilotModel(payload) : undefined;
  const toolName = config.privacy.storeToolNames
    ? firstString(payload, ['toolName', 'tool_name', 'tool.name'], 120) : undefined;
  return [makeEvent({
    agent: 'copilot',
    ts: timestamp(payload),
    source,
    kind: isStatus ? 'usage' : actualName.toLowerCase().includes('subagent') ? 'subagent' : 'lifecycle',
    event_name: actualName,
    session_id: session,
    turn_id: turn,
    model,
    project_id: projectIdentity(payload, config),
    tool_name: toolName,
    subagent_type: firstString(payload, ['agentType', 'agent_type', 'subagentType'], 120),
    status: firstString(payload, ['status', 'reason', 'errorType'], 80),
    usage: hasUsage(usage) ? usage : undefined,
    usage_cumulative: hasUsage(usage) ? undefined : cumulative,
    billing_cumulative: billing,
    cost: cumulativeCost !== undefined
      ? { cumulative_usd: cumulativeCost, basis: 'provider_reported', currency: 'USD' }
      : amount !== undefined
        ? { amount_usd: amount, basis: 'provider_reported', currency: 'USD' }
        : undefined,
    context: contextFields(payload),
    metrics: metrics(payload, config),
    flags: {
      cost_cumulative: cumulativeCost !== undefined,
      usage_cumulative: cumulative !== undefined,
      billing_cumulative: billing !== undefined
    },
    fingerprint: (isStatus || turn || timestamp(payload) || firstValue(payload, ['eventId', 'event_id']))
      ? fingerprint(['copilot', actualName, session, turn, model, usage, cumulative, billing, amount, cumulativeCost, timestamp(payload), toolName, contextFields(payload), metrics(payload, config)])
      : undefined
  })];
}
