import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startOtlpServer } from '../src/otlp-server.mjs';
import { fixture, tempDir, testConfig } from './helpers.mjs';

function varint(input) {
  let value = BigInt(input);
  const bytes = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function tag(field, wire) { return varint((BigInt(field) << 3n) | BigInt(wire)); }
function lenField(field, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([tag(field, 2), varint(buffer.length), buffer]);
}
function fixed64Field(field, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tag(field, 1), buffer]);
}
function anyString(value) { return lenField(1, value); }
function anyDouble(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return Buffer.concat([tag(4, 1), buffer]);
}
function keyValue(key, any) { return Buffer.concat([lenField(1, key), lenField(2, any)]); }
function minimalLogsProtobuf() {
  const body = anyString(JSON.stringify({
    'event.name': 'codex.protobuf_request', input_token_count: 4000,
    cached_input_token_count: 2500, output_token_count: 350,
    model: 'gpt-protobuf-test', prompt: 'SECRET PROTOBUF PROMPT'
  }));
  const record = Buffer.concat([
    fixed64Field(1, 1787400000000000000n),
    lenField(5, body),
    lenField(6, keyValue('conversation_id', anyString('protobuf-session'))),
    lenField(6, keyValue('turn_id', anyString('protobuf-turn'))),
    lenField(6, keyValue('cost_usd', anyDouble(0.025))),
    lenField(6, keyValue('arbitrary.text', anyString('SECRET PROTOBUF ATTRIBUTE')))
  ]);
  const scope = lenField(1, 'codex.telemetry');
  const scopeLogs = Buffer.concat([lenField(1, scope), lenField(2, record)]);
  const resource = lenField(1, keyValue('service.name', anyString('codex')));
  const resourceLogs = Buffer.concat([lenField(1, resource), lenField(2, scopeLogs)]);
  return lenField(1, resourceLogs);
}

test('loopback OTLP JSON receiver stores allowlisted metadata', async () => {
  const root = tempDir();
  const config = testConfig(root);
  const receiver = await startOtlpServer(config, { host: '127.0.0.1', port: 0, quiet: true });
  const address = receiver.server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture('codex-otlp.json'))
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.accepted, 1);
    const stored = fs.readFileSync(config.dataFile, 'utf8');
    assert.match(stored, /codex\.api_request/);
    assert.doesNotMatch(stored, /SECRET BODY|SECRET ATTRIBUTE|prompt/);
  } finally {
    await receiver.close();
  }
});

test('OTLP protobuf logs are decoded without storing arbitrary bodies', async () => {
  const config = testConfig(tempDir());
  const receiver = await startOtlpServer(config, { host: '127.0.0.1', port: 0, quiet: true });
  const address = receiver.server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: minimalLogsProtobuf()
    });
    assert.equal(response.status, 200);
    const stored = fs.readFileSync(config.dataFile, 'utf8');
    assert.match(stored, /codex\.protobuf_request/);
    assert.match(stored, /gpt-protobuf-test/);
    assert.match(stored, /"input_total":4000/);
    assert.match(stored, /"cache_read":2500/);
    assert.doesNotMatch(stored, /SECRET PROTOBUF|prompt|arbitrary\.text/);
  } finally { await receiver.close(); }
});

test('protobuf metrics are rejected rather than partially misparsed', async () => {
  const config = testConfig(tempDir());
  const receiver = await startOtlpServer(config, { host: '127.0.0.1', port: 0, quiet: true });
  const address = receiver.server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/metrics`, {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: Buffer.from([0, 1, 2])
    });
    assert.equal(response.status, 415);
  } finally { await receiver.close(); }
});
