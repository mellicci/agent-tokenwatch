# Architecture

```text
agent hook / status stdin / OTLP
                 │
                 ▼
        provider-specific adapter
                 │  constructs a new allowlisted object
                 ▼
        tokenwatch.event/v1 validator
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
append-only events.jsonl   compact state.json
       │                    │
       ▼                    ▼
full audit/export          fast status line
```

## Capture plane

- Claude and Copilot commands read bounded JSON from stdin.
- Codex notify reads the JSON argument appended by the CLI and optionally relays
  a pre-existing notifier.
- The loopback OTLP server accepts JSON logs/metrics and a deliberately small
  protobuf logs subset. Unknown protobuf fields are skipped; arbitrary body and
  attribute text is never copied into the event.

Adapters emit a new normalized object rather than deleting bad fields from the
raw payload. This makes the privacy boundary easier to audit.

## Storage plane

`events.jsonl` is the source of truth. Each append is one bounded line. A small
atomic state file — one per session (`sessions/s_<hash>.json`, keyed by a
hashed session id; `state.json` when unkeyed) — holds:

- recent normalized summaries for low-latency status rendering;
- cumulative-cost baselines;
- deduplication fingerprints for retried telemetry;
- last cache activity timestamps.

A future SQLite backend can implement the same store interface, but JSONL avoids
native modules and dependency management on Linux, macOS, and Windows.

## Analysis plane

Audits group exact turn IDs when available and otherwise treat usage events as
separate observations. They calculate token/cache distributions, model mix,
context growth, TTL-sized gaps, structural output sizes, and subagent counts.
Rules produce evidence, an explicitly labeled inference, a suggested action, and
a confidence level. Turning an action into a tracked, reversible experiment is a
separate, deliberate step (`tokenwatch experiment`); the audit never records one
itself. Provider charges and configured estimates stay separate.

## Installation plane

The installer:

- merges Claude JSON hooks and an available status-line slot;
- writes a dedicated Copilot hook file and an available status-line slot;
- installs a Codex notify relay and adds a comment-delimited OTEL block only when
  `[otel]` is absent;
- copies each bundled skill source into agent-native discovery paths;
- records only the information needed to remove exact managed entries.

All default paths have CLI overrides. Installed commands use absolute paths to
the current Node executable and Tokenwatch entry point.
