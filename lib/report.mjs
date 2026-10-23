// Human reports: `ttt report` (one project) and `ttt all` (every project).
import { fmtDur, fmtTok, fmtUnit, truncate, localDayKey, startOfLocalDay, width, MIN, HOUR } from './util.mjs';
import { tokensToMs, msToTokens } from './model.mjs';
import { c, sparkline } from './style.mjs';
import { fmtUsd } from './pricing.mjs';
import { blockedCauses } from './blocked.mjs';

const pct = (x) => `${Math.round(x * 100)}%`;

/** Horizontal share bars for "where the time goes". */
export function breakdownRows(b, { width: W = 24, top = 5 } = {}) {
  const tools = Object.entries(b.tools || {}).sort((x, y) => y[1] - x[1]);
  const rows = [['model thinking & writing', b.model, c.cyan]];
  for (const [k, ms] of tools.slice(0, top)) rows.push([k, ms, c.sky]);
  const rest = tools.slice(top).reduce((a, [, ms]) => a + ms, 0);
  if (rest >= 1000) rows.push([`${tools.length - top} other tools`, rest, c.dim]);
  if (b.wait) rows.push(['waiting on you', b.wait, c.amber]);
  const total = rows.reduce((a, [, ms]) => a + ms, 0) || 1;
  return rows.filter(([, ms]) => ms >= 1000).map(([k, ms, col]) => {
    const f = ms / total;
    const cells = Math.max(1, Math.round(f * W));
    return `${pad(c.dim(truncate(k, 26)), 28)}${col('█'.repeat(cells))}${c.faint('░'.repeat(W - cells))} ${lpad(c.white(fmtDur(ms)), 7)} ${c.dim(lpad(pct(f), 4))}`;
  });
}

/** Model × kind economics: where a cheaper model did the same kind of work about as fast. */
export function economics(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (t.status !== 'done' || !t.model) continue;
    const k = `${t.kind}|${t.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const rows = [];
  for (const [k, ts] of groups) {
    const [kind, model] = k.split('|');
    rows.push({ kind, model, n: ts.length, time: med(ts.map((t) => t.active)), tokens: med(ts.map((t) => t.tokens)), cost: med(ts.map((t) => t.cost)) });
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || b.n - a.n);
  const tips = [];
  const byKind = new Map();
  for (const r of rows.filter((x) => x.n >= 2)) byKind.set(r.kind, [...(byKind.get(r.kind) || []), r]);
  for (const [kind, rs] of byKind) {
    if (rs.length < 2) continue;
    const priciest = rs.reduce((x, y) => (y.cost > x.cost ? y : x));
    const cheapest = rs.reduce((x, y) => (y.cost < x.cost ? y : x));
    if (cheapest !== priciest && cheapest.cost < priciest.cost * 0.6 && cheapest.time <= priciest.time * 1.5) {
      tips.push(`${kind}: ${cheapest.model} took ${fmtDur(cheapest.time)} vs ${fmtDur(priciest.time)} on ${priciest.model}, at ${Math.round((1 - cheapest.cost / priciest.cost) * 100)}% less cost (medians of ${cheapest.n} vs ${priciest.n} tasks)`);
    }
  }
  return { rows, tips };
}

const pad = (s, n) => `${s}${' '.repeat(Math.max(0, n - width(s)))}`;
const lpad = (s, n) => `${' '.repeat(Math.max(0, n - width(s)))}${s}`;

function when(t, now) {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (t >= startOfLocalDay(now)) return `today ${hm}`;
  if (t >= startOfLocalDay(now) - 24 * HOUR) return `yest. ${hm}`;
  return `${localDayKey(t).slice(5)} ${hm}`;
}

const STATUS = {
  running: () => c.amber('⏳ run'),
  done: () => c.green('✓ done'),
  interrupted: () => c.dim('⏹ stop'),
  stalled: () => c.dim('💤 idle'),
};

function exchange(sum) {
  const r = sum.total.rate;
  if (!(r > 0)) return c.dim('not enough history yet');
  const unit = sum.total.tokens >= 2e6 ? 1e6 : 1e5;
  return [
    `${c.pink(`${fmtUnit(unit)} ${sum.tokenMode}`)} ≈ ${c.white(fmtDur(tokensToMs(unit, r)))}`,
    `${c.pink('1h')} ≈ ${c.white(fmtTok(msToTokens(HOUR, r)))} ${c.dim(sum.tokenMode)}`,
    `${c.sky(fmtTok(r))}${c.dim('/min of real time')}`,
  ].join(c.dim('   ·   '));
}

function bucketLine(b, tokenMode) {
  if (!b.n) return c.dim('—');
  const par = b.parallel >= 1.15 ? c.violet(` (${fmtDur(b.agentTime)} agent-time, ×${b.parallel.toFixed(1)})`) : '';
  return `${c.white(fmtDur(b.wall))}${par}  ${c.dim('·')}  ${c.cyan(fmtTok(b.tokens))} ${c.dim(tokenMode)}  ${c.dim('·')}  ${b.n} ${c.dim(b.n === 1 ? 'task' : 'tasks')}`;
}

function taskRow(v, now) {
  const rate = v.active > 0 ? fmtTok(v.tokens / (v.active / MIN)) : '–';
  return [
    pad(c.dim(when(v.start, now)), 12),
    pad(STATUS[v.status](), 8),
    lpad(c.white(fmtDur(v.active)), 7),
    lpad(c.cyan(fmtTok(v.tokens)), 7),
    lpad(c.sky(rate), 6),
    lpad(c.gold(fmtUsd(v.cost)), 7),
    lpad(v.agents ? c.violet(`🤖${v.agents}`) : '', 4),
    `  ${truncate(v.prompt, 58)}`,
  ].join(' ');
}

export function projectReport(sum, { tasks = 12, now = Date.now(), calib } = {}) {
  const t = sum.total;
  const L = [];
  L.push('');
  L.push(`  ${c.bold(c.gold('⏱ TTT'))} ${c.dim('· Token to Time ·')} ${c.bold(sum.name)}  ${c.faint(sum.cwd || sum.slug)}`);
  L.push('');
  if (!t.n) {
    L.push(c.dim('  No finished work in this project yet.'));
    return L.join('\n');
  }
  const row = (k, v) => L.push(`  ${pad(c.dim(k), 14)}${v}`);
  row('Real time', `${c.bold(c.white(fmtDur(t.wall)))} ${c.dim('wall-clock with Claude working (parallel sessions merged)')}`);
  row('Agent time', `${c.violet(fmtDur(t.agentTime))} ${c.dim(`main + subagents  ·  ×${t.parallel.toFixed(1)} parallel`)}`);
  row('Tokens', `${c.cyan(fmtTok(t.out))} ${c.dim('out')}  ${c.dim('·')}  ${fmtTok(t.in + t.cw)} ${c.dim('in+cache-write')}  ${c.dim('·')}  ${c.faint(`${fmtTok(t.cr)} cache-read`)}`);
  row('Tasks', `${c.white(t.n)}  ${c.dim('·')}  ${c.dim('median')} ${fmtDur(sum.p50)}  ${c.dim('·')}  ${c.dim('p90')} ${fmtDur(sum.p90)}  ${c.dim('·')}  ${t.agents} ${c.dim('subagents')}`);
  row('Exchange', exchange(sum));
  row('Today', bucketLine(sum.today, sum.tokenMode));
  row('Last 7 days', bucketLine(sum.week, sum.tokenMode));

  // 14-day sparkline of real time.
  const byDay = new Map(sum.days.map((d) => [d.day, d]));
  const series = [];
  for (let i = 13; i >= 0; i--) series.push(byDay.get(localDayKey(startOfLocalDay(now) - i * 24 * HOUR))?.wall || 0);
  const peak = Math.max(...series);
  L.push(`  ${pad(c.dim('14 days'), 14)}${c.green(sparkline(series))}  ${c.dim(`peak ${fmtDur(peak)}/day`)}`);

  if (sum.models.length) {
    const tot = sum.models.reduce((a, m) => a + m.out, 0) || 1;
    row('Models', sum.models.slice(0, 4).map((m) => `${c.white(m.model)} ${c.dim(`${Math.round((100 * m.out) / tot)}%`)}`).join(c.dim('  ·  ')));
  }

  row('API cost', `${c.gold(fmtUsd(t.cost))} ${c.dim('API-equivalent')}  ${c.dim('·')}  ${fmtUsd(t.n ? t.cost / t.n : 0)} ${c.dim('per task')}${sum.today.n ? `  ${c.dim('·')}  ${c.gold(fmtUsd(sum.today.cost))} ${c.dim('today')}` : ''}`);
  if (calib?.ok) {
    const better = calib.naiveOffBy / calib.offBy;
    row('Forecasts', `${c.white(`typically off by ×${calib.offBy.toFixed(1)}`)}  ${c.dim('·')}  ${pct(calib.within2x)} ${c.dim('within 2×')}  ${c.dim('·')}  ${better >= 1.05 ? c.green(`${better.toFixed(1)}× better than guessing the median`) : c.dim('no better than the median yet')}  ${c.faint(`(backtest of ${calib.n} tasks)`)}`);
  }

  L.push('');
  L.push(`  ${c.bold('Where the time goes')}  ${c.faint('main thread · subagents run alongside')}`);
  for (const r of breakdownRows(t)) L.push(`  ${r}`);

  const causes = blockedCauses(t.blocked);
  if (causes.length) {
    L.push('');
    L.push(`  ${c.bold('Waiting on you')}  ${c.amber(fmtDur(t.wait))} ${c.dim(`over ${t.waits} prompts`)}  ${c.faint('· ttt blocked for fixes')}`);
    for (const k of causes.slice(0, 4)) {
      L.push(`  ${pad(c.white(truncate(k.label, 26)), 28)}${lpad(c.amber(fmtDur(k.ms)), 8)} ${c.dim(`×${k.count}`)}  ${k.rule ? c.faint(`allow ${k.rule}`) : c.faint('questions Claude asked you')}`);
    }
  }

  const eco = economics(sum.tasks);
  if (eco.rows.some((r) => r.n >= 2)) {
    L.push('');
    L.push(`  ${c.bold('Models on your work')}  ${c.faint('median per task')}`);
    L.push(`  ${c.faint(pad('kind', 12))}${c.faint(pad('model', 13))}${c.faint(lpad('tasks', 6))}${c.faint(lpad('time', 9))}${c.faint(lpad(sum.tokenMode, 8))}${c.faint(lpad('cost', 8))}`);
    for (const r of eco.rows.filter((x) => x.n >= 2).slice(0, 10)) {
      L.push(`  ${pad(c.dim(r.kind), 12)}${pad(c.white(r.model), 13)}${lpad(String(r.n), 6)}${lpad(c.white(fmtDur(r.time)), 9)}${lpad(c.cyan(fmtTok(r.tokens)), 8)}${lpad(c.gold(fmtUsd(r.cost)), 8)}`);
    }
    for (const tip of eco.tips.slice(0, 3)) L.push(`  ${c.green('↳')} ${c.dim(tip)}`);
  }

  const recent = sum.tasks.slice(-tasks).reverse();
  L.push('');
  L.push(`  ${c.bold('Recent tasks')}  ${c.faint('when · status · active · ' + sum.tokenMode + ' tok · tok/min · cost · agents · prompt')}`);
  for (const v of recent) L.push(`  ${taskRow(v, now)}`);

  const longest = [...sum.tasks].sort((a, b) => b.active - a.active).slice(0, 5);
  L.push('');
  L.push(`  ${c.bold('Longest tasks')}`);
  for (const v of longest) L.push(`  ${taskRow(v, now)}`);
  L.push('');
  return L.join('\n');
}

export function allReport(sums, { now = Date.now() } = {}) {
  const rows = sums.filter((s) => s.total.n).sort((a, b) => b.total.wall - a.total.wall);
  const tot = rows.reduce((a, s) => ({
    wall: a.wall + s.total.wall, agent: a.agent + s.total.agentTime, tok: a.tok + s.total.tokens,
    n: a.n + s.total.n, today: a.today + s.today.wall,
  }), { wall: 0, agent: 0, tok: 0, n: 0, today: 0 });
  const L = [''];
  L.push(`  ${c.bold(c.gold('⏱ TTT'))} ${c.dim('· Token to Time · all projects')}`);
  L.push('');
  L.push(`  ${c.faint(pad('project', 26))}${c.faint(lpad('real', 9))}${c.faint(lpad('agent', 9))}${c.faint(lpad(sums[0]?.tokenMode || 'out', 8))}${c.faint(lpad('tasks', 7))}${c.faint(lpad('tok/min', 9))}${c.faint(lpad('today', 9))}  ${c.faint('last active')}`);
  for (const s of rows) {
    const last = s.tasks.at(-1)?.end;
    L.push(`  ${pad(c.gold(truncate(s.name, 24)), 26)}${lpad(c.white(fmtDur(s.total.wall)), 9)}${lpad(c.violet(fmtDur(s.total.agentTime)), 9)}${lpad(c.cyan(fmtTok(s.total.tokens)), 8)}${lpad(String(s.total.n), 7)}${lpad(c.sky(fmtTok(s.total.rate)), 9)}${lpad(s.today.n ? c.green(fmtDur(s.today.wall)) : c.faint('·'), 9)}  ${c.dim(last ? when(last, now) : '')}`);
  }
  L.push(`  ${c.faint('─'.repeat(90))}`);
  L.push(`  ${pad(c.bold('Σ'), 26)}${lpad(c.bold(fmtDur(tot.wall)), 9)}${lpad(c.violet(fmtDur(tot.agent)), 9)}${lpad(c.cyan(fmtTok(tot.tok)), 8)}${lpad(String(tot.n), 7)}${lpad('', 9)}${lpad(tot.today ? c.green(fmtDur(tot.today)) : '', 9)}`);
  L.push(c.faint('  real = wall-clock with Claude working (per project; parallel sessions merged) · agent = main + subagent time'));
  L.push('');
  return L.join('\n');
}
