// Turn indexed tasks into time: active time, real (calendar) time, rates, forecasts.
import path from 'node:path';
import { MIN, quantile, startOfLocalDay, localDayKey } from './util.mjs';

/** Gaps longer than this are you, not Claude (reading, away, a permission prompt left open). */
export const IDLE_MS = Number(process.env.TTT_IDLE_MIN || 5) * MIN;
/** A task with no new entry for this long is treated as stalled, not running. */
export const STALL_MS = Number(process.env.TTT_STALL_MIN || 30) * MIN;
/** Which tokens count: out (generated, default) | work (in+out+cache writes) | all (incl. cache reads). */
export const TOKEN_MODE = process.env.TTT_TOKENS || 'out';

export function tokensOf(t, mode = TOKEN_MODE) {
  if (mode === 'all') return t.in + t.out + t.cw + t.cr;
  if (mode === 'work') return t.in + t.out + t.cw;
  return t.out;
}

/** Active segments [startMs, endMs] of a task: consecutive events closer than idleMs. */
export function segments(tsSec, idleMs = IDLE_MS) {
  if (!tsSec.length) return [];
  const ts = [...tsSec].sort((a, b) => a - b);
  const out = [];
  let s = ts[0], e = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if ((ts[i] - e) * 1000 <= idleMs) e = ts[i];
    else { out.push([s * 1000, e * 1000]); s = e = ts[i]; }
  }
  out.push([s * 1000, e * 1000]);
  return out;
}

const sumSeg = (segs) => segs.reduce((a, [s, e]) => a + (e - s), 0);

/** Length of the union of intervals: wall-clock time with *any* Claude work in flight. */
export function unionMs(intervals) {
  if (!intervals.length) return 0;
  const iv = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    const [s, e] = iv[i];
    if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  return total + (ce - cs);
}

export function taskStatus(t, now = Date.now()) {
  if (t.interrupted) return 'interrupted';
  if (t.stop === 'end_turn' || t.stop === 'stop_sequence' || t.stop === 'max_tokens' || t.stop === 'refusal') return 'done';
  if (now - t.end > STALL_MS) return 'stalled';
  return 'running';
}

/** Per-task view with derived timings. */
export function viewTask(t, now = Date.now()) {
  const segs = segments(t.ts);
  const status = taskStatus(t, now);
  let active = sumSeg(segs);
  // A running task is still burning time since its last transcript entry.
  const tail = status === 'running' ? Math.min(Math.max(0, now - t.end), IDLE_MS) : 0;
  const wall = (status === 'running' ? now : t.end) - t.start;
  active = Math.min(active + tail, Math.max(wall, 0));
  let agentTime = tail;
  for (const [, ms] of Object.values(t.work || {})) agentTime += ms;
  agentTime = Math.max(agentTime, active);
  return {
    key: t.key, sid: t.sid, prompt: t.prompt, start: t.start, end: t.end, status,
    active, wall, agentTime, segs,
    in: t.in, out: t.out, cw: t.cw, cr: t.cr, tokens: tokensOf(t),
    msgs: t.msgs, agentMsgs: t.agentMsgs, agents: t.agents.length, models: t.models,
  };
}

function bucket() {
  return { n: 0, active: 0, wall: 0, agentTime: 0, tokens: 0, in: 0, out: 0, cw: 0, cr: 0, agents: 0, segs: [] };
}

function add(b, v) {
  b.n++; b.active += v.active; b.agentTime += v.agentTime; b.tokens += v.tokens; b.agents += v.agents;
  b.in += v.in; b.out += v.out; b.cw += v.cw; b.cr += v.cr;
  for (const s of v.segs) b.segs.push(s);
}

function close(b) {
  b.wall = unionMs(b.segs);
  b.parallel = b.wall > 0 ? b.agentTime / b.wall : 0; // ×N agents working at once, on average
  // Exchange rate in *real* time: what a minute of the clock buys, parallelism included.
  b.rate = b.wall > 0 ? b.tokens / (b.wall / MIN) : 0;
  delete b.segs;
  return b;
}

/** Full project summary from an indexer state. */
export function summarize(state, now = Date.now()) {
  const views = Object.values(state.tasks)
    .filter((t) => t.msgs > 0)
    .map((t) => viewTask(t, now))
    .sort((a, b) => a.start - b.start);

  const total = bucket(), today = bucket(), week = bucket();
  const days = new Map(), models = new Map();
  const dayStart = startOfLocalDay(now), weekStart = dayStart - 6 * 24 * 60 * MIN;
  for (const v of views) {
    add(total, v);
    if (v.start >= dayStart) add(today, v);
    if (v.start >= weekStart) add(week, v);
    const dk = localDayKey(v.start);
    if (!days.has(dk)) days.set(dk, bucket());
    add(days.get(dk), v);
    for (const [m, out] of Object.entries(v.models)) {
      const mb = models.get(m) || { model: m, out: 0, tasks: 0 };
      mb.out += out; mb.tasks++;
      models.set(m, mb);
    }
  }

  const done = views.filter((v) => v.status === 'done' && v.active > 0);
  const durations = done.map((v) => v.active).sort((a, b) => a - b);
  const cwd = state.cwd || null;
  return {
    slug: state.slug,
    cwd,
    name: cwd ? path.basename(cwd) : state.slug,
    updatedAt: state.updatedAt,
    tokenMode: TOKEN_MODE,
    tasks: views,
    total: close(total),
    today: close(today),
    week: close(week),
    days: [...days.entries()].map(([day, b]) => ({ day, ...close(b) })),
    models: [...models.values()].sort((a, b) => b.out - a.out),
    durations,
    p50: quantile(durations, 0.5),
    p90: quantile(durations, 0.9),
  };
}

/**
 * How much longer will a running task take?
 *
 * Survival estimate: among past tasks that ran *at least* as long as this one already has,
 * how much longer did they go? We report the median of that remaining time, and the 80th
 * percentile as a pessimistic bound. It sharpens as the project accumulates history.
 */
export function forecast(elapsed, durations, { minSample = 5 } = {}) {
  const n = durations.length;
  if (n < minSample) return { ok: false, reason: 'learning', n };
  const longer = durations.filter((d) => d > elapsed);
  const p90 = quantile(durations, 0.9);
  if (longer.length < 3) return { ok: false, reason: 'beyond', n, longer: longer.length, p90 };
  const rem = longer.map((d) => d - elapsed).sort((a, b) => a - b);
  const remaining = quantile(rem, 0.5);
  return {
    ok: true,
    n,
    support: longer.length,
    remaining,
    remainingHi: quantile(rem, 0.8),
    progress: elapsed / (elapsed + remaining),
    p50: quantile(durations, 0.5),
    p90,
  };
}

/** Exchange rate helpers: the project's measured tokens-per-active-minute. */
export function tokensToMs(tokens, ratePerMin) {
  return ratePerMin > 0 ? (tokens / ratePerMin) * MIN : NaN;
}

export function msToTokens(ms, ratePerMin) {
  return ratePerMin > 0 ? (ms / MIN) * ratePerMin : NaN;
}
