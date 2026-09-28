---
name: tw-import-history
description: Import a coding agent's history from before Tokenwatch was installed, checked against live capture, and repair a mapping that no longer fits from its shape alone - never reading a prompt, a reply or code.
---

# Import history, and repair a mapping from its shape

Use this skill when the user wants the sessions from before Tokenwatch was
installed, or sessions live capture could not see (headless runs, plain
`codex`), counted in their reports. Tokenwatch reads the agent's own session
files through a mapping, keeps numbers only, and checks them against live
capture before writing anything.

The session files hold the user's prompts, replies and code. Everything in this
skill works from what `tokenwatch import` prints: counts, key paths and ids,
never a value from those files.

## Rules that never bend

- **Never open, read, list or search a session file or directory with your own
  tools**: not `~/.claude/projects`, `~/.codex/sessions`,
  `~/.copilot/session-state`, nor any file inside them, not even to look at one
  line. Tokenwatch reads them; you read only its output.
- **Pass the model nothing from a session file except the output of the
  commands below.** If a command prints something that looks like prose or a
  path, other than `session_dir` and the mapping file's own path, which
  Tokenwatch prints on purpose, stop and tell the user; do not paste it
  anywhere.
- **Never edit anything under `src/`, a bundled mapping, or an installed
  package.** The only file you ever write is a mapping proposal in a scratch
  file, and Tokenwatch validates it before using it.
- **In a repair, change only paths**: the `path` of a `select` predicate, the
  `path` of a number or id field, and the file-name `glob`. Never change a
  predicate's `equals` value, which the probe cannot show you, and never change
  `semantics`, `usage_mode`, `authority`, `overlap` or `agent`: those say what
  the numbers mean, and a shape cannot tell you that.
- **Name a repaired mapping `<bundled-id>-r<N>`** (for example `claude-jsonl-1-r1`)
  and set `evidence.repaired_from` to the bundled id.
- **Import only after the user says yes**, and keep a repaired mapping only
  after the user says yes.
- **Run `--undo <id>` before replacing a kept mapping's rows with another
  mapping's**, so the same history is never counted twice.

## Which agent

```sh
tokenwatch agents
```

It prints the host agent and which agents have live data. Default the import to
the host agent. If the user may mean another agent, ask; never pick one
silently. Write the agent first in every command (`tokenwatch import claude
--check`), because an option that takes a value reads the next word.

## Check before anything is written

```sh
tokenwatch import <agent> --check --json
```

Read `diagnosis` first; it is the one field to act on. The command prints one
JSON object on every path, with the same fields. `errors` is always a list,
empty when the mapping itself is valid. A field that could not be measured on
that path (nothing was read, no overlap check ran, no row was chosen) is
`null`: never read `null` as zero, or as verified. Then show the user, in
plain words:

- `session_dir` and `directory` (how many files, how many match the mapping's
  glob) - what will be read;
- `would_write.files_read`, `files_with_records` and `responses_written` - what
  will be kept;
- `overlap` (`sessions_compared`, `matched`) and `mapping_origin` (`bundled`,
  `user` for a kept repair, `file`) - what was verified, and with which mapping.

What `diagnosis` means:

- `bundled_mapping_broken: true` beside any diagnosis - Tokenwatch's own
  mapping is damaged. Do not propose a repair: stop, and tell the user to
  reinstall Tokenwatch.
- `no_directory` - there is no session directory at `session_dir` (`null`
  when none is configured), so nothing can be read, checked or imported. Tell
  the user where Tokenwatch looked, and do not propose a mapping. A non-empty
  `errors` beside it means the mapping is invalid as well.
- `verified` - the import agrees with live capture. Offer the import.
- `no_overlap` or `no_live_tokens` - there is nothing live to check against
  (a fresh install, plain `codex`). The numbers cannot be verified. Say so. If
  `internally_consistent` is `true`, you may add that the file agrees with its
  own totals, never that it is verified.
- `mismatch` with `mapping_paths.unresolved` empty - every path resolves but
  the numbers disagree with live capture. Do not propose a mapping. Report
  `overlap.by_field`, `turns_compared`, `matched` and the first `mismatches`.
  For Codex, `docs/limitations.md` explains a known input-only request live
  capture records and the rollout does not.
- `paths_unresolved`, `glob_matches_nothing`, or `mapping_invalid` with a
  non-empty `errors` - the mapping no longer fits the files. Offer a repair
  (below). An entry of `<file:not_json>`, `<file:unreadable>` or
  `<file:too_large>` means the mapping file itself could not be read: fix your
  proposal file, or, when `mapping_origin` is `user`, tell the user the kept
  mapping needs fixing or removing.
- `mapping_invalid` with an empty `errors` and `mapping_paths.unresolved`
  empty - every path resolves but no record is selected: a selector value was
  renamed, and the probe cannot show values. Say this
  cannot be repaired from the shape, and offer the issue bundle described
  under "When three proposals fail". The same holds for `mapping_invalid` with an empty `errors` when the
  only unresolved paths are number paths: no selector or id is missing, so the
  shape gives no repair to make.

## Import

```sh
tokenwatch import <agent> --dry-run --json
```

Summarise it, and import only after the user says yes:

```sh
tokenwatch import <agent> --json
```

A run that is not verified writes nothing unless `--accept-unverified` is
added. Add it only after the user has typed or said the word unverified
themselves, and from then on every summary of that data says unverified.
Imported rows carry no cost; `analyze` counts them in `imported_turns`, apart
from live turns.

To remove an import: `tokenwatch import <agent> --undo <mapping id>`, or with
`--run <run id>` for one run. Show the `--dry-run` form first; it writes
nothing. An undo removes only that agent's rows: an id from another agent's
import is refused ("nothing removed") with the command that would remove it.
Do not run that command unless the user asks for that agent's history to go.

## Repair a mapping that no longer fits

1. Get the mapping in use: `tokenwatch import <agent> --export-mapping` prints
   it; save it to a scratch file.
2. From the `--check --json` output, use only `probe.paths` (key paths, value
   types and counts), `mapping_paths.unresolved` and `directory`. Find where
   each unresolved path moved - a renamed or re-nested key, a new file-name
   pattern - and write a proposal: the saved mapping with those paths changed,
   a new `mapping_id` and `evidence.repaired_from`.
3. Check the proposal:

   ```sh
   tokenwatch import <agent> --check --json --mapping <proposal file>
   ```

4. If `diagnosis` is `verified`, show the user what changed and, after the user
   says yes, keep it:

   ```sh
   tokenwatch import <agent> --keep-mapping <proposal file>
   ```

   Later imports use the kept mapping instead of the bundled one, and
   `tokenwatch doctor` names it. Tell the user about any key listed in
   `differs_from_bundled`. A refusal names the key path to fix; `read_only`
   means the data directory cannot be written here: say so in one line and
   point to the `writable_roots` note in `INSTALL.md` (Codex CLI specifics),
   without retrying.

5. If the proposal is not verified, read its `diagnosis`, `mapping_paths` and
   `overlap.by_field`, and try again.

**Three proposals at most.** After the third, stop.

### When three proposals fail

Say the format is not supported by the bundled mapping and its repairs, and
offer the user a values-free bundle to file as an issue: the `--check --json`
output's `diagnosis`, `mapping_paths`, `directory` and `probe`, and the last
proposal. Leave out `session_dir` and any file name.

## Sharing a repaired mapping

`tokenwatch import <agent> --export-mapping` prints the kept mapping as data,
with no values and no paths from this machine. The user may share it in an
issue. Another user keeps it with `--keep-mapping`, and their next import
checks it against their own live capture.

To look at the imported history afterwards, point the user to
`tw-retrospective-overall`: `/tw-<name>` in Claude Code and Copilot CLI,
`$tw-<name>` in Codex, where `/skills` also lists them.
