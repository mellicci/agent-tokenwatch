const COLUMNS = [
  'ts', 'agent', 'kind', 'source', 'event_name', 'session_id', 'turn_id', 'model', 'project_id',
  'input_total', 'input_fresh', 'cache_read', 'cache_write', 'output', 'reasoning',
  'cost_usd', 'cost_basis', 'context_percent', 'tool_name', 'subagent_type',
  'usage_basis', 'import_mapping', 'import_verification'
];

// A cell beginning with one of these is evaluated as a formula by Excel,
// LibreOffice and Sheets when someone opens the export. Model, tool and event
// names come from the agent, so their first character is not ours to trust. A
// leading apostrophe makes the cell literal text. A plain negative number is
// left alone, since that is the one legitimate reason a cell starts with `-`.
function neutralizeFormula(text) {
  if (/^[=+@\t\r]/.test(text)) return `'${text}`;
  if (text.startsWith('-') && !Number.isFinite(Number(text))) return `'${text}`;
  return text;
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = neutralizeFormula(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function eventsToCsv(events) {
  const lines = [COLUMNS.join(',')];
  for (const event of events) {
    const row = {
      ts: event.ts, agent: event.agent, kind: event.kind, source: event.source,
      event_name: event.event_name, session_id: event.session_id, turn_id: event.turn_id,
      model: event.model, project_id: event.project_id,
      input_total: event.usage?.input_total, input_fresh: event.usage?.input_fresh,
      cache_read: event.usage?.cache_read, cache_write: event.usage?.cache_write,
      output: event.usage?.output, reasoning: event.usage?.reasoning,
      cost_usd: event.cost?.delta_usd ?? event.cost?.amount_usd,
      cost_basis: event.cost?.basis, context_percent: event.context?.percent,
      tool_name: event.tool_name, subagent_type: event.subagent_type,
      usage_basis: event.usage?.basis, import_mapping: event.import?.mapping_id, import_verification: event.import?.verification
    };
    lines.push(COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
