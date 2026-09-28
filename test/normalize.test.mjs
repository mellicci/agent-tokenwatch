import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { normalizeCopilot } from '../src/normalize/copilot.mjs';
import { normalizeCodexNotify, normalizeCodexOtlpLogs } from '../src/normalize/codex.mjs';
import { fixture, tempDir, testConfig } from './helpers.mjs';

const config = testConfig(tempDir());

test('Claude status normalizes component cache accounting and cumulative cost', () => {
  const [event] = normalizeClaude('status', fixture('claude-status-1.json'), config, 'statusline');
  assert.equal(event.agent, 'claude-code');
  assert.equal(event.kind, 'usage');
  assert.equal(event.usage.input_fresh, 1000);
  assert.equal(event.usage.cache_read, 6500);
  assert.equal(event.usage.cache_write, 500);
  assert.equal(event.usage.input_total, 8000);
  assert.equal(event.usage.output, 900);
  assert.equal(event.cost.cumulative_usd, 1.25);
  assert.equal(event.cost.basis, 'provider_reported');
  assert.equal(event.flags.cost_cumulative, true);
  assert.match(event.project_id, /^project_[a-f0-9]{20}$/);
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /THIS MUST NEVER BE STORED|transcript|example-project/);
});

test('Copilot cached input is a subset and is not double-counted', () => {
  const [event] = normalizeCopilot('status', fixture('copilot-status.json'), config, 'statusline');
  assert.equal(event.agent, 'github-copilot-cli');
  assert.equal(event.usage.input_total, 5000);
  assert.equal(event.usage.cache_read, 3000);
  assert.equal(event.usage.input_fresh, 2000);
  assert.equal(event.usage.total, 5400);
  assert.equal(event.cost.amount_usd, 0.02);
  assert.equal(event.context.percent, 40);
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /SECRET TOOL CONTENT|private|toolOutput/);
});

test('Codex notify stores only structural lengths', () => {
  const [event] = normalizeCodexNotify('agent-turn-complete', fixture('codex-notify.json'), config);
  assert.equal(event.agent, 'codex-cli');
  assert.equal(event.metrics.input_message_count, 2);
  assert.ok(event.metrics.input_message_bytes > 0);
  assert.ok(event.metrics.assistant_output_bytes > 0);
  assert.doesNotMatch(JSON.stringify(event), /SECRET|codex-project|input-messages|last-assistant-message/);
});

test('Codex OTLP body is allowlisted and arbitrary text is discarded', () => {
  const events = normalizeCodexOtlpLogs(fixture('codex-otlp.json'), config);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event_name, 'codex.api_request');
  assert.equal(event.model, 'gpt-test');
  assert.equal(event.usage.input_total, 9000);
  assert.equal(event.usage.cache_read, 6000);
  assert.equal(event.usage.input_fresh, 3000);
  assert.equal(event.usage.output, 800);
  assert.equal(event.cost.amount_usd, 0.04);
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /SECRET BODY|SECRET ATTRIBUTE|prompt|arbitrary\.text|otlp-project/);
});

// The shape Copilot CLI 1.0.85 writes to a status line command's stdin, read
// out of the shipped bundle rather than guessed from field names.
test('a Copilot 1.0.85 status object yields model, context, and cache-split tokens', () => {
  const payload = fixture('copilot-status-1085.json');
  const [event] = normalizeCopilot('status', payload, config, 'statusline');

  assert.equal(event.model, 'claude-sonnet-4.5');
  assert.equal(event.context.percent, 34);
  assert.equal(event.usage.basis, 'sample', 'a status render is a gauge, not an additive charge');
  assert.equal(event.usage.input_total, 68000);
  assert.equal(event.usage.cache_read, 64000);
  assert.equal(event.usage.cache_write, 1500);
  // Copilot's total contains both cache halves, so fresh input is the remainder.
  assert.equal(event.usage.input_fresh, 2500);
  assert.equal(event.usage.output, 640);
  // No currency anywhere in Copilot's payload; duration and request counts are
  // not money and must not become a cost observation.
  assert.equal(event.cost, undefined);
  const serialized = JSON.stringify(event);
  for (const secret of ['SECRET SESSION TITLE', 'transcript.json', '/private/workspace']) {
    assert.ok(!serialized.includes(secret), `${secret} must not be persisted`);
  }
});

test('the router name alone is not recorded as a model', () => {
  const unresolved = fixture('copilot-status-cumulative-2.json');
  unresolved.model = { id: 'auto', display_name: 'Auto', auto_tier: null };
  const [event] = normalizeCopilot('status', unresolved, config, 'statusline');
  assert.equal(event.model, undefined, '"Auto" is a router, not a model that ran');
});

// Codex fills logRecord.eventName with a Rust source location and puts the
// semantic name in the event.name attribute.
test('Codex OTLP events are named by event.name, not by its source tree', () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ scope: { name: 'codex_otel.log_only' }, logRecords: [{
      eventName: 'event otel/src/events/session_telemetry.rs:1012',
      timeUnixNano: '0',
      observedTimeUnixNano: '1789661690877997369',
      attributes: [
        { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
        { key: 'input_token_count', value: { intValue: '15268' } },
        { key: 'output_token_count', value: { intValue: '5' } },
        { key: 'cached_token_count', value: { intValue: '11136' } },
        { key: 'cache_write_token_count', value: { intValue: '0' } },
        { key: 'model', value: { stringValue: 'gpt-5.6-sol' } },
        { key: 'conversation.id', value: { stringValue: 'codex-session-1' } },
        { key: 'user.email', value: { stringValue: 'someone@example.com' } },
        { key: 'terminal.type', value: { stringValue: 'vscode/1.136.1' } }
      ]
    }] }] }]
  };
  const [event] = normalizeCodexOtlpLogs(payload, config);

  assert.equal(event.event_name, 'codex.sse_event');
  // timeUnixNano is 0 here; dating this to 1970 hid every Codex event from --since.
  assert.equal(event.ts, '2026-09-17T16:14:50.877Z');
  assert.equal(event.usage.input_total, 15268);
  assert.equal(event.usage.cache_read, 11136);
  // Codex's own footer reports 4137 tokens used for this call: 15268 - 11136
  // uncached input, plus 5 output.
  assert.equal(event.usage.input_fresh, 4132);
  assert.equal(event.usage.output, 5);

  const serialized = JSON.stringify(event);
  for (const attribute of ['someone@example.com', 'vscode', 'session_telemetry.rs']) {
    assert.ok(!serialized.includes(attribute), `${attribute} must not be persisted`);
  }
});

// Billing counters move on renders where nothing else does. Leaving them out of
// the fingerprint made those renders look like duplicates of the previous one
// and dropped them, freezing the session total.
test('a render that moves only the billing counter is not a duplicate', () => {
  const first = fixture('copilot-status-cumulative-2.json');
  const second = fixture('copilot-status-cumulative-2.json');
  second.ai_used = { total_nano_aiu: 20000000000, formatted: '20.00' };

  const [a] = normalizeCopilot('status', first, config, 'statusline');
  const [b] = normalizeCopilot('status', second, config, 'statusline');
  assert.notEqual(a.fingerprint, b.fingerprint);
});
