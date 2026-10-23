// Usage-limit runway: turn "5h limit 62% used" into "≈3 more tasks like this".
//
// Claude Code reports the 5-hour window's used % and reset time on every refresh. We
// sample it, and measure how fast it rises *while a task is running*: % per working
// minute. Then: tasks left = headroom / (burn × your typical task length), and a
// running task gets a warning if its forecast outlasts the headroom before reset.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './paths.mjs';
import { MIN } from './util.mjs';

// v2: samples are kept per session. Concurrent sessions can report different usage (e.g.
// different accounts), and mixing their readings invents huge fake jumps.
const file = () => path.join(cacheRoot(), 'limits.v2.json');
const WINDOW_MS = 5 * 60 * MIN;
const MAX_GAP = 5 * MIN; // samples further apart than this don't count as continuous
const MAX_JUMP_PER_MIN = 12; // % per minute beyond this is a different account, not real burn

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { windows: {} }; }
}

function save(s) {
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file());
  } catch { /* best effort */ }
}

/** Record one observation. `working` = this session has a task in flight. */
export function sample(rateLimits, working, now = Date.now(), sid = 'default') {
  const five = rateLimits?.five_hour;
  const pct = Number(five?.used_percentage);
  const reset = Number(five?.resets_at);
  if (!Number.isFinite(pct) || !Number.isFinite(reset)) return null;
  const s = load();
  s.windows ||= {};
  // Round so tiny jitter in the reported reset time can't split one window in two.
  const key = String(Math.round(reset / 300) * 300);
  const w = (s.windows[key] ||= { samples: [] });
  const mine = w.samples.filter((x) => x[3] === sid);
  const last = mine.at(-1);
  if (!last || now - last[0] >= 20_000 || last[1] !== pct) {
    w.samples.push([now, pct, working ? 1 : 0, sid]);
    if (w.samples.length > 600) w.samples.splice(0, w.samples.length - 600);
    // Keep the current window and the previous few (burn rates carry over between windows).
    const keys = Object.keys(s.windows).sort((a, b) => Number(a) - Number(b));
    for (const k of keys.slice(0, -4)) delete s.windows[k];
    save(s);
  }
  return { pct, reset: reset * 1000, windows: s.windows };
}

/** % of the 5h limit burned per minute of Claude working, from all recent windows. */
export function burnRate(windows) {
  let dp = 0, dt = 0;
  for (const w of Object.values(windows || {})) {
    const bySid = new Map();
    for (const x of w.samples) bySid.set(x[3], [...(bySid.get(x[3]) || []), x]);
    for (const xs of bySid.values()) {
      for (let i = 1; i < xs.length; i++) {
        const [t0, p0, k0] = xs[i - 1], [t1, p1] = xs[i];
        if (!k0 || t1 - t0 > MAX_GAP || p1 < p0) continue;
        if ((p1 - p0) / Math.max((t1 - t0) / MIN, 0.25) > MAX_JUMP_PER_MIN) continue;
        dp += p1 - p0; dt += t1 - t0;
      }
    }
  }
  if (dt < 3 * MIN || dp <= 0) return null;
  return dp / (dt / MIN);
}

/**
 * @returns {null | {pct, headroom, tasksLeft, capAt, resetAt, burn}}
 *   tasksLeft  how many typical tasks fit before the cap
 *   capAt      when the running task would hit the cap (only if before reset)
 */
export function runway(rateLimits, { working, typicalMs, remainingMs, now = Date.now(), sid } = {}) {
  const obs = sample(rateLimits, working, now, sid);
  if (!obs) return null;
  let burn = burnRate(obs.windows);
  if (!burn) {
    // Not enough working samples yet: fall back to the window's average so far, which
    // under-states burn (idle time included) — so we only use it when nothing better exists.
    const elapsed = now - (obs.reset - WINDOW_MS);
    if (elapsed > 10 * MIN && obs.pct > 0) burn = obs.pct / (elapsed / MIN);
  }
  const headroom = Math.max(0, 100 - obs.pct);
  const out = { pct: obs.pct, headroom, resetAt: obs.reset, burn, tasksLeft: null, capAt: null };
  if (!burn) return out;
  if (typicalMs > 0) out.tasksLeft = headroom / (burn * (typicalMs / MIN));
  const minutesToCap = headroom / burn;
  const capAt = now + minutesToCap * MIN;
  if (working && remainingMs > 0 && minutesToCap * MIN < remainingMs && capAt < obs.reset) out.capAt = capAt;
  return out;
}
