import { aggregateEvents, groupTurns } from './aggregate.mjs';
import { compactNumber, money } from './format.mjs';

function mean(values) {
  const filtered = values.filter(Number.isFinite);
  return filtered.length ? filtered.reduce((a, b) => a + b, 0) / filtered.length : undefined;
}
function median(values) {
  const filtered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!filtered.length) return undefined;
  const middle = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[middle] : (filtered[middle - 1] + filtered[middle]) / 2;
}
function p95(values) {
  const filtered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!filtered.length) return undefined;
  return filtered[Math.min(filtered.length - 1, Math.ceil(filtered.length * 0.95) - 1)];
}
function pct(value) { return `${(value * 100).toFixed(0)}%`; }

function sessionGroups(turns) {
  const map = new Map();
  turns.forEach((turn) => {
    const key = `${turn.agent}|${turn.session_id ?? 'unknown'}`;
    const list = map.get(key) ?? [];
    list.push(turn);
    map.set(key, list);
  });
  return [...map.entries()].map(([key, list]) => ({ key, turns: list.sort((a, b) => new Date(a.last_ts) - new Date(b.last_ts)) }));
}

function inputGrowth(sessions) {
  const rows = [];
  for (const session of sessions) {
    const values = session.turns.map((turn) => turn.usage.input_total).filter(Number.isFinite);
    if (values.length < 8) continue;
    const quarter = Math.max(2, Math.floor(values.length / 4));
    const early = mean(values.slice(0, quarter));
    const late = mean(values.slice(-quarter));
    if (early > 0) rows.push({ key: session.key, turns: values.length, early, late, ratio: late / early });
  }
  return rows;
}

function coldResumeEvidence(sessions, ttlSeconds) {
  let gaps = 0;
  let costlyGaps = 0;
  for (const session of sessions) {
    for (let i = 1; i < session.turns.length; i += 1) {
      const prior = session.turns[i - 1];
      const current = session.turns[i];
      const gap = (new Date(current.first_ts) - new Date(prior.last_ts)) / 1000;
      if (gap <= ttlSeconds) continue;
      gaps += 1;
      const currentFresh = current.usage.input_fresh ?? current.usage.input_total ?? 0;
      const priorFresh = prior.usage.input_fresh ?? prior.usage.input_total ?? 0;
      if (currentFresh >= Math.max(5_000, priorFresh * 1.25)) costlyGaps += 1;
    }
  }
  return { gaps, costlyGaps };
}

function confidence(sample, strong = 20) {
  if (sample >= strong) return 'high';
  if (sample >= Math.max(3, strong / 4)) return 'medium';
  return 'low';
}

export function analyzeEvents(events, config, { since } = {}) {
  const aggregate = aggregateEvents(events);
  const turns = groupTurns(events);
  const sessions = sessionGroups(turns);
  const observations = [];
  const recommendations = [];

  // Imported turns are tokens only, with no provider cost; said wherever a
  // total includes them, with how many were verified (intent 06, D4).
  const imported = aggregate.imported_turns
    ? ` ${aggregate.imported_turns} turns were imported from session files (tokens only, no provider cost; ${aggregate.imported_turns - aggregate.imported_unverified_turns} verified, ${aggregate.imported_unverified_turns} unverified).`
    : '';
  observations.push({
    id: 'coverage',
    evidence: `${aggregate.turns} turns across ${aggregate.session_count} identified sessions; ${aggregate.increment_turns} carry additive per-call token counts and ${aggregate.context_samples.turns} carry latest-call gauge samples. ${aggregate.cost.provider_turns} have provider-reported cost and ${aggregate.cost.estimated_turns} have configured estimates.${imported}`,
    confidence: aggregate.turns ? 'high' : 'low'
  });
  if (aggregate.context_samples.turns) {
    observations.push({
      id: 'context-size',
      evidence: `Latest-call context samples: median ${compactNumber(aggregate.context_samples.input_median)} tokens, p95 ${compactNumber(aggregate.context_samples.input_p95)}, max ${compactNumber(aggregate.context_samples.input_max)}. These are gauges of one call each and are deliberately not summed into a period total.`,
      confidence: confidence(aggregate.context_samples.turns)
    });
  }
  // A provider whose token deltas are correctly additive (Copilot's cumulative
  // counters, diffed into increments) reports almost none of context_samples
  // above, because that field is deliberately gated on usage.basis === 'sample'
  // to avoid double-counting token gauges as increments. Context-window percent
  // is not a token count and carries no such risk, so it is reported here from
  // every turn that has one, regardless of usage.basis.
  if (aggregate.context_percent_samples.turns) {
    observations.push({
      id: 'context-percent',
      evidence: `Context-window percent samples: ${aggregate.context_percent_samples.turns} turns; median ${Math.round(aggregate.context_percent_samples.percent_median)}%, p95 ${Math.round(aggregate.context_percent_samples.percent_p95)}%, max ${Math.round(aggregate.context_percent_samples.percent_max)}%, latest ${Math.round(aggregate.context_percent_samples.percent_last)}%.`,
      confidence: confidence(aggregate.context_percent_samples.turns)
    });
  }

  if (aggregate.cache.ratio_turns > 0) {
    observations.push({
      id: 'cache-share',
      evidence: `Averaged across ${aggregate.cache.ratio_turns} turns, input tokens were ${pct(aggregate.cache.read_share)} served from cache, ${pct(aggregate.cache.write_share)} newly written to cache, and ${pct(aggregate.cache.fresh_share)} fresh. A cache write is a miss that was stored, so it is counted separately from a hit.`,
      confidence: confidence(aggregate.cache.ratio_turns)
    });
    if (aggregate.cache.ratio_turns >= 5 && aggregate.cache.read_share < 0.3) {
      recommendations.push({
        id: 'stabilize-prefix',
        priority: 'high',
        evidence: `Only ${pct(aggregate.cache.read_share)} of input tokens were served from cache, averaged across ${aggregate.cache.ratio_turns} turns.`,
        inference: 'The static prefix may be changing, caching may be disabled, or sessions may be going cold.',
        action: 'Keep stable instructions, tools, and settings at the front of the session; move volatile content later; inspect tool/MCP toggles and timestamps in cached material.',
        confidence: confidence(aggregate.cache.ratio_turns)
      });
    }
  }

  const growth = inputGrowth(sessions);
  const growing = growth.filter((row) => row.ratio >= 1.5 && row.late - row.early >= 5_000);
  if (growing.length) {
    const ratio = median(growing.map((row) => row.ratio));
    recommendations.push({
      id: 'control-context-growth',
      priority: 'high',
      evidence: `${growing.length} sessions with at least 8 turns ended with roughly ${ratio.toFixed(1)}× the early-turn input footprint.`,
      inference: 'Long-lived context is being re-sent and may include stale material.',
      action: 'Use `/clear` between unrelated tasks and compact during a coherent task while the context is still recoverable, rather than waiting for the limit.',
      confidence: confidence(growing.length, 8)
    });
  }

  const compactEvents = events.filter((event) => event.kind === 'compact' || /compact/i.test(event.event_name ?? ''));
  const compactPercents = compactEvents.map((event) => event.context?.percent).filter(Number.isFinite);
  if (compactPercents.length) {
    const med = median(compactPercents);
    observations.push({
      id: 'compact-timing',
      evidence: `${compactPercents.length} compactions had context measurements; median context use at compaction was ${med.toFixed(0)}%.`,
      confidence: confidence(compactPercents.length, 8)
    });
    if (med >= 80) {
      recommendations.push({
        id: 'compact-earlier',
        priority: 'medium',
        evidence: `Median measured context at compaction was ${med.toFixed(0)}%.`,
        inference: 'Late summaries have more material to compress and may discard important details.',
        action: 'Try a project-specific warning near 50–60% context and compare continuity and cost over several sessions.',
        confidence: confidence(compactPercents.length, 8)
      });
    }
  }

  const cold = coldResumeEvidence(sessions, Number(config.cacheTtlSeconds) || 300);
  if (cold.gaps) {
    observations.push({
      id: 'ttl-gaps',
      evidence: `${cold.gaps} within-session gaps exceeded the configured ${config.cacheTtlSeconds}s cache TTL; ${cold.costlyGaps} were followed by a materially larger fresh-input observation.`,
      confidence: confidence(cold.gaps, 10)
    });
    if (cold.costlyGaps >= 2) {
      recommendations.push({
        id: 'resume-from-summary',
        priority: 'medium',
        evidence: `${cold.costlyGaps} cold gaps were followed by at least 5k fresh tokens and a ≥25% increase over the prior turn.`,
        inference: 'Resuming an old session may be repaying a large cold prefix.',
        action: 'Before a long break, save a concise state summary; after the break, compare resuming the old session with starting from that summary.',
        confidence: confidence(cold.costlyGaps, 6)
      });
    }
  }

  const toolOutputs = events.map((event) => event.metrics?.tool_output_bytes).filter(Number.isFinite);
  const subagentStops = events.filter((event) => event.kind === 'subagent' && /stop|end|complete/i.test(event.event_name ?? '')).length;
  if (toolOutputs.length) {
    const high = p95(toolOutputs);
    observations.push({
      id: 'tool-output-size',
      evidence: `Recorded tool outputs: median ${compactNumber(median(toolOutputs))}B, p95 ${compactNumber(high)}B; ${subagentStops} completed subagents were observed.`,
      confidence: confidence(toolOutputs.length)
    });
    if (high >= 50_000 && subagentStops === 0) {
      recommendations.push({
        id: 'filter-or-delegate-output',
        priority: 'high',
        evidence: `Tool-output p95 was ${compactNumber(high)}B and no completed subagent was observed.`,
        inference: 'Large logs or search results may be entering the main context unfiltered.',
        action: 'Filter logs/tests before the agent reads them, or delegate verbose inspection to a subagent that returns only a concise result.',
        confidence: confidence(toolOutputs.length)
      });
    }
  }

  const modelRows = Object.entries(aggregate.models).sort((a, b) => b[1].turns - a[1].turns);
  if (modelRows.length > 1) {
    observations.push({
      id: 'model-mix',
      evidence: modelRows.map(([model, row]) => `${model}: ${row.turns} turns`).join('; '),
      confidence: 'high'
    });
    recommendations.push({
      id: 'review-model-routing',
      priority: 'low',
      evidence: `${modelRows.length} models were recorded.`,
      inference: 'Model routing may be an optimization lever, but telemetry does not reveal task difficulty.',
      action: 'Label a small sample of turns by task difficulty, then reserve the most capable/expensive model for hard blockers rather than applying a blanket downgrade.',
      confidence: 'medium'
    });
  }

  if (!aggregate.cost.provider_turns && !aggregate.cost.estimated_turns) {
    recommendations.push({
      id: 'enable-cost-basis',
      priority: 'medium',
      evidence: 'No per-turn cost observations are available.',
      inference: 'Token trends are measurable, but dollar comparisons are not.',
      action: 'Prefer provider-reported cost. Where only tokens are available, add a dated local pricing file and keep estimates separate from reported charges.',
      confidence: 'high'
    });
  }

  if (!recommendations.length) {
    recommendations.push({
      id: 'collect-more',
      priority: 'low',
      evidence: 'No configured threshold was crossed.',
      inference: 'This does not prove the workflow is optimal; evidence may be sparse or healthy.',
      action: 'Collect at least 20 representative turns, then rerun the audit and compare by agent, model, and project.',
      confidence: aggregate.turns >= 20 ? 'medium' : 'low'
    });
  }

  return {
    schema: 'tokenwatch.audit/v1',
    generated_at: new Date().toISOString(),
    period: { since: since ?? aggregate.first_ts, until: aggregate.last_ts },
    aggregate: { ...aggregate, turns_data: undefined },
    observations,
    recommendations,
    methodology: {
      provider_costs_and_estimates_separated: true,
      savings_claims: 'none_without_counterfactual_measurement',
      content_inspected: false,
      configured_cache_ttl_seconds: Number(config.cacheTtlSeconds)
    }
  };
}

export function formatAuditMarkdown(report) {
  const a = report.aggregate;
  const lines = [
    '# Tokenwatch cost audit', '',
    `Generated: ${report.generated_at}`,
    `Period: ${report.period.since ?? 'first event'} → ${report.period.until ?? 'latest event'}`, '',
    '## Measured totals', '',
    `- ${a.turns} turns across ${a.session_count} identified sessions.`,
    `- Additive per-call tokens (${a.increment_turns} turns): ${compactNumber(a.tokens.input_total)} input total; ${compactNumber(a.tokens.input_fresh)} fresh; ${compactNumber(a.tokens.cache_read)} cache reads; ${compactNumber(a.tokens.cache_write)} cache writes; ${compactNumber(a.tokens.output)} output.`,
    `- Latest-call gauge samples (${a.context_samples.turns} turns): median ${compactNumber(a.context_samples.input_median)} input, p95 ${compactNumber(a.context_samples.input_p95)}, max ${compactNumber(a.context_samples.input_max)}. Not summed; each sample re-describes one call.`,
    `- Context-window percent (${a.context_percent_samples.turns} turns): median ${a.context_percent_samples.percent_median !== undefined ? Math.round(a.context_percent_samples.percent_median) : 'n/a'}%, p95 ${a.context_percent_samples.percent_p95 !== undefined ? Math.round(a.context_percent_samples.percent_p95) : 'n/a'}%, max ${a.context_percent_samples.percent_max !== undefined ? Math.round(a.context_percent_samples.percent_max) : 'n/a'}%.`,
    `- Provider-reported cost: ${money(a.cost.provider_reported_usd)} across ${a.cost.provider_turns} observations.`,
    `- Configured estimate: ${money(a.cost.configured_estimate_usd, true)} across ${a.cost.estimated_turns} observations.`, '',
    'Provider-reported charges and local estimates are intentionally not added together.', '',
    '## Observations', ''
  ];
  for (const observation of report.observations) {
    lines.push(`### ${observation.id}`, '', observation.evidence, '', `Confidence: ${observation.confidence}.`, '');
  }
  lines.push('## Recommended experiments', '');
  for (const recommendation of report.recommendations) {
    lines.push(
      `### ${recommendation.id} (${recommendation.priority} priority)`, '',
      `**Evidence:** ${recommendation.evidence}`, '',
      `**Inference:** ${recommendation.inference}`, '',
      `**Action:** ${recommendation.action}`, '',
      `Confidence: ${recommendation.confidence}.`, ''
    );
  }
  lines.push('## Guardrails', '',
    '- The audit inspected aggregates and structural lengths, not prompts, code, transcripts, tool contents, or file paths.',
    '- It does not invent prices or claim savings without a measured counterfactual.',
    '- Cache TTL is the local configured assumption unless an adapter reports a provider value.',
    '- Gauge samples and additive per-call counts are reported separately and never summed together.', '');
  return `${lines.join('\n')}\n`;
}
