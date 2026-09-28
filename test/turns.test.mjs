import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeClaude } from '../src/normalize/claude.mjs';
import { normalizeCopilot } from '../src/normalize/copilot.mjs';
import { aggregateEvents, groupTurns, rollingStatusFromState, turnReadings } from '../src/aggregate.mjs';
import { analyzeEvents } from '../src/analyze.mjs';
import { comparePeriods, rankGroups, turnConcentration } from '../src/rank.mjs';
import { formatStatus } from '../src/format.mjs';
import { makeEvent } from '../src/schema.mjs';
import { flushPendingTurns, sessionStateFile, statusState, storeEvents } from '../src/store.mjs';
import { fixture, tempDir, testConfig } from './helpers.mjs';

// A turn is one prompt and the whole answer to it, however many model calls
// (tool round-trips) that answer takes. Copilot's payloads carry no prompt or
// turn id, so every model call - the movement of its cumulative counters
// between two renders - used to be a turn of its own: a Windows live test
// (Copilot CLI 1.0.88) showed 16 turns for a session of three prompts whose
// billing matched Copilot to the unit. Its `userPromptSubmitted` hook is what
// marks a prompt, and it now delimits the turns.

function ledgerLines(config) {
  if (!fs.existsSync(config.dataFile)) return [];
  const text = fs.readFileSync(config.dataFile, 'utf8').trim();
  return text ? text.split('\n').map(JSON.parse) : [];
}

const SESSION = 'copilot-cumulative-session';
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

// A Copilot session built from the recorded 1.0.85 status payload, its
// cumulative counters advanced by hand, and the prompt hook Copilot sends when a
// prompt is submitted. Every timestamp is a literal step of one second.
function copilotSession(config, { start = '2026-09-28T09:00:00.000Z' } = {}) {
  const payload = fixture('copilot-status-cumulative-1.json');
  const window = payload.context_window;
  let clock = Date.parse(start);
  const tick = () => (clock += 1000);
  let renders = 0;
  return {
    get renders() { return renders; },
    // One status-line render. With `aiu`, the model call behind it moved the
    // counters; without, it is an idle re-render that moved nothing.
    render({ aiu = 0, premium = 0, input = 0, output = 0, percent } = {}) {
      window.total_input_tokens += input;
      window.total_cache_read_tokens += Math.max(0, input - 10);
      window.total_output_tokens += output;
      window.total_tokens += input + output;
      payload.ai_used.total_nano_aiu += Math.round(aiu * 1e9);
      payload.cost.total_premium_requests += premium;
      if (percent !== undefined) window.current_context_used_percentage = percent;
      payload.timestamp = new Date(tick()).toISOString();
      renders += 1;
      return storeEvents(normalizeCopilot('status', structuredClone(payload), config, 'statusline'), config);
    },
    prompt() {
      return storeEvents(normalizeCopilot('userPromptSubmitted', {
        sessionId: SESSION, timestamp: tick(), cwd: '/private/workspace/project', prompt: 'SECRET PROMPT TEXT'
      }, config, 'hook'), config);
    },
    tool() {
      return storeEvents(normalizeCopilot('postToolUse', {
        sessionId: SESSION, timestamp: tick(), cwd: '/private/workspace/project', toolName: 'bash',
        toolArgs: 'SECRET TOOL CONTENT'
      }, config, 'hook'), config);
    }
  };
}

// Three prompts answered by two, one and three model calls, with idle renders
// before the first prompt and between calls.
function threePrompts(session) {
  session.render({ percent: 48 });                                        // baseline, before any prompt
  session.render({ percent: 48 });                                        // idle, before any prompt
  session.prompt();
  session.render({ aiu: 0.05, premium: 1, input: 1000, output: 50, percent: 50 });
  session.tool();
  session.render({ percent: 50 });                                        // idle, mid-reply
  session.render({ aiu: 0.02, input: 1200, output: 20, percent: 51 });
  session.prompt();
  session.render({ aiu: 0.1, premium: 1, input: 2000, output: 80, percent: 55 });
  session.prompt();
  session.render({ aiu: 0.01, premium: 1, input: 500, output: 5, percent: 56 });
  session.tool();
  session.render({ aiu: 0.02, input: 600, output: 6, percent: 57 });
  session.tool();
  session.render({ aiu: 0.03, input: 700, output: 7, percent: 58 });
  session.render({ percent: 58 });                                        // idle, after the last call
}

test('three Copilot prompts are three turns, however many model calls answer each', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  threePrompts(session);
  const events = ledgerLines(config);

  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.turns, 3, `three prompts, got ${aggregate.turns} turns`);
  assert.equal(aggregate.undelimited_turns, 0, 'every call sits behind a prompt hook');
  assert.equal(aggregate.tokens.input_total, 6000, 'every call\'s tokens are still summed once');
  assert.equal(aggregate.render_only_readings, 2, 'the two renders before the first prompt are readings, not turns');
  assert.equal(aggregate.context_percent_samples.turns, session.renders, 'every context reading is kept');
  assert.equal(aggregate.context_percent_samples.percent_last, 58);

  // Per turn: the prompt and every call behind it.
  const perTurn = aggregate.turns_data.map((turn) => turn.billing);
  near(perTurn[0].aiu, 0.07, 'first prompt, two calls');
  near(perTurn[1].aiu, 0.1, 'second prompt, one call');
  near(perTurn[2].aiu, 0.06, 'third prompt, three calls');
  assert.deepEqual(perTurn.map((billing) => billing.premium_requests), [1, 1, 1]);

  // The totals match what Copilot itself reports, less the baseline render.
  const ranking = rankGroups(events, { by: 'session' });
  assert.equal(ranking.ranked_by, 'billing:aiu');
  assert.equal(ranking.total_provider_usd, 0, 'Copilot reports no dollars and none are invented');
  const [row] = ranking.groups;
  assert.equal(row.key, SESSION);
  assert.equal(row.turns, 3);
  near(row.billing.aiu, 0.23, 'session AIU');
  assert.equal(row.billing.premium_requests, 3);
  assert.equal(row.billing_share.aiu, 1);
  assert.equal(row.undelimited_turns, 0);

  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /SECRET PROMPT TEXT|SECRET TOOL CONTENT|SECRET SESSION TITLE|\/private\//);
});

test('every unit a held Copilot reply moved is kept when it is written, not only the last render\'s', () => {
  // A gauge-shaped Copilot render (the recorded payload that carries a per-call
  // `current_usage`) is held until the reply ends, like Claude's, and each
  // render replaces the one before. Cost accumulated across the held renders;
  // billing units did not, so a reply written from three renders kept only
  // the units the last one moved.
  // Real status payloads carry no timestamp, and a held reply older than an
  // hour is written out early, so these renders are stamped when stored.
  const config = testConfig(tempDir());
  const render = (aiu, requests) => {
    const payload = fixture('copilot-status-1085.json');
    payload.ai_used.total_nano_aiu = Math.round(aiu * 1e9);
    payload.cost.total_premium_requests = requests;
    storeEvents(normalizeCopilot('status', payload, config, 'statusline'), config);
  };
  const prompt = () => storeEvents(normalizeCopilot('userPromptSubmitted', { sessionId: 'copilot-session-9' }, config, 'hook'), config);
  prompt();
  render(1, 4);        // baseline for the units
  render(1.2, 5);      // 0.2 AIU and a premium request
  render(1.5, 5);      // 0.3 AIU more, same reply
  prompt();
  render(1.6, 6);      // 0.1 AIU
  flushPendingTurns(config);
  assert.equal(ledgerLines(config).filter((event) => event.source === 'statusline').length, 2,
    'one row per held reply');

  const turns = groupTurns(ledgerLines(config));
  assert.equal(turns.length, 2);
  near(turns[0].billing.aiu, 0.5, 'both movements of one held reply');
  assert.equal(turns[0].billing.premium_requests, 1);
  near(turns[1].billing.aiu, 0.1, 'second reply');
});

test('prompt delimiting follows time, not the order rows sit in the file', () => {
  // A ledger is not always in time order: repair merges files, and an import
  // appends older rows after newer ones. The turns an existing ledger is read
  // into must not depend on it.
  const config = testConfig(tempDir());
  threePrompts(copilotSession(config));
  const events = ledgerLines(config);
  const inOrder = groupTurns(events);
  const reversed = groupTurns([...events].reverse());
  assert.equal(reversed.length, 3);
  reversed.forEach((turn, index) => {
    near(turn.billing.aiu, inOrder[index].billing.aiu, `turn ${index + 1} AIU`);
    assert.equal(turn.billing.premium_requests, inOrder[index].billing.premium_requests);
  });
  assert.deepEqual(reversed.map((turn) => turn.usage.input_total), [2200, 2000, 1800]);
});

// L3 (review): the turns were chosen in time order, but the readings inside
// one - the newest context reading, gauge and model - still followed the file,
// so a reversed ledger reported 56% as the latest context reading instead of 58%.
test('the latest reading of a turn is the latest in time, not the last in the file', () => {
  const config = testConfig(tempDir());
  threePrompts(copilotSession(config));
  const events = ledgerLines(config);
  const inOrder = aggregateEvents(events);
  const reversed = aggregateEvents([...events].reverse());
  assert.equal(reversed.context_percent_samples.percent_last, 58, 'the newest context reading of the period');
  assert.deepEqual(reversed.context_percent_samples, inOrder.context_percent_samples);
  assert.deepEqual(reversed.turns_data.map((turn) => turn.context_percent), [51, 55, 58]);
  assert.deepEqual(reversed.turns_data.map((turn) => turn.context_percent),
    inOrder.turns_data.map((turn) => turn.context_percent));
});

test('with no prompt hook each Copilot model call stays its own turn, and the report says so', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  session.render({ percent: 40 });
  session.render({ aiu: 0.05, premium: 1, input: 1000, output: 50, percent: 41 });
  session.render({ aiu: 0.02, input: 1200, output: 20, percent: 42 });
  session.render({ aiu: 0.1, premium: 1, input: 2000, output: 80, percent: 43 });
  const events = ledgerLines(config);

  const aggregate = aggregateEvents(events);
  assert.equal(aggregate.turns, 3, 'no hook delimits them, so each call is counted, never merged by guess');
  assert.equal(aggregate.undelimited_turns, 3);
  near(aggregate.turns_data.reduce((sum, turn) => sum + turn.billing.aiu, 0), 0.17, 'billing is unaffected');
  assert.equal(rankGroups(events, { by: 'session' }).groups[0].undelimited_turns, 3);

  const coverage = analyzeEvents(events, testConfig(tempDir())).observations.find((row) => row.id === 'coverage');
  assert.match(coverage.evidence, /3 turns had no turn id and no prompt hook in the period to delimit them, so each is counted per model call/);
});

test('a prompt hook that names no session delimits no session\'s calls', () => {
  // Sessions are told apart by id alone. A prompt hook without one cannot be
  // placed in any session, so the calls stay one turn each, and are counted as
  // undelimited rather than attached to a guessed prompt.
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  session.render({ percent: 40 });
  storeEvents(normalizeCopilot('userPromptSubmitted', { timestamp: Date.parse('2026-09-28T09:00:01.500Z') }, config, 'hook'), config);
  session.render({ aiu: 0.05, premium: 1, input: 1000, output: 50, percent: 41 });
  session.render({ aiu: 0.02, input: 1200, output: 20, percent: 42 });
  const aggregate = aggregateEvents(ledgerLines(config));
  assert.equal(aggregate.turns, 2);
  assert.equal(aggregate.undelimited_turns, 2);
});

test('a period that starts mid-reply counts only the calls before the first prompt it holds per call', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  threePrompts(session);
  const events = ledgerLines(config);
  // --since between the first prompt's two calls: its hook is outside the window.
  const since = events.find((event) => event.event_name === 'postToolUse').ts;
  const window = events.filter((event) => event.ts >= since);

  const aggregate = aggregateEvents(window);
  assert.equal(aggregate.turns, 3, 'the cut-off reply\'s remaining call, then the two whole prompts');
  assert.equal(aggregate.undelimited_turns, 1);
  near(aggregate.turns_data[0].billing.aiu, 0.02, 'only the call inside the window');
});

test('Claude turns are unchanged beside a Copilot session, and imported rows stay one turn each', () => {
  const claudeConfig = testConfig(tempDir());
  const claude = (name, payload, source) => storeEvents(normalizeClaude(name, payload, claudeConfig, source), claudeConfig);
  const render = (prompt, cost, input) => claude('status', {
    session_id: 'c1', prompt_id: prompt, model: { id: 'claude-test-model' }, cost: { total_cost_usd: cost },
    context_window: { used_percentage: 5, current_usage: { input_tokens: input, cache_read_input_tokens: 9, output_tokens: 1 } }
  }, 'statusline');
  const prompt = (id) => claude('UserPromptSubmit', { session_id: 'c1', prompt_id: id, hook_event_name: 'UserPromptSubmit' }, 'hook');
  render('pre', 1, 10);                      // before the first prompt: a baseline render
  prompt('p1');
  render('p1', 1.5, 20);
  render('p1', 2, 30);
  render('slash', 2, 30);                    // /status: a render-only reading
  prompt('p2');
  render('p2', 2.5, 40);
  flushPendingTurns(claudeConfig);
  const claudeEvents = ledgerLines(claudeConfig);

  const copilotConfig = testConfig(tempDir());
  threePrompts(copilotSession(copilotConfig));
  const imported = makeEvent({
    agent: 'copilot', kind: 'usage', source: 'import', event_name: 'import.response', ts: '2026-09-20T09:00:00.000Z',
    session_id: 'older-copilot-session', turn_id: 'session-summary',
    usage: { input_total: 900, output: 30, semantics: 'components', basis: 'transcript' },
    billing: { aiu: 1.5, premium_requests: 4 },
    import: { mapping_id: 'copilot-events-1', mapping_version: '1.0', run_id: 'run-1', verification: 'verified' }
  });
  const mixed = [...claudeEvents, ...ledgerLines(copilotConfig), imported];

  const alone = groupTurns(claudeEvents, { includeRenderOnly: true });
  const beside = groupTurns(mixed, { includeRenderOnly: true }).filter((turn) => turn.agent === 'claude-code');
  assert.deepEqual(beside, alone, 'every Claude reading is grouped exactly as it was on its own');
  assert.equal(alone.filter((turn) => !turn.render_only).length, 2, 'two prompts, two Claude turns');

  const aggregate = aggregateEvents(mixed);
  assert.equal(aggregate.turns, 2 + 3 + 1);
  assert.equal(aggregate.imported_turns, 1, 'one imported summary is one turn, as before');
  assert.equal(aggregate.undelimited_turns, 0);
  const byAgent = rankGroups(mixed, { by: 'agent' });
  assert.equal(byAgent.ranked_by, 'provider_cost_usd', 'a period with dollars still ranks by dollars');
  const copilotRow = byAgent.groups.find((row) => row.key === 'github-copilot-cli');
  assert.equal(copilotRow.turns, 4);
  near(copilotRow.billing.aiu, 0.23 + 1.5, 'live and imported units');
});

test('the Copilot status line counts a reply as the prompt and every call behind it', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  threePrompts(session);

  const snapshot = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  near(snapshot.in_flight_billing.aiu, 0.06, 'this reply: the third prompt\'s three calls so far');
  assert.equal(snapshot.in_flight_billing.premium_requests, 1);
  near(snapshot.last_prompt_billing.aiu, 0.1, 'previous reply: the whole second prompt');
  assert.equal(snapshot.session_billing.premium_requests, 11, 'the session total is still Copilot\'s own');
  const line = formatStatus(snapshot, config, { NO_COLOR: '1', COLUMNS: '200' });
  assert.match(line, /this reply 0\.060 AIU so far/);
  assert.match(line, /previous reply 0\.100 AIU/);
  assert.doesNotMatch(line, /\$/);
});

test('a state file written before replies kept a running total still shows the replies the ring holds', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  threePrompts(session);
  const file = sessionStateFile(config, SESSION);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.replyTotals, 'this version keeps the totals');
  delete state.replyTotals;
  fs.writeFileSync(file, JSON.stringify(state));

  const snapshot = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  near(snapshot.in_flight_billing.aiu, 0.06, 'this reply, summed from the ring as before');
  near(snapshot.last_prompt_billing.aiu, 0.1, 'previous reply, summed from the ring as before');

  session.prompt();
  session.render({ aiu: 0.04, input: 100, output: 5, percent: 60 });
  const after = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  near(after.in_flight_billing.aiu, 0.04, 'the first reply opened after the upgrade keeps a total');
  near(after.last_prompt_billing.aiu, 0.06, 'the reply in flight at the upgrade, from the ring');
});

test('without a prompt hook the Copilot status line keeps one reply per call', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  session.render({ percent: 40 });
  session.render({ aiu: 0.05, premium: 1, input: 1000, output: 50, percent: 41 });
  session.render({ aiu: 0.02, input: 1200, output: 20, percent: 42 });

  const snapshot = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  assert.equal(snapshot.in_flight_billing, undefined, 'nothing marks a reply as open');
  near(snapshot.last_prompt_billing.aiu, 0.02, 'the last call, as before');
});

// M2 (review): the reply was rebuilt from the live ring, which keeps the newest
// 200 entries of the session, and idle renders and tool hooks take slots in it
// too. A reply of 120 calls showed 0.66 AIU on the status line where `analyze`
// counted 1.20. The store now keeps each reply's running total in session
// state, so the status line no longer depends on how much of the reply is
// still in the ring.
test('the Copilot status line counts a whole reply however many renders and hooks it spans', () => {
  const config = testConfig(tempDir());
  const session = copilotSession(config);
  session.render({ percent: 40 });                                         // baseline
  session.prompt();
  for (let call = 0; call < 90; call += 1) {
    session.render({ aiu: 0.01, premium: call === 0 ? 1 : 0, input: 100, output: 5, percent: 41 });
    session.tool();
    session.render({ percent: 41 });                                       // idle, mid-reply
  }
  const long = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  near(long.in_flight_billing.aiu, 0.9, 'this reply: all 90 calls, not only those still in the ring');
  assert.equal(long.in_flight_billing.premium_requests, 1);

  session.prompt();
  session.render({ aiu: 0.05, premium: 1, input: 100, output: 5, percent: 42 });
  for (let idle = 0; idle < 210; idle += 1) { session.tool(); session.render({ percent: 42 }); }
  const snapshot = rollingStatusFromState(statusState(config, SESSION), config, 'copilot');
  near(snapshot.in_flight_billing.aiu, 0.05, 'this reply, although its one call has left the ring');
  near(snapshot.last_prompt_billing.aiu, 0.9, 'previous reply: the whole first prompt');
  assert.equal(snapshot.last_prompt_billing.premium_requests, 1);

  // The same figures `analyze` reads from the ledger.
  const turns = groupTurns(ledgerLines(config));
  assert.equal(turns.length, 2);
  near(turns[0].billing.aiu, snapshot.last_prompt_billing.aiu, 'status line and analyze agree on the first reply');
  near(turns[1].billing.aiu, snapshot.in_flight_billing.aiu, 'and on the second');
});

// M3 (review): every section of one report grouped the whole period into turns
// again - about eight times for `analyze --group-by --compare` - and reports
// became three times slower once grouping sorted every row. The period is now
// grouped once and the same turns handed to each section, so a section given
// them must not need the rows again, and must report exactly what it would
// have computed itself.
test('report sections handed the period\'s turns report the same figures without grouping the rows again', () => {
  const config = testConfig(tempDir());
  threePrompts(copilotSession(config));
  const events = ledgerLines(config);
  const priorConfig = testConfig(tempDir());
  threePrompts(copilotSession(priorConfig, { start: '2026-09-27T09:00:00.000Z' }));
  const prior = ledgerLines(priorConfig);
  const readings = turnReadings(events);
  const priorReadings = turnReadings(prior);

  assert.deepEqual(readings, groupTurns(events, { includeRenderOnly: true }));
  assert.deepEqual(aggregateEvents(events, { readings }), aggregateEvents(events));
  assert.deepEqual(rankGroups([], { by: 'session', readings }), rankGroups(events, { by: 'session' }));
  assert.deepEqual(turnConcentration([], { readings }), turnConcentration(events));
  assert.deepEqual(comparePeriods(events, prior, { current: readings, prior: priorReadings }), comparePeriods(events, prior));
  const withTurns = analyzeEvents(events, config, { readings });
  const alone = analyzeEvents(events, config);
  assert.deepEqual({ ...withTurns, generated_at: undefined }, { ...alone, generated_at: undefined });
});
