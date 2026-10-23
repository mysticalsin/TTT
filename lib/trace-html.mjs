// The browser view of `ttt trace`: one self-contained HTML file, no network.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './paths.mjs';

export function writeTraceHtml(trace, { file } = {}) {
  const out = file || path.join(cacheRoot(), 'trace.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const json = JSON.stringify(trace).replace(/</g, '\\u003c');
  const title = `Trace · ${trace.task.prompt.slice(0, 60)}`.replace(/</g, '&lt;');
  fs.writeFileSync(out, HTML.replace('__DATA__', () => json).replace('__TITLE__', () => title));
  return out;
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --raise: #ffffff; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10); --hover: rgba(11,11,11,0.04); --sel: rgba(42,120,214,0.10);
  --model: #2a78d6; --tool: #1baf7a; --wait: #eda100; --handoff: #6250d6; --fail: #d03b3b; --orch: #52514e;
  --rb: linear-gradient(90deg, #00e5ff, #7c5cff 33%, #ff4fa3 66%, #ffc84a);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --raise: #222220; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.04); --sel: rgba(57,135,229,0.16);
    --model: #3987e5; --tool: #199e70; --wait: #c98500; --handoff: #9085e9; --fail: #e66767; --orch: #c3c2b7;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --raise: #222220; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.04); --sel: rgba(57,135,229,0.16);
  --model: #3987e5; --tool: #199e70; --wait: #c98500; --handoff: #9085e9; --fail: #e66767; --orch: #c3c2b7;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
header { padding: 18px 20px 0; }
.top { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 15px; white-space: nowrap; }
.prompt { flex: 1 1 320px; min-width: 0; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; border: 1px solid var(--ring); color: var(--ink-2); white-space: nowrap; }
.controls { display: flex; gap: 8px; align-items: center; }
.search { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 4px 8px; }
.search input { border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; width: 180px; }
.search kbd { font: 11px ui-monospace, Menlo, monospace; color: var(--muted); border: 1px solid var(--ring); border-radius: 4px; padding: 0 4px; }
.seg { display: inline-flex; border: 1px solid var(--ring); border-radius: 8px; overflow: hidden; background: var(--surface); }
.seg button { border: 0; background: transparent; color: var(--ink-2); font: inherit; font-size: 12px; padding: 5px 9px; cursor: pointer; font-variant-numeric: tabular-nums; }
.seg button[aria-pressed="true"] { background: var(--sel); color: var(--ink); font-weight: 600; }
button.icon { border: 1px solid var(--ring); background: var(--surface); color: var(--ink-2); border-radius: 8px; padding: 5px 9px; cursor: pointer; font: inherit; font-size: 12px; }
.rule { height: 3px; border-radius: 2px; background: var(--rb); margin: 14px 0 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 7px 12px; min-width: 96px; }
.chip .k { color: var(--muted); font-size: 11.5px; }
.chip .v { font-size: 18px; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.row2 { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin: 12px 0 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--ink-2); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.slowest { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12.5px; }
.slowest b { color: var(--muted); font-weight: 500; margin-right: 2px; }
.slowest button { border: 1px solid var(--ring); background: var(--surface); color: var(--ink-2); border-radius: 99px; padding: 2px 9px; cursor: pointer; font: inherit; font-size: 12px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slowest button i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
main { flex: 1; min-height: 0; display: flex; margin: 0 20px 20px; background: var(--surface); border: 1px solid var(--ring); border-radius: 12px; overflow: hidden; }
#scroll { flex: 1; overflow: auto; position: relative; }
.grid { position: relative; }
.axis, .row { display: flex; }
.axis { position: sticky; top: 0; z-index: 3; background: var(--surface); border-bottom: 1px solid var(--grid); height: 30px; }
.name { position: sticky; left: 0; z-index: 2; flex: 0 0 var(--nameW); width: var(--nameW); background: var(--surface); border-right: 1px solid var(--grid); display: flex; align-items: center; gap: 6px; padding: 0 10px 0 0; overflow: hidden; }
.axis .name { z-index: 4; color: var(--muted); font-size: 12px; padding-left: 12px; }
.lane { position: relative; flex: 0 0 auto; }
.tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--grid); }
.axis .tick span { position: absolute; top: 8px; left: 4px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.row { height: 28px; cursor: pointer; }
.row:hover, .row:hover .name { background: var(--hover); }
.row.sel, .row.sel .name { background: var(--sel); }
.row .name { font-size: 13px; }
.caret { width: 16px; flex: 0 0 16px; text-align: center; color: var(--muted); font-size: 10px; user-select: none; }
.kind { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 8px; }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model { margin-left: auto; color: var(--muted); font-size: 11px; border: 1px solid var(--ring); border-radius: 6px; padding: 0 5px; white-space: nowrap; }
.bar { position: absolute; top: 7px; height: 14px; border-radius: 4px; min-width: 2px; }
.bar.k-orchestrator { background: transparent; border: 1.5px solid var(--orch); top: 6px; height: 16px; }
.bar.k-agent { background: color-mix(in srgb, var(--handoff) 22%, transparent); border: 1.5px solid var(--handoff); top: 6px; height: 16px; }
.bar.k-model { background: var(--model); }
.bar.k-tool { background: var(--tool); }
.bar.k-waiting { background: repeating-linear-gradient(135deg, var(--wait) 0 4px, color-mix(in srgb, var(--wait) 55%, transparent) 4px 8px); }
.bar.k-handoff { background: var(--handoff); }
.bar.k-failed { background: var(--fail); }
.bar.k-open { border-top-right-radius: 0; border-bottom-right-radius: 0; mask-image: linear-gradient(90deg, #000 85%, transparent); }
.dur { position: absolute; top: 6px; font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: none; }
.x { color: var(--fail); font-weight: 700; margin-left: 2px; }
#panel { flex: 0 0 340px; border-left: 1px solid var(--grid); padding: 16px; overflow: auto; display: none; }
#panel.on { display: block; }
#panel h3 { margin: 0 0 4px; font-size: 14px; }
#panel dl { display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; margin: 12px 0 0; font-size: 12.5px; }
#panel dt { color: var(--muted); }
#panel dd { margin: 0; word-break: break-word; }
#panel pre { white-space: pre-wrap; word-break: break-word; background: var(--page); border: 1px solid var(--ring); border-radius: 8px; padding: 8px; font: 12px/1.4 ui-monospace, Menlo, monospace; margin: 0; }
.empty { padding: 48px 20px; text-align: center; color: var(--muted); }
.empty b { display: block; color: var(--ink); font-size: 14px; margin-bottom: 4px; }
.tip { position: fixed; pointer-events: none; z-index: 10; background: var(--raise); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; box-shadow: 0 6px 24px rgba(0,0,0,.18); max-width: 360px; opacity: 0; }
.tip .m { color: var(--ink-2); }
@media (max-width: 760px) { #panel { position: fixed; inset: auto 0 0 0; height: 45vh; flex: none; background: var(--surface); border-top: 1px solid var(--grid); border-left: 0; z-index: 6; } .search input { width: 110px; } }
</style>
</head>
<body>
<header>
  <div class="top">
    <span class="brand">⏱ Trace</span>
    <span class="prompt" id="prompt"></span>
    <span class="pill" id="status"></span>
    <div class="controls">
      <label class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" placeholder="Search steps" aria-label="Search steps"><kbd>⌘F</kbd></label>
      <div class="seg" id="zoom" role="group" aria-label="Zoom"></div>
      <button class="icon" id="theme" type="button">Theme</button>
    </div>
  </div>
  <div class="rule"></div>
  <div class="chips" id="chips"></div>
  <div class="row2">
    <div class="legend" id="legend"></div>
    <div class="slowest" id="slowest"></div>
  </div>
</header>
<main>
  <div id="scroll"><div class="grid" id="grid"></div></div>
  <aside id="panel" aria-live="polite"></aside>
</main>
<div class="tip" id="tip"></div>
<script>
const T = __DATA__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (ms) => { if (!isFinite(ms) || ms < 0) return '–'; if (ms < 1000) return (ms / 1000).toFixed(1) + 's'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; const h = Math.floor(m / 60); return h + 'h' + String(m % 60).padStart(2, '0') + 'm'; };
const tok = (n) => !n ? '0' : n < 1000 ? String(Math.round(n)) : n < 1e5 ? (n / 1e3).toFixed(1) + 'k' : n < 1e6 ? Math.round(n / 1e3) + 'k' : (n / 1e6).toFixed(2) + 'M';
const usd = (x) => !x ? '$0' : x < 0.01 ? '<$0.01' : x < 10 ? '$' + x.toFixed(2) : '$' + x.toFixed(0);
const KIND = { orchestrator: ['Orchestrator', 'var(--orch)'], model: ['Model call', 'var(--model)'], tool: ['Tool call', 'var(--tool)'], waiting: ['Waiting on you', 'var(--wait)'], handoff: ['Handoff', 'var(--handoff)'], agent: ['Subagent', 'var(--handoff)'], failed: ['Failed', 'var(--fail)'] };
const S = T.summary, spans = T.spans, byId = new Map(spans.map((s) => [s.id, s]));
const kids = new Map(); for (const s of spans) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) || []), s.id]);
const total = Math.max(S.duration, 1);
const label = (s) => s.kind === 'model' ? (s.calls && s.calls.length ? '→ ' + [...new Set(s.calls)].join(', ') : (s.thought ? 'thinking & writing' : 'writing')) : s.name;

// Theme.
try { const t = localStorage.getItem('ttt-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
$('theme').onclick = () => { const dark = getComputedStyle(document.documentElement).colorScheme === 'dark'; document.documentElement.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('ttt-theme', document.documentElement.dataset.theme); } catch {} };

// Header.
$('prompt').textContent = T.task.prompt;
$('prompt').title = T.task.prompt;
$('status').textContent = [T.task.status, T.task.model, T.task.effort && T.task.effort + ' effort'].filter(Boolean).join(' · ');
const chips = [['Duration', dur(S.duration)], ['Cost', usd(S.cost)], ['Tokens', tok(S.tokens)], ['LLM calls', S.llm], ['Tool calls', S.tools], ['Errors', S.errors], ['Waited on you', dur(S.waiting)], ['Subagents', S.agents]];
$('chips').innerHTML = chips.map(([k, v]) => '<div class="chip"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>').join('');
$('legend').innerHTML = ['model', 'tool', 'waiting', 'handoff', 'failed'].map((k) => '<span><i style="background:' + KIND[k][1] + '"></i>' + KIND[k][0] + '</span>').join('');
const slow = spans.filter((s) => s.kind !== 'orchestrator' && s.kind !== 'agent').sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5);
$('slowest').innerHTML = '<b>Slowest</b>' + slow.map((s) => '<button type="button" data-id="' + s.id + '"><i style="background:' + KIND[s.kind][1] + '"></i>' + esc(dur(s.end - s.start) + ' · ' + label(s)) + '</button>').join('');
$('slowest').onclick = (e) => { const b = e.target.closest('button'); if (b) reveal(b.dataset.id); };

// State.
let zoom = 1;
const collapsed = new Set();
if (spans.length > 400) for (const s of spans) if (s.kind === 'agent') collapsed.add(s.id);
let query = '';
let selected = null;
const ZOOMS = [0.5, 1, 1.5, 2, 4];
$('zoom').innerHTML = ZOOMS.map((z) => '<button type="button" data-z="' + z + '" aria-pressed="' + (z === 1) + '">' + z + 'x</button>').join('');
$('zoom').onclick = (e) => { const b = e.target.closest('button'); if (b) setZoom(Number(b.dataset.z)); };
function setZoom(z) { zoom = z; for (const b of $('zoom').children) b.setAttribute('aria-pressed', String(Number(b.dataset.z) === z)); render(); }

function visibleRows() {
  const q = query.trim().toLowerCase();
  if (q) {
    const hit = new Set();
    for (const s of spans) {
      if ([s.name, s.detail, s.model, s.tool, s.error, label(s)].some((x) => x && String(x).toLowerCase().includes(q))) {
        for (let p = s; p; p = byId.get(p.parent)) hit.add(p.id);
      }
    }
    return spans.filter((s) => hit.has(s.id));
  }
  const out = [];
  const walk = (id) => { const s = byId.get(id); out.push(s); if (!collapsed.has(id)) for (const k of kids.get(id) || []) walk(k); };
  walk(spans[0].id);
  return out;
}

function niceStep(ms, px) {
  const steps = [100, 250, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5];
  return steps.find((s) => (s / ms) * px >= 90) || steps.at(-1);
}

function render() {
  const nameW = Math.min(380, Math.max(240, innerWidth * 0.26));
  const avail = $('scroll').clientWidth - nameW - 70;
  const W = Math.max(320, avail) * zoom;
  const x = (ms) => (ms / total) * W;
  const rows = visibleRows();
  const step = niceStep(total, W);
  let ticks = '';
  for (let t = 0; t <= total; t += step) ticks += '<div class="tick" style="left:' + x(t).toFixed(1) + 'px"><span>' + dur(t) + '</span></div>';
  let html = '<div class="axis" style="--nameW:' + nameW + 'px"><div class="name">Step</div><div class="lane" style="width:' + (W + 70) + 'px">' + ticks + '</div></div>';
  if (!rows.length) {
    html += '<div class="empty"><b>No matching steps</b>Nothing in this trace matches “' + esc(query) + '”.</div>';
  }
  for (const s of rows) {
    const has = (kids.get(s.id) || []).length;
    const caret = has ? (collapsed.has(s.id) && !query ? '▸' : '▾') : '';
    const l = x(s.start), w = Math.max(2, x(s.end) - x(s.start));
    const d = s.end - s.start;
    html += '<div class="row' + (selected === s.id ? ' sel' : '') + '" data-id="' + s.id + '" style="--nameW:' + nameW + 'px">' +
      '<div class="name" style="padding-left:' + (6 + s.depth * 14) + 'px"><span class="caret" data-caret="' + (has ? s.id : '') + '">' + caret + '</span><span class="kind" style="background:' + KIND[s.kind][1] + '"></span><span class="label">' + esc(label(s)) + (s.kind === 'failed' ? '<span class="x" aria-label="failed"> ✕</span>' : '') + '</span>' + (s.model && (s.kind === 'orchestrator' || s.kind === 'agent' || s.kind === 'model') ? '<span class="model">' + esc(s.model) + '</span>' : '') + '</div>' +
      '<div class="lane" style="width:' + (W + 70) + 'px"><div class="bar k-' + s.kind + (s.open ? ' k-open' : '') + '" style="left:' + l.toFixed(1) + 'px;width:' + w.toFixed(1) + 'px"></div><span class="dur" style="left:' + (l + w + 6).toFixed(1) + 'px">' + dur(d) + '</span></div></div>';
  }
  $('grid').innerHTML = html;
}

function detail(s) {
  const rows = [
    ['Kind', KIND[s.kind][0] + (s.open ? ' (still running)' : '')],
    ['Starts at', '+' + dur(s.start)], ['Duration', dur(s.end - s.start)],
    s.model && ['Model', s.model], s.tokens != null && s.kind !== 'tool' && ['Tokens out', tok(s.tokens)],
    s.usd && ['Cost', usd(s.usd)], s.tool && ['Tool', s.tool], s.approved && ['Approved', s.approved],
    s.async && ['Mode', 'background'], s.child && ['Subagent', byId.get(s.child)?.name],
  ].filter(Boolean);
  return '<h3>' + esc(label(s)) + '</h3><span class="pill">' + KIND[s.kind][0] + '</span><dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' +
    (s.detail ? '<p style="margin:14px 0 6px;color:var(--muted);font-size:12px">' + (s.kind === 'orchestrator' ? 'Prompt' : 'Input') + '</p><pre>' + esc(s.detail) + '</pre>' : '') +
    (s.text ? '<p style="margin:14px 0 6px;color:var(--muted);font-size:12px">Said</p><pre>' + esc(s.text) + '</pre>' : '') +
    (s.error ? '<p style="margin:14px 0 6px;color:var(--fail);font-size:12px">✕ Error</p><pre>' + esc(s.error) + '</pre>' : '');
}

function select(id) {
  selected = id;
  const s = byId.get(id);
  $('panel').innerHTML = s ? detail(s) : '';
  $('panel').classList.toggle('on', Boolean(s));
  render();
}

function reveal(id) {
  query = ''; $('q').value = '';
  for (let p = byId.get(byId.get(id)?.parent); p; p = byId.get(p.parent)) collapsed.delete(p.id);
  select(id);
  const row = document.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
  if (row) row.scrollIntoView({ block: 'center' });
}

$('grid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-caret]');
  if (c && c.dataset.caret) { const id = c.dataset.caret; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render(); return; }
  const r = e.target.closest('.row'); if (r) select(r.dataset.id);
});
const tip = $('tip');
$('grid').addEventListener('pointermove', (e) => {
  const r = e.target.closest('.row'); if (!r || !e.target.closest('.lane')) { tip.style.opacity = 0; return; }
  const s = byId.get(r.dataset.id);
  tip.innerHTML = '<b>' + esc(label(s)) + '</b><div class="m">' + KIND[s.kind][0] + ' · ' + dur(s.end - s.start) + ' · at +' + dur(s.start) + (s.tokens && s.kind === 'model' ? ' · ' + tok(s.tokens) + ' tok' : '') + '</div>' + (s.detail && s.kind !== 'orchestrator' ? '<div class="m">' + esc(String(s.detail).slice(0, 120)) + '</div>' : '') + (s.error ? '<div class="m" style="color:var(--fail)">✕ ' + esc(s.error.slice(0, 100)) + '</div>' : '');
  tip.style.opacity = 1;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
});
$('grid').addEventListener('pointerleave', () => { tip.style.opacity = 0; });
$('q').addEventListener('input', (e) => { query = e.target.value; render(); });
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); }
  else if (e.key === 'Escape') { if (document.activeElement === $('q') && query) { query = ''; $('q').value = ''; render(); } else select(null); }
  else if (document.activeElement !== $('q') && (e.key === '+' || e.key === '=')) setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]);
  else if (document.activeElement !== $('q') && e.key === '-') setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]);
});
addEventListener('resize', render);
render();
</script>
</body>
</html>`;
