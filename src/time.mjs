export function parseDuration(value, fallbackMs = undefined) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  if (typeof value === 'number') return value;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * factors[unit];
}

export function sinceDate(value, now = Date.now()) {
  if (!value) return undefined;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w)?$/i.test(text)) {
    return new Date(now - parseDuration(text)).toISOString();
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date or duration: ${value}`);
  return date.toISOString();
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(seconds < 864_000 ? 1 : 0)}d`;
}
