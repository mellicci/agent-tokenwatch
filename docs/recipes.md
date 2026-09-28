# Operational recipes

## Establish a baseline

```sh
tokenwatch analyze --since 7d --format markdown --output baseline.md
```

Do not change several levers at once. Choose one recommendation, collect a
matched sample, then compare tokens, provider cost when available, latency, and
quality failures.

## Inspect one agent

```sh
tokenwatch analyze --since 30d --agent claude --format json
```

Accepted filters are `claude`, `codex`, `copilot` or their normalized names.

## Inspect one project without storing its path

Run `tokenwatch status --json` in the project to find the local `project_id`,
then:

```sh
tokenwatch analyze --since 30d --project-id project_... --format markdown
```

## Compare a cache experiment

1. Record a baseline for a repeated task class.
2. Stabilize the early prompt/instructions and avoid changing tool/MCP settings.
3. Repeat the same number of turns.
4. Compare fresh input, cache read share, quality, and latency.
5. Revert when quality or workflow degrades.

Tokenwatch does not claim that a changed cache share was caused by your edit;
record external factors such as model/provider changes.

## Handle a long break

Before a break, ask the agent to write a concise task-state summary outside the
conversation. After the configured TTL, compare:

- resuming the old session;
- starting a new session with the summary.

Measure fresh input and successful completion, not token count alone.

## Retention and backup

```sh
tokenwatch prune --older-than 90d
cp ~/.tokenwatch/events.jsonl /encrypted/backup/
```

The store is append-only JSONL and can be compressed with standard tools. Keep
installation state with the machine, not in a shared project repository.
