---
name: tw-token-cost-coach
description: Interactively walk someone through a real situation that made their coding agent expensive - a long session, a break that went cold, a huge tool output, model choice, subagents, compaction timing, or several sessions at once - using their own recorded telemetry to teach the underlying cost driver. Use when someone asks why a session cost so much, how prompt caching works in practice, or wants to learn what actually drives token cost.
---

# Token cost coach

Teach one cost driver at a time, grounded in the user's own numbers. This skill
is conversational: present the menu, wait for a choice, then work through that
scenario. Do not dump the scenarios all at once, and do not lecture before
looking at their data.

If the person does not yet have the vocabulary this skill assumes — what a
token is, why a cache write costs more than a cache read, what a TTL does — send
them to `tw-cost-drivers-basics` first. Teaching the concept through a live
example works far better once the terms themselves are not also new.

When you point the user to another Tokenwatch skill, write it the way their
agent invokes it: `/tw-<name>` in Claude Code and Copilot CLI, `$tw-<name>` in
Codex, where `/skills` also lists them.

## Which agent you are reporting on

**Establish this before reading any numbers.** One installation serves Claude
Code, Codex CLI and Copilot CLI at once, and their data sits in one ledger. A
skill invoked inside Copilot that reports Claude's sessions is describing
somebody else's work with total confidence.

```sh
tokenwatch agents
```

That prints the detected host agent and every agent with recorded activity. Then:

- **Host detected** — scope every command to it with `--agent <host>` and say
  which agent the report covers in the first line.
- **Host unknown** — do not pick one. Either ask the user which agent they mean,
  or report each agent separately with its own heading. `tokenwatch agents` shows
  which ones have recent activity, which usually makes the question easy to ask.

Never total across agents. Claude reports USD; Copilot reports AI units and
premium requests; Codex reports neither. A combined figure mixes units, and the
share it implies is meaningless. Report each agent in its own unit, or say the
comparison cannot be made.

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

## How to run a session

1. Check there is data to teach from:

   ```sh
   tokenwatch agents
   tokenwatch status --agent <host> --json
   tokenwatch analyze --since 14d --agent <host> --group-by model --format json
   ```

2. Ask which situation matches theirs, in their words. Offer the menu below.
3. Work the chosen scenario: pull the relevant figure, explain what it means,
   then state the lever **and the status-line field they will watch to see
   whether it worked**. Every scenario below names that field.
4. Stop and check understanding before moving to another scenario.

Two or three scenarios is a good session. Seven is a lecture.

## When there is no data yet

A new install has nothing recorded, and the honest move is to say so — but not to
stop. The status line always has something in it, even on the first turn:

```sh
tokenwatch status --agent <host> --json
```

Check `session_scope.basis` in it first: if it is `most_recent_fallback`, the
snapshot may be another open session's, so say that before teaching from it.
Teach from that single snapshot instead: what `ctx` is, why `sent` is so much
larger than `output`, what `from cache` versus `added to cache` means on *this*
turn, and how long `cache warm` has left. That is enough for scenarios 2, 3 and 6
in concept. Say plainly that the period comparisons need a week or so of use, and
offer to come back to them.

Never illustrate a point with invented numbers, and never present a worked
example as though it were the user's own.

## Ground rules

- Use their real figures. If a figure is unavailable, say it is unavailable.
- Separate **measured**, **inferred**, and **suggested**. A number is measured; a
  cause is inferred; a change is suggested.
- Never promise a saving. Offer a change and a way to check whether it helped.
- Token reduction is not the goal. Correctness, latency, and the user's flow
  matter more, and a cheaper session that loses the thread is a bad trade.
- Do not read prompts, transcripts, tool output, or source files.
- Shares and rankings come from `--group-by`, computed in code. Do not total
  columns by eye while teaching.

## The menu

> Which of these sounds like what happened?
>
> 1. A long session slowly got expensive.
> 2. I stepped away, came back, and the next turn cost a lot.
> 3. I ran something with huge output and the cost jumped.
> 4. I am not sure I am using the right model.
> 5. I spawned a bunch of subagents and cannot tell what they cost.
> 6. My context keeps filling up and compacting.
> 7. I run several Claude sessions at once and cannot tell them apart.

---

### Scenario 1 — the long session that crept up

**Look at:** `aggregate.context_samples` (median, p95, max, in tokens) - or
`aggregate.context_percent_samples` (same shape, in percent) for an agent like
Copilot whose token deltas are additive rather than sampled - and `ctx` on the
status line.

**Teach:** every turn re-sends the conversation as input. The context window is
not a cost by itself, but it sets the size of every subsequent request. As the
session grows, each turn carries more, so a late turn costs more than an early
one for the same amount of work. Compare their early-session and late-session
context sizes to make it concrete.

**Lever:** clear between *unrelated* tasks; compact while the task state is still
coherent rather than at the limit. Clearing mid-task is usually a false economy —
re-establishing the context costs more than it saves.

**Watch:** `▥ ctx` climbing across a session, against `❯ previous reply` for the
same kind of work.

**Check:** compare median context and cost per turn across a few sessions before
and after changing the habit.

---

### Scenario 2 — the break that went cold

**Look at:** `cache warm` on the status line, `cache_ttl_source`, and
`aggregate.cache.fresh_share`.

**Teach:** the prompt cache holds the conversation prefix for a limited window. A
cache **read** is cheap; re-sending that prefix as **fresh** input is not. If they
return after the TTL, the next turn repays the whole prefix at full price. Show
their actual TTL — it is provider-reported when present, and if the field is
missing, Tokenwatch will not guess it.

**Lever:** before a long break, save a short state summary. On return, compare
resuming the old session against starting fresh from that summary. For short
breaks, returning before expiry keeps the prefix warm.

**Watch:** `◴ cache warm` before stepping away, and `% from cache` on the first
turn back.

**Check:** watch `fresh_share` on the first turn after a break. A large fresh
share right after a gap is the signature of a cold resume.

---

### Scenario 3 — the enormous tool output

**Look at:** `metrics.tool_output_bytes` percentiles in the audit, and whether
subagents were used.

**Teach:** anything the agent reads enters the context and is re-sent on every
following turn in that session. A single large test log or unfiltered search is
not a one-off charge — it becomes a recurring tax for the rest of the session.
This is the cost driver people underestimate most.

**Lever:** filter before the agent reads (narrow the grep, tail the log, target
the test). Or delegate the verbose reading to a subagent that returns only a
conclusion, keeping the bulk out of the main context.

**Watch:** `↑ sent` jumping a step and staying there, rather than returning to
its previous level on the next turn.

**Check:** compare context growth across turns that follow a big read against
turns that follow a filtered one.

---

### Scenario 4 — model choice

**Look at:** `ranking` from `--group-by model` — `turn_share` against
`provider_share` for each model.

**Teach:** show the split. A model holding a small share of turns and a large
share of spend is worth a conversation. But telemetry does not record task
difficulty, so this is a prompt to think, not evidence of waste. A capable model
that solves a blocker in one turn can be cheaper than a weaker one that flails
for six.

**Lever:** pick a default suited to routine work and escalate deliberately for
hard problems, rather than escalating by habit.

**Watch:** `⌬ model` — simply noticing which model is answering routine work.

**Check:** label a small sample of turns by difficulty, then compare cost and
outcome by model on comparable work. Do not apply a blanket downgrade.

---

### Scenario 5 — subagents

**Look at:** `subagent_count` and `subagent_cost_share` on the status line.

**Teach:** be precise about what each half means. The **count is exact** — it is a
maintained counter of subagents that finished in this session. The **share is an
upper bound**: it is cost accrued while at least one subagent was running, and
parallel subagents share one window, with the parent's own work in that window
counted too. Subagent lifecycle events carry no model, tokens, or cost, so
per-subagent spend **cannot be attributed**. Tokenwatch can tell them how many
ran, not which was expensive. Saying so is the honest answer.

Then teach the real trade-off: a subagent is worth it when it keeps a large body
of material out of the main context and returns something small. It is wasteful
when its work overlaps another agent's, or when it returns nearly everything it
read, since the isolation bought nothing.

**Lever:** give each subagent a narrow scope and an explicit contract for what it
returns.

**Watch:** `⑃ Subagents` — the count against the share. Many subagents with a
small share is the pattern working.

**Check:** compare main-session context growth on tasks delegated to a subagent
against comparable tasks done inline.

---

### Scenario 6 — compaction timing

**Look at:** `compactions` from `--group-by` (count, sessions, median context
percentage at which they fired), and `ctx` before and after one.

**Teach:** a compaction replaces the conversation with a summary. `ctx` drops
sharply, which reads like a saving and is not: the cached prefix is gone, so the
first turn afterwards rebuilds the cache from new material. It is a deliberate
cold start. Worth paying between phases of work; wasteful if it fires repeatedly
mid-task, and lossy if it fires late under pressure at 90%+ context.

**Lever:** compact at a natural boundary while the task state is still coherent,
rather than waiting for the limit to force it. `/clear` between genuinely
unrelated tasks is cheaper than compacting a context that had nothing worth
summarising.

**Watch:** `▥ ctx` dropping, then `% from cache` on the very next turn — the
rebuild is visible there.

**Check:** compare cost per turn in the three turns after a compaction against
the three before, across a few sessions.

---

### Scenario 7 — several sessions at once

**Look at:** `--group-by session` ranking, and the per-session state files under
the Tokenwatch home.

**Teach:** each Claude Code session keeps its own derived state, so the status
line in one window describes **that window only** — its session cost, its
subagent count, its cache. The event ledger is shared and append-only, which is
what makes the ranking across all sessions possible. So the status line answers
"what is this window costing me" and `--group-by session` answers "which of my
windows cost the most", and those are different questions.

Worth naming: `tokenwatch status` run by hand at a shell has no session on
stdin. It uses `--session <id>` when given, or Claude Code's own session id from
the environment, and otherwise falls back to whichever session wrote most
recently - `session_scope.basis` says which. Piped from Claude Code it always
carries the session id and is exact.

**Lever:** when several sessions run at once, rank them before assuming the busy
one is the expensive one. Long-running sessions concentrate cost quietly.

**Watch:** `Σ session` per window, which never mixes with another window's spend.

**Check:** run `--group-by session` at the end of a day and see whether the
ranking matches which window felt busiest.

---

## Closing a session

Summarise in three lines at most: what they saw in their own data, the one
inference drawn from it, and the single change worth trying next. Offer
`tw-retrospective-overall` if they want the full period breakdown,
`tw-retrospective-this-session` if they just want to know what happened in the
session they are in right now, or `tw-cost-audit-define-experiment` if they want
that change turned into a recorded experiment with a baseline and a success
metric.
