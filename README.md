# Agent Tokenwatch

[![ci](https://github.com/mellicci/agent-tokenwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mellicci/agent-tokenwatch/actions/workflows/ci.yml)
[![codeql](https://github.com/mellicci/agent-tokenwatch/actions/workflows/codeql.yml/badge.svg)](https://github.com/mellicci/agent-tokenwatch/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mellicci/agent-tokenwatch/badge)](https://scorecard.dev/viewer/?uri=github.com/mellicci/agent-tokenwatch)
[![npm](https://img.shields.io/npm/v/agent-tokenwatch)](https://www.npmjs.com/package/agent-tokenwatch)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![node](https://img.shields.io/node/v/agent-tokenwatch)](package.json)
[![license](https://img.shields.io/npm/l/agent-tokenwatch)](LICENSE)

Agent Tokenwatch is a dependency-free Node.js CLI that captures **local,
metadata-only** token and cost telemetry from Claude Code, OpenAI Codex CLI, and
GitHub Copilot CLI. It installs lifecycle hooks where available, feeds supported
command-backed status lines, accepts Codex OTLP/HTTP JSON and protobuf logs,
and installs a shared set of `tw-*` skills.

It records counts and operational structure—not prompts, code, transcripts,
file paths, tool inputs, tool outputs, or arbitrary telemetry bodies.

There is one exception, and it happens only when you type it:
`tokenwatch import <agent>` reads that agent's own session files to fill in
history from before Tokenwatch was installed. It keeps numbers, identifiers and
a hashed project only, labels every row as imported, and never runs on its own
([threat model](docs/privacy-threat-model.md#an-explicit-history-import)).

## What it shows

A native status line can look like this:

```text
⌬  Opus-5[1m] │ ▥ ctx 67% · Σ session $30.19 · ◴ cache warm 1.0h     │ ◐ this reply $2.29 so far · ❯ previous reply $0.740
⊞  Tokens     │ ↑ 670k sent · 99.8% from cache · 1.5k added to cache │ ↓ 668 output
⑃  Subagents  │ 25 completed                                         │ 6% of session cost
```

Each row opens with a label naming what it covers, and cells are padded so the
columns line up. Claude Code renders each printed line as its own row. Set
`status.layout` to `"single"` for a one-line version, or `status.align` to
`false` to keep rows ragged.

Every field is labelled, because an unlabelled number invites the wrong reading:

- `this reply` is what the answer being written has cost so far; `previous reply`
  is what the one before it finally cost. A reply is your prompt plus the whole
  answer to it, however many tool calls that involves.
- `session` is the provider's cumulative cost for the whole session, the most
  directly verifiable figure on the line.
- `sent` (up to the model) and `output` (back down) are the two sides of one
  call. The sent cell then says how that amount was billed: **from cache**
  (replayed cheaply) and **added to cache** (stored now at a premium so later
  turns are cheap). Those describe billing, not direction; the remainder is
  ordinary input.
- `Subagents` counts completed subagents and the share of session cost accrued
  **while at least one was running**. Parallel subagents share a window and the
  parent's own work counts too, so it is an upper bound, not per-subagent
  attribution.
- Cache warmth appears only when the provider reports a TTL. Tokenwatch does not
  render a configured default as though it had been measured.

Fields appear only when the agent exposes them, and lower-priority fields are
dropped rather than the line being truncated mid-value. A missing dollar value
stays `n/a`; Tokenwatch never silently substitutes an old built-in price.

Icons and a restrained magenta/white palette are on by default. Turn either off,
or change how much fits, with:

```sh
tokenwatch config set status.layout '"single"'
tokenwatch config set status.color false
tokenwatch config set status.icons false
tokenwatch config set status.maxWidth 120
```

Row width follows the `COLUMNS` value Claude Code provides, so the line fits the
real terminal; `maxWidth` applies only when `COLUMNS` is unset.

`NO_COLOR` is honoured regardless of configuration. Individual glyphs can be
replaced without disabling the rest:

```sh
tokenwatch config set status.iconOverrides '{"model":"⬡","cache":"⧉"}'
```

Keys are `model`, `turn`, `inflight`, `session`, `context`, `input`, `cache`,
`warm`, `output`, and `subagents`.

## Design

- **Zero runtime dependencies.** Node.js 20+ and built-in modules only.
- **Append-only JSONL by default.** Easy to inspect, stream, back up, or ingest.
- **Metadata allowlist.** Raw prompts, messages, code, paths, tool contents, and
  OTLP bodies are discarded before persistence.
- **Provider cost first.** Provider-reported observations remain distinct from
  optional, dated local estimates.
- **Cache-safe accounting.** Fresh input, cache reads, and cache writes are
  represented separately; OpenAI-style cached-input subsets are not added twice.
- **Non-blocking hooks.** Collector errors are swallowed by default so an agent
  session is not broken by telemetry.
- **Portable skill.** One source is installed into `.claude/skills` and
  `.agents/skills` as required by the selected agents.
- **Reversible installation.** Existing hooks/settings are preserved. An
  existing status line is kept and run beside Tokenwatch's by default (up to
  four of them, in order), and `tokenwatch install --repair` picks up one that
  another tool installed later; `--no-compose` leaves it alone instead, and
  `--force` hides it. `uninstall` restores what any of them replaced.

## Install

Node.js 20+ is the only prerequisite. One command wires hooks, status lines,
and all seven skills into every installed agent — Claude Code, Codex CLI,
Copilot CLI — whichever are present, on macOS, Linux, or Windows:

```sh
npx agent-tokenwatch install --agents all --scope user
```

That needs no clone and no global install. Prefer a persistent `tokenwatch`
command for daily use (`status`, `analyze`, …)? Install it once:

```sh
npm install -g agent-tokenwatch
tokenwatch install --agents all --scope user
tokenwatch doctor
```

The package is named `agent-tokenwatch`; the command it provides is
`tokenwatch`. Both commands work the same way in bash/zsh, PowerShell, and
cmd.exe — nothing here is a shell-chained one-liner that could break on a
shell without `&&` (Windows PowerShell 5.1 does not have it).

Working from a clone or the portable archive instead:

```sh
git clone https://github.com/mellicci/agent-tokenwatch.git
# alternatively: unzip agent-tokenwatch-portable-0.1.0.zip
cd agent-tokenwatch
npm pack
npm install -g ./agent-tokenwatch-<version>.tgz
tokenwatch install --agents all --scope user
```

Install the tarball `npm pack` printed, not the folder: `npm install -g .`
installs a link to the folder, so every hook would run the script inside it and
break when the folder is moved or cleaned up. `tokenwatch install` and
`tokenwatch doctor` warn when the CLI is reached through a link or lives in a
temporary or download folder. `npm link` is for developing Tokenwatch itself;
see [INSTALL.md](INSTALL.md#developing-tokenwatch-itself).

Setting up a machine from scratch is written out step by step in
[INSTALL.md](INSTALL.md): Node, the GitHub CLI, all three agent CLIs, and then
Tokenwatch, with the commands for macOS, Linux, WSL, and Windows.

Which agent and operating-system combinations have actually been checked, how,
and when is in [Platform and agent support](#platform-and-agent-support) below.
Windows was run hands-on with Claude Code and Copilot CLI on 2026-09-23 and
2026-09-28; the fixes those runs led to have not been re-verified there yet.
Codex CLI has not been live-tested for this release, and no agent has been run
hands-on on macOS: only the test suite runs there.

Install project-local hooks and skills instead:

```sh
npx tokenwatch install --agents all --scope project --project .
```

Project scope writes Claude hooks to `.claude/settings.local.json`, not the
shared `.claude/settings.json`, because the generated commands embed absolute
paths to this machine's Node executable and install directory.

The installer prints every resolved path and any conflict it deliberately left
untouched. All paths can be overridden, for example:

```sh
tokenwatch install --agents claude \
  --scope user \
  --claude-settings /custom/claude/settings.json \
  --claude-skills /custom/claude/skills
```

Windows PowerShell uses the same CLI flags. Off Windows, the generated hook and
status-line commands contain absolute quoted paths to the current Node
executable and Tokenwatch entry point. On Windows, Claude Code's commands start
the `node` on `PATH` instead, so that Git Bash and PowerShell both run them
(`docs/interfaces.md`).

## Platform and agent support

Each cell says what was actually observed for that agent on that operating
system, not what should work. **Hands-on verified** means someone ran the agent
with Tokenwatch and saw it record, with the agent version and date.
**Tested in CI** means Tokenwatch's own test suite passed on that platform, which
says nothing about the agent running the commands Tokenwatch writes.
**Provisional** means smoke-tested at most: the adapter has not been reconciled
against the agent's own records, so its numbers may be incomplete. **Failed
hands-on** means a real run broke, fixes have landed since, and nobody has run
it again. **Untested** means nothing is recorded.

<!-- support-matrix:begin (generated from docs/support-matrix.json by scripts/support-matrix.mjs; do not edit by hand) -->

Last reviewed: 2026-09-28.

| Agent | Linux | macOS | Windows | WSL |
|---|---|---|---|---|
| Claude Code | **Hands-on verified**: 2.1.280 and 2.1.281, 2026-09-24 | **Tested in CI** (last green 2026-09-18), not yet hands-on | **Failed hands-on** 2026-09-28 (version 2.1.283); fixes landed, not re-verified; some causes still open | **Untested** |
| Codex CLI | **Provisional**: smoke-tested 2026-09-17 (version not recorded) | **Provisional**: CI only (last green 2026-09-18), not yet hands-on | **Failed hands-on** 2026-09-23 (version not recorded); fixes landed, not re-verified; some causes still open | **Untested** |
| GitHub Copilot CLI | **Hands-on verified**: 1.0.85, 2026-09-17 | **Tested in CI** (last green 2026-09-18), not yet hands-on | **Provisional**: smoke-tested 2026-09-28 (version 1.0.88) | **Untested** |

**CI.** The `ci` workflow runs on ubuntu-latest, macos-latest and windows-latest, each on Node 20, 22 and 24. It last passed on 2026-09-18 (commit `5ca5ea0`, in the private development repository). On 2026-09-28 the matrix ran again: Linux and macOS passed, Windows failed 32 tests. All 32 are fixed since (31 in the tests, which assumed POSIX paths, shells or case; one in how a timed-out composed status line is stopped on Windows) and pass on windows-latest, but the full matrix has not been re-run on them.

- CI runs Tokenwatch's own test suite and smoke test. It does not run Claude Code, Codex CLI or GitHub Copilot CLI, so it cannot show that an agent executes the commands Tokenwatch writes; only a hands-on run can.
- A hands-on date covers the Tokenwatch build installed that day. A change dated later — the CHANGELOG entries still marked "Needs a hands-on Windows test" among them — is covered by the test suite, not by that run.
- Not live-tested for this release: Codex CLI on any operating system (its cells record older smoke tests and the 2026-09-23 Windows failure), and any agent on macOS, where only the test suite has run.

**Evidence per cell:**

- **Claude Code on Linux.** The maintainer's machine, a Linux container, has recorded Claude Code status-line samples and hook events continuously since 2026-09-09; the newest, on 2026-09-24, came from sessions running Claude Code 2.1.280 and 2.1.281. Subagent counts were reconciled against Claude Code's own transcripts (`docs/publishing.md`). That machine ran the build from before the Unreleased changes dated 2026-09-24 (sandbox-safe reports, doctor's collection and status-line checks, install-location warnings).
- **Codex CLI on Linux.** Smoke-tested, not field-tested. On 2026-09-17 a session started through `tokenwatch-codex` recorded token counts over OpenTelemetry and `notify` recorded turn boundaries; on 2026-09-18 host detection was checked by running `codex exec`; the Codex version was not recorded for either. On 2026-09-24, after a user-scope and after a project-scope install, the skill list codex-cli 0.154.0 gives its model (`codex debug prompt-input`) held all six skills. The recorded events have not been reconciled against Codex's own session logs, which `docs/publishing.md` requires before an adapter counts as field-tested. A session started as plain `codex` records no tokens (`docs/limitations.md`).
- **GitHub Copilot CLI on Linux.** On 2026-09-17 a live GitHub Copilot CLI 1.0.85 session delivered status-line renders and hook events, and the per-call token delta derived from its cumulative counters matched the `last_call_*` figures Copilot reports separately; the captured payloads are the 1.0.85 fixtures in `test/fixtures`. The recorded data was checked again on 2026-09-21. Hook entries have since become a `bash` and `powershell` pair and `preToolUse` is no longer registered (Unreleased, 2026-09-24); no real Copilot has run that form yet.
- **Claude Code on macOS, Codex CLI on macOS and GitHub Copilot CLI on macOS.** The `ci` matrix ran the full suite and the smoke test on `macos-latest` for Node 20, 22 and 24, all passing on 2026-09-18. No hands-on run on a Mac is recorded for any agent.
- **Claude Code on Windows.** Hands-on 2026-09-28 with Git Bash present (Windows 11, PowerShell 5.1 and 7, Node 20): install at user and project scope, including a project path with spaces and a settings file with a byte-order mark, CRLF line endings and tabs; hooks and the status line recorded; composition with another tool's status line and `install --repair`; the privacy canary found nowhere; all seven skills; history import and undo; and uninstall restoring every settings file byte for byte all passed. Five checks failed and are fixed since, not re-run on Windows: doctor skipped its command probes for a settings file with a byte-order mark, a hand-run `status` waited forever on an open stdin, status-line renders with no model call were counted as turns, and two background subagents were counted as one. Not run: the pass without Git Bash, where Claude Code uses PowerShell.
- **Codex CLI on Windows.** Hands-on 2026-09-23, with Codex started as plain `codex`: no tokens were recorded (expected without `tokenwatch-codex`), no Codex events reached the ledger at all, reporting commands failed with `EPERM` inside Codex's sandbox, and the skills could not be found; the same day's test run showed the installer did not recognise its own `notify` relay. Fixed since: reporting commands work where the data directory is read-only, the relay is recognised by its parsed arguments, and the README, install output and skills give Codex's `$tw-...` syntax while `doctor` checks where Codex looks for skills. Still open: why no Codex events arrived at all, and whether the skill syntax was the whole skills problem. `doctor` now tells the causes apart (the relay failing, with its stage and error class; the relay never started; Codex not launched through `tokenwatch-codex`), and Codex's source shows it starts `notify` outside its sandbox (`docs/limitations.md`), but which cause applied there is unknown. Nothing has been re-run on Windows.
- **GitHub Copilot CLI on Windows.** Smoke-tested 2026-09-28 with Copilot CLI 1.0.88 (Windows 11, PowerShell 5.1 and 7): user and project install, ten hook events with no `preToolUse`, every hook command run under both PowerShells, no tool call denied, the status line recording through cmd.exe with AI units and premium requests matching Copilot's own, all seven skills, a verified history import and its undo, and uninstall restoring the settings files. One session of three prompts was reported as 16 turns; since then a Copilot turn is one prompt and its whole answer and renders with no model call are not turns, not yet re-run on Windows. Not run: the regression scenarios (refused settings, a failing hook, composition and repair, an edited skill, a corrupt state file) and the check of Copilot's session variable.
- **Claude Code on WSL, Codex CLI on WSL and GitHub Copilot CLI on WSL.** No run inside a WSL distribution is recorded for any agent. Under WSL Tokenwatch runs as Linux code, which the Linux CI leg covers. The Linux machine above is a container on a WSL2 kernel, not a WSL distribution used from Windows, so it does not exercise the split between the WSL and Windows home directories that `INSTALL.md` warns about.

<!-- support-matrix:end -->

The table is generated from [`docs/support-matrix.json`](docs/support-matrix.json)
by `node scripts/support-matrix.mjs --write`, and a test fails if the two
disagree. It is updated before every release (see
[docs/publishing.md](docs/publishing.md)).

## Agent integrations

### Claude Code

The installer adds metadata collectors for session, prompt-submit, stop,
subagent, pre-compact, and session-end lifecycle events. When no custom status
line is already present, it installs:

```text
tokenwatch status --agent claude --ingest-stdin
```

The status adapter consumes the JSON delivered on stdin and uses cumulative
session cost only after a baseline exists. The first cumulative snapshot is not
misreported as a single-turn charge.

### GitHub Copilot CLI

Tokenwatch writes a dedicated `tokenwatch.json` hook file and installs
`statusLine.command` into `~/.copilot/settings.json` when that slot is free.
Each hook carries a Bash command and a PowerShell command, because Copilot runs
hooks through PowerShell on Windows and a single command string did not parse
there. Tokenwatch registers no `preToolUse` hook: Copilot denies the tool call
when that hook fails, and a telemetry tool must never be able to do that.
`tokenwatch doctor` runs every installed Copilot command through the shell
Copilot will use, without recording anything, so a command that does not parse
shows up as an error there instead of in the agent.

Copilot reports no currency, so its line shows the units it actually bills in:

```text
⌬  Gpt-5.6-luna │ ▥ ctx 61% · Σ session 17.18 AIU · 9 premium reqs │ ❯ previous reply 0.265 AIU
⊞  Tokens       │ ↑ 118k sent · 99.9% from cache · 49 added to cache │ ↓ 17 output
```

It also sends no per-call token gauge, only session-cumulative counters, so one
call's usage is the movement between two renders — the same baseline-and-diff
rule already used for cumulative cost. Its auto router reports `model.id: "auto"`
and names its choice in `display_name`; the chosen model is what gets recorded.

Because Copilot CLI configuration is evolving, run `tokenwatch doctor` after an
upgrade and inspect the generated path shown by `tokenwatch paths`.

### OpenAI Codex CLI

Codex `notify` supplies turn-complete lifecycle context but not necessarily exact
token billing. Tokenwatch preserves a prior notifier through a local relay.
Exact token observations are accepted through a loopback receiver that speaks
OTLP/HTTP JSON and a small protobuf-logs subset.

Run Codex through the wrapper:

```sh
tokenwatch-codex
# or
tokenwatch codex -- --full-auto
```

The installer adds a managed `[otel]` block only when none exists. An existing
OpenTelemetry configuration is never replaced automatically. The block declares
`protocol`, which Codex requires: without it Codex refuses to load `config.toml`
at all. `codex.otlpProtocol` sets it, and the wrapper's exporter environment is
derived from the same value so the two cannot disagree. The wrapper starts
`127.0.0.1:4318`, sets standard OTLP endpoint/protocol environment variables,
launches Codex, and closes the receiver on exit.

Codex has a configurable built-in footer rather than an arbitrary command slot,
so Tokenwatch does not replace it. Use `tokenwatch status --agent codex`, or keep
Codex’s native footer and run the audit on demand.

## Daily commands

```sh
# Current local view
tokenwatch status --agent claude
tokenwatch status --agent copilot
tokenwatch status --agent codex
# One session in particular; without it, a hand run reports the agent's own
# session where it can tell, else the most recent one, and says which
tokenwatch status --agent claude --session <id>

# Evidence-based audit
tokenwatch analyze --since 7d --format markdown

# Machine-readable audit for the agent skill
tokenwatch analyze --since 30d --format json

# Cost drivers ranked in code, against the preceding window of equal length
tokenwatch analyze --since 7d --group-by model --compare --format json
tokenwatch analyze --since 7d --group-by session --limit 5 --format json

# Controlled experiments: propose, then close with what actually happened
tokenwatch experiment add --hypothesis ... --change ... --baseline ... --metric ...
tokenwatch experiment list
tokenwatch experiment close <id> --result adopted --outcome "cost per turn fell 40%"

# Which agent am I in, and which agents have data
tokenwatch agents

# Portable export
tokenwatch export --since 30d --format csv --output tokenwatch.csv

# Retention. Nothing prunes on a timer; `doctor` warns when the ledger has
# grown past the configured retentionDays, and these are the two ways to act.
tokenwatch prune --retention
tokenwatch prune --older-than 30d

# History from before install, only when you type it: numbers only, labelled
# imported, checked against live capture first (see the threat model)
tokenwatch import claude --check          # the files' shape and the comparison
tokenwatch import claude --dry-run        # what would be written
tokenwatch import claude --since 30d      # write; --accept-unverified if the check cannot verify
tokenwatch import claude --undo claude-jsonl-1 [--run <run id>]
tokenwatch import claude --keep-mapping repaired.json   # keep a repaired mapping; later imports use it
tokenwatch import claude --export-mapping               # print the mapping in use, to share as data

# Merge exchange fragments left by versions before per-turn accumulation
tokenwatch repair --dry-run
tokenwatch repair

# Remove managed integrations
tokenwatch uninstall --scope user
```

## Skills

Installing copies seven skills into each selected agent's discovery path
(`.claude/skills/<name>/SKILL.md` for Claude Code, `.agents/skills/<name>/SKILL.md`
for Codex and Copilot CLI). Each agent invokes them in its own syntax:

| Agent | Invoke a skill | List the skills |
|---|---|---|
| Claude Code | `/tw-retrospective-this-session` | type `/` |
| Codex CLI (0.95.0 or later) | `$tw-retrospective-this-session` | `/skills`, or type `$` |
| Copilot CLI | `/tw-retrospective-this-session` | `/skills list` |

Codex does not recognise `/tw-…`. A session that was already open when you
installed may not list the skills until it is restarted (in Copilot CLI,
`/skills reload`). `tokenwatch doctor` says whether the shared skills sit where
Codex looks and whether Codex can parse them.

| Skill | Use it when |
|---|---|
| `tw-cost-drivers-basics` | Someone is new to this — what a token is, why input/output/cache are priced differently, what a cache TTL does. Concepts, not a report. |
| `tw-explain-statusline` | Someone asks what a status-line field means, why cache reads so high, or how to change icons, colours, and width. |
| `tw-retrospective-this-session` | A quick "how much has *this* session cost so far" gut-check, without a multi-day audit. |
| `tw-retrospective-overall` | You want to know where the money went over a week or a month, with cost drivers ranked by measured share. Backward-looking. |
| `tw-token-cost-coach` | You want to understand *why* something was expensive, walked through interactively against your own numbers. |
| `tw-cost-audit-define-experiment` | You want a diagnosis and a controlled experiment to test a change — and an evaluation of experiments already running. Forward-looking. |
| `tw-import-history` | You want the sessions from before Tokenwatch was installed counted. It checks the import against live capture before writing, and repairs a mapping an agent upgrade broke, from its shape alone, never reading a prompt. |

The four reporting skills (`tw-retrospective-this-session`, `tw-retrospective-overall`,
`tw-token-cost-coach`, `tw-cost-audit-define-experiment`) establish which agent
they are reporting on before reading any numbers — one installation serves all
three agents from one ledger, so a skill invoked inside Copilot that describes
Claude's sessions is describing somebody else's work. `tokenwatch agents` names
the host and lists every agent with recorded activity, and units are never
mixed: Claude reports USD, Copilot reports AI units and premium requests, Codex
reports neither.

All four start from aggregates, keep provider-reported charges separate from
configured estimates, and refuse to invent prices or claim unmeasured savings.
They do not read prompts, transcripts, tool output, or source files. Every share
and rank they quote comes from `--group-by`, computed in code rather than totalled
by eye — a model asked to add a thousand CSV rows in its head produces a plausible
number, and a plausible number is worse than none.

A bundled skill is only replaced on reinstall when you pass `--force`; without it
a file you edited yourself is left alone. The text `--force` replaces is kept in
an owner-only backup under `~/.tokenwatch/backups/skills/`, never in the install
record or `install`'s output, and `uninstall` puts it back when the backup still
matches, or leaves the file and says why when it does not. A backup no install
record names any more, such as the first of two forced installs over a skill you
edited twice, is reported by `tokenwatch doctor` (`skill-backups:orphaned`) and
never deleted for you.

## Local data

Defaults:

```text
~/.tokenwatch/config.json
~/.tokenwatch/events.jsonl
~/.tokenwatch/sessions/s_<hash>.json
~/.tokenwatch/experiments.jsonl
~/.tokenwatch/install-state.json
~/.tokenwatch/backups/skills/
~/.tokenwatch/codex-relay.json
```

`codex-relay.json` is the Codex notify relay's own record of when it last
recorded a turn and how its recent runs failed - stage and error class, never
the payload - which `tokenwatch doctor` reads.

Override the root or individual files:

```sh
export TOKENWATCH_HOME="$HOME/.local/state/tokenwatch"
export TOKENWATCH_DATA="$HOME/private/agent-usage.jsonl"
```

One installation serves every concurrent agent session. The ledger is shared and
append-only, which is safe for many writers; derived state is kept in one file
per session, so no session can overwrite another's counters. State from the
earlier single-file layout is carried across on first use.

The event file is JSONL so a damaged final line does not make earlier records
unreadable. Each session's state file holds recent safe summaries, deduplication
fingerprints, cumulative-cost baselines, and cache activity timestamps.

## Optional pricing

Tokenwatch ships **no model prices**. Copy the example, verify current prices,
and point the config to it:

```sh
cp examples/pricing.example.json ~/.tokenwatch/pricing.json
tokenwatch config set pricingFile '"~/.tokenwatch/pricing.json"'
```

A pricing rule must cover every non-zero token component used by an event. An
incomplete rule produces no estimate instead of a deceptively low one.

## Development

```sh
npm test
npm run smoke
npm run check
npm pack --dry-run
```

Tests cover normalization, privacy rejection, cumulative cost baselines,
cache accounting, OTLP body allowlisting, status formatting, and
install/uninstall round trips in temporary homes.

## Documentation

- [Installing on a new machine](INSTALL.md)
- [Architecture](docs/architecture.md)
- [Interface map and official references](docs/interfaces.md)
- [Configuration](docs/configuration.md)
- [Normalized event schema](docs/event-schema.md)
- [Privacy and threat model](docs/privacy-threat-model.md)
- [Operational recipes](docs/recipes.md)
- [Known limitations](docs/limitations.md)
- [Publishing to npm](docs/publishing.md)

## Support

Agent Tokenwatch is maintained by one person on a best-effort basis, with no
response-time commitment. Bug reports, questions, and ideas are welcome as
[issues](https://github.com/mellicci/agent-tokenwatch/issues/new/choose); pull
requests are not accepted (see [CONTRIBUTING.md](CONTRIBUTING.md)). Report
security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT

Agent Tokenwatch is an independent project. It is not affiliated with, endorsed
by, or sponsored by Anthropic, OpenAI, or GitHub. Claude, Claude Code, Codex,
GitHub, and GitHub Copilot are trademarks of their respective owners.
