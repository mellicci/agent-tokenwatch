---
name: tw-retrospective-this-session
description: Report what the coding-agent session in progress right now has cost so far, its cache health, and whether it is running expensive compared to the user's own recent average. Use when someone asks "how much has this session cost", "why is this session already expensive", or wants a quick read on the conversation they are sitting in, not a weekly or monthly period.
---

# This session's retrospective

This is the **fast, narrow** sibling of `tw-retrospective-overall`. That skill
answers "where did the money go this week"; this one answers "what has *this*
conversation cost, right now". Reach for it when the user's question is about the
session they are typed into at this moment, not a period.

Do not run a multi-day audit here. If the question turns out to be about a
pattern across sessions ("this always happens", "every long session ends up like
this"), say so and hand off to `tw-retrospective-overall` or
`tw-cost-audit-define-experiment` rather than trying to answer it from one
session's numbers.

When you point the user to another Tokenwatch skill, write it the way their
agent invokes it: `/tw-<name>` in Claude Code and Copilot CLI, `$tw-<name>` in
Codex, where `/skills` also lists them.

## Which agent you are reporting on

**Establish this before reading any numbers.** One installation serves Claude
Code, Codex CLI and Copilot CLI at once, and their data sits in one ledger. A
report produced inside Copilot that reads Claude's session is describing
somebody else's work with total confidence.

```sh
tokenwatch agents
```

Scope every command to `--agent <host>`. If the host cannot be detected, ask
which agent they mean rather than guessing — `tokenwatch status` for the wrong
agent will not error, it will just quietly describe a different conversation.

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

## The live snapshot, and whose session it describes

```sh
tokenwatch status --agent <host> --json
```

Read `session_scope` before anything else in that snapshot. It says which
session the figures belong to and how Tokenwatch knew:

- `basis` is `environment:<VAR>` (the agent's own session id, read from its
  environment) or `option` (you passed `--session <id>`): the snapshot is this
  session's. `stdin` means a status-line payload was piped, which a hand run
  does not do.
- `basis` is `most_recent_fallback`: no session id was available, so the
  snapshot is whichever session last wrote to this machine. With another session
  open, that may not be this one. Say so in the report's first lines and name
  `session_scope.session_id`. If you know this session's id another way, re-run
  with it:

  ```sh
  tokenwatch status --agent <host> --json --session <id>
  ```
- `basis` is `unknown`: nothing was resolved. Report that there is no live
  snapshot to scope, not an empty session.
- `state_found` is `false`: the session has no recorded data yet. That means
  nothing arrived, not that it cost nothing.

Only then read the figures: `latest`, `session_cost_usd` (or `session_billing`
for an agent that reports no currency), `last_prompt_cost_usd`,
`in_flight_cost_usd`, `average_provider_cost_usd`, `average_window`,
`subagent_count`, and `subagent_cost_share` describe the session named in
`session_scope.session_id`.

Then read `latest.session_id` — the next step needs it.

## Finding this session's shape

`status` gives the current total and the latest call, but not how many turns
this session has taken or how long it has been running. For that, find its row
in a ranking:

```sh
tokenwatch analyze --since 1d --agent <host> --group-by session --limit 50 --format json
```

Look for the group whose `key` equals the `session_id` from the step above. If it
is not there, the session has been running longer than the window — widen to
`3d`, then `7d`, then `30d`, the same escalation `tw-retrospective-overall` uses,
until the group appears. A long session is not rare: one on record ran 34 hours.

That group's row gives `turns`, `first_ts`/`last_ts` (so you can state the span),
`provider_cost_usd`, and `cost_per_turn_usd` — all genuinely scoped to this
session, because the grouping key is the session id itself. A turn is one prompt
and its whole answer; for Copilot, whose payloads carry no turn id, its prompt
hook delimits them. If the row's `undelimited_turns` is above zero, that many
turns had no prompt hook to delimit them and are single model calls: say so, and
do not read a per-turn figure from them as a per-prompt one. Its `imported_turns`
is 0: a session live capture recorded is never imported. Other rows in the same
ranking may be imported history, with tokens and no cost.

## What the wider analyze blocks do *not* tell you about this session alone

`compactions`, `concentration`, and the top-level `aggregate.cache.*` in that same
`analyze` response describe **every session inside the window**, not just this
one. They are safe to quote as this session's own figures only when
`ranking.groups_total` is `1` — meaning this session is the only thing in the
window. If it is more than `1`, do not attribute those blocks to this session;
report only what the matched group row itself carries, and say plainly that
cache/compaction detail for a single session among several is not available from
`analyze` today. Do not approximate it.

## What to report

1. **Which agent, which session** — name both in the first line.
2. **Cost or billing so far** — `session_cost_usd` (or `session_billing`), and
   `last_prompt_cost_usd`/`in_flight_cost_usd` for the two most recent replies.
   Never invent a dollar figure for an agent that reports none.
3. **Is this session normal for you** — compare `cost_per_turn_usd` (from the
   matched group) against `average_provider_cost_usd` over `average_window`
   turns from the live snapshot. That average is the user's own recent baseline,
   not a period figure, which is what makes "is this session expensive" answerable
   without a full audit.
4. **Cache health right now** — `latest.cache` (TTL, age, hit rate) if the
   provider reports one; otherwise the latest call's read/write/fresh split from
   `latest.usage`.
5. **Subagents this session** — `subagent_count` and, when available,
   `subagent_cost_share` — the share of this session's cost that accrued while at
   least one was running. State plainly that this is an upper bound, not
   per-subagent attribution.
6. **If it looks expensive** — name the one lever that would matter most for a
   session shaped like this (long-running with a rising fresh share: consider
   `/clear` or compacting sooner; low cache read share on a large input: the
   prefix likely changed), and offer to turn it into a tracked experiment with
   `tw-cost-audit-define-experiment` rather than asserting a fix worked without a
   test.

Keep the whole report to a few lines. This is a gut-check, not an audit — if it
grows past what fits in one screen, the user probably wanted
`tw-retrospective-overall` instead.
