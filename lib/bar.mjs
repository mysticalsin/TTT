// The status-line segment. Claude Code pipes session JSON on stdin (via ccstatusline's
// custom-command widget); we print one ANSI line. Must stay fast: refreshes run every few
// seconds with a ~1s timeout, so heavy indexing is handed to a detached background job.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexProject, loadState, tryLock } from './indexer.mjs';
import { summarize, viewTask, tokensToMs } from './model.mjs';
import { estimate } from './forecast.mjs';
import { runway } from './limits.mjs';
import { findPlanFile, parseChecklist, forecastPlan } from './plan.mjs';
import { maybeNotify } from './notify.mjs';
import { shortModel } from './indexer.mjs';
import { projectDirFor, slugForCwd } from './paths.mjs';
import { fmtDur, fmtEta, fmtTok, fmtUnit, width } from './util.mjs';
import { c, gradientBar } from './style.mjs';
import { recordDurations, globalDurations, globalTasks } from './global.mjs';

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

const clock = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const SOURCE_ICON = { plan: '📋', similar: '🔮', history: '' };

/** Everything the bar needs beyond the summary: forecast inputs, limits, roadmap. */
function context(sum, input = {}, now = Date.now()) {
  return {
    now,
    others: globalTasks(sum.slug),
    fallback: globalDurations(sum.slug),
    model: shortModel(input.model?.id) || undefined,
    effort: input.effort?.level || undefined,
    rateLimits: input.rate_limits,
    cwd: input.workspace?.project_dir || input.cwd || sum.cwd,
  };
}

/**
 * Task segment. Running:
 *   "⏳ 3m12s ▰▰▱▱▱ 🔮~4m left · 41.2k out · 🤖3/5 ⚡2.1×"
 *   "⏳ 0s 🔮 ~14m · ~60k"                       (just sent: pre-flight estimate)
 *   "⏳ 9m02s 🌀 same error ×5 · …"              (loop alert)
 *   "⏳ 6m ⚠ cap 14:20 · …"                      (will hit the 5h limit first)
 * Idle:
 *   "✅ last 5m02s · 52.1k out · ⏸ you 1m10s"
 */
export function renderTask(sum, task, now = Date.now(), budget = Math.round(BUDGET * 0.48), ctx = context(sum, {}, now)) {
  if (!task) return c.dim('⏱ no task yet');
  const v = task.active != null ? task : viewTask(task, now);
  const rate = v.active > 0 ? v.tokens / (v.active / 60000) : 0;
  const tok = [`${c.cyan(fmtTok(v.tokens))} ${c.dim(sum.tokenMode)}`, 5];
  const spd = [v.active >= 5000 ? `${c.sky(fmtTok(rate))}${c.dim('/m')}` : null, 1];
  const par = v.agents && v.wall > 0 && v.agentTime / v.wall >= 1.15 ? ` ${c.violet(`⚡${(v.agentTime / v.wall).toFixed(1)}×`)}` : '';
  const agentCount = v.plan?.kind === 'agents' ? `🤖${v.plan.done}/${v.plan.total}` : `🤖×${v.agents}`;
  const agents = [v.agents ? `${c.violet(agentCount)}${par}` : null, 3];

  if (v.status === 'running') {
    const est = estimate(sum, v, { model: ctx.model, effort: ctx.effort, others: ctx.others, fallbackDurations: ctx.fallback });
    const col = est.ok ? tone(v.active, est.p50, est.p90) : c.white;
    const head = [`⏳ ${c.bold(col(fmtDur(v.active)))}`, Infinity];
    const alerts = [];
    if (v.loop) alerts.push([c.red(`🌀 ${v.loop.why}`), 10]);
    const rw = ctx.runway;
    if (rw?.capAt) alerts.push([c.red(`⚠ cap ${clock(rw.capAt)}`), 10]);

    let eta = null;
    const icon = est.ok ? SOURCE_ICON[est.source] : '';
    const planTag = v.plan && est.source === 'plan' ? c.dim(`${v.plan.done}/${v.plan.total} `) : '';
    if (est.ok && v.active < 20_000 && v.tokens < 2000) {
      // Just sent: what is this going to cost me?
      const tk = Number.isFinite(est.tokens) ? ` ${c.dim('·')} ${c.cyan(`~${fmtTok(est.tokens)}`)}` : '';
      eta = `${icon}${icon ? ' ' : ''}${c.white(`~${fmtEta(est.total)}`)}${tk}`;
    } else if (est.ok) {
      eta = `${gradientBar(est.progress, 5)} ${icon}${planTag}${c.white(`~${fmtEta(est.remaining)}`)} ${c.dim('left')}`;
    } else if (est.reason === 'beyond') {
      eta = `${gradientBar(1, 5, { over: true })} ${c.red('past p90')}`;
    } else {
      eta = c.dim(`learning ${est.n}/5`);
    }
    const line = fit([head, ...alerts, [eta, 9], v.tokens ? tok : [null, 0], agents, spd], budget);
    return line.replace(DOT, ' '); // keep the clock glued to what follows it
  }
  const icon = v.status === 'interrupted' ? '⏹' : v.status === 'stalled' ? '💤' : '✅';
  const col = tone(v.active, sum.p50, sum.p90);
  const waited = [v.br?.wait >= 30_000 ? `${c.amber('⏸')} ${c.dim('you')} ${c.amber(fmtDur(v.br.wait))}` : null, 2];
  return fit([[`${icon} ${c.dim('last')} ${col(fmtDur(v.active))}`, Infinity], tok, waited, agents, spd], budget);
}

/** "🏗 TTT 2h14m · 1.3M · 18 tasks · 🔋≈4 tasks · today 47m · 🏁 6h40m · 1M≈1h44m" */
export function renderProject(sum, budget = Math.round(BUDGET * 0.52) - 5, ctx = {}) {
  const t = sum.total;
  if (!t.n) return c.dim(`🏗 ${sum.name} · first task`);
  const parts = [
    [`🏗 ${c.bold(c.gold(sum.name))} ${c.white(fmtDur(t.wall))}`, Infinity],
    [c.cyan(fmtTok(t.tokens)), 6],
    [`${c.white(t.n)} ${c.dim(t.n === 1 ? 'task' : 'tasks')}`, 5],
  ];
  const rw = ctx.runway;
  if (rw && Number.isFinite(rw.tasksLeft)) {
    const n = rw.tasksLeft;
    const colr = n < 1.5 ? c.red : n < 4 ? c.amber : c.green;
    const shown = n >= 10 ? String(Math.round(n)) : n.toFixed(n < 2 ? 1 : 0);
    parts.push([`🔋${colr(`≈${shown}`)} ${c.dim(shown === '1' || shown === '1.0' ? 'task' : 'tasks')}`, 7]);
  }
  if (t.agentTime > t.wall * 1.15) parts.push([`${c.violet(fmtDur(t.agentTime))} ${c.dim('agent')}`, 2]);
  if (sum.today.n && sum.today.wall < t.wall) parts.push([`${c.dim('today')} ${c.green(fmtDur(sum.today.wall))}`, 4]);
  if (ctx.roadmap?.open?.length) parts.push([`🏁 ${c.white(fmtDur(ctx.roadmap.totalMs))}`, 4.5]);
  // The exchange rate: what a fixed chunk of tokens costs you in real time here.
  if (t.rate > 0 && t.wall > 60_000) {
    const unit = t.tokens >= 2e6 ? 1e6 : t.tokens >= 2e5 ? 1e5 : 1e4;
    parts.push([c.pink(`${fmtUnit(unit)}≈${fmtDur(tokensToMs(unit, t.rate))}`), 1]);
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

/** Roadmap forecast for the bar, if the project has a checklist file. */
function roadmapFor(sum, ctx) {
  const file = findPlanFile(ctx.cwd);
  if (!file) return null;
  try {
    const items = parseChecklist(fs.readFileSync(file, 'utf8'));
    if (!items.some((i) => !i.done)) return null;
    return forecastPlan(sum, items, { others: ctx.others, now: ctx.now });
  } catch {
    return null;
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
  const ctx = context(sum, input, now);
  const running = task?.status === 'running';

  // Runway needs the running task's forecast, so estimate once here.
  let est = null;
  if (task) est = estimate(sum, running ? task : { ...task, active: 0, plan: null }, { model: ctx.model, effort: ctx.effort, others: ctx.others, fallbackDurations: ctx.fallback });
  if (ctx.rateLimits) {
    ctx.runway = runway(ctx.rateLimits, {
      working: running, now, sid: input.session_id,
      typicalMs: Number.isFinite(sum.p50) ? sum.p50 : est?.p50,
      remainingMs: running && est?.ok ? est.remaining : 0,
    });
  }
  if (mode !== 'task') ctx.roadmap = roadmapFor(sum, ctx);
  if (task) maybeNotify(sum.name, task, { typical: !running && est?.ok ? est.total : NaN, loop: task.loop });

  const taskSeg = renderTask(sum, task, now, undefined, ctx);
  const projSeg = renderProject(sum, undefined, ctx) + (indexing ? c.dim(' ↻') : '');
  if (mode === 'task') return taskSeg;
  if (mode === 'project') return projSeg;
  return `${taskSeg}${SEP}${projSeg}`;
}
