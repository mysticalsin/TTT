// ANSI styling, matched to tonys-tcc's cc-health.sh palette.
const on = !process.env.NO_COLOR;
const esc = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: esc('38;5;245'),
  faint: esc('38;5;240'),
  green: esc('38;5;115'),
  amber: esc('38;5;215'),
  red: esc('38;5;203'),
  cyan: esc('38;5;80'),
  sky: esc('38;5;117'),
  violet: esc('38;5;141'),
  pink: esc('38;5;211'),
  gold: esc('38;5;222'),
  white: esc('97'),
  bold: esc('1'),
};

function hsv(h) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h), f = h - i;
  const [r, g, b] = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][i];
  return `38;2;${Math.round(r * 255)};${Math.round(g * 255)};${Math.round(b * 255)}`;
}

/**
 * Progress bar with a truecolor hue sweep (cyan → violet by default), echoing the
 * rainbow rule. `frac` in [0,1]; extra `over` turns the tip red when past forecast.
 */
export function gradientBar(frac, cells = 8, { from = 180, to = 300, over = false } = {}) {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * cells);
  let s = '';
  for (let i = 0; i < cells; i++) {
    const ch = i < full ? '▰' : '▱';
    if (!on) { s += ch; continue; }
    const code = i < full
      ? (over && i === full - 1 ? '38;5;203' : hsv(from + ((to - from) * i) / Math.max(1, cells - 1)))
      : '38;5;238';
    s += `\x1b[${code}m${ch}`;
  }
  return on ? `${s}\x1b[0m` : s;
}

/** Unicode sparkline for a series. */
export function sparkline(values) {
  const ticks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 0);
  return values.map((v) => (v <= 0 ? (on ? '\x1b[38;5;238m·\x1b[0m' : '·') : ticks[Math.min(7, Math.floor((v / max) * 7.999))])).join('');
}
