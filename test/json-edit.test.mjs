import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInverse, editToValue, inverseEdits, parseJsonDocument } from '../src/json-edit.mjs';

// Intent 18. The installer edits an agent's settings file by span instead of
// re-serialising it, so the user's formatting and comments survive. Each case
// here edits a document towards a target value and checks three things: the
// value is exactly the target, nothing outside the edit changed, and undoing
// the edits returns the original bytes.

function edit(text, mutate) {
  const doc = parseJsonDocument(text);
  assert.equal(doc.error, undefined, `could not parse ${JSON.stringify(text)}`);
  const target = structuredClone(doc.value);
  mutate(target);
  const result = editToValue(text, target);
  assert.equal(result.refused, undefined, `refused ${JSON.stringify(text)}: ${result.refused}`);
  assert.deepEqual(parseJsonDocument(result.text).value, target, 'the edited text holds the target value');
  assert.equal(applyInverse(result.text, inverseEdits(result.edits)), text, 'undoing the edits returns the original bytes');
  return result;
}

const hook = (command) => ({ hooks: [{ type: 'command', command, timeout: 5 }] });

test('a member added to a multi-line object takes its own line, indented like its neighbours', () => {
  const text = '{\n  "theme": "dark"\n}\n';
  const { text: out } = edit(text, (value) => { value.statusLine = { type: 'command', command: 'tw' }; });
  assert.equal(out, '{\n  "theme": "dark",\n  "statusLine": {\n    "type": "command",\n    "command": "tw"\n  }\n}\n');
});

test('four-space and tab indentation are copied, not replaced with two spaces', () => {
  assert.equal(edit('{\n    "a": 1\n}', (v) => { v.b = [1]; }).text, '{\n    "a": 1,\n    "b": [\n        1\n    ]\n}');
  assert.equal(edit('{\n\t"a": 1\n}', (v) => { v.b = { c: 2 }; }).text, '{\n\t"a": 1,\n\t"b": {\n\t\t"c": 2\n\t}\n}');
});

test('a compact object stays compact, with its own spacing', () => {
  assert.equal(edit('{"a":1}', (v) => { v.b = 2; }).text, '{"a":1,"b":2}');
  assert.equal(edit('{"a":1, "b":2}', (v) => { v.c = 3; }).text, '{"a":1, "b":2, "c":3}');
  assert.equal(edit('{ "a": 1 }', (v) => { v.b = 2; }).text, '{ "a": 1, "b": 2 }');
});

// Found by the live test: a hook appended to a user's one-line "Stop": [ ... ]
// in a tab-indented file came out as a multi-line block at the wrong depth.
test('a one-line container in an indented document keeps a new item on its line', () => {
  assert.equal(edit('{\n\t"Stop": [ { "x": 1 } ]\n}', (v) => { v.Stop.push({ y: [1] }); }).text, '{\n\t"Stop": [ { "x": 1 }, {"y":[1]} ]\n}');
  assert.equal(edit('{\n\t"a": { },\n\t"b": [\n\t\t1\n\t]\n}', (v) => { v.a.c = { d: 1 }; }).text, '{\n\t"a": { "c":{"d":1} },\n\t"b": [\n\t\t1\n\t]\n}');
});

test('an empty object gets a member in the style of its braces', () => {
  assert.equal(edit('{}', (v) => { v.a = 1; }).text, '{"a":1}');
  assert.equal(edit('{ }', (v) => { v.a = 1; }).text, '{ "a":1 }');
  assert.equal(edit('{\n}\n', (v) => { v.a = { b: 1 }; }).text, '{\n  "a": {\n    "b": 1\n  }\n}\n');
});

test('a comment beside the last member stays on that member\'s line', () => {
  const text = '{\n  // settings\n  "a": 1 // note\n}\n';
  const { text: out } = edit(text, (v) => { v.b = 2; });
  assert.equal(out, '{\n  // settings\n  "a": 1, // note\n  "b": 2\n}\n');
});

test('an element is appended after a trailing comment in an array', () => {
  const text = '{\n  "Stop": [\n    { "x": 1 } /* mine */\n  ]\n}';
  const { text: out } = edit(text, (v) => { v.Stop.push({ y: 2 }); });
  assert.equal(out, '{\n  "Stop": [\n    { "x": 1 }, /* mine */\n    {\n      "y": 2\n    }\n  ]\n}');
});

test('a document without a trailing newline keeps none, and one with two keeps two', () => {
  assert.equal(edit('{\n  "a": 1\n}', (v) => { v.b = 2; }).text.endsWith('}'), true);
  assert.equal(edit('{\n  "a": 1\n}\n\n', (v) => { v.b = 2; }).text.endsWith('}\n\n'), true);
});

test('CRLF documents receive only CRLF line endings', () => {
  const { text: out } = edit('{\r\n  "a": 1\r\n}\r\n', (v) => { v.b = { c: 1 }; });
  assert.equal(out, '{\r\n  "a": 1,\r\n  "b": {\r\n    "c": 1\r\n  }\r\n}\r\n');
  assert.equal(out.replaceAll('\r\n', '').includes('\n'), false, 'no bare LF');
});

test('a byte-order mark stays at offset 0', () => {
  const { text: out } = edit('﻿{\n  "a": 1\n}', (v) => { v.b = 2; });
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out, '﻿{\n  "a": 1,\n  "b": 2\n}');
});

test('an escaped key matches its decoded name', () => {
  const { text: out } = edit('{\n  "st\\u0061tusLine": 1\n}', (v) => { v.statusLine = 2; });
  assert.equal(out, '{\n  "st\\u0061tusLine": 2\n}');
});

test('removing the only hook leaves the user\'s empty containers exactly as they were', () => {
  // The installer adds to an existing "hooks": {} and an existing "Stop": [];
  // taking the entry out again must leave both, byte for byte.
  const original = '{\n  "hooks": {\n    "Stop": []\n  }\n}\n';
  const installed = edit(original, (v) => { v.hooks.Stop.push(hook('tw')); });
  const back = editToValue(installed.text, parseJsonDocument(original).value);
  assert.equal(back.text, original);
});

test('removing an item takes its line and one comma, never a neighbour\'s comment', () => {
  const text = '{\n  // first\n  "a": 1,\n  "b": 2, // keep\n  "c": 3\n}\n';
  assert.equal(edit(text, (v) => { delete v.c; }).text, '{\n  // first\n  "a": 1,\n  "b": 2 // keep\n}\n');
  assert.equal(edit(text, (v) => { delete v.a; }).text, '{\n  // first\n  "b": 2, // keep\n  "c": 3\n}\n');
  assert.equal(edit('{"a":1,"b":2,"c":3}', (v) => { delete v.b; }).text, '{"a":1,"c":3}');
});

test('outside an edit, every byte of the original is kept', () => {
  const text = '{\n  /* block */ "x": [1, 2],\n  "hooks": {\n    "Stop": [ { "mine": true } ]\n  }\n}\n';
  const { edits } = edit(text, (v) => { v.hooks.Stop.push(hook('tw')); v.statusLine = { command: 'tw' }; });
  let current = text;
  for (const round of [...new Set(edits.map((e) => e.round))]) {
    const group = edits.filter((e) => e.round === round).sort((a, b) => a.start - b.start);
    const first = group[0];
    const lastEdit = group[group.length - 1];
    let next = current;
    for (const e of [...group].reverse()) next = next.slice(0, e.start) + e.inserted + next.slice(e.end);
    assert.equal(next.slice(0, first.start), current.slice(0, first.start), 'the prefix before an edit is unchanged');
    const tail = current.length - lastEdit.end;
    assert.equal(next.slice(next.length - tail), current.slice(lastEdit.end), 'the suffix after an edit is unchanged');
    current = next;
  }
});

test('a document the editor cannot be sure of is refused with a category and no text', () => {
  assert.equal(parseJsonDocument('{ "a": 1, }').error, 'unparseable', 'no trailing commas');
  assert.equal(parseJsonDocument("{ 'a': 1 }").error, 'unparseable', 'no single quotes');
  assert.equal(parseJsonDocument('{ a: 1 }').error, 'unparseable', 'no unquoted keys');
  assert.equal(parseJsonDocument('{ /* open').error, 'unparseable');
  assert.equal(parseJsonDocument('{"a":1} trailing').error, 'unparseable');
  assert.equal(editToValue('{"a":1,"a":2}', { a: 3 }).refused, 'duplicate-key');
  // An object with a duplicate key is refused only when it has to change.
  assert.equal(editToValue('{"a":1,"a":2,"b":1}', { a: 2, b: 1 }).text, '{"a":1,"a":2,"b":1}');
});

test('a document nested past the depth cap is refused, not parsed', () => {
  const deep = `${'['.repeat(65)}${']'.repeat(65)}`;
  assert.equal(parseJsonDocument(deep).error, 'too-deep');
  const ok = `${'['.repeat(63)}${']'.repeat(63)}`;
  assert.equal(parseJsonDocument(ok).error, undefined);
  // Far past the cap is still a refusal, not a stack overflow.
  assert.equal(parseJsonDocument(`${'['.repeat(100000)}`).error, 'too-deep');
});

test('a document over the size cap is refused before it is parsed', () => {
  const big = `{"a":"${'x'.repeat(4 * 1024 * 1024)}"}`;
  assert.equal(parseJsonDocument(big).error, 'too-large');
});

test('the parse result says whether the document holds a comment', () => {
  assert.equal(parseJsonDocument('{"a":"// not a comment"}').comments, false);
  assert.equal(parseJsonDocument('{"a":1} // trailing').comments, true);
  assert.equal(parseJsonDocument('{"a":/* here */1}').comments, true);
  assert.equal(parseJsonDocument('{"a":1}').comments, false, 'cleared by each parse');
});

test('a key named __proto__ is an ordinary member, as JSON.parse makes it', () => {
  const doc = parseJsonDocument('{"__proto__": {"polluted": true}}');
  assert.deepEqual(Object.keys(doc.value), ['__proto__']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(doc.value), Object.prototype);
});

test('the parsed value is exactly what JSON.parse gives for the same text without comments', () => {
  for (const text of ['{"a":[1,2.5e3,-0,true,false,null,"x\\n\\u00e9"],"b":{}}', '[]', '"s"', '12']) {
    assert.deepEqual(parseJsonDocument(text).value, JSON.parse(text));
  }
});

// The loop's exit guard: a target the document can never hold is refused
// rather than looped on or written approximately (D7, review H2).
test('a target the document can never hold is refused as edit-invariant', () => {
  assert.equal(editToValue('{}', { a: undefined }).refused, 'edit-invariant');
  assert.equal(editToValue('{}', { a: Number.NaN }).refused, 'edit-invariant');
});

// The fallback for a change that is neither an append, a filter nor a member
// change replaces the whole value, and is still inverted exactly (review M3).
test('a value no narrower edit can reach is replaced whole, and undone exactly', () => {
  const text = '{\n  "a": [1, 2]\n}\n';
  const result = editToValue(text, { a: [3, 4, 5] });
  assert.deepEqual(parseJsonDocument(result.text).value, { a: [3, 4, 5] });
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].removed, '[1, 2]');
  assert.equal(applyInverse(result.text, inverseEdits(result.edits)), text);
});

// Review 2, M2: a file just under the size cap that the edit pushes over it is
// refused for its size, the user's to fix, not blamed on the editor.
test('an edit that pushes a document past the size cap is refused as too-large', () => {
  const text = `{"a":"${'x'.repeat(4 * 1024 * 1024 - 16)}"}`;
  assert.equal(parseJsonDocument(text).error, undefined);
  assert.equal(editToValue(text, { ...parseJsonDocument(text).value, b: 'y'.repeat(64) }).refused, 'too-large');
});
