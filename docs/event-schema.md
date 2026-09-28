# Normalized event schema

Each line of `events.jsonl` is a `tokenwatch.event/v1` object.

```json
{
  "schema": "tokenwatch.event/v1",
  "event_id": "opaque-id",
  "ts": "2026-08-22T12:34:56.000Z",
  "agent": "claude-code",
  "kind": "usage",
  "source": "statusline",
  "event_name": "status",
  "session_id": "opaque-session-id",
  "turn_id": "opaque-turn-id",
  "model": "provider-model-id",
  "project_id": "project_hmac-prefix",
  "usage": {
    "input_total": 8000,
    "input_fresh": 1000,
    "cache_read": 6500,
    "cache_write": 500,
    "cache_write_5m": 500,
    "output": 900,
    "reasoning": 200,
    "total": 8900,
    "semantics": "components",
    "basis": "sample"
  },
  "cost": {
    "delta_usd": 0.031,
    "cumulative_usd": 1.92,
    "basis": "provider_reported",
    "currency": "USD"
  },
  "context": {
    "used": 82000,
    "limit": 200000,
    "percent": 41
  },
  "cache": {
    "ttl_seconds": 3600,
    "age_seconds": 0,
    "hit_rate": 0.87,
    "ttl_source": "provider_reported"
  },
  "metrics": {
    "tool_output_bytes": 42000,
    "duration_ms": 1300
  }
}
```

All fields after `source` are optional.

## Usage basis

- `increment`: one distinct model call. Safe to add to other increments.
- `sample`: a gauge re-reported on every status refresh, describing the most
  recent call. Adding repeated samples would multiply one turn by the refresh
  rate, so aggregation reports them as last/median/p95 instead.
- `transcript`: one API response read from an agent's session file by an
  explicit `tokenwatch import`. Additive, and summed like `increment`; kept
  apart so reports can say which turns were imported. Such a row also carries
  an `import` block: `mapping_id`, `mapping_version`, `run_id`, `verification`
  (`verified` or `unverified`) and, on an unverified row, `reason`: the
  overlap check's verdict, one of `no_overlap`, `no_live_tokens` or
  `mismatch`, and nothing else. A run that stops (an invalid mapping, a
  read-only data directory) writes no row, so its reason is printed by the
  command, never stored. In `analyze`, `imported_turns` counts these turns and is
  part of `increment_turns`, not a third partition beside it.

A `cache` block is only present when the provider reported cache state; its
`ttl_source` records whether the numbers were measured or assumed. When the
provider also reports a cache hit ratio, it arrives as `hit_rate`, normalized
to a 0-1 fraction even when the source reported a percentage
(`src/normalize/claude.mjs`, `claudeCache`). `analyze` judges a within-session
gap against the TTL the provider reported for that session, and against the
configured `cacheTtlSeconds` only for a session that reported none. Its
`ttl-gaps` finding says which, in its text and in `ttl_sources`
(`provider_reported_gaps`, `provider_ttl_seconds`, `configured_gaps`,
`configured_ttl_seconds`); a configured TTL is named as an assumption.

## Turns and render-only readings

A turn is one prompt and the whole answer to it, however many model calls
(tool round-trips) that answer takes. Rows are grouped into turns:

- by `turn_id` where the agent supplies one (Claude's prompt id);
- otherwise by the prompt hook (`UserPromptSubmit`, `userPromptSubmitted`,
  `codex.user_prompt`): a row with no `turn_id` belongs to the turn the latest
  prompt hook of the same session opened, in `ts` order rather than file
  order. This is how Copilot, whose payloads carry no turn or prompt id, gets
  one turn per prompt instead of one per model call. The prompt hook must
  carry the session id the status line sends;
- otherwise per row. That is a row before the first prompt hook of its
  session among the rows read (hooks not installed, or a `--since` that starts
  mid-reply), and a row with no `session_id`. `analyze` counts these as
  `aggregate.undelimited_turns`, and each `--group-by` row as its own
  `undelimited_turns`; for Copilot each is one model call. An imported row
  (`source: "import"`) is always a turn of its own - one response, or for
  Copilot one session summary - and is not counted there.

The rows of a turn are read in `ts` order too, so what a turn keeps as its
latest - its sample gauge, its context reading, its model - is the latest in
time, wherever the rows sit in the file.

The ledger carries no synthetic turn id: turns are derived when the ledger is
read, so a ledger written before prompt delimiting existed is regrouped
without a migration. The status line applies the same rule from session state,
where the store numbers each session's prompts with a local counter and keeps a
running total of each reply a prompt hook opened (`replyTotals`: its calls,
billing units and cost, never adding a configured estimate to a provider
figure). `this reply` and `previous reply` come from
that total, so a reply is whole however many renders and hooks it spans, and
after a report has flushed part of it to the ledger. A state file written
before the total existed falls back to what its live ring still holds.

Claude Code also gives a prompt id to renders with no model call behind them:
a slash command such as `/status`, `/cost` or `/context`, the render after
`/compact`, and the render before the first prompt. Such a group is a
**render-only reading**, not a turn, when all of these hold:

- every row in it is a status-line reading (`source: "statusline"`, with
  `basis: "sample"` or no usage at all);
- no prompt hook (`UserPromptSubmit`, `userPromptSubmitted`,
  `codex.user_prompt`) carries its turn id;
- it moved no provider cost, no configured estimate and no billing units;
- its token gauge, if it has one, equals the previous reading's in the same
  session. The first reading of a session has nothing to compare with and is
  render-only when it moved no cost, since the first cumulative cost
  observation is a baseline.

`analyze` reports these as `aggregate.render_only_readings` and leaves them out
of `turns`, the cost and model breakdowns, `increment_turns`, rankings
(`--group-by` turn counts and `cost_per_turn_usd`), concentration and
`--compare`. Their context readings stay in `context_samples` and
`context_percent_samples`, whose `turns` count every reading and can be larger
than `aggregate.turns`; the audit's text calls them readings. The rule is applied when reading, so a ledger written
before it existed is read correctly without a migration.

By agent: a Copilot render that moved nothing - the first one of a session,
or any whose cumulative counters did not change - carries no usage, billing or
cost. Before the session's first prompt hook it is a render-only reading;
after one it is part of that prompt's turn, and its context reading is kept.
One that moved tokens carries an `increment` and always belongs to a turn.
Codex sends nothing through a status line, and an imported row has
`source: "import"`, so neither is ever render-only.

A turn a prompt hook delimited keeps every context reading of its rows in
`context_percent_samples`; a turn with a `turn_id` contributes its last, as it
always did.

## Billing units

Not every provider bills in currency. Copilot CLI reports AI units and premium
requests and no dollars at all. Those arrive in `billing_cumulative` as
provider-reported running totals and are diffed into `billing` per call, exactly
as cumulative cost and cumulative tokens are. A turn's `billing` is the sum of
its calls' deltas, so AIU per turn is AIU per prompt. A gauge-shaped row that
the store holds for a whole reply carries the units every render of that reply
moved, not only the last one's.

They are deliberately not part of `cost`: a unit that is not money must never be
added to money, rendered with a currency symbol, or compared against a configured
price estimate. The status line prints them with the unit named.

`analyze --group-by` sums `billing` per group the same way it sums
`provider_cost_usd`, and reports each group's `billing_share` per unit. When a
period has no USD at all but does have billing data, `rankGroups` sorts by AIU
instead of falling back to turn count - `ranking.ranked_by` says which happened.
Billing is never mixed into `total_provider_usd`, and a group's `billing` is an
empty object, not a zero, when that group has no billing-bearing turns.

## Cumulative counters

Some providers report session-running token totals instead of a per-call gauge -
Copilot CLI does. Those totals arrive in `usage_cumulative`, which holds the same
token keys and deliberately carries no `basis` or `semantics`, because a running
total is neither an increment nor a sample.

The store diffs consecutive snapshots into `usage` with `basis: "increment"`, so
the movement between two renders is the call that happened between them. As with
cumulative cost, the first snapshot of a session is a baseline and yields no
usage, and a counter that moves backwards is treated as a provider restart rather
than a call. `usage_cumulative` stays on the event so `repair` can rebuild the
deltas from the ledger alone.

`context.percent` is unaffected by any of this - it is a point-in-time reading of
context-window fullness, not a token count, so it is captured on every turn that
reports one regardless of `usage.basis`. `aggregate.context_percent_samples`
reports its distribution; `aggregate.context_samples` (the older, token-count
field) stays gated on `basis: "sample"` on purpose, since an increment turn's
`input_total` is already summed into `aggregate.tokens` and must not also appear
in a gauge distribution. For an increment-dominated agent, `context_samples`
being thin or empty is expected; `context_percent_samples` is where its real
context-growth signal lives.

## Usage semantics

- `components`: `input_total = input_fresh + cache_read + cache_write`.
  Five-minute and one-hour writes are also available separately when exposed.
- `cached_subset`: `cache_read` is a subset of `input_total`, and
  `input_fresh = input_total - cache_read`. Where the provider also reports cache
  writes inside that total, as Copilot CLI does, the adapter passes
  `input_fresh` explicitly as the remainder after reads *and* writes.
- `unknown`: the adapter could not establish the provider’s relationship between
  fields. Pricing should not infer missing components.

## Cost semantics

- `provider_reported`: supplied by the agent/provider interface.
- `configured_estimate`: calculated from a local, versioned pricing file.
- `cumulative_usd`: session total at the observation.
- `delta_usd`: difference from the prior cumulative snapshot. The first
  snapshot establishes a baseline and has no delta.
- `amount_usd`: an already per-event amount.
- `price_version`: the pricing file's version string (or a content hash when the
  file sets none), stamped on the event only when `basis` is
  `configured_estimate` (`src/pricing.mjs`, `estimateEventCost`; applied in
  `src/store.mjs`, `applyPricing`).

Aggregates use `delta_usd` or `amount_usd`; they never count cumulative totals.

## Deliberately excluded

The schema validator rejects keys for prompts, messages, content, bodies,
transcripts, current directories, project directories, file paths, commands
and their arguments, environments, tool inputs, and tool outputs. Structural
byte counts may be stored, but not the corresponding text.

## Subagent cost windows

Subagent lifecycle events carry no tokens or cost. State therefore tracks the
provider's cumulative-cost movement while at least one subagent was active, and
the status snapshot exposes it as `subagent_cost_usd` and `subagent_cost_share`.
Parallel and nested subagents share a single window, and the parent's own work
during that window is included, so the figure is co-occurring cost and an upper
bound rather than per-subagent attribution.
