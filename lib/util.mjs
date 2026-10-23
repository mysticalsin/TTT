// Formatting, parsing and small statistics helpers shared by every TTT module.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** 3725000 -> "1h02m", 95000 -> "1m35s", 4000 -> "4s". */
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, '0')}h`;
}

/** Coarser duration for ETAs: "~4m", "~1h10m". */
export function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 60_000) return '<1m';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** 1234 -> "1.2k", 1234567 -> "1.23M". */
export function fmtTok(n) {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (a < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (a < 100_000_000) return `${(n / 1e6).toFixed(2)}M`;
  if (a < 1e9) return `${Math.round(n / 1e6)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

/** Round token unit for exchange rates: 1e6 -> "1M", 1e5 -> "100k". */
export function fmtUnit(n) {
  return n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);
}

/** Tokens per active minute. */
export function rate(tokens, ms) {
  return ms > 0 ? tokens / (ms / MIN) : 0;
}

/** "250k" | "1.5M" | "42000" -> tokens. Returns NaN if not a token amount. */
export function parseTokens(str) {
  const m = /^\s*([\d.,_]+)\s*(k|m|b)?\s*(tok|tokens)?\s*$/i.exec(String(str));
  if (!m) return NaN;
  const n = Number(m[1].replace(/[,_]/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return n * mult;
}

/** "45m" | "2h" | "1h30m" | "90s" | "1.5h" -> ms. Returns NaN if not a duration. */
export function parseDuration(str) {
  const s = String(str).trim().toLowerCase();
  if (!/^(\d+(\.\d+)?\s*(d|h|m|min|s)\s*)+$/.test(s)) return NaN;
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|min|m|s)/g)) {
    ms += Number(n) * { d: 24 * HOUR, h: HOUR, min: MIN, m: MIN, s: 1000 }[u];
  }
  return ms;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function startOfLocalDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Strip ANSI escapes, for width math and tests. */
export function plain(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible width, counting emoji / wide glyphs as 2 columns. */
export function width(s) {
  let w = 0;
  for (const ch of plain(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) continue;
    w += cp >= 0x1f300 || (cp >= 0x231a && cp <= 0x23fa) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1100 && cp <= 0x115f) ? 2 : 1;
  }
  return w;
}

export function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
