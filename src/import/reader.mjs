import fs from 'node:fs';
import { IMPORT_READ_CHUNK_BYTES, MAX_IMPORT_LINE_BYTES } from '../constants.mjs';

// Reads an agent's session file one JSON line at a time, holding at most one
// line plus one chunk in memory (intent 06, D11). A line longer than the bound
// is skipped unparsed, and a line that does not parse is skipped; both are
// counted in `counts`. Nothing from a line ever leaves this function except the
// parsed record itself: no error text, which from JSON.parse quotes the input.
export function* readSessionRecords(file, counts = {}, { maxLineBytes = MAX_IMPORT_LINE_BYTES } = {}) {
  counts.lines ??= 0;
  counts.oversized_lines ??= 0;
  counts.malformed_lines ??= 0;
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(IMPORT_READ_CHUNK_BYTES);
  let parts = [];
  let size = 0;
  let oversized = false;
  const finish = () => {
    const line = oversized ? null : Buffer.concat(parts, size);
    const wasOversized = oversized;
    parts = [];
    size = 0;
    oversized = false;
    if (wasOversized) {
      counts.lines += 1;
      counts.oversized_lines += 1;
      return undefined;
    }
    const text = line.toString('utf8').trim();
    if (!text) return undefined;
    counts.lines += 1;
    try {
      const record = JSON.parse(text);
      if (record && typeof record === 'object' && !Array.isArray(record)) return record;
    } catch { /* the message quotes the line; it is never kept */ }
    counts.malformed_lines += 1;
    return undefined;
  };
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let start = 0;
      for (let index = 0; index < read; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        if (!oversized) {
          parts.push(Buffer.from(chunk.subarray(start, index)));
          size += index - start;
          if (size > maxLineBytes) oversized = true;
        }
        const record = finish();
        if (record) yield record;
        start = index + 1;
      }
      if (start < read && !oversized) {
        parts.push(Buffer.from(chunk.subarray(start, read)));
        size += read - start;
        if (size > maxLineBytes) {
          oversized = true;
          parts = [];
        }
      }
    }
    // A last line with no newline is either complete JSON or a session still
    // being written; a truncated one counts as malformed (FR-40).
    if (size || oversized) {
      const record = finish();
      if (record) yield record;
    }
  } finally {
    fs.closeSync(fd);
  }
}
