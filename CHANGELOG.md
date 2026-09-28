# Changelog

## Unreleased

### History import

- **An import undo removes only the named agent's history, and its dry run
  writes nothing.** `tokenwatch import claude --undo codex-rollout-1` used to
  remove Codex's imported rows; an id that only another agent's history
  carries is now refused, naming the command that would remove it.
  `--undo … --dry-run` no longer flushes the in-flight turn into the ledger it
  is previewing: it reads that turn from state and counts it as kept.
  `--no-export-mapping` no longer exports, `--json=false` no longer prints
  JSON, and the `import` usage line lists `--undo` and `--run`.
- **`tokenwatch import <agent> --check` prints one JSON object on every path.**
  That includes a missing session directory (new diagnosis `no_directory`) and a
  mapping refusal, always with the same fields and `null` where a path measured
  nothing. `errors` is always a list; a mapping file that cannot be read or
  parsed is named `<file:unreadable>`, `<file:too_large>` or `<file:not_json>`
  instead of an empty list, which the `tw-import-history` skill read as "the
  mapping is valid".
- **An import run never claims rows it did not write.** A refused row stops the
  run before its plan is recorded; a run whose record cannot be removed or
  finished says so instead of crashing. For a run that recorded no count,
  `doctor` reports how many of its rows the ledger holds, and says "up to N"
  only when it cannot read a ledger of up to 64 MiB. `import.reason` accepts
  only what the overlap check writes (`no_overlap`, `no_live_tokens`,
  `mismatch`); existing ledgers read as before.

- **`tw-import-history` imports history, and repairs a mapping an agent
  upgrade broke, without reading a prompt.** The seventh bundled skill runs
  `tokenwatch import <agent> --check` and imports only after you say yes.
  When the check says the mapping no longer fits, your agent proposes a
  repair from key paths alone, never a value from the files. The repair is
  checked against live capture, kept only after you say yes, and it stops
  after three tries. `--check` now reports a single `diagnosis`, which of the
  mapping's paths the files still carry, and counts. `--keep-mapping` keeps a
  repaired mapping beside the ledger, where it outranks the bundled one and
  `doctor` names it. It refuses any secret- or path-shaped string and the
  bundled id. `--export-mapping` prints the mapping in use, to share as data.
  A renamed record-type value cannot be repaired from shapes, and the skill
  says so. Reinstall to receive the skill.

- **`tokenwatch import <claude|codex|copilot>` fills in the history from before
  Tokenwatch was installed, and only when you type it.** The command reads the
  agent's own session files through a bundled mapping and keeps numbers only:
  token counts, Copilot's AI units and premium requests, identifiers that have
  an identifier's shape, and the same hashed project as live capture. Every row
  is labelled imported, so `analyze`, rankings, comparisons and the CSV count it
  apart, and `doctor` and `agents` never take it as evidence that live capture
  works. Imported rows carry no provider cost.
- **An import writes nothing it cannot check.** Before writing, it compares its
  numbers with what live capture recorded for the sessions both saw. If that
  check cannot verify them, nothing is written unless you pass
  `--accept-unverified`, and then the rows say so. `--check` shows the files'
  shape (key paths and types, never a value) and the comparison, and
  `--dry-run` shows what would be written. Sessions live capture already
  recorded are skipped, a second run adds nothing, and
  `--undo <mapping id> [--run <run id>]` removes exactly one import's rows
  after a backup. On this machine, Codex's per-response records agree with its
  own running totals to the token in 17 of 18 real sessions *(corrected 2026-09-25 from "all 18": the live test found one session, with four compactions, whose per-response sum exceeds its final total)*. For one real Copilot
  session, its shutdown summary matches live capture exactly.

### Install and uninstall

- **Every remedy Tokenwatch prints names the scope of the install it
  concerns.** A settings-file refusal, `doctor`'s status-line, skill, Copilot,
  Codex-relay and executable hints, and the install-location warning used to
  say `tokenwatch install --agents <agent> --force` (or a bare
  `tokenwatch install --force`), which sent a project-scope user to a
  user-scope install and left the project uninstrumented. They are now built
  for the record's scope and agents, and `claude-status-line` ends with `Run:`.
- **A settings file refused at install stays refused, visibly.** The refusal is
  saved with the install; that agent gets no hooks, no status line and no
  skills (shared skills only when Codex or an unrefused Copilot reads them), and
  `doctor` reports it as `<install>:<agent>-settings` with the file, the reason
  and the command to run once the file is repaired. Uninstall works while the
  file is still broken, and removes the Copilot hooks folder install created.
- **Codex uninstall takes back exactly what install added.** A user-scope
  `~/.codex/config.toml` that links into a dotfiles repository stays a link
  through `uninstall` and `install --force`; a project-scope link is still
  never followed. A notifier displaced by `--force` is restored only while
  `notify` still holds Tokenwatch's relay; one changed or removed since is left
  and reported. The managed `[otel]` block is removed as exactly the span
  install appended, so leading blank lines, CRLF endings and a missing final
  newline come back byte for byte.
- **`install --force` no longer stores or prints the skill file it replaces.**
  A customised skill used to be saved whole in `install-state.json` and echoed
  on stdout, where CI logs kept it. Its text now goes to an owner-only backup
  in `~/.tokenwatch/backups/skills/` (0600 in a 0700 directory, never through a
  link), and the record keeps only its hash and the backup's path. Uninstall
  restores it only from a backup that still matches, then deletes it; otherwise
  the installed skill stays and `WARN skills:` names the files.
- **A refused Copilot is not told how to run the skills by a later install.**
  `install --agents codex --force` beside a Copilot whose settings file was
  refused printed Copilot's `/tw-<name>` usage line again, because the refusal
  it leaves out of the printed record was also left out of the usage lines.
  They are now read from the record as saved.
- **A forced Codex reinstall over a `notify` line changed since install says
  so.** The reinstall replaces the newer notifier and records it, so `uninstall`
  restores that one, and the notifier the first install replaced is no longer
  recorded. That used to happen in silence; it is now a `WARN settings:` line
  naming `config.toml`, quoting neither notifier.
- **An uninstall stopped by a broken settings file names the uninstall to run
  once the file is repaired,** for the install's own scope
  (`tokenwatch uninstall --scope project --project "<dir>"`), instead of a
  reinstall that would put Tokenwatch back.
- **`tokenwatch paths` prints install records the way `install` does:** another
  tool's composed status command by hash and file, without the status line,
  Copilot hooks file or Codex notifier a forced install displaced, and without
  the replaced skill text older versions kept inline in the record.

- **Tokenwatch now runs beside another status line by default, and keeps doing
  so when things change.** A plain `tokenwatch install` into a project whose
  status line is taken composes with it: the other line keeps running, and
  Tokenwatch records tokens from the first render. Before, the default left the
  other line alone with a warning and recorded nothing until you re-ran with
  `--compose`. `--no-compose` keeps the old behaviour, and `--force` still hides
  the other line; `uninstall` restores what any of them replaced. Up to four
  other lines are composed, printed in the order they were adopted, and one that
  hangs or fails leaves the others and Tokenwatch's rows intact. When another
  tool changes the status line later, `doctor` names one command,
  `tokenwatch install --agents <agent> ... --repair`, which keeps what was
  composed, adopts the new line, and changes nothing when nothing drifted; the
  status-line skill offers to run it. A status line whose path merely contains
  "tokenwatch" (a checkout named `agent-tokenwatch`, say) is now composed rather
  than refused as Tokenwatch's own. A wrapper template,
  `examples/statusline-wrapper.mjs`, covers status tools composition cannot run.
  An install record written by this version lists its composed lines; an older
  Tokenwatch reading it composes nothing and shows only its own rows. Needs a
  hands-on Windows test.

- **Installing Tokenwatch no longer reformats your agent settings or deletes
  their comments, and uninstall gives the exact file back.** Claude Code's and
  Copilot CLI's settings files used to be rewritten through JSON serialisation:
  formatting changed, an object Tokenwatch emptied disappeared (`"hooks": {}`),
  and a Copilot settings file lost its comments at install. Tokenwatch now edits
  only the spans its own keys need, keeping comments, formatting, key order,
  line endings, a byte-order mark and the file's mode. Uninstall restores the
  original bytes when the file is unchanged, deletes a file Tokenwatch created,
  and otherwise removes only Tokenwatch's entries and the containers it created.
  Uninstall now also keeps a user-scope settings file that is a symbolic link as
  a link. A settings file Tokenwatch cannot edit safely (it does not parse,
  repeats a key, nests too deep, is too large or is not an object) is refused for
  that agent by name and left untouched, and the other agents still install;
  previously a non-object file aborted the whole install. A Claude Code settings
  file with a comment is refused too: Claude Code ignores such a file whole, so
  hooks installed there would never run. The refusal is printed
  on stderr as a `WARN` line and the command still exits 0. `install --force`
  over a settings file it cannot edit leaves that agent exactly as installed, so
  repairing the file and running the command again finishes cleanly. The install
  record keeps hashes and the few spans Tokenwatch replaced, never the file.

### Doctor

- **`tokenwatch doctor` survives a corrupt session state file and creates
  nothing.** A truncated `sessions/*.json` used to stop it with
  `Cannot read JSON` and no report; each unreadable file is now named in a
  `session-state:unreadable` warning. Doctor no longer creates `config.json`
  (with its project salt) or the data directory on a machine where nothing has
  run yet, and reports a missing config as "not created yet; doctor used the
  defaults" rather than `ok`. `otlp-bind` judges loopback with the same rule as
  `otlp-receiver`, and `retention` ages the ledger at the instant doctor is
  given.
- **`tokenwatch doctor` reports a skill backup no install record names**
  (`skill-backups:orphaned`), such as the first backup after two forced
  installs over a skill you edited twice. Nothing else would ever restore or
  remove it. It is named by file, never quoted, and never deleted.
- **Doctor's other lines agree with a settings file refused at install.** The
  refused file's own line is `INFO` instead of `OK`, `collection:<agent>` says nothing
  is collected from that agent instead of "Run a session, then check again",
  and the shared-skills line no longer tells a refused Copilot to type
  `/tw-<name>`. Each points at `<install>:<agent>-settings`.

### Claude Code on Windows

- **Claude Code's Windows commands now run under PowerShell as well as Git
  Bash.** Claude Code runs hooks and its status line through Git Bash when it is
  installed and through PowerShell when it is not, which native Windows allows.
  Tokenwatch wrote every Claude command as a quoted Node path, a form PowerShell
  cannot parse, so a Windows machine without Git Bash would have recorded nothing
  from Claude Code while `doctor` reported healthy. Every Claude command on
  Windows is now `node` followed by double-quoted arguments, which both shells run
  the same way; a path either shell would read differently is refused at install,
  naming the character. `install` warns when the `node` on PATH is missing or is
  not the one that installed, and `doctor` now runs each installed Claude Code
  hook and status-line command through the shell Claude Code would use, checks
  that the status line receives its input, and resolves `node` on PATH. Existing
  Windows installs keep the old commands until reinstalled with
  `tokenwatch install --agents claude --force`. Commands on macOS and Linux are
  unchanged. Needs a hands-on Windows test.

### Status line

- **`tokenwatch status` run by hand now reports the session that asked, or says
  it could not.** Before, with no payload on stdin it silently showed whichever
  session last wrote to the machine, so with two sessions open a retrospective
  could describe the other one. It now takes the session from the piped payload,
  then from the new `--session <id>` option, then from Claude Code's
  `CLAUDE_CODE_SESSION_ID`, and only then falls back to the most recent session.
  `status --json` carries a `session_scope` object (`session_id`, `basis`,
  `state_found`) saying which of these applied, text output adds a `note:` line
  under the fallback, and the bundled skills read `session_scope` before
  presenting a snapshot as "this session". Copilot CLI's and Codex's session
  variables are not read until they are verified against a real session. A
  `--session` value that is not a usable id reports nothing rather than another
  session's figures.
- **New: `tokenwatch install --compose` runs Tokenwatch next to a status line
  another tool already owns.** Claude Code and Copilot CLI run exactly one
  status-line command, and it is Claude Code's only source of token and cost
  figures, so a slot taken by another tool meant either hiding it (`--force`) or
  recording nothing. `--compose` keeps the other line and installs a Tokenwatch
  command that reads the payload once, records it, hands the identical bytes to
  the other command, and prints that command's rows followed by Tokenwatch's.
  At project scope it composes with the status line in the project's shared
  `.claude/settings.json` that outranks Tokenwatch's, the case from the first
  Windows install, and only ever reads that file. `uninstall` restores exactly
  what was there. Each half fails alone: a missing, failing, slow or noisy other
  command never stops Tokenwatch recording or rendering. The other command is
  replayed through the shell its agent uses - `/bin/sh`, cmd.exe for Copilot on
  Windows, and Git Bash or else PowerShell for Claude Code on Windows, per its
  status-line documentation - and is killed on a timeout
  (`status.composeTimeoutMs`, default 1000) and when the agent cancels the
  render. It refuses a status line that already runs Tokenwatch, and
  `--compose --force` on a first install. `doctor` gains a `status-compose`
  check that reports when the other tool's command has changed since install,
  without running or quoting it. On Windows a timed-out or cancelled render stops the shell that ran the other command, but a program that shell started may keep running until it exits by itself. Needs a
  hands-on Windows test.

### Accounting and correctness

- **Fixed: reporting commands failed inside a sandbox that cannot write
  `~/.tokenwatch`.** `agents`, `analyze`, `export` and `repair` flush the
  in-flight turn into the ledger before reading it, and since the fix that made
  `agents` do the same, the command every reporting skill runs first failed with
  `EPERM` in Codex's default sandbox on Windows, until the user approved running
  it outside. The flush is now an optimisation, never a precondition: when the
  write is refused (`EPERM`, `EACCES`, `EROFS`) nothing is written, the in-flight
  turn is included from pending state in memory, and the report says which of
  the two happened - a `degraded` field in JSON, one `note:` line in text, and a
  line on stderr for `export`, whose output is the data itself. One function
  decides what a flush writes and what the read-only view shows, so the two
  cannot diverge; a test checks a read-only run against the writable run that
  follows it. Any other error is still raised. `status` renders the reading it
  was handed from the same reduction held in memory, and says it was not
  recorded. Two more writes on the same path were found while testing against a
  real read-only home: loading a config written by an older version rewrote it
  with the new defaults before every command, and a ledger that accepts an
  append beside a state directory that refuses the rewrite would take the same
  turn again on every report. Both are fixed. `tokenwatch repair` without
  `--dry-run` still needs a writable directory, since rewriting the ledger is
  its job.

- **Fixed: a missing session id silently collapsed every per-session meter into
  one shared bucket.** Cumulative cost, cumulative tokens and cumulative billing
  units are all keyed by agent plus session, and the key fell back to a literal
  `no-session` when the agent sent no session id. Two sessions of one agent then
  interleaved their running totals: each read as the other restarting its
  counter, and the diff spanned both. Measured on four readings from two
  sessions, that reported 9 against a true 4, with the status line as confident
  either way. A cumulative record with no session identity is no longer diffed
  at all - the turn loses its delta, exactly as the first snapshot of any
  session does, rather than gaining spend that never happened. The refusal is
  counted and `doctor` reports it, because the failure this replaces was silent
  and an agent renaming its session field is a plausible way to reach it.
  Not currently triggered: all 385 cumulative events in a real ledger carry a
  session id, but 7 events without one already exist, one of them from an agent
  that does report cumulative cost.
- **Fixed: the second ledger writer ran no privacy check.** `appendToLedger` has
  two callers. `storeEvent` guards its own write twice, once on entry and once
  after the mutating reducers; `flushTurn` writes a turn that has since been
  serialised to the per-session state file and read back, so nothing in the
  process saw what actually returned from disk. The guard is re-run there, and a
  failure drops the turn rather than writing it.
- **Changed: `retentionDays` now does something.** It was a documented default
  that nothing read, kept in sync with the documentation by a passing test. It
  stays advisory, because deleting months of history should be a sentence
  someone typed, but `tokenwatch prune --retention` acts on it, `doctor` warns
  when the ledger has outgrown the window, and a bare `prune` now names the
  configured value instead of only refusing.
- **Fixed: `main()` accepted an injected config and ignored it.** A test could
  pass a scratch config, believe it was sandboxed, and drive a destructive
  command against the caller's real `~/.tokenwatch`. Found by doing exactly
  that while adding the prune test above. A parameter that looks honoured has to
  be honoured.
- **Removed: two dead functions.** `truncate()` in the status-line renderer,
  which read like a defence against row overflow while doing nothing, and an
  unused protobuf builder in the OTLP tests. The overflow gap `truncate` appeared
  to cover is real and is now described where it sits, rather than implied by a
  function nobody calls.

### Security

Found by auditing the code against its own claims before a public release.
Every item below was reproduced against the shipped behaviour first, and each
has a regression test that fails without its fix.

- **Fixed (critical): a cloned repository could run commands on your machine.**
  `installCodex` recorded the `notify` argv it found in a project's
  `.codex/config.toml` even on the branch where it *declined* to install and
  told the user the file was "left unchanged". `priorCodexNotify` then scanned
  every install record with no scope filter and no check that anything had been
  installed, so a project-scoped record was handed to `spawn()` during an
  unrelated user-scope Codex turn. A repo carrying a committed `.codex/config.toml`
  therefore achieved arbitrary command execution on every later turn. Three
  changes: a prior notifier is recorded only when Tokenwatch actually displaced
  one, the relay carries `--install <id>` so a lookup can never cross
  installations, and the relay refuses an argv that points back at itself.

- **Fixed (critical): one malformed HTTP header killed the OTLP receiver.** The
  request path was built with `new URL(req.url, …req.headers.host)` outside the
  handler's try/catch, so `Host: [` threw an uncaught `TypeError` and
  terminated the process. Under `tokenwatch-codex` that process also supervises
  the user's Codex session. The path is now parsed from the request target
  alone, and the whole handler is guarded.

- **Fixed: `install --force` could stop Codex starting.** The TOML editing used
  `^key\s*=.*$`, which ends at the first newline, so an ordinary multi-line
  `notify = [` array was replaced on its first line only and the remaining
  elements were orphaned into invalid TOML. Codex then refuses to load its
  config at all — the exact outcome the code's own comment says must never
  happen. Replaced with a bracket-depth scanner that tracks strings and
  comments, refuses to edit a file it cannot parse, and round-trips a
  multi-line array byte-for-byte through install and uninstall.

- **Fixed: the privacy guarantee covered field names but never values.**
  `assertPrivacySafe` was a 21-name key denylist that never looked at a string,
  so a filesystem path, an API key, or a whole prompt sentence passed straight
  through in `session_id`, `model`, `event_name`, `tool_name` or `status`.
  Identifier values are now checked for credential prefixes, absolute-path
  shapes and prose, and a matching value is dropped while the rest of the event
  is still recorded. Checked against 2,180 distinct identifier values from a
  real 5,522-event ledger: none were affected.

- **Fixed: secrets could land in filenames.** Per-session state files were named
  after the agent-supplied session id, so whatever it contained appeared in
  `ls`, in backup manifests and in cloud-sync indexes. Names are now a hash of
  the session id; the previous name is still read once so a session spanning the
  upgrade keeps its cumulative-cost baseline.

- **Fixed: OTLP attributes bypassed the body allowlist.** Attribute keys and
  values were copied through unfiltered and preferred over the allowlisted
  body, so any local process could write arbitrary strings into the ledger
  through an unauthenticated loopback receiver. OTLP-derived identifiers must
  now match an identifier shape and are rejected rather than scrubbed.

- **Fixed: a gzip bomb could exhaust memory.** The 8 MB request cap counted
  compressed bytes and decompression was synchronous and unbounded. A 1 GB
  bomb now returns 413 in under a fifth of a second without the receiver
  stalling.

- **Fixed: a browser could post forged telemetry.** The content-type test was a
  substring search, so the CORS-simple `text/plain;charset=json` passed. An
  exact media type is now required, which forces a preflight that gets no CORS
  headers back.

- **Fixed: a partial install left changes nothing could undo.** Install state
  was written only after every agent succeeded, so a malformed config for the
  second agent aborted the run with the first agent's hooks already on disk and
  `uninstall` reporting nothing to remove. State is now persisted even when a
  later agent fails.

- **Fixed: atomic writes followed a planted symlink.** The temp path was the pid
  plus `Math.random` and was opened without `O_EXCL`, so a symlink left at that
  path was followed and its target overwritten and chmodded. Temp names now come
  from a CSPRNG and are created exclusively. Separately, a config file that *is*
  a symlink — the dotfiles pattern — is now written through rather than replaced.

- **Fixed: exported CSV could execute on open.** Cells beginning `=`, `+`, `@` or
  a tab are now prefixed so Excel, LibreOffice and Sheets treat them as text.
  A genuine negative number is left alone.

- **Fixed: error text echoed payload fragments.** `JSON.parse` messages quote
  roughly sixteen characters of the offending input, and `tokenwatch otlp serve`
  printed them by default. Only the error's type is reported now.

- **Changed:** `ensureDir` no longer chmods a directory it did not create, so
  installing no longer silently changes the permissions of `~/.claude` or
  `~/.codex`. `doctor` reports a loose Tokenwatch home instead of quietly
  tightening it.

### Cross-platform

- **Fixed: a source install could point every agent's hooks into a temporary
  folder.** Every hook and status line embeds the path of the installed CLI.
  `INSTALL.md` recommended `npm install -g .`, which installs a link to the
  source folder rather than a copy (a junction on Windows), and Node resolves
  that link before loading anything, so the hooks ran the script inside the
  source folder itself. On the first Windows install that folder was in
  `%TEMP%`, so cleaning it up would have silently broken every agent at once;
  it was noticed by accident. `INSTALL.md` and the README now install from
  source by packing it (`npm pack`, then
  `npm install -g ./agent-tokenwatch-<version>.tgz`), which is a real copy, the
  same as installing from npm; `npm link` is kept for developing Tokenwatch,
  with the caveat stated. `tokenwatch install` now checks where the running CLI
  lives before writing anything and warns - in its result and on stderr, naming
  the safer command - when it was reached through a linked package folder or
  lives in a temporary or download folder. A git checkout is noted as `info`,
  because the maintainer develops from one. It warns rather than refuses,
  consistent with an installer that leaves conflicts alone with a warning
  instead of deciding. `tokenwatch doctor` reports the same for the running CLI
  and for the CLI embedded in each recorded install, and reports a recorded
  script that no longer exists as an error. Paths are compared
  case-insensitively on Windows, as project identity already is; the Windows
  cases are tested with Windows-spelled paths on every OS. **Needs a hands-on
  Windows test.**
- **Fixed: on Windows the Codex installer did not recognise its own relay.**
  It decided whether the existing `notify` line was its own by searching the
  raw `config.toml` text for its own path. TOML escapes backslashes, so the file
  held `C:\\Users\\...\\tokenwatch.mjs`, the search looked for
  `C:\Users\...\tokenwatch.mjs`, and it never matched. A reinstall then
  recorded Tokenwatch's own relay as the user's previous notifier, and
  `uninstall` put that relay back - so once the package was removed, Codex ran
  a missing script on every turn. Install, uninstall and the relay now read the
  `notify` array as TOML and share one rule for "this is our relay": an element
  that is this CLI's path, compared case-insensitively on Windows as project
  identity already is, or the `notify-relay` subcommand. The same reader
  replaces a regex that took a quoted word inside a TOML comment for an
  argument of the user's notifier. A record already written wrongly is inert:
  the relay refuses to run it, and `uninstall` or `install --force` drops it
  instead of restoring it. Found on the first hands-on Windows run; the
  regression tests build the Windows-form line explicitly, so they fail on
  Linux too. **Needs a hands-on Windows test.**
- **Fixed: `tokenwatch codex` hung forever when Codex could not start.** The
  OTLP receiver was closed only on the success path, and it keeps the event
  loop alive, so a failed spawn left the process wedged holding port 4318 —
  with the first Ctrl+C swallowed by a signal handler forwarding to a child
  that did not exist. This is the default experience on Windows, where npm
  installs Codex as a `.cmd` shim.
- **Fixed: `spawn` could not run a `.cmd` shim.** libuv's executable search
  tries only the bare name, `.com` and `.exe`, and never consults PATHEXT, so
  the documented `npm i -g @openai/codex` route failed with ENOENT on Windows.
  A new `spawnPortable` routes a non-`.exe` name through the command
  interpreter with per-argument quoting. **Needs a hands-on Windows test.**
- **Fixed: a missing prior notifier crashed the relay.** The spawned child had
  no `'error'` listener, so an uninstalled or renamed notifier — commonly a
  `.cmd` shim on Windows — produced an uncaught exception on every Codex turn.
- **Fixed: one project could be counted twice on Windows.** `path.resolve` does
  not canonicalise drive-letter case, so `c:\dev\proj` and `C:\dev\proj`
  produced different `project_id`s, different install keys, and made our own
  status line read as a stranger's. Identity comparisons are now case-folded on
  Windows only.
- **Fixed: Git Bash drive paths resolved to the wrong drive.** `/c/Users/me` is
  absolute to `path.win32`, so it normalised to `\c\Users\me` on whatever drive
  happened to be current. It is now converted on Windows and left alone on POSIX.
- **Fixed: a replace-by-rename could fail transiently on Windows.** A virus
  scanner or indexer holding a brief handle made the write fail, and the hook
  and status paths swallow write errors, so it surfaced as unexplained gaps in
  the ledger. The rename now retries briefly.
- **Added:** `doctor` checks that the Node executable baked into each installed
  command still exists. Under nvm, fnm or volta — near-universal on macOS —
  switching or removing a version silently stopped all collection while
  `doctor` reported all-green.
- **Fixed:** `tokenwatch doctor` always exited 0. The entry point discarded the
  exit code the command returned, so a health check could never detect a problem.
- **Changed: a byte-order mark in front of a payload is dropped on purpose.**
  Windows PowerShell 5.1 can pipe text with a UTF-8 BOM, Node's stdin decoding
  keeps it, and `JSON.parse` rejects it, so a hook fed that way would have
  recorded nothing and, failing open, said nothing. It already worked, but only
  because the stdin reader happened to `trim()`; `parseJsonPayload` now drops
  the mark itself, which also covers `--payload`, and both routes have a test.
- **Fixed: four tests could only fail on Windows, while the code they test was
  right.** The first hands-on Windows run passed 151 of 156; the relay case is a
  real defect, tracked separately, and the other four were written after CI last
  ran on Windows. Two Codex-wrapper cases required ENOENT for a missing program,
  which POSIX raises but Windows cannot: the name goes through `cmd.exe`, which
  starts, reports the program as not recognised, and exits non-zero. They now
  expect that exit code on Windows, and a new case runs the same started-then-
  failed child on every platform. The wrapper's port-release check now binds
  the port itself, since re-running the wrapper proved nothing - it treats a
  held port as a receiver already running. Two symlink cases are skipped, with
  the reason printed, only where the account cannot create a symlink at all
  (Windows without Developer Mode or elevation), and the skill-destination case
  compares the target's mode with itself rather than with `0o600`, which Windows
  reports as `0o666`. **Needs a hands-on Windows test.**

### Repository

- **Added: a dated platform and agent support matrix.** The README said
  Windows was "tested by CI but not yet by hand" and nothing about macOS, WSL,
  or which agents had ever been seen working where. Its new *Platform and agent
  support* section has one row per agent and one column per operating system,
  and every cell states its evidence: hands-on verified with the agent version
  and date, tested in CI with the date of the last green run, provisional,
  failed hands-on with fixes not yet re-verified, or untested. Nothing claims
  more than was observed: Codex CLI is provisional everywhere, macOS has only
  CI behind it, the Windows cells record the 2026-09-23 run and the fixes above
  that are still marked "Needs a hands-on Windows test", and the section says
  CI has not run since 2026-09-21. The table is generated from
  `docs/support-matrix.json` by `scripts/support-matrix.mjs`; a docs test fails
  when the README disagrees with the data file, or when a cell claims a level
  without the version or date it needs. Updating it is now a release-checklist
  item in `docs/publishing.md`.
- **Changed: the "no status line" troubleshooting entry leads with the likely
  cause.** `INSTALL.md` now starts from a project-level status line outranking
  the user-level one, which is what the first Windows install hit, shows the
  two `doctor` lines that identify it (a test renders them from the code, so
  the guide cannot quote wording `doctor` no longer prints), and gives both
  ways out: a project-scope install, or a wrapper that runs both status lines.

- Added CodeQL, OpenSSF Scorecard, and a tag-driven publish workflow using npm
  provenance; `npm audit` now runs in CI.
- Added a code of conduct, issue and pull-request templates, and Dependabot for
  GitHub Actions.
- `SECURITY.md` names a real reporting channel instead of a placeholder.
- README leads with the published package name, carries status badges, and no
  longer advertises the old `/token-cost-*` skill names.
- Removed a stray `hello_world.py` that had been committed by accident.

- Fixed: `analyze --group-by` never looked at billing units at all, so a period
  with no USD - any Copilot-only window - fell back to plain turn-count
  ordering with nothing rankable by measured share. `groupTurns` now sums
  `billing` per turn the same way it sums cost; `rankGroups` sorts by AIU when
  a period has no USD but does have billing data (`ranking.ranked_by` says
  which happened), and reports `billing`/`billing_share` per group alongside
  the existing cost fields. Verified live: Copilot's dominant model went from
  "92.9% of turns, unrankable by spend" to a measured "100% of AIU and premium
  requests" - a real driver, not an activity count standing in for one.

- Fixed: Copilot's context-window readings were almost entirely dropped from
  `analyze` output - 1 of 66 genuine observations survived on the real ledger.
  Two compounding causes: an event with no usage at all (a baseline render) was
  discarded before it could become a turn, losing its context reading with it;
  and `context_samples`, the existing token-count field, is deliberately gated
  on `basis: "sample"` to avoid double-counting an increment turn's tokens
  against `aggregate.tokens` - correct for tokens, but it also silently
  excluded that turn's unrelated context-percent reading. New
  `aggregate.context_percent_samples` (median/p95/max/latest, in percent)
  reports every turn's context regardless of basis; `context_samples` keeps its
  existing, narrower, correct behavior for token counts. Surfaced by comparing
  a live Copilot CLI's own retrospective output against the raw ledger.

- Documented and verified the real single-command install:
  `npx tokenwatch install --agents all --scope user`, run from the source
  directory, needs no prior `npm install -g` step and no shell-chaining
  operator (`&&` is unsupported in Windows PowerShell 5.1). Verified against a
  simulated from-scratch machine: isolated home, isolated destination paths, no
  global link, `npx` cache cleared first.
- Removed an unverified INSTALL.md claim ("run this from PowerShell rather than
  CMD") that did not hold up under inspection - the installer's output depends
  only on `process.platform`, not which Windows shell invoked it. Replaced with
  an honest boundary: CI verifies the installer's own file generation on
  `windows-latest`; it cannot verify that Claude Code, Copilot CLI, or Codex CLI
  then execute the generated commands correctly on a real Windows machine,
  since CI does not run those three binaries.

- Fixed: `docs.test.mjs` and `skills.test.mjs` matched checked-out Markdown with
  a bare `\n`, which only breaks on a Windows checkout - `actions/checkout` on
  `windows-latest` converts every text file to CRLF by default, and CI had been
  red on all three Windows jobs since these tests were added. Not caught by a
  local `npm run check` on Linux, only by checking CI directly.
- Added `.gitattributes` forcing LF on checkout for every text format in this
  repo, so this class of platform-specific breakage cannot recur - a Windows
  checkout is now byte-for-byte identical to a Linux or macOS one.

- Host-agent detection markers replaced with ones confirmed live, not guessed.
  The previous Copilot markers (`COPILOT_CLI_VERSION`, `COPILOT_AGENT_MODEL`,
  `COPILOT_SESSION_ID`) were never actually set by Copilot in a spawned shell
  command's environment - only read as optional external overrides - so
  `tokenwatch agents` reported every Copilot session as `host: unknown` from the
  day detection shipped. Real markers (`COPILOT_CLI`, `COPILOT_CLI_BINARY_VERSION`,
  `COPILOT_AGENT_SESSION_ID`; `CODEX_SANDBOX_NETWORK_DISABLED`,
  `CODEX_THREAD_ID`, `CODEX_SESSION_ID`) were found by actually running
  `codex exec` and `copilot -p` and inspecting the real environment a spawned
  shell command receives, then verified against the live CLIs, not documentation.

- Bundled skills renamed to a consistent `tw-*` prefix, and expanded from four to
  six:
  - `status-line-guide` -> `tw-explain-statusline`
  - `token-cost-audit` -> `tw-cost-audit-define-experiment`
  - `token-cost-retrospective` -> `tw-retrospective-overall`
  - `token-cost-coach` -> `tw-token-cost-coach`
  - new: `tw-retrospective-this-session` - a fast, narrow retrospective scoped to
    the session in progress, distinct from the period-level `tw-retrospective-overall`
  - new: `tw-cost-drivers-basics` - a concept primer covering prompts, tokens,
    turns, why input/output/cache are priced differently, and what a cache TTL
    does, for someone who does not yet have the vocabulary the other skills assume
  - Renaming a skill needs no installer change: `bundledSkills()` discovers skills
    by scanning the `skills/` directory, and a forced reinstall removes any
    previously installed skill no longer in the bundle before installing the
    current one.
- `tokenwatch doctor` flags a skill directory that mentions `tokenwatch` but is
  tracked by neither the current bundle nor the install record - a renamed or
  removed skill left behind by drift the installer's own bookkeeping cannot see,
  which this rename immediately surfaced on a machine whose install record
  predates per-skill array tracking. Reported, never deleted automatically.

- `tokenwatch agents` names the detected host agent and lists every agent with
  recorded activity, its session count, and the unit it reports in.
- The three reporting skills establish their host agent before reading numbers
  and scope every command to it. Invoked inside Copilot, they were reporting
  Claude's sessions, because they had `--agent claude` written into them.

- The subagent cost window is measured in whatever the provider meters in, so
  the share beside the subagent count appears for an agent that reports no
  currency instead of staying blank next to a perfectly good count.
- A status render that moves only the billing counter is no longer discarded as
  a duplicate of the one before it.

- Installing one agent no longer uninstalls the others. A scope keeps one record
  covering every agent, and a forced per-agent reinstall tore down all of them
  before installing the one named - removing the other agents' hooks and
  reverting their status lines. Adding an agent later is the documented path.

### Codex

- **Fixed: every instruction for running a skill used Claude Code's syntax.**
  The README, the install output and the skills' hand-offs to one another all
  said `/tw-…`, which Codex does not recognise; Codex takes `$tw-…` or its
  `/skills` list. `install` now prints each installed agent's own syntax, the
  README has a per-agent table, and every skill tells the model how to name a
  sibling skill in the host agent's syntax. Checked against codex-cli 0.154.0:
  after a user-scope or a project-scope install, Codex's model-visible skill
  list (`codex debug prompt-input`, rendered offline) holds all six. Codex reads
  `~/.agents/skills` only from 0.95.0 on.
- **Added: `doctor` says when Codex cannot see the shared skills.** It warns
  when they were installed somewhere Codex does not look (a `--shared-skills`
  override), or when an installed skill would be skipped by Codex's loader - no
  description, a name over 64 characters, or a byte-order mark in front of the
  frontmatter, which is enough for Codex to drop the file without a word. It
  reports and never rewrites. A test holds every bundled skill to both Claude
  Code's and Codex's frontmatter rules.
- **Fixed: `doctor` printed `OK otlp-bind` with no receiver running.** On the
  Windows machine where Codex recorded nothing, that line read as "the receiver
  is fine" while nothing listened on the port; it only ever checked that the
  configured host was loopback. `otlp-bind` now says it is the configuration,
  and where Codex is installed a new `otlp-receiver` line asks the port itself,
  with a `GET /health` from a short-lived child process: a Tokenwatch receiver
  running is `OK`, nothing listening is `INFO` ("Codex tokens are only captured
  while `tokenwatch-codex` is running", normal when Codex is not in use), and
  something else on the port is `WARN`, because `tokenwatch-codex` takes a port
  in use for its own receiver and the tokens are then lost.
- **Fixed: the notify relay failed without a trace.** It fails open, and its
  only report was `TOKENWATCH_DEBUG=1` output - which went nowhere, since Codex
  sends the relay's stdout and stderr to the null device. The relay now keeps
  `codex-relay.json` beside the state files: the time of its last recorded
  turn, and its last 20 failures, each the time, the stage (`read`, `parse`,
  `normalize`, `store`, or `relay-spawn` for the displaced notifier it passes
  payloads on to), whether the payload came as an argument, on stdin, or not at
  all, and the error's class and system code. Never the message, which for a
  parse error quotes the payload. `doctor` reports it as `codex-relay`. Where the
  data directory cannot be written the record cannot be either; it is then
  skipped like every other relay error, rather than written somewhere shared.
  A relay run with no payload at all used to be stored as an empty turn with no
  session, which made a relay that lost its argument look like one that
  worked. It is now recorded as a failure.
- **Added: `doctor` names why Codex has no turns.** `collection:codex` now
  tells three faults apart: turns without tokens (Codex was not started through
  `tokenwatch-codex`), a relay that ran and failed since its last recorded turn
  (`relay-failing`, with the stage and error class), and no Codex event and no
  relay run at all since install (`relay-not-running`: Codex is not starting
  the relay, or it could not write anything, the failure included). A new
  `<install>:codex-notify` line warns when `config.toml` no longer runs
  Tokenwatch's relay, and also when the relay was never written because
  `notify` already ran another program at install time - the case found on a
  real machine, where the line was missing and `collection:codex` pointed at it.
- **Added: a Codex session can say it was launched through `tokenwatch-codex`.**
  The wrapper sets `TW_CODEX_WRAPPER=1` on the Codex it starts, and `tokenwatch
  agents` inside Codex reports it (`codex_wrapper` in JSON). The name avoids
  `TOKEN`, because Codex strips variables matching `*KEY*`, `*SECRET*` and
  `*TOKEN*` from the commands it runs by default - which also means a
  `TOKENWATCH_AGENT` set outside Codex does not reach them. Needs a hands-on
  check inside a real Codex session.
- Investigated, not changed: how Codex runs `notify` on Windows. It is started
  by Codex itself, outside the sandbox, with the payload as one argument and no
  shell; see `docs/limitations.md`.
- `docs/interfaces.md` re-reviewed on 2026-09-24: OpenAI's Codex pages moved to
  `learn.chatgpt.com/docs/…` and the old links redirect, and two Copilot CLI
  links pointed at a retired page and a missing one. The skill row now gives
  each agent's paths and invocation.

- The installed `[otel]` block now declares `protocol`. Without it Codex refuses
  to load `config.toml` and will not start at all, so installing Tokenwatch broke
  the agent it was meant to observe.
- The wrapper's exporter protocol is derived from the same setting, instead of
  forcing protobuf while the config it wrote said JSON - which routed telemetry
  through the small protobuf subset and lost event names and timestamps.
- OTLP events are dated from `observedTimeUnixNano` when `timeUnixNano` is 0, as
  Codex sends it. Every Codex event was previously dated to 1970 and invisible
  to `--since`.
- Events are named from the `event.name` attribute rather than the Rust source
  location Codex puts in `logRecord.eventName`.
- `cached_token_count` and `cache_write_token_count` are read, so Codex cache
  reuse is visible instead of reading 0%.
- `codex.user_prompt` delimits turns, so Codex observations group into turns.

### Copilot

- **Fixed: installing Tokenwatch made Copilot CLI deny every tool call on
  Windows.** Copilot runs hooks through PowerShell there, and Tokenwatch wrote
  each hook as one quoted command string, which PowerShell does not execute
  without the `&` call operator: every hook failed to parse before Tokenwatch's
  own fail-open code ran. One of them was `preToolUse`, which Copilot makes
  fail-closed - a crash or non-zero exit denies the tool call - so a skill,
  `tokenwatch agents`, even `Get-Content` were all refused with
  `Denied by preToolUse hook ... (hook errored)`. Tokenwatch no longer registers
  `preToolUse` at all (the same tool information arrives through `postToolUse`
  and `postToolUseFailure`), and `FAIL_CLOSED_HOOK_EVENTS` names every event,
  for every agent, whose failure blocks the agent, with a test that fails if the
  installer ever writes one. Each hook entry now carries a `bash` and a
  `powershell` command, rendered for its shell - the call operator, and quotes
  doubled, including the typographic apostrophes Windows profile names pick up -
  plus the documented `timeoutSec`. Needs a hands-on Windows test.
- **Changed: the Copilot status line stays in the form cmd.exe runs.** Copilot
  1.0.86 spawns `statusLine.command` with Node's `shell: true`, which is cmd.exe
  on Windows, not PowerShell; that is read from its shipped code because no
  document says it, and the `&` form would not run there.
- **Fixed: reinstalling kept the hook file an older version wrote.** A file whose
  every command is Tokenwatch's own hook is now rewritten without `--force` and
  is never recorded or restored as the "prior" file, so neither a reinstall nor
  an uninstall can bring `preToolUse` back. At user scope that covers a file from
  any earlier install path; at project scope, where the file may have come with
  a clone, only one pointing at this installation. Install records written by
  older versions still uninstall exactly.
- **Added: `doctor` runs the installed Copilot commands instead of checking that
  the file exists.** The hook check used to pass while every hook failed to
  parse. Each hook now runs through the shell Copilot uses (Bash, or `pwsh` then
  Windows PowerShell), and the status line through `/bin/sh` or cmd.exe, with
  `TOKENWATCH_PROBE=1`: `hook` and `status` then print a marker and exit before
  loading config, so the probe writes nothing. A failing command is an error
  naming its event, an older file that still registers `preToolUse` is a warning,
  and a shell this machine does not have is reported as not checked. Only
  commands that run this very CLI are executed: probe mode is a promise only it
  keeps, and run against a real home after an upgrade, the check executed the
  older installation's hooks for real and wrote a full round of empty Copilot
  events into the ledger each time. A command that runs a different Tokenwatch
  is now reported as not executed, with the reinstall that makes it checkable.
- Billing units recorded and shown: AI units and premium requests, diffed per
  reply like a cumulative cost total, and never rendered as money.
- Hook coverage extended to `subagentStart`, `subagentStop`, `preCompact`,
  `agentStop`, and `postToolUseFailure`, which the subagent and compaction
  features already depended on.

### All agents

- **Added: `doctor` checks that data is actually arriving, not only that
  Tokenwatch is configured.** On the first hands-on Windows install it reported
  all-OK while nothing was recorded: the project's own `.claude/settings.json`
  held another tool's status line, which outranks the user file Tokenwatch had
  installed into, so its status command never ran - and hooks kept writing 15
  lifecycle events and 0 turns, which made the ledger look alive. A
  `collection:<agent>` line now compares what arrived over the last seven days
  (never before the install) with what that agent should send: hook events but
  0 status-line samples, Codex turns with no token counts (not launched through
  `tokenwatch-codex`), or nothing at all an hour after install. A
  `claude-status-line` line walks Claude Code's settings precedence for the
  current directory and names the file whose `statusLine` wins when it is not
  Tokenwatch's; `install` runs the same check and adds it to its warning. Only
  the current directory is checked - the list of every project Claude Code has
  opened lives in its private `~/.claude.json`, which Tokenwatch does not read.
  The reporting skills now run `doctor` and caveat a report whose agent is not
  collecting, rather than summarising a partial ledger as a quiet week.
- **Changed: `tokenwatch agents` says "0 status-line samples" instead of "no
  cost reported"** for Claude Code or Copilot CLI when hooks arrived and the
  status line never did. "No cost reported" read as a fact about the provider
  when the real fact was that nothing was being collected. Copilot's AI units
  are still named whenever they arrive.

- The model row is kept even when an agent reports neither context nor cost, so
  a token row always says which model produced it.
- The on-demand session lookup ranks by an agent's own newest renderable
  activity rather than by file modification time.

- Context and model are read from the newest render rather than the last render
  that moved the token counters, so a compaction or a clear shows immediately.
  With cumulative counters most renders move nothing, and those are exactly the
  renders a compaction lands in.
- `tokenwatch status --agent <x>` with no piped payload finds the newest session
  holding that agent's events instead of the newest session of any agent.
- The auto router's own name is no longer recorded as a model.

- Copilot CLI now reports real numbers, not a placeholder: it sends no per-call
  gauge, so session-cumulative counters are diffed into per-call increments. The
  derived delta matches the `last_call_*` figures Copilot reports separately, and
  recovers the cache split those fields omit. Copilot token data is additive and
  groupable for the first time.
- Copilot's auto router no longer records every model as `auto`; the model it
  actually chose is read from `display_name`.
- Copilot context is read from `current_context_*`, which it fills, rather than
  the Claude-shaped fields it leaves null.
- `usage_cumulative` added to the event schema for providers that report running
  totals.
- A container is never stringified into a stored name. `model.id` holding an
  object used to be recorded as the literal `[object Object]`, and an array of
  strings would have been joined into stored text.

- Copilot CLI status line works: written to `~/.copilot/settings.json` as the
  bare `statusLine.command` string Copilot reads, with the `footer.showCustom`
  opt-out repaired when set.
- The status line never renders as an empty string. A host that prints the
  command's stdout cannot tell a blank line from a command it never ran, and a
  lifecycle-only event used to produce exactly that.
- The Copilot adapter reads Copilot 1.0.85's status object
  (`context_window.current_usage`), deriving fresh input as the remainder after
  cache reads *and* writes, because its input total contains both.
- Copilot settings files are parsed as JSONC, since Copilot writes comments into
  its own settings.

- Status line rendered as labelled, column-aligned rows, with the running reply
  separated from the last completed one and every field named.
- Subagent counting keyed to starts, plus the share of session cost accrued while
  at least one subagent was running.
- Per-session state files, so concurrent sessions cannot overwrite one another's
  counters; earlier single-file state is carried across on first use.
- `analyze --group-by` and `--compare`: cost drivers ranked in code against the
  preceding window of equal length.
- `experiment add|list|close` for controlled cost experiments.
- `repair` to rebuild derived counters from the ledger.
- Four bundled skills (`status-line-guide`, `token-cost-audit`,
  `token-cost-retrospective`, `token-cost-coach`); `--force` refreshes them.
- OTLP protobuf-logs subset accepted alongside OTLP/HTTP JSON.
- New-machine install guide covering macOS, Linux, WSL, and Windows for the
  GitHub CLI, Claude Code, Codex CLI, and Copilot CLI (`INSTALL.md`).
- `npm run pack:portable` builds a self-contained archive with the source, the
  install guide, and the git history as a bundle.

## 0.1.0 — 2026-08-22

- Initial dependency-free Node.js implementation.
- Claude Code hook and command-backed status-line adapter.
- GitHub Copilot CLI hook and command-backed status-line adapter.
- Codex CLI notify adapter plus local OTLP/HTTP JSON receiver and wrapper.
- Append-only metadata-only JSONL store, local pricing estimates, aggregate
  status, audit report, export, pruning, installer, uninstaller, and doctor.
- Portable `token-cost-audit` agent skill.
