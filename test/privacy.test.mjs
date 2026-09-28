import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivacySafe, makeEvent } from '../src/schema.mjs';
import { looksSensitive, safeString, safeIdentifier } from '../src/privacy.mjs';
import { tomlEscaped, windowsPath } from './helpers.mjs';

test('schema rejects transcript-like fields at any depth', () => {
  const event = makeEvent({ agent: 'claude', kind: 'usage', usage: { input_total: 1 } });
  event.metrics = { nested: { tool_output: 'secret' } };
  assert.throws(() => assertPrivacySafe(event), /Unsafe field/);
});

test('schema truncates identifiers and excludes unknown input fields', () => {
  const event = makeEvent({
    agent: 'codex', kind: 'usage', model: 'x'.repeat(1000),
    usage: { input_total: 100, cache_read: 60, semantics: 'cached_subset' },
    prompt: 'secret'
  });
  assert.equal(event.model.length, 160);
  assert.equal(event.usage.input_fresh, 40);
  assert.equal(event.prompt, undefined);
  assert.doesNotThrow(() => assertPrivacySafe(event));
});

// A provider that nests an object where a name is expected used to become the
// literal string "[object Object]" in the ledger, and an array of strings would
// have been joined into one - content, not metadata.
test('a container is never stringified into a stored name', () => {
  assert.equal(safeString({ id: 'x' }), undefined);
  assert.equal(safeString(['/secret/path', '/another']), undefined);
  assert.equal(safeIdentifier({ nested: { deep: true } }), undefined);
  assert.equal(safeIdentifier(['a', 'b']), undefined);
  // Primitives still pass through untouched.
  assert.equal(safeString('claude-opus-5'), 'claude-opus-5');
  assert.equal(safeIdentifier('gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.equal(safeString(42), '42');
});

// An identifier from an agent running on Windows carries a path in whichever
// spelling that agent happened to use: native backslashes, forward slashes, a
// lower-case drive, the doubled backslashes of a value lifted out of a TOML or
// JSON config, the extended-length prefix, or a UNC share. Built explicitly so
// every spelling is checked on every OS, not only on a Windows runner.
test('a Windows path is refused as an identifier in every spelling Windows writes it', () => {
  const native = windowsPath('Users', 'someone', 'clients', 'acme', 'plan.md');
  const relative = native.slice('C:\\'.length);
  const spellings = [
    native,
    native.replaceAll('\\', '/'),
    native.replace(/^C:/, 'c:'),
    tomlEscaped(native),
    `\\\\?\\${native}`,
    `\\\\fileserver\\share\\${relative}`,
    `..\\..\\${relative}`
  ];
  for (const value of spellings) {
    assert.equal(looksSensitive(value), true, `${value} must be recognised as a path`);
    const event = makeEvent({ agent: 'claude-code', kind: 'usage', source: 'hook', session_id: value, tool_name: value });
    assert.equal(event.session_id, undefined, `${value} must not be stored as a session id`);
    assert.equal(event.tool_name, undefined, `${value} must not be stored as a tool name`);
  }
});

// Intent 06, D1: an imported row's provenance is a closed block. Anything a
// mapping or a session file could smuggle in beside the fixed keys is dropped.
test('an import block keeps only its fixed keys and a reason from the closed vocabulary', () => {
  const event = makeEvent({
    agent: 'claude', kind: 'usage', source: 'import', session_id: 's-1',
    usage: { input_total: 10, output: 2, semantics: 'components', basis: 'transcript' },
    import: {
      mapping_id: 'claude-jsonl-1', mapping_version: '1.0', run_id: '0b1c9d6e-5f2a-4d3b-8c7e-1a2b3c4d5e6f',
      verification: 'verified', reason: 'mismatch', prompt: 'please refactor the login page', path: '/home/me/src'
    }
  });
  assert.equal(event.usage.basis, 'transcript', 'a third, additive basis');
  assert.deepEqual(Object.keys(event.import).sort(), ['mapping_id', 'mapping_version', 'reason', 'run_id', 'verification']);
  assertPrivacySafe(event);
  const loose = makeEvent({ agent: 'claude', kind: 'usage', import: { verification: 'probably', reason: 'the mapping looked fine to me' } });
  assert.equal(loose.import, undefined, 'a verification or reason outside the vocabulary is dropped, not stored');
  const other = makeEvent({ agent: 'claude', kind: 'usage', usage: { input_total: 1, basis: 'made-up' } });
  assert.equal(other.usage.basis, 'increment', 'an unknown basis still falls back to increment');
});
