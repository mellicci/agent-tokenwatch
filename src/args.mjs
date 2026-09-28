function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgv(argv) {
  const positionals = [];
  const options = {};
  let passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('--no-')) {
      options[camel(arg.slice(5))] = false;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options[camel(arg.slice(2, eq))] = arg.slice(eq + 1);
        continue;
      }
      const key = camel(arg.slice(2));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg === '-h') options.help = true;
      else if (arg === '-v') options.version = true;
      else positionals.push(arg);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options, passthrough };
}

export function boolOption(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function listOption(value, fallback = []) {
  if (value === undefined || value === true) return fallback;
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}
