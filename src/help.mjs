export const HELP = `agent-tokenwatch 0.2.0

Local, metadata-only token and cost telemetry for Claude Code, Codex CLI, and
GitHub Copilot CLI. No runtime dependencies; Node.js 20+.

Usage:
  tokenwatch <command> [options]

Commands:
  install          Install hooks, supported native status lines, and the skills
  uninstall        Remove only entries installed by Tokenwatch
  status           Ingest native status JSON and print a compact status line
  hook             Ingest one hook/notify payload (normally called by an agent)
  notify-relay     Codex notify relay; records metadata and preserves prior notifier
  otlp serve       Receive Codex OTLP/HTTP JSON/Protobuf logs on loopback
  agents           List agents with recorded activity, and detect the host agent
  analyze          Produce an evidence-based token-cost audit
                   --group-by session|model|day|agent|project ranks cost drivers
                   --compare adds the preceding window of equal length
  experiment       Record, list, and close controlled cost experiments
  export           Export normalized events as JSON or CSV
  prune            Remove events older than a duration/date (--retention uses retentionDays)
  repair           Merge exchange fragments left by older versions (--dry-run to preview)
  import           Import an agent's session files as tokens-only history: --check, --dry-run, --since, --undo <mapping id>
  doctor           Check configuration, paths, integrations, and privacy-safe defaults
  config           Show/get/set local configuration
  paths            Print resolved local paths
  version          Print the package version

Common examples:
  tokenwatch install --agents all --scope user
  tokenwatch install --agents claude,codex --scope project --project .
  tokenwatch status --agent claude --json
  tokenwatch analyze --since 7d --format markdown
  tokenwatch analyze --since 7d --group-by session --compare --format json
  tokenwatch experiment list
  tokenwatch export --since 30d --format csv --output tokenwatch.csv
  tokenwatch prune --older-than 90d
  tokenwatch otlp serve
  tokenwatch install --agents claude --scope project --project . --repair
  tokenwatch-codex --full-auto

Status options:
  --session <id>              Report this session instead of the most recently active one

Install options:
  --agents <list>             claude,codex,copilot or all (default all)
  --scope <user|project>      Installation scope (default user)
  --project <path>            Project root for project scope
  --force                     Replace conflicting status/notify entries, restorable on uninstall
  --compose                   Compose with an existing status line (the default; restorable on uninstall)
  --no-compose                Leave an existing status line alone instead of composing with it
  --repair                    Re-compose after another tool changed the status line; keeps what was composed
  --claude-settings <path>    Override Claude settings path
  --copilot-config <path>     Override Copilot config path
  --copilot-hooks <path>      Override Copilot hook file path
  --codex-config <path>       Override Codex config.toml path
  --claude-skills <dir>       Override Claude skills directory
  --shared-skills <dir>       Override .agents skills directory

Import options (tokenwatch import <claude|codex|copilot>):
  --check                     Compare the files' shape and the import with live capture; writes nothing
  --dry-run                   Print what would be imported; writes nothing
  --since <duration|date>     Import responses from this window (default 30d)
  --accept-unverified         Import even when the overlap check cannot verify the numbers
  --mapping <file>            Read the session files through this mapping instead of the kept or bundled one
  --keep-mapping <file>       Keep a repaired mapping beside the ledger; later imports use it instead of the bundled one
  --export-mapping            Print the mapping an import would use, to share as data (with --mapping, that file)
  --undo <mapping id>         Remove the rows an import wrote (with --dry-run to preview)
  --run <run id>              With --undo, remove only this run's rows
  --json                      Print JSON

Environment:
  TOKENWATCH_AGENT            Name the host agent when it cannot be detected
  TOKENWATCH_HOME             Default ~/.tokenwatch
  TOKENWATCH_CONFIG           Override config.json path
  TOKENWATCH_DATA             Override events.jsonl path
  TOKENWATCH_DEBUG=1          Print hook/receiver diagnostics

Privacy default:
  Stores token counts, cost observations, timing/length counters, model/session
  identifiers, event names, and an HMAC project identity. It does not store
  prompts, code, transcripts, file paths, tool inputs/outputs, or OTLP bodies.
`;
