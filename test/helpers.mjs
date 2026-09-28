import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'tokenwatch-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(root) {
  return {
    version: 1,
    dataFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    installStateFile: path.join(root, 'install-state.json'),
    experimentsFile: path.join(root, 'experiments.jsonl'),
    pricingFile: null,
    projectSalt: 'a'.repeat(64),
    cacheTtlSeconds: 300,
    averagingWindow: 10,
    retentionDays: 90,
    status: {
      maxWidth: 140, showCost: true, showTokens: true,
      showCache: true, showContext: true, showSubagents: true
    },
    privacy: {
      projectIdentity: 'hmac-sha256', storeToolNames: true,
      storeModelNames: true, storeDurations: true
    },
    codex: {
      // 0, not Codex's real 4318: a test that starts a receiver from this
      // config without its own port would otherwise bind the port a
      // developer's running Codex may be using.
      command: 'codex', otlpHost: '127.0.0.1', otlpPort: 0,
      otlpPath: '/v1/logs', installOtelConfig: true
    },
    paths: {}
  };
}

export function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

// A Windows path spelled out with backslashes and a drive letter, rather than
// built with `path.join`, so a case about how Windows writes a path runs, and
// means the same thing, on every OS. `windowsPath('Users', 'me', 'cli.mjs')`
// is `C:\Users\me\cli.mjs`.
export function windowsPath(...segments) {
  return ['C:', ...segments].join('\\');
}

// The same value as it appears inside a TOML basic string, such as a Codex
// `notify = ["..."]` line: every backslash doubled and every quote escaped.
// Written out by the TOML rule rather than borrowed from `JSON.stringify`,
// which is what the installer itself uses and so could not check it.
export function tomlEscaped(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Windows lets an account create a symbolic link only with Developer Mode on
// or from an elevated shell, so a test whose subject is a symlink cannot set
// up its own premise there. Returns the skip reason in that case, and false
// everywhere a link can be made. Only Windows is probed: anywhere else a
// failure to link is a real failure and should surface as one.
export function symlinkUnavailable() {
  if (process.platform !== 'win32') return false;
  const root = tempDir('tokenwatch-symlink-probe-');
  try {
    fs.writeFileSync(path.join(root, 'target'), '');
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'));
    return false;
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    return 'this Windows account cannot create symbolic links (EPERM); enable Developer Mode or run elevated to exercise it';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
