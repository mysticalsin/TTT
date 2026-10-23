// `ttt trace` / `/trace`: a waterfall of one task — every model call, tool call, wait on
// you, failure and handoff to a subagent, nested, on one time axis.
//
// The index keeps only aggregates, so a trace re-reads just that task's slice of its
// session transcript (plus the subagents it spawned) on demand.
import fs from 'node:fs';
import path from 'node:path';
import { promptText, promptLabel, commandLabel, shortModel } from './indexer.mjs';
import { costOf } from './pricing.mjs';
import { fmtDur, fmtTok, truncate, width } from './util.mjs';
import { fmtUsd } from './pricing.mjs';
import { c } from './style.mjs';

const HANDOFF_TOOLS = new Set(['Agent', 'Task']);

function readJsonl(file, onEntry) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (onEntry(d) === false) return;
  }
}

/** Bash minus its setup noise: "cd x && export PATH=… && npm test" -> "npm test". */
function cleanCommand(cmd) {
  return cmd.replace(/^\s*((cd|export|source|set)\s+[^;&|]*(&&|;)\s*)+/, '').trim() || cmd;
}

function snippet(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return truncate(cleanCommand(input.command), 160);
  const v = input.command || input.description || input.file_path || input.pattern || input.url || input.query || input.prompt || JSON.stringify(input);
  return truncate(String(v), 160);
}

function resultText(r) {
  const x = r?.content;
  const s = typeof x === 'string' ? x : Array.isArray(x) ? x.map((p) => p?.text || '').join(' ') : '';
  return truncate(s, 200);
}

/**
 * Turn one stream's entries (main thread or one subagent) into spans.
 * Model call: from the previous event to the last entry of that API message.
 * Tool call: from its tool_use to its tool_result.
 */
function streamSpans(entries, { parent, depth, now, idPrefix }) {
  const spans = [];
  const pending = new Map();
  let lastTs = null;
  let cur = null; // current model span (same message id)
  let k = 0;
  const id = () => `${idPrefix}${k++}`;
  for (const d of entries) {
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (d.type === 'assistant') {
      const m = d.message || {};
      if (m.model === '<synthetic>') { lastTs = ts; continue; }
      if (!cur || cur.msgId !== m.id) {
        cur = { id: id(), parent, depth, kind: 'model', name: 'Model call', model: shortModel(m.model), msgId: m.id, start: lastTs ?? ts, end: ts, tokens: 0, usd: 0, calls: [] };
        spans.push(cur);
      }
      cur.end = ts;
      const u = m.usage || {};
      const cw = u.cache_creation_input_tokens || 0, cw1 = Math.min(u.cache_creation?.ephemeral_1h_input_tokens || 0, cw);
      cur.tokens = u.output_tokens || 0;
      cur.in = (u.input_tokens || 0) + cw;
      cur.usd = costOf({ [cur.model || 'sonnet-5.5']: [u.input_tokens || 0, u.output_tokens || 0, cw - cw1, cw1, u.cache_read_input_tokens || 0] });
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type === 'tool_use') {
          cur.calls.push(p.name);
          pending.set(p.id, { ts, name: p.name, input: p.input });
        } else if (p?.type === 'thinking') cur.thought = true;
        else if (p?.type === 'text' && p.text) cur.text = truncate(p.text, 200);
      }
      lastTs = ts;
      continue;
    }
    // user entry: tool results end tool spans
    const results = Array.isArray(d.message?.content) ? d.message.content.filter((p) => p?.type === 'tool_result') : [];
    const human = /^user/.test(d.permissionDecision?.source || '');
    for (const r of results) {
      const p = pending.get(r.tool_use_id);
      if (!p) continue;
      pending.delete(r.tool_use_id);
      const asked = p.name === 'AskUserQuestion';
      const kind = r.is_error ? 'failed' : HANDOFF_TOOLS.has(p.name) ? 'handoff' : (human || asked) ? 'waiting' : 'tool';
      spans.push({
        id: id(), parent, depth, kind, name: HANDOFF_TOOLS.has(p.name) ? 'Spawn subagent' : commandLabel(p.name, p.input), tool: p.name,
        detail: snippet(p.input), start: p.ts, end: ts, error: r.is_error ? resultText(r) : undefined,
        approved: human ? 'by you' : undefined, toolUseId: r.tool_use_id,
        agentId: d.toolUseResult?.agentId, async: d.toolUseResult?.isAsync === true,
      });
    }
    lastTs = ts;
    cur = null;
  }
  // Calls still in flight (running task).
  for (const [tid, p] of pending) {
    spans.push({ id: id(), parent, depth, kind: HANDOFF_TOOLS.has(p.name) ? 'handoff' : 'tool', name: commandLabel(p.name, p.input), tool: p.name, detail: snippet(p.input), start: p.ts, end: now, open: true, toolUseId: tid });
  }
  for (const s of spans) delete s.msgId;
  return spans;
}

/** Find the task's slice of its session file: from its prompt to the next human prompt. */
function mainSlice(file, key) {
  const out = [];
  let on = false;
  let promptEntry = null;
  readJsonl(file, (d) => {
    if (d.isSidechain) return;
    const isPrompt = promptText(d) != null;
    if (isPrompt && on) return false; // next task begins
    if (isPrompt && (d.promptId === key || d.uuid === key)) { on = true; promptEntry = d; out.push(d); return; }
    if (on) out.push(d);
  });
  return { entries: out, promptEntry };
}

/**
 * @param projectDir  ~/.claude/projects/<slug>
 * @param task        a task view from summarize()
 */
export function buildTrace(projectDir, task, { now = Date.now() } = {}) {
  const sessionFile = path.join(projectDir, `${task.sid}.jsonl`);
  const { entries } = mainSlice(sessionFile, task.key);
  const t0 = task.start;
  const end = task.status === 'running' ? now : task.end;
  const root = {
    id: 'root', parent: null, depth: 0, kind: 'orchestrator', name: 'Orchestrator', model: task.model,
    detail: task.prompt, start: t0, end, tokens: task.tokens, usd: task.cost,
  };
  const spans = [root, ...streamSpans(entries, { parent: 'root', depth: 1, now, idPrefix: 'm' })];

  // Subagents spawned by this task: matched by the tool_use id in their meta.json, or by
  // the promptId on their first entry.
  const handoffs = new Map(spans.filter((s) => s.kind === 'handoff' || s.tool === 'Agent' || s.tool === 'Task').map((s) => [s.toolUseId, s]));
  const promptIds = new Set([task.key, ...entries.map((e) => e.promptId).filter(Boolean)]);
  const subDir = path.join(projectDir, task.sid, 'subagents');
  let files = [];
  try { files = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch { /* no subagents */ }
  let a = 0;
  for (const f of files) {
    const abs = path.join(subDir, f);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(abs.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* optional */ }
    const handoff = meta.toolUseId ? handoffs.get(meta.toolUseId) : null;
    // One agent file can serve several tasks (agents get continued with new prompts), so
    // take only the stretches whose promptId belongs to this task, like the indexer does.
    const agentEntries = [];
    let cur = null, firstPid = null;
    readJsonl(abs, (d) => {
      if (d.type === 'user' && d.promptId) { cur = d.promptId; firstPid ||= cur; }
      const mine = promptIds.has(cur) || (handoff && (cur === null || cur === firstPid));
      if (mine) agentEntries.push(d);
    });
    const belongs = agentEntries.length > 0;
    if (!belongs || !agentEntries.length) continue;
    const ts = agentEntries.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
    const last = agentEntries.filter((e) => e.type === 'assistant').at(-1);
    const done = last?.message?.stop_reason === 'end_turn';
    const gid = `a${a++}`;
    const parent = handoff ? handoff.id : 'root';
    const depth = handoff ? handoff.depth + 1 : 1;
    const first = agentEntries.find((e) => e.type === 'user');
    const label = meta.description || (typeof first?.message?.content === 'string' ? promptLabel(first.message.content) : 'Subagent');
    const model = shortModel(agentEntries.find((e) => e.type === 'assistant')?.message?.model) || meta.model;
    const children = streamSpans(agentEntries, { parent: gid, depth: depth + 1, now, idPrefix: `${gid}.` });
    const group = {
      id: gid, parent, depth, kind: 'agent', name: truncate(label, 80), model, detail: meta.agentType,
      start: Math.min(...ts), end: done || task.status !== 'running' ? Math.max(...ts) : now, open: !done && task.status === 'running',
      tokens: children.reduce((x, s) => x + (s.kind === 'model' ? s.tokens : 0), 0),
      usd: children.reduce((x, s) => x + (s.usd || 0), 0),
    };
    if (handoff) handoff.child = gid;
    spans.push(group, ...children);
  }

  // Order: depth-first by start time, children under their parent.
  const kids = new Map();
  for (const s of spans) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) || []), s]);
  const ordered = [];
  const walk = (s) => { ordered.push(s); for (const k of (kids.get(s.id) || []).sort((x, y) => x.start - y.start)) walk(k); };
  walk(root);

  const leaf = ordered.filter((s) => s.kind !== 'orchestrator' && s.kind !== 'agent');
  const summary = {
    duration: end - t0,
    active: task.active,
    cost: task.cost,
    tokens: task.tokens,
    llm: leaf.filter((s) => s.kind === 'model').length,
    tools: leaf.filter((s) => s.kind !== 'model').length,
    errors: leaf.filter((s) => s.kind === 'failed').length,
    waiting: leaf.filter((s) => s.kind === 'waiting').reduce((x, s) => x + (s.end - s.start), 0),
    agents: ordered.filter((s) => s.kind === 'agent').length,
  };
  return {
    task: { key: task.key, prompt: task.prompt, status: task.status, model: task.model, effort: task.effort, start: t0, end },
    summary,
    spans: ordered.map((s) => ({ ...s, start: s.start - t0, end: Math.max(s.end, s.start) - t0 })),
  };
}

// ---------------------------------------------------------------- terminal waterfall

const KIND = {
  orchestrator: { ch: '█', col: c.gold, label: 'orchestrator' },
  model: { ch: '█', col: c.sky, label: 'model call' },
  tool: { ch: '█', col: c.green, label: 'tool call' },
  waiting: { ch: '▒', col: c.amber, label: 'waiting on you' },
  handoff: { ch: '█', col: c.violet, label: 'handoff' },
  agent: { ch: '█', col: c.violet, label: 'subagent' },
  failed: { ch: '█', col: c.red, label: 'failed' },
};

/** Bar of `cols` cells; each cell shows the kind with the most time in it among `spans`. */
function laneBar(spans, total, cols, { from = 0, to = total } = {}) {
  const cells = [];
  for (let i = 0; i < cols; i++) {
    const a = (i / cols) * total, b = ((i + 1) / cols) * total;
    if (b < from || a > to) { cells.push(c.faint('·')); continue; }
    const share = {};
    for (const s of spans) {
      const ov = Math.min(b, s.end) - Math.max(a, s.start);
      if (ov > 0) share[s.kind] = (share[s.kind] || 0) + ov;
    }
    const top = Object.entries(share).sort((x, y) => y[1] - x[1])[0];
    if (!top) { cells.push(c.faint(a >= from && b <= to ? '─' : '·')); continue; }
    const k = KIND[top[0]] || KIND.tool;
    cells.push(k.col(k.ch));
  }
  return cells.join('');
}

function axis(total, cols) {
  let s = '';
  const marks = 4;
  for (let i = 0; i <= marks; i++) {
    const label = fmtDur((total * i) / marks);
    const pos = Math.round((cols * i) / marks);
    if (s.length < pos) s += ' '.repeat(pos - s.length);
    s += label;
  }
  return c.faint(s);
}

/** Compact waterfall for a terminal (and for /trace inside Claude Code). */
export function renderTraceTty(trace, { cols = 46, maxRows = 14 } = {}) {
  const { summary: S, task, spans } = trace;
  const total = Math.max(S.duration, 1);
  const L = [];
  const chip = (k, v) => `${c.dim(k)} ${v}`;
  L.push('');
  L.push(`  ${c.bold(c.gold('⏱ Trace'))}  ${c.bold(truncate(task.prompt, 70))}`);
  L.push(`  ${[
    chip('duration', c.white(fmtDur(S.duration))), chip('cost', c.gold(fmtUsd(S.cost))), chip('tokens', c.cyan(fmtTok(S.tokens))),
    chip('LLM', c.white(S.llm)), chip('tools', c.white(S.tools)), chip('errors', S.errors ? c.red(S.errors) : c.white(0)),
    S.waiting ? chip('waited', c.amber(fmtDur(S.waiting))) : null, S.agents ? chip('agents', c.violet(S.agents)) : null,
  ].filter(Boolean).join(c.faint('  ·  '))}`);
  L.push('');
  const nameW = 30;
  L.push(`  ${' '.repeat(nameW + 11)} ${axis(total, cols)}`);
  const row = (name, model, bar, dur) => `  ${name}${' '.repeat(Math.max(1, nameW - width(name)))}${c.dim((model || '').padEnd(11).slice(0, 11))} ${bar} ${c.white(dur)}`;

  const root = spans[0];
  const mainLeaves = spans.filter((s) => s.parent === 'root' && s.kind !== 'agent');
  L.push(row(c.gold('Orchestrator'), root.model, laneBar(mainLeaves, total, cols), fmtDur(root.end - root.start)));
  const agents = spans.filter((s) => s.kind === 'agent');
  const shown = agents.slice(0, maxRows);
  shown.forEach((g, i) => {
    const kids = spans.filter((s) => s.parent === g.id);
    const branch = i === shown.length - 1 && agents.length <= maxRows ? '└' : '├';
    L.push(row(`${c.faint(` ${branch} `)}${c.violet(truncate(g.name, nameW - 4))}`, g.model, laneBar(kids.length ? kids : [{ ...g, kind: 'agent' }], total, cols, { from: g.start, to: g.end }), fmtDur(g.end - g.start)));
  });
  if (agents.length > maxRows) L.push(`  ${c.faint(`   … ${agents.length - maxRows} more subagents (see the browser view)`)}`);

  const slow = spans.filter((s) => !['orchestrator', 'agent'].includes(s.kind)).sort((x, y) => (y.end - y.start) - (x.end - x.start)).slice(0, 5);
  if (slow.length) {
    L.push('');
    L.push(`  ${c.bold('Slowest')}`);
    for (const s of slow) {
      const k = KIND[s.kind] || KIND.tool;
      L.push(`  ${k.col('■')} ${c.white(fmtDur(s.end - s.start).padStart(7))}  ${truncate(s.kind === 'model' ? `${s.model || 'model'} · ${s.calls?.length ? `→ ${[...new Set(s.calls)].join(', ')}` : 'thinking & writing'}` : `${s.name}${s.detail && s.detail !== s.name ? c.faint(`  ${s.detail}`) : ''}`, 90)}${s.error ? c.red(`  ✕ ${truncate(s.error, 40)}`) : ''}`);
    }
  }
  L.push('');
  L.push(`  ${['model', 'tool', 'waiting', 'handoff', 'failed'].map((k) => `${KIND[k].col('■')} ${c.dim(KIND[k].label)}`).join('   ')}`);
  return L.join('\n');
}
