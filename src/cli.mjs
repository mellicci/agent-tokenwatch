import fs from 'node:fs';
import { killProcessTrees, spawnPortable, spawnShellLine } from './spawn.mjs';
import { parseArgv, boolOption, numberOption } from './args.mjs';
import { rollingStatusFromState, turnReadings } from './aggregate.mjs';
import { COMPOSED_ENV, MAX_COMPOSE_OUTPUT_BYTES, PACKAGE_VERSION, PROBE_ENV, PROBE_MARKER } from './constants.mjs';
import { composeSettings, configPath, getConfigValue, loadConfig, saveConfig, setConfigValue, tokenwatchHome } from './config.mjs';
import { agentActivity, costLabel, detectHostAgent, hostSessionId, launchedThroughCodexWrapper } from './host.mjs';
import { safeIdentifier } from './privacy.mjs';
import { formatStatus, jsonString } from './format.mjs';
import { HELP } from './help.mjs';
import { readStdin, readStdinBytes, parseJsonPayload } from './input.mjs';
import { normalizeAgentPayload } from './normalize/index.mjs';
import { STATUS_LOCK_BUDGET_MS } from './state-lock.mjs';
import { collectEvents, emptyStatusState, loadSessionState, pendingTurnRows, previewSessionState, pruneEvents, resolveStatusSession, storeEvents, tryFlushPendingTurns } from './store.mjs';
import { isWriteRefused } from './fs-util.mjs';
import { recordRelayOutcome } from './relay-record.mjs';
import { sinceDate } from './time.mjs';

// Every hook and status render is a process of its own, started by the agent
// for every event, and loading this whole module graph was about half of each
// one's time on Windows (91 of 174 ms, windows-latest, Node 22): doctor, the
// installer, the history import and the analysis load and compile on every
// hook while no hook uses them. They are loaded by the commands that do.
let installerModule;
async function installer() {
  installerModule ??= await import('./installer.mjs');
  return installerModule;
}

function parseConfigValue(raw) {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function normalizedAgentName(agent) {
  return ({ claude: 'claude-code', codex: 'codex-cli', copilot: 'github-copilot-cli' })[agent] ?? agent;
}

function outputText(text, file) {
  if (file) fs.writeFileSync(file, text, 'utf8');
  else process.stdout.write(text);
}

// Reporting commands flush the in-flight turn first, and inside a sandbox that
// can read `~/.tokenwatch` but not write it - Codex's default - that flush is
// refused. The report still includes the turn, read from pending state in
// memory, and says so: one field in JSON output, one line in text. Absent when
// the flush worked or there was nothing to flush, so a writable run's output
// is exactly what it was.
function degradedFlush(flush) {
  if (!flush.refused) return undefined;
  const turns = flush.unflushed.length;
  return {
    reason: 'data_directory_read_only',
    code: flush.refused.code,
    flushed: false,
    unflushed_turns: turns,
    note: `${turns === 1 ? 'in-flight turn' : `${turns} in-flight turns`} included from pending state; data directory is read-only here, nothing was flushed`
  };
}

async function payloadFrom({ positionals, options, startIndex = 0, stdinOptional = true }) {
  if (options.payload && options.payload !== true) return parseJsonPayload(String(options.payload), '--payload');
  const positional = positionals[startIndex];
  if (positional && (positional.startsWith('{') || positional.startsWith('['))) return parseJsonPayload(positional, 'argument');
  const text = await readStdin({ optional: stdinOptional });
  return parseJsonPayload(text, 'stdin');
}

async function handleHook(args, config) {
  const { positionals, options } = parseArgv(args);
  const agent = positionals[0];
  const eventName = positionals[1] || 'unknown';
  if (!agent) throw new Error('hook requires an agent name');
  try {
    const payload = await payloadFrom({ positionals, options, startIndex: 2 });
    const events = normalizeAgentPayload(agent, eventName, payload, config, 'hook');
    const results = storeEvents(events, config);
    // An update stored without the session lock is counted for `doctor`; under
    // debug the hook also says so as it happens.
    if (process.env.TOKENWATCH_DEBUG === '1' && results.some((row) => row.unlocked)) {
      console.error('tokenwatch hook: session state lock stayed busy; stored without it (counted in session-state:unlocked-writes)');
    }
    if (options.json) process.stdout.write(jsonString({ ok: true, stored: results.filter((row) => row.stored).length }));
    return 0;
  } catch (error) {
    if (boolOption(options.strict, false)) throw error;
    if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch hook ignored error: ${error.message}`);
    return 0;
  }
}

function composeDebug(reason) {
  if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch status: not composing - ${reason}`);
}

// Why a `--compose` render runs Tokenwatch alone. Each reason is silent on the
// status bar and named under TOKENWATCH_DEBUG=1 (intent 04, FR-09).
function composeRefusal(options, agent) {
  if (options.json) return '--json output must stay one JSON document';
  if (agent !== 'claude' && agent !== 'copilot') return `${agent} has no command-backed status line`;
  if (process.env[COMPOSED_ENV] === '1') return 'already running inside a composed status line';
  return null;
}

// Runs every composed status command at once, each with the agent's bytes on
// its stdin, and collects what each prints, never more than
// MAX_COMPOSE_OUTPUT_BYTES apiece. One signal handler and one timer own every
// child, so a cancelled or timed-out render takes all of them down together
// (intent 16, D6). Resolves with one outcome per command, in order; nothing
// here throws, because the status line must render whatever the others do.
function runComposedCommands(specs, bytes, { timeoutMs }) {
  return new Promise((resolve) => {
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    let settled = false;
    const runs = specs.map(() => ({ child: undefined, out: [], size: 0, truncated: false, outcome: undefined }));
    // Every child still running goes with everything it started, at once and
    // without a grace period: a status line has nothing to shut down (intent
    // 04, D16). A shell that has already exited, while a program it started
    // still holds the pipe, is not killed: its id may already be another
    // program's (killProcessTrees). Every unfinished child's pipes are then
    // let go, so neither that program nor a descendant the kill could not
    // reach can hold the render open until it finishes on its own.
    const unfinished = () => runs.filter((run) => run.outcome === undefined && run.child);
    const stop = (stopping) => {
      killProcessTrees(stopping.map((run) => run.child));
      for (const { child } of stopping) {
        child.stdout?.destroy();
        child.stdin?.destroy();
        child.unref();
      }
    };
    // The agent cancels an in-flight status script when the next update
    // arrives (Claude Code status-line docs): every child goes with us.
    const onSignal = (signal) => { stop(unfinished()); process.exit(signal === 'SIGINT' ? 130 : 143); };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) process.removeListener(signal, onSignal);
      resolve(runs.map((run) => ({
        outcome: run.outcome,
        stdout: run.outcome === 'ok' || run.outcome === 'exit-nonzero' ? Buffer.concat(run.out, run.size) : Buffer.alloc(0),
        truncated: run.truncated
      })));
    };
    const done = (run, outcome) => {
      if (run.outcome !== undefined) return;
      run.outcome = outcome;
      if (runs.every((each) => each.outcome !== undefined)) settle();
    };
    const timer = setTimeout(() => {
      // Marked first, so nothing the stop itself reports can change them.
      const stopping = unfinished();
      for (const run of runs) if (run.outcome === undefined) run.outcome = 'timeout';
      stop(stopping);
      settle();
    }, timeoutMs);
    for (const signal of signals) process.on(signal, onSignal);
    specs.forEach((spec, index) => {
      const run = runs[index];
      try {
        run.child = spawnShellLine(spec.command, spec, {
          stdio: ['pipe', 'pipe', process.env.TOKENWATCH_DEBUG === '1' ? 'inherit' : 'ignore'],
          env: { ...process.env, [COMPOSED_ENV]: '1' },
          detached: process.platform !== 'win32'
        });
      } catch {
        done(run, 'spawn-failed');
        return;
      }
      run.child.on('error', () => done(run, 'spawn-failed'));
      run.child.on('close', (code) => done(run, code === 0 ? 'ok' : 'exit-nonzero'));
      run.child.stdout.on('data', (chunk) => {
        const room = MAX_COMPOSE_OUTPUT_BYTES - run.size;
        if (chunk.length > room) run.truncated = true;
        if (room <= 0) return;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        run.out.push(kept);
        run.size += kept.length;
      });
      // A command that does not read stdin closes it early; that is the command
      // declining input, not a failure.
      run.child.stdin.on('error', () => {});
      run.child.stdin.end(bytes);
    });
    if (!specs.length) settle();
  });
}

// Which session a `status` render describes (intent 15): the piped payload's
// id, else `--session`, else the agent's own verified session marker, else no
// id - and the caller then learns it got the most recent session, not its own.
// An id from outside goes through the same safeIdentifier the store applied to
// the id it filed the session under, or a live session would look empty (D7).
function statusSessionScope(options, agent, env, { payloadSessionId, ingested }) {
  const normalise = (value) => (typeof value === 'string' ? safeIdentifier(value, 160) : undefined);
  const asked = Object.hasOwn(options, 'session') ? normalise(options.session) : undefined;
  // A payload that carried no id was still stored, under the shared state file:
  // render that reading, not a guess at another session (D14).
  if (payloadSessionId || ingested) {
    return { sessionId: payloadSessionId, basis: 'stdin', ...(asked && asked !== payloadSessionId ? { requested: asked } : {}) };
  }
  if (Object.hasOwn(options, 'session')) {
    // An explicit request that cannot be honoured is answered with nothing,
    // never with another session's figures (D1).
    return asked ? { sessionId: asked, basis: 'option' } : { sessionId: undefined, basis: 'unknown', rejected: true };
  }
  const marker = hostSessionId(agent, env);
  const fromEnv = normalise(marker.sessionId);
  if (fromEnv) return { sessionId: fromEnv, basis: marker.basis };
  return { sessionId: undefined, basis: undefined };
}

async function handleStatus(args, config, env = process.env) {
  const { options } = parseArgv(args);
  const agent = String(options.agent || 'claude');
  const composeKey = typeof options.compose === 'string' && options.compose ? options.compose : undefined;
  const settings = composeSettings(config);
  let sessionId;
  let events;
  let state;
  let degraded;
  let note;
  let composed;
  // Only an explicit --ingest-stdin reads stdin, and every installed status line
  // passes it. Reading whenever stdin was not a terminal made a hand-run status
  // wait forever on a pipe its caller never closed: a shell tool, a CI step,
  // `ssh -T` (Windows live test, 2026-09-28).
  if (boolOption(options.ingestStdin, false)) {
    let text;
    if (composeKey) {
      // One raw read serves both halves: the other command gets the bytes the
      // agent sent, Tokenwatch parses its own decoded copy (intent 04, D2).
      // Nothing in this set-up may escape: whatever goes wrong here, Tokenwatch
      // still renders its own rows, as the plain path always has.
      let bytes;
      try {
        bytes = await readStdinBytes({ optional: true });
        text = bytes.toString('utf8').trim();
      } catch (error) {
        if (error?.code === 'STDIN_LIMIT') note = 'stdin exceeded the 2 MiB safety limit; nothing was ingested or forwarded';
        else composeDebug(`stdin could not be read (${error?.name ?? 'Error'})`);
        text = '';
      }
      // Neither call below throws: the resolver treats an unreadable record as
      // none, and runComposedCommands resolves with an outcome in every case.
      // A failed read has already said why above, so it says nothing more here.
      const refusal = bytes === undefined ? null : !bytes.length ? 'no payload on stdin' : composeRefusal(options, agent);
      const specs = (refusal || bytes === undefined ? null : (await installer()).composedStatusCommand(config, composeKey, agent)) ?? [];
      if (refusal) composeDebug(refusal);
      else if (bytes !== undefined && !specs.length) composeDebug(`no composable status line recorded for ${agent} under ${composeKey}`);
      // Started before Tokenwatch's own ingest, so the reading is recorded
      // while the others run rather than after them (D2).
      if (specs.length) composed = runComposedCommands(specs, bytes, settings);
    }
    try {
      // Under --compose, `text` is always set above, so stdin is never read twice.
      if (text === undefined) text = await readStdin({ optional: true });
      if (text) {
        const payload = parseJsonPayload(text, 'status-line stdin');
        events = normalizeAgentPayload(agent, 'status', payload, config, 'statusline');
        sessionId = events[0]?.session_id;
        storeEvents(events, config, { lock: { budgetMs: STATUS_LOCK_BUDGET_MS } });
      }
    } catch (error) {
      if (isWriteRefused(error) && events) {
        // The status line must render whatever happens. When the reading cannot
        // be recorded, render it anyway from the same reduction a store would
        // have run, held in memory, and say it was not kept - otherwise a
        // read-only data directory looks exactly like a working one while
        // nothing at all is being collected.
        state = previewSessionState(events, config, sessionId);
        degraded = {
          reason: 'data_directory_read_only',
          code: error.code,
          recorded: false,
          note: 'data directory is read-only here; this reading is shown but was not recorded'
        };
      } else if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch status ingestion ignored: ${error.message}`);
    }
  }
  const agentName = normalizedAgentName(agent);
  let scope;
  let rendered = state;
  try {
    scope = statusSessionScope(options, agent, env, { payloadSessionId: sessionId, ingested: Boolean(events?.length) });
    if (rendered) {
      // The read-only preview: the reading is in memory, not in a file (FR-08).
      scope.found = true;
    } else if (scope.rejected) {
      scope.found = false;
      rendered = emptyStatusState();
    } else if (scope.basis === 'stdin') {
      // One read of wherever the payload was filed - its session's file, or the
      // shared state file for a payload with no id - answers both what renders
      // and whether it was found, whether or not the store just succeeded
      // (D13, D19). It is the read statusState made here before (D4).
      ({ state: rendered, found: scope.found } = loadSessionState(config, sessionId));
    } else {
      const resolved = resolveStatusSession(config, { sessionId: scope.sessionId, agentName });
      // `requested` never surfaces: an id always arrives with its own basis (D2).
      scope.basis ??= resolved.resolution;
      scope.found = resolved.found;
      rendered = resolved.state;
    }
  } catch (error) {
    // A status command must render whatever happens (FR-24).
    if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch status: session not resolved (${error?.name ?? 'Error'})`);
    scope = { basis: 'unknown', found: false };
    rendered = emptyStatusState();
  }
  const snapshot = rollingStatusFromState(rendered, config, agent);
  const sessionScope = {
    session_id: snapshot.latest?.session_id ?? scope.sessionId,
    basis: scope.basis,
    state_found: scope.found,
    ...(scope.requested ? { requested_session_id: scope.requested } : {}),
    ...(scope.rejected ? { rejected_session_id: true } : {})
  };
  if (options.json) {
    process.stdout.write(jsonString({ ...snapshot, session_scope: sessionScope, ...(degraded ? { degraded } : {}) }));
    return 0;
  }
  const scopeNote = scope.rejected
    ? '--session was not a usable session id; nothing was reported'
    // found describes the read, and the ranked file can be empty or gone by then
    // (D21), so the note needs both halves (FR-12, D22).
    : sessionScope.basis === 'most_recent_fallback' && sessionScope.state_found
      ? `no session id given; showing the most recently active ${agent} session${sessionScope.session_id ? ` (${sessionScope.session_id})` : ''}. Pass --session <id> to choose one.`
      : undefined;
  const notes = [degraded?.note, note, scopeNote].filter(Boolean).map((line) => `note: ${line}\n`).join('');
  const own = `${formatStatus(snapshot, config)}\n${notes}`;
  const others = composed ? await composed : [];
  others.forEach((other, index) => {
    if (other.outcome !== 'ok') composeDebug(`status command ${index + 1} of ${others.length} ended as ${other.outcome}${other.truncated ? ', output truncated' : ''}`);
  });
  // Each other command's bytes are printed exactly as it wrote them, in record
  // order, with one newline added only when it did not end its last row; the
  // block goes before or after Tokenwatch's rows as a whole (intent 16, D7).
  const otherBytes = others.filter((other) => other.stdout.length)
    .map((other) => (other.stdout.at(-1) === 0x0a ? other.stdout : Buffer.concat([other.stdout, Buffer.from('\n')])));
  if (!otherBytes.length) {
    process.stdout.write(own);
    return 0;
  }
  const parts = settings.order === 'first' ? [Buffer.from(own), ...otherBytes] : [...otherBytes, Buffer.from(own)];
  process.stdout.write(Buffer.concat(parts));
  return 0;
}

async function handleAgents(args, config) {
  const { options } = parseArgv(args);
  // Every reporting skill runs this first to learn which agent has data, so an
  // unflushed in-flight turn here reads as "no activity" on exactly the session
  // being asked about.
  const flush = tryFlushPendingTurns(config);
  const since = sinceDate(String(options.since || '30d'));
  const events = await collectEvents(config, { since }, { pending: flush.unflushed });
  const report = { host: detectHostAgent(), since, agents: agentActivity(events) };
  // Inside Codex, whether this session's tokens can reach Tokenwatch at all
  // depends on how Codex was started, and the session can now say.
  if (report.host.agent === 'codex') report.host.codex_wrapper = launchedThroughCodexWrapper();
  const degraded = degradedFlush(flush);
  if (degraded) report.degraded = degraded;
  if (options.json || options.format === 'json') {
    process.stdout.write(jsonString(report));
    return 0;
  }
  const wrapper = report.host.codex_wrapper === undefined ? ''
    : report.host.codex_wrapper
      ? ' · launched through tokenwatch-codex'
      : " · no tokenwatch-codex marker: this session's tokens are recorded only if Codex was started with tokenwatch-codex";
  const lines = [report.host.agent
    ? `host: ${report.host.agent} (${report.host.basis})${wrapper}`
    : 'host: unknown - pass --agent, or set TOKENWATCH_AGENT, to say which agent to report on'];
  for (const row of report.agents) {
    const units = costLabel(row);
    const imported = row.imported_events ? ` · imported: ${row.imported_sessions} sessions, ${row.imported_events} responses` : '';
    lines.push(`${row.agent}: last ${row.last_activity ?? 'never'} · ${row.events} events · ${row.sessions} sessions · ${units}${imported}`);
  }
  if (degraded) lines.push(`note: ${degraded.note}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// `tokenwatch import <agent>` (intent 06). What it prints holds counts, ids,
// dates and the user's own session directory, never a session-file value.
async function handleImport(args, config, env) {
  const { positionals, options } = parseArgv(args);
  const agent = { 'claude-code': 'claude', 'codex-cli': 'codex', 'github-copilot-cli': 'copilot' }[positionals[0]] ?? positionals[0];
  if (!['claude', 'codex', 'copilot'].includes(agent)) {
    process.stderr.write('usage: tokenwatch import <claude|codex|copilot> [--check] [--dry-run] [--since 30d] [--accept-unverified] [--mapping <file>] [--keep-mapping <file>] [--export-mapping] [--undo <mapping id> [--run <run id>]] [--json]\n');
    return 1;
  }
  const [{ runImport }, { undoImport }, { exportMapping, keepMapping }] = await Promise.all([
    import('./import/run.mjs'), import('./import/undo.mjs'), import('./import/override.mjs')
  ]);
  // Keep and export a mapping (intent 19): handled before any import, and
  // neither opens a session file.
  const KEEP_REFUSALS = {
    too_large: (result) => `the mapping file is larger than Tokenwatch reads (${result.limit} bytes)`,
    mapping_invalid: (result) => result.message,
    shadows_bundled: (result) => `a kept mapping needs its own mapping_id; ${result.mapping_id} is the bundled one`,
    unsafe_string: (result) => `the mapping holds a secret- or path-shaped string at ${result.key_path}; remove it`,
    read_only: () => 'the Tokenwatch data directory is read-only here'
  };
  if (options.keepMapping !== undefined) {
    if (typeof options.keepMapping !== 'string') {
      process.stderr.write('usage: tokenwatch import <agent> --keep-mapping <file>\n');
      return 1;
    }
    const kept = keepMapping(config, { agent, file: options.keepMapping });
    if (kept.status === 'kept') process.stdout.write(jsonString(kept));
    else process.stderr.write(`not kept (${kept.status}): ${(KEEP_REFUSALS[kept.status] ?? (() => kept.status))(kept)}\n`);
    return kept.exitCode;
  }
  // A switch, read as one: `--no-export-mapping` parses to false, which a
  // presence test took for a request to export.
  if (boolOption(options.exportMapping, false)) {
    const exported = exportMapping(config, { agent, file: typeof options.mapping === 'string' ? options.mapping : undefined });
    if (exported.status === 'exported') {
      process.stdout.write(exported.text);
      process.stderr.write(`mapping ${exported.mapping_id} (${exported.mapping_origin})\n`);
    } else {
      process.stderr.write(`not exported (${exported.status}): ${(KEEP_REFUSALS[exported.status] ?? (() => exported.status))(exported)}\n`);
    }
    return exported.exitCode;
  }
  if (options.undo !== undefined) {
    if (typeof options.undo !== 'string' || (options.run !== undefined && typeof options.run !== 'string')) {
      process.stderr.write('usage: tokenwatch import <agent> --undo <mapping id> [--run <run id>] [--dry-run]\n');
      return 1;
    }
    // A real undo flushes a turn still pending in a state file first, so it is
    // on disk before the ledger is rewritten around it. A dry run writes
    // nothing (intent 06, D12): it reads those turns from state in memory and
    // counts them as kept, as the real undo would.
    const dryRun = boolOption(options.dryRun, false);
    let pendingRows = [];
    if (dryRun) pendingRows = pendingTurnRows(config);
    else tryFlushPendingTurns(config);
    const undone = undoImport(config, { agent, mappingId: options.undo, runId: options.run, dryRun, pendingRows });
    process.stdout.write(jsonString(undone));
    if (undone.warning) process.stderr.write(`WARN import-undo: ${undone.warning}\n`);
    if (undone.refused) process.stderr.write(`nothing removed: ${undone.refused}\n`);
    return undone.refused ? 1 : 0;
  }
  const result = await runImport(config, {
    agent,
    since: sinceDate(String(options.since || '30d')),
    dryRun: boolOption(options.dryRun, false),
    check: boolOption(options.check, false),
    acceptUnverified: boolOption(options.acceptUnverified, false),
    mappingFile: typeof options.mapping === 'string' ? options.mapping : undefined,
    env
  });
  const json = boolOption(options.json, false) || options.format === 'json';
  switch (result.status) {
    case 'no_directory':
      process.stderr.write(`no ${agent} session directory at ${result.dir ?? '(not configured)'}\n`);
      break;
    case 'mapping_invalid':
      // A kept user-local mapping that no longer validates is named, with the
      // one action that fixes it; the bundled mapping is not used instead (FR-31).
      // Only a mapping that failed to validate carries a mapping_path.
      if (result.mapping_origin === 'user' && result.mapping_path) {
        process.stderr.write(`the user-local ${agent} mapping at ${result.mapping_path} is not valid (${result.message}); fix or remove that file\n`);
      } else if (result.mapping_origin === 'bundled' && result.mapping_path) {
        process.stderr.write(`the bundled ${agent} mapping is broken (${result.message}); reinstall Tokenwatch\n`);
      } else if (result.mapping_path) {
        process.stderr.write(`the ${agent} mapping at ${result.mapping_path} is not valid (${result.message})\n`);
      } else {
        process.stderr.write(`the ${agent} mapping does not fit these session files: ${result.message ?? 'no record it selects carries usage'}\n`);
      }
      if (result.diagnosis === 'no_directory') process.stderr.write(`no ${agent} session directory at ${result.dir ?? '(not configured)'}\n`);
      if (result.diagnosis) break;
      if (result.probe) process.stdout.write(jsonString({ probe: result.probe }));
      else if (json) process.stdout.write(jsonString({ status: result.status, mapping_origin: result.mapping_origin, errors: result.errors, ...(result.bundled_mapping_broken ? { bundled_mapping_broken: true } : {}) }));
      break;
    case 'check':
      break;
    case 'unverified':
      process.stdout.write(jsonString({ overlap: result.overlap }));
      process.stderr.write(`nothing written: the overlap check is unverified (${result.overlap.reason}); run with --check to see why, or --accept-unverified to import rows marked unverified\n`);
      break;
    case 'read_only':
      process.stderr.write('nothing written: the Tokenwatch data directory is read-only here (data_directory_read_only)\n');
      break;
    case 'record_unreadable':
      process.stderr.write(`nothing written: imports.json beside the ledger could not be read and could not be moved aside; move or delete it, then run the import again\n`);
      break;
    case 'write_failed': {
      const undo = `To remove exactly those rows: tokenwatch import ${agent} --undo ${result.record.mapping_id} --run ${result.record.run_id}`;
      if (!result.written) {
        process.stderr.write(`nothing written: the ledger refused the import (${result.code})${result.record_left_unfinished
          ? `; imports.json could not be updated either, so it still lists run ${result.record.run_id} as unfinished, and none of its rows were written` : ''}\n`);
      } else if (result.written === result.of && result.record_left_unfinished) {
        process.stderr.write(`all ${result.written} responses were written, but the run record could not be finished (${result.code}); run ${result.record.run_id} stays listed as unfinished. ${undo}\n`);
      } else {
        process.stderr.write(`the import stopped after writing ${result.written} of ${result.of} responses (${result.code}); run ${result.record.run_id} is recorded as unfinished. ${undo}\n`);
      }
      break;
    }
    default: {
      const record = result.status === 'dry_run' ? { dry_run: true, session_dir: result.dir, ...result.record } : result.record;
      if (json) process.stdout.write(jsonString({ ...record, overlap: result.overlap }));
      else process.stdout.write(`${Object.entries(record).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`);
    }
  }
  // --check prints one JSON object on every path, with every documented field:
  // null where a field could not be measured on that path (nothing was read,
  // no overlap check ran, no row was chosen), never an invented zero. `errors`
  // is always a list: empty when the mapping validated (#15).
  if (boolOption(options.check, false) && result.diagnosis) {
    process.stdout.write(jsonString({
      diagnosis: result.diagnosis,
      session_dir: result.dir ?? null,
      mapping_origin: result.mapping_origin ?? result.record?.mapping_origin ?? null,
      errors: result.errors ?? [],
      ...(result.bundled_mapping_broken ? { bundled_mapping_broken: true } : {}),
      directory: result.directory ?? null,
      mapping_paths: result.mapping_paths ?? null,
      probe: result.probe ?? null,
      overlap: result.overlap ?? null,
      summary_delta: result.summary_delta ?? null,
      ...(result.internally_consistent === undefined ? {} : { internally_consistent: result.internally_consistent }),
      would_write: result.record ?? null
    }));
  }
  return result.exitCode;
}

async function handleAnalyze(args, config) {
  const { options } = parseArgv(args);
  const [{ analyzeEvents, formatAuditMarkdown }, { rankGroups, turnConcentration, compactionSummary, comparePeriods }] = await Promise.all([
    import('./analyze.mjs'), import('./rank.mjs')
  ]);
  const flush = tryFlushPendingTurns(config);
  const since = options.since ? sinceDate(options.since) : undefined;
  const agents = options.agent ? String(options.agent).split(',').map(normalizedAgentName) : undefined;
  const events = await collectEvents(config, { since, agents, projectId: options.projectId }, { pending: flush.unflushed });
  // The period is grouped into turns once, and every section below reads the
  // same readings rather than grouping the whole period again.
  const readings = turnReadings(events);
  const report = analyzeEvents(events, config, { since, readings });
  const degraded = degradedFlush(flush);
  if (degraded) report.degraded = degraded;
  // Ranked shares are computed here rather than left for a reader to total up.
  if (options.groupBy) {
    report.ranking = rankGroups(events, {
      by: String(options.groupBy),
      limit: numberOption(options.limit, 10),
      readings
    });
    report.concentration = turnConcentration(events, { readings });
    report.compactions = compactionSummary(events);
  }
  if (boolOption(options.compare, false)) {
    if (!since) throw new Error('--compare requires --since so the prior window has a length to match');
    const span = Date.now() - new Date(since).getTime();
    const priorStart = new Date(new Date(since).getTime() - span).toISOString();
    const prior = (await collectEvents(config, { since: priorStart, agents, projectId: options.projectId }, { pending: flush.unflushed }))
      .filter((event) => event.ts < since);
    report.comparison = { current_since: since, prior_since: priorStart, ...comparePeriods(events, prior, { current: readings }) };
  }
  const format = String(options.format || (options.json ? 'json' : 'markdown')).toLowerCase();
  const markdown = () => `${degraded ? `> note: ${degraded.note}\n\n` : ''}${formatAuditMarkdown(report)}`;
  outputText(format === 'json' ? jsonString(report) : markdown(), options.output);
  return 0;
}

async function handleExperiment(args, config) {
  const { positionals, options } = parseArgv(args);
  const { addExperiment, closeExperiment, listExperiments, formatExperiments } = await import('./experiments.mjs');
  const subcommand = positionals[0] || 'list';
  if (subcommand === 'add') {
    const record = addExperiment(config, {
      hypothesis: options.hypothesis, change: options.change, baseline: options.baseline,
      metric: options.metric, guardrail: options.guardrail, rollback: options.rollback,
      sample: options.sample, agent: options.agent, projectId: options.projectId, id: options.id
    });
    process.stdout.write(options.json ? jsonString(record) : `${record.id}\n`);
    return 0;
  }
  if (subcommand === 'close') {
    const record = closeExperiment(config, positionals[1] || options.id, { result: options.result, outcome: options.outcome });
    process.stdout.write(options.json ? jsonString(record) : `${record.id} closed as ${record.result}\n`);
    return 0;
  }
  if (subcommand === 'list') {
    const status = boolOption(options.all, false) ? 'all' : String(options.status || 'open');
    const rows = listExperiments(config, { status });
    process.stdout.write(options.json ? jsonString(rows) : formatExperiments(rows, status));
    return 0;
  }
  throw new Error(`Unknown experiment subcommand: ${subcommand}`);
}

async function handleExport(args, config) {
  const { options } = parseArgv(args);
  const { eventsToCsv } = await import('./export.mjs');
  const flush = tryFlushPendingTurns(config);
  const since = options.since ? sinceDate(options.since) : undefined;
  const agents = options.agent ? String(options.agent).split(',').map(normalizedAgentName) : undefined;
  const events = await collectEvents(config, { since, agents, projectId: options.projectId }, { pending: flush.unflushed });
  const format = String(options.format || 'json').toLowerCase();
  const text = format === 'csv' ? eventsToCsv(events) : jsonString(events);
  outputText(text, options.output);
  // Export's output is the data itself - a JSON array or a CSV table - so there
  // is no field to carry the note without changing its shape. It goes to stderr.
  const degraded = degradedFlush(flush);
  if (degraded) process.stderr.write(`tokenwatch export: note: ${degraded.note}\n`);
  return 0;
}

async function handlePrune(args, config) {
  const { options } = parseArgv(args);
  const raw = options.olderThan || options.before;
  // `--retention` is the opt-in that makes the configured `retentionDays` do
  // something. It stays opt-in rather than becoming the default for a bare
  // `prune`, because deleting several months of history should be a sentence
  // someone typed, not a default they inherited.
  if (!raw && !boolOption(options.retention, false)) {
    throw new Error(`prune requires --older-than <duration|date>, or --retention to use the configured retentionDays of ${config.retentionDays}d`);
  }
  const cutoff = raw
    ? (options.olderThan ? sinceDate(raw) : new Date(raw).toISOString())
    : sinceDate(`${config.retentionDays}d`);
  const result = await pruneEvents(config, cutoff);
  process.stdout.write(jsonString({ cutoff, ...result }));
  return 0;
}

// install's output is read back by the status-line skill's model, whichever
// remedy it ran, so it names another tool's status line by hash and file,
// never by command: composed entries are reduced, and the line the slot held
// (priorStatusLine) and the file record's restore spans, which quote it, are
// left out. The record on disk keeps all of it (intent 16, D14, D29, D32).
// The same holds for the other prior values an install keeps to restore:
// a displaced Copilot hooks file and a displaced Codex notifier (review 2, D33).
// Called by install and paths, once they have loaded the installer.
function redactComposeCommands(record) {
  const redact = (agentRecord) => {
    if (!agentRecord) return agentRecord;
    const { priorStatusLine, file, compose, priorHooks, priorNotifyLine, ...rest } = agentRecord;
    const entries = installerModule.composeEntries(agentRecord);
    return entries.length
      ? { ...rest, compose: entries.map(({ sha256, sourceFile, level, shell, adoptedAt, carried }) => ({ sha256, sourceFile, level, shell, adoptedAt, ...(carried ? { carried } : {}) })) }
      : rest;
  };
  const shown = withoutSkillText(record);
  for (const agent of ['claude', 'copilot', 'codex']) if (record[agent]) shown[agent] = redact(record[agent]);
  return shown;
}

// A skill --force replaced is named by hash and backup path, and never printed:
// it can be a customised skill with a team's notes in it, and `install --force`
// runs in CI. Records written before the backup existed still carry the text
// inline as `prior`, and are shown without it by both install and uninstall.
function withoutSkillText(record) {
  const strip = (skill) => {
    if (!skill || typeof skill !== 'object' || !Object.hasOwn(skill, 'prior')) return skill;
    const { prior, ...rest } = skill;
    return rest;
  };
  const shown = { ...record };
  for (const key of ['claudeSkills', 'sharedSkills']) if (Array.isArray(record?.[key])) shown[key] = record[key].map(strip);
  for (const key of ['claudeSkill', 'sharedSkill']) if (record?.[key]) shown[key] = strip(record[key]);
  return shown;
}

function installOptions(options) {
  return {
    agents: options.agents,
    scope: options.scope,
    project: options.project,
    force: boolOption(options.force, false),
    // Undefined unless typed: composing is the default for a taken slot, and
    // only an explicit --compose makes `--compose --force` a contradiction
    // (intent 16, D1).
    compose: options.compose === undefined ? undefined : boolOption(options.compose, false),
    repair: boolOption(options.repair, false),
    claudeSettings: options.claudeSettings,
    copilotConfig: options.copilotConfig,
    copilotHooks: options.copilotHooks,
    codexConfig: options.codexConfig,
    claudeSkills: options.claudeSkills,
    sharedSkills: options.sharedSkills
  };
}

// A recorded notifier that points back at this CLI would relay into itself on
// every turn and spawn without bound. `installCodex` and `priorCodexNotify`
// both refuse to record or return one; this is the last line of defence, at the
// point where the argv would actually be executed. It starts from the same
// `isTokenwatchRelay` rule those two use, so the three cannot drift apart, and
// adds a broader check that is only safe here: refusing to run anything named
// like a Tokenwatch binary costs nothing, while treating such a line as ours at
// install time would overwrite it without `--force`.
function relaysToSelf(argv, { isTokenwatchRelay }) {
  return isTokenwatchRelay(argv) || argv.some((value) => /(^|[\\/])tokenwatch(-codex)?(\.mjs|\.cmd|\.exe)?$/i.test(String(value)));
}

async function handleNotifyRelay(args, config) {
  const { positionals, options } = parseArgv(args);
  // Codex appends its JSON payload as the relay's last argument and gives it no
  // stdin (codex-rs/hooks/src/legacy_notify.rs). Which of the two a payload
  // came from - or that neither carried one - is kept with a failure, because
  // an argument mangled on its way through a command line looks exactly like
  // no argument at all.
  let payloadText = positionals.findLast((value) => value.startsWith('{'));
  let payloadSource = payloadText ? 'argument' : 'none';
  let stage = 'read';
  try {
    if (!payloadText) {
      payloadText = await readStdin({ optional: true });
      if (payloadText) payloadSource = 'stdin';
    }
    // Codex always sends a payload, so a run with none is a command line that
    // lost it. It used to parse as `{}` and be stored as a turn with no
    // session, which made a broken relay look like a working one.
    if (!payloadText) throw Object.assign(new Error('no Codex notify payload'), { name: 'MissingPayload' });
    stage = 'parse';
    const payload = parseJsonPayload(payloadText, 'Codex notify payload');
    stage = 'normalize';
    const events = normalizeAgentPayload('codex', payload.type || 'agent-turn-complete', payload, config, 'notify');
    stage = 'store';
    storeEvents(events, config);
    recordRelayOutcome(config, { ok: true });
  } catch (error) {
    // Fails open, as it always has. What it no longer does is fail silently:
    // Codex discards the relay's stdout and stderr, so the debug line below
    // reached nobody, and the failure is recorded for `doctor` instead - its
    // class and stage, never its message, which quotes part of the payload.
    recordRelayOutcome(config, { ok: false, stage, error, payload: payloadSource });
    if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch notify relay ignored (${error?.name ?? 'Error'})`);
  }
  // Scoped to the installation whose config.toml invoked this relay. Without
  // `--install` nothing is relayed, which is the safe default for a hand-run
  // command and for a relay line written by an older version.
  const recorded = await installer();
  const prior = recorded.priorCodexNotify(config, options.install);
  const relayed = Boolean(prior?.length) && !relaysToSelf(prior, recorded) && typeof payloadText === 'string';
  if (relayed) {
    // The user's own notifier failing to start does not stop Tokenwatch
    // recording, so it is recorded under its own stage and `doctor` keeps it
    // apart from the failures that lose a turn.
    const spawnFailed = (error) => recordRelayOutcome(config, { ok: false, stage: 'relay-spawn', error, payload: payloadSource });
    try {
      const child = spawnPortable(prior[0], [...prior.slice(1), payloadText], { stdio: 'ignore', detached: false, windowsHide: true });
      // A ChildProcess that emits 'error' with no listener is an uncaught
      // exception. The notifier may have been uninstalled or renamed since the
      // install, and on Windows it is commonly an npm `.cmd` shim - so without
      // this, Codex got a stack trace and a failing notifier on every turn.
      child.on('error', spawnFailed);
      child.unref();
    } catch (error) {
      spawnFailed(error);
    }
  }
  if (options.json) process.stdout.write(jsonString({ ok: true, priorNotifier: relayed }));
  return 0;
}

async function handleOtlp(args, config) {
  const { positionals, options } = parseArgv(args);
  const subcommand = positionals[0] || 'serve';
  if (subcommand !== 'serve') throw new Error(`Unknown otlp subcommand: ${subcommand}`);
  const { startOtlpServer } = await import('./otlp-server.mjs');
  const receiver = await startOtlpServer(config, {
    host: options.host || config.codex.otlpHost,
    port: numberOption(options.port, config.codex.otlpPort),
    quiet: boolOption(options.quiet, false)
  });
  const address = receiver.server.address();
  process.stderr.write(`tokenwatch OTLP listening on http://${address.address}:${address.port} (JSON logs/metrics; protobuf logs)\n`);
  await new Promise((resolve) => {
    const stop = () => receiver.close().finally(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

function handleConfig(args, config, env) {
  const { positionals } = parseArgv(args);
  const subcommand = positionals[0] || 'show';
  if (subcommand === 'show') process.stdout.write(jsonString(config));
  else if (subcommand === 'path') process.stdout.write(`${configPath(env)}\n`);
  else if (subcommand === 'get') {
    if (!positionals[1]) throw new Error('config get requires a dotted key');
    process.stdout.write(jsonString(getConfigValue(config, positionals[1])));
  } else if (subcommand === 'set') {
    if (!positionals[1] || positionals[2] === undefined) throw new Error('config set requires <dotted-key> <json-or-string-value>');
    setConfigValue(config, positionals[1], parseConfigValue(positionals[2]));
    const file = saveConfig(config, env);
    process.stdout.write(`${file}\n`);
  } else throw new Error(`Unknown config subcommand: ${subcommand}`);
  return 0;
}

// `injected` exists for tests. It used to be accepted and silently ignored,
// which is the worst of both: a test could pass a scratch config, believe it was
// sandboxed, and drive a destructive command against the caller's real
// `~/.tokenwatch`. A parameter that looks honoured has to be honoured.
export async function main(argv = process.argv.slice(2), injected = {}) {
  const { env = process.env } = injected;
  const { positionals, options, passthrough } = parseArgv(argv);
  const command = positionals[0] || (options.version ? 'version' : options.help ? 'help' : 'help');
  if (command === 'help' || options.help) { process.stdout.write(HELP); return 0; }
  if (command === 'version') { process.stdout.write(`${PACKAGE_VERSION}\n`); return 0; }
  // A `doctor` probe of an installed hook or status-line command: it proves the
  // agent's shell parsed the command and reached this dispatcher with the right
  // arguments. Answered before config is loaded, so a probe writes nothing -
  // no ledger row, no state file, not even a first-run config.json.
  if (env[PROBE_ENV] === '1' && (command === 'hook' || command === 'status')) {
    let marker = `${PROBE_MARKER} ${argv.slice(argv.indexOf(command)).join(' ')}`;
    // A status line's only input is its stdin, and a shell can parse the
    // command yet not hand the payload on. The byte count shows it arrived;
    // the bytes themselves are read and dropped (intent 17, D7).
    if (command === 'status' && boolOption(options.ingestStdin, false)) {
      let count;
      try { count = String((await readStdinBytes({ optional: true })).length); } catch { count = 'error'; }
      marker += ` stdin=${count}`;
    }
    process.stdout.write(`${marker}\n`);
    return 0;
  }
  // doctor observes a machine and must not set it up: it reads the config, or
  // uses the defaults in memory, and writes neither config.json nor merged
  // defaults. Every other command creates the file on first use, because the
  // random projectSalt in it keeps HMAC project identities stable.
  const loaded = injected.config
    ? { config: injected.config, file: injected.configFile ?? '(injected)' }
    : loadConfig({ env, create: command !== 'doctor' });
  const { config, file: configFile } = loaded;
  const rest = argv.slice(argv.indexOf(command) + 1);
  switch (command) {
    case 'hook': return handleHook(rest, config);
    case 'status': return handleStatus(rest, config, env);
    case 'analyze': return handleAnalyze(rest, config);
    case 'import': return handleImport(rest, config, env);
    case 'export': return handleExport(rest, config);
    case 'prune': return handlePrune(rest, config);
    case 'repair': {
      const parsed = parseArgv(rest);
      // Best-effort, so `repair --dry-run` works where the ledger is read-only.
      // A real repair rewrites the ledger and fails on its own write there,
      // which is the honest outcome for a command whose job is to write.
      tryFlushPendingTurns(config);
      const { repairLedger } = await import('./repair.mjs');
      process.stdout.write(jsonString(await repairLedger(config, { dryRun: boolOption(parsed.options.dryRun, false) })));
      return 0;
    }
    case 'experiment': return handleExperiment(rest, config);
    case 'agents': return handleAgents(rest, config);
    case 'notify-relay': return handleNotifyRelay(rest, config);
    case 'otlp': return handleOtlp(rest, config);
    case 'install': {
      const parsed = parseArgv(rest);
      const record = (await installer()).install(config, installOptions(parsed.options));
      if (record.installLocation?.status === 'warn') process.stderr.write(`WARN install-location: ${record.installLocation.detail}\n`);
      if (record.claude?.nodeWarning) process.stderr.write(`WARN claude-node: ${record.claude.nodeWarning}\n`);
      for (const agent of ['claude', 'copilot']) {
        if (record[agent]?.refused) process.stderr.write(`WARN ${agent}-settings: ${record[agent].warning}\n`);
      }
      for (const warning of record.warnings ?? []) process.stderr.write(`WARN settings: ${warning}\n`);
      for (const warning of record.skillWarnings ?? []) process.stderr.write(`WARN skills: ${warning}\n`);
      // skillUsage comes with the result: install() reads it from the record
      // as saved, where a retained agent's refusal is still visible.
      process.stdout.write(jsonString(record.repaired === false ? record : redactComposeCommands(record)));
      return 0;
    }
    case 'uninstall': {
      const parsed = parseArgv(rest);
      const result = (await installer()).uninstall(config, installOptions(parsed.options));
      for (const warning of result.warnings ?? []) process.stderr.write(`WARN settings: ${warning}\n`);
      for (const warning of result.skillWarnings ?? []) process.stderr.write(`WARN skills: ${warning}\n`);
      process.stdout.write(jsonString(result.record ? { ...result, record: withoutSkillText(result.record) } : result));
      return 0;
    }
    case 'doctor': {
      const { runDoctor, formatDoctor } = await import('./doctor.mjs');
      const report = runDoctor(config, configFile);
      if (options.json) process.stdout.write(jsonString(report));
      else process.stdout.write(formatDoctor(report));
      return report.ok ? 0 : 1;
    }
    case 'config': return handleConfig(rest, config, env);
    case 'paths': {
      // The records as install prints them: another tool's status command by
      // hash and file, no displaced prior values, no skill text (D33's residue).
      const managedInstalls = Object.fromEntries(Object.entries((await installer()).listInstalls(config)).map(([key, record]) => [key, redactComposeCommands(record)]));
      process.stdout.write(jsonString({ home: tokenwatchHome(env), config: configFile, data: config.dataFile, state: config.stateFile, installs: config.installStateFile, managedInstalls }));
      return 0;
    }
    case 'codex': {
      const { runCodexWrapper } = await import('./codex-wrapper.mjs');
      return runCodexWrapper(passthrough.length ? passthrough : rest.filter((arg) => arg !== '--'), { config });
    }
    default: throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}
