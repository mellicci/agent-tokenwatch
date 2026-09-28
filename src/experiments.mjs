import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './fs-util.mjs';

// An audit that proposes a controlled change and then forgets it is giving
// advice, not gathering evidence. The journal is append-only for the same reason
// the event ledger is: several sessions may write it, and a record that was
// already made must never be rewritten by a later one.

const OPEN = 'open';
const RESULTS = new Set(['adopted', 'rejected', 'inconclusive']);

export function experimentsFile(config) {
  return config.experimentsFile || path.join(path.dirname(config.dataFile), 'experiments.jsonl');
}

function readRecords(config) {
  const file = experimentsFile(config);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function appendRecord(config, record) {
  const file = experimentsFile(config);
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

// Journal text is prose a person wrote, and two skills tell the agent to run
// `experiment list` and read the result. So it is text that reaches a model's
// reasoning, which makes an unbounded, unescaped field the wrong shape for it:
// a newline lets planted text pose as separate output lines, and a control
// character can rewrite what a terminal shows. Neither is a boundary on its
// own - the journal is the user's own file - but the event ledger bounds its
// records and this had no bound at all.
const MAX_FIELD = 500;

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

function requireText(value, field) {
  const text = cleanText(value);
  if (!text) throw new Error(`experiment add requires --${field}`);
  return text;
}

export function addExperiment(config, input = {}) {
  const record = {
    schema: 'tokenwatch.experiment/v1',
    id: input.id || `exp-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`,
    op: 'open',
    opened_at: new Date().toISOString(),
    hypothesis: requireText(input.hypothesis, 'hypothesis'),
    change: requireText(input.change, 'change'),
    // Without a baseline recorded up front, a later reading has nothing to be
    // measured against and the experiment can only produce an impression.
    baseline: requireText(input.baseline, 'baseline'),
    metric: requireText(input.metric, 'metric'),
    guardrail: cleanText(input.guardrail) || undefined,
    rollback: cleanText(input.rollback) || undefined,
    sample: cleanText(input.sample) || undefined,
    agent: cleanText(input.agent) || undefined,
    project_id: cleanText(input.projectId) || undefined
  };
  return appendRecord(config, record);
}

export function closeExperiment(config, id, { result, outcome } = {}) {
  if (!id) throw new Error('experiment close requires an id');
  const known = listExperiments(config, { status: 'all' });
  const existing = known.find((row) => row.id === id);
  if (!existing) throw new Error(`No experiment with id ${id}. Run "tokenwatch experiment list" to see open ones.`);
  if (existing.status !== OPEN) throw new Error(`Experiment ${id} is already closed as ${existing.result}.`);
  const normalized = String(result || 'inconclusive').toLowerCase();
  if (!RESULTS.has(normalized)) throw new Error(`result must be one of ${[...RESULTS].join(', ')}`);
  return appendRecord(config, {
    schema: 'tokenwatch.experiment/v1',
    id,
    op: 'close',
    closed_at: new Date().toISOString(),
    result: normalized,
    outcome: requireText(outcome, 'outcome')
  });
}

// Reduce the append-only log to current state. A close applies to the open
// record with the same id; anything else is ignored rather than throwing, so a
// journal written by a newer version stays readable.
export function listExperiments(config, { status = OPEN } = {}) {
  const byId = new Map();
  for (const record of readRecords(config)) {
    if (record.op === 'open') {
      byId.set(record.id, { ...record, status: OPEN, op: undefined });
    } else if (record.op === 'close' && byId.has(record.id)) {
      byId.set(record.id, { ...byId.get(record.id), status: 'closed', result: record.result, outcome: record.outcome, closed_at: record.closed_at });
    }
  }
  const rows = [...byId.values()].sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
  if (status === 'all') return rows;
  return rows.filter((row) => row.status === status);
}

export function formatExperiments(rows, status = OPEN) {
  if (!rows.length) {
    return status === 'all'
      ? 'No experiments recorded.\n'
      : `No ${status} experiments. Use --all to include closed ones.\n`;
  }
  const lines = [];
  for (const row of rows) {
    const age = Math.floor((Date.now() - new Date(row.opened_at)) / 86_400_000);
    lines.push(`${row.id}  [${row.status}${row.result ? `: ${row.result}` : ''}]  opened ${age}d ago`);
    lines.push(`  hypothesis  ${row.hypothesis}`);
    lines.push(`  change      ${row.change}`);
    lines.push(`  baseline    ${row.baseline}`);
    lines.push(`  metric      ${row.metric}`);
    if (row.guardrail) lines.push(`  guardrail   ${row.guardrail}`);
    if (row.rollback) lines.push(`  rollback    ${row.rollback}`);
    if (row.sample) lines.push(`  sample      ${row.sample}`);
    if (row.outcome) lines.push(`  outcome     ${row.outcome}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
