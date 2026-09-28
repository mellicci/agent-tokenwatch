# Privacy and threat model

## Data boundary

Tokenwatch’s event store is intended to answer operational questions without
building a second transcript database. It persists:

- token components and cost observations;
- agent, model, event, session, and turn identifiers;
- context percentage and cache timing;
- lifecycle names such as compact or subagent stop;
- optional tool names and structural byte/count/duration metrics;
- a salted HMAC project identity.

It does not persist prompts, code, assistant messages, transcripts, local file
paths, shell commands, environment variables, tool arguments/results, or
arbitrary OTLP bodies.

The Codex notify relay's record, `codex-relay.json`, holds times, a fixed stage
name, where the payload came from, and an error's class and system code. It
never holds an error message, because a JSON parse error quotes the text it
failed on, and never the payload.

Two files beside the ledger are deliberately outside that guarantee, and both
are worth stating plainly rather than leaving to be discovered.

The **installation manifest** necessarily stores local configuration paths and,
only when required for reversible replacement, the prior status or notifier
value. When it composes with another tool's status line (the default since
intent 16) it also stores the other tools' status commands that Tokenwatch now
runs beside its own, up to four, the settings file it came from, the
shell to run it with and a hash of it, so that a render can run it and `doctor`
can tell when it has changed. That is the same kind of value as a prior status
line, in the same mode-600 file. For an agent settings file it also keeps the
file's hashes before and after install and the inverse of each span Tokenwatch
edited, so uninstall can restore the exact bytes; only a span Tokenwatch
replaced (a prior status line, a footer flag) carries any of the file's text,
never the rest of the file, which can hold credentials in `env`. A skill file
`install --force` replaces is treated the same way: it can be a customised
skill with a team's notes in it, so its text goes to an owner-only backup
(`backups/skills/` beside the manifest, mode 600 in a mode-700 directory,
written atomically and never through a symbolic link), and the manifest keeps
only its hash and the backup's path. Neither `install` nor `uninstall` prints
it. `uninstall` restores it only from a backup that is a regular file and still
hashes to what was recorded, then deletes the backup; otherwise it leaves the
skill as it is and warns, naming the files, never quoting either text. A backup
no record names any more is reported by `doctor` by file name
(`skill-backups:orphaned`) and never read or deleted by it. `tokenwatch paths`
prints the install records with the same reductions `install` applies.

The **experiments journal** holds prose you wrote: a hypothesis, a change, a
baseline, an outcome. Nothing inspects that text for content, because it is
yours and the tool has no business rewriting it. It is bounded rather than
filtered, at 500 characters a field with control characters removed, so a
field cannot forge structure in the rendered list. Two of the bundled skills
instruct an agent to read this journal, so treat what you put in it as
something a model will see, and do not paste a path or a credential into a
baseline.

`~/.tokenwatch` as a whole is a trust boundary this design relies on. It is
created mode 700 with its files mode 600, `doctor` reports if that has been
loosened, and everything in it, the ledger included, is readable and writable
by anything running as you.

Per-session state is filed under a hash of the session id, not the id itself:
`src/store.mjs:50 (sessionStateFile)` writes to `sessions/s_<hash>.json`. A
session id is supplied by the agent and can carry a file path or other
sensitive text; without the hash it would have ended up in `ls` output, backup
manifests, and cloud-sync indexes, all places a secret outlives the file it
came from.

A hand-run `tokenwatch status` can also take a session id from outside a
payload: `--session <id>`, or the agent's own session variable
(`CLAUDE_CODE_SESSION_ID`; `src/host.mjs`, `hostSessionId`). Such an id passes
the same `safeIdentifier` guard a stored id does before it is hashed into a file
name. It is used only to find that file and is never written anywhere. A value
the guard refuses, such as a path or a key-shaped string, is not echoed: the
output says only `rejected_session_id: true`, and the command reports nothing.

## An explicit history import

`tokenwatch import <claude|codex|copilot>` is the one command that opens an
agent's session directory: `~/.claude/projects`, `~/.codex/sessions` or
`~/.copilot/session-state` by default, or `import.<agent>.sessionDir`, with
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` honoured first. Those files hold the
user's prompts, the assistant's replies, file paths and tool output. Nothing
else opens them: no hook, status-line render, `doctor` check or `agents` call
reads them, and a test holds that to be true. The import runs only when someone
types it, or when the user invokes the one skill that runs it.

**The history-import skill (intent 19).** `tw-import-history` runs
`tokenwatch import`, and only after the user says yes. No skill reads a session
file. When an agent upgrade breaks a mapping, the skill has the user's own agent
repair it from what `--check` prints: key paths, value types and counts, which
paths resolve, and a diagnosis. That output never includes a value from the
files, so a renamed record-type value cannot be repaired, and the skill says so.

The skill forbids the agent to open, read, list or search a session file or
directory with its own tools, to pass the model anything from those files but
command output, and to edit code or a bundled mapping. **Those prohibitions are
instructions, not code.** The session directory is the agent's own configuration
directory, and Tokenwatch cannot stop the agent reading it. The skill gives the
agent no reason to, and a test pins each sentence. A user who wants a
code-level fence can add a `permissions.deny` rule for reads under the session
directory to their Claude Code settings. Tokenwatch documents this rule and
never writes it.

A repaired mapping is kept beside the ledger (`mappings/<agent>.json`) only
after `--keep-mapping` validates it. That refuses a secret- or path-shaped
string anywhere in it, and it refuses the bundled mapping's id, so the rows
stay distinguishable and undoable. `--export-mapping` prints a mapping to share
as data, under the same refusal. Neither flag opens a session file.

What it keeps is decided by a mapping, a data file that names where each number
lives in one agent's format. The mapping's shape is closed: its targets are the
token fields, billing units and a handful of identifiers, and it can express no
other field. What reaches the ledger is:

- token counts and billing units (numbers only);
- a session id, a response id and a model name, each kept only when it has an
  identifier's shape (letters, digits and `._:@/+-`, starting with a letter or
  digit, at most 160 characters, not secret-shaped). A value that fails this
  check is never cleaned up and kept. A session id that fails drops its whole
  record, and is counted. A response id that fails leaves the response keyed
  by its figures instead. A model name that fails is left out;
- the project path as the same salted HMAC live capture uses;
- a fixed `import` block: the mapping's id and version, the run id, and the
  result of the overlap check.

It never keeps or prints message text, a path other than as that HMAC, or the
error message of a line that did not parse. Lines are read one at a time and
bounded at 4 MiB, and an oversized or malformed line is counted, never quoted.
`--check` prints the files' shape as key paths and value types, never a value.
The session directory is printed once, as the user's own path, under
`--check` and `--dry-run`. `imports.json`, the run record beside the ledger,
holds counts, dates and ids, and no path.

Every row passes the same `makeEvent` allowlist and `assertPrivacySafe` guard
as live capture, through a writer of its own that touches no session state.
`tokenwatch import <agent> --undo <mapping id> [--run <run id>]` removes those
rows exactly, after a backup, and only `<agent>`'s: an id that belongs to
another agent's history is refused and removes nothing. With `--dry-run` it
writes nothing at all.

## Threats addressed

### Malicious or accidental hook payloads

Payload keys are not copied wholesale. Agent-specific adapters construct a new
allowlisted object, enforce maximum string lengths, and cap stdin at 2 MiB.
Hooks do not execute payload fields.

### Telemetry body exfiltration

OTLP log bodies can contain arbitrary text. Tokenwatch extracts only a small set
of numeric/identifier keys from structured bodies, never stores the body, caps
requests at 8 MiB, caps what a compressed body may expand to, and accepts
only an exact `application/json`, `application/x-protobuf`, or
`application/octet-stream` media type (`src/otlp-server.mjs`) - protobuf and
octet-stream are accepted for `/v1/logs` only, `/v1/metrics` takes JSON alone.
The receiver binds to loopback by default, and `doctor` warns when it is not.

### Dependency compromise

There are no runtime or development package dependencies. Tests use Node’s
built-in test runner.

### Settings corruption

The installer edits agent settings files in place, changing only the spans its
own keys need and leaving comments and formatting as they were; it uses a
dedicated Copilot hook file, marks its own Codex TOML block with comments, and
removes only exact commands/content installed by Tokenwatch. Every edit is
re-parsed and must hold exactly the intended value, or nothing is written. A
settings file it cannot edit safely is refused by name, never quoted and never
rewritten. An existing status line is composed by default (run beside
Tokenwatch's); `--no-compose` leaves it alone and `--force` hides it. Composing
and hiding both record the prior entry, and `uninstall` restores it.

### Reading another tool's configuration

`doctor` and `install` read Claude Code's settings-precedence chain to find
which file's `statusLine` will actually run, because a free slot in the file
Tokenwatch wrote says nothing when a higher-precedence file also sets one
(`src/claude-settings.mjs:30`, `claudeSettingsChain`). The check extracts only
whether a `statusLine` is set and whether one of its shell words runs Tokenwatch
(`classifyStatusLineCommand`); the message
that names the shadowing file never quotes the other command, which can hold a
path or a secret of its own (`src/claude-settings.mjs`,
`statusLineShadowMessage`). `~/.claude.json`, which could name every project
Claude Code has opened, is deliberately not read at all, on the same principle:
reading another tool's private state to be more helpful is a trade this project
declines.

### A composed status command

A composed install makes Tokenwatch run other programs on every status render:
the status commands the agent was already running, up to four, in the order
they were adopted. Since intent 16 this is what a plain `tokenwatch install`
does when the slot is taken. One function, `composedStatusCommand` in
`src/installer.mjs`, decides what may run: only entries composed for exactly
the install key on the command line, each checked on its own, never one that
runs Tokenwatch (which would record every reading twice and could run itself),
within a length cap, through a shell kind recorded at install, and at most
`MAX_COMPOSE_COMMANDS` (4), a constant rather than a setting. An unreadable
install record means nothing runs. `TOKENWATCH_COMPOSED=1` in each child's
environment stops a wrapper the word check missed from composing again.

At project scope this can adopt a command from a project's committed
`.claude/settings.json`, which the Codex notify relay refuses to do for a
notifier. The difference is consent, and what would run anyway. The user ran a
project-scope `tokenwatch install` for that project, and without composition
Claude Code would run that same command there, behind its own workspace-trust
prompt (https://code.claude.com/docs/en/statusline). Tokenwatch's line, written
to the local file that outranks the shared one, runs it in the same place,
rather than hiding it. A user-scope install never adopts a project's line. The
payload reaches each other program on stdin only, never on its command line,
and nothing a program prints is stored.

`doctor` reports a changed or missing source command without running it or
quoting it. `install`, including `install --repair`, which re-reads those files
and adopts a line that replaced the slot, prints composed entries by hash and file
only, and leaves out the displaced line and the file's restore spans: the
status-line skill reads that output back into a model. Neither a hook nor a render ever
repairs: only the user, or a skill the user invoked, runs it.

### A doctor probe that could run a stranger's Tokenwatch

`doctor` executes each installed Copilot hook command and the Copilot
status-line command through a real shell, in probe mode
(`TOKENWATCH_PROBE=1`), to catch a shell parse failure before Copilot hits it;
probe mode makes `hook`/`status` print a marker and exit before loading config
or storing anything (`src/doctor.mjs:591`, `probe`). That promise is kept only
by the exact CLI that defines it. Run once against a real home whose hooks
still pointed at an older checkout, every probe reached that other CLI, which
ignored the environment variable and recorded a real, empty Copilot event per
hook into the real ledger (commit `7e54979`). `runsThisCli`
(`src/installer.mjs`) now gates every probe: a command is executed only
when it resolves to this installation, and a foreign one is reported as a
warning naming the reinstall that would make it checkable, and nothing is run
(`src/doctor.mjs`, `foreignCommandCheck`).

### Symlinked install targets

A project-scope install writes into a checkout that is not necessarily the
user's own; a committed symlink there can be chosen by whoever wrote the
repository. `installSkills` in `src/installer.mjs` checks each skill
destination with `lstatSync` before touching it and refuses a symlinked one
outright, rather than reading through it into the install record and stdout or
writing through it to overwrite and relax the mode of whatever it points at.
`test/security.test.mjs` demonstrates this against a symlink to `~/.ssh/id_rsa`.
A user-scope config file is written through a symlink deliberately, because
that path is one the user chose themselves - their own dotfiles-managed
settings file, for instance.

### CSV export formula injection

A model name, tool name, or other identifier could begin with `=`, `+`, `-`,
`@`, a tab or a carriage return, which a spreadsheet application may evaluate as
a formula on open.
`src/export.mjs` (`neutralizeFormula`, `csvCell`) prefixes such a cell with a
quote before it reaches `eventsToCsv`, so exporting the ledger cannot execute
code in whatever opens the file. An ordinary negative number is left numeric.

### Misleading cost calculations

No prices ship in code. Estimates require a local versioned table and complete
rates for every non-zero component. Provider-reported and estimated totals are
never combined. Cumulative provider cost uses a baseline before deltas enter
averages.

## Residual risks

- Session/model/tool identifiers can reveal operational metadata.
- A local attacker with read access can inspect the event and install files.
- Concurrent processes can race on the small state snapshot; JSONL events remain
  the source of truth.
- Agent configuration formats can change. Hooks fail open and `doctor` should be
  run after upgrades.
- HMAC project identities are stable within one installation; delete or rotate
  `projectSalt` to break correlation.

For stricter privacy, disable tool/model names and place `TOKENWATCH_HOME` on an
encrypted, access-controlled volume.
