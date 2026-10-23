// The status-line segment. Claude Code pipes session JSON on stdin (via ccstatusline's
// custom-command widget); we print one ANSI line. Must stay fast: refreshes run every few
// seconds with a ~1s timeout, so heavy indexing is handed to a detached background job.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexProject, loadState, tryLock } from './indexer.mjs';
import { summarize, forecast, viewTask, tokensToMs } from './model.mjs';
import { projectDirFor, slugForCwd } from './paths.mjs';
import { fmtDur, fmtEta, fmtTok, fmtUnit, width } from './util.mjs';
import { c, gradientBar } from './style.mjs';
import { recordDurations, globalDurations } from './global.mjs';

/** Inline indexing budget; anything bigger goes to the background. */
const INLINE_BYTES = Number(process.env.TTT_INLINE_MB || 24) * 1024 * 1024;
const SEP = c.faint('  │  ');
const DOT = c.dim(' · ');
/** Column budget for the whole TTT line; ccstatusline truncates anything past it. */
const BUDGET = Number(process.env.TTT_WIDTH || 92);

/**
 * Join parts with " · ", dropping the lowest-priority ones until it fits `budget` columns.
 * parts: [text, priority] — higher priority survives longer; Infinity never drops.
 */
export function fit(parts, budget) {
  let keep = parts.filter(([t]) => t);
  const len = () => width(keep.map(([t]) => t).join(' · '));
  while (len() > budget) {
    let min = -1;
    keep.forEach(([, p], i) => { if (p !== Infinity && (min === -1 || p < keep[min][1])) min = i; });
    if (min === -1) break;
    keep.splice(min, 1);
  }
  return keep.map(([t]) => t).join(DOT);
}

function spawnBackgroundIndex(projectDir) {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ttt.mjs');
  try {
    spawn(process.execPath, [cli, 'index', '--dir', projectDir, '--quiet'], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best effort */ }
}

/** Index what we can afford inline; otherwise render from cache and refresh in background. */
export function freshState(projectDir) {
  const slug = path.basename(projectDir);
  const lock = tryLock(slug);
  if (!lock) return { state: loadState(slug), indexing: true };
  let r;
  try {
    r = indexProject(projectDir, { maxBytes: INLINE_BYTES });
  } finally {
    lock();
  }
  if (r.deferred) {
    spawnBackgroundIndex(projectDir); // only after releasing, so the job can take the lock
    return { state: r.state, indexing: true, pendingBytes: r.pendingBytes };
  }
  if (r.changed) recordDurations(summarize(r.state));
  return { state: r.state, indexing: false };
}

function tone(ms, p50, p90) {
  if (!Number.isFinite(p50)) return c.white;
  if (ms >= p90) return c.red;
  if (ms >= p50) return c.amber;
  return c.green;
}

/** "⏳ 3m12s ▰▰▰▱▱ ~4m left · 41.2k out · 12.8k/m · 🤖×3 ⚡2.1×"  or  "✅ last 5m02s · …" */
export function renderTask(sum, task, now = Date.now(), budget = Math.round(BUDGET * 0.48)) {
  if (!task) return c.dim('⏱ no task yet');
  const v = task.active != null ? task : viewTask(task, now);
  const rate = v.active > 0 ? v.tokens / (v.active / 60000) : 0;
  const tok = [`${c.cyan(fmtTok(v.tokens))} ${c.dim(sum.tokenMode)}`, 5];
  const spd = [v.active >= 5000 ? `${c.sky(fmtTok(rate))}${c.dim('/m')}` : null, 2];
  const par = v.agents && v.wall > 0 && v.agentTime / v.wall >= 1.15 ? ` ${c.violet(`⚡${(v.agentTime / v.wall).toFixed(1)}×`)}` : '';
  const agents = [v.agents ? `${c.violet(`🤖×${v.agents}`)}${par}` : null, 3];

  if (v.status === 'running') {
    let durations = sum.durations;
    if (durations.length < 5) durations = globalDurations(sum.slug);
    const fc = forecast(v.active, durations);
    const col = fc.ok ? tone(v.active, fc.p50, fc.p90) : c.white;
    let eta;
    if (fc.ok) eta = `${gradientBar(fc.progress, 6)} ${c.dim('~')}${c.white(fmtEta(fc.remaining))} ${c.dim('left')}`;
    else if (fc.reason === 'beyond') eta = `${gradientBar(1, 6, { over: true })} ${c.red('past p90')}`;
    else eta = c.dim(`learning ${fc.n}/5`);
    return fit([[`⏳ ${c.bold(col(fmtDur(v.active)))}`, Infinity], [eta, 9], tok, agents, spd], budget)
      .replace(`${DOT}`, ' '); // keep the clock and its ETA together
  }
  const icon = v.status === 'interrupted' ? '⏹' : v.status === 'stalled' ? '💤' : '✅';
  const col = tone(v.active, sum.p50, sum.p90);
  return fit([[`${icon} ${c.dim('last')} ${col(fmtDur(v.active))}`, Infinity], tok, agents, spd], budget);
}

/** "🏗 TTT 2h14m · 1.3M · 18 tasks · 6h40m agent · today 47m · 1M≈1h44m" */
export function renderProject(sum, budget = Math.round(BUDGET * 0.52) - 5) {
  const t = sum.total;
  if (!t.n) return c.dim(`🏗 ${sum.name} · first task`);
  const parts = [
    [`🏗 ${c.bold(c.gold(sum.name))} ${c.white(fmtDur(t.wall))}`, Infinity],
    [c.cyan(fmtTok(t.tokens)), 6],
    [`${c.white(t.n)} ${c.dim(t.n === 1 ? 'task' : 'tasks')}`, 5],
  ];
  if (t.agentTime > t.wall * 1.15) parts.push([`${c.violet(fmtDur(t.agentTime))} ${c.dim('agent')}`, 2]);
  if (sum.today.n && sum.today.wall < t.wall) parts.push([`${c.dim('today')} ${c.green(fmtDur(sum.today.wall))}`, 4]);
  // The exchange rate: what a fixed chunk of tokens costs you in real time here.
  if (t.rate > 0 && t.wall > 60_000) {
    const unit = t.tokens >= 2e6 ? 1e6 : t.tokens >= 2e5 ? 1e5 : 1e4;
    parts.push([c.pink(`${fmtUnit(unit)}≈${fmtDur(tokensToMs(unit, t.rate))}`), 3]);
  }
  return fit(parts, budget);
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Entry point for `ttt bar [full|task|project]`. */
export function bar(mode = 'full', input = readStdinJson(), now = Date.now()) {
  const cwd = input.workspace?.project_dir || input.workspace?.current_dir || input.cwd || process.cwd();
  const projectDir = input.transcript_path
    ? projectDirFor({ transcriptPath: input.transcript_path })
    : projectDirFor({ slug: slugForCwd(cwd) });
  if (!fs.existsSync(projectDir)) return c.dim('⏱ TTT · no transcripts yet');

  const { state, indexing, pendingBytes } = freshState(projectDir);
  if (!state.cwd) state.cwd = cwd;
  const sum = summarize(state, now);
  if (indexing && !sum.tasks.length) {
    const mb = pendingBytes ? ` ${Math.round(pendingBytes / 1048576)}MB` : '';
    return c.dim(`⏱ TTT indexing history${mb}…`);
  }

  // Current session's latest task; else the project's latest.
  const sid = input.session_id;
  const mine = sid ? sum.tasks.filter((t) => t.sid === sid) : [];
  const task = (mine.length ? mine : sum.tasks).at(-1);

  const taskSeg = renderTask(sum, task, now);
  const projSeg = renderProject(sum) + (indexing ? c.dim(' ↻') : '');
  if (mode === 'task') return taskSeg;
  if (mode === 'project') return projSeg;
  return `${taskSeg}${SEP}${projSeg}`;
}
