# Known limitations

- Codex CLI 0.160.0 was integration-tested on Linux on 2026-10-03 against a
  local Responses API fixture, using JSON and protobuf OTLP logs. Exact token
  counts, turn notifications, notifier forwarding, prompt privacy and uninstall
  restoration passed (`npm run smoke:codex`). This is not a production provider
  or interactive TUI test. Codex remains unverified on other operating systems,
  as does any agent on macOS, where only Tokenwatch's own test suite runs (in CI).
  Claude Code and GitHub Copilot CLI were run hands-on on Linux and Windows;
  `docs/support-matrix.json` records what each run covered and what it did not.
- Agent interfaces do not expose identical metrics. A lifecycle stop event is
  not assumed to be a billing event.
- `tokenwatch import` fills in history from an agent's session files, and that
  history is tokens only. Imported rows carry no provider cost: the session
  files hold none, except Copilot's AI units and premium requests. A session
  live capture already recorded, or one with a live state file, is skipped
  whole, so an import never counts a session twice. A session still in
  progress when you import is skipped the same way once live capture has seen
  it. Copilot imports one row per session (its last shutdown summary), because
  its per-call records cover only some requests. That summary is the whole
  session, including any part before `--since`. The session-file formats are
  undocumented, so each mapping records the agent version it was probed on.
  When a format changes, `--check` shows the new shape and the import stops
  rather than guessing.
- For Codex, live capture (OTLP through `tokenwatch-codex`) can record a
  request that the rollout file has no response for: measured once per
  wrapper session on this machine, an input-only request with no output and
  no cached tokens. The response itself matches field for field, so the
  overlap check reports that session's input total as a `mismatch`, and a
  Codex import next to live-captured sessions needs `--accept-unverified`.
  Its rows are then marked unverified. Which side is right about that request
  is not known.
- `verified` tolerates a mismatch on a session's first or last compared
  turn. Live capture starts and stops part-way through a session, so the turn
  at either edge can hold more or less than the transcript's; such a mismatch
  is counted in `boundary_mismatches` and does not decide the result. Any
  mismatch in between does. So `matched` can be lower than `turns_compared`
  in a verified import.
- A mapping repaired by `tw-import-history` is found from the files' shape
  alone: a renamed or re-nested key, or a new file-name pattern. A renamed
  record-type value (`type: "assistant"` becoming something else) cannot be
  seen in the shape, so it is not repaired. The skill says so and offers a
  values-free issue report. An import with no live capture to compare with
  (a fresh install, plain `codex`) stays unverified whatever else agrees. A
  repaired mapping's rows are undone with `--undo <its id>` before another
  mapping imports the same history, or it is counted twice.
- An import records its plan before its first row. If it stops before it can
  record a count - killed, or a disk that fills and stays full, so the record
  cannot be rewritten either - `doctor` counts that run's rows in the ledger
  by its run id and reports that number, or that none are there. It reads a
  ledger of up to 64 MiB for this; above that, or when the ledger cannot be
  read, it can only repeat the plan ("up to N ... may have been written").
- `tokenwatch import <agent> --undo` rewrites the ledger. It removes only
  `<agent>`'s imported rows and marks only `<agent>`'s runs undone, and it
  refuses a mapping or run id that only another agent's history carries,
  naming the command that would remove it. It first flushes any turn still in
  flight into the ledger, so the rewrite keeps it. It refuses while a live
  turn is pending, or when the ledger grew since it was read, and warns when
  the file changed after the swap. A row a live agent appends in the instant
  between its last check and the swap can still be lost without a warning.
  Stop the agents before an undo. Every undo keeps the ledger as it was in
  `events.jsonl.bak-<time>` beside it. `--undo … --dry-run` writes nothing, not
  even that flush: it reads the in-flight turns from state and counts them as
  kept. It cannot foresee a refusal that depends on the moment of the real
  undo, such as a live turn arriving during it.
- Codex exact token collection requires OTLP export and the Tokenwatch receiver.
  This implementation accepts OTLP/HTTP JSON and protobuf logs; protobuf
  metrics are not implemented. The wrapper supplies its exporter through CLI
  configuration overrides and uses an independent port when the configured one
  is occupied. Without the notify relay, tokens are collected but notify turn
  boundaries are absent. Existing user-level notifiers require explicit
  `install --compose`; project-scope composition does not adopt them.
- Codex’s native footer is not command-backed, so Tokenwatch does not replace it.
- A provider may omit cost, cache lifetime, reasoning tokens, or turn IDs. The
  corresponding status field stays absent or `n/a`.
- The cache countdown is shown only when the provider reports a TTL. A
  configured `cacheTtlSeconds` is an assumption, never rendered on the status
  line as though it were measured. The audit's gap analysis uses the TTL the
  provider reported for each session and falls back to `cacheTtlSeconds` only
  for a session that reported none; its `ttl-gaps` finding says which it used.
  Where a session's TTL changed, a gap is judged against the latest TTL
  reported up to the end of the turn before it.
- Status-line cumulative cost needs two observations before a per-turn delta is
  known. The first observation is a baseline by design.
- The status line's `this reply` and `previous reply` come from a running total
  the store keeps in session state for each of a session's newest 50 replies
  that a prompt hook opened. A reply with no prompt hook behind it, one older
  than that, and any reply in a state file written before the total existed
  are summed from the live ring, which holds the session's newest 200 entries,
  idle renders and tool hooks included, so a long one can show less there than
  `analyze` does.
- A turn is one prompt and its whole answer, however many model calls it
  takes. Turn grouping is exact when a turn ID exists (Claude Code). Without
  one (Copilot CLI), the prompt hook delimits turns: every row of a session
  after a `userPromptSubmitted` and before the next belongs to that prompt,
  in time order. This relies on the prompt hook carrying the same session id
  as the status line; a hook without one delimits nothing. It is inferred from
  timing, not told: a call whose render reaches Tokenwatch only after the next
  prompt was submitted is counted in the next prompt's turn (period totals are
  unaffected). Where neither signal exists - hooks not installed, or a
  `--since` window that starts mid-reply, whose first calls have their prompt
  hook outside the window - each row is its own turn (for Copilot, one model
  call), and `analyze` reports how many in `undelimited_turns` rather than
  merging them by guesswork. Turns are derived when the ledger is read, so a
  ledger recorded before this rule is regrouped too.
- A status-line render with no model call behind it is not a turn. Claude Code
  gives `/status`, `/cost`, `/context`, the render after `/compact` and the
  render before the first prompt a prompt id of their own; a group made only of
  such readings, backed by no prompt hook, that moved no cost or billing units
  and repeats the previous gauge is counted in `render_only_readings`, kept as a
  context reading, and left out of every turn count and per-turn figure (the
  rule is in `docs/event-schema.md`). It is inferred from what moved, not told:
  a real prompt that failed before it cost anything is still a turn only
  because its `UserPromptSubmit` carries the same prompt id, and a zero-cost
  render whose gauge changed is still counted. The first reading of a session
  has nothing to compare with, so one with no cost is treated as a baseline
  render; with no prompt hook and no earlier render in the period, a first
  reply whose cost is only that baseline is left out of the turn count, as its
  cost already is. The status line applies the same rule: such a render is
  never the reply in flight, the previous reply, or a slot in
  `averagingWindow`.
- A status line re-renders many times per turn, so its token counters are gauges
  describing the latest call. They are tagged `basis: "sample"` and are reported
  as distributions, never summed into a period total. Records written before this
  tag existed are inferred from their source.
- The final turn of a session stays buffered until the next prompt, a session-end
  hook, or the next `agents`, `analyze`, `export` or `repair`, which flush it to
  the durable ledger before reading.
- Where `~/.tokenwatch` can be read but not written - Codex's default sandbox, a
  read-only mount - that flush is skipped rather than failing the command
  (`tryFlushPendingTurns`, `src/store.mjs`). The in-flight turn is still included,
  read from pending state in memory, and the output says so: a `degraded` field
  in JSON, a `note:` line in text, and a stderr line for `export`. The turn stays
  pending until a run that can write flushes it. `status` handed a payload it
  cannot record renders it anyway and says it was not recorded - while that
  lasts, nothing is being collected. Codex's documentation does not say whether
  its sandbox can always *read* `~/.tokenwatch`; the failure observed on Windows
  was on the write. To let Codex write it instead, add the directory to
  `sandbox_workspace_write.writable_roots` (see `INSTALL.md`, Codex CLI
  specifics).
- JSONL writes are append-safe. The compact state snapshot is written under a
  per-session lock, but a hook waits at most 2 s for it and a status render 1 s:
  under a stall that keeps another process holding the lock longer, the event is
  still recorded, without the lock, and that write can then lose an update to
  the live state, its own or another's (see the next item). No update is lost
  only while every write gets the lock within its wait. `tokenwatch repair`
  rebuilds the subagent counts from the ledger when they drift, and resets the
  count `doctor` reports.
- A session state file that is truncated or otherwise unreadable (a full disk,
  an interrupted copy) is not repaired or replaced automatically. The store
  cannot load it, so that session's hooks record nothing more - silently, since
  hooks fail open - and `agents`, `analyze`, `export` and `repair` stop on it.
  `tokenwatch doctor` names each such file (`session-state:unreadable`) and
  leaves it alone; moving it aside lets the session record again, with its
  running totals restarting from a new baseline.
- Several agent sessions commonly share one installation and one state file.
  Per-session values - the recent ring, pending exchanges, subagent tallies,
  cumulative-cost baselines - are keyed by session, and the status line scopes
  itself to the session it is rendering. Each session keeps its own state file,
  so concurrent sessions have one writer each and cannot overwrite one another;
  only the append-only ledger is shared. That removes contention *between*
  sessions. *Within* one, hooks fire in the same instant (two subagents launched
  together are two `SubagentStart` hooks at once), and each reads, changes and
  rewrites the state file, so the file is guarded by a lock beside it
  (`sessions/s_<hash>.lock`, `state.lock` for events with no session id): the
  writes of one session are applied one after the other. The wait is bounded,
  because a hook must never hold up the agent: after 2 s (well inside the 5 s
  timeout Tokenwatch installs its hooks with; 1 s for a status render) the event
  is stored without the lock, as every event was before it existed, and the
  ledger row is appended either way. Only then can two writes still race, the
  loser's update to the live state being overwritten rather than merged; each
  such write is counted, and `tokenwatch doctor` reports the count since the
  last `tokenwatch repair` (`session-state:unlocked-writes`). The count is kept
  in the state file an overlapping write can overwrite, so it is a lower bound.
  A lock can outlive its write: a hook the agent killed at its timeout, or a
  status render Claude Code cancelled, leaves its lock file behind, and it
  stays, legitimately, until that session's next write takes it over. That is
  at once where its process id can be checked (same machine) and shows it
  exited; otherwise after ten seconds, twice the hook timeout, so a hook still
  writing is never taken over. A takeover is made by one process at a time and
  never removes a fresh lock that took the stale one's place. A lock found in a
  data directory this process cannot write (a read-only mount, Codex's sandbox)
  is not waited for: the write is refused at once, as it would be anyway. A
  report that finds a session's lock busy does not flush that session's
  in-flight turn, since two flushes could append it twice; it includes the turn
  from memory, counted once even if the lock's holder has just appended it, and
  a later report flushes it.
- That per-session scoping is exact for the status line, which always pipes its
  own session id on stdin. `tokenwatch status` run by hand picks its session in
  this order: the piped payload's id; `--session <id>`; the agent's own session
  id from the environment, for agents whose variable has been checked against a
  real session; and only then whichever session last wrote to this machine's
  state (`mostRecentSession`, `src/store.mjs`). Of the environment variables,
  only Claude Code's `CLAUDE_CODE_SESSION_ID` is verified (checked 2026-09-24);
  Copilot CLI's and Codex's candidates are not read until they are, so a
  hand-run `status --agent copilot` or `--agent codex` without `--session` still
  falls back. The fallback is exact only while one session is active: with
  several open it is whichever last re-rendered, possibly another agent's. It is
  no longer silent - `status --json` carries `session_scope.basis`
  (`stdin`, `option`, `environment:<VAR>`, `most_recent_fallback` or `unknown`)
  and `session_scope.state_found`, and the text output adds a `note:` line under
  the fallback. A `--session` value that is not a usable id reports nothing
  rather than another session's figures.
- Copilot CLI reports no currency at all, so its cost fields stay empty and the
  status line shows AI units and premium requests instead. Those are the
  provider's own units; they are not dollars and no rate converts them here.
- Codex reports tokens only through OTLP, so a Codex session run outside the
  `tokenwatch-codex` wrapper records turn boundaries and structure but no token
  counts. Codex exposes no context-window figure over OTLP, so that field stays
  absent for Codex.
- Copilot's token counters are session-cumulative, so the first render of a
  session is a baseline and carries no usage, exactly as the first cumulative
  cost snapshot does. If the provider restarts a counter mid-session, the
  movement across the restart is discarded rather than reported as a call.
- Host-agent detection reads environment markers each agent sets for a spawned
  shell command, confirmed for all three by actually running `codex exec` and
  `copilot -p` (not `--help`, which loads no config and proves nothing) and
  inspecting the real environment - `env | sort` inside the sandbox, not
  documentation. A version upgrade could rename these; when none of a marker
  group is present, `tokenwatch agents` reports the host as unknown rather than
  guessing. If one agent is launched from inside another - Codex run from a
  Claude Code shell, for instance - the outer agent's markers are still ambient
  in the inner one's environment and win by list order, which is wrong for that
  nested case specifically. Set `TOKENWATCH_AGENT` to settle either situation -
  except inside Codex, which by default strips every variable whose name
  contains `KEY`, `SECRET` or `TOKEN` from the commands it runs
  (`shell_environment_policy`; `populate_env` in
  [codex-rs/protocol/src/shell_environment.rs](https://github.com/openai/codex/blob/53446f90a56692dede3c8f413e8d486a6adb77b5/codex-rs/protocol/src/shell_environment.rs)),
  so a `TOKENWATCH_AGENT` exported before starting Codex does not reach them.
  The wrapper's own marker is named `TW_CODEX_WRAPPER` for the same reason.
  `tokenwatch agents` inside Codex reports whether that marker arrived; a
  missing marker means a plain `codex` launch, or a `shell_environment_policy`
  that filtered it. Neither has been checked inside a real Codex session yet.
- `tokenwatch doctor` flags a skill directory that mentions `tokenwatch` but is
  not part of the current bundle or install record - typically a renamed or
  removed skill whose old entry fell out of an install-state record written
  before per-skill tracking existed. It is reported, never deleted
  automatically: the destination directory is shared with anything else placed
  there, and this tool only ever removes what its own records say it installed.
  The same holds for a skill backup in `backups/skills/` that no install record
  names any more (`skill-backups:orphaned`), such as the first backup after two
  forced installs over a skill edited twice: it is reported by file name and
  left for you to remove.
- `tokenwatch doctor` judges collection from the ledger over the last seven
  days, never reaching back before the install, and reads at most the newest
  8 MiB of it so it stays cheap. An installed agent with nothing recorded is
  reported only after an hour, because Tokenwatch cannot tell "not used yet"
  from "used and not recorded"; the warning says both. The Claude status-line
  precedence check reads `.claude/settings.local.json`, `.claude/settings.json`
  and `~/.claude/settings.json` for the directory `doctor` runs in (or the
  project a project-scope install names). It does not read managed settings or
  a `claude --settings` override, and it does not scan other projects, because
  the list of them lives in Claude Code's private `~/.claude.json`. Copilot
  CLI's settings layering is not checked until it is verified against primary
  documentation; its collection line still reports hooks without samples.
- `doctor`'s `otlp-receiver` line asks the configured port for the receiver's
  `/health` answer from a short-lived child process, so the check stays
  synchronous and bounded (about a second when something accepts the
  connection and never answers). It connects only when the configured host is
  loopback, and reports rather than checks a port of 0. It sees whether a
  receiver is running at the moment `doctor` runs - not whether one was running
  during the Codex session being asked about. It is shown only where Codex is
  installed.
- The Codex notify relay keeps `codex-relay.json` beside the state files: the
  time of its last recorded turn and its last 20 failures, each with the stage,
  where the payload came from, and the error's class and code, never its
  message. It is rewritten on every Codex turn without a lock, so two sessions
  ending turns at the same instant can lose one entry. Where the data directory
  cannot be written, the relay cannot record its own failure either, and it
  does not write one anywhere else; `doctor` then reports no relay run at all
  since install (`relay-not-running`) and names that as one of two causes.
- How Codex runs `notify`, read from its source at commit
  [`53446f9`](https://github.com/openai/codex/tree/53446f90a56692dede3c8f413e8d486a6adb77b5)
  (2026-09-24), since the configuration reference does not say. Codex starts the
  command itself, as a direct child process with no shell: the configured array
  is the program and its arguments, and the JSON payload is appended as one
  final argument
  ([codex-rs/hooks/src/legacy_notify.rs](https://github.com/openai/codex/blob/53446f90a56692dede3c8f413e8d486a6adb77b5/codex-rs/hooks/src/legacy_notify.rs),
  `command_from_argv` in
  [codex-rs/hooks/src/registry.rs](https://github.com/openai/codex/blob/53446f90a56692dede3c8f413e8d486a6adb77b5/codex-rs/hooks/src/registry.rs)).
  Consequences for the Windows run that recorded no Codex events:
  - It is not sandboxed. The relay runs with Codex's own rights and an
    environment captured when the session started, not inside the sandbox that
    confines the agent's shell commands, so the `EPERM` those commands hit is
    not expected here. Unverified on Windows itself.
  - Its stdin, stdout and stderr go to the null device, so the relay can report
    nothing on screen; hence `codex-relay.json`. Codex does not wait for it; a
    failure to start it becomes a `FailedContinue` hook result inside Codex,
    and whether Codex shows that anywhere was not checked.
  - The argument is quoted by Rust's `std::process::Command`, which on Windows
    encodes each argument by the convention `CommandLineToArgvW` and Node both
    decode ([Command::arg](https://doc.rust-lang.org/std/process/struct.Command.html#method.arg)).
    The installed line starts with `node.exe`, not a `.cmd` shim, so cmd.exe's
    different quoting is never involved and the JSON should arrive intact. If it
    does not, the relay now records a `parse` failure (the argument arrived
    mangled) or a `read` failure with no payload (none arrived).
  - The whole command line is bounded: 32,767 characters on Windows
    ([CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)),
    and 128 KiB for one argument on Linux (`MAX_ARG_STRLEN`,
    [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html)). The
    payload carries the turn's own prompts and the final reply, so a long turn
    can exceed it; Codex then cannot start the relay at all, that turn leaves no
    record anywhere, and nothing in Tokenwatch can see it. Other turns are
    unaffected.
  - The relay's path is written into `config.toml` as a TOML basic string with
    its backslashes escaped, and read back by value, not text (see intent 02 and
    `docs/high_level_architecture_tokenwatch.md`, risk area 2).
  What stays unverified without a Windows machine: whether Codex read the
  `config.toml` Tokenwatch wrote (a `CODEX_HOME` elsewhere), and whether it ran
  the relay at all. `doctor` now separates those cases - `codex-notify`,
  `codex-relay` and the `collection:codex` verdict - instead of guessing.
- Local prices go stale. Tokenwatch ships none and will not estimate with an
  incomplete pricing rule.
- Copilot CLI and other preview interfaces can change configuration paths or
  casing. Use path overrides and run `tokenwatch doctor` after upgrades.
- `doctor` runs installed Copilot commands only through shells present on this
  machine: Bash on POSIX, `pwsh` or Windows PowerShell on Windows for hooks, and
  `/bin/sh` or cmd.exe for the status line. That Copilot uses cmd.exe for the
  status line is read from Copilot 1.0.86's shipped code, not from its
  documentation, and a later version could change it; `doctor` would then show
  the status-line check passing while Copilot fails, until it is re-checked.
- `doctor` runs installed Claude Code commands through the shell Claude Code
  would use on this machine now: `/bin/sh` off Windows, Git Bash on Windows when
  installed, else Windows PowerShell (`powershell.exe`), and reports a shell
  that is not here as not checked. The probe proves Tokenwatch's own invocation
  of that shell parses the command and hands the status line its stdin; how
  Claude Code itself starts PowerShell is not documented, so it is not proven
  identical. On Windows those commands run the `node` found on `PATH`, not the
  one that installed Tokenwatch; `install` warns when they differ and `doctor`
  checks that a `node` is there. A path that Git Bash and PowerShell would read
  differently is refused at install; the realistic cases are a UNC path
  (`\\server\share\...`) and a project at a drive root (`C:\`), whose trailing
  backslash would escape the closing quote in Bash. The status-line probe
  reports how many bytes of its input arrived: a shell that re-encodes the
  payload (Windows PowerShell 5.1 can add a byte-order mark) is a warning, not a
  failure. None of this has been run on Windows yet.
- Structural byte counts show volume, not semantic usefulness or task
  difficulty. Model-routing and subagent recommendations remain hypotheses.
