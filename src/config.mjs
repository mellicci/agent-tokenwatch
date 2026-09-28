import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_VERSION, DEFAULT_OTLP_PORT } from './constants.mjs';
import { atomicWriteJson, createJsonExclusively, ensureDir, isWriteRefused, readJsonSettled, resolvePath } from './fs-util.mjs';

export function tokenwatchHome(env = process.env) {
  return resolvePath(env.TOKENWATCH_HOME || path.join(os.homedir(), '.tokenwatch'));
}

export function configPath(env = process.env) {
  return resolvePath(env.TOKENWATCH_CONFIG || path.join(tokenwatchHome(env), 'config.json'));
}

export function defaultConfig(env = process.env) {
  const home = tokenwatchHome(env);
  return {
    version: CONFIG_VERSION,
    dataFile: env.TOKENWATCH_DATA || path.join(home, 'events.jsonl'),
    stateFile: path.join(home, 'state.json'),
    installStateFile: path.join(home, 'install-state.json'),
    experimentsFile: path.join(home, 'experiments.jsonl'),
    pricingFile: null,
    projectSalt: crypto.randomBytes(32).toString('hex'),
    cacheTtlSeconds: 300,
    averagingWindow: 10,
    retentionDays: 90,
    status: {
      maxWidth: 160,
      layout: 'multi',
      align: true,
      color: true,
      icons: true,
      showCost: true,
      showSession: true,
      showTokens: true,
      showCache: true,
      showContext: true,
      showSubagents: true,
      composeOrder: 'last',
      composeTimeoutMs: 1000
    },
    privacy: {
      projectIdentity: 'hmac-sha256',
      storeToolNames: true,
      storeModelNames: true,
      storeDurations: true
    },
    codex: {
      command: 'codex',
      otlpHost: '127.0.0.1',
      otlpPort: DEFAULT_OTLP_PORT,
      otlpPath: '/v1/logs',
      otlpProtocol: 'json',
      installOtelConfig: true
    },
    // Where `tokenwatch import` looks for each agent's session files; the
    // agent's own CLAUDE_CONFIG_DIR or CODEX_HOME wins (intent 06, D13).
    import: {
      claude: { sessionDir: '~/.claude/projects' },
      codex: { sessionDir: '~/.codex/sessions' },
      copilot: { sessionDir: '~/.copilot/session-state' }
    },
    paths: {}
  };
}

function mergeObject(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeObject(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// The compose settings, bounded where they are read rather than in
// normalizeConfig, because an injected config (tests, `main({ config })`)
// never passes through normalizeConfig (intent 04, decision D14). Which shell
// replays the other command is not a setting: it is recorded at install, so
// config.json is never one more place that decides what Tokenwatch runs (D20).
export function composeSettings(config) {
  const status = config?.status ?? {};
  const timeout = Number(status.composeTimeoutMs);
  return {
    order: status.composeOrder === 'first' ? 'first' : 'last',
    timeoutMs: Number.isFinite(timeout) ? Math.min(30000, Math.max(250, Math.round(timeout))) : 1000
  };
}

export function loadConfig({ create = true, env = process.env } = {}) {
  const file = configPath(env);
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  let existing = readJsonSettled(file, null);
  if (!isObject(existing)) {
    const config = defaultConfig(env);
    if (!create) return { config: normalizeConfig(config, env), file, created: false };
    ensureDir(path.dirname(file));
    // Several hooks can start together on a fresh install. Only one may create
    // the file; the others use what it wrote, so every process hashes projects
    // with the one projectSalt that is kept.
    if (existing === null && createJsonExclusively(file, config)) return { config: normalizeConfig(config, env), file, created: true };
    existing = readJsonSettled(file, null);
    if (!isObject(existing)) {
      // A file that holds no settings at all (`null`, `false`, an array) is
      // replaced, as it always was; otherwise every run would draw a new salt.
      atomicWriteJson(file, config);
      return { config: normalizeConfig(config, env), file, created: true };
    }
  }
  const config = mergeObject(defaultConfig(env), existing);
  if (!config.projectSalt) config.projectSalt = crypto.randomBytes(32).toString('hex');
  // Writing the merged defaults back is housekeeping, not a precondition: the
  // merged config is complete in memory either way. Inside a sandbox that can
  // read `~/.tokenwatch` but not write it - Codex's default - a config written
  // by an older version made every command fail here, reporting commands
  // included, until the user approved running outside the sandbox. The write is
  // simply retried on the next run that can make it.
  if (create && JSON.stringify(existing) !== JSON.stringify(config)) {
    try { atomicWriteJson(file, config); } catch (error) { if (!isWriteRefused(error)) throw error; }
  }
  return { config: normalizeConfig(config, env), file, created: false };
}

export function normalizeConfig(config, env = process.env) {
  const cwd = process.cwd();
  const normalized = structuredClone(config);
  normalized.dataFile = resolvePath(env.TOKENWATCH_DATA || normalized.dataFile, cwd);
  normalized.stateFile = resolvePath(normalized.stateFile, cwd);
  normalized.installStateFile = resolvePath(normalized.installStateFile, cwd);
  normalized.experimentsFile = resolvePath(normalized.experimentsFile, cwd);
  if (normalized.pricingFile) normalized.pricingFile = resolvePath(normalized.pricingFile, cwd);
  return normalized;
}

export function saveConfig(config, env = process.env) {
  const file = configPath(env);
  atomicWriteJson(file, config);
  return file;
}

export function setConfigValue(config, dottedKey, value) {
  const parts = dottedKey.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('A dotted configuration key is required.');
  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return config;
}

export function getConfigValue(config, dottedKey) {
  return dottedKey.split('.').filter(Boolean).reduce((value, key) => value?.[key], config);
}
