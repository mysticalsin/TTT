// Whole-project forecast: estimate every open item on your roadmap from similar past tasks.
// Sources: a markdown checklist (TODO.md, ROADMAP.md, PLAN.md, …) or GitHub issues.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { estimate } from './forecast.mjs';
import { buildIndex } from './similar.mjs';
import { quantile, localDayKey, startOfLocalDay, HOUR } from './util.mjs';

export const PLAN_FILES = ['TODO.md', 'ROADMAP.md', 'PLAN.md', 'TASKS.md', 'docs/ROADMAP.md', 'docs/TODO.md', '.claude/TODO.md'];

export function findPlanFile(cwd) {
  // TTT_PLAN_FILE points at a roadmap that lives outside the repo (a notes app, a vault…).
  if (process.env.TTT_PLAN_FILE) return fs.existsSync(process.env.TTT_PLAN_FILE) ? process.env.TTT_PLAN_FILE : null;
  if (!cwd) return null;
  for (const f of PLAN_FILES) {
    const p = path.join(cwd, f);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** "- [ ] Add OAuth" / "* [x] done" → items; nested items and headings give context. */
export function parseChecklist(text) {
  const items = [];
  let heading = '';
  for (const line of String(text).split('\n')) {
    const h = /^#{1,6}\s+(.*)/.exec(line);
    if (h) { heading = h[1].trim(); continue; }
    const m = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (m) items.push({ done: m[1] !== ' ', title: m[2].replace(/\s+$/, ''), section: heading });
  }
  return items;
}

export function githubIssues(cwd) {
  try {
    const out = execFileSync('gh', ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels'], { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out).map((i) => ({ done: false, title: `#${i.number} ${i.title}`, section: (i.labels || []).map((l) => l.name).join(', ') }));
  } catch {
    return null;
  }
}

/** Your recent pace: average real Claude-time per active day over the last 14 days. */
export function dailyPace(sum, now = Date.now()) {
  const from = localDayKey(startOfLocalDay(now) - 13 * 24 * HOUR);
  const days = sum.days.filter((d) => d.day >= from && d.wall > 0);
  if (!days.length) return 0;
  return days.reduce((a, d) => a + d.wall, 0) / days.length;
}

/**
 * Estimate each open item. Returns totals and a finish date at your daily pace.
 * @param items  [{title, done, section}]
 */
export function forecastPlan(sum, items, { others = [], now = Date.now() } = {}) {
  const done = sum.tasks.filter((t) => t.status === 'done' && t.active > 0);
  const pool = [...done, ...others];
  const index = buildIndex(pool);
  const fallback = done.length >= 5 ? done.map((t) => t.active).sort((a, b) => a - b) : pool.map((t) => t.active).sort((a, b) => a - b);
  const median = quantile(fallback, 0.5);
  const medTok = quantile(pool.map((t) => t.tokens).sort((a, b) => a - b), 0.5);
  const open = items.filter((i) => !i.done).map((i) => {
    const e = estimate(sum, { key: `plan:${i.title}`, prompt: i.title, active: 0 }, { done, pool, index, fallbackDurations: fallback });
    const ms = e.ok ? e.total : median;
    return { ...i, ms: Number.isFinite(ms) ? ms : 0, tokens: e.ok && Number.isFinite(e.tokens) ? e.tokens : medTok, source: e.ok ? e.source : 'median', like: e.like };
  });
  const totalMs = open.reduce((a, i) => a + i.ms, 0);
  const totalTok = open.reduce((a, i) => a + (Number.isFinite(i.tokens) ? i.tokens : 0), 0);
  const pace = dailyPace(sum, now);
  const days = pace > 0 ? totalMs / pace : NaN;
  return {
    open, doneCount: items.length - open.length, total: items.length, totalMs, totalTok, pace, days,
    finishAt: Number.isFinite(days) ? now + Math.ceil(days) * 24 * HOUR : null,
  };
}
