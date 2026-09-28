# Agent Tokenwatch

[![ci](https://github.com/mellicci/agent-tokenwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mellicci/agent-tokenwatch/actions/workflows/ci.yml)
[![codeql](https://github.com/mellicci/agent-tokenwatch/actions/workflows/codeql.yml/badge.svg)](https://github.com/mellicci/agent-tokenwatch/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mellicci/agent-tokenwatch/badge)](https://scorecard.dev/viewer/?uri=github.com/mellicci/agent-tokenwatch)
[![npm](https://img.shields.io/npm/v/agent-tokenwatch)](https://www.npmjs.com/package/agent-tokenwatch)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![node](https://img.shields.io/node/v/agent-tokenwatch)](package.json)
[![license](https://img.shields.io/npm/l/agent-tokenwatch)](LICENSE)

**See what your coding agent is costing you, live, in its own status line —
without a single prompt leaving your machine.**

Agent Tokenwatch records token, cache and cost figures from **Claude Code**,
**GitHub Copilot CLI** and **OpenAI Codex CLI**, shows them where you already
look, and gives your agent seven skills that explain where the money went and
how to spend less. It keeps numbers only: never your prompts, code, file paths or
tool output.

```text
⌬  Opus-5[1m] │ ▥ ctx 67% · Σ session $30.19 · ◴ cache warm 1.0h     │ ◐ this reply $2.29 so far · ❯ previous reply $0.740
⊞  Tokens     │ ↑ 670k sent · 99.8% from cache · 1.5k added to cache │ ↓ 668 output
⑃  Subagents  │ 25 completed                                         │ 6% of session cost
```

## Why

Coding agents spend money continuously and report it thinly: a running total at
best, units that do not compare from one tool to the next, and nothing you can
look back at next week. Tokenwatch gives you:

- **A live status line.** This reply, the previous one, the session total,
  context fill, cache warmth and subagents, every number labelled.
- **Answers from your own data.** Ask your agent `/tw-retrospective-overall` where
  last week's money went, or `/tw-token-cost-coach` why a session was expensive.
- **Experiments, not hunches.** Record a change with a baseline and a metric, then
  close it with what actually happened.

Everything stays on your machine: an append-only file under `~/.tokenwatch`, no
service, no account, nothing sent anywhere.

## Quick start

Node.js 20 or later is the only prerequisite.

```sh
npm install -g agent-tokenwatch
tokenwatch install --agents all --scope user
tokenwatch doctor
```

Start a new agent session and the status line appears with the first reply.
`install` wires hooks, the status line and the skills into every agent it finds;
`doctor` checks that each one is really delivering data. The package is
`agent-tokenwatch`, the command it installs is `tokenwatch`, and both work the same
in bash, zsh, PowerShell and cmd.exe.

- **Codex CLI:** start it as `tokenwatch-codex` (or `tokenwatch codex -- <args>`)
  so its token counts reach Tokenwatch; plain `codex` records turns but no tokens.
- **One project only:** `tokenwatch install --agents all --scope project --project .`
- **Already have a status line?** It is kept and runs beside Tokenwatch's.
- **Remove it all:** `tokenwatch uninstall --scope user` takes out everything it
  added and restores whatever it replaced.

A new machine, a source checkout or custom paths: see [INSTALL.md](INSTALL.md).

## Reading the status line

- **`this reply` / `previous reply`**: what the answer being written has cost so
  far, and what the one before it finally cost. A reply is your prompt plus the
  whole answer, however many tool calls it takes.
- **`session`**: the provider's own running total for the session.
- **`sent` / `output`**: the latest call's two directions. `from cache` is input
  replayed cheaply; `added to cache` is stored now, at a premium, so later turns
  are cheap.
- **`cache warm`**: time left before the prompt cache expires, shown only when the
  provider reports it.
- **`Subagents`**: how many finished, and the share of session cost accrued while
  any ran. That share is an upper bound, not a per-subagent bill.
- **Copilot CLI** bills in AI units and premium requests, not dollars, so that is
  what its line shows. Nothing is ever converted into money it was not.

A figure the agent does not report stays absent or `n/a`; Tokenwatch never fills a
gap with a guess. Layout, colours, icons and width are configurable
([configuration](docs/configuration.md)), and `/tw-explain-statusline` explains
your own line field by field.

## Skills

`install` adds seven skills to each agent. Claude Code and Copilot CLI invoke them
as `/tw-<name>`, Codex as `$tw-<name>`:

| Agent | Invoke a skill | List the skills |
|---|---|---|
| Claude Code | `/tw-retrospective-this-session` | type `/` |
| Codex CLI (0.95.0 or later) | `$tw-retrospective-this-session` | `/skills`, or type `$` |
| Copilot CLI | `/tw-retrospective-this-session` | `/skills list` |

| Skill | Use it when |
|---|---|
| `tw-cost-drivers-basics` | You are new to this: what a token is, why output and cache writes cost more, what a cache TTL does. |
| `tw-explain-statusline` | You want a field on your line explained, or to change its layout, colours or width. |
| `tw-retrospective-this-session` | You want a quick read on what the current session has cost. |
| `tw-retrospective-overall` | You want to know where the money went over a week or a month, drivers ranked by measured share. |
| `tw-token-cost-coach` | You want to learn why something was expensive, walked through with your own numbers. |
| `tw-cost-audit-define-experiment` | You want to change something and measure whether it worked. |
| `tw-import-history` | You want your sessions from before Tokenwatch was installed counted too. |

The reporting skills first establish which agent they are in, never add dollars to
AI units, take every share and rank from Tokenwatch's own calculations rather than
the model's arithmetic, and label what is measured apart from what is inferred.
None of them reads your prompts, transcripts or code.

## Everyday commands

```sh
tokenwatch status --agent claude                  # the current session, by hand
tokenwatch agents                                 # which agent you are in, which have data
tokenwatch analyze --since 7d --format markdown   # an evidence-based audit of the week
tokenwatch analyze --since 7d --group-by model --compare --format json
tokenwatch export --since 30d --format csv --output tokenwatch.csv
tokenwatch experiment list
tokenwatch doctor                                 # is every agent still delivering data?
```

`tokenwatch import <agent>` fills in history from before you installed: numbers
only, labelled as imported, and checked against what Tokenwatch recorded live
before anything is written. It runs only when you type it. Retention, backups and
other tasks are in [Operational recipes](docs/recipes.md), optional prices in
[Configuration](docs/configuration.md), and `tokenwatch help` lists every command.

## Private by construction

- **Numbers, not content.** Events pass an allowlist, and identifier values are
  checked too, so a secret or a path is dropped even from a field that looks
  innocent. Project paths are stored only as a salted hash.
- **Local only.** Nothing opens an outbound connection. The one listener is the
  loopback receiver Codex's telemetry needs, on `127.0.0.1`.
- **No guessed prices.** Costs come from the provider, or from a price file you
  supply, and are labelled which. Tokenwatch ships no prices of its own.
- **Never in the agent's way.** Hooks fail open, and Tokenwatch registers no hook
  whose failure could block a tool call.
- **Zero runtime dependencies.** Node.js built-ins only.
- **Reversible.** Settings files are edited in place, keeping your formatting and
  comments, and a file you have not touched since comes back byte for byte on
  uninstall.

The single exception to "no content is read" is the history import above, and it
reads only what you ask it to. The details are in the
[privacy and threat model](docs/privacy-threat-model.md).

## Supported agents and platforms

Each cell says what was actually seen working, not what should work. **Hands-on
verified** means someone ran that agent with Tokenwatch and saw it record;
**Tested in CI** means Tokenwatch's own test suite passes there; **Provisional**
means smoke-tested at most; **Failed hands-on** means a real run broke, fixes
have landed since, and nobody has re-run it yet.

## Where your data lives

```text
~/.tokenwatch/events.jsonl           append-only ledger, one event per line
~/.tokenwatch/sessions/s_<hash>.json live per-session state
~/.tokenwatch/config.json            settings
~/.tokenwatch/install-state.json     what install changed, so uninstall can undo it
~/.tokenwatch/experiments.jsonl      your experiment journal
```

Set `TOKENWATCH_HOME` to move all of it, or `TOKENWATCH_DATA` to move just the
ledger. Nothing is pruned on a timer: `tokenwatch prune --older-than 30d` when you
choose to.

## Documentation

- [Installing on a new machine](INSTALL.md)
- [Configuration](docs/configuration.md)
- [Operational recipes](docs/recipes.md)
- [How each agent is integrated](docs/interfaces.md)
- [Privacy and threat model](docs/privacy-threat-model.md)
- [Known limitations](docs/limitations.md)
- [Event schema](docs/event-schema.md)
- [Architecture](docs/architecture.md)

## Development

```sh
npm run check      # syntax, the full test suite and a smoke test
npm pack --dry-run # what would ship
```

## Support

Agent Tokenwatch is maintained by one person on a best-effort basis, with no
response-time commitment. Bug reports, questions and ideas are welcome as
[issues](https://github.com/mellicci/agent-tokenwatch/issues/new/choose); pull
requests are not accepted (see [CONTRIBUTING.md](CONTRIBUTING.md)). Report
security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT

Agent Tokenwatch is an independent project. It is not affiliated with, endorsed
by, or sponsored by Anthropic, OpenAI, or GitHub. Claude, Claude Code, Codex,
GitHub, and GitHub Copilot are trademarks of their respective owners.
