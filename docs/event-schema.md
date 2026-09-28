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
(`src/normalize/claude.mjs`, `claudeCache`).

## Billing units

Not every provider bills in currency. Copilot CLI reports AI units and premium
requests and no dollars at all. Those arrive in `billing_cumulative` as
provider-reported running totals and are diffed into `billing` per call, exactly
as cumulative cost and cumulative tokens are.

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
