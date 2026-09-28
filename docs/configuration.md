# Configuration

`~/.tokenwatch/config.json` is created on first use by any command except
`tokenwatch doctor`, which only reads it: on a machine where nothing has run
yet, doctor uses the defaults in memory, writes neither the file nor the data
directory, and says the config is not created yet. `TOKENWATCH_HOME`
relocates the whole `~/.tokenwatch` root (and so the default location of every
file below it, computed the first time `config.json` is created);
`TOKENWATCH_CONFIG` overrides just the config file's path and `TOKENWATCH_DATA`
just the data file's, and both keep applying on every run even after
`config.json` exists.

## Defaults

```json
{
  "version": 1,
  "dataFile": "~/.tokenwatch/events.jsonl",
  "stateFile": "~/.tokenwatch/state.json",
  "installStateFile": "~/.tokenwatch/install-state.json",
  "experimentsFile": "~/.tokenwatch/experiments.jsonl",
  "pricingFile": null,
  "cacheTtlSeconds": 300,
  "averagingWindow": 10,
  "retentionDays": 90,
  "status": {
    "maxWidth": 160,
    "layout": "multi",
    "align": true,
    "color": true,
    "icons": true,
    "showCost": true,
    "showSession": true,
    "showTokens": true,
    "showCache": true,
    "showContext": true,
    "showSubagents": true,
    "composeOrder": "last",
    "composeTimeoutMs": 1000
  },
  "privacy": {
    "projectIdentity": "hmac-sha256",
    "storeToolNames": true,
    "storeModelNames": true,
    "storeDurations": true
  },
  "codex": {
    "command": "codex",
    "otlpHost": "127.0.0.1",
    "otlpPort": 4318,
    "otlpPath": "/v1/logs",
    "otlpProtocol": "json",
    "installOtelConfig": true
  },
  "import": {
    "claude": { "sessionDir": "~/.claude/projects" },
    "codex": { "sessionDir": "~/.codex/sessions" },
    "copilot": { "sessionDir": "~/.copilot/session-state" }
  },
  "paths": {}
}
```

`codex.otlpProtocol` is written into Codex's `[otel]` block and used for the
wrapper's `OTEL_EXPORTER_OTLP_PROTOCOL`, so the two always agree. `"json"` is the
full-fidelity path; `"binary"` selects the deliberately small protobuf-logs
subset, which carries fewer attributes.

A random `projectSalt` is generated locally and omitted above. Project paths are
stored in event records only as truncated HMAC identities using that salt.

`stateFile` names the derived-state file, but its directory is what actually
matters: each session keeps its own snapshot in
`<stateFile dir>/sessions/s_<hash>.json`, so concurrent sessions never overwrite
one another's counters. Only the append-only ledger is shared. The name is a
hash of the session id rather than the id itself, because a session id comes
from the agent and a filename is visible in places a file's contents are not.

A bundled skill that `install --force` replaces is backed up beside
`installStateFile`, in `<installStateFile dir>/backups/skills/` (directory mode
700, files mode 600), because the text it replaces can be yours: the install
record keeps only its hash and the backup's path. `uninstall` restores it from
there and deletes the backup, or, when the backup is missing or no longer
matches, leaves the skill as it is and says so. It is not a setting.

`retentionDays` is **advisory: nothing deletes history on a timer.** The ledger
is append-only and grows until you prune it. Two things make the setting real
rather than decorative:

```sh
tokenwatch prune --retention      # prune to the configured window
tokenwatch prune --older-than 30d # or name a window explicitly
tokenwatch doctor                 # warns when the ledger is older than the window
```

A bare `prune` still refuses and names the configured value rather than
choosing for you, because deleting several months of history should be a
sentence someone typed, not a default they inherited.

## Status line

| Key | Default | Effect |
|---|---|---|
| `status.layout` | `"multi"` | `"multi"` prints one labelled row per group; `"single"` keeps everything on one line |
| `status.align` | `true` | pads cells into columns; falls back to ragged rows when alignment would overflow |
| `status.color` | `true` | magenta/white palette; `NO_COLOR` overrides this regardless |
| `status.icons` | `true` | line-art glyphs before each field |
| `status.iconOverrides` | absent | per-glyph replacements, e.g. `{"model":"⬡"}` |
| `status.maxWidth` | `160` | used only when the agent does not set `COLUMNS` |
| `status.showCost` | `true` | the in-flight and previous reply costs |
| `status.showSession` | `true` | cumulative session cost |
| `status.showTokens` | `true` | the sent/output row |
| `status.showCache` | `true` | cache share, cache writes, and the warmth countdown |
| `status.showContext` | `true` | context-window percentage |
| `status.showSubagents` | `true` | completed subagents and their cost-window share |
| `status.composeOrder` | `"last"` | for a composed status line: `"last"` prints the other status lines first, as one block in the order they were adopted, and Tokenwatch's rows after them; `"first"` the reverse |
| `status.composeTimeoutMs` | `1000` | for a composed status line: how long the other status commands may run, together, before any still running is stopped and left out (250-30000) |

Override keys for `status.iconOverrides` are `model`, `turn`, `inflight`,
`session`, `context`, `input`, `cache`, `warm`, `output`, and `subagents`.

## CLI edits

```sh
tokenwatch config show
tokenwatch config get status.maxWidth
tokenwatch config set status.maxWidth 100
tokenwatch config set cacheTtlSeconds 3600
tokenwatch config set privacy.storeToolNames false
```

The final argument to `config set` is parsed as JSON when possible. Quote JSON
strings in the shell.

## Pricing schema

```json
{
  "version": "2026-08-22-reviewed",
  "models": [
    {
      "agent": "claude-code",
      "match": "model-id-or-glob-*",
      "input_per_million": 0,
      "cache_read_per_million": 0,
      "cache_write_5m_per_million": 0,
      "cache_write_1h_per_million": 0,
      "output_per_million": 0,
      "reasoning_per_million": 0
    }
  ]
}
```

Rates are USD per one million tokens. Zeroes in the shipped example are
placeholders, not price claims. For OpenAI-style cached-input accounting,
`input_total` contains cached tokens and `input_fresh` is derived as total minus
cache reads; the estimate charges each component once. For Anthropic-style
component accounting, fresh input, reads, and writes are separate components.

An event is estimated only when all non-zero components have matching rates.
Provider-reported and estimated costs remain separate in every aggregate.
