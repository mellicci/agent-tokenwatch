import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { identifierOrUndefined } from '../src/privacy.mjs';
import { readSessionRecords } from '../src/import/reader.mjs';
import { validateMapping } from '../src/import/mapping.mjs';
import { applyMapping, readContext } from '../src/import/apply.mjs';
import { tempDir } from './helpers.mjs';

// Intent 06: `tokenwatch import` reads an agent's session files, which hold the
// user's prompts, replies and code, and keeps numbers only. These cases pin the
// pieces that stand between those files and the ledger.

const SALT = 'a'.repeat(64);

function minimalMapping(extra = {}) {
  return {
    mapping_id: 'test-jsonl-1', mapping_version: '1.0', agent: 'claude',
    evidence: { agent_version: 'test', probed_on: '2026-09-25' },
    file: { glob: '**/*.jsonl', line_format: 'jsonl' },
    record: {
      select: [{ path: 'type', equals: 'assistant' }],
      ts: 'timestamp', session_id: 'sessionId', response_id: 'message.id', model: 'message.model', project_path: 'cwd',
      usage: { input_fresh: { path: 'message.usage.input_tokens' }, output: { path: 'message.usage.output_tokens' } }
    },
    semantics: 'components', usage_mode: 'per_call', authority: 'per_call', overlap: { compare: 'last_call_per_turn' },
    ...extra
  };
}

test('a session-file identifier is kept only when it has an identifier shape, and rejected rather than scrubbed', () => {
  for (const kept of ['0b1c9d6e-5f2a-4d3b-8c7e-1a2b3c4d5e6f', 'claude-opus-5-5', 'msg_01ABCdef', 'gpt-5.6-luna', 42]) {
    assert.equal(identifierOrUndefined(kept), String(kept), `kept: ${kept}`);
  }
  for (const rejected of ['fix login bug', '/home/me/project', 'C:\\Users\\me\\x', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'please refactor the whole login page now', '', ' leading', 'a'.repeat(200), null, {}, ['id']]) {
    assert.equal(identifierOrUndefined(rejected), undefined, `rejected: ${JSON.stringify(rejected)}`);
  }
});

test('the reader yields one parsed line at a time and counts, never quotes, what it cannot read', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  const poison = 'please refactor the login page';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'a', n: 1 }),
    `{"type": "broken", "text": "${poison}"`,
    '',
    JSON.stringify({ type: 'b', n: 2 }),
    '[1, 2]',
    `{"truncated": "${poison}`
  ].join('\n'));
  const counts = {};
  const records = [...readSessionRecords(file, counts)];
  assert.deepEqual(records.map((record) => record.n), [1, 2]);
  assert.deepEqual(counts, { lines: 5, oversized_lines: 0, malformed_lines: 3 });
  assert.doesNotMatch(JSON.stringify(counts), /refactor/);
});

test('a line over the bound is skipped unparsed and counted, and the lines around it still read', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  const huge = JSON.stringify({ type: 'user', text: 'x'.repeat(5 * 1024 * 1024) });
  fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n${huge}\n${JSON.stringify({ n: 2 })}\n`);
  const counts = {};
  const records = [...readSessionRecords(file, counts)];
  assert.deepEqual(records.map((record) => record.n), [1, 2]);
  assert.equal(counts.oversized_lines, 1);
  const small = {};
  assert.deepEqual([...readSessionRecords(file, small, { maxLineBytes: 16 })].map((record) => record.n), [1, 2]);
  assert.equal(small.oversized_lines, 1);
  // An over-bound line that ends inside one chunk is caught too, not only one
  // that spans chunks.
  const short = path.join(dir, 'short.jsonl');
  fs.writeFileSync(short, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2, text: 'thirty bytes of text here' })}\n`);
  const bounded = {};
  assert.deepEqual([...readSessionRecords(short, bounded, { maxLineBytes: 16 })].map((record) => record.n), [1]);
  assert.equal(bounded.oversized_lines, 1);
  const sessionContext = { session_id: 'from-context' };
  assert.deepEqual(applyMapping({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z', sessionId: 'fix the login bug', message: { usage: { output_tokens: 1 } } },
    minimalMapping().record, { context: sessionContext, projectSalt: SALT }), { rejected: true }, 'a prose session id is rejected, never replaced by the context\'s');
});

test('a mapping is refused for any key, target or predicate outside its closed shape', () => {
  assert.deepEqual(validateMapping(minimalMapping()), []);
  assert.deepEqual(validateMapping(minimalMapping({ evidence: { agent_version: '2.1.282', probed_on: '2026-09-25', note: 'probed', repaired_from: 'claude-jsonl-1' } })), [],
    'every allowed evidence key, well shaped');
  assert.deepEqual(validateMapping(minimalMapping({ file: { glob: 'events.jsonl', line_format: 'jsonl' } })), [], 'a bare file name is a glob');
  const cases = {
    'an unknown top-level key': [minimalMapping({ script: 'x' }), 'script'],
    'a text target': [minimalMapping({ record: { ...minimalMapping().record, usage: { prompt: { path: 'message.content' } } } }), 'record.usage.prompt'],
    'a regular-expression predicate': [minimalMapping({ record: { ...minimalMapping().record, select: [{ path: 'type', matches: 'assis.*' }] } }), 'record.select.0'],
    'a path with brackets': [minimalMapping({ record: { ...minimalMapping().record, ts: 'items[0].ts' } }), 'record.ts'],
    'a negative scale': [minimalMapping({ record: { ...minimalMapping().record, usage: { output: { path: 'o', scale: -1 } } } }), 'record.usage.output'],
    'an unknown agent': [minimalMapping({ agent: 'gemini' }), 'agent'],
    'a summary authority with no summary': [minimalMapping({ authority: 'per_call_else_summary' }), 'summary'],
    // Intent 19: a mapping can be kept and shared, so its free strings are closed.
    'an unknown evidence key': [minimalMapping({ evidence: { agent_version: 'test', source_url: 'https://example.com' } }), 'evidence.source_url'],
    'a prose agent version': [minimalMapping({ evidence: { agent_version: 'the latest one' } }), 'evidence.agent_version'],
    'a probe date that is not a date': [minimalMapping({ evidence: { probed_on: 'yesterday' } }), 'evidence.probed_on'],
    'a note over 500 characters': [minimalMapping({ evidence: { note: 'x'.repeat(501) } }), 'evidence.note'],
    'a non-string note': [minimalMapping({ evidence: { note: { text: 'x' } } }), 'evidence.note'],
    'a repaired-from that is not a mapping id': [minimalMapping({ evidence: { repaired_from: 'Claude JSONL 1' } }), 'evidence.repaired_from'],
    'a glob with a directory': [minimalMapping({ file: { glob: '/home/alice/*.jsonl', line_format: 'jsonl' } }), 'file'],
    'a glob that climbs': [minimalMapping({ file: { glob: '../*.jsonl', line_format: 'jsonl' } }), 'file'],
    'a glob with a nested directory': [minimalMapping({ file: { glob: '**/logs/*.jsonl', line_format: 'jsonl' } }), 'file']
  };
  for (const [why, [mapping, where]] of Object.entries(cases)) {
    assert.ok(validateMapping(mapping).includes(where), `${why}: ${JSON.stringify(validateMapping(mapping))}`);
  }
});

test('applying a mapping keeps numbers and identifiers, hashes the project path, and drops a line whose session id is prose', () => {
  const mapping = minimalMapping();
  const line = {
    type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', sessionId: 'sess-1', cwd: '/home/me/secret-project',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 12, output_tokens: 3 }, content: [{ text: 'hello' }] }
  };
  const row = applyMapping(line, mapping.record, { projectSalt: SALT });
  assert.deepEqual(row.usage, { input_fresh: 12, output: 3 });
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.response_id, 'msg_1');
  assert.match(row.project_id, /^project_[0-9a-f]{20}$/);
  assert.doesNotMatch(JSON.stringify(row), /secret-project|hello/);
  assert.equal(applyMapping({ ...line, type: 'user' }, mapping.record, { projectSalt: SALT }), undefined, 'not a record the mapping selects');
  assert.deepEqual(applyMapping({ ...line, sessionId: 'fix the login bug' }, mapping.record, { projectSalt: SALT }), { rejected: true });
  const scaled = applyMapping(line, { ...mapping.record, usage: { output: { path: 'message.usage.output_tokens', scale: 1e-9 } } }, { projectSalt: SALT });
  assert.equal(scaled.usage.output, 3e-9);
  const aiu = applyMapping({ ...line, n: 17184730000 }, { ...mapping.record, billing: { aiu: { path: 'n', scale: 1e-9 } } }, { projectSalt: SALT });
  assert.equal(aiu.billing.aiu, 17184730000 / 1e9, 'the same figure the live Copilot adapter records');
});

test('a context line lends its session id and model to later lines that do not carry them', () => {
  const entries = [{ select: [{ path: 'type', equals: 'session_meta' }], session_id: 'payload.id', project_path: 'payload.cwd' },
    { select: [{ path: 'type', equals: 'turn_context' }], model: 'payload.model' }];
  const context = {
    ...readContext({ type: 'session_meta', payload: { id: 'rollout-1', cwd: '/home/me/x' } }, entries, { projectSalt: SALT }),
    ...readContext({ type: 'turn_context', payload: { model: 'gpt-5.5' } }, entries, { projectSalt: SALT })
  };
  const spec = { select: [{ path: 'type', equals: 'token_usage_record' }], ts: 'timestamp', response_id: 'payload.response_id',
    usage: { input_total: { path: 'payload.usage.input_tokens' } } };
  const row = applyMapping({ type: 'token_usage_record', timestamp: '2026-09-01T10:00:00Z', payload: { response_id: 'resp_1', usage: { input_tokens: 9 } } },
    spec, { context, projectSalt: SALT });
  assert.equal(row.session_id, 'rollout-1');
  assert.equal(row.model, 'gpt-5.5');
  assert.match(row.project_id, /^project_/);
});
