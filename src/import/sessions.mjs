import fs from 'node:fs';
import path from 'node:path';
import { MAX_IMPORT_DIR_DEPTH } from '../constants.mjs';
import { resolvePath } from '../fs-util.mjs';

// Where each agent keeps its session files. The agent's own override comes
// first (Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME), then the
// configured directory (intent 06, D13).
export function resolveSessionDir(agent, config, env = process.env) {
  if (agent === 'claude' && env.CLAUDE_CONFIG_DIR) return resolvePath(path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  if (agent === 'codex' && env.CODEX_HOME) return resolvePath(path.join(env.CODEX_HOME, 'sessions'));
  const configured = config.import?.[agent]?.sessionDir;
  return configured ? resolvePath(configured) : undefined;
}

// The files a mapping's glob names under a directory. Only the last segment is
// a pattern (`*` matches within a name); the directory is walked to any depth.
// Files not modified since `sinceMs` are left unopened (D11). Newest first.
// Only the last segment of a glob is a pattern; `*` matches within a name.
function globPattern(glob) {
  return new RegExp(`^${glob.split('/').at(-1).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
}

export function listSessionFiles(dir, glob, { sinceMs = -Infinity } = {}) {
  const pattern = globPattern(glob);
  const found = [];
  const walk = (at, depth) => {
    if (depth > MAX_IMPORT_DIR_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) {
        let mtimeMs;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtimeMs >= sinceMs) found.push({ file, mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}

// What a session directory holds, as counts only (intent 19, FR-09, D6): the
// regular files, how many match the glob before any --since filter, and their
// extensions. No file or directory name leaves this function.
export function describeSessionDir(dir, glob) {
  const pattern = globPattern(glob);
  const out = { files: 0, matching_glob: 0, extensions: {} };
  const walk = (at, depth) => {
    if (depth > MAX_IMPORT_DIR_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { walk(path.join(at, entry.name), depth + 1); continue; }
      if (!entry.isFile()) continue;
      out.files += 1;
      if (pattern.test(entry.name)) out.matching_glob += 1;
      // An extension is a file-name tail, so it is held to a short extension
      // shape; anything else is counted as <other>, never printed (review-fix, D11).
      const tail = path.extname(entry.name).toLowerCase();
      const extension = tail === '' || /^\.[a-z0-9]{1,8}$/.test(tail) ? tail : '<other>';
      out.extensions[extension] = (out.extensions[extension] ?? 0) + 1;
    }
  };
  walk(dir, 0);
  return out;
}
