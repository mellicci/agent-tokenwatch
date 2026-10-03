import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeShell, findOnPath, shellLineInvocation } from './spawn.mjs';
import { AGENTS, AGENT_NAMES, FAIL_CLOSED_HOOK_EVENTS, IMPORT_RUN_SCAN_BYTES, IMPORT_RUN_SCAN_CHUNK_BYTES, MAX_COMPOSE_COMMANDS, PROBE_ENV, PROBE_MARKER } from './constants.mjs';
import { codexNotifyState, composeEntries, composeSpec, inspectInstallLocation, reinstallCommand, repairCommand, listInstalls, runningInstallLocation, runsThisCli, settingsRefusalReason, skillBackupDir } from './installer.mjs';
import { isLoopbackHost } from './otlp-server.mjs';
import { describeRelayFailure, readRelayRecord, relayRecordSummary } from './relay-record.mjs';
import { loadPricing } from './pricing.mjs';
import { identityPath, readJson, readJsonc } from './fs-util.mjs';
import { loadImportRuns } from './import/runs.mjs';
import { bundledMapping, resolveMapping, userMappingFile } from './import/override.mjs';
import { listSessionStateFiles } from './store.mjs';
import { claudeSettingsChain, isTokenwatchStatusLine, statusLineAt, statusLineShadowMessage, winningClaudeStatusLine } from './claude-settings.mjs';

// A skill directory Tokenwatch once installed but no install-state record now
// lists - typically a renamed or removed skill whose old entry fell out of a
// record written before per-skill array tracking existed. Nothing else ever
// revisits it, so it sits there forever, stale, still loadable, and easy to
// mistake for the current version. Detected, never deleted automatically: this
// directory is shared with anything else the user or another tool put there.
function findOrphanedSkills(destinationDir, trackedNames) {
  let entries;
  try {
    entries = fs.readdirSync(destinationDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const orphans = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || trackedNames.has(entry.name)) continue;
    const skillFile = path.join(destinationDir, entry.name, 'SKILL.md');
    let content;
    try {
      content = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    // A skill that shells out to `tokenwatch` is almost certainly ours; an
    // unrelated skill a user placed in the same shared folder is not flagged.
    if (/\btokenwatch\s+[a-z-]+/.test(content)) orphans.push(path.join(entry.name, 'SKILL.md'));
  }
  return orphans;
}

// An installed skill is a file a model reads and acts on, with that model's
// tools. The digest recorded at install was used by uninstall, to avoid
// reverting a file the user had edited, and by nothing else - so a skill
// altered after install was never noticed by anything.
//
// Reported, never repaired. Editing an installed skill is a legitimate thing
// to do and the installer deliberately preserves such edits, so this states
// what changed and lets the reader decide. `--force` reinstalls the bundled
// text if they want it back.
function skillDigestCheck(skill, prefix, remedy) {
  if (!skill?.installed || !skill.path || !skill.sha256) return [];
  let current;
  try {
    current = crypto.createHash('sha256').update(fs.readFileSync(skill.path, 'utf8'), 'utf8').digest('hex');
  } catch {
    return [];
  }
  if (current === skill.sha256) return [];
  return [{
    id: `${prefix}:${skill.name ?? 'skill'}:modified`,
    status: 'warn',
    detail: `${skill.path} no longer matches what was installed. If you edited it, nothing is wrong. If you did not, something else changed a file an agent reads as instructions. Reinstall the bundled text with: ${remedy}`
  }];
}

// The ledger is append-only and written in order, so its first line is its
// oldest record. That makes the retention question answerable by reading one
// line rather than the whole file, which matters because `doctor` should stay
// cheap on a ledger that has been accumulating for a year.
function oldestLedgerEntry(dataFile) {
  let handle;
  try {
    handle = fs.openSync(dataFile, 'r');
    const buffer = Buffer.alloc(8192);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, read).toString('utf8').split('\n')[0];
    const ts = JSON.parse(first)?.ts;
    return ts ? new Date(ts) : undefined;
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch {} }
  }
}

// `retentionDays` used to be a documented default that nothing read. It is
// advisory by design - nothing deletes history on a timer - but advisory is not
// the same as inert, so the gap between the window you asked for and the window
// you actually have is reported here.
// The last history import per agent: fine when it finished, a warning naming
// the exact undo when it stopped part-way (intent 06, D12).
function importRunChecks(config) {
  const { runs, unreadable } = loadImportRuns(config);
  if (unreadable) {
    return [{ id: 'import:runs', status: 'warn', detail: 'imports.json beside the ledger could not be read, so imported runs cannot be checked; the next import moves it aside and starts a new one.' }];
  }
  const last = new Map();
  for (const run of runs) {
    if (run.undone_at || typeof run.agent !== 'string') continue;
    const previous = last.get(run.agent);
    if (!previous || String(run.started_at ?? '') > String(previous.started_at ?? '')) last.set(run.agent, run);
  }
  // A run that stopped before it recorded a count holds only its plan. The rows
  // of that run the ledger holds now are counted instead, so doctor never
  // reports a number it did not measure (#14).
  const uncounted = [...last.values()].filter((run) => !run.finished_at && !Number.isFinite(run.responses_written));
  const inLedger = ledgerRowsOfRuns(config.dataFile, uncounted.map((run) => run.run_id));
  return [...last].map(([agent, run]) => {
    const which = `(mapping ${run.mapping_id}${run.mapping_origin === 'user' ? ', user-local' : ''}, ${run.verification ?? 'unverified'})`;
    const what = `${run.responses_written ?? 0} responses from ${run.sessions_imported ?? 0} sessions ${which}`;
    if (run.finished_at) {
      const result = run.responses_written === 0 && run.responses_skipped_duplicate
        ? `nothing new, ${run.responses_skipped_duplicate} responses were already imported ${which}`
        : what;
      return { id: `import:${agent}`, status: 'ok', detail: `last import finished at ${run.finished_at}: ${result}.` };
    }
    const stopped = `the import started at ${run.started_at} did not finish`;
    const undo = `To remove exactly those, run: tokenwatch import ${agent} --undo ${run.mapping_id} --run ${run.run_id}`;
    const plan = `${run.responses_planned ?? 'an unknown number of'} responses from ${run.sessions_planned ?? 'an unknown number of'} sessions ${which}`;
    if (run.responses_written === 0) {
      return { id: `import:${agent}`, status: 'info', detail: `${stopped} and wrote no rows ${which}; there is nothing to undo.` };
    }
    if (Number.isFinite(run.responses_written)) return { id: `import:${agent}`, status: 'warn', detail: `${stopped}: ${what} were written. ${undo}` };
    const found = inLedger?.get(run.run_id);
    if (found === 0) {
      return { id: `import:${agent}`, status: 'info', detail: `${stopped} and recorded no count; none of its rows are in the ledger (it planned ${plan}), so there is nothing to undo.` };
    }
    if (found) return { id: `import:${agent}`, status: 'warn', detail: `${stopped} and recorded no count; ${found} rows of this run are in the ledger (it planned ${plan}). ${undo}` };
    // The ledger could not be read whole: the plan is the only evidence (D27).
    return { id: `import:${agent}`, status: 'warn', detail: `${stopped}: it recorded no count, and up to ${plan} may have been written. ${undo}` };
  });
}

// How many rows of each named run the ledger holds, counted by the run id every
// imported row carries in its import block. Undefined when the ledger cannot be
// read whole within IMPORT_RUN_SCAN_BYTES: then nothing was measured. A missing
// ledger holds no rows.
function ledgerRowsOfRuns(dataFile, runIds) {
  const counts = new Map(runIds.map((id) => [id, 0]));
  if (!runIds.length) return counts;
  const needles = runIds.map((id) => [id, Buffer.from(`"run_id":${JSON.stringify(String(id))}`)]);
  const keep = Math.max(...needles.map(([, needle]) => needle.length)) - 1;
  let fd;
  try { fd = fs.openSync(dataFile, 'r'); } catch (error) { return error.code === 'ENOENT' ? counts : undefined; }
  try {
    if (fs.fstatSync(fd).size > IMPORT_RUN_SCAN_BYTES) return undefined;
    const chunk = Buffer.alloc(IMPORT_RUN_SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      // A match that lies wholly inside the carried tail was counted last round.
      for (const [id, needle] of needles) {
        for (let at = window.indexOf(needle); at !== -1; at = window.indexOf(needle, at + 1)) {
          if (at + needle.length > carry.length) counts.set(id, counts.get(id) + 1);
        }
      }
      carry = window.subarray(Math.max(0, window.length - keep));
    }
    return counts;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

// A kept user-local mapping outranks the bundled one for every later import
// (intent 19, H-1), so doctor says which one is in use, or that it no longer
// validates. It never moves, rewrites or deletes the file (FR-21).
function userMappingChecks(config) {
  const checks = [];
  for (const agent of AGENTS) {
    const file = userMappingFile(config, agent);
    // A damaged install is reported whether or not the user kept a mapping of
    // their own (third review, D13).
    const shipped = bundledMapping(agent);
    if (shipped.error) {
      checks.push({ id: `import:mapping:${agent}`, status: 'warn', detail: `the bundled ${agent} mapping at ${shipped.error.path} is broken (${shipped.error.message}); reinstall Tokenwatch` });
      continue;
    }
    if (!fs.existsSync(file)) continue;
    const bundled = shipped.mapping.mapping_id;
    try {
      const { mapping } = resolveMapping({ agent, config });
      const from = mapping.evidence?.repaired_from ? ` (repaired from ${mapping.evidence.repaired_from})` : '';
      if (mapping.mapping_id === bundled) {
        checks.push({ id: `import:mapping:${agent}`, status: 'warn', detail: `the user-local mapping at ${file} uses the bundled id ${bundled}, so its rows cannot be told apart from the bundled mapping's or undone alone; give it its own mapping_id` });
        continue;
      }
      checks.push({ id: `import:mapping:${agent}`, status: 'ok', detail: `user-local mapping ${mapping.mapping_id}${from} at ${file} is used instead of the bundled ${bundled}` });
    } catch (error) {
      // readMapping names every read failure (a directory, a denied read, an
      // oversized file) as MAPPING_INVALID, so doctor warns on each of them;
      // the bundled read above is guarded the same way. Anything else is a
      // programming error and surfaces (review-fix, D11, D12).
      if (error.code !== 'MAPPING_INVALID') throw error;
      // A file that could not be read or parsed has no key path to name; its
      // message says why.
      const paths = (error.errors ?? []).filter((entry) => !entry.startsWith('<file:')).join(', ');
      checks.push({ id: `import:mapping:${agent}`, status: 'warn', detail: `the user-local mapping at ${file} is not valid (${paths || error.message}); imports of ${agent} will fail until it is fixed or removed` });
    }
  }
  return checks;
}

// `now` is the instant `runDoctor` judges at, as in `collectionChecks`, so a
// replayed situation gets the verdict it had then rather than today's.
function retentionCheck(config, now) {
  const days = Number(config.retentionDays);
  if (!Number.isFinite(days) || days <= 0) return [];
  // An import appends old history after newer rows, so the first line is no
  // longer the oldest once one has run: the runs record their earliest row
  // (intent 06, D4). An undone run took its rows out again, so it no longer
  // ages the ledger.
  const earliestImported = loadImportRuns(config).runs.filter((run) => !run.undone_at)
    .map((run) => Date.parse(run.earliest_ts ?? run.earliest_planned_ts)).filter(Number.isFinite);
  const firstLine = oldestLedgerEntry(config.dataFile)?.getTime();
  const candidates = [firstLine, ...earliestImported].filter(Number.isFinite);
  const oldest = candidates.length ? new Date(Math.min(...candidates)) : undefined;
  if (!oldest || Number.isNaN(oldest.getTime())) return [];
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const ageDays = Math.floor((nowMs - oldest.getTime()) / 86_400_000);
  if (ageDays <= days) {
    return [{ id: 'retention', status: 'ok', detail: `oldest event is ${ageDays}d old, within the configured ${days}d window.` }];
  }
  return [{
    id: 'retention',
    status: 'warn',
    detail: `oldest event is ${ageDays}d old, past the configured retentionDays of ${days}. Nothing prunes on a timer. Run: tokenwatch prune --retention`
  }];
}

// A cumulative record with no session id cannot be diffed safely, so the store
// declines to diff it and counts the refusal. A non-zero count means some agent
// stopped sending a session id, which is the shape of an upstream field rename
// - and the consequence is missing spend, so it must not stay quiet.
//
// A state file that cannot be read is reported on its own line rather than
// thrown out of `runDoctor`: one truncated file used to end doctor with
// `Cannot read JSON` and no report at all. The store fails on the same file, so
// it is worth naming, and nothing here moves or rewrites it.
//
// A state update stored without its session's lock, because another process
// held the lock past the hook's budget, is counted in the same file
// (`counters.unlocked_writes`, `storeEvent`) until the next `tokenwatch repair`,
// which rebuilds the subagent counts from the ledger and resets the count
// (`repairLedger`). It is named here, only when it happened: the ledger kept
// every row, but a live figure (a subagent count, a running baseline) may have
// missed one update if another write overlapped it.
function unkeyedCumulativeCheck(config) {
  let unkeyed = 0;
  let unlocked = 0;
  let unlockedFiles = 0;
  const unreadable = [];
  for (const file of listSessionStateFiles(config)) {
    const read = readStateFile(file);
    if (read.problem) { unreadable.push(`${file} (${read.problem})`); continue; }
    unkeyed += Number(read.state?.counters?.unkeyed ?? 0);
    const writes = Number(read.state?.counters?.unlocked_writes ?? 0);
    if (writes > 0) { unlocked += writes; unlockedFiles += 1; }
  }
  const checks = [];
  if (unlocked) {
    checks.push({
      id: 'session-state:unlocked-writes',
      status: 'info',
      detail: `${unlocked} state update(s) in ${unlockedFiles} session state file(s) were stored without the session lock since the last repair, because another Tokenwatch process held it for longer than a hook may wait. The ledger kept every row; a live figure on the status line may have missed one of those updates. Run: tokenwatch repair (it rebuilds subagent counts from the ledger and resets this count)`
    });
  }
  if (unreadable.length) {
    checks.push({
      id: 'session-state:unreadable',
      status: 'warn',
      detail: `${unreadable.length} session state file(s) could not be read: ${unreadable.join('; ')}. The store cannot load them either, so nothing more is recorded for those sessions, and agents, analyze, export and repair stop on the same file. doctor leaves them as they are; move a file aside to let its session record again, with its running totals restarting from a new baseline.`
    });
  }
  const unread = unreadable.length ? `; ${unreadable.length} file(s) could not be read (see session-state:unreadable)` : '';
  if (!unkeyed) {
    const scope = unreadable.length ? 'every cumulative record in the readable session state files' : 'every cumulative record';
    checks.push({ id: 'cumulative-session-keys', status: 'ok', detail: `${scope} carried a session id${unread}.` });
    return checks;
  }
  checks.push({
    id: 'cumulative-session-keys',
    status: 'warn',
    detail: `${unkeyed} cumulative record(s) arrived with no session id and were not diffed, so their spend is missing rather than wrong. This usually means an agent renamed its session field${unread}. Check: tokenwatch agents`
  });
  return checks;
}

// One session state file, or why it could not be read. The reason is an error
// code or "not valid JSON", never the parser's message, which quotes the file.
function readStateFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { state: null }; // removed since it was listed
    return { problem: error?.code ?? 'not readable' };
  }
  try { return { state: JSON.parse(text) }; } catch { return { problem: 'not valid JSON' }; }
}

// Why a shared skill would be skipped by Codex, or undefined when it would load.
// These are the rules Codex's own loader applies to `SKILL.md`, read from the
// source at https://github.com/openai/codex: codex-rs/skills/src/parser.rs and
// mentions.rs at rust-v0.154.0, and the 1024-character description cap that
// core/src/skills/loader.rs and core-skills/src/loader.rs enforced from 0.95.0
// through at least 0.140.0. Only a fixed reason is returned, never file text.
function codexSkillProblem(text, directoryName) {
  // Codex compares the first line to `---` after Rust's `trim()`, which keeps
  // U+FEFF. JavaScript's `trim()` removes it, so the mark is checked on its own:
  // an editor saving "UTF-8 with BOM" makes Codex drop the skill without a word
  // (observed with codex-cli 0.154.0).
  if (text.charCodeAt(0) === 0xfeff) return 'it starts with a byte-order mark, so Codex finds no frontmatter';
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return 'it does not open with a --- frontmatter line';
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 2) return 'its frontmatter is empty or never closed with ---';
  const field = (key) => {
    const line = lines.slice(1, end).find((entry) => entry.startsWith(`${key}:`));
    if (line === undefined) return undefined;
    const value = line.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    return value.split(/\s+/).filter(Boolean).join(' ');
  };
  const description = field('description');
  if (!description) return 'it has no description, which Codex requires';
  if ([...description].length > 1024) return 'its description is over 1024 characters, which Codex 0.95.0 to 0.140.0 rejects';
  const name = field('name') || directoryName;
  if ([...name].length > 64) return 'its name is over 64 characters, which Codex rejects';
  // A `$name` mention is only recognised over these characters (mentions.rs),
  // so any other name would load and still be impossible to invoke.
  if (!/^[A-Za-z0-9_:-]+$/.test(name)) return 'its name has characters a $name mention cannot contain';
  return undefined;
}

// Codex 0.95.0 and later read user skills from `$HOME/.agents/skills` and
// repository skills from `.agents/skills` in each directory from the project
// root down to where Codex was started; before 0.95.0 it read only
// `$CODEX_HOME/skills`. Copilot CLI reads the same two `.agents/skills` places.
// Sources: https://learn.chatgpt.com/docs/build-skills,
// codex-rs/ext/skills/src/host_roots.rs at rust-v0.154.0, and
// https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
//
// A skill that is on disk but somewhere Codex does not look, or that Codex
// cannot parse, used to leave `doctor` green while `/skills` listed nothing.
// Reported, never moved or rewritten: the directory is shared with other tools.
function sharedSkillsCheck(installs, homeDir) {
  const checks = [];
  for (const [key, record] of Object.entries(installs)) {
    const skills = record.sharedSkills ?? (record.sharedSkill ? [record.sharedSkill] : []);
    const installed = skills.filter((skill) => skill?.installed && skill.path);
    if (!installed.length) continue;
    const directory = record.paths?.sharedSkills ?? path.dirname(path.dirname(installed[0].path));
    const root = record.scope === 'project' && record.project ? record.project : homeDir ?? os.homedir();
    const expected = path.join(root, '.agents', 'skills');
    let healthy = true;
    if (identityPath(directory) !== identityPath(expected)) {
      healthy = false;
      checks.push({
        id: `${key}:shared-skills:location`,
        status: 'warn',
        detail: `skills were installed to ${directory}, but Codex and Copilot CLI look in ${expected}, so /skills will not list them. Reinstall without --shared-skills: ${reinstallCommand(record, sharedSkillAgents(record))}`
      });
    }
    for (const skill of installed) {
      let text;
      try {
        text = fs.readFileSync(skill.path, 'utf8');
      } catch {
        continue; // A missing file is already an error from `checkFile`.
      }
      const problem = codexSkillProblem(text, path.basename(path.dirname(skill.path)));
      if (!problem) continue;
      healthy = false;
      checks.push({
        id: `${key}:shared:${skill.name ?? 'skill'}:codex`,
        status: 'warn',
        detail: `${skill.path} will be skipped by Codex: ${problem}. Reinstall the bundled text with: ${reinstallCommand(record, sharedSkillAgents(record))}`
      });
    }
    if (healthy) {
      checks.push({
        id: `${key}:shared-skills`,
        status: 'ok',
        // A Copilot refused at install has nothing recording its sessions,
        // so it is not sent to the skills (`<key>:copilot-settings` says why).
        detail: `${installed.length} skill(s) in ${directory}, where Codex 0.95.0+ and Copilot CLI look. In Codex type $tw-<name> or pick from /skills; ${record.copilot?.refused
          ? `Copilot CLI records nothing here until its settings file is repaired (${key}:copilot-settings).`
          : 'in Copilot CLI type /tw-<name>.'} Restart the agent if they are not listed.`
      });
    }
  }
  return checks;
}

// Every other check here inspects configuration Tokenwatch wrote. None of them
// asks whether data is actually arriving, and on the first real Windows install
// that gap was the whole failure: hooks kept writing lifecycle events, so the
// ledger looked alive, while the status line - Claude Code's only source of
// tokens and cost - belonged to another tool and never ran Tokenwatch at all.
// `doctor` reported all-OK for days of zeros. These checks compare what arrived
// with what an installed agent should send, from the ledger itself, so they
// catch the failure whatever caused it.
//
// The window is the last seven days, and never reaches back before the install
// being judged, because events from before it say nothing about it. A fresh
// install with nothing recorded is not a failure until an hour has passed:
// long enough for "install, then doctor" not to raise an alarm, short enough
// that an agent that was used and recorded nothing is reported the same day.
const LIVENESS_WINDOW_MS = 7 * 86_400_000;
const LIVENESS_GRACE_MS = 60 * 60 * 1000;
// Read from the end of the ledger, and bounded: doctor must stay cheap and
// synchronous on a ledger that has been growing for a year. At one record per
// turn this is tens of thousands of turns, far more than a week holds.
const LIVENESS_SCAN_BYTES = 8 * 1024 * 1024;
const LIVENESS_CHUNK_BYTES = 64 * 1024;
// Agents whose token and cost figures arrive only through a status-line command,
// while their hooks carry none (docs/interfaces.md).
const STATUS_LINE_AGENTS = new Set(['claude', 'copilot']);

// What to look at next, by the stage a relay failure happened at. Fixed text
// chosen from the stage and error code, never from the error's message.
function relayFailureHint(entry) {
  if (entry.stage === 'read' || (entry.stage === 'parse' && entry.payload !== 'argument')) {
    return "Codex's JSON payload did not arrive as the relay's last argument; see the notify command line in docs/limitations.md.";
  }
  if (entry.stage === 'parse') return 'A payload arrived but was not valid JSON, which points at how the notify command line was quoted; see docs/limitations.md.';
  if (entry.stage === 'normalize') return 'The payload was not in the shape Tokenwatch reads; Codex may have changed its notify payload.';
  if (['EPERM', 'EACCES', 'EROFS'].includes(entry.code)) return 'The data directory refused the write; see data-directory-write.';
  return 'The ledger or a state file could not be written; see event-store and data-directory-write.';
}

// What one installed agent sent since it was installed, judged against what it
// should send. Pure, so it can be reused and extended by other collection rules
// (a Codex relay-failure record, say) without re-reading the ledger.
//
// `events` may hold any agents' events and any timestamps; only this agent's,
// since `installedAt`, count. `complete: false` means the caller could not scan
// back as far as the install, so an absence is reported as unknown rather than
// as "nothing since install". Returns counts over the window starting at
// `since`, the newest event since install, and a verdict:
//   collecting                   ok    - usage is arriving
//   idle                         info  - nothing in the window, but not provably broken
//   no-activity-yet              info  - installed within the last hour, nothing yet
//   no-events-since-install      warn  - installed over an hour ago, never recorded
//   hooks-without-status-samples warn  - hooks fire, the status line never delivered
//   turns-without-tokens         warn  - Codex turns recorded, none with token counts
// and, for Codex when the caller passes the relay's own record as `relay`
// (`null` when there is none), two that name the cause of missing turns:
//   relay-failing                warn  - the relay ran and failed after its last good record
//   relay-not-running            warn  - no Codex event and no relay run at all since install
export function collectionLiveness(agent, events, { installedAt, now = Date.now(), complete = true, relay } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const installedMs = Date.parse(installedAt ?? '');
  const known = Number.isFinite(installedMs);
  const sinceMs = Math.max(known ? installedMs : -Infinity, nowMs - LIVENESS_WINDOW_MS);
  const name = AGENT_NAMES[agent] ?? agent;
  // Imported history is never evidence that live capture works: a headless
  // session imported yesterday must not make a silent status line read as
  // collecting (intent 06, D4). It is reported as a count beside the verdict.
  const mine = events.filter((event) => event?.agent === name);
  const imported = mine.filter((event) => event.source === 'import');
  const own = mine.filter((event) => event.source !== 'import' && (!known || Date.parse(event.ts) >= installedMs));
  const recent = own.filter((event) => Date.parse(event.ts) >= sinceMs);
  const count = (predicate) => recent.filter(predicate).length;
  const result = {
    agent,
    installed_at: known ? new Date(installedMs).toISOString() : undefined,
    since: new Date(sinceMs).toISOString(),
    complete,
    events: recent.length,
    hook_events: count((event) => event.source === 'hook'),
    status_samples: count((event) => event.source === 'statusline'),
    turns: count((event) => event.source === 'notify'),
    token_records: count((event) => event.usage !== undefined),
    last_event_at: own.map((event) => event.ts).sort().at(-1),
    imported_events: imported.length
  };
  const verdict = (label, status, detail) => ({ ...result, verdict: label, status, detail });
  // The relay's record says what the ledger cannot: that Codex did run the
  // relay and it failed. Judged before the ledger counts, because a relay that
  // recorded turns yesterday and fails on every turn today still has turns in
  // the window, and those turns would otherwise read as healthy.
  const relayKnown = agent === 'codex' && relay !== undefined;
  const relaySummary = relayKnown ? relayRecordSummary(relay, known ? installedMs : -Infinity) : undefined;
  const latestFailure = relaySummary?.failing.at(-1);
  if (latestFailure) {
    const failed = relaySummary.failing.length;
    const count = failed >= relaySummary.max_listed ? `at least ${failed}` : String(failed);
    const since = relaySummary.last_success_at ? `after its last recorded turn at ${relaySummary.last_success_at}` : 'since install, and has not recorded a turn';
    return verdict('relay-failing', 'warn',
      `the Codex notify relay ran and failed ${count} time(s) ${since}; the latest ${describeRelayFailure(latestFailure)}. Codex turns are not being recorded. ${relayFailureHint(latestFailure)}`);
  }
  if (!result.events) {
    if (result.last_event_at) {
      return verdict('idle', 'info', `no ${name} events since ${result.since}; the last was at ${result.last_event_at}. Nothing to check until it runs again.`);
    }
    if (!complete || !known) {
      return verdict('idle', 'info', `no ${name} events found since ${result.since}${complete ? '' : ' in the part of the ledger read'}.`);
    }
    if (nowMs - installedMs < LIVENESS_GRACE_MS) {
      return verdict('no-activity-yet', 'info', `no ${name} events yet since install at ${result.installed_at}. Run a session, then check again.`);
    }
    if (relayKnown && !relaySummary.ran) {
      return verdict('relay-not-running', 'warn',
        `no ${name} events, and no notify relay run recorded, since install at ${result.installed_at}. If Codex has been used since, it never started the relay: check the codex-notify line (config.toml must still run Tokenwatch's relay) and that Codex reads that config.toml (CODEX_HOME). Codex starts notify itself, outside its sandbox; if the relay did start but the data directory refused every write, it could not record that either (see data-directory-write). If Codex has not been used since, run one session and check again.`);
    }
    const route = agent === 'codex'
      ? 'its notify relay is not recording turns'
      : 'its hooks are not reaching Tokenwatch: check the executable and settings lines above, and restart the agent after installing';
    return verdict('no-events-since-install', 'warn',
      `no ${name} events at all since install at ${result.installed_at}. If you have used it since, ${route}. If you have not, run one session and check again.`);
  }
  if (STATUS_LINE_AGENTS.has(agent) && result.hook_events > 0 && result.status_samples === 0) {
    const cause = agent === 'claude'
      ? 'The usual cause is another statusLine taking precedence (see the claude-status-line line); a status line replaced or removed after install does the same.'
      : "The usual cause is that statusLine.command in Copilot's settings.json is not Tokenwatch's.";
    return verdict('hooks-without-status-samples', 'warn',
      `${result.hook_events} hook events but 0 status-line samples from ${name} since ${result.since}: the status line never delivered usage, so no tokens or cost were recorded. ${cause}`);
  }
  if (agent === 'codex' && result.turns > 0 && result.token_records === 0) {
    return verdict('turns-without-tokens', 'warn',
      `${result.turns} Codex turns since ${result.since}, none with token counts: Codex was not launched through tokenwatch-codex, which is the only way Tokenwatch receives Codex tokens. Start Codex with: tokenwatch-codex`);
  }
  const detail = STATUS_LINE_AGENTS.has(agent)
    ? `${result.hook_events} hook events and ${result.status_samples} status-line samples`
    : `${result.turns} turns and ${result.token_records} records with token counts`;
  return verdict('collecting', 'ok', `${result.events} ${name} events since ${result.since}: ${detail}.`);
}

// The ledger's newest records, read backwards in chunks until a whole chunk is
// older than `sinceMs` or the byte bound is reached. Not a strict time cut: a
// buffered status sample is appended when its turn ends, so an old timestamp
// can sit among new ones, and stopping at the first old line would drop the
// fresh records behind it. Lines are split on the newline byte, never inside a
// multi-byte character, and a malformed line is skipped as `readEvents` does.
function recentLedgerEvents(dataFile, sinceMs, maxBytes = LIVENESS_SCAN_BYTES) {
  let handle;
  try { handle = fs.openSync(dataFile, 'r'); } catch { return { events: [], complete: true }; }
  const events = [];
  let complete = true;
  try {
    let position = fs.fstatSync(handle).size;
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (position > 0) {
      if (scanned >= maxBytes) { complete = false; break; }
      const length = Math.min(LIVENESS_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(handle, chunk, 0, length, position);
      scanned += length;
      const combined = Buffer.concat([chunk, carry]);
      const cut = position > 0 ? combined.indexOf(0x0a) : -1;
      if (position > 0 && cut === -1) { carry = combined; continue; }
      carry = position > 0 ? combined.subarray(0, cut) : Buffer.alloc(0);
      let parsed = 0;
      let inWindow = 0;
      for (const line of combined.subarray(cut + 1).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        // Imported rows are old history appended after newer live rows: they
        // never decide when the backward scan stops (intent 06, D4).
        if (event?.source === 'import') {
          if (Date.parse(event.ts) >= sinceMs) events.push(event);
          continue;
        }
        parsed += 1;
        if (Date.parse(event?.ts) >= sinceMs) { events.push(event); inWindow += 1; }
      }
      if (parsed && !inWindow) break;
    }
  } finally {
    try { fs.closeSync(handle); } catch {}
  }
  return { events, complete };
}

// A status-line sample is buffered in its session's state file until the turn
// ends, so the very first turn after an install has hook events in the ledger
// and its samples still pending. Counting only the ledger would report that
// healthy first turn as "hooks without status samples". Read-only: doctor does
// not flush, because a diagnostic should not write the ledger it is judging.
function pendingSampleEvents(config, sinceMs) {
  const events = [];
  for (const file of listSessionStateFiles(config)) {
    try {
      if (fs.statSync(file).mtimeMs < sinceMs) continue;
      const state = readJson(file, null);
      for (const turns of Object.values(state?.pending ?? {})) {
        for (const entry of Object.values(turns ?? {})) if (entry?.event) events.push(entry.event);
      }
    } catch {}
  }
  return events;
}

function collectionChecks(config, installs, now) {
  const installedAt = new Map();
  const earliest = new Map();
  // An agent whose settings file install refused has no hooks and no status
  // line in that install, so it cannot deliver anything through it: it is not
  // judged by its events there, and told to run a session, but reported as
  // not collecting, pointing at the refusal (`<key>:<agent>-settings`).
  const refusedAt = new Map();
  for (const [key, record] of Object.entries(installs)) {
    for (const agent of record.agents ?? []) {
      if (record[agent]?.refused) {
        refusedAt.set(agent, [...(refusedAt.get(agent) ?? []), `${key}:${agent}-settings`]);
        continue;
      }
      // The earliest install of an agent is the one that should have been
      // collecting longest, so it is the one "since install" is measured from.
      const at = record.installedAt;
      const current = installedAt.get(agent);
      if (!installedAt.has(agent) || (at && (!current || at < current))) {
        installedAt.set(agent, at);
        earliest.set(agent, record);
      }
    }
  }
  const refusedOnly = [...refusedAt].filter(([agent]) => !installedAt.has(agent)).map(([agent, ids]) => ({
    id: `collection:${agent}`,
    status: 'warn',
    detail: `nothing is collected from ${AGENT_LABELS[agent] ?? agent}: install refused its settings file (${ids.join(', ')}), so it has no hooks and no status line. That line names the file and the command to run once it is repaired.`
  }));
  if (!installedAt.size) return refusedOnly;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const starts = [...installedAt.values()].map((at) => Date.parse(at ?? ''));
  const scanFrom = starts.every(Number.isFinite) ? Math.min(...starts) : nowMs - LIVENESS_WINDOW_MS;
  const { events, complete } = recentLedgerEvents(config.dataFile, scanFrom);
  events.push(...pendingSampleEvents(config, scanFrom));
  return [...installedAt].map(([agent, at]) => {
    const relay = agent === 'codex' ? readRelayRecord(config) ?? null : undefined;
    const result = collectionLiveness(agent, events, { installedAt: at, now: nowMs, complete, relay });
    // Hooks arriving without status samples is what a lost status line looks
    // like; the remedy is named here, where the record is known, so
    // collectionLiveness stays a pure function of the ledger (intent 16, D12).
    const remedy = result.verdict === 'hooks-without-status-samples' && (agent === 'claude' || agent === 'copilot')
      ? ` Run: ${repairCommand(earliest.get(agent), agent)}` : '';
    return { id: `collection:${agent}`, status: result.status, detail: `${result.detail}${remedy}` };
  }).concat(refusedOnly);
}

// For every install that put Tokenwatch's status line into a Claude settings
// file, which statusLine actually wins. A user-scope install is judged for one
// project directory, the current one unless `projectDir` says otherwise; a
// project-scope install is judged for its own project.
function claudeStatusLineChecks(installs, { projectDir, homeDir }) {
  const checks = [];
  for (const [key, record] of Object.entries(installs)) {
    if (!record.claude?.settingsPath) continue;
    const userScope = record.scope !== 'project';
    const dir = userScope ? projectDir : record.project;
    if (!dir) continue;
    const chain = claudeSettingsChain(userScope
      ? { projectDir: dir, homeDir, userFile: record.claude.settingsPath }
      : { projectDir: dir, homeDir, localFile: record.claude.settingsPath });
    const { winner, unreadable } = winningClaudeStatusLine(chain);
    const caveat = unreadable.length
      ? ` ${unreadable.join(', ')} could not be parsed, so whether it sets a statusLine is unknown.`
      : '';
    let status = 'warn';
    let detail;
    let remedy = '';
    if (!winner) {
      detail = `no statusLine is set in ${chain.map((entry) => entry.file).join(', ')}, so Claude Code sends Tokenwatch no usage for ${dir}.`;
      // A forced reinstall of this record's own scope, in the `Run:` form the
      // status-line skill quotes, and last: a flat user-scope command on a
      // project record would install into another settings file. A file
      // refused at install is repaired first (`<key>:claude-settings`).
      remedy = ` ${record.claude.refused ? `Install refused ${record.claude.settingsPath} (${key}:claude-settings); repair it first. ` : ''}Run: ${reinstallCommand(record, 'claude')}`;
    } else if (winner.tokenwatch) {
      if (!unreadable.length) status = 'ok';
      detail = `${winner.file} sets the statusLine that wins for ${dir}, and it is Tokenwatch's.`;
    } else {
      detail = statusLineShadowMessage(winner, dir, userScope ? undefined : repairCommand(record, 'claude'));
    }
    checks.push({ id: `${key}:claude-status-line`, status, detail: `${detail}${caveat}${remedy}` });
  }
  return checks;
}

// A settings file refused at install is saved in the record (owner decision,
// option B): the agent has no hooks, no status line and no skills there, and
// without this line the gap looked like an agent nobody had used yet. Named by
// file and reason, never by content, with the reinstall for the record's own
// scope, to run once the file is repaired.
const AGENT_LABELS = { claude: 'Claude Code', copilot: 'Copilot CLI' };

function settingsRefusalChecks(installs) {
  const checks = [];
  for (const [key, record] of Object.entries(installs)) {
    for (const agent of ['claude', 'copilot']) {
      const refused = record[agent]?.refused;
      if (!refused) continue;
      const file = agent === 'claude' ? record.claude.settingsPath : record.copilot.configPath;
      checks.push({ id: `${key}:${agent}-settings`, status: 'warn',
        detail: `install did not change ${file}: it ${settingsRefusalReason(refused, agent)}. So Tokenwatch installed no hooks, status line or skills for ${AGENT_LABELS[agent]} there. Repair the file first. Run: ${reinstallCommand(record, agent)}` });
    }
  }
  return checks;
}

// Every command an install record says it wrote, with the install and the
// agent it belongs to.
function recordedCommands(installs) {
  const found = [];
  for (const [key, record] of Object.entries(installs)) {
    const commands = [
      ['claude', record.claude?.statusCommand],
      ...(record.claude?.hooks ?? []).map((hook) => ['claude', hook.command]),
      ['copilot', record.copilot?.statusCommand],
      ['codex', record.codex?.notifyLine]
    ].filter(([, value]) => typeof value === 'string');
    for (const [agent, command] of commands) found.push({ key, agent, command });
  }
  return found;
}

// The leading words of a recorded command, unquoted: the Node executable, then
// the CLI script. Claude Code's and Copilot's commands single-quote each word
// on POSIX (a quote inside one is written `'\''`); on Windows a Claude command
// is a bare `node` then double-quoted words, and an older install wrote a
// double-quoted Node path. A Codex notify line is written as a JSON array,
// which is also valid TOML. No recorded command takes PowerShell's `&` form:
// Copilot's PowerShell hook entries live in its hook file, not in the record.
function commandWords(command) {
  const notify = /^\s*notify\s*=\s*(\[[\s\S]*\])\s*$/.exec(command);
  if (notify) {
    try {
      const argv = JSON.parse(notify[1]);
      return Array.isArray(argv) ? argv.slice(0, 2).map(String) : [];
    } catch {
      return [];
    }
  }
  const words = [];
  let index = 0;
  while (words.length < 2) {
    while (index < command.length && /\s/.test(command[index])) index += 1;
    if (index >= command.length) break;
    let word = '';
    while (index < command.length && !/\s/.test(command[index])) {
      const character = command[index];
      if (character === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) return words;
        word += command.slice(index + 1, close);
        index = close + 1;
      } else if (character === '"') {
        index += 1;
        while (index < command.length && command[index] !== '"') {
          if (command[index] === '\\' && command[index + 1] === '"') { word += '"'; index += 2; } else { word += command[index]; index += 1; }
        }
        index += 1;
      } else if (character === '\\' && command[index + 1] === "'") {
        word += "'";
        index += 2;
      } else {
        word += character;
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

// Where the running CLI lives, and where every recorded install's commands
// point. A hook that runs a script from a temporary or download folder, or
// through a linked source folder, works until that folder is cleaned up or
// moved, and then every agent silently stops recording. Reported, never
// repaired: the fix is a reinstall from a durable copy, which the detail names.
function installLocationChecks(installs) {
  const running = runningInstallLocation();
  const checks = [{ id: 'install-location', status: running.status, detail: running.detail }];
  const seen = new Set([identityPath(running.path)]);
  for (const { key, command } of recordedCommands(installs)) {
    const script = commandWords(command)[1];
    if (!script || seen.has(identityPath(script))) continue;
    seen.add(identityPath(script));
    // Every agent of that install embeds the script, so the reinstall onto a
    // durable copy is the whole install, at its own scope.
    const record = installs[key];
    const recorded = inspectInstallLocation(script, { rerun: reinstallCommand(record, record.agents ?? AGENTS.filter((agent) => record[agent])) });
    if (recorded.status === 'ok') continue;
    checks.push({ id: `${key}:install-location`, status: recorded.status, detail: recorded.detail });
  }
  return checks;
}

// Checking that the Copilot hook file exists said nothing about whether its
// commands run: on Windows every one of them failed to parse in PowerShell, the
// fail-closed `preToolUse` then denied every tool call, and this check still
// passed. So each installed command is executed here, through the shell Copilot
// will use, in probe mode (`PROBE_ENV`), which exits before anything is stored.
// A parse error is found by `doctor` instead of by the agent.
//
// Hooks run through Bash on POSIX and PowerShell on Windows
// (https://docs.github.com/en/copilot/reference/hooks-reference). Copilot's
// runtime asks for `pwsh` and falls back to Windows PowerShell, so the probe
// does the same. The status line goes through Node's `shell: true`, as Copilot
// 1.0.86 spawns it: cmd.exe on Windows, /bin/sh elsewhere. A shell that is not
// on this machine is reported as not checked, never as a failure.

function copilotHookShell(env, platform = process.platform) {
  if (platform === 'win32') {
    for (const name of ['pwsh', 'powershell']) {
      const file = findOnPath(name, env, platform);
      if (file) return { name, kind: 'powershell', file, argsFor: (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
    }
    return { name: 'PowerShell (pwsh or powershell)' };
  }
  const file = findOnPath('bash', env, platform);
  return file ? { name: 'bash', kind: 'bash', file, argsFor: (script) => ['-c', script] } : { name: 'bash' };
}

// Copilot starts a shell per hook; doctor starts one for all of them, because a
// shell per hook was ten PowerShell starts, about 9 s of a 16 s doctor on
// windows-latest. One script is not ten shells, though: joined as plain lines,
// a hook that exited ended the script for the hooks after it, one that did not
// parse took the rest of the script with it, and one that hung was measured
// against the sum of every hook's limit. So each hook is wrapped. The script
// prints a line before it and, after it, its exit code, the errors PowerShell
// recorded while it ran and the time it took; it is parsed only when it runs
// (`eval` in Bash, `[ScriptBlock]::Create` in PowerShell), in Bash inside a
// subshell of its own, and PowerShell's probe variable is set again before
// each. A hook counts as healthy here only if it printed its own probe marker
// between those two lines, exited 0 with no error, and finished inside its own
// limit, counting the shell's start as Copilot's own shell would. Anything
// else - a hook that failed, one that ended the script, the hooks the script
// never reached, a script that did not parse or timed out - is decided by
// running that hook alone, in a shell of its own under its own limit, exactly
// as doctor did before it batched them.
//
// The script is one command-line argument, base64 UTF-16 for PowerShell, and a
// Windows command line holds 32,767 characters: past this, no batch is tried.
const HOOK_BATCH_ARGUMENT_LIMIT = 30_000;

function copilotHookBatchScript(kind, hooks, tag) {
  if (kind === 'powershell') {
    const literal = (text) => `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`;
    return [
      `"${tag} s $([long]([DateTime]::Now - [Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds)"`,
      `function __tw($i, $s) { "${tag} b $i"; $env:${PROBE_ENV} = '1'; $global:LASTEXITCODE = 0; $e = $global:Error.Count; $f = 0; $w = [Diagnostics.Stopwatch]::StartNew(); try { & ([ScriptBlock]::Create($s)) } catch { $f = 1 }; "${tag} e $i $global:LASTEXITCODE $($global:Error.Count - $e + $f) $($w.ElapsedMilliseconds) 1" }`,
      ...hooks.map((hook, index) => `__tw ${index} ${literal(hook.script)}`)
    ].join('\n');
  }
  const literal = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
  return [
    `printf '%s\\n' '${tag} s 0'`,
    `__tw() { local r t1 t0="\${EPOCHREALTIME:-}" s0=$SECONDS; printf '%s\\n' "${tag} b $1"; ( __tw_s=$2; set --; eval "$__tw_s" ); r=$?; t1="\${EPOCHREALTIME:-}"; if [ -n "$t0" ] && [ -n "$t1" ]; then t0=\${t0/[.,]/}; t1=\${t1/[.,]/}; printf '\\n%s\\n' "${tag} e $1 $r 0 $(( (10#$t1 - 10#$t0) / 1000 )) 1"; else printf '\\n%s\\n' "${tag} e $1 $r 0 $(( (SECONDS - s0) * 1000 )) 1000"; fi; }`,
    ...hooks.map((hook, index) => `__tw ${index} ${literal(hook.script)}`)
  ].join('\n');
}

// The hooks the batch shows healthy, by index. The time a hook took is taken
// at its upper bound (Bash without EPOCHREALTIME counts whole seconds), plus
// the time the shell took to start, which a shell of its own would also spend.
function copilotHooksHealthyInBatch(shell, hooks, env) {
  const healthy = new Set();
  if (hooks.length < 2) return healthy;
  const tag = `tw-doctor-${crypto.randomBytes(6).toString('hex')}`;
  const args = shell.argsFor(copilotHookBatchScript(shell.kind, hooks, tag));
  if (args.reduce((total, arg) => total + arg.length + 1, 0) > HOOK_BATCH_ARGUMENT_LIMIT) return healthy;
  const run = probeRun([shell.file, args], env, hooks.reduce((total, hook) => total + hook.seconds, 0) * 1000);
  const startLine = new RegExp(`^${tag} s (\\d+)$`);
  const beginLine = new RegExp(`^${tag} b (\\d+)$`);
  const endLine = new RegExp(`^${tag} e (\\d+) (-?\\d+) (\\d+) (\\d+) (\\d+)$`);
  let startMs = 0;
  let current;
  for (const line of run.stdout.split(/\r?\n/).map((text) => text.trimEnd())) {
    const start = startLine.exec(line);
    const begin = beginLine.exec(line);
    const end = endLine.exec(line);
    if (start) startMs = Number(start[1]);
    else if (begin) current = { index: Number(begin[1]), lines: [] };
    else if (end && current && Number(end[1]) === current.index) {
      const hook = hooks[current.index];
      const [, , code, errors, elapsed, resolution] = end.map(Number);
      if (hook && code === 0 && errors === 0 && startMs + elapsed + resolution <= hook.seconds * 1000
        && current.lines.includes(`${PROBE_MARKER} hook copilot ${hook.eventName}`)) healthy.add(current.index);
      current = undefined;
    } else current?.lines.push(line);
  }
  return healthy;
}

// Runs one command in probe mode and says what went wrong, if anything. The
// detail names the event and the exit status only: the command text is ours,
// but stderr from a shell echoes it back, and the fix is the same either way.
function probe(spawnArgs, expected, env, timeoutMs) {
  const { problem, stdout } = probeRun(spawnArgs, env, timeoutMs);
  if (problem) return problem;
  if (!stdout.includes(expected)) return 'exited 0 without reaching Tokenwatch with the expected arguments';
  return undefined;
}

function probeRun(spawnArgs, env, timeoutMs, input = '') {
  const [file, args, extra] = spawnArgs;
  const result = spawnSync(file, args, {
    ...extra, env: { ...env, [PROBE_ENV]: '1' }, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  const stdout = String(result.stdout ?? '');
  if (result.error?.code === 'ETIMEDOUT') return { problem: `timed out after ${timeoutMs / 1000}s`, stdout };
  if (result.error) return { problem: `could not be started (${result.error.code ?? result.error.name})`, stdout };
  if (result.status !== 0) return { problem: `exited ${result.status ?? result.signal}`, stdout };
  return { stdout };
}

// The agents of a record that read the shared `.agents/skills`, for a remedy
// that reinstalls them. A record always names its agents; one that does not
// falls back to the agent records it holds.
function sharedSkillAgents(record) {
  return ['copilot', 'codex'].filter((agent) => (record.agents ?? []).includes(agent) || record[agent]);
}

// Probe mode is a promise only this CLI keeps. A hook written by another
// Tokenwatch - an older version not yet reinstalled, or another checkout - may
// not know it, and executing that hook records a real, empty event in the
// ledger it points at. That happened: run after an upgrade, this check wrote a
// full round of Copilot hook events into a real ledger each time. So a command
// that does not run this CLI is reported and left unexecuted.
// A composed status line runs another tool's command, recorded at install
// (intent 04, FR-19). What can go wrong later is that the record no longer
// matches the command it was taken from, or that the shell recorded for it has
// gone. Nothing here runs the other command or quotes it: it is not ours to
// execute outside a render, and it can hold a path or a secret of its own.
function composeChecks(config, installs) {
  const checks = [];
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const rank = { ok: 0, info: 1, warn: 2 };
  for (const [key, record] of Object.entries(installs)) {
    for (const agent of ['claude', 'copilot']) {
      const entries = composeEntries(record[agent]);
      if (!record[agent]?.statusInstalled || !entries.length) continue;
      // One check per agent, however many entries: consumers find it by id
      // (intent 16, D13). Each entry is named by its place and its file.
      const states = entries.map((entry) => {
        if (typeof entry.command !== 'string' || entry.sha256 !== hash(entry.command)) {
          return { status: 'warn', text: 'edited by hand (it does not match its recorded hash)' };
        }
        if (entry.carried) {
          return { status: 'info', text: 'kept from an earlier install; it no longer appears in any settings file, so drift cannot be checked' };
        }
        if (entry.level !== 'target') {
          const source = statusLineAt(entry.sourceFile);
          if (typeof source?.command !== 'string') return { status: 'warn', text: 'no longer sets a statusLine, but Tokenwatch still runs the command it set' };
          if (isTokenwatchStatusLine(source) || hash(source.command) !== entry.sha256) {
            return { status: 'warn', text: 'changed since install, so Tokenwatch runs the old command beside its own' };
          }
        }
        // The render asks the same gate, so doctor can never call an entry
        // healthy that the render refuses to run.
        if (!composeSpec(entry)) return { status: 'warn', text: 'refused by the render gate (it runs Tokenwatch, is too long, or names no usable shell), so it does not run' };
        if (entry.shell === 'bash' && !fs.existsSync(entry.shellPath)) {
          return { status: 'warn', text: `Git Bash missing (the recorded ${entry.shellPath} is gone), so it does not run` };
        }
        return { status: 'ok', text: `unchanged since install, run through ${entry.shell}` };
      });
      const lines = states.map((state, index) => `entry ${index + 1} of ${entries.length} (${entries[index].sourceFile ?? 'unknown file'}): ${state.text}`);
      const runnable = entries.filter((entry) => composeSpec(entry)).length;
      if (runnable > MAX_COMPOSE_COMMANDS) {
        states.push({ status: 'warn' });
        lines.push(`${runnable} entries recorded; only the first ${MAX_COMPOSE_COMMANDS} run`);
      }
      const status = states.reduce((worst, state) => (rank[state.status] > rank[worst] ? state.status : worst), 'ok');
      const remedy = status === 'warn' ? ` Run: ${repairCommand(record, agent)}` : '';
      checks.push({ id: `${key}:${agent}-status-compose`, status, detail: `the composed status line runs ${entries.length === 1 ? 'one other command' : `${entries.length} other commands`}: ${lines.join('; ')}.${remedy}` });
    }
  }
  return checks;
}

function foreignCommandCheck(id, count, what, remedy) {
  return { id, status: 'warn',
    detail: `${count} ${what} run a different Tokenwatch than this one, so they were not executed: it may not honour probe mode, and running it would record a real event. Reinstall with this version to check them: ${remedy}` };
}

function copilotCommandChecks(installs, env) {
  const ours = (command) => runsThisCli(command);
  const checks = [];
  for (const [key, record] of Object.entries(installs)) {
    const copilot = record.copilot;
    if (!copilot) continue;
    if (copilot.hooksCreated && copilot.hooksPath) {
      // An unreadable file is already reported by the `copilotHooks` check.
      let document = null;
      try { document = readJson(copilot.hooksPath, null); } catch {}
      const hooks = document?.hooks && typeof document.hooks === 'object' ? document.hooks : {};
      const failClosed = Object.keys(hooks).filter((eventName) => FAIL_CLOSED_HOOK_EVENTS.copilot.includes(eventName));
      if (failClosed.length) {
        checks.push({ id: `${key}:copilot-fail-closed-hooks`, status: 'warn',
          detail: `${copilot.hooksPath} registers ${failClosed.join(', ')}, which denies the agent's action whenever the hook fails. An older Tokenwatch wrote this. Rewrite it with: ${reinstallCommand(record, 'copilot')}` });
      }
      const shell = copilotHookShell(env);
      const entries = Object.entries(hooks).flatMap(([eventName, list]) => (Array.isArray(list) ? list : []).map((entry) => ({ eventName, entry })));
      if (!shell.file) {
        checks.push({ id: `${key}:copilot-hooks-run`, status: 'info',
          detail: `${shell.name} is not on PATH here, so the ${entries.length} Copilot hook command(s) were not executed. Copilot needs the same shell to run them.` });
      } else {
        // One shell for every healthy hook; each other hook alone, as Copilot
        // runs it (copilotHooksHealthyInBatch).
        let foreign = 0;
        const own = [];
        for (const { eventName, entry } of entries) {
          const script = process.platform === 'win32' ? entry?.powershell ?? entry?.command : entry?.bash ?? entry?.command;
          if (typeof script !== 'string') continue;
          if (!ours(script)) { foreign += 1; continue; }
          const seconds = Number(entry.timeoutSec ?? entry.timeout ?? 30);
          own.push({ eventName, script, seconds: seconds > 0 ? seconds : 30 });
        }
        const healthy = copilotHooksHealthyInBatch(shell, own, env);
        let failures = 0;
        for (const [index, { eventName, script, seconds }] of own.entries()) {
          if (healthy.has(index)) continue;
          const problem = probe([shell.file, shell.argsFor(script)], `${PROBE_MARKER} hook copilot ${eventName}`, env, seconds * 1000);
          if (!problem) continue;
          failures += 1;
          const consequence = FAIL_CLOSED_HOOK_EVENTS.copilot.includes(eventName)
            ? 'Copilot denies the tool call when this hook fails'
            : 'Copilot skips it and records nothing';
          checks.push({ id: `${key}:copilot-hook:${eventName}`, status: 'error',
            detail: `the ${eventName} hook ${problem} under ${shell.name} before Tokenwatch could record anything; ${consequence}. Reinstall with: ${reinstallCommand(record, 'copilot')}` });
        }
        if (foreign) checks.push(foreignCommandCheck(`${key}:copilot-hooks-run`, foreign, 'Copilot hook command(s)', reinstallCommand(record, 'copilot')));
        else if (!failures) {
          checks.push({ id: `${key}:copilot-hooks-run`, status: 'ok',
            detail: `${entries.length} Copilot hook command(s) ran through ${shell.name} and reached Tokenwatch (probe mode, nothing stored).` });
        }
      }
    }
    if (copilot.statusInstalled && copilot.statusCommand && copilot.configPath) {
      let current;
      try { current = readJsonc(copilot.configPath, {})?.statusLine?.command; } catch {}
      // Only the command Copilot will actually run. Someone else's status line
      // now in that slot is theirs to test.
      if (current === copilot.statusCommand && !ours(current)) {
        checks.push(foreignCommandCheck(`${key}:copilot-status-run`, 1, 'Copilot status-line command', reinstallCommand(record, 'copilot')));
      } else if (current === copilot.statusCommand) {
        const shellName = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const problem = probe([current, [], { shell: true }], `${PROBE_MARKER} status --agent copilot`, env, 10_000);
        checks.push(problem
          ? { id: `${key}:copilot-status-run`, status: 'error', detail: `the Copilot status-line command ${problem} under ${shellName}, so the status line shows nothing. Reinstall with: ${reinstallCommand(record, 'copilot')}` }
          : { id: `${key}:copilot-status-run`, status: 'ok', detail: `the Copilot status-line command ran through ${shellName} and reached Tokenwatch (probe mode, nothing stored).` });
      }
    }
  }
  return checks;
}

// Claude Code's half of the check above (intent 17). Claude Code runs hooks
// and its status line through one shell: /bin/sh off Windows, Git Bash on
// Windows when installed, else PowerShell (https://code.claude.com/docs/en/hooks,
// /statusline). A command that shell cannot parse records nothing, silently,
// and nothing else here would notice. So each installed command runs through
// that shell in probe mode, built by the same shellLineInvocation the composed
// status line uses, and the status probe also shows its stdin arrived (D7).
const SHELL_NAMES = { posix: '/bin/sh', bash: 'Git Bash', powershell: 'PowerShell' };
// What the status probe feeds the command, and so how many bytes should arrive.
const STATUS_PROBE_INPUT = '{}';

function claudeShellAvailable(spec, env, platform) {
  if (spec.shell === 'bash') return Boolean(spec.shellPath && fs.existsSync(spec.shellPath));
  if (spec.shell === 'powershell') return Boolean(findOnPath(platform === 'win32' ? 'powershell' : 'pwsh', env, platform));
  return true;
}

// On Windows, the shell Claude Code would use if Git Bash came or went. Its
// verdict is information only: it is not the shell running the commands now.
function otherClaudeShell(primary, env, platform) {
  if (platform !== 'win32' || primary.shell !== 'bash') return undefined;
  return { shell: 'powershell' };
}

function claudeProbe(commands, spec, env, platform, record) {
  const invocation = (line) => {
    const { file, args, shell } = shellLineInvocation(line, spec, platform);
    return [file, args, { shell }];
  };
  const hookSeconds = commands.hooks.reduce((total, hook) => total + (Number(hook.timeout) > 0 ? Number(hook.timeout) : 5), 0);
  const hookRun = commands.hooks.length
    ? probeRun(invocation(commands.hooks.map((hook) => hook.command).join('\n')), env, hookSeconds * 1000)
    : { stdout: '' };
  const hookProblems = commands.hooks.map(({ eventName }) => {
    const reached = hookRun.stdout.split(/\r?\n/).includes(`${PROBE_MARKER} hook claude ${eventName}`);
    return { eventName, problem: reached ? undefined : hookRun.problem ?? 'exited without reaching Tokenwatch with the expected arguments' };
  }).filter((hook) => hook.problem);
  let statusProblem;
  let statusWarning;
  let stdinBytes;
  if (commands.status) {
    const run = probeRun(invocation(commands.status), env, 10_000, STATUS_PROBE_INPUT);
    const marker = run.stdout.split(/\r?\n/).find((line) => line.startsWith(`${PROBE_MARKER} status --agent claude`));
    const arrived = / stdin=(\d+|error)$/.exec(marker ?? '')?.[1];
    const expected = Buffer.byteLength(STATUS_PROBE_INPUT);
    if (!marker) statusProblem = run.problem ?? 'exited without reaching Tokenwatch with the expected arguments';
    else if (!arrived || arrived === 'error' || arrived === '0') statusProblem = 'reached Tokenwatch but its stdin did not, so a real render would receive no payload';
    else {
      stdinBytes = Number(arrived);
      // A shell may re-encode what it passes on (Windows PowerShell 5.1 can add
      // a byte-order mark, which the parser strips). Measured and named, not
      // assumed either way (review HIGH 1).
      if (stdinBytes !== expected) statusWarning = `its stdin arrived as ${stdinBytes} bytes for a ${expected}-byte payload, so the shell may be re-encoding what Claude Code sends`;
    }
  }
  // A Node below 20 on PATH fails to load the CLI; say which one it was.
  const nodeNote = record.claude?.commandShell === 'gitbash-or-powershell' && (hookProblems.length || statusProblem)
    ? ` (node on PATH: ${findOnPath('node', env, platform) ?? 'none'}; Tokenwatch needs Node 20+)` : '';
  return { hookProblems, statusProblem, statusWarning, stdinBytes, nodeNote };
}

export function claudeCommandChecks(installs, env, platform = process.platform) {
  const checks = [];
  for (const [key, record] of Object.entries(installs)) {
    const claude = record.claude;
    if (!claude?.settingsPath) continue;
    // A settings file refused at install wrote nothing and is reported by its
    // own `<key>:claude-settings` line.
    if (claude.refused) continue;
    // Read with the grammar the installer edits with, which accepts the
    // byte-order mark a Windows editor saves: plain JSON.parse threw on it, and
    // the probes for that install were skipped without a word. A file that still
    // cannot be read is said so here, named but never quoted.
    let settings = null;
    try {
      settings = readJsonc(claude.settingsPath, null);
    } catch (error) {
      const reason = String(error?.message ?? '').split(': ').pop() || 'unreadable';
      checks.push({ id: `${key}:claude-hooks-run`, status: 'warn',
        detail: `${claude.settingsPath} could not be read here (${reason}), so its Claude Code commands were not run. Repair the file, then run tokenwatch doctor again.` });
      continue;
    }
    if (!settings || typeof settings !== 'object') continue;
    const present = (hook) => (settings.hooks?.[hook.eventName] ?? []).some((entry) =>
      (entry?.hooks ?? []).some((candidate) => candidate?.type === 'command' && candidate.command === hook.command));
    const hooks = (claude.hooks ?? []).filter((hook) => typeof hook?.command === 'string' && present(hook))
      .map((hook) => ({ ...hook, timeout: 5 }));
    const ownHooks = hooks.filter((hook) => runsThisCli(hook.command));
    const foreignHooks = hooks.length - ownHooks.length;
    const statusCurrent = claude.statusInstalled && typeof claude.statusCommand === 'string'
      && settings.statusLine?.command === claude.statusCommand ? claude.statusCommand : undefined;
    const ownStatus = statusCurrent && runsThisCli(statusCurrent) ? statusCurrent : undefined;
    if (foreignHooks) checks.push(foreignCommandCheck(`${key}:claude-hooks-run`, foreignHooks, 'Claude Code hook command(s)', reinstallCommand(record, 'claude')));
    if (statusCurrent && !ownStatus) checks.push(foreignCommandCheck(`${key}:claude-status-run`, 1, 'Claude Code status-line command', reinstallCommand(record, 'claude')));
    const commands = { hooks: ownHooks, status: ownStatus };
    const count = ownHooks.length + (ownStatus ? 1 : 0);
    if (!count) continue;
    const reinstall = `Reinstall with: ${reinstallCommand(record, 'claude')}`;
    const primary = claudeShell({ platform, env });
    const primaryName = SHELL_NAMES[primary.shell];
    if (!claudeShellAvailable(primary, env, platform)) {
      checks.push({ id: `${key}:claude-hooks-run`, status: 'info',
        detail: `${primaryName} is not on PATH here, so the ${count} Claude Code command(s) were not executed. Claude Code needs the same shell to run them.` });
      continue;
    }
    const { hookProblems, statusProblem, statusWarning, stdinBytes, nodeNote } = claudeProbe(commands, primary, env, platform, record);
    for (const { eventName, problem } of hookProblems) {
      checks.push({ id: `${key}:claude-hook:${eventName}`, status: 'error',
        detail: `the ${eventName} hook ${problem} under ${primaryName} before Tokenwatch could record anything${nodeNote}; Claude Code skips it and records nothing. ${reinstall}` });
    }
    if (ownHooks.length && !hookProblems.length && !foreignHooks) {
      checks.push({ id: `${key}:claude-hooks-run`, status: 'ok',
        detail: `${ownHooks.length} Claude Code hook command(s) ran through ${primaryName} and reached Tokenwatch (probe mode, nothing stored).` });
    }
    if (ownStatus) {
      if (statusProblem) {
        checks.push({ id: `${key}:claude-status-run`, status: 'error',
          detail: `the Claude Code status-line command ${statusProblem} under ${primaryName}${nodeNote}, so the status line shows nothing and Claude Code's tokens and cost are not recorded. ${reinstall}` });
      } else if (statusWarning) {
        checks.push({ id: `${key}:claude-status-run`, status: 'warn',
          detail: `the Claude Code status-line command ran through ${primaryName} and reached Tokenwatch, but ${statusWarning}. Tokenwatch strips a byte-order mark; check that the status line shows figures.` });
      } else {
        checks.push({ id: `${key}:claude-status-run`, status: 'ok',
          detail: `the Claude Code status-line command ran through ${primaryName}, received its ${stdinBytes}-byte stdin intact, and reached Tokenwatch (probe mode, nothing stored).` });
      }
    }
    const other = otherClaudeShell(primary, env, platform);
    if (other && claudeShellAvailable(other, env, platform)) {
      const result = claudeProbe(commands, other, env, platform, record);
      const failed = result.hookProblems.length + (result.statusProblem ? 1 : 0);
      checks.push({ id: `${key}:claude-hooks-run:${SHELL_NAMES[other.shell]}`, status: 'info',
        detail: failed
          ? `${failed} of ${count} Claude Code command(s) would not reach Tokenwatch under ${SHELL_NAMES[other.shell]}. Claude Code uses ${primaryName} on this machine, so this matters only if that changes.`
          : `all ${count} Claude Code command(s) also reach Tokenwatch under ${SHELL_NAMES[other.shell]}, the shell Claude Code uses when Git Bash is absent.` });
    }
  }
  return checks;
}

// `otlp-bind` used to be the only receiver line, and it printed
// `OK otlp-bind: 127.0.0.1:4318` on the Windows machine where nothing was
// listening - it checks the configured host, not the port. So the receiver is
// asked directly: a GET of the `/health` route every Tokenwatch receiver
// answers, from a short-lived child process. A child, because `runDoctor` is
// synchronous and a report every skill consumes should stay so; `spawnSync`
// bounds it the way the Copilot command probes are bounded. It connects only
// to the configured loopback host, so doctor still opens nothing outward.
const RECEIVER_PROBE_TIMEOUT_MS = 1000;
const RECEIVER_PROBE = `
const http = require('node:http');
const [host, port, timeout] = process.argv.slice(1);
const done = (result) => { process.stdout.write(JSON.stringify(result)); process.exit(0); };
const request = http.get({ host, port: Number(port), path: '/health', timeout: Number(timeout) }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { if (body.length < 1024) body += chunk; });
  res.on('end', () => {
    let ours = false;
    try { const parsed = JSON.parse(body); ours = parsed && parsed.ok === true && parsed.service === 'tokenwatch-otlp'; } catch {}
    done({ result: ours ? 'tokenwatch' : 'other', status: res.statusCode });
  });
});
request.on('timeout', () => done({ result: 'no-answer' }));
request.on('error', (error) => done({ result: error.code === 'ECONNREFUSED' ? 'refused' : 'error', code: error.code }));
`;

function probeReceiver(host, port) {
  const run = spawnSync(process.execPath, ['-e', RECEIVER_PROBE, '--', host, String(port), String(RECEIVER_PROBE_TIMEOUT_MS)], {
    encoding: 'utf8', timeout: RECEIVER_PROBE_TIMEOUT_MS * 5, windowsHide: true
  });
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { result: 'error', code: run.error?.code ?? 'ENOPROBE' };
  }
}

function otlpReceiverCheck(config) {
  const host = String(config.codex.otlpHost ?? '');
  const port = Number(config.codex.otlpPort);
  const where = `${host}:${config.codex.otlpPort}`;
  const notChecked = (why) => ({ id: 'otlp-receiver', status: 'info', detail: `not checked: ${why}.` });
  if (!isLoopbackHost(host)) return notChecked(`${host} is not a loopback address (see otlp-bind), and doctor connects to nothing else`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return notChecked(`port ${config.codex.otlpPort} is not one Codex can send to`);
  const probe = probeReceiver(host, port);
  if (probe.result === 'tokenwatch') {
    return { id: 'otlp-receiver', status: 'ok', detail: `a Tokenwatch receiver is running on ${where}, so Codex tokens sent there are being recorded.` };
  }
  if (probe.result === 'refused') {
    return { id: 'otlp-receiver', status: 'info',
      detail: `no receiver on ${where} - Codex tokens are only captured while tokenwatch-codex is running. That is normal when Codex is not in use; start Codex with tokenwatch-codex.` };
  }
  if (probe.result === 'other' || probe.result === 'no-answer') {
    const seen = probe.result === 'other' ? `something else answers there (HTTP ${probe.status})` : `something accepts connections there but did not answer within ${RECEIVER_PROBE_TIMEOUT_MS / 1000}s`;
    return { id: 'otlp-receiver', status: 'warn',
      detail: `${seen}, and it is not Tokenwatch's receiver. Direct Codex exports to ${where} will not reach Tokenwatch. Start Codex with tokenwatch-codex: the wrapper uses an independent OS-assigned port when the configured port is occupied.` };
  }
  return notChecked(`the probe could not connect (${probe.code ?? 'unknown error'})`);
}

// What the relay's own record says, reported on its own line so that the
// time of the last good record and the latest failure are visible even when
// the collection verdict is about something else.
function codexRelayCheck(config, installedMs) {
  const summary = relayRecordSummary(readRelayRecord(config), installedMs);
  if (!summary.ran) {
    return { id: 'codex-relay', status: 'info', detail: 'the Codex notify relay has recorded no run since install. It records every run, success or failure, so if Codex has been used since, see collection:codex.' };
  }
  const latest = summary.failing.at(-1);
  if (latest) {
    return { id: 'codex-relay', status: 'warn',
      detail: `${summary.last_success_at ? `last recorded turn: ${summary.last_success_at}; ${summary.failing.length} failed run(s) after it` : `no recorded turn since install; ${summary.failing.length} failed run(s)`}, the latest ${describeRelayFailure(latest)}.` };
  }
  const spawn = summary.spawn_failures.at(-1);
  if (spawn && !(Date.parse(spawn.at) < Date.parse(summary.last_success_at ?? ''))) {
    return { id: 'codex-relay', status: 'warn',
      detail: `last recorded turn: ${summary.last_success_at ?? 'none since install'}. The notifier Tokenwatch displaced, which it passes each payload on to, could not be started ${describeRelayFailure(spawn)}.` };
  }
  return { id: 'codex-relay', status: 'ok', detail: `last recorded turn: ${summary.last_success_at}.` };
}

// Every place Codex capture can fail without saying so, checked only where
// Codex is installed: the notify line Codex runs, the relay's own record of
// its runs, and whether a receiver is actually listening.
function codexCaptureChecks(config, installs) {
  const codex = Object.entries(installs).filter(([, record]) => (record.agents ?? []).includes('codex') || record.codex);
  if (!codex.length) return [];
  const checks = [];
  for (const [key, record] of codex) {
    if (!record.codex?.configPath) continue;
    const state = codexNotifyState(record.codex.configPath);
    // The install found `notify` already running another program and, as it
    // must without --force, left it alone - so no relay was ever written and
    // Codex has never told Tokenwatch about a turn. This used to print nothing
    // at all, while collection:codex pointed at a codex-notify line that did
    // not exist. Found on a real machine whose notify belonged to another tool.
    if (!record.codex.notifyLine) {
      if (state === 'relay') {
        checks.push({ id: `${key}:codex-notify`, status: 'ok', detail: `${record.codex.configPath} runs Tokenwatch's relay after every Codex turn.` });
      } else if (state === 'other') {
        const kept = key === 'user'
          ? 'Your notifier is kept: the relay passes each turn on to it, and uninstall restores it.'
          : 'Your notifier line is restored on uninstall; at project scope the relay does not run it, because a cloned repository may have chosen it.';
        checks.push({ id: `${key}:codex-notify`, status: 'warn',
          detail: `Tokenwatch's Codex relay was never installed: ${record.codex.configPath} already ran another notifier at install time, and install leaves an existing notifier alone. Codex records no turns into Tokenwatch. To add the relay: ${reinstallCommand(record, 'codex')}. ${kept}` });
      }
      continue;
    }
    if (state === 'relay') {
      checks.push({ id: `${key}:codex-notify`, status: 'ok', detail: `${record.codex.configPath} runs Tokenwatch's relay after every Codex turn.` });
    } else if (state !== 'missing') {
      const now = { other: 'runs a different notifier', none: 'has no notify line', unreadable: 'could not be read' }[state];
      checks.push({ id: `${key}:codex-notify`, status: 'warn',
        detail: `${record.codex.configPath} ${now}, so Codex does not start Tokenwatch's relay and records no turns. Reinstall with: ${reinstallCommand(record, 'codex')}` });
    }
  }
  const starts = codex.map(([, record]) => Date.parse(record.installedAt ?? '')).filter(Number.isFinite);
  checks.push(codexRelayCheck(config, starts.length ? Math.min(...starts) : -Infinity));
  checks.push(otlpReceiverCheck(config));
  return checks;
}

// An agent settings file the record names. One install refused is known not to
// be editable, so it is not reported `ok` for merely existing: it points at the
// check that says why (`refusal`, the `<key>:<agent>-settings` id), and that
// check carries the remedy.
function settingsFileCheck(file, label, refusal) {
  if (!refusal) return checkFile(file, label, true);
  return { id: label, status: 'info', detail: `${file}: install refused this file and changed nothing in it; see ${refusal}.` };
}

// A skill backup holds the text of a skill a forced install replaced, which
// can be a team's notes. Uninstall restores it and deletes it; a record that no
// longer names it (a second forced install over a skill edited again records
// only the newer backup, and uninstall forgets one it could not restore) leaves
// it with nothing to restore or remove it. Reported by file name, never by its
// text, and never deleted: doctor reports, it does not repair.
function orphanedSkillBackupCheck(config, installs) {
  const dir = skillBackupDir(config);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const named = new Set();
  for (const record of Object.values(installs)) {
    for (const key of ['claudeSkills', 'sharedSkills', 'claudeSkill', 'sharedSkill']) {
      for (const skill of [record[key]].flat()) if (typeof skill?.backup === 'string') named.add(identityPath(path.resolve(skill.backup)));
    }
  }
  const orphans = entries.filter((entry) => !entry.isDirectory()).map((entry) => path.join(dir, entry.name))
    .filter((file) => !named.has(identityPath(file)));
  if (!orphans.length) return [];
  return [{ id: 'skill-backups:orphaned', status: 'warn',
    detail: `${orphans.length} skill backup(s) are named by no install record, so neither uninstall nor a reinstall will restore or remove them: ${orphans.join(', ')}. Each holds the text of a skill a forced install replaced. Keep what you need and remove the rest by hand.` }];
}

function checkFile(file, label, required = false) {
  try {
    const stat = fs.statSync(file);
    return { id: label, status: stat.isFile() ? 'ok' : 'warn', detail: file };
  } catch (error) {
    return { id: label, status: required ? 'error' : 'info', detail: `${file} (${error.code === 'ENOENT' ? 'not created yet' : error.message})` };
  }
}

// `doctor` loads its configuration without creating it (`main()`), so on a
// machine where nothing has run yet there is no file here, and saying `ok` for
// it would vouch for a file that does not exist. Every other command writes it
// on first use, with the random salt that keeps project identities stable.
function configFileCheck(configFile) {
  try {
    fs.statSync(configFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { id: 'config', status: 'info', detail: `${configFile} (not created yet; doctor used the defaults. The first other tokenwatch command writes it, with this installation's random project salt.)` };
    }
  }
  return checkFile(configFile, 'config', true);
}

// Whether Tokenwatch can write its data directory, judged without creating it:
// doctor observes, and the first command that records creates the directory
// itself. A missing one is judged by the nearest directory that does exist.
function dataDirectoryCheck(dataDir) {
  const id = 'data-directory-write';
  let stat;
  try {
    stat = fs.statSync(dataDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { id, status: 'error', detail: error.message };
    let parent = path.dirname(dataDir);
    while (parent !== path.dirname(parent) && !fs.existsSync(parent)) parent = path.dirname(parent);
    try {
      if (!fs.statSync(parent).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      fs.accessSync(parent, fs.constants.W_OK);
    } catch (problem) {
      return { id, status: 'error', detail: `${dataDir} does not exist, and it cannot be created in ${parent} (${problem.code ?? problem.message}).` };
    }
    return { id, status: 'info', detail: `${dataDir} (not created yet; ${parent} is writable, so the first command that records creates it).` };
  }
  if (!stat.isDirectory()) return { id, status: 'error', detail: `${dataDir} is not a directory.` };
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (error) {
    return { id, status: 'error', detail: error.message };
  }
  return { id, status: 'ok', detail: dataDir };
}

// `now`, `projectDir` and `homeDir` exist so the collection and status-line
// checks can be judged at a fixed instant, for a given project, against a given
// home directory - which is what lets a test replay a situation without reading
// the real `~/.claude`.
export function runDoctor(config, configFile, { env = process.env, now = Date.now(), projectDir = process.cwd(), homeDir } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node', status: nodeMajor >= 20 ? 'ok' : 'error', detail: `Node ${process.versions.node}; Node 20+ is required.` });
  checks.push(configFileCheck(configFile));
  checks.push(checkFile(config.dataFile, 'event-store', false));
  checks.push(checkFile(config.stateFile, 'state', false));
  const dataDir = path.dirname(config.dataFile);
  checks.push(dataDirectoryCheck(dataDir));
  // Reported rather than silently corrected: this directory may predate the
  // install, and changing another party's permissions without asking is the
  // behaviour this tool avoids elsewhere. POSIX modes only; Windows ACLs do not
  // map onto them, so the check is skipped there rather than reported wrongly.
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(dataDir).mode & 0o777;
      const loose = (mode & 0o077) !== 0;
      checks.push({
        id: 'data-directory-permissions',
        status: loose ? 'warn' : 'ok',
        detail: loose
          ? `${dataDir} is mode ${mode.toString(8)}; it holds cost data and session state. Run: chmod 700 ${dataDir}`
          : `${dataDir} is mode ${mode.toString(8)}.`
      });
    } catch {}
  }
  if (config.pricingFile) {
    try {
      const pricing = loadPricing(config.pricingFile);
      checks.push({ id: 'pricing', status: 'ok', detail: `${pricing.models.length} model rules; version ${pricing._version}` });
    } catch (error) {
      checks.push({ id: 'pricing', status: 'error', detail: error.message });
    }
  } else checks.push({ id: 'pricing', status: 'info', detail: 'No local pricing file. Provider-reported costs still work; token-only streams remain unpriced.' });
  const installs = listInstalls(config);
  checks.push({ id: 'installs', status: Object.keys(installs).length ? 'ok' : 'info', detail: `${Object.keys(installs).length} managed installation(s).` });
  for (const [key, record] of Object.entries(installs)) {
    if (record.claude?.settingsPath) checks.push(settingsFileCheck(record.claude.settingsPath, `${key}:claudeSettings`, record.claude.refused && `${key}:claude-settings`));
    const claudeSkills = record.claudeSkills ?? (record.claudeSkill ? [record.claudeSkill] : []);
    for (const skill of claudeSkills) {
      if (skill?.path) checks.push(checkFile(skill.path, `${key}:claude:${skill.name ?? 'skill'}`, true));
      checks.push(...skillDigestCheck(skill, `${key}:claude`, reinstallCommand(record, 'claude')));
    }
    if (record.copilot?.configPath) checks.push(settingsFileCheck(record.copilot.configPath, `${key}:copilotConfig`, record.copilot.refused && `${key}:copilot-settings`));
    if (record.copilot?.hooksCreated && record.copilot.hooksPath) checks.push(checkFile(record.copilot.hooksPath, `${key}:copilotHooks`, true));
    if (record.codex?.configPath) checks.push(checkFile(record.codex.configPath, `${key}:codexConfig`, true));
    const sharedSkills = record.sharedSkills ?? (record.sharedSkill ? [record.sharedSkill] : []);
    for (const skill of sharedSkills) {
      if (skill?.path) checks.push(checkFile(skill.path, `${key}:shared:${skill.name ?? 'skill'}`, true));
      checks.push(...skillDigestCheck(skill, `${key}:shared`, reinstallCommand(record, sharedSkillAgents(record))));
    }
    if (record.paths?.claudeSkills) {
      const tracked = new Set(claudeSkills.map((skill) => skill.name));
      for (const orphan of findOrphanedSkills(record.paths.claudeSkills, tracked)) {
        checks.push({ id: `${key}:claude:orphaned-skill`, status: 'warn',
          detail: `${path.join(record.paths.claudeSkills, orphan)} is not part of the current bundle or install record. Likely a renamed or removed skill left behind; remove it by hand if you do not need it.` });
      }
    }
    if (record.paths?.sharedSkills) {
      const tracked = new Set(sharedSkills.map((skill) => skill.name));
      for (const orphan of findOrphanedSkills(record.paths.sharedSkills, tracked)) {
        checks.push({ id: `${key}:shared:orphaned-skill`, status: 'warn',
          detail: `${path.join(record.paths.sharedSkills, orphan)} is not part of the current bundle or install record. Likely a renamed or removed skill left behind; remove it by hand if you do not need it.` });
      }
    }
  }
  checks.push(...orphanedSkillBackupCheck(config, installs));
  // Every installed hook, status line and Codex notify array hard-codes the
  // absolute path of whichever Node ran `install`. Under nvm, fnm or volta that
  // path is version-specific, so `nvm use 22` or removing an old version leaves
  // every integration pointing at an executable that is no longer there. The
  // failure is silent - hooks just stop firing - and until now `doctor` reported
  // all-green while no telemetry was being collected at all.
  // Each executable is reported once, under the first install that recorded
  // it, with the agents of that install whose commands start it: those are
  // what the reinstall has to rewrite.
  const recordedExecutables = new Map();
  for (const { key, agent, command } of recordedCommands(installs)) {
    const [executable] = commandWords(command);
    if (!executable) continue;
    if (!recordedExecutables.has(executable)) recordedExecutables.set(executable, { key, agents: new Set() });
    const entry = recordedExecutables.get(executable);
    if (entry.key === key) entry.agents.add(agent);
  }
  for (const [executable, { key, agents }] of recordedExecutables) {
    // A bare name is what a shell resolves on PATH: Claude Code's Windows
    // commands start `node` that way (intent 17, D12).
    if (!/[\\/]/.test(executable)) {
      if (!findOnPath(executable, env)) {
        checks.push({ id: `${key}:executable`, status: 'error',
          detail: `\`${executable}\` is not on PATH here; Claude Code's commands start the \`${executable}\` found on PATH. Install Node 20+ on PATH, then reinstall with: ${reinstallCommand(installs[key], 'claude')}` });
      }
      continue;
    }
    let missing = false;
    try { fs.accessSync(executable, fs.constants.X_OK); } catch { missing = true; }
    if (missing) {
      checks.push({
        id: `${key}:executable`,
        status: 'error',
        detail: `${executable} is recorded in an installed command but is not executable. A Node version manager may have moved or removed it. Re-run: ${reinstallCommand(installs[key], AGENTS.filter((agent) => agents.has(agent)))}`
      });
    }
  }
  checks.push(...copilotCommandChecks(installs, env));
  checks.push(...claudeCommandChecks(installs, env));
  checks.push(...settingsRefusalChecks(installs));
  checks.push(...claudeStatusLineChecks(installs, { projectDir, homeDir }));
  checks.push(...composeChecks(config, installs));
  checks.push(...collectionChecks(config, installs, now));
  checks.push(...retentionCheck(config, now));
  checks.push(...importRunChecks(config));
  checks.push(...userMappingChecks(config));
  checks.push(...unkeyedCumulativeCheck(config));
  checks.push(...installLocationChecks(installs));
  checks.push(...sharedSkillsCheck(installs, homeDir));
  // The same definition `otlp-receiver` and the receiver itself use, so one
  // host is never warned about here and connected to as loopback there.
  const hostSafe = isLoopbackHost(config.codex.otlpHost);
  checks.push({
    id: 'otlp-bind',
    status: hostSafe ? 'ok' : 'warn',
    // Configuration only. Whether anything listens there is `otlp-receiver`.
    detail: `configured for ${config.codex.otlpHost}:${config.codex.otlpPort}${hostSafe ? ', a loopback address' : ''}; keep the receiver loopback-only unless you add network controls. This is the configuration, not a sign that a receiver is running.`
  });
  checks.push(...codexCaptureChecks(config, installs));
  const ok = !checks.some((check) => check.status === 'error');
  return { ok, checks };
}

export function formatDoctor(report) {
  const icon = { ok: 'OK', info: 'INFO', warn: 'WARN', error: 'ERROR' };
  return `${report.checks.map((check) => `${icon[check.status] ?? check.status.toUpperCase()}  ${check.id}: ${check.detail}`).join('\n')}\n`;
}
