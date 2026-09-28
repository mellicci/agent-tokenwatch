# Installing Agent Tokenwatch on a new machine

This guide takes a bare machine — macOS, Linux, or Windows — to a coding-agent
session showing a Tokenwatch status line. It covers the GitHub CLI, all three
supported agents (Claude Code, OpenAI Codex CLI, GitHub Copilot CLI), and then
Tokenwatch itself.

Every command below is one you run yourself. Tokenwatch has no runtime
dependencies and sends nothing anywhere; all telemetry it records stays in
`~/.tokenwatch`.

**The short version**, once Node 20+ and at least one agent CLI are present —
every installed agent, any platform:

```sh
cd agent-tokenwatch
npm pack
npm install -g ./agent-tokenwatch-<version>.tgz
tokenwatch install --agents all --scope user
tokenwatch doctor
```

`npm pack` builds the same tarball npm would publish and prints its name
(`agent-tokenwatch-0.1.0.tgz` for this release); install exactly that file.
That puts a real copy in npm's global folder — what `npm install -g
agent-tokenwatch` gives you — so the source folder can be moved or deleted
afterwards without breaking anything. Each line is one command, nothing
shell-chained, so it works the same in bash, PowerShell (including 5.1, which
does not support `&&`) and cmd.exe. Then restart the agent.

## Contents

1. [What is in the archive](#1-what-is-in-the-archive)
2. [Prerequisites](#2-prerequisites)
3. [Install the GitHub CLI](#3-install-the-github-cli)
4. [Unpack the source](#4-unpack-the-source)
5. [Install the coding agents](#5-install-the-coding-agents)
6. [Install Tokenwatch](#6-install-tokenwatch)
7. [Wire Tokenwatch into each agent](#7-wire-tokenwatch-into-each-agent)
8. [Verify](#8-verify)
9. [Optional: local price estimates](#9-optional-local-price-estimates)
10. [Moving your data with you](#10-moving-your-data-with-you)
11. [Uninstall](#11-uninstall)
12. [Troubleshooting](#12-troubleshooting)

## 1. What is in the archive

The portable archive unpacks to:

```text
agent-tokenwatch-<version>/
  INSTALL.md                  this file
  agent-tokenwatch/           the full source tree, ready to install
  agent-tokenwatch.gitbundle  the complete git history, as one file
```

`agent-tokenwatch/` is all you need in order to install. The bundle matters only
if you want the commit history back — see [Restore the git
history](#restore-the-git-history-optional).

## 2. Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Node.js 20 or newer | `node -v` | Tokenwatch is tested on 20, 22, and 24 |
| npm | `npm -v` | ships with Node |
| git | `git --version` | for the history and for GitHub |

Copilot CLI installed through npm wants Node 22+, so if you plan to use Copilot,
install 22 or newer and everything else is covered.

**macOS**

```sh
brew install node git
```

**Linux**

```sh
# Debian / Ubuntu — check node -v afterwards; distro Node is often too old
sudo apt update && sudo apt install -y nodejs npm git

# Fedora / RHEL
sudo dnf install -y nodejs git

# Arch
sudo pacman -S nodejs npm git
```

If your distribution ships Node 18 or older, use
[nvm](https://github.com/nvm-sh/nvm) or the
[NodeSource packages](https://github.com/nodesource/distributions). One caveat
with version managers is listed under [Troubleshooting](#12-troubleshooting).

**Windows (PowerShell)**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Windows works two ways: natively in PowerShell, or inside WSL. Under WSL, follow
the Linux instructions throughout — the agents, Tokenwatch, and the data
directory all live inside the WSL filesystem, separate from any Windows install.
Pick one and stay in it.

## 3. Install the GitHub CLI

`gh` is not required to run Tokenwatch. It is how you get this repository onto
GitHub from one machine and back off it onto the next without handling archives
by hand.

**macOS**

```sh
brew install gh
```

**Windows (PowerShell)**

```powershell
winget install --id GitHub.cli
```

**Linux — Debian / Ubuntu** (the GitHub package repository must be added first):

```sh
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update && sudo apt install gh -y
```

**Linux — Fedora / RHEL**

```sh
sudo dnf install -y dnf5-plugins
sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo
sudo dnf install -y gh
```

**Linux — Arch**

```sh
sudo pacman -S github-cli
```

Authenticate once per machine:

```sh
gh auth login      # GitHub.com, HTTPS, log in through the browser
gh auth status
```

`gh auth login` also configures git credentials, so `git push` works afterwards
without a personal access token.

### Put this repository on GitHub

From a clone that has its history (see [step 4](#4-unpack-the-source)):

```sh
gh repo create mellicci/agent-tokenwatch --private --source=. --remote=origin --push
```

On the next machine, skip the archive entirely:

```sh
gh repo clone mellicci/agent-tokenwatch
cd agent-tokenwatch
```

## 4. Unpack the source

**macOS / Linux**

```sh
unzip agent-tokenwatch-portable-*.zip
cd agent-tokenwatch-*/agent-tokenwatch
```

**Windows (PowerShell)**

```powershell
Expand-Archive agent-tokenwatch-portable-0.1.0.zip -DestinationPath .
Set-Location agent-tokenwatch-0.1.0\agent-tokenwatch
```

### Restore the git history (optional)

The archive carries the full history as a single git bundle, so you can keep
working with branches and commits instead of a bare snapshot:

```sh
git clone agent-tokenwatch.gitbundle agent-tokenwatch-repo
cd agent-tokenwatch-repo
git log --oneline | head
```

Use that clone in place of `agent-tokenwatch/` for everything below if you want
to keep committing. The bundle path is relative to the unpacked archive root.

## 5. Install the coding agents

Tokenwatch reports what an agent tells it, so install at least one. Each agent is
independent; install only the ones you use.

### Claude Code

| Platform | Command |
|---|---|
| macOS, Linux, WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| macOS (Homebrew) | `brew install --cask claude-code` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows (WinGet) | `winget install Anthropic.ClaudeCode` |

The native installer keeps itself updated. Homebrew and WinGet do not — upgrade
with `brew upgrade claude-code` or `winget upgrade Anthropic.ClaudeCode`.

```sh
claude --version     # prints a version followed by (Claude Code)
claude               # first run prompts for login; /login switches accounts later
```

Claude Code needs a Claude subscription (Pro, Max, Team, Enterprise), a Claude
Console account, or access through a supported cloud provider. On native Windows,
installing [Git for Windows](https://git-scm.com/downloads/win) is recommended so
Claude Code has a Bash tool. Docs: <https://code.claude.com/docs/en/quickstart>.

### OpenAI Codex CLI

| Platform | Command |
|---|---|
| macOS, Linux, WSL | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| macOS (Homebrew) | `brew install --cask codex` |
| Windows (PowerShell) | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| Any platform (npm) | `npm install -g @openai/codex` |

```sh
codex --version
codex                # choose "Sign in with ChatGPT" on first run
```

Docs: <https://developers.openai.com/codex/>.

### GitHub Copilot CLI

| Platform | Command |
|---|---|
| macOS, Linux (Homebrew) | `brew install --cask copilot-cli` |
| macOS, Linux (script) | `curl -fsSL https://gh.io/copilot-install \| bash` |
| Windows (WinGet) | `winget install GitHub.Copilot` |
| Any platform (npm) | `npm install -g @github/copilot` |

Copilot CLI needs an active GitHub Copilot subscription, Node 22+ for the npm
install, and, on Windows, PowerShell 6 or newer (`pwsh`), which it runs hooks
through; the Windows PowerShell 5.1 that ships with Windows is not enough.
`tokenwatch doctor` probes the Copilot hooks with `pwsh` when it is on `PATH`
and falls back to Windows PowerShell 5.1 only when it is not; a pass under 5.1
shows the commands parse, not that Copilot, which needs `pwsh`, can run them.
If `ignore-scripts=true` is set in
your `~/.npmrc`, use
`npm_config_ignore_scripts=false npm install -g @github/copilot`.

```sh
copilot              # then type /login and follow the prompts
```

Docs: <https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli>.

## 6. Install Tokenwatch

From the source directory, on every platform, pack the source into the tarball
npm would publish and install that tarball globally:

```sh
npm pack
npm install -g ./agent-tokenwatch-<version>.tgz
tokenwatch version
tokenwatch doctor
```

Replace `<version>` with what `npm pack` printed. `doctor` should report
`OK node` and `OK install-location`. It creates nothing, so on a fresh machine
`config`, `event-store`, `state` and `data-directory-write` are `INFO` lines
saying `not created yet`: `tokenwatch install`, or any other command that
records, creates them. There is also an `INFO` line about pricing —
Tokenwatch ships no prices (see [step 9](#9-optional-local-price-estimates)).
Right after installing, each `collection:<agent>` line is `INFO` until that agent
has run a session; run `doctor` again afterwards, from the project you work in,
and it should say `OK` with the hook and status-line counts it saw. If
`tokenwatch` is not found on `PATH` afterwards, see
[Troubleshooting](#12-troubleshooting).

**Why a tarball and not `npm install -g` on the folder.** Every hook and status
line Tokenwatch writes embeds the absolute path of the installed CLI. Pointing
`npm install -g` at a folder does not copy it: npm installs a *link* to the
folder (a junction on Windows), so every agent's hooks end up running the
script inside your source folder. If that folder is in a temporary or download
directory, cleaning it up silently breaks every agent at once. The tarball is
installed as a copy, exactly as the published package is. `tokenwatch install`
and `tokenwatch doctor` both warn when the CLI is reached through a link or
lives in a temporary or download folder, and say which command to run instead.

### Developing Tokenwatch itself

When you are changing Tokenwatch and want the agents to run your working tree,
link it instead of packing it:

```sh
npm link
tokenwatch install --agents all --scope user
```

`npm link` makes the global `tokenwatch` a link to this checkout, so every hook
runs whatever is checked out — a branch switch changes what the agents run, and
moving or deleting the checkout breaks them. `doctor` notes this as `INFO` for a
git checkout. Use it only on a checkout you intend to keep where it is, and
reinstall from a tarball when you are done. `npx tokenwatch install` from the
source folder behaves the same way: the hooks run the script in that folder.

**What is and is not verified on Windows:** CI runs this project's own test
suite — including the installer's file-writing, JSON/TOML generation, and
uninstall round-trip — on `windows-latest` for real; the `ci` badge in the
README says whether that run passed for the latest commit. What CI
cannot verify is the far side: whether Claude Code, Copilot CLI, and Codex CLI
themselves then execute the generated hook/status-line command strings
correctly on a real Windows machine, since CI does not run those three agent
binaries. If a hook or status line silently does nothing on Windows specifically,
that boundary — Tokenwatch's own output versus how another vendor's CLI consumes
it — is the first place to look, and worth a bug report either way.
What has been checked by hand, on which platform, with which agent version and
when, is in the README's
[Platform and agent support](README.md#supported-agents-and-platforms) table. The
first hands-on Windows run was on 2026-09-23; the fixes it led to have not yet
been re-run on Windows, and CI has not run since 2026-09-21.

## 7. Wire Tokenwatch into each agent

One command covers everything installed:

```sh
tokenwatch install --agents all --scope user
```

Or name the agents you want: `--agents claude`, `--agents claude,codex`,
`--agents copilot`. The installer prints every path it touched and every conflict
it deliberately left alone. It never overwrites a Codex notifier without
`--force`. An existing status line is composed by default, so the other line keeps
running beside Tokenwatch's; `--no-compose` leaves it alone and `--force` hides
it. `uninstall` restores whatever an install replaced.

What `--scope user` writes, on macOS and Linux (`~` is `%USERPROFILE%` on
Windows):

| Agent | Files written |
|---|---|
| Claude Code | lifecycle hooks and, if the slot is free, a status line in `~/.claude/settings.json`; skills in `~/.claude/skills/` |
| Codex CLI | a `notify` relay and a managed `[otel]` block in `~/.codex/config.toml`; skills in `~/.agents/skills/` |
| Copilot CLI | a dedicated `~/.copilot/hooks/tokenwatch.json`, a `statusLine.command` in `~/.copilot/settings.json` if free; skills in `~/.agents/skills/` |

An upgrade that adds a bundled skill (intent 19 added `tw-import-history`) reaches an agent
only when you run `tokenwatch install` again; an installed skill is a copy, not a link.

**Restart the agent afterwards.** Hooks and status lines are read at session
start.

Project scope instead of user scope:

```sh
tokenwatch install --agents all --scope project --project /path/to/project
```

Project scope writes Claude hooks to `.claude/settings.local.json` rather than the
shared `.claude/settings.json`, because the generated commands embed absolute
paths to this machine's Node executable and install directory. Do not commit
those files — they are machine-specific by construction.

### Claude Code specifics

The status line command is:

```text
tokenwatch status --agent claude --ingest-stdin
```

It reads the status JSON Claude Code sends on stdin. Cumulative session cost is
used only once a baseline exists, so the first snapshot is not misreported as a
single-turn charge.

### Codex CLI specifics

Codex reports exact token usage over OpenTelemetry rather than through its
lifecycle hook, so run it through the wrapper, which starts a loopback receiver on
`127.0.0.1:4318` for the duration of the session and closes it on exit:

```sh
tokenwatch-codex             # or: tokenwatch codex -- --full-auto
```

The installer adds a managed `[otel]` block only when none exists; an existing
OpenTelemetry configuration is never replaced. Codex's footer is built in rather
than command-backed, so Tokenwatch does not replace it — use
`tokenwatch status --agent codex` when you want the line.

Codex runs the agent's shell commands in a sandbox that, in `workspace-write`
mode, cannot write outside the workspace. The reporting commands the skills run
still work there: they read `~/.tokenwatch`, include the turn in progress from
memory, and print a `note:` saying nothing was flushed. If you would rather Codex
could write it, add the directory to `sandbox_workspace_write.writable_roots` in
`~/.codex/config.toml`, which the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes as "additional writable roots when `sandbox_mode = "workspace-write"`":

```toml
[sandbox_workspace_write]
writable_roots = ["/home/you/.tokenwatch"]   # Windows: 'C:\Users\you\.tokenwatch'
```

The skills go to `~/.agents/skills` (a project-scope install: `.agents/skills`
in the project), which Codex reads from version 0.95.0 on; check yours with
`codex --version`. In Codex a skill is not a slash command: type
`$tw-retrospective-this-session`, or run `/skills` and pick one. Codex notices
new skills by itself, but restart it if they are not listed. A project-scope
install is found when Codex starts in that project or below it, up to the
repository root (Codex looks for `.git` to find it).

### Copilot CLI specifics

Copilot reads user settings from `~/.copilot/settings.json` — not
`config.json`, which holds its own app state. The status line goes in as a bare
string:

```json
{ "statusLine": { "command": "... tokenwatch status --agent copilot --ingest-stdin" } }
```

Copilot spawns that command once per refresh with its status object on stdin and
renders the trimmed stdout, so `statusLine.padding` and
`statusLine.refreshInterval` are yours to set alongside it. The `custom` footer
item must be on for the output to appear; it is on unless you set
`footer.showCustom` to `false`, and the installer repairs that opt-out.

The hook file holds a `bash` and a `powershell` command for each event, and
Copilot picks the one for your platform. `tokenwatch doctor` runs each of them,
and the status-line command, through the shell Copilot uses, in a probe mode
that stores nothing; an `ERROR ... copilot-hook:<event>` line means that hook
cannot run on this machine. A shell that is not installed is reported as not
checked.

After any Copilot upgrade, run `tokenwatch doctor` and check the paths in
`tokenwatch paths`. If Copilot has moved its configuration, point the installer
at the new location:

```sh
tokenwatch install --agents copilot --scope user \
  --copilot-config /path/to/config.json \
  --copilot-hooks /path/to/hooks/tokenwatch.json
```

## 8. Verify

```sh
tokenwatch paths                  # where config, events, and state live
tokenwatch doctor                 # managed paths exist and are writable
tokenwatch status --agent claude  # renders from whatever has been recorded
```

Then start Claude Code in any project. The status line appears at the bottom of
the session, filling in as the session accrues cost:

```text
⌬  Opus-5[1m] │ ▥ ctx 67% · Σ session $30.19 · ◴ cache warm 1.0h     │ ◐ this reply $2.29 so far · ❯ previous reply $0.740
⊞  Tokens     │ ↑ 670k sent · 99.8% from cache · 1.5k added to cache │ ↓ 668 output
⑃  Subagents  │ 25 completed                                         │ 6% of session cost
```

Ask the agent `/tw-explain-statusline` to have any field explained, or run
`tokenwatch analyze --since 7d --format markdown` after a few sessions.

## 9. Optional: local price estimates

Tokenwatch ships **no model prices** and never invents one. Provider-reported
costs work without any of this. To estimate cost for token-only streams, copy the
example, fill in prices you have verified yourself, and point the config at it:

```sh
cp examples/pricing.example.json ~/.tokenwatch/pricing.json
tokenwatch config set pricingFile '"~/.tokenwatch/pricing.json"'
tokenwatch doctor
```

In PowerShell the quoting differs:

```powershell
Copy-Item examples\pricing.example.json $HOME\.tokenwatch\pricing.json
tokenwatch config set pricingFile '"~/.tokenwatch/pricing.json"'
```

An incomplete pricing rule produces no estimate rather than a deceptively low
one.

## 10. Moving your data with you

Installation state belongs to the machine; recorded history does not.

```sh
# on the old machine
cp ~/.tokenwatch/events.jsonl /somewhere/portable/

# on the new one, after installing
cp /somewhere/portable/events.jsonl ~/.tokenwatch/events.jsonl
tokenwatch repair          # rebuild derived counters from the ledger
tokenwatch analyze --since 30d --format markdown
```

Do not copy `install-state.json` between machines: it records the exact entries to
remove on uninstall, and those paths are machine-specific.

To put the whole data directory somewhere else, set `TOKENWATCH_HOME` (or
`TOKENWATCH_DATA` for just the ledger) in your shell profile before running any
Tokenwatch command.

## 11. Uninstall

```sh
tokenwatch uninstall --scope user     # removes only entries Tokenwatch installed
npm uninstall -g agent-tokenwatch     # removes the CLI
rm -rf ~/.tokenwatch                  # removes recorded telemetry, if you want it gone
```

On Windows, the last line is `Remove-Item -Recurse -Force $HOME\.tokenwatch`.
Anything the installer replaced with `--force` is restored by `uninstall`,
unless you changed it yourself since: a Codex `notify` line you set to another
tool after installing, or removed, is left as you set it, and `uninstall` prints
a `WARN settings:` line naming `config.toml` instead of restoring the old
notifier. A forced reinstall (`install --agents codex --force`) over such a line
prints a `WARN settings:` line too: it replaces your newer notifier with the
relay and records it, so `uninstall` later restores that newer one, and the one
the first install replaced is no longer recorded. A `~/.codex/config.toml`
that is a link into your dotfiles stays a link, and the file it points to gets
its own bytes back.

## 12. Troubleshooting

**`tokenwatch: command not found`** — the npm global bin directory is not on your
`PATH`. Find it with `npm prefix -g` and add `<prefix>/bin` to your shell profile
(`$env:PATH` plus the prefix itself on Windows). Open a new terminal afterwards.

**Installed, but no status line, or nothing recorded** — first suspect a status
line set at a higher level than the one Tokenwatch installed. Claude Code runs
exactly one `statusLine`, and the first of these files that sets one wins:
`.claude/settings.local.json`, then the project's `.claude/settings.json`, then
`~/.claude/settings.json` ([Claude Code settings
precedence](https://code.claude.com/docs/en/settings)). A user-scope install
writes the last of the three, so any project whose own settings set a status
line — another tool's, often committed to the repository — outranks it. Claude
Code still runs Tokenwatch's hooks, so the ledger fills with lifecycle events and
looks alive, but the status line is where every token and cost figure comes
from, and none arrive. That is what happened on the first hands-on Windows
install, and nothing about it is specific to Windows.

Run `tokenwatch doctor` from that project. It names the file that wins, and once
the agent has run a session it counts what actually arrived:

```text
WARN  user:claude-status-line: /home/you/project/.claude/settings.json sets a statusLine that is not Tokenwatch's, and it takes precedence for /home/you/project. Claude Code runs that command instead, so Tokenwatch records hook events there but no tokens or cost. To run both in that project: tokenwatch install --agents claude --scope project --project "/home/you/project" (uninstall restores what it replaced). --force instead hides the other status line; uninstall restores it.
WARN  collection:claude: 15 hook events but 0 status-line samples from claude-code since 2026-09-23T09:00:00.000Z: the status line never delivered usage, so no tokens or cost were recorded. The usual cause is another statusLine taking precedence (see the claude-status-line line); a status line replaced or removed after install does the same.
```

`tokenwatch install` prints the same `claude-status-line` finding as a warning
when it installs. Two ways out, both reversible:

- **Keep both.** Run the command `doctor` printed: `tokenwatch install --agents
  claude --scope project --project /path/to/project`. Composing is the default,
  so no flag is needed. It writes `.claude/settings.local.json`, which outranks
  the shared `.claude/settings.json` and is not meant to be committed, with a
  status line that reads the payload once, records it, hands the identical
  bytes to the other tool's command and prints that tool's rows followed by
  Tokenwatch's. That shared file is only read, never edited. Composing also
  works when the other status line is in the very file Tokenwatch writes, for
  Claude Code and Copilot CLI alike: there the entry is replaced, and
  `uninstall` restores it exactly. It refuses a status line that already runs
  Tokenwatch; one that only mentions the word is composed, with a warning.
- **Let Tokenwatch's status line win in that project.** The same command with
  `--force` hides the other tool's status line in that project until
  `tokenwatch uninstall --scope project --project /path/to/project` puts back
  what was there. `--force` and `--compose` together are refused on a first
  install, because one hides the other line and the other keeps it.
  `--no-compose` leaves the other line alone, and Tokenwatch collects nothing
  from the status line there.

If another tool changes or replaces the status line after install, `doctor`
says so on the `status-compose`, `claude-status-line` or `collection` line and
names the repair in full, for example `tokenwatch install --agents claude --scope
project --project "/path/to/project" --repair`. It keeps the lines composed
before, adopts the new one, and changes nothing when nothing drifted; uninstall
then restores the line that was in the slot at the repair. (`tokenwatch repair`
is a different command, for ledger files.) Up to four other lines are composed,
printed in the order they were adopted; `status.composeOrder` and
`status.composeTimeoutMs` tune them ([docs/configuration.md](docs/configuration.md)).
For a status tool that needs its own shell or environment, the package ships a
wrapper template, `examples/statusline-wrapper.mjs`, to copy and set as the
status line; Tokenwatch never runs it itself. A command still running at
`status.composeTimeoutMs` is stopped with everything it started, on Windows too
(`taskkill /T`, which can add up to 2 s to that render). On Windows a render the
agent itself terminates cannot stop anything, so a program started by the other
command may then keep running until it exits by itself. The same holds for a
program the other command started and then returned from: once that command's
shell has exited, its process id may already belong to another program, so
Tokenwatch does not kill by it, and only stops reading the program's output.

If `doctor` shows neither warning:

- The session was started before the install. Restart it; hooks and status
  lines are read at session start.
- The slot Tokenwatch installs into was already taken and the install used
  `--no-compose`, or the other line was refused (it runs Tokenwatch, or has no
  command); the install output says which. `uninstall` restores whatever an
  install replaced.
- In Copilot CLI, check that `footer.showCustom` is not `false` in
  `~/.copilot/settings.json`, and that the command is in `settings.json` rather
  than `config.json`. Copilot renders the command's trimmed stdout, so a command
  that prints nothing looks exactly like one that was never configured.
  `collection:copilot` reports hook events without status-line samples, but
  `doctor` does not walk Copilot's settings layering (see
  [docs/limitations.md](docs/limitations.md)).

**Hooks stop working after a Node upgrade** — installed commands embed the
absolute path of the Node executable current at install time. Version managers
such as nvm, fnm, and volta move that path. Re-run `tokenwatch install` after
switching Node versions, then `tokenwatch doctor`.

**Nothing recorded for Codex** — `tokenwatch doctor` names which of three
faults it is. `collection:codex` says "turns … none with token counts" when
Codex was not started through `tokenwatch-codex`, the only route by which Codex
tokens arrive; "relay ran and failed" with the stage and error class when the
notify relay is running but cannot record; and "no notify relay run recorded"
when Codex never started the relay - check the `codex-notify` line, which says
whether `config.toml` runs Tokenwatch's relay at all. One cause `codex-notify`
names directly: "Tokenwatch's Codex relay was never installed", when
`config.toml` already ran another notifier at install time and, as it must
without `--force`, install left it alone, so no relay was ever written.
`tokenwatch install --agents codex --force` adds it. `otlp-receiver` says
whether a receiver is listening right now, and `otlp-bind` only what is
configured. Inside a Codex session, `tokenwatch agents` says whether that
session was launched through `tokenwatch-codex`.

**Nothing recorded for Copilot** — Copilot CLI has moved its configuration
between previews. Compare `tokenwatch paths` against where your Copilot CLI
actually reads config, and reinstall with `--copilot-config` / `--copilot-hooks`
pointed at the real paths.

**Codex records turns but no tokens** — Codex reports token counts only over
OpenTelemetry, so a session started as plain `codex` records boundaries and
structure while a session started through `tokenwatch-codex` also records tokens.
`doctor` reports this as `collection:codex` turns without token counts.

**Codex does not list the Tokenwatch skills** — `/tw-…` is Claude Code's syntax;
in Codex type `$tw-…` or open `/skills`. If `/skills` does not list them, run
`tokenwatch doctor`: it warns when the skills were installed somewhere Codex does
not look, or when one no longer parses (a byte-order mark added by an editor is
enough for Codex to skip it). Codex before 0.95.0 reads only `~/.codex/skills`,
so upgrade Codex rather than copying the files there.

**Codex will not start after installing** — an `[otel]` block without a
`protocol` field makes Codex refuse to load `config.toml`. Versions of Tokenwatch
before this fix wrote one. Re-run `tokenwatch install --agents codex` to rewrite
the block, or delete the `# tokenwatch:v1` section from `~/.codex/config.toml`.

**Copilot CLI fails with "Native addon \"runtime\" not found" or "failed to map
segment from shared object"** — the addon is there; the filesystem holding
Copilot's package cache is mounted `noexec`, which is common for `~/.cache` in
containers and devcontainers. A `.node` addon is a shared library, so loading it
needs an executable mapping. Check with
`findmnt -T ~/.cache -o TARGET,FSTYPE,OPTIONS`, and if `noexec` is listed, move
the cache to a filesystem that allows exec:

```sh
echo 'copilot() { XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.xdg-cache}" command copilot "$@"; }' >> ~/.bashrc
```

With root you can instead remount it: `sudo mount -o remount,exec ~/.cache`. In a
devcontainer, dropping `noexec` from the cache mount in `devcontainer.json`
survives rebuilds, which the shell function does not.

**Copilot denies every tool call: `Denied by preToolUse hook ... (hook errored)`**
— an older Tokenwatch registered Copilot's `preToolUse` hook, which denies the
tool call whenever the hook fails, and wrote a command PowerShell could not
parse. Reinstall with `tokenwatch install --agents copilot --force` (add
`--scope project --project "<dir>"` for a project install): the hook
file is rewritten without `preToolUse` and with a PowerShell command for each
event. `tokenwatch doctor` then runs each hook to confirm it.

**`WARN claude-settings: ... was not changed`** (or `copilot-settings`) — install
could not edit that agent's settings file safely: it does not parse, repeats a
key, nests too deep, is over 4 MiB, does not hold a JSON object, or (Claude Code
only) contains comments, which Claude Code ignores whole. The file is left byte
for byte, and that agent gets no hooks, no status line and no skills; the other
agents install as usual. The refusal is saved with the install, so
`tokenwatch doctor` keeps reporting it as `<install>:claude-settings`. Repair the
file, then run the command the warning names: it is the reinstall for the scope
you installed at, for example
`tokenwatch install --agents claude --scope project --project "<dir>" --force`.
`tokenwatch uninstall` works while the file is still broken, since nothing was
written to it. A file that breaks *after* a working install is different:
`uninstall` then keeps that agent's record, prints a `WARN settings:` line, and
names itself, for your scope, as the command to run once the file is repaired,
for example `tokenwatch uninstall --scope project --project "<dir>"`.

**Windows: quoting errors from an agent hook** — run the install from PowerShell,
not CMD, and install PowerShell 6+ (`pwsh`), which Copilot CLI requires for its
hooks. `tokenwatch doctor` executes the installed Copilot and Claude Code
commands and names any hook that fails to run; its `copilot-hooks-run` line
names the shell it used, and `powershell` there means `pwsh`, which Copilot
needs, is not on `PATH`.

**Windows: Claude Code records nothing, and Git Bash is not installed** — Claude
Code then runs hooks and the status line through PowerShell, which could not run
the commands older Tokenwatch versions wrote. Reinstall with
`tokenwatch install --agents claude --force` (add `--scope project --project
"<dir>"` for a project install). The new commands start `node` from `PATH`, so
make sure `node --version` works in PowerShell and prints 20 or newer.
`tokenwatch doctor` runs each command through the shell Claude Code uses and
says which one failed.

**Windows: Codex calls a Tokenwatch script that no longer exists** — versions of
Tokenwatch before this fix did not recognise their own Codex relay on Windows, so
a reinstall recorded the relay as your previous notifier and `uninstall` put it
back. If Tokenwatch is still installed, run
`tokenwatch install --agents codex --force` and then, if you want it gone,
`tokenwatch uninstall`: both now drop that record instead of restoring it. If the
package is already removed, delete the `notify = [...]` line that mentions
`notify-relay` from `%USERPROFILE%\.codex\config.toml`.

**WSL: the status line is empty in Windows terminals** — a WSL install writes to
the WSL home directory. The Windows-native agent reads the Windows home directory
and will not see it. Install Tokenwatch on the side you actually run the agent on.

**After any agent CLI upgrade** — run `tokenwatch doctor`. These CLIs are moving
targets; the doctor makes a changed settings path visible instead of silently
recording nothing.

## Further reading

- [README](README.md) — what each status-line field means and the daily commands
- [docs/configuration.md](docs/configuration.md) — every setting and its default
- [docs/privacy-threat-model.md](docs/privacy-threat-model.md) — what is stored and what is refused
- [docs/limitations.md](docs/limitations.md) — what these numbers do not mean
- [docs/recipes.md](docs/recipes.md) — running a cost experiment
- [docs/interfaces.md](docs/interfaces.md) — the per-agent interface map and primary sources
