---
name: tw-explain-statusline
description: Explain what each field on the Tokenwatch status line means, what it deliberately does not mean, and how to reconfigure it. Use when someone asks what a number on their coding-agent status line is, why cache looks high, what "cache warm" refers to, why context dropped after a compaction, where prices come from, or how to change the icons, colours, and width.
---

# Status line guide

This explains what is *on the line* — a specific reading for a specific field.
If the question is really about the underlying concept ("what is a cache write",
"why does output cost more than input") rather than "what does this field on my
line mean", answer briefly and point to `tw-cost-drivers-basics`, which covers
that ground from first principles without assuming the reader already has the
vocabulary.

When you point the user to another Tokenwatch skill, write it the way their
agent invokes it: `/tw-<name>` in Claude Code and Copilot CLI, `$tw-<name>` in
Codex, where `/skills` also lists them.

## On invocation

Always print the full bullet list below, verbatim in substance, before anything
else. Do not abbreviate it, skip elements because they look self-evident, or omit
ones missing from the current line — the reader may not know any of these terms.

> **What each part means**
>
> The line reads in three rows: where the session stands, how tokens moved, and
> what the subagents did.
>
> **Row 1 — the session**
>
> - **⌬ model** — which model is answering right now. A suffix like `[1m]` is the
>   context-window size, so the window is never repeated elsewhere on the line.
> - **▥ ctx** — how full the context window is. Not a cost, but it sets the floor
>   for every future exchange. A sudden drop means a compaction or a clear, not a
>   saving: the prefix changed, so the next turn re-sends.
> - **Σ session** — everything this session has cost, cumulative.
> - **◴ cache warm** — time left before the prompt cache expires. After that, the
>   whole conversation is re-sent as fresh input, which is the expensive path.
> - **◐ this reply … so far** — what the reply being written right now has cost so
>   far. It climbs while the answer is produced, then becomes `previous reply`.
>   Between replies it is absent.
> - **❯ previous reply** — what the reply before it cost, finished and final.
>
>   One "reply" is your prompt plus the whole answer to it, however many tool
>   calls that takes. Tool calls are not separate replies. The two figures are
>   routinely far apart in either direction — a reply's cost tracks how much work
>   it did, not just how big the context was.
>
> **Row 2 — ⊞ Tokens** (the latest model call only, not a session total)
>
> - **↑ sent** — everything sent *up to* the model on that call. Each turn
>   re-sends the whole conversation, which is why this is large. The rest of the
>   cell says how that amount was billed:
>   - **from cache** — the server still had this text and replayed it. Cheapest
>     by far, roughly a tenth of normal input price.
>   - **added to cache** — new text stored into the cache on this call so later
>     turns can replay it. Costs *more* than normal input now, to save later.
>
>   Whatever is left over was neither replayed nor stored, and is billed as
>   ordinary input.
> - **↓ output** — what the model wrote back on that call. The priciest meter of
>   all: several times the rate of ordinary input, and far above a cache read.
>
> **Row 3 — ⑃ Subagents**
>
> - how many finished this session, and the share of session cost that accrued
>   while at least one was running. That share is an upper bound, not a bill.

Then read their live values with `tokenwatch status --agent <agent> --json`
(check `session_scope.basis` first: if it is `most_recent_fallback`, the values
may be another open session's, so say that) and interpret them — cheapest signal first: an expiring cache, a falling cached
share, a high subagent share, context climbing. Two or three sentences.

Stop there unless they ask more. Everything below is reference for follow-ups;
do not recite it unprompted.

## Field reference

The default layout spans three labelled rows: the session, token flow, and
subagents. Context and session spend share a cell, since both describe where the
session stands. Cells are padded so columns align across rows. Claude Code renders
each printed line as its own row.

```text
⌬  Opus-5[1m] │ ▥ ctx 6% · Σ session $32.63 · ◴ cache warm 60m      │ ◐ this reply $0.986 so far · ❯ previous reply $3.74
⊞  Tokens     │ ↑ 670k sent · 99.8% from cache · 1.5k added to cache │ ↓ 668 output
⑃  Subagents  │ 25 completed                                        │ 6% of session cost
```

`tokenwatch config set status.layout '"single"'` puts it back on one line.

| Glyph | Field | Meaning | JSON key |
|---|---|---|---|
| `⌬` | model | Active model, provider prefix stripped; `[1m]` is the window size | `latest.model` |
| `▥` | ctx | Share of the context window in use | `latest.context` |
| `Σ` | session | Cumulative session cost, provider-reported | `session_cost_usd` |
| `◴` | cache warm | Time until the prompt cache expires | `cache_ttl_seconds`, `cache_age_seconds` |
| `◐` | this reply | Cost of the reply still being written | `in_flight_cost_usd` |
| `❯` | previous reply | Cost of the last **completed** reply | `last_prompt_cost_usd` |
| `⊞` | Tokens | Row label for the latest call's token flow | — |
| `↑` | sent | Sent to the model, split by cached / written / fresh | `latest.usage` |
| `↓` | output | Written back by the model on that call | `latest.usage.output` |
| `⑃` | Subagents | How many finished this session, and cost share while any ran | `subagent_count`, `subagent_cost_share` |

Fields drop whole when a row is too narrow, so a short row means "not shown",
never "cut off". Width follows the `COLUMNS` value Claude Code sets for the
terminal, falling back to `status.maxWidth`.

## What each number is not

- **`previous reply` is finished, `this reply` is still running.** They are
  separate fields because comparing a partial against completed replies makes the
  figure look implausibly low. A reply that incurred no charge shows zero
  legitimately, and `this reply` is absent between replies.
- **A reply is not an API call.** One prompt and its entire answer form a single
  reply, no matter how many tool round-trips happen inside it.
- **Reply cost is not purely a function of context size.** A long reply with many
  tool calls costs more than a short one at the same context, so successive
  replies vary rather than rising monotonically. `previous reply` exceeding
  `this reply` several times over is ordinary.
- **`ctx` is not a cost.** High `ctx` with a cheap reply is normal. And a low
  `ctx` right after a compaction does not mean the session got cheaper — the
  cached prefix was invalidated, so the next turn pays to rebuild it.
- **The token row is not a session total.** Latest call only, both directions.
- **`⑃ N completed · X% of session cost` is not per-subagent spend.** The share is
  cost accrued *while at least one subagent was running*. Parallel subagents share
  one window, and the parent's own work in that window counts too. It is an upper
  bound on subagent cost, not an attribution. Per-subagent cost is not
  recoverable: subagent lifecycle events carry no model, tokens, or cost.

## Why cached is not 100%

`N% from cache` is `cache_read ÷ input_total` — input **served from** cache. A cache
write is a miss that was stored, so it is counted as **added to cache**, never as
replayed. Anything left over was neither replayed nor stored and is billed as ordinary
input.

`634k sent · 99.9% from cache · 644 added to cache` reads as: 634k
tokens went up to the model, almost all replayed from cache, and 644 of new
material stored for reuse. A percentage only prints as `100%` when the
entire input was cached; a near miss shows `99.9%`.

Note the terminology: **from cache / added to cache / uncached describe how the
sent tokens were billed**, not direction. Direction is `sent` (up) and
`output` (down).

## Working with the cache

The cache holds the conversation prefix for a provider-set window (`◴ cache
warm`). Practical tips:

- **Return before it expires.** Coming back after expiry re-sends the entire
  conversation as fresh input. That is the single most expensive avoidable event
  in a long session.
- **Keep stable material first.** Caching matches on a prefix, so anything that
  changes early — toggled tools, MCP servers, edited instructions, a timestamp —
  invalidates everything after it. Put volatile content late.
- **Avoid changing tools or settings mid-session** when continuity matters.
- **Watch the cached share after a break.** A collapse in `% from cache` right
  after a gap is the signature of a cold resume.
- **A compaction is a deliberate cold start.** `ctx` falls, and the first turn
  after it rebuilds the cache from a new prefix. Worth doing between phases of
  work; not worth doing repeatedly mid-task.
- **Before a long break, save a short state summary**, then compare resuming the
  old session against starting fresh from that summary.

There is no setting that extends the TTL; it is the provider's. `cacheTtlSeconds`
in config is only an assumption used for gap analysis in audits, and is never
rendered on the status line.

## Where prices come from

Tokenwatch **ships no prices and computes no dollar figures for Claude Code**.
The agent reports `cost.total_cost_usd` directly, and every cost shown is that
provider-reported number or a difference between two of them. Check
`current_cost_basis` — `provider_reported` means it came from the agent.

An optional local `pricing.json` exists only for token-only streams that carry no
cost (some Codex OTLP telemetry). It is unset by default, and anything derived
from it is labelled `configured_estimate` and never added to provider figures. If
asked "where do the numbers come from", the answer for Claude Code is: from
Claude Code.

## When the unit is not dollars

Not every agent reports money. Copilot CLI reports none at all, so in place of
`session $12.40` its line reads:

```text
Σ session 17.18 AIU · 9 premium reqs
```

Those are Copilot's own billing units — AI units and premium requests, the same
figures its native footer shows — and they are what the user's quota is consumed
in. They are provider-reported counts, diffed per reply exactly as a dollar total
would be, so `previous reply 0.265 AIU` is that reply's real consumption.

Say plainly what they are not: they are not dollars, no exchange rate is applied,
and nothing here converts one to the other. If asked what a reply cost in money
on Copilot, the honest answer is that Copilot does not report money, and the AIU
figure is the closest provider-reported measure of the same thing.

Codex reports neither money nor billing units over OTLP, so its line carries the
model and tokens only. Its own footer shows uncached input plus output, which is
what `↑ sent` minus the cached share plus `↓ output` describes.

## Reconfiguring

```sh
tokenwatch config set status.layout '"single"'    # one row instead of three
tokenwatch config set status.align false          # ragged rows, no column padding
tokenwatch config set status.maxWidth 200         # only used when COLUMNS is unset
tokenwatch config set status.color false          # drop ANSI colour
tokenwatch config set status.icons false          # labels only
tokenwatch config set status.iconOverrides '{"model":"⬡"}'
tokenwatch config set status.showSubagents false  # hide one field
```

Toggles: `showCost`, `showSession`, `showContext`, `showCache`, `showTokens`,
`showSubagents`. Icon keys: `model`, `turn`, `session`, `context`, `input`,
`inflight`, `cache`, `warm`, `output`, `subagents`. `NO_COLOR` always wins.

To fit more, prefer the multi-row layout over widening a single row.

## Multiple sessions at once

Derived state is per session: `sessions/s_<hash>.json` under the Tokenwatch
home, one writer each, so parallel Claude Code sessions never overwrite one
another's figures. The event ledger stays shared and append-only, which is what
lets audits and retrospectives span every session.

One consequence: `tokenwatch status` run by hand, with no payload on stdin,
needs another way to know its session: `--session <id>`, or inside Claude Code
the `CLAUDE_CODE_SESSION_ID` it sets. Without either it falls back to whichever
session wrote most recently, and says so in `session_scope.basis`
(`most_recent_fallback`) and, in the human-readable render, a `note:` line. Piped from Claude Code it always
carries the session id and is exact.

## Sharing the status line with another tool

Claude Code and Copilot CLI each run one status-line command, and it is their
only source of token and cost figures. Since intent 16 a plain
`tokenwatch install` composes with a status line that is already there: it keeps
the other line running beside Tokenwatch's, reading the agent's payload once and
handing the identical bytes to the other command, and
`tokenwatch uninstall` puts back exactly what was there. Several other lines can
be composed, up to four; they print in the order they were adopted, as one block
before Tokenwatch's rows (`status.composeOrder` `"last"`, the default) or after
them (`"first"`). `status.composeTimeoutMs` sets how long they may take; one still
running then is dropped, and the others and Tokenwatch's rows still print.

- `--no-compose` leaves another tool's status line exactly as it was, and
  Tokenwatch records hook events there but no tokens or cost.
- `--force` hides the other status line instead; uninstall restores it.
- A status line that already runs Tokenwatch is never composed, because every
  reading would be recorded twice. One that only mentions the word (a script in
  a folder named `agent-tokenwatch`, say) is composed, with a warning.

When another tool changes or replaces the status line later, check before
advising anything:

1. Run `tokenwatch doctor --json`.
2. Look for `warn` on `claude-status-line`, `<agent>-status-compose`,
   `<agent>-settings` or `collection:<agent>`. Each names the file involved and,
   when a repair would help, contains `Run:` or `To run both in that project:`
   followed by the exact command. Report the check ids and quote that command;
   never paste the JSON body, and never the other tool's command.
   `<agent>-settings` means install refused that agent's settings file, so it
   has no hooks, status line or skills: the file has to be repaired by the user
   before its command can work. `collection:<agent>` for that agent then says
   nothing is collected and points at the `<agent>-settings` line, which holds
   the command.
3. Offer to run the command it names, and run it only after the user says yes.
   It is always the full form, for the install's own scope. When no status line
   is set at all, it is a forced reinstall, for example
   `tokenwatch install --agents claude --scope project --project "/path/to/project" --force`.
   For a composed line that drifted it is a repair, for example:

```sh
tokenwatch install --agents claude --scope project --project "/path/to/project" --repair
```

`install --repair` keeps the lines it composed before (except one whose settings
file no longer sets it, or now runs Tokenwatch), adopts the one that
replaced the slot, and re-writes Tokenwatch's line; when nothing has drifted it
changes nothing. Uninstall afterwards puts back the line that was in the slot
when install or repair last ran. Do not shorten it to `tokenwatch repair`: that
is a different command, which merges ledger files.

Only when composition cannot run a tool - it needs its own shell or environment
variables - use the wrapper template Tokenwatch ships at
`examples/statusline-wrapper.mjs` in the installed package. Copy it, list the
commands in its `COMMANDS` array, and set `node /path/to/your/copy.mjs` as the
status line, and set `AGENT` in the copy to `claude` or `copilot`: a Copilot
payload recorded as Claude's is recorded under the wrong agent. It gives each
command the same payload on stdin and runs Tokenwatch's own status call for that
agent last - keep that call, since it is what records the turn. When Tokenwatch composes the wrapper itself, the
wrapper skips its own Tokenwatch call so the rows do not show twice. Tokenwatch
never runs the template on its own.

## When a field is missing

`tokenwatch status --agent <agent> --json` shows the underlying snapshot; absent
there means the agent did not supply it. `tokenwatch doctor` checks paths and
integrations, and whether usage is actually arriving. Never substitute a plausible-looking value — absent means
unavailable, and saying so is the correct answer.
