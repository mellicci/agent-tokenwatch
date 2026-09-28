import { formatDuration } from './time.mjs';

export function compactNumber(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs < 10_000_000_000 ? 1 : 0)}b`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return String(Math.round(value));
}

export function money(value, estimated = false) {
  if (!Number.isFinite(value)) return 'n/a';
  let digits = 2;
  if (value < 1) digits = 3;
  if (value < 0.01) digits = 4;
  return `${estimated ? '~' : ''}$${value.toFixed(digits)}`;
}

// A provider that bills in its own units rather than currency. The unit is
// always named, because an unlabelled 17.18 beside a dollar figure elsewhere on
// the line would read as money.
const UNIT_LABELS = { aiu: 'AIU', premium_requests: 'premium reqs' };

export function billingValue(units, unit) {
  const value = units?.[unit];
  if (!Number.isFinite(value)) return undefined;
  const digits = Number.isInteger(value) ? 0 : value < 1 ? 3 : 2;
  return `${value.toFixed(digits)} ${UNIT_LABELS[unit] ?? unit}`;
}

function agentLabel(agent) {
  return ({ 'claude-code': 'Claude', 'codex-cli': 'Codex', 'github-copilot-cli': 'Copilot' })[agent] ?? agent;
}

// There is deliberately no truncation helper here any more. `fit()` below is
// the whole width strategy: it drops whole cells, lowest priority first, until
// a row fits, which is what the README promises - a short row means "not
// shown", never "cut off".
//
// Known gap, left as it is rather than papered over: `fit()` counts the lead
// cell in the width but never drops or shortens it, and the lead is the model
// name. A model name at the 160-character cap `safeIdentifier` allows renders a
// 211-column row at COLUMNS=80 and wraps. A dead `truncate()` used to sit here
// and read like a defence against exactly that, which is worse than nothing,
// because it answered the question without doing anything.

// The provider prefix is redundant once the family and size are shown.
function shortModel(model) {
  if (!model) return undefined;
  return String(model).replace(/^claude-/, '').replace(/^models\//, '');
}

const ANSI = {
  reset: '\u001b[0m',
  magenta: '\u001b[35m',
  brightMagenta: '\u001b[95m',
  white: '\u001b[97m',
  bold: '\u001b[1m'
};

// Flat line-art glyphs of even stroke weight, each chosen for what it denotes:
// a ring for the model, a prompt chevron for the current turn, a filled column
// for context consumed, a grid for the cache, and a dial for time remaining.
const ICONS = {
  model: '⌬', turn: '❯', session: 'Σ',
  context: '▥', input: '↑', inflight: '◐', cache: '⊞', warm: '◴', output: '↓', subagents: '⑃'
};

// Each row opens with a label naming what the row is about, so a reader does not
// have to infer the grouping. Labels are padded to a common width, which is what
// makes the value columns line up across rows.
const ROW_ORDER = ['session', 'cache', 'agents'];
const ROW_LABELS = { cache: 'Tokens', agents: 'Subagents' };
const ROW_ICONS = { session: 'model', cache: 'cache', agents: 'subagents' };

// Claude Code cannot expose the terminal to the script, so it sets COLUMNS
// instead. Prefer it over a fixed width so the line fits the real terminal.
function widthFor(status, env) {
  const columns = Number(env.COLUMNS);
  if (Number.isFinite(columns) && columns > 20) return columns;
  return Number(status.maxWidth) || 160;
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function colorEnabled(status, env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return status.color !== false;
}

function paint(text, code, enabled) {
  return enabled && text ? `${code}${text}${ANSI.reset}` : text;
}

// Escape sequences occupy no columns, so width must be measured on the plain text.
function visibleLength(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

// A ratio that rounds to 100% while tokens are still being read fresh reads as
// implausible. Keep a decimal in the high band so the number stays believable.
function percentLabel(ratio) {
  const percent = Math.max(0, Math.min(100, ratio * 100));
  // Only an exact whole may print as 100%. Rounding a near-miss up to 100 while
  // uncached tokens are visible on the same line is what made this untrustworthy.
  if (percent >= 100) return '100%';
  if (percent > 99.9) return '99.9%';
  if (percent >= 99) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function formatStatus(snapshot, config, env = process.env) {
  const latest = snapshot.latest;
  const status = config.status ?? {};
  const color = colorEnabled(status, env);
  const icons = status.icons !== false;
  const iconFor = (name) => String(status.iconOverrides?.[name] ?? ICONS[name]);
  const glyph = (name) => (icons && name ? `${iconFor(name)} ` : '');
  const modelName = capitalize(shortModel(latest?.model) ?? agentLabel(snapshot.agent));

  // A host that renders our stdout cannot tell an empty line from a command it
  // never ran, so there is always something to print. Copilot CLI trims stdout
  // and shows nothing at all for a blank line, which reads as "not installed".
  const placeholder = () => {
    const head = `${glyph('model')}${paint(`TW ${agentLabel(snapshot.agent)}`, `${ANSI.bold}${ANSI.brightMagenta}`, color)}`;
    return `${head} · no local usage yet`;
  };
  if (!latest) return placeholder();

  // Lower rank survives longer when a row has to shrink.
  const fields = [];
  const segment = (part, painted) => {
    const lead = `${glyph(part.icon)}`;
    const label = part.label ? `${part.label} ` : '';
    if (!painted) return `${lead}${label}${part.value}`.trim();
    return `${paint(lead.trimEnd(), ANSI.magenta, color)}${lead ? ' ' : ''}${label}${paint(String(part.value), `${ANSI.bold}${ANSI.white}`, color)}`.trim();
  };
  const add = (row, rank, parts) => {
    const present = parts.filter((part) => part.value !== undefined && part.value !== null && part.value !== '');
    if (!present.length) return;
    fields.push({
      row,
      rank,
      plain: present.map((part) => segment(part, false)).join(' · '),
      painted: present.map((part) => segment(part, true)).join(' · ')
    });
  };

  // Context and session spend are both "where this session stands", so they share
  // a cell rather than being split by a column divider.
  const contextValue = status.showContext !== false && latest.context?.percent !== undefined
    ? `${Math.round(latest.context.percent)}%` : undefined;
  const sessionValue = status.showSession === false ? undefined
    : Number.isFinite(snapshot.session_cost_usd) ? money(snapshot.session_cost_usd)
      : billingValue(snapshot.session_billing, 'aiu');
  let warmValue;
  if (status.showCache !== false && snapshot.cache_ttl_source === 'provider_reported'
      && Number.isFinite(snapshot.cache_age_seconds) && Number.isFinite(snapshot.cache_ttl_seconds)) {
    const remaining = snapshot.cache_ttl_seconds - snapshot.cache_age_seconds;
    warmValue = remaining > 0 ? formatDuration(remaining) : 'cold';
  }
  // Quota consumption in the provider's own unit, shown beside the session total
  // only when the provider reports no currency at all.
  const quotaValue = status.showCost !== false && !Number.isFinite(snapshot.session_cost_usd)
    ? billingValue(snapshot.session_billing, 'premium_requests') : undefined;
  add('session', 2, [
    { icon: 'context', label: 'ctx', value: contextValue },
    { icon: 'session', label: 'session', value: sessionValue },
    { icon: '', label: '', value: quotaValue },
    { icon: 'warm', label: 'cache warm', value: warmValue }
  ]);

  if (status.showCost !== false) {
    const isEstimate = snapshot.current_cost_basis === 'configured_estimate';
    // The unit is one prompt and the whole reply to it, however many tool calls
    // that takes. "so far" marks the running one as still climbing.
    add('session', 1, [
      {
        icon: 'inflight',
        label: 'this reply',
        value: Number.isFinite(snapshot.in_flight_cost_usd)
          ? `${money(snapshot.in_flight_cost_usd, isEstimate)} so far`
          : billingValue(snapshot.in_flight_billing, 'aiu')
            && `${billingValue(snapshot.in_flight_billing, 'aiu')} so far`
      },
      {
        icon: 'turn',
        label: 'previous reply',
        value: Number.isFinite(snapshot.last_prompt_cost_usd)
          ? money(snapshot.last_prompt_cost_usd, isEstimate)
          : billingValue(snapshot.last_prompt_billing, 'aiu')
      }
    ]);
  }

  if (status.showTokens !== false && latest.usage) {
    const usage = latest.usage;
    const total = usage.input_total ?? 0;
    if (total > 0) {
      // Reads as a sentence: how much went up, then how that amount was billed.
      // Naming the direction of each cache movement avoids the metaphors
      // ("banked", "written") that readers had to ask about.
      const parts = [{ icon: 'input', label: '', value: `${compactNumber(total)} sent` }];
      if (status.showCache !== false) {
        // A cache write is a miss that was stored, not a hit. Counting writes as
        // hits is what made this field read 100% on every turn.
        parts.push({ icon: '', label: '', value: `${percentLabel((usage.cache_read ?? 0) / total)} from cache` });
        const write = usage.cache_write ?? 0;
        if (write > 0) parts.push({ icon: '', label: '', value: `${compactNumber(write)} added to cache` });
      }
      add('cache', 3, parts);
    }
    if (usage.output !== undefined) {
      add('cache', 5, [{ icon: 'output', label: '', value: `${compactNumber(usage.output)} output` }]);
    }
  }
  if (status.showSubagents !== false && snapshot.subagent_count) {
    const heading = status.layout === 'multi';
    add('agents', 5, [{
      icon: heading ? '' : 'subagents',
      label: heading ? '' : 'subagents',
      value: `${snapshot.subagent_count} completed`
    }]);
    if (Number.isFinite(snapshot.subagent_cost_share)) {
      add('agents', 9, [{ icon: '', label: '', value: `${percentLabel(snapshot.subagent_cost_share)} of session cost` }]);
    }
  }

  const maxWidth = widthFor(status, env);
  const separator = paint(' │ ', ANSI.magenta, color);
  const fit = (members, leadPlain) => {
    const width = (rows) => visibleLength([leadPlain, ...rows.map((row) => row.plain)].filter(Boolean).join(' │ '));
    const byRank = [...members].sort((a, b) => a.rank - b.rank);
    let visible = [...byRank];
    while (visible.length && width(visible) > maxWidth) visible.pop();
    return members.filter((member) => visible.includes(member));
  };

  const pad = (text, plain, target) => `${text}${' '.repeat(Math.max(0, target - visibleLength(plain)))}`;
  const joinRow = (leadPainted, cells, widths) => [
    leadPainted,
    ...cells.map((cell, index) => (widths && index < cells.length - 1
      ? pad(cell.painted, cell.plain, widths[index]) : cell.painted))
  ].filter(Boolean).join(separator);

  // An event with no renderable field at all - a lifecycle hook before any usage
  // has been reported - leaves every row empty.
  if (!fields.length) return placeholder();

  if (status.layout !== 'multi') {
    const head = `${glyph('model')}${paint(modelName, `${ANSI.bold}${ANSI.brightMagenta}`, color)}`;
    return joinRow(head, fit(fields, `${glyph('model')}${modelName}`));
  }

  // In multi-row mode the row label doubles as the grouping heading. Padding the
  // labels to one width, then each cell to its column's width, turns the rows
  // into an aligned grid instead of three ragged lines.
  // The session row carries the model name as its label, so it is always active:
  // an agent that reports tokens but neither context nor cost still has to say
  // which model produced them.
  const active = ROW_ORDER.filter((row) => row === 'session' || fields.some((field) => field.row === row));
  const lead = (row) => (icons ? `${iconFor(ROW_ICONS[row])}  ` : '');
  const labelPlain = (row) => `${lead(row)}${row === 'session' ? modelName : ROW_LABELS[row]}`;
  const labelWidth = Math.max(...active.map((row) => visibleLength(labelPlain(row))));

  const rows = active.map((row) => {
    const plain = labelPlain(row);
    const tone = row === 'session' ? `${ANSI.bold}${ANSI.brightMagenta}` : ANSI.magenta;
    const text = `${paint(lead(row).trimEnd(), ANSI.magenta, color)}${icons ? '  ' : ''}${paint(row === 'session' ? modelName : ROW_LABELS[row], tone, color)}`;
    return { row, leadPlain: pad(plain, plain, labelWidth), leadPainted: pad(text, plain, labelWidth), cells: fit(fields.filter((field) => field.row === row), plain) };
    // The session row's label is the model name, so it stays even with no cells:
    // an agent that reports tokens but no context or cost - Codex - would
    // otherwise render a token row with nothing saying which model produced it.
  }).filter((row) => row.cells.length || row.row === 'session');

  const columns = [];
  for (const row of rows) {
    row.cells.forEach((cell, index) => {
      columns[index] = Math.max(columns[index] ?? 0, visibleLength(cell.plain));
    });
  }
  // Alignment adds width, so fall back to ragged rows rather than overflow.
  const alignedFits = status.align !== false && rows.every((row) => {
    const width = visibleLength(row.leadPlain)
      + row.cells.reduce((total, cell, index) => total + (index < row.cells.length - 1 ? columns[index] : visibleLength(cell.plain)) + 3, 0);
    return width <= maxWidth;
  });

  if (!rows.length) return placeholder();
  return rows.map((row) => joinRow(row.leadPainted, row.cells, alignedFits ? columns : undefined)).join('\n');
}

export function jsonString(value) { return `${JSON.stringify(value, null, 2)}\n`; }
