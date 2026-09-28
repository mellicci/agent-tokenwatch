import { isDeepStrictEqual } from 'node:util';
import { MAX_JSON_EDIT_BYTES, MAX_JSON_EDIT_DEPTH } from './constants.mjs';

// Editing an agent's settings file in place (intent 18).
//
// The installer used to parse a settings file, change the object and write it
// back with JSON.stringify, so every install reformatted a file the user owns,
// dropped any object it emptied and, for Copilot's JSONC, deleted the user's
// comments. This module changes only the spans a change needs and leaves every
// other byte where it was, the way the Codex config.toml path already does.
//
// The caller never says *how* to edit. It computes the value the file should
// hold, with the same value-level logic the installer always had, and
// `editToValue` reaches that value one span edit at a time, re-parsing after
// each, until the document's value equals it. The result is therefore exactly
// the value today's code produces; only the formatting around it is kept.
//
// Formatting rule for anything inserted: it copies its neighbours. A member or
// element added to a container whose items sit on their own lines gets its own
// line, indented like the last item, with the document's own line ending; one
// added to a compact container (`{"a":1}`) stays compact. An empty container
// that spans lines gets the container's indent plus the document's indent
// unit. Removing an item takes its line and exactly one separating comma, never
// a neighbour's comment. A byte-order mark stays at offset 0.
//
// Refused, with a category and never any file text: a document that does not
// parse as JSON with // and /* */ comments ('unparseable'; no trailing commas,
// single quotes or unquoted keys), one larger than MAX_JSON_EDIT_BYTES
// ('too-large') or nested deeper than MAX_JSON_EDIT_DEPTH ('too-deep'), an edit
// inside an object that repeats a key ('duplicate-key'), and an edit whose
// result does not re-parse to the requested value ('edit-invariant').

const WS = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Refusal extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

// Set by skip() when it passes a comment, and cleared by each parse, so the
// parse result can say whether the document holds any (see parseJsonDocument).
let sawComment = false;

function skip(text, i) {
  for (;;) {
    while (i < text.length && WS.has(text[i])) i += 1;
    if (text[i] === '/' && text[i + 1] === '/') {
      sawComment = true;
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      sawComment = true;
      const close = text.indexOf('*/', i + 2);
      if (close === -1) throw new Refusal('unparseable');
      i = close + 2;
    } else {
      return i;
    }
  }
}

function setOwn(object, key, value) {
  // An own property even for "__proto__", as JSON.parse creates one.
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function parseString(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  if (j >= text.length) throw new Refusal('unparseable');
  const raw = text.slice(i, j + 1);
  try {
    return { value: JSON.parse(raw), end: j + 1 };
  } catch {
    throw new Refusal('unparseable');
  }
}

function parseValue(text, i, depth) {
  if (depth > MAX_JSON_EDIT_DEPTH) throw new Refusal('too-deep');
  const c = text[i];
  if (c === '{') {
    const node = { kind: 'object', start: i, members: [], duplicates: new Set(), value: {} };
    let j = skip(text, i + 1);
    if (text[j] === '}') { node.end = j + 1; return node; }
    for (;;) {
      if (text[j] !== '"') throw new Refusal('unparseable');
      const key = parseString(text, j);
      let k = skip(text, key.end);
      if (text[k] !== ':') throw new Refusal('unparseable');
      k = skip(text, k + 1);
      const value = parseValue(text, k, depth + 1);
      if (Object.hasOwn(node.value, key.value)) node.duplicates.add(key.value);
      setOwn(node.value, key.value, value.value);
      node.members.push({ key: key.value, start: j, keyEnd: key.end, node: value, end: value.end });
      j = skip(text, value.end);
      if (text[j] === ',') {
        j = skip(text, j + 1);
        if (text[j] === '}') throw new Refusal('unparseable');
        continue;
      }
      if (text[j] === '}') { node.end = j + 1; return node; }
      throw new Refusal('unparseable');
    }
  }
  if (c === '[') {
    const node = { kind: 'array', start: i, elements: [], value: [] };
    let j = skip(text, i + 1);
    if (text[j] === ']') { node.end = j + 1; return node; }
    for (;;) {
      const value = parseValue(text, j, depth + 1);
      node.value.push(value.value);
      node.elements.push({ start: value.start, node: value, end: value.end });
      j = skip(text, value.end);
      if (text[j] === ',') {
        j = skip(text, j + 1);
        if (text[j] === ']') throw new Refusal('unparseable');
        continue;
      }
      if (text[j] === ']') { node.end = j + 1; return node; }
      throw new Refusal('unparseable');
    }
  }
  if (c === '"') {
    const string = parseString(text, i);
    return { kind: 'string', start: i, end: string.end, value: string.value };
  }
  for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
    if (text.startsWith(word, i)) return { kind: 'literal', start: i, end: i + word.length, value };
  }
  NUMBER.lastIndex = i;
  const number = NUMBER.exec(text);
  if (number && number[0].length) return { kind: 'number', start: i, end: i + number[0].length, value: Number(number[0]) };
  throw new Refusal('unparseable');
}

function lineStart(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineIndent(text, pos) {
  const start = lineStart(text, pos);
  let end = start;
  while (text[end] === ' ' || text[end] === '\t') end += 1;
  return text.slice(start, end);
}

// The indent a nested item adds to its container's, read from the first
// container whose items sit on their own lines; '' for a compact document.
function detectIndentUnit(text, root) {
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    const items = node.members ?? node.elements;
    if (!items?.length) continue;
    const first = items[0];
    if (text.slice(node.start, first.start).includes('\n')) {
      const outer = lineIndent(text, node.start);
      const inner = lineIndent(text, first.start);
      if (inner.startsWith(outer) && inner.length > outer.length) return inner.slice(outer.length);
    }
    for (const item of items) queue.push(item.node);
  }
  return '';
}

// Parses a settings document. `error` is a refusal category and the other
// fields are absent when the text cannot be edited safely.
export function parseJsonDocument(text) {
  if (Buffer.byteLength(text) > MAX_JSON_EDIT_BYTES) return { error: 'too-large' };
  const bom = text.charCodeAt(0) === 0xfeff;
  sawComment = false;
  try {
    const start = skip(text, bom ? 1 : 0);
    const root = parseValue(text, start, 1);
    if (skip(text, root.end) !== text.length) throw new Refusal('unparseable');
    const lf = text.indexOf('\n');
    return {
      value: root.value,
      root,
      bom,
      comments: sawComment,
      newline: lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n',
      indentUnit: detectIndentUnit(text, root)
    };
  } catch (error) {
    if (error instanceof Refusal) return { error: error.category };
    throw error;
  }
}

// `unit` overrides the document's indent unit for a value placed on its own
// line in a document that has no nested item to learn one from.
function render(value, doc, baseIndent, unit = doc.indentUnit) {
  if (!unit) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).split('\n').join(doc.newline + baseIndent);
}

function colonSeparator(text, object, unit) {
  for (const member of object.members) {
    const between = text.slice(member.keyEnd, member.node.start);
    if (/^[ \t]*:[ \t]*$/.test(between)) return between;
  }
  return unit ? ': ' : ':';
}

// The end of the line `pos` is on, provided only whitespace or a comment
// follows it there; otherwise undefined (something else shares the line).
function restOfLineEnd(text, pos, stopAt) {
  let i = pos;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (i >= text.length || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n')) return i;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) i += 1;
      return i;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1 || text.slice(i, close).includes('\n')) return undefined;
      i = close + 2;
      continue;
    }
    if (stopAt !== undefined && i === stopAt) return undefined;
    return undefined;
  }
}

function lineBreakLength(text, pos) {
  if (text[pos] === '\r' && text[pos + 1] === '\n') return 2;
  return text[pos] === '\n' ? 1 : 0;
}

function itemText(text, container, doc, key, value, indent, unit = doc.indentUnit) {
  const rendered = render(value, doc, indent, unit);
  return key === undefined ? rendered : `${JSON.stringify(key)}${colonSeparator(text, container, unit)}${rendered}`;
}

function insertItem(text, container, doc, key, value) {
  const items = container.members ?? container.elements;
  const close = container.end - 1;
  if (!items.length) {
    const interior = text.slice(container.start + 1, close);
    if (interior.includes('\n')) {
      const at = restOfLineEnd(text, container.start + 1) ?? container.start + 1;
      const unit = doc.indentUnit || '  ';
      const indent = lineIndent(text, container.start) + unit;
      return [{ start: at, end: at, text: `${doc.newline}${indent}${itemText(text, container, doc, key, value, indent, unit)}` }];
    }
    // A container written on one line keeps its item on that line, rendered
    // compact whatever the document's indentation elsewhere.
    const pad = interior.length ? ' ' : '';
    return [{ start: container.start + 1, end: container.start + 1, text: `${pad}${itemText(text, container, doc, key, value, '', '')}` }];
  }
  const last = items[items.length - 1];
  const eol = text.slice(last.end, close).includes('\n') ? restOfLineEnd(text, last.end) : undefined;
  if (eol !== undefined) {
    const indent = lineIndent(text, last.start);
    const unit = doc.indentUnit || '  ';
    return [
      { start: last.end, end: last.end, text: ',' },
      { start: eol, end: eol, text: `${doc.newline}${indent}${itemText(text, container, doc, key, value, indent, unit)}` }
    ];
  }
  let separator = /^\s/.test(text.slice(container.start + 1)) ? ' ' : '';
  if (items.length > 1) {
    const comma = skip(text, items[0].end);
    separator = /^[ \t]*/.exec(text.slice(comma + 1))[0];
  }
  return [{ start: last.end, end: last.end, text: `,${separator}${itemText(text, container, doc, key, value, '', '')}` }];
}

// The position of the comma between items[index - 1] and items[index].
function commaBefore(text, items, index) {
  return skip(text, items[index - 1].end);
}

function removeItem(text, container, index) {
  const items = container.members ?? container.elements;
  const item = items[index];
  const last = index === items.length - 1;
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart(text, item.start), item.start));
  let afterItem = item.end;
  if (!last) {
    afterItem = skip(text, item.end);
    if (text[afterItem] !== ',') throw new Refusal('unparseable');
    afterItem += 1;
  }
  const eol = ownLine ? restOfLineEnd(text, afterItem) : undefined;
  // Own line(s), nothing else on them: take the whole lines.
  if (eol !== undefined && /^[ \t]*$/.test(text.slice(afterItem, eol))) {
    const from = lineStart(text, item.start);
    const edits = [{ start: from, end: eol + lineBreakLength(text, eol), text: '' }];
    if (last && index > 0) {
      const comma = commaBefore(text, items, index);
      edits.push({ start: comma, end: comma + 1, text: '' });
    }
    return edits;
  }
  if (!last) {
    const next = items[index + 1].start;
    if (/^\s*,\s*$/.test(text.slice(item.end, next))) return [{ start: item.start, end: next, text: '' }];
    const comma = skip(text, item.end);
    return [{ start: comma, end: comma + 1, text: '' }, { start: item.start, end: item.end, text: '' }];
  }
  if (index > 0) {
    const comma = commaBefore(text, items, index);
    if (/^\s*$/.test(text.slice(comma + 1, item.start))) return [{ start: comma, end: item.end, text: '' }];
    return [{ start: comma, end: comma + 1, text: '' }, { start: item.start, end: item.end, text: '' }];
  }
  return [{ start: item.start, end: item.end, text: '' }];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// One change towards `target` inside `node`, as a list of non-overlapping
// edits applied together, or null when the node already holds `target`.
function nextEdit(text, doc, node, target, path, created) {
  if (isDeepStrictEqual(node.value, target)) return null;
  if (node.kind === 'object' && isPlainObject(target)) {
    if (node.duplicates.size) throw new Refusal('duplicate-key');
    for (let index = 0; index < node.members.length; index += 1) {
      if (!Object.hasOwn(target, node.members[index].key)) return removeItem(text, node, index);
    }
    for (const member of node.members) {
      const edit = nextEdit(text, doc, member.node, target[member.key], [...path, member.key], created);
      if (edit) return edit;
    }
    for (const key of Object.keys(target)) {
      if (!Object.hasOwn(node.value, key)) {
        created?.push([...path, key].join('.'));
        return insertItem(text, node, doc, key, target[key]);
      }
    }
    return null;
  }
  if (node.kind === 'array' && Array.isArray(target)) {
    const current = node.value;
    if (target.length > current.length && current.every((value, index) => isDeepStrictEqual(value, target[index]))) {
      return insertItem(text, node, doc, undefined, target[current.length]);
    }
    if (target.length < current.length) {
      let t = 0;
      let first = -1;
      for (let index = 0; index < current.length; index += 1) {
        if (t < target.length && isDeepStrictEqual(current[index], target[t])) t += 1;
        else if (first === -1) first = index;
      }
      if (t === target.length && first !== -1) return removeItem(text, node, first);
    }
    if (target.length === current.length) {
      for (let index = 0; index < current.length; index += 1) {
        const edit = nextEdit(text, doc, node.elements[index].node, target[index], [...path, index], created);
        if (edit) return edit;
      }
    }
  }
  // Anything else replaces the whole value. The installer never reaches this
  // for a value it did not set (its changes only append to or filter arrays
  // and add or remove members), so the text such an edit removes is never
  // user content it would then store; a caller that can reach it must not
  // keep that removed text.
  return [{ start: node.start, end: node.end, text: render(target, doc, lineIndent(text, node.start)) }];
}

// Applied from the last offset back, so earlier offsets stay valid. Edits at
// the same offset keep their listed order in the result (a comma, then the
// member it separates), so among equals the later-listed one goes in first.
function apply(text, edits) {
  let out = text;
  const ordered = edits.map((edit, index) => ({ edit, index })).sort((a, b) => b.edit.start - a.edit.start || b.index - a.index);
  for (const { edit } of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// Edits `text` until it holds `target`. Returns `{ text, edits, created }`,
// where `edits` lists, in the order applied, each change with the text it
// removed and `created` names the dotted paths of members inserted; or
// `{ refused }` with a category and nothing written.
export function editToValue(text, target) {
  const created = [];
  const applied = [];
  let current = text;
  for (let round = 0; round < 10_000; round += 1) {
    const doc = parseJsonDocument(current);
    // After the first round the text is the editor's own output, so a failure
    // to parse it is the editor's, never the user's file - except size, which
    // an insert can push past the cap in a file that was just under it.
    if (doc.error) return { refused: round === 0 || doc.error === 'too-large' ? doc.error : 'edit-invariant' };
    let edits;
    try {
      edits = nextEdit(current, doc, doc.root, target, [], created);
    } catch (error) {
      if (error instanceof Refusal) return { refused: error.category };
      throw error;
    }
    if (!edits) {
      return isDeepStrictEqual(doc.value, target) ? { text: current, edits: applied, created } : { refused: 'edit-invariant' };
    }
    edits.forEach((edit, order) => applied.push({ round, order, start: edit.start, end: edit.end, removed: current.slice(edit.start, edit.end), inserted: edit.text }));
    current = apply(current, edits);
  }
  return { refused: 'edit-invariant' };
}

// The replacements that turn the edited text back into the original: each
// round undone in reverse order, its edits applied together. Offsets refer to
// the text as it stood after that round.
export function inverseEdits(edits) {
  const rounds = new Map();
  for (const edit of edits) {
    if (!rounds.has(edit.round)) rounds.set(edit.round, []);
    rounds.get(edit.round).push(edit);
  }
  const inverse = [];
  for (const round of [...rounds.keys()].sort((a, b) => b - a)) {
    const group = rounds.get(round).sort((a, b) => a.start - b.start || a.order - b.order);
    let shift = 0;
    const undo = [];
    for (const edit of group) {
      const start = edit.start + shift;
      undo.push({ start, end: start + edit.inserted.length, text: edit.removed });
      shift += edit.inserted.length - (edit.end - edit.start);
    }
    inverse.push(undo);
  }
  return inverse;
}

export function applyInverse(text, inverse) {
  let out = text;
  for (const group of inverse) {
    if (group.some((edit) => edit.start < 0 || edit.end > out.length || edit.start > edit.end)) return undefined;
    out = apply(out, group);
  }
  return out;
}
