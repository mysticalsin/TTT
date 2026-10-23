// `ttt dashboard`: one self-contained HTML file (no network, no dependencies) with your
// time, tokens and forecasts. It holds your prompts, so it stays local: ~/.cache/ttt/.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './paths.mjs';
import { blockedCauses } from './blocked.mjs';
import { economics } from './report.mjs';

const DAY = 24 * 3600_000;

function payload(sums, calib, now) {
  const projects = sums.filter((s) => s.total.n).sort((a, b) => b.total.wall - a.total.wall);
  const tasks = [];
  for (const s of projects) {
    for (const t of s.tasks) {
      tasks.push({
        p: s.name, prompt: t.prompt.slice(0, 140), start: t.start, end: t.end, status: t.status,
        active: t.active, agentTime: t.agentTime, tokens: t.tokens, cost: t.cost, agents: t.agents,
        model: t.model, kind: t.kind, segs: t.segs.slice(0, 60), wait: t.br.wait,
      });
    }
  }
  const sumB = (k) => projects.reduce((a, s) => a + s.total[k], 0);
  const tools = {}, blocked = {};
  let model = 0, wait = 0;
  for (const s of projects) {
    model += s.total.model; wait += s.total.wait;
    for (const [k, ms] of Object.entries(s.total.tools)) tools[k] = (tools[k] || 0) + ms;
    for (const [k, [n, ms]] of Object.entries(s.total.blocked)) { const x = (blocked[k] ||= [0, 0]); x[0] += n; x[1] += ms; }
  }
  const allTasks = projects.flatMap((s) => s.tasks);
  return {
    now,
    title: projects.length === 1 ? projects[0].name : 'All projects',
    tokenMode: projects[0]?.tokenMode || 'out',
    projects: projects.map((s) => ({ name: s.name, wall: s.total.wall, tokens: s.total.tokens, n: s.total.n, cost: s.total.cost })),
    totals: {
      wall: sumB('wall'), agentTime: sumB('agentTime'), tokens: sumB('tokens'), n: sumB('n'), cost: sumB('cost'),
      todayWall: projects.reduce((a, s) => a + s.today.wall, 0), wait,
    },
    breakdown: { model, wait, tools },
    blocked: blockedCauses(blocked).slice(0, 8),
    economics: economics(allTasks),
    calib: calib?.ok ? calib : null,
    tasks,
  };
}

export function writeDashboard(sums, { calib, file, now = Date.now() } = {}) {
  const data = payload(sums, calib, now);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const out = file || path.join(cacheRoot(), 'dashboard.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, HTML.replace('__DATA__', json).replace('__TITLE__', `TTT · ${data.title}`.replace(/</g, '&lt;')));
  return out;
}

export { DAY };

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --q1: #cde2fb; --q2: #9ec5f4; --q3: #6da7ec; --q4: #3987e5; --q5: #256abf; --q6: #184f95; --q7: #0d366b;
  --good: #0ca30c; --warn: #fab219; --crit: #d03b3b; --good-text: #006300;
  --rb: linear-gradient(90deg, #00e5ff, #7c5cff 33%, #ff4fa3 66%, #ffc84a);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
    --q1: #104281; --q2: #184f95; --q3: #1c5cab; --q4: #2a78d6; --q5: #5598e7; --q6: #86b6ef; --q7: #cde2fb;
    --good-text: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --q1: #104281; --q2: #184f95; --q3: #1c5cab; --q4: #2a78d6; --q5: #5598e7; --q6: #86b6ef; --q7: #cde2fb;
  --good-text: #0ca30c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 28px 16px 64px; }
header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
h1 small { color: var(--muted); font-weight: 500; font-size: 14px; margin-left: 8px; }
.rule { height: 3px; border-radius: 2px; background: var(--rb); margin: 14px 0 22px; }
button.theme { border: 1px solid var(--ring); background: var(--surface); color: var(--ink-2); border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
.grid { display: grid; gap: 14px; }
.tiles { grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); margin-bottom: 14px; }
.tile, .card { background: var(--surface); border: 1px solid var(--ring); border-radius: 12px; }
.tile { padding: 14px 16px; }
.tile .k { color: var(--ink-2); font-size: 12.5px; }
.tile .v { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; margin-top: 2px; }
.tile .s { color: var(--muted); font-size: 12px; margin-top: 2px; }
.card { padding: 16px 18px; min-width: 0; }
.card h2 { font-size: 14.5px; margin: 0 0 2px; }
.card p.sub { margin: 0 0 12px; color: var(--muted); font-size: 12.5px; }
.two { grid-template-columns: 1fr 1fr; }
@media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0 0 10px; font-size: 12.5px; color: var(--ink-2); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
td { padding: 7px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.prompt { color: var(--ink-2); }
.pill { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11.5px; border: 1px solid var(--ring); color: var(--ink-2); white-space: nowrap; }
.tip { position: fixed; pointer-events: none; z-index: 10; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: 0 6px 24px rgba(0,0,0,.18); max-width: 340px; opacity: 0; transition: opacity .08s; }
.tip b { font-weight: 650; }
.tip .m { color: var(--ink-2); }
.bars .row { display: grid; grid-template-columns: 170px 1fr 64px 40px; gap: 10px; align-items: center; padding: 4px 0; font-size: 13px; }
.bars .track { height: 10px; background: var(--grid); border-radius: 5px; overflow: hidden; }
.bars .fill { height: 100%; border-radius: 5px; }
.bars .lab { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bars .val { text-align: right; font-variant-numeric: tabular-nums; }
.bars .pct { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 12px; margin-top: 10px; }
.status { display: inline-flex; align-items: center; gap: 5px; }
.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.status.done::before { background: var(--good); } .status.running::before { background: var(--warn); } .status.interrupted::before { background: var(--crit); }
details summary { cursor: pointer; color: var(--ink-2); font-size: 12.5px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <header>
    <div><h1>⏱ TTT <small>Token to Time · <span id="title"></span></small></h1></div>
    <button class="theme" id="theme" type="button">Theme</button>
  </header>
  <div class="rule"></div>
  <section class="grid tiles" id="tiles"></section>
  <section class="grid"><div class="card"><h2>Every task, last 7 days</h2><p class="sub">Each bar is a stretch of Claude working · hover for the prompt</p><div class="legend" id="tl-legend"></div><div id="timeline"></div></div></section>
  <section class="grid two" style="margin-top:14px">
    <div class="card"><h2>Real time per day</h2><p class="sub">Last 30 days · wall-clock with Claude working</p><div id="daily"></div></div>
    <div class="card"><h2>When you work with Claude</h2><p class="sub">Real time by weekday and hour</p><div id="heat"></div></div>
  </section>
  <section class="grid two" style="margin-top:14px">
    <div class="card"><h2>Exchange rate</h2><p class="sub">Tokens per minute of real time, by week</p><div id="rate"></div></div>
    <div class="card"><h2>Where the time goes</h2><p class="sub">Main thread · subagents run alongside</p><div class="bars" id="breakdown"></div></div>
  </section>
  <section class="grid two" style="margin-top:14px">
    <div class="card"><h2>Models on your work</h2><p class="sub">Median per task, by kind of task</p><div id="eco"></div></div>
    <div class="card"><h2>Waiting on you</h2><p class="sub">Time Claude sat waiting for an answer or an approval</p><div id="blocked"></div></div>
  </section>
  <section class="grid" style="margin-top:14px"><div class="card"><h2>Longest tasks</h2><p class="sub">Top 25 by active time</p><div id="tasks"></div></div></section>
  <p class="note">Generated locally by <code>ttt dashboard</code>. Nothing here leaves your machine. Costs are API-equivalent estimates.</p>
</main>
<div class="tip" id="tip"></div>
<script>
const D = __DATA__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (ms) => { if (!isFinite(ms) || ms < 0) return '–'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; const h = Math.floor(m / 60); if (h < 24) return h + 'h' + String(m % 60).padStart(2, '0') + 'm'; return Math.floor(h / 24) + 'd' + String(h % 24).padStart(2, '0') + 'h'; };
const tok = (n) => n < 1000 ? String(Math.round(n)) : n < 1e5 ? (n / 1e3).toFixed(1) + 'k' : n < 1e6 ? Math.round(n / 1e3) + 'k' : (n / 1e6).toFixed(2) + 'M';
const usd = (x) => x < 0.01 ? '<$0.01' : x < 10 ? '$' + x.toFixed(2) : x < 1000 ? '$' + x.toFixed(0) : '$' + (x / 1000).toFixed(1) + 'k';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const tipEl = $('tip');
function tip(target, html) {
  target.addEventListener('pointermove', (ev) => { tipEl.innerHTML = html; tipEl.style.opacity = 1; const x = Math.min(ev.clientX + 14, innerWidth - tipEl.offsetWidth - 8); tipEl.style.left = x + 'px'; tipEl.style.top = (ev.clientY + 14) + 'px'; });
  target.addEventListener('pointerleave', () => { tipEl.style.opacity = 0; });
}

// Theme toggle (remembered per browser).
try { const t = localStorage.getItem('ttt-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
$('theme').onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ttt-theme', document.documentElement.dataset.theme); } catch {}
};

$('title').textContent = D.title;

// Tiles.
const T = D.totals;
const rate = T.wall > 0 ? T.tokens / (T.wall / 60000) : 0;
const tiles = [
  ['Real time', dur(T.wall), 'wall-clock with Claude working'],
  ['Agent time', dur(T.agentTime), (T.wall ? (T.agentTime / T.wall).toFixed(1) : '–') + '× parallel'],
  ['Tasks', String(T.n), D.projects.length + ' project' + (D.projects.length === 1 ? '' : 's')],
  ['Tokens', tok(T.tokens), D.tokenMode + ' tokens'],
  ['Exchange rate', tok(rate) + '/min', '1M ≈ ' + dur(1e6 / rate * 60000)],
  ['API cost', usd(T.cost), 'API-equivalent'],
  ['Waited on you', dur(T.wait), 'answers & approvals'],
];
if (D.calib) tiles.push(['Forecasts', '×' + D.calib.offBy.toFixed(1), 'typical miss · ' + Math.round(D.calib.within2x * 100) + '% within 2×']);
$('tiles').innerHTML = tiles.map(([k, v, s]) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s) + '</div></div>').join('');

// Project colours: fixed order by real time. Timeline bars can neighbour any other project,
// so only the 3 slots that validate all-pairs get a colour; the rest fold into "Other".
const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'];
const projColor = new Map(D.projects.slice(0, 3).map((p, i) => [p.name, 'var(' + SLOTS[i] + ')']));
const colorOf = (p) => projColor.get(p) || 'var(--muted)';

// Timeline: one lane per day, x = hour of day.
(function timeline() {
  const W = 1100, laneH = 26, top = 18, left = 74, days = 7;
  const dayStart = new Date(D.now); dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime() - (days - 1) * 864e5;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + (top + days * laneH + 6), role: 'img', 'aria-label': 'Timeline of tasks over the last 7 days' });
  const x = (ms) => left + (ms / 864e5) * (W - left - 8);
  for (let h = 0; h <= 24; h += 3) { el('line', { x1: x(h * 36e5), x2: x(h * 36e5), y1: top - 4, y2: top + days * laneH, stroke: 'var(--grid)' }, svg); const t = el('text', { x: x(h * 36e5), y: 10, 'text-anchor': 'middle' }, svg); t.textContent = String(h).padStart(2, '0') + ':00'; }
  for (let d = 0; d < days; d++) {
    const day = new Date(t0 + d * 864e5);
    const y = top + d * laneH;
    const lab = el('text', { x: 0, y: y + laneH / 2 + 4 }, svg);
    lab.textContent = d === days - 1 ? 'Today' : day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    el('rect', { x: left, y: y + 3, width: W - left - 8, height: laneH - 6, rx: 4, fill: 'var(--grid)', opacity: 0.35 }, svg);
  }
  const shown = new Set();
  for (const t of D.tasks) {
    for (const [s, e] of t.segs) {
      if (e < t0) continue;
      const d = Math.floor((s - t0) / 864e5);
      if (d < 0 || d >= days) continue;
      const base = t0 + d * 864e5;
      const y = top + d * laneH;
      const x1 = x(s - base), x2 = Math.max(x1 + 2.5, x(Math.min(e, base + 864e5) - base));
      const r = el('rect', { x: x1, y: y + 5, width: x2 - x1, height: laneH - 10, rx: 3, fill: colorOf(t.p), stroke: 'var(--surface)', 'stroke-width': 1 }, svg);
      shown.add(t.p);
      tip(r, '<b>' + esc(t.p) + '</b> · ' + dur(t.active) + (t.agents ? ' · 🤖' + t.agents : '') + '<div class="m">' + esc(t.prompt) + '</div><div class="m">' + tok(t.tokens) + ' tok · ' + usd(t.cost) + ' · ' + new Date(t.start).toLocaleString() + '</div>');
    }
  }
  $('timeline').appendChild(svg);
  const names = D.projects.map((p) => p.name).filter((n) => shown.has(n));
  const legend = names.filter((n) => projColor.has(n));
  if (names.some((n) => !projColor.has(n))) legend.push('Other');
  $('tl-legend').innerHTML = legend.length > 1 ? legend.map((n) => '<span><i style="background:' + (n === 'Other' ? 'var(--muted)' : colorOf(n)) + '"></i>' + esc(n) + '</span>').join('') : '';
})();

// Bucket helpers.
function realBy(keyFn) {
  // Union of segments per bucket so parallel sessions don't double count.
  const by = new Map();
  for (const t of D.tasks) for (const sg of t.segs) { const k = keyFn(sg[0]); if (!by.has(k)) by.set(k, []); by.get(k).push(sg); }
  const out = new Map();
  for (const [k, segs] of by) {
    segs.sort((a, b) => a[0] - b[0]);
    let tot = 0, [cs, ce] = segs[0];
    for (const [s, e] of segs.slice(1)) { if (s <= ce) ce = Math.max(ce, e); else { tot += ce - cs; cs = s; ce = e; } }
    out.set(k, tot + (ce - cs));
  }
  return out;
}
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

// Daily bars (single series: no legend, title names it).
(function daily() {
  const W = 520, H = 170, left = 34, bottom = 20, n = 30;
  const by = realBy(dayKey);
  const start = new Date(D.now); start.setHours(0, 0, 0, 0);
  const vals = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(start.getTime() - i * 864e5); vals.push([d, by.get(dayKey(d.getTime())) || 0]); }
  const max = Math.max(36e5, ...vals.map((v) => v[1]));
  const niceH = Math.ceil(max / 36e5);
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Real time per day, last 30 days' });
  const y = (ms) => H - bottom - (ms / (niceH * 36e5)) * (H - bottom - 8);
  for (let h = 0; h <= niceH; h += Math.max(1, Math.ceil(niceH / 4))) { el('line', { x1: left, x2: W, y1: y(h * 36e5), y2: y(h * 36e5), stroke: h ? 'var(--grid)' : 'var(--axis)' }, svg); const t = el('text', { x: left - 6, y: y(h * 36e5) + 4, 'text-anchor': 'end' }, svg); t.textContent = h + 'h'; }
  const bw = (W - left) / n;
  vals.forEach(([d, ms], i) => {
    const bx = left + i * bw + 1, h = H - bottom - y(ms);
    if (ms > 0) el('path', { d: 'M' + bx + ',' + (H - bottom) + 'v' + -(Math.max(h, 2) - 4) + 'q0,-4 4,-4h' + (bw - 6) + 'q4,0 4,4v' + (Math.max(h, 2) - 4) + 'z', fill: 'var(--s1)' }, svg);
    const hit = el('rect', { x: left + i * bw, y: 0, width: bw, height: H - bottom, fill: 'transparent' }, svg);
    tip(hit, '<b>' + d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + '</b><div class="m">' + dur(ms) + ' real time</div>');
    if (i % 5 === 4 || i === n - 1) { const t = el('text', { x: left + i * bw + bw / 2, y: H - 5, 'text-anchor': 'middle' }, svg); t.textContent = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }); }
  });
  $('daily').appendChild(svg);
})();

// Heatmap weekday × hour (sequential, one hue).
(function heat() {
  const W = 520, cell = 19, left = 34, top = 4;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of D.tasks) for (const [s, e] of t.segs) {
    for (let a = s; a < e;) { const d = new Date(a); const next = Math.min(e, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()); grid[(d.getDay() + 6) % 7][d.getHours()] += next - a; a = next; }
  }
  const max = Math.max(1, ...grid.flat());
  const steps = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'];
  const cw = (W - left) / 24;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + (top + 7 * cell + 18), role: 'img', 'aria-label': 'Heatmap of real time by weekday and hour' });
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  grid.forEach((row, d) => {
    const lab = el('text', { x: 0, y: top + d * cell + 13 }, svg); lab.textContent = days[d];
    row.forEach((ms, h) => {
      const fill = ms <= 0 ? 'var(--grid)' : 'var(' + steps[Math.min(6, Math.floor((ms / max) * 6.999))] + ')';
      const r = el('rect', { x: left + h * cw + 1, y: top + d * cell + 1, width: cw - 2, height: cell - 2, rx: 3, fill, opacity: ms <= 0 ? 0.5 : 1 }, svg);
      tip(r, '<b>' + days[d] + ' ' + String(h).padStart(2, '0') + ':00</b><div class="m">' + dur(ms) + ' real time</div>');
    });
  });
  for (let h = 0; h < 24; h += 3) { const t = el('text', { x: left + h * cw + cw / 2, y: top + 7 * cell + 14, 'text-anchor': 'middle' }, svg); t.textContent = String(h).padStart(2, '0'); }
  $('heat').appendChild(svg);
})();

// Weekly exchange rate (line, single series).
(function rateChart() {
  const W = 520, H = 170, left = 44, bottom = 20;
  const wk = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const real = realBy(wk);
  const toks = new Map(); for (const t of D.tasks) toks.set(wk(t.start), (toks.get(wk(t.start)) || 0) + t.tokens);
  const pts = [...real.entries()].filter(([, ms]) => ms > 5 * 60000).sort((a, b) => a[0] - b[0]).slice(-12).map(([k, ms]) => [k, (toks.get(k) || 0) / (ms / 60000)]);
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Tokens per real minute by week' });
  if (pts.length < 2) { const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, svg); t.textContent = 'Needs two weeks of history'; $('rate').appendChild(svg); return; }
  const max = Math.max(...pts.map((p) => p[1])) * 1.15;
  const x = (i) => left + (i / (pts.length - 1)) * (W - left - 10);
  const y = (v) => H - bottom - (v / max) * (H - bottom - 10);
  for (let i = 0; i <= 3; i++) { const v = (max / 3) * i; el('line', { x1: left, x2: W - 10, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)' }, svg); const t = el('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg); t.textContent = tok(v); }
  el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + x(i) + ',' + y(p[1])).join(''), fill: 'none', stroke: 'var(--s7)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  pts.forEach((p, i) => {
    el('circle', { cx: x(i), cy: y(p[1]), r: 4, fill: 'var(--s7)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    const hit = el('rect', { x: x(i) - 16, y: 0, width: 32, height: H - bottom, fill: 'transparent' }, svg);
    tip(hit, '<b>Week of ' + new Date(p[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</b><div class="m">' + tok(p[1]) + ' tok per real minute</div>');
    if (i === 0 || i === pts.length - 1 || pts.length <= 6) { const t = el('text', { x: x(i), y: H - 5, 'text-anchor': 'middle' }, svg); t.textContent = new Date(p[0]).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }); }
  });
  $('rate').appendChild(svg);
})();

// Breakdown bars.
(function breakdown() {
  const b = D.breakdown;
  const tools = Object.entries(b.tools).sort((x, y) => y[1] - x[1]);
  const rows = [['Model thinking & writing', b.model, 'var(--s1)']].concat(tools.slice(0, 6).map(([k, v]) => [k, v, 'var(--s3)']));
  const rest = tools.slice(6).reduce((a, [, v]) => a + v, 0);
  if (rest) rows.push([(tools.length - 6) + ' other tools', rest, 'var(--muted)']);
  if (b.wait) rows.push(['Waiting on you', b.wait, 'var(--s4)']);
  const total = rows.reduce((a, r) => a + r[1], 0) || 1;
  const max = Math.max(...rows.map((r) => r[1]));
  $('breakdown').innerHTML = rows.map(([k, v, col]) => '<div class="row"><div class="lab" title="' + esc(k) + '">' + esc(k) + '</div><div class="track"><div class="fill" style="width:' + (v / max * 100).toFixed(1) + '%;background:' + col + '"></div></div><div class="val">' + dur(v) + '</div><div class="pct">' + Math.round(v / total * 100) + '%</div></div>').join('');
})();

// Economics table.
(function eco() {
  const rows = D.economics.rows.filter((r) => r.n >= 2).slice(0, 12);
  if (!rows.length) { $('eco').innerHTML = '<p class="note">Needs at least two finished tasks per model and kind.</p>'; return; }
  $('eco').innerHTML = '<table><thead><tr><th>Kind</th><th>Model</th><th class="n">Tasks</th><th class="n">Time</th><th class="n">Tokens</th><th class="n">Cost</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td><span class="pill">' + esc(r.kind) + '</span></td><td>' + esc(r.model) + '</td><td class="n">' + r.n + '</td><td class="n">' + dur(r.time) + '</td><td class="n">' + tok(r.tokens) + '</td><td class="n">' + usd(r.cost) + '</td></tr>').join('') + '</tbody></table>' +
    D.economics.tips.slice(0, 3).map((t) => '<p class="note">↳ ' + esc(t) + '</p>').join('');
})();

// Blocked.
(function blocked() {
  const rows = D.blocked;
  if (!rows.length) { $('blocked').innerHTML = '<p class="note">Claude never had to wait for you.</p>'; return; }
  $('blocked').innerHTML = '<table><thead><tr><th>Cause</th><th class="n">Times</th><th class="n">Waited</th><th>Fix</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td class="n">' + r.count + '</td><td class="n">' + dur(r.ms) + '</td><td>' + (r.rule ? '<code>' + esc(r.rule) + '</code>' : '<span class="note">a question for you</span>') + '</td></tr>').join('') + '</tbody></table>';
})();

// Longest tasks.
(function tasks() {
  const rows = [...D.tasks].sort((a, b) => b.active - a.active).slice(0, 25);
  $('tasks').innerHTML = '<table><thead><tr><th>When</th>' + (D.projects.length > 1 ? '<th>Project</th>' : '') + '<th>Prompt</th><th class="n">Active</th><th class="n">Tokens</th><th class="n">Cost</th><th class="n">Agents</th><th>Status</th></tr></thead><tbody>' +
    rows.map((t) => '<tr><td class="n" style="text-align:left">' + new Date(t.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</td>' + (D.projects.length > 1 ? '<td>' + esc(t.p) + '</td>' : '') + '<td class="prompt">' + esc(t.prompt) + '</td><td class="n">' + dur(t.active) + '</td><td class="n">' + tok(t.tokens) + '</td><td class="n">' + usd(t.cost) + '</td><td class="n">' + (t.agents || '') + '</td><td><span class="status ' + t.status + '">' + t.status + '</span></td></tr>').join('') + '</tbody></table>';
})();
</script>
</body>
</html>`;
