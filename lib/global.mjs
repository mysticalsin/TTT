// A tiny cross-project memory of task durations, so a brand-new project can still get an
// ETA from how long your tasks usually take everywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './paths.mjs';

const KEEP = 400;
const file = () => path.join(cacheRoot(), 'global.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { projects: {} }; }
}

export function recordDurations(sum) {
  const g = load();
  g.projects ||= {};
  g.projects[sum.slug] = {
    name: sum.name,
    updatedAt: Date.now(),
    rate: sum.total.rate,
    durations: sum.durations.slice(-KEEP),
  };
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(g));
    fs.renameSync(tmp, file());
  } catch { /* cache is best effort */ }
}

/** Sorted durations from every other project (excluding `slug`). */
export function globalDurations(excludeSlug) {
  const g = load();
  const all = [];
  for (const [slug, p] of Object.entries(g.projects || {})) {
    if (slug !== excludeSlug) all.push(...(p.durations || []));
  }
  return all.sort((a, b) => a - b);
}

/** Token-weighted average rate across projects (tokens per active minute). */
export function globalRate() {
  const g = load();
  const ps = Object.values(g.projects || {}).filter((p) => p.rate > 0);
  if (!ps.length) return 0;
  const w = ps.map((p) => p.durations?.length || 1);
  return ps.reduce((a, p, i) => a + p.rate * w[i], 0) / w.reduce((a, b) => a + b, 0);
}
