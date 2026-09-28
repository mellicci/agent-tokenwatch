---
name: tw-cost-audit-define-experiment
description: Design and track evidence-based experiments that reduce coding-agent token cost - evaluating experiments already running before proposing new ones - without exposing prompts, code, transcripts, or tool contents.
---

# Token cost audit

Use this skill when the user asks what to change about their coding-agent cost
and how to test it. Tokenwatch is a local metadata collector; treat its output as
operational telemetry, not as proof of causation.

This skill looks **forwards**. `tw-retrospective-overall` looks backwards over a
period and `tw-retrospective-this-session` looks backwards over the session in
progress; either describes what already happened. If the user asks "where did
the money go", use one of those instead. If someone asks a basic question
first - what a token is, why cache reads are cheap, what a cache write costs -
send them to `tw-cost-drivers-basics` before running an audit on numbers they
do not yet have the concepts to read.

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

## Start with the experiments already running

```sh
tokenwatch experiment list
```

Before proposing anything new, evaluate what is already open. An audit that
proposes a controlled change and then forgets it is giving advice, not gathering
evidence — and next week nobody remembers what was tried.

For each open experiment, check whether its measurement window has elapsed and
enough turns have accumulated. If it has:

1. Measure the stated metric over the window, using the same command that
   produced the baseline.
2. Compare against the recorded `baseline`. Check the `guardrail` too — a change
   that cut cost and broke the user's flow failed.
3. Close it with what actually happened:

   ```sh
   tokenwatch experiment close <id> --result adopted|rejected|inconclusive \
     --outcome "cost per turn fell 40%, turns-to-completion unchanged"
   ```

`inconclusive` is a real and common result. Record it rather than forcing a
verdict from a thin sample, and say what sample size would settle it.

If an experiment is still accumulating data, say so and leave it open. Do not
propose a new experiment that changes the same variable while one is running —
two overlapping changes make both unmeasurable.

## Safety and evidence rules

1. Start with aggregate commands. Do **not** read `events.jsonl`, prompts,
   transcripts, source files, tool inputs, or tool outputs unless the user
   explicitly asks and the task genuinely requires it.
2. Keep provider-reported charges separate from locally configured estimates.
   Never add the two totals together.
3. Do not invent model prices. When estimates are unavailable, analyze tokens
   and tell the user that dollar comparisons are unavailable.
4. Label every conclusion as **measured**, **inferred**, or **recommended**.
   A cache miss, long gap, or growing context is evidence; its cause is an
   inference until tested.
5. Never promise savings without a counterfactual. State a test, baseline,
   success metric, and rollback instead — and record it in the journal.
6. Treat the configured cache TTL as an assumption unless the event explicitly
   says it is provider-reported.
7. Shares and ranks come from `--group-by`, computed in code. Do not total CSV
   columns by eye.

## Establishing the period

If a retrospective was just run in this conversation, **take its ranked drivers
as input and do not re-derive the period shape.** Go straight to the diagnostic
map. Otherwise:

```sh
tokenwatch doctor --json
tokenwatch status --agent <host> --json
tokenwatch analyze --since 7d --agent <host> --group-by model --compare --format json
tokenwatch analyze --since 7d --agent <host> --group-by session --format json
```

`<host>` is the agent established above. The `status` snapshot is period
context, not the audit's subject; if you quote it as the current session's, check
`session_scope.basis` first - `most_recent_fallback` means it may be another open
session's. Dropping `--agent` from `analyze` reports every agent at once, which
is right only when you have said so explicitly and are reporting per agent;
`status` with no `--agent` reports Claude's, so never drop it there. When seven
days has too little data, expand to 30.

Summarize only the fields needed for the decision: coverage and cost-basis
coverage; the `ranking` rows and their `provider_share` against `turn_share` -
or, when `ranking.ranked_by` is `"billing:aiu"` (no USD in the period at all,
as for Copilot), `billing_share.aiu` against `turn_share` instead, reported in
AIU, never converted to a dollar figure; `concentration.top_decile_share`;
`compactions`; cache read/write/fresh shares; gaps longer than the cache TTL;
tool-output lengths and subagent counts.

## Choose what to investigate by measured share

The map below is a set of hypotheses, not a checklist. **Pick the row that
explains the largest measured share of spend**, not the row that is easiest to
match. A signal attached to 3% of the bill is not worth an experiment however
clearly it appears, and an audit that proposes five changes has prioritised none
of them.

| Signal | Plausible interpretation | Experiment |
|---|---|---|
| A model holds a small `turn_share` and a large `provider_share` (or `billing_share.aiu`, when ranked by billing) | Routing may be ad hoc | Label a sample by difficulty; use the strongest model only for blockers |
| `concentration.top_decile_share` is high | A few turns, not a general habit, carry the period | Characterise those turns before changing anything general |
| Low cached share on large inputs | Prefix changes, cold sessions, caching unavailable, or changing tools/settings | Keep stable material first; avoid toggling tools/MCPs for a matched task sample |
| Fresh input rises through a long session | Stale context is being re-sent | Compare `/clear` between unrelated tasks or a mid-task compact against matched sessions |
| Compaction commonly occurs above ~80% | Summaries may be late and lossy | Add a 50–60% reminder and compare continuity plus token totals |
| Compaction count rising against the prior period | Sessions may be running longer than the task needs | Compare cost per turn either side of a compaction across matched sessions |
| Large fresh-input jump after TTL-sized gap | A cold resume may be repaying the old prefix | Save a concise state summary; compare old-session resume with summary-based restart |
| Very large tool-output p95 and no subagents | Logs/search output may enter the main context | Filter at the shell or delegate verbose inspection to a subagent |
| High reasoning output on simple tasks | Effort may be too high | Lower effort for a matched set of mechanical changes and compare correctness |
| Always-loaded project instructions are large | Static context tax on every turn | Keep the always-loaded file short; move specialized guidance into on-demand skills |
| Broad prompts correlate with large scans | Scope discovery is expensive | Name concrete files, tests, and acceptance criteria; plan first and stop early if wrong |

## Recording an experiment

Propose **one** change at a time, and record it before the user starts:

```sh
tokenwatch experiment add \
  --hypothesis "Opus on routine turns drives the 80% spend share" \
  --change     "Default to Sonnet; escalate to Opus only on blockers" \
  --baseline   "7d: Opus 23% of turns, 80% of \$102.15 provider spend" \
  --metric     "cost per turn by model, tokenwatch analyze --since 7d --group-by model" \
  --guardrail  "no increase in turns-to-completion or rework" \
  --rollback   "set the default model back to Opus" \
  --sample     "at least 40 turns or 7 days, whichever is later"
```

The baseline must be a figure you actually measured, quoted with its command, so
the same measurement can be repeated at close. `add` refuses a proposal with no
baseline or no metric, because a change recorded with nothing to measure against
can only ever produce an impression.

The journal lives in the Tokenwatch home as append-only JSONL, shared across
projects and sessions. Records are never rewritten, so a closed experiment stays
readable exactly as it was proposed.

## Required response structure

1. **Open experiments** — what was running, what the data now says, and which you
   closed with what result. If none were open, say so in one line.
2. **Coverage and data quality** — what was measured, missing cost bases, and
   whether the sample is representative.
3. **Measured findings** — numbers and time period, ranked by share of spend.
4. **Likely causes** — explicitly identify inference and uncertainty.
5. **The next experiment** — one change, with baseline, success metric, sample
   size, guardrail, and rollback, recorded with `tokenwatch experiment add`. Offer
   a second only if it touches an independent variable.
6. **Configuration changes** — exact commands or file edits only after the
   evidence supports them.

Prefer reversible changes. Preserve correctness, latency, privacy, and developer
flow; token reduction alone is not a successful outcome.
