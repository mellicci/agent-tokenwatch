import { MAX_STDIN_BYTES } from './constants.mjs';

function stdinLimitError(maxBytes) {
  const error = new Error(`stdin exceeds the ${maxBytes}-byte safety limit`);
  error.code = 'STDIN_LIMIT';
  return error;
}

export async function readStdin({ maxBytes = MAX_STDIN_BYTES, optional = true } = {}) {
  if (optional && process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw stdinLimitError(maxBytes);
    }
  }
  return text.trim();
}

// The bytes exactly as the agent sent them: no decoding, no trim, no removal
// of a byte-order mark. A composed status line forwards these to another
// program, which is owed what the agent sent rather than Tokenwatch's reading
// of it (intent 04, FR-02). Same bound as readStdin, counted in bytes.
export async function readStdinBytes({ maxBytes = MAX_STDIN_BYTES, optional = true } = {}) {
  if (optional && process.stdin.isTTY) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += bytes.length;
    if (size > maxBytes) throw stdinLimitError(maxBytes);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

// Windows PowerShell 5.1 can pipe text to a program with a UTF-8 byte-order
// mark in front, and Node's stdin decoding keeps it as U+FEFF, which
// `JSON.parse` rejects. `readStdin`'s `trim()` happens to remove it, but that
// is a side effect a later change could lose without noticing, and a `--payload`
// never passes through it. So the mark is dropped here, deliberately, where
// every payload is parsed. A hook that failed to parse would record nothing and,
// failing open, say nothing either.
export function parseJsonPayload(text, label = 'payload') {
  const body = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    // Deliberately no cause and no parser message: Node quotes roughly sixteen
    // characters of the offending input, and that input is a hook payload. The
    // one thing this tool promises never to surface is payload content.
    throw new Error(`Invalid JSON ${label}`);
  }
}
