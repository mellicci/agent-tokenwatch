import { normalizeClaude } from './claude.mjs';
import { normalizeCodexNotify, normalizeCodexOtlpLogs, normalizeCodexOtlpMetrics } from './codex.mjs';
import { normalizeCopilot } from './copilot.mjs';

export function normalizeAgentPayload(agent, eventName, payload, config, source = 'hook') {
  switch (agent) {
    case 'claude': return normalizeClaude(eventName, payload, config, source);
    case 'copilot': return normalizeCopilot(eventName, payload, config, source);
    case 'codex': return normalizeCodexNotify(eventName, payload, config);
    default: throw new Error(`Unsupported agent: ${agent}`);
  }
}

export function normalizeOtlp(pathname, payload, config) {
  if (pathname.endsWith('/metrics')) return normalizeCodexOtlpMetrics(payload, config);
  return normalizeCodexOtlpLogs(payload, config);
}
