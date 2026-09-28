import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'tokenwatch.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwatch-smoke-'));
const env = { ...process.env, TOKENWATCH_HOME: home };

function run(args, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: { ...env, ...extraEnv } });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function render(cost, percent, input, cacheRead, output) {
  run(['status', '--agent', 'claude', '--ingest-stdin'], JSON.stringify({
    session_id: 'smoke', model: { id: 'smoke-model' }, cost: { total_cost_usd: cost },
    prompt_cache: { ttl: '1h' },
    context_window: {
      used_percentage: percent,
      current_usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: output }
    }
  }));
}

run(['version']);
run(['hook', 'claude', 'SessionStart'], JSON.stringify({ session_id: 'smoke', cwd: '/private/smoke' }));

// Three renders spanning two turns. A status line re-renders continuously, so
// the audit must count turns, not refreshes.
render(0.1, 10, 100, 900, 50);
render(0.12, 12, 120, 1000, 60);
run(['hook', 'claude', 'UserPromptSubmit'], JSON.stringify({ session_id: 'smoke' }));
render(0.2, 14, 130, 1100, 70);

const audit = JSON.parse(run(['analyze', '--since', '1d', '--format', 'json']));
if (audit.aggregate.turns !== 2) {
  throw new Error(`expected 2 turns from 3 renders across one prompt boundary, got ${audit.aggregate.turns}`);
}
if (audit.aggregate.context_samples.turns !== 2) throw new Error('gauge samples were not tracked separately');
if (audit.aggregate.tokens.input_total !== 0) throw new Error('gauge samples must not be summed into additive totals');
if (!fs.existsSync(path.join(home, 'events.jsonl'))) throw new Error('event store was not created');

// Named explicitly: run inside Claude Code, the hand run would otherwise report
// the caller's own session, which this temporary home has never seen.
const statusLine = run(['status', '--agent', 'claude', '--session', 'smoke']);
const lowered = statusLine.toLowerCase();
for (const label of ['previous reply', 'session', 'ctx', 'tokens', 'sent', 'output', 'from cache', 'cache warm']) {
  if (!lowered.includes(label)) throw new Error(`status line lost the "${label}" label: ${statusLine}`);
}
if (statusLine.trim().split('\n').length < 2) {
  throw new Error(`expected a multi-row status line, got: ${statusLine}`);
}
// Ranked drivers are computed in code, not left to a reader to total up.
const ranked = JSON.parse(run(['analyze', '--since', '1d', '--group-by', 'model', '--compare', '--format', 'json']));
if (!ranked.ranking?.groups?.length) throw new Error('--group-by produced no ranking');
if (ranked.ranking.groups[0].key !== 'smoke-model') throw new Error('ranking did not group on the model');
if (Math.abs(ranked.ranking.shown_provider_share - 1) > 1e-9) throw new Error('a complete ranking must cover the whole period');
if (!ranked.concentration || !ranked.compactions) throw new Error('--group-by must also report concentration and compactions');
if (ranked.comparison?.provider_cost_usd?.current !== ranked.ranking.total_provider_usd) {
  throw new Error('--compare disagreed with the ranking about current spend');
}

// The experiment journal closes the loop between proposing a change and
// measuring it; a proposal with nothing to measure against is refused.
const id = run(['experiment', 'add',
  '--hypothesis', 'smoke', '--change', 'smoke', '--baseline', 'smoke', '--metric', 'smoke']).trim();
if (!run(['experiment', 'list']).includes(id)) throw new Error('an open experiment was not listed');
run(['experiment', 'close', id, '--result', 'adopted', '--outcome', 'smoke outcome']);
if (run(['experiment', 'list']).includes(id)) throw new Error('a closed experiment is still listed as open');
if (!run(['experiment', 'list', '--all']).includes('smoke outcome')) throw new Error('the closed outcome was not retained');

// One command fills in history from before install: two synthetic Claude
// sessions, imported as tokens-only rows that analyze counts apart from the
// live gauge samples (intent 06, SM-07).
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwatch-smoke-claude-'));
const responses = [['imp-a', 'msg_a1', 100, 10], ['imp-a', 'msg_a2', 200, 20], ['imp-b', 'msg_b1', 300, 30]];
for (const session of ['imp-a', 'imp-b']) {
  fs.mkdirSync(path.join(claudeDir, 'projects', 'p'), { recursive: true });
  const lines = responses.filter(([id]) => id === session).map(([, messageId, input, output], index) => JSON.stringify({
    type: 'assistant', sessionId: session, timestamp: new Date(Date.now() - (60 - index) * 60_000).toISOString(),
    message: { id: messageId, model: 'smoke-model', usage: { input_tokens: input, output_tokens: output } }
  }));
  fs.writeFileSync(path.join(claudeDir, 'projects', 'p', `${session}.jsonl`), `${lines.join('\n')}\n`);
}
const imported = JSON.parse(run(['import', 'claude', '--since', '1d', '--accept-unverified', '--json'], undefined, { CLAUDE_CONFIG_DIR: claudeDir }));
if (imported.responses_written !== 3) throw new Error(`expected 3 imported responses, got ${imported.responses_written}`);
const withHistory = JSON.parse(run(['analyze', '--since', '1d', '--format', 'json']));
if (withHistory.aggregate.imported_turns !== 3) throw new Error(`analyze counted ${withHistory.aggregate.imported_turns} imported turns, not 3`);
if (withHistory.aggregate.tokens.input_total !== 600) throw new Error('imported input tokens were not totalled');
if (withHistory.aggregate.context_samples.turns !== 2) throw new Error('imported history disturbed the live gauge turns');

console.log('smoke ok');
console.log(statusLine.trim());
