// Human reports: `ttt report` (one project) and `ttt all` (every project).
import { fmtDur, fmtTok, fmtUnit, truncate, localDayKey, startOfLocalDay, width, MIN, HOUR } from './util.mjs';
import { tokensToMs, msToTokens } from './model.mjs';
import { c, sparkline } from './style.mjs';

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
    lpad(v.agents ? c.violet(`🤖${v.agents}`) : '', 4),
    `  ${truncate(v.prompt, 58)}`,
  ].join(' ');
}

export function projectReport(sum, { tasks = 12, now = Date.now() } = {}) {
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

  const recent = sum.tasks.slice(-tasks).reverse();
  L.push('');
  L.push(`  ${c.bold('Recent tasks')}  ${c.faint('when · status · active · ' + sum.tokenMode + ' tok · tok/min · agents · prompt')}`);
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
