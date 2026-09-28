// Minimal, dependency-free decoder for the OTLP Logs Export request messages
// needed by Tokenwatch. It intentionally does not implement arbitrary protobuf
// schemas or OTLP metrics. Unknown fields are skipped.

const MAX_FIELDS = 100_000;
const MAX_DEPTH = 16;
// `MAX_FIELDS` bounds one message. A document is a tree of messages, so a body
// whose every individual message stays under that limit could still decode to
// an unbounded number of nodes in total - the limit sat one step from where it
// binds. This budget spans the whole decode.
//
// A module-level counter is safe here because a decode runs start to finish
// synchronously on one thread: nothing can interleave between the reset below
// and the return.
const MAX_TOTAL_FIELDS = 200_000;
let remainingFields = MAX_TOTAL_FIELDS;

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (let i = 0; i < 10; i += 1) {
    if (offset >= buffer.length) throw new Error('truncated protobuf varint');
    const byte = buffer[offset];
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error('protobuf varint exceeds 10 bytes');
}

function fields(buffer, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('protobuf nesting limit exceeded');
  const out = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (out.length >= MAX_FIELDS) throw new Error('protobuf field limit exceeded');
    remainingFields -= 1;
    if (remainingFields < 0) throw new Error('protobuf document field limit exceeded');
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (number <= 0) throw new Error('invalid protobuf field number');
    if (wire === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      out.push({ number, wire, value: item.value });
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error('truncated protobuf fixed64');
      out.push({ number, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) throw new Error('invalid protobuf length');
      out.push({ number, wire, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error('truncated protobuf fixed32');
      out.push({ number, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

function decimal(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function anyValue(buffer, depth = 0) {
  const field = fields(buffer, depth + 1)[0];
  if (!field) return {};
  if (field.number === 1 && field.wire === 2) return { stringValue: field.value.toString('utf8') };
  if (field.number === 2 && field.wire === 0) return { boolValue: field.value !== 0n };
  if (field.number === 3 && field.wire === 0) return { intValue: decimal(field.value) };
  if (field.number === 4 && field.wire === 1) return { doubleValue: field.value.readDoubleLE(0) };
  if (field.number === 5 && field.wire === 2) {
    return { arrayValue: { values: fields(field.value, depth + 1).filter((item) => item.number === 1 && item.wire === 2).map((item) => anyValue(item.value, depth + 1)) } };
  }
  if (field.number === 6 && field.wire === 2) {
    return { kvlistValue: { values: fields(field.value, depth + 1).filter((item) => item.number === 1 && item.wire === 2).map((item) => keyValue(item.value, depth + 1)) } };
  }
  if (field.number === 7 && field.wire === 2) return { bytesValue: field.value.toString('base64') };
  return {};
}

function keyValue(buffer, depth = 0) {
  const out = { key: '', value: {} };
  for (const field of fields(buffer, depth + 1)) {
    if (field.number === 1 && field.wire === 2) out.key = field.value.toString('utf8');
    else if (field.number === 2 && field.wire === 2) out.value = anyValue(field.value, depth + 1);
  }
  return out;
}

function resource(buffer, depth = 0) {
  return {
    attributes: fields(buffer, depth + 1)
      .filter((field) => field.number === 1 && field.wire === 2)
      .map((field) => keyValue(field.value, depth + 1))
  };
}

function scope(buffer, depth = 0) {
  const out = {};
  for (const field of fields(buffer, depth + 1)) {
    if (field.number === 1 && field.wire === 2) out.name = field.value.toString('utf8');
    else if (field.number === 2 && field.wire === 2) out.version = field.value.toString('utf8');
  }
  return out;
}

function fixed64Decimal(buffer) {
  return buffer.readBigUInt64LE(0).toString();
}

function logRecord(buffer, depth = 0) {
  const out = { attributes: [] };
  for (const field of fields(buffer, depth + 1)) {
    if (field.number === 1 && field.wire === 1) out.timeUnixNano = fixed64Decimal(field.value);
    else if (field.number === 2 && field.wire === 1) out.observedTimeUnixNano = fixed64Decimal(field.value);
    else if (field.number === 4 && field.wire === 2) out.severityText = field.value.toString('utf8');
    else if (field.number === 5 && field.wire === 2) out.body = anyValue(field.value, depth + 1);
    else if (field.number === 6 && field.wire === 2) out.attributes.push(keyValue(field.value, depth + 1));
    else if (field.number === 9 && field.wire === 2) out.traceId = field.value.toString('hex');
    else if (field.number === 10 && field.wire === 2) out.spanId = field.value.toString('hex');
    else if (field.number === 12 && field.wire === 2) out.eventName = field.value.toString('utf8');
  }
  return out;
}

function scopeLogs(buffer, depth = 0) {
  const out = { logRecords: [] };
  for (const field of fields(buffer, depth + 1)) {
    if (field.number === 1 && field.wire === 2) out.scope = scope(field.value, depth + 1);
    else if (field.number === 2 && field.wire === 2) out.logRecords.push(logRecord(field.value, depth + 1));
  }
  return out;
}

function resourceLogs(buffer, depth = 0) {
  const out = { scopeLogs: [] };
  for (const field of fields(buffer, depth + 1)) {
    if (field.number === 1 && field.wire === 2) out.resource = resource(field.value, depth + 1);
    else if (field.number === 2 && field.wire === 2) out.scopeLogs.push(scopeLogs(field.value, depth + 1));
  }
  return out;
}

export function decodeOtlpLogsExportRequest(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  remainingFields = MAX_TOTAL_FIELDS;
  return {
    resourceLogs: fields(buffer)
      .filter((field) => field.number === 1 && field.wire === 2)
      .map((field) => resourceLogs(field.value, 1))
  };
}
