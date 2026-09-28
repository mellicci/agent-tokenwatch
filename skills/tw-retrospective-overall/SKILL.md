---
name: tw-retrospective-overall
description: Review a period of recorded Tokenwatch telemetry and report what actually happened - which sessions, models, and turns drove spend, how the period compares with the one before it, and which cost drivers dominated. Use for a weekly or monthly look back at coding-agent cost, or when asked where the money went.
---

# Token cost retrospective

This skill looks **backwards** and describes what happened. It ranks cost drivers
by measured share of spend, compares the period against the one before it, and
characterises how usage changed.

It is deliberately distinct from `tw-cost-audit-define-experiment`, which looks **forwards** and
designs controlled experiments. If the user wants "what should I change and how
do I test it", use that skill instead. If they want "where did the money go last
week", use this one. Do not duplicate the other skill's experiment tables here.

When you point the user to another Tokenwatch skill, write it the way their
agent invokes it: `/tw-<name>` in Claude Code and Copilot CLI, `$tw-<name>` in
Codex, where `/skills` also lists them.

## Which agent you are reporting on

**Establish this before reading any numbers.** One installation serves Claude
Code, Codex CLI and Copilot CLI at once, and their data sits in one ledger. A
report produced inside Copilot that ranks Claude's sessions is describing
somebody else's work with total confidence.

```sh
tokenwatch agents
```

That prints the detected host agent and every agent with recorded activity.
Scope every command to the host with `--agent <host>`, and name the agent the
report covers in its first line. If the host cannot be detected, ask which agent
they mean or report each separately - never default to one.

Never total across agents. Claude reports USD; Copilot reports AI units and
premium requests; Codex reports neither. A combined total mixes units and the
shares it implies are meaningless.

**Inside a sandbox.** A `note:` line saying the data directory is read-only
here and nothing was flushed - or a `degraded` field in `--json` output - means
the agent's sandbox can read Tokenwatch's data but not write it, as Codex's
does by default. The report is still complete: the turn in progress was read
from pending state in memory rather than from the ledger. Mention it in one
line and carry on. Do not ask to run outside the sandbox just to clear the
note; ask only when the in-flight turn matters and has to be recorded, not
just shown. A user who wants the note gone for good can add Tokenwatch's data
directory to Codex's `sandbox_workspace_write.writable_roots` (INSTALL.md,
Codex CLI specifics).

### Is data actually arriving?

```sh
tokenwatch doctor
```

Read the `collection:<host>` line, and for Claude Code the `claude-status-line`
line. `WARN` there means the ledger is missing data the agent should have sent -
hooks arriving while the status line never delivered usage, Codex turns with no
token counts, or nothing at all since install. Do not refuse, and do not
summarise as though the data were complete: say so in the report's first lines,
quote the cause doctor names, and present every figure as covering only what
arrived. Missing turns make a total incomplete, not low, and nothing absent may
be read as zero.

## Never do the arithmetic yourself

Every share, rank, and delta in this report comes from `tokenwatch analyze
--group-by`. Do **not** read the CSV and total columns by eye: a model asked to
add a thousand rows in its head produces a plausible number, and a plausible
number is worse than no number. If a figure you want is not in the JSON, say it
is unavailable rather than deriving it informally.

The CSV export exists for the user to inspect or graph, not for you to reduce.

## Evidence rules

1. Work from `analyze` output. Do not read `events.jsonl` directly, and never
   read prompts, transcripts, tool output, or source files.
2. Keep provider-reported charges and locally configured estimates in separate
   columns. `ranking.total_provider_usd` and `ranking.total_estimate_usd` are
   separate for this reason. Never add them.
3. Label every statement **measured** or **inferred**. Attribution of spend to a
   model or session is measured. Attribution of spend to a *cause* is inferred.
4. Report shares of a total rather than raw sums wherever the underlying counter
   is a gauge (see below). Percentages of spend are safe; summed context sizes
   are not.
5. Do not invent prices, and do not claim a saving that was not measured against
   a baseline.

## The one distinction that governs every number

Tokenwatch tags each usage record with a `basis`:

- `increment` — one distinct model call. Safe to add to other increments.
- `sample` — a gauge re-reported on every status refresh, describing the most
  recent call. Adding repeated samples multiplies one turn by the refresh rate.
- `transcript` — one model call read from the agent's own session files by an
  explicit history import the user ran. Additive like `increment`, tokens only, and
  never priced. `aggregate.imported_turns` counts these turns (it is part of
  `increment_turns`), and `aggregate.imported_unverified_turns` counts those
  whose import could not be checked against live capture. A `--group-by` row
  carries its own `imported_turns`.

Claude's status-line telemetry is almost entirely `sample`. So for those records:

- **Cost is additive** and trustworthy: it derives from the provider's cumulative
  total, and per-turn deltas are genuine increments.
- **Tokens are not additive.** `aggregate.tokens.*` holds no sample tokens, so
  it will be near zero for a sample-dominated period, and that is correct, not
  a bug - unless history was imported: then it holds the imported turns'
  tokens. Read `aggregate.imported_turns` before quoting it. Use
  `aggregate.context_samples.*` (median, p95, max, in tokens) to describe
  context size.

A provider whose token deltas are genuinely additive - Copilot's cumulative
counters, diffed into per-call increments - correctly does *not* populate
`context_samples`: mixing an increment turn's `input_total` into that gauge
distribution would double-count it against `aggregate.tokens`, which already
sums increments separately. Context-window **percent**, unlike a token count,
carries no such risk, so `aggregate.context_percent_samples.*` (median, p95,
max, in percent) reports it from every turn that has one, regardless of basis.
For an agent whose data is mostly increments, this is the field with the real
context-growth signal; `context_samples` will be thin or empty there by
design, not because the agent lacks the data.

A turn is one prompt and its whole answer, however many model calls (tool
round-trips) that answer took, so `turns`, `turn_share`, `cost_per_turn_usd`
and AIU per turn are per prompt. Claude names each prompt; Copilot names none,
so its turns are delimited by its prompt hook: every call after a
`userPromptSubmitted` belongs to that prompt's turn. Where neither delimits a
turn - hooks not installed, or a window that starts mid-reply - each call is
counted as a turn of its own, and `aggregate.undelimited_turns` (and each
`--group-by` row's `undelimited_turns`) says how many. Above zero, say that
those turns are per call, not per prompt, and do not compare their per-turn
figures with per-prompt ones.

`aggregate.turns` counts turns with a model call behind them. A status-line
render with none - a slash command such as `/status` or `/cost`, the render
after `/compact`, the render before the first prompt, or a Copilot render whose
counters did not move - is counted in `aggregate.render_only_readings` instead,
and in no turn count, cost per turn, ranking or comparison. Its context reading
stays in both context series, so `context_samples.turns` and
`context_percent_samples.turns` count readings, not turns, and can be larger
than `aggregate.turns`.

If a retrospective quotes a period token total for a sample-dominated agent as
live usage, it is wrong. Quote cost totals and context distributions instead.
When `aggregate.imported_turns` is above zero, the token total is imported
history: say so, say how many of those turns are unverified, and never compare
it with live cost - imported turns carry no cost, so a `$0.00` group or a low
cost per turn there means "imported", not "cheap".

## Procedure

```sh
tokenwatch analyze --since 7d --group-by model   --compare --format json
tokenwatch analyze --since 7d --group-by session --format json
tokenwatch analyze --since 7d --group-by day     --format json
```

`--group-by` adds three computed sections to the report:

- `ranking` — groups sorted by provider spend, each with `provider_share`,
  `turn_share`, `turns`, and `cost_per_turn_usd`. `shown_provider_share` says how
  much of the period the listed rows actually cover; `groups_total` says how many
  were cut off by `--limit`. `ranked_by` says what actually produced the sort
  order: `"provider_cost_usd"` normally, or `"billing:aiu"` when the period has
  no USD at all but does have billing-unit data (Copilot). In the latter case
  each group also carries `billing` (summed per unit) and `billing_share`
  (that group's share of the period's `total_billing`, per unit) - genuinely
  ranked, the same as a cost-reporting agent, just in AIU instead of dollars.
  A group with no billing data at all reports an empty `billing`/`billing_share`
  rather than a fabricated zero. Never describe a `ranked_by: "billing:aiu"`
  ranking as spend or convert AIU to a dollar figure - name the unit.
- `concentration` — `median_usd`, `p95_usd`, `max_usd`, and `top_decile_share`:
  the fraction of spend sitting in the most expensive tenth of turns.
- `compactions` — how many happened, in how many sessions, and the median
  context percentage at which they fired.

`--compare` adds a `comparison` section against the immediately preceding window
of equal length, with `current`, `prior`, `absolute`, and `relative` for turns,
sessions, cost, cost per turn, and compactions, plus per-model movement sorted by
absolute change. It requires `--since`.

Scope to the host agent established above with `--agent <host>`; a period total
that mixes agents mixes their units. Narrow further with `--project-id <id>`, or `--group-by
project`. Widen the window if `aggregate.turns` is small; say so rather than
over-reading a thin sample. Add `--limit N` to lengthen a ranking.

Sessions are clean units: each Claude Code session writes its own derived state,
while the event ledger is shared and append-only. That is what makes ranking
across every session on the machine possible, and what makes one session's
figures trustworthy in isolation.

## What to report

### 1. Period shape and coverage

From `aggregate`: turns, sessions, date range, provider-reported cost, and how
many turns carry a cost basis at all. State coverage before any conclusion —
a period where most turns lack cost data cannot support a spend breakdown.

### 2. Versus the period before

Lead with `comparison`. A retrospective's actual question is "versus what", and
total spend alone cannot answer it: more spend across proportionally more turns
is a busier week, while the same turns costing more is a change in how they run.
Report both `provider_cost_usd` and `cost_per_turn_usd`, then the per-model
movement that explains the difference.

If the prior window is empty, say so — the comparison is meaningless, not zero.

### 3. Ranked cost drivers

Rank by **share of measured spend**, largest first, straight from `ranking`. When
`ranked_by` is `"billing:aiu"` instead, the same logic applies to AIU share -
report it exactly as plainly, just in its own unit rather than dollars:

- **by model** — a model taking a small share of turns and a large share of spend
  (or AIU) is the single most actionable finding in most retrospectives. Compare
  `turn_share` against `provider_share` (or `billing_share.aiu`) directly.
- **by session** — long sessions concentrate cost. Report the top few and their
  turn counts.
- **by turn** — from `concentration`: p95, max, and what share of spend the top
  decile carries. A high `top_decile_share` means a few turns, not a general
  habit, and points the investigation somewhere quite different.

Give each driver a measured share (`X% of $Y`), not an adjective.

### 4. How usage moved over the period

- Context growth: compare `context_samples.input_median` (token count) early
  versus late for a sample-dominated agent; for an increment-dominated agent
  such as Copilot, use `context_percent_samples.percent_median` instead - see
  above for why the two fields exist.
- Cache behaviour: `aggregate.cache.read_share`, `write_share`, and `fresh_share`
  average per-turn ratios and sum to roughly one. A rising `fresh_share` means
  more of the context is being re-sent as new input.
- Compaction rhythm: from `compactions`. Each one is a deliberate cold start —
  the prefix is replaced, so the turn after it repays the cache. Many compactions
  at a high median context percentage suggests they are firing late and under
  pressure; a rising count against the prior period is a real change in working
  style, whoever caused it.
- Model mix over time: whether routing shifted, and whether cost followed.

### 5. What the data cannot tell you

Name the gaps explicitly rather than letting the reader assume coverage:

- Subagent spend is folded into the parent session's cumulative cost. Subagent
  lifecycle events carry no model, tokens, or cost, so per-subagent attribution
  is unavailable. A session with many subagents shows their cost, but not which
  of them was expensive.
- Task difficulty is not recorded, so an expensive turn is not evidence of waste.
- Structural byte counts show volume, not usefulness.

## Output structure

1. **Coverage** — period, turns, sessions, and what fraction has a cost basis.
2. **Headline** — total provider-reported spend and its movement against the
   prior window, and separately any configured estimate.
3. **Top cost drivers** — ranked, each with its measured share and a one-line
   inferred reading marked as inference.
4. **Movement** — two or three measured trends, including compaction rhythm.
5. **Blind spots** — what this data cannot answer.
6. **Where to go next** — if the user wants changes and a test plan, point them
   at `tw-cost-audit-define-experiment`. If they only want to know what just
   happened in the session they are sitting in right now, rather than a period,
   point them at `tw-retrospective-this-session` instead — this skill answers
   "what happened over the last week/month", not "what happened just now". Mention
   any open experiments from `tokenwatch experiment list` whose measurement window
   falls inside this period, since this report is the evidence they were waiting
   for.

Keep it short enough to read in one sitting. A retrospective that buries three
real findings in twenty paragraphs has failed.
