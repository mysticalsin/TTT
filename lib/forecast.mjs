// The forecast engine: how long will a task take, and how many tokens?
//
// Three estimators, most specific first:
//   📋 plan     Claude declared its own plan (todo list, or a fan-out of subagents) and
//               part of it is done: extrapolate from the pace so far.
//   🔮 similar  Past tasks whose prompts look like this one (TF-IDF) across all your
//               projects (same project weighted 1.5×), conditioned on having already run this
//               long, weighted by similarity and matching model/effort. In a backtest over
//               182 real tasks this beat the project median by ~40% (typical miss ×2.6 vs ×4.6).
//   ⏳ history  Survival over every past task in the project (or all projects).
// Every estimate is then widened into a calibrated range using a backtest: replay history,
// predict each task from only the tasks before it, and measure how wrong we were.
import { buildIndex, neighbours, weightedQuantile } from './similar.mjs';
import { forecast as survival } from './model.mjs';
import { quantile } from './util.mjs';

const BACKTEST_MAX = 160;

function doneTasks(sum) {
  return sum.tasks.filter((t) => t.status === 'done' && t.active > 0);
}

const K = 7, SAME_PROJECT = 1.5;

/** Similar-prompt estimate of remaining time/tokens, given elapsed so far. */
function fromSimilar(index, pool, prompt, elapsed, opts) {
  const nb = neighbours(index, pool, prompt, { ...opts, k: 400 })
    .filter(({ task }) => task.active > elapsed)
    .map((n) => ({ ...n, w: n.w * (n.task.proj ? 1 : SAME_PROJECT) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, K);
  if (nb.length < 3) return null;
  const rem = weightedQuantile(nb.map(({ task, w }) => [task.active - elapsed, w]), 0.5);
  const tok = weightedQuantile(nb.map(({ task, w }) => [task.tokens, w]), 0.5);
  const sim = nb.reduce((a, b) => a + b.sim, 0) / nb.length;
  return { remaining: rem, tokens: tok, support: nb.length, sim, like: nb[0].task.prompt };
}

function fromPlan(plan, elapsed) {
  if (!plan || plan.done < 1 || plan.done >= plan.total || elapsed < 30_000) return null;
  const f = plan.done / plan.total;
  return { remaining: (elapsed * (1 - f)) / f, progress: f };
}

/**
 * @param sum      project summary (from summarize)
 * @param task     a task view (running, or a hypothetical {prompt, active: 0})
 * @param opts     { model, effort, fallbackDurations }
 */
export function estimate(sum, task, { model, effort, fallbackDurations = [], others = [], index, pool, done, calib } = {}) {
  done ||= doneTasks(sum).filter((t) => t.key !== task.key);
  pool ||= [...done, ...others];
  index ||= buildIndex(pool);
  const elapsed = task.active || 0;
  const plan = fromPlan(task.plan, elapsed);
  const sim = pool.length >= 5 ? fromSimilar(index, pool, task.prompt, elapsed, { model: model || task.model, effort: effort || task.effort }) : null;
  const durations = done.length >= 5 ? done.map((t) => t.active).sort((a, b) => a - b) : fallbackDurations;
  const hist = survival(elapsed, durations);

  let source, remaining;
  if (plan) { source = 'plan'; remaining = sim ? Math.sqrt(plan.remaining * Math.max(sim.remaining, 1)) : plan.remaining; }
  else if (sim) { source = 'similar'; remaining = sim.remaining; }
  else if (hist.ok) { source = 'history'; remaining = hist.remaining; }
  else return { ok: false, reason: hist.reason, n: hist.n, p90: hist.p90 };

  // Calibrated range: scale the predicted total by the backtest's error ratios.
  const total = elapsed + remaining;
  let lo = remaining, hi = remaining;
  if (calib?.ok) {
    lo = Math.max(0, total * calib.r20 - elapsed);
    hi = Math.max(lo, total * calib.r80 - elapsed);
  }
  const tokTotal = sim?.tokens;
  return {
    ok: true, source, remaining, lo, hi, total,
    progress: plan ? plan.progress : elapsed / total,
    tokens: tokTotal, like: sim?.like, support: sim?.support || hist.support || 0,
    p50: quantile(durations, 0.5), p90: quantile(durations, 0.9),
  };
}

/**
 * Replay history: for each finished task, predict its duration at the moment it started
 * using only tasks that finished before it (this project and others), then compare.
 * Errors are multiplicative ("off by ×2"), which is fair to both short and long tasks.
 */
export function backtest(sum, others = []) {
  const done = doneTasks(sum).sort((a, b) => a.start - b.start);
  const rows = [];
  const start = Math.max(5, done.length - BACKTEST_MAX);
  for (let i = start; i < done.length; i++) {
    const t = done[i];
    const prior = done.slice(0, i);
    const pool = [...prior, ...others.filter((o) => o.start + o.active < t.start)];
    const e = estimate(sum, { key: t.key, prompt: t.prompt, active: 0, model: t.model, effort: t.effort }, { done: prior, pool, index: buildIndex(pool) });
    const naive = quantile(prior.map((x) => x.active).sort((a, b) => a - b), 0.5);
    if (e.ok && e.total > 0) rows.push({ actual: t.active, predicted: e.total, naive, source: e.source });
  }
  if (rows.length < 6) return { ok: false, n: rows.length };
  const logErr = (a, p) => Math.abs(Math.log(a / p));
  const typical = (xs) => Math.exp(quantile(xs.sort((a, b) => a - b), 0.5));
  const ratios = rows.map((r) => r.actual / r.predicted).sort((a, b) => a - b);
  return {
    ok: true,
    n: rows.length,
    offBy: typical(rows.map((r) => logErr(r.actual, r.predicted))),
    naiveOffBy: typical(rows.map((r) => logErr(r.actual, r.naive))),
    // Last 20 in time order: is it improving as history grows?
    recentOffBy: typical(rows.slice(-20).map((r) => logErr(r.actual, r.predicted))),
    within2x: rows.filter((r) => logErr(r.actual, r.predicted) <= Math.LN2).length / rows.length,
    r20: quantile(ratios, 0.2),
    r80: quantile(ratios, 0.8),
  };
}
