# Agent interface map

Last reviewed: 2026-09-25. Agent CLIs evolve quickly; re-check the linked primary
sources before changing installer schemas.

| Agent | Lifecycle source | Exact usage/cost source | Native custom status | Skill path | Skill invocation |
|---|---|---|---|---|---|
| Claude Code | Command hooks | Status-line stdin fields, when exposed | Command-backed status line | `~/.claude/skills/<name>/SKILL.md`; project `.claude/skills/` | `/<name>` |
| OpenAI Codex CLI | `notify` turn-complete payload, plus `codex.user_prompt` in OTLP | OpenTelemetry export (`codex.sse_event`) | Built-in item-list footer; Tokenwatch leaves it intact | `$HOME/.agents/skills/<name>/SKILL.md` (0.95.0 and later); `.agents/skills/` in each directory from the repository root down to the working directory (0.94.0 and later) | `$<name>`, or pick from `/skills`; `/<name>` is not recognised |
| GitHub Copilot CLI | JSON hook configuration | Status-line stdin fields | `statusLine.command` in `settings.json` | `~/.agents/skills/<name>/SKILL.md` (also `~/.copilot/skills/`); project `.agents/skills/` (also `.github/skills/`, `.claude/skills/`) | `/<name>`; `/skills list`, `/skills reload` |

## Why the adapters are asymmetric

A stop event is useful behavioral context, but it is not a universal billing
record. Tokenwatch therefore treats lifecycle hooks and usage telemetry as
separate evidence:

- Claude status JSON can carry model, cost, context, and cache-token components;
  lifecycle hooks add compaction and subagent context.
- Claude Code runs `statusLine.command` through a shell: on Windows "through Git
  Bash when Git Bash is installed, or through PowerShell when Git Bash is
  absent", with `CLAUDE_CODE_GIT_BASH_PATH` naming the Git Bash to use. It
  debounces updates at 300 ms and cancels a status script still running when the
  next update arrives (https://code.claude.com/docs/en/statusline, read
  2026-09-24). A composed install replays other tools' status commands through
  that same shell, and must record its own reading before waiting on it.
- Claude Code runs **hooks** by the same rule. A hook without `args` is "shell
  form": "The `command` string is passed to a shell: `sh -c` on macOS and Linux,
  Git Bash on Windows, or PowerShell when Git Bash isn't installed"
  (https://code.claude.com/docs/en/hooks, "Exec form and shell form", read
  2026-09-24). A hook entry can also set `shell` (`bash` or `powershell`) or
  `args`, which spawns `command` directly with no shell. No Claude Code version
  is given for either field. Native Windows needs no Git: "Native Windows |
  Requires: None; Git for Windows is optional", and without it Claude Code uses
  PowerShell (https://code.claude.com/docs/en/setup, read 2026-09-24). Which
  PowerShell executable it starts is not stated.
- So every Claude Code command Tokenwatch writes on Windows is one string that
  both shells read the same way: a bare `node`, then double-quoted words, with
  no `&` (PowerShell's call operator, which Bash rejects with exit 2, and exit 2
  blocks `UserPromptSubmit` and `Stop`). Tokenwatch sets neither `shell` nor
  `args`: a Claude Code that ignored `shell` would run the `&` form under Git
  Bash, and one that ignored `args` would run `node` with no script and record
  nothing. A path that the two shells would read differently (`"`, `$`, a
  backtick, a doubled or trailing backslash, a control character, or U+201C-U+201F)
  is refused at install. Off Windows the commands are unchanged: the absolute
  Node path and CLI, single-quoted. `tokenwatch doctor` runs each installed Claude
  command through the shell Claude Code would use now, in probe mode, and the
  status-line probe shows that its stdin arrived.
- Codex notify is useful for turn boundaries and structural lengths. OTLP is the
  token-telemetry path. Tokenwatch accepts OTLP/HTTP JSON plus a small,
  auditable protobuf-logs subset while remaining dependency-free.
- Codex starts the `notify` command itself, with no shell and outside the
  sandbox, appends the JSON payload as its last argument, and discards the
  command's stdin, stdout and stderr (`codex-rs/hooks/src/legacy_notify.rs` in
  the open-source repository, read at commit `53446f9`). The payload is
  `type`, `thread-id`, `turn-id`, `cwd`, an optional `client`,
  `input-messages` and `last-assistant-message`; Tokenwatch keeps the
  identifiers, a salted hash of `cwd`, and the byte lengths of the last two. Because nothing the relay
  prints is seen, it records its own failures in `codex-relay.json` for
  `doctor`. Details and limits are in `docs/limitations.md`.
- Copilot CLI invokes both command hooks and a command-backed status line. Its
  status object looks Claude-shaped but reports the opposite kind of number: as
  of 1.0.85 `context_window.current_usage` is absent and `used_percentage` and
  `context_window_size` are null, while session-cumulative counters
  (`total_input_tokens`, `total_cache_read_tokens`, `total_cache_write_tokens`,
  `total_output_tokens`) and `current_context_*` are populated. One call's usage
  is therefore the movement between two renders, which the store derives the way
  it already derives per-turn cost from Claude's cumulative total. The derived
  delta agrees exactly with the `last_call_input_tokens` and
  `last_call_output_tokens` that Copilot reports separately, and additionally
  recovers the cache split those two fields do not carry.
- Copilot's input totals contain both cache halves, so fresh input is the
  remainder after reads *and* writes, not reads alone.
- Copilot carries no currency anywhere: its `cost` block holds durations, line
  counts, and premium-request counts. Cost fields stay absent rather than being
  synthesized. What it does bill in - `cost.total_premium_requests` and
  `ai_used.total_nano_aiu` (nano-units: 17184730000 is the 17.18 its own footer
  shows) - is recorded as a billing unit and diffed per call, never as money.
- Copilot 1.0.85 declares 17 hook events in `schemas/api.schema.json`. Tokenwatch
  registers the ones it can report on: session and prompt boundaries, tool use,
  tool failure and other errors (`postToolUse`, `postToolUseFailure`,
  `errorOccurred`), `agentStop`, `preCompact`, and `subagentStart`/`subagentStop`.
  It never registers `preToolUse`: the hook reference says a `preToolUse`
  command that crashes or exits non-zero denies the tool call, and on Windows
  that denied every tool call Copilot tried. The same tool information arrives
  after the call. `FAIL_CLOSED_HOOK_EVENTS` (`src/constants.mjs`) lists every
  such event per agent, and a test holds what the installer writes against it.
- Copilot runs a hook's `bash` command on POSIX and its `powershell` command on
  Windows, so each hook entry carries both, rendered for its shell: PowerShell
  needs the `&` call operator before a quoted path and doubles a quote to escape
  it. The status line is different. Copilot 1.0.86 spawns `statusLine.command`
  with Node's `shell: true` - cmd.exe on Windows, `/bin/sh` elsewhere - which no
  document states and was read from its shipped status-line runner, so the
  status line keeps the double-quoted form cmd.exe runs. `tokenwatch doctor`
  executes every installed Copilot command through those shells in probe mode
  (`TOKENWATCH_PROBE=1`, which stores nothing), so a command that does not parse
  is reported before the agent runs into it.
- All three read the same `SKILL.md` format, but each loader decides on its own
  whether a file is a skill. Codex (checked against codex-cli 0.154.0 and the
  `openai/codex` source) requires a `description`, caps `name` at 64 characters
  (and `description` at 1024 from 0.95.0 through at least 0.140.0), skips a file
  whose first line is not `---` - a UTF-8 byte-order mark is enough - and only
  matches `$name` over `[A-Za-z0-9_:-]`. Before 0.95.0 it read user skills from
  `$CODEX_HOME/skills` alone. It lists skills within "2% of the model's context
  window, or 8,000 characters when the context window is unknown". The bundled
  skills are held to both this and the Agent Skills spec Claude Code follows by
  `test/skills.test.mjs`, and `tokenwatch doctor` reports installed shared
  skills that sit where Codex does not look or that it would skip.
- Copilot's auto router reports `model.id: "auto"` and names the model it chose
  in `display_name` ("Auto -> gpt-5.6-luna"). The adapter records the chosen
  model, because a router is not a model and model choice is a cost driver.

## Environment markers

Tokenwatch reads two kinds of variable that the agents set in the shells they spawn. Neither is
copied into the ledger as environment data.

- **Presence markers** (`src/host.mjs`, `MARKERS`) answer "which agent is this shell inside?" for
  `tokenwatch agents` and the reporting skills. Only their presence is used: Claude Code sets
  `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT`; Copilot CLI sets `COPILOT_CLI`,
  `COPILOT_CLI_BINARY_VERSION` and `COPILOT_AGENT_SESSION_ID`; Codex sets
  `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_THREAD_ID` and `CODEX_SESSION_ID`.
- **Session markers** (`SESSION_MARKERS`) answer "which session is asking?" for a hand-run
  `tokenwatch status`. The *value* is used, so a marker counts only once it has been checked to equal
  the `session_id` that agent's hooks and status line send:

| Agent | Variable | Status | How it was checked |
|---|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID` | verified 2026-09-24 (Claude Code 2.1.282 in the live test, Linux) | A real session's Bash tool saw the same value the session's hooks and status line stored, and `claude -p --output-format json` reported. A subagent's shell carries the parent's value. |
| Copilot CLI | `COPILOT_AGENT_SESSION_ID` | not verified; not read | - |
| Codex CLI | `CODEX_THREAD_ID`, `CODEX_SESSION_ID` | not verified; not read | - |

Until a marker is verified, `status` for that agent falls back to the most recent session and says
so in `session_scope.basis` (intent 15). Verifying one is a single dated entry in `SESSION_MARKERS`.

## Primary documentation

### Anthropic / Claude Code

- Hooks: https://code.claude.com/docs/en/hooks
- Status line: https://code.claude.com/docs/en/statusline
- Agent skills: https://code.claude.com/docs/en/skills (frontmatter follows the
  Agent Skills spec, https://agentskills.io/specification)
- Settings: https://code.claude.com/docs/en/settings

Legacy Anthropic documentation paths may redirect from:

- https://docs.anthropic.com/en/docs/claude-code/hooks
- https://docs.anthropic.com/en/docs/claude-code/statusline

### OpenAI / Codex CLI

- Codex documentation index: https://learn.chatgpt.com/docs
- Configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Advanced configuration and observability: https://learn.chatgpt.com/docs/config-file/config-advanced
- Agent skills: https://learn.chatgpt.com/docs/build-skills
- Open-source CLI repository: https://github.com/openai/codex (skill loading:
  `codex-rs/skills/src/parser.rs`, `codex-rs/ext/skills/src/host_roots.rs`)

The `developers.openai.com/codex/…` paths used until 2026-08-22 now answer with
a permanent redirect to the pages above.

### GitHub / Copilot CLI

- Using Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview
- Hooks reference (entry fields, per-platform shells, fail-closed events): https://docs.github.com/en/copilot/reference/hooks-reference
- Using hooks with Copilot CLI (file locations, PowerShell 7 on Windows): https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
- Customizing Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot
- Agent skills for Copilot CLI (directories, `/skill-name`, `/skills list`): https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- GitHub Copilot documentation: https://docs.github.com/en/copilot

### Session files (read only by `tokenwatch import`)

None of the three agents documents its session-file format, so these are
**undocumented; shape recorded**. The evidence for each mapping is a probe
date and an agent version, not a documentation link. Each shape was read from
this machine's files as key paths and value types only.

| Agent | Files | Mapping | Probed |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`: one line per assistant message part; `message.id`, `message.model`, `message.usage.*`. `timestamp` is stamped when the message completes, which can be after the status line's last render of that turn (measured 2026-09-25, intent 06 live test) | `src/import/mappings/claude.json` (`claude-jsonl-1`) | 2026-09-25, Claude Code 2.1.282 |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl`: one `token_usage_record` per response; `session_meta` and `turn_context` headers; `token_count` running totals | `src/import/mappings/codex.json` (`codex-rollout-1`) | 2026-09-25, Codex CLI 0.154.0 |
| Copilot CLI | `~/.copilot/session-state/<id>/events.jsonl`: `session.start`, `model.model_call_success` for some requests, `session.shutdown` with the session's totals | `src/import/mappings/copilot.json` (`copilot-events-1`) | 2026-09-25, Copilot CLI 1.0.86 |

A user whose agent changed format can keep a repaired mapping beside the ledger
(`tokenwatch import <agent> --keep-mapping <file>`, intent 19). It outranks the
bundled one for that user, `tokenwatch doctor` names it, and `--export-mapping`
prints it to share. The bundled mappings above stay the reference each repair
names in `evidence.repaired_from`.

## Installer policy

The installer follows four rules:

1. use a dedicated hook entry or file, and never register a hook event whose
   failure blocks the agent;
2. do not replace a Codex notifier without `--force`; an existing status line is
   composed by default, which keeps it running beside Tokenwatch's, and replaced
   only with `--force` (`--no-compose` leaves it alone);
3. record only the prior value needed for reversible uninstall, and edit settings
   files in place, so uninstall returns an untouched file to its exact bytes. Copilot
   CLI's settings file is read as JSON with comments. Claude Code's is strict JSON:
   measured on Claude Code 2.1.282, a settings file with a `//` or `/* */` comment
   is ignored whole (its hooks never run), while a byte-order mark is accepted. So
   install refuses a Claude settings file that holds a comment, rather than report
   hooks that will not run; uninstall still removes Tokenwatch's entries from one;
4. expose path overrides because enterprise packaging and preview channels often
   relocate settings.

Run `tokenwatch doctor` after an agent CLI upgrade. A schema change should fail
open for the coding agent: hooks ignore collector errors, while diagnostics make
the missing data visible.
