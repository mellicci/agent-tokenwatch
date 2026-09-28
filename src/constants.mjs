export const PACKAGE_VERSION = '0.1.0';
export const SCHEMA = 'tokenwatch.event/v1';
export const CONFIG_VERSION = 1;
export const INSTALL_VERSION = 1;
export const AGENTS = ['claude', 'codex', 'copilot'];
export const AGENT_NAMES = {
  claude: 'claude-code',
  codex: 'codex-cli',
  copilot: 'github-copilot-cli',
};
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
];
// Copilot CLI 1.0.85 ships a HookType enum of 17 events (schemas/api.schema.json
// in its bundle). These are the ones that map to something Tokenwatch already
// reports: subagent windows, compaction, turn boundaries, and failed work.
// `preToolUse` is deliberately absent: it is fail-closed (see below), and the
// tool information it carries arrives again through `postToolUse` and
// `postToolUseFailure`, which cannot deny anything.
export const COPILOT_HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'postToolUse',
  'postToolUseFailure',
  'errorOccurred',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'agentStop',
  'sessionEnd',
];
// Hook events where a hook that merely fails - a crash, a shell parse error, any
// ordinary non-zero exit - stops the agent from doing what it was about to do.
// Tokenwatch observes; it never decides, so it registers none of these for any
// agent, and a test holds every registered event against this list. Each entry
// is taken from the agent's primary documentation:
//
// - Copilot CLI, https://docs.github.com/en/copilot/reference/hooks-reference:
//   "Command `preToolUse` hooks are fail-closed on errors - a crash or non-zero
//   exit denies the tool call". Exactly this denied every Copilot tool call on
//   Windows, where the hook did not parse in PowerShell. `permissionRequest`
//   treats exit 2 as a deny and the reference does not say what other failures
//   do, so it is listed rather than assumed safe.
// - Claude Code, https://code.claude.com/docs/en/hooks: exit 1 and other codes
//   are non-blocking for every event except the worktree ones, where "any
//   non-zero exit code from `WorktreeCreate` aborts worktree creation" and
//   `WorktreeRemove` fails likewise. Exit 2 blocks several events Tokenwatch does
//   register (UserPromptSubmit, Stop, ...), but 2 is a decision code rather than
//   a failure: the hook handler always exits 0 and the CLI exits 1 on an error it
//   cannot swallow. The one accidental source of 2 is a Bash syntax error, which
//   the rendering tests rule out for the commands Tokenwatch writes - on Windows
//   too, where Claude Code may run them under Git Bash, which is why they are
//   never written in PowerShell's `&` form (claudeCommands, installer.mjs).
// - Codex CLI: Tokenwatch registers no Codex hook events; its `notify` program
//   runs after a turn and cannot block one.
export const FAIL_CLOSED_HOOK_EVENTS = {
  claude: ['WorktreeCreate', 'WorktreeRemove'],
  codex: [],
  copilot: ['preToolUse', 'permissionRequest'],
};
// `doctor` runs every installed Copilot command through the shell Copilot will
// use. With this variable set, `hook` and `status` print the marker and the
// arguments they received, then exit 0 before loading config or reading stdin,
// so a probe proves the command parsed and reached Tokenwatch without writing
// anything to the ledger, the state files, or even a fresh config.
export const PROBE_ENV = 'TOKENWATCH_PROBE';
export const PROBE_MARKER = 'tokenwatch-probe-ok';
export const MANAGED_TAG = 'tokenwatch:v1';
export const DEFAULT_OTLP_PORT = 4318;
export const MAX_STDIN_BYTES = 2 * 1024 * 1024;
// Bounds on an agent settings file the installer edits in place (intent 18).
// A project-scope file can be anyone's, so the editor refuses rather than
// parses anything past these.
export const MAX_JSON_EDIT_BYTES = 4 * 1024 * 1024;
export const MAX_JSON_EDIT_DEPTH = 64;
export const MAX_EVENT_LINE_BYTES = 64 * 1024;
// A composed status line (intent 04) reads the other tool's stdout up to this
// many bytes and discards the rest; a status line is a few short rows.
export const MAX_COMPOSE_OUTPUT_BYTES = 64 * 1024;
// A composed status command can never exceed this; the resolver refuses a
// longer recorded command rather than truncating it.
export const MAX_COMPOSE_COMMAND_CHARS = 4096;
// How many other status commands one render runs. Each is a process started on
// the agent's render path, so this is a bound, not a setting (intent 16, D5).
export const MAX_COMPOSE_COMMANDS = 4;
// Set on the displaced command Tokenwatch runs, so a `tokenwatch status` inside
// it never composes again (intent 04, FR-31).
export const COMPOSED_ENV = 'TOKENWATCH_COMPOSED';
export const COMPOSE_SHELLS = ['posix', 'cmd', 'bash', 'powershell'];
// Set by `tokenwatch-codex` on the Codex it launches, so a command run inside
// that session can say it was launched through the wrapper - the only route by
// which Codex tokens reach Tokenwatch. The name must not contain KEY, SECRET or
// TOKEN: Codex strips variables matching `*KEY*`, `*SECRET*` and `*TOKEN*`
// from the environment of the shell commands it runs, by default
// (codex-rs/protocol/src/shell_environment.rs, `populate_env`), which is why it
// is not TOKENWATCH_-prefixed like the others.
export const CODEX_WRAPPER_ENV = 'TW_CODEX_WRAPPER';
// Bounds for `tokenwatch import` (intent 06). A session-file line longer than
// this is skipped unparsed and counted: a tool result can be megabytes.
export const MAX_IMPORT_LINE_BYTES = 4 * 1024 * 1024;
export const IMPORT_READ_CHUNK_BYTES = 64 * 1024;
// The shape probe reads the newest files only, and reports at most this many
// distinct key paths, this deep.
export const IMPORT_PROBE_FILES = 3;
export const MAX_IMPORT_PROBE_PATHS = 500;
export const MAX_IMPORT_PROBE_DEPTH = 6;
// How deep a session directory is walked, and how many items of one array the
// probe describes.
export const MAX_IMPORT_DIR_DEPTH = 8;
// The largest mapping file --keep-mapping reads (intent 19).
export const MAX_MAPPING_FILE_BYTES = 256 * 1024;
// The largest ledger doctor reads whole to count the rows of an import run that
// stopped before it recorded a count; above it, only the plan is reported.
export const IMPORT_RUN_SCAN_BYTES = 64 * 1024 * 1024;
export const IMPORT_RUN_SCAN_CHUNK_BYTES = 1024 * 1024;
export const MAX_IMPORT_PROBE_ITEMS = 20;
