import { AGENTS, AGENT_NAMES, CODEX_WRAPPER_ENV } from './constants.mjs';

// A skill invoked inside one agent must report on that agent. Run from Copilot,
// a skill that defaults to Claude describes somebody else's session with total
// confidence, which is worse than declining to guess.
//
// Every marker below was confirmed by running the real CLI and inspecting the
// environment a spawned shell command actually receives - not guessed from
// documentation. Codex sets CODEX_* for its sandboxed exec tool; Copilot sets
// COPILOT_* for a spawned shell command in non-interactive (-p) mode; Claude
// Code sets CLAUDECODE for any command the agent runs. Two caveats this cannot
// see past: an agent's own docs may rename these across versions, and if one
// agent is launched *from inside* another (Codex run from a Claude Code shell,
// for instance), the outer agent's markers are still ambient in the child's
// environment and win by list order below - set TOKENWATCH_AGENT explicitly in
// that case rather than trusting detection.
const MARKERS = [
  ['claude', ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']],
  ['copilot', ['COPILOT_CLI', 'COPILOT_CLI_BINARY_VERSION', 'COPILOT_AGENT_SESSION_ID']],
  ['codex', ['CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']]
];

// Which environment variable carries the agent's own session id - the same value
// its adapter stores as `session_id` - so a hand-run `status` inside that agent
// can report the session that asked (intent 15). Only a marker checked against a
// real session is ever read; an unverified one would swap one confident
// misattribution for another. Flipping an entry is a one-line, dated change.
export const SESSION_MARKERS = {
  claude: [{ name: 'CLAUDE_CODE_SESSION_ID', verified: true, checked: '2026-09-24' }],
  copilot: [{ name: 'COPILOT_AGENT_SESSION_ID', verified: false }],
  codex: [{ name: 'CODEX_THREAD_ID', verified: false }, { name: 'CODEX_SESSION_ID', verified: false }]
};

// Keyed on the agent asked about, never on detectHostAgent's winner: an outer
// agent's ambient marker must not answer for an inner one (FR-05).
export function hostSessionId(agent, env = process.env) {
  const short = Object.keys(AGENT_NAMES).find((key) => key === agent || AGENT_NAMES[key] === agent);
  for (const marker of SESSION_MARKERS[short] ?? []) {
    if (!marker.verified) continue;
    const value = env[marker.name];
    if (typeof value === 'string' && value !== '') return { sessionId: value, basis: `environment:${marker.name}` };
  }
  return { sessionId: undefined, basis: 'unknown' };
}

export function detectHostAgent(env = process.env) {
  const explicit = env.TOKENWATCH_AGENT;
  if (explicit && AGENTS.includes(explicit)) {
    return { agent: explicit, name: AGENT_NAMES[explicit], basis: 'TOKENWATCH_AGENT' };
  }
  for (const [agent, keys] of MARKERS) {
    const seen = keys.find((key) => env[key] !== undefined && env[key] !== '');
    if (seen) return { agent, name: AGENT_NAMES[agent], basis: `environment:${seen}` };
  }
  return { agent: undefined, name: undefined, basis: 'unknown' };
}

// Whether this process runs inside a Codex that `tokenwatch-codex` launched.
// The wrapper sets the marker on Codex, and Codex passes its environment on to
// the shell commands it runs unless `shell_environment_policy` says otherwise.
// So `true` is evidence; `false` means no marker arrived, which is either a
// plain `codex` launch or a policy that filtered it, and is reported as that.
export function launchedThroughCodexWrapper(env = process.env) {
  return env[CODEX_WRAPPER_ENV] === '1';
}

// What the ledger knows about each agent, so a caller that cannot identify its
// host can still see which agents are live and say which one it is reporting on.
export function agentActivity(events) {
  const byAgent = new Map();
  for (const event of events) {
    const row = byAgent.get(event.agent) ?? {
      agent: event.agent, events: 0, sessions: new Set(), last_activity: undefined,
      reports_cost: false, billing_units: new Set(), models: new Set(), status_samples: 0,
      imported_events: 0, imported_sessions: new Set()
    };
    byAgent.set(event.agent, row);
    // Imported history is not activity: counted apart, so an import on a fresh
    // install never makes an agent look live (intent 06, D4).
    if (event.source === 'import') {
      row.imported_events += 1;
      if (event.session_id) row.imported_sessions.add(event.session_id);
      continue;
    }
    row.events += 1;
    if (event.source === 'statusline') row.status_samples += 1;
    if (event.session_id) row.sessions.add(event.session_id);
    if (!row.last_activity || event.ts > row.last_activity) row.last_activity = event.ts;
    if (event.cost?.cumulative_usd !== undefined || event.cost?.amount_usd !== undefined) row.reports_cost = true;
    for (const unit of Object.keys(event.billing_cumulative ?? event.billing ?? {})) row.billing_units.add(unit);
    if (event.model) row.models.add(event.model);
  }
  return [...byAgent.values()]
    .map((row) => ({
      ...row,
      sessions: row.sessions.size,
      imported_sessions: row.imported_sessions.size,
      billing_units: [...row.billing_units],
      models: [...row.models].slice(0, 10)
    }))
    .sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')));
}

// What `tokenwatch agents` prints in the unit column. "no cost reported" used to
// be the answer whenever no dollars had arrived, and read as a fact about the
// provider. For an agent whose status line is the only source of its usage, the
// common reason is that the status line never delivered anything - another
// tool's status line outranking Tokenwatch's, on the first Windows install - so
// that case is stated as the count it is. Copilot bills in its own units rather
// than dollars, so its units are named whenever they have arrived.
const STATUS_LINE_AGENTS = new Set([AGENT_NAMES.claude, AGENT_NAMES.copilot]);

export function costLabel(row) {
  if (row.reports_cost) return 'USD';
  if (row.billing_units?.length) return row.billing_units.join(', ');
  if (STATUS_LINE_AGENTS.has(row.agent) && row.events > 0 && row.status_samples === 0) return '0 status-line samples';
  return 'no cost reported';
}
