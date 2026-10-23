// Incremental transcript indexer.
//
// Claude Code appends every turn to JSONL transcripts under ~/.claude/projects/<slug>/:
//   <session>.jsonl                          main thread
//   <session>/subagents/agent-<id>.jsonl     every subagent that session spawned
//
// We read each file from the byte offset where we stopped last time, so a refresh only
// costs the bytes written since. Entries are folded into *tasks*: one task per human
// prompt, owning every assistant message (main thread and subagents) that prompt caused.
// Subagent entries carry the `promptId` of the prompt that spawned them, which makes the
// attribution exact rather than a timestamp guess.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './paths.mjs';
import { IDLE_MS } from './model.mjs';

export const CACHE_VERSION = 4;
const CHUNK = 8 * 1024 * 1024;

// ---------------------------------------------------------------- file discovery

/** All transcript files of a project, main threads first (subagents need their prompt map). */
export function listTranscripts(projectDir) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (e.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const rel = path.relative(projectDir, p);
        const parts = rel.split(path.sep);
        const agent = parts.length > 1;
        out.push({ rel, abs: p, size: st.size, mtimeMs: st.mtimeMs, agent, sid: agent ? parts[0] : e.name.slice(0, -6) });
      }
    }
  };
  walk(projectDir, 0);
  out.sort((a, b) => (a.agent - b.agent) || (a.mtimeMs - b.mtimeMs));
  return out;
}

// ---------------------------------------------------------------- state & cache

export function emptyState(slug) {
  return { v: CACHE_VERSION, slug, idleMs: IDLE_MS, cwd: null, updatedAt: 0, files: {}, sessions: {}, tasks: {} };
}

export function cachePath(slug) {
  return path.join(cacheRoot(), 'projects', `${slug}.json`);
}

export function loadState(slug) {
  try {
    const s = JSON.parse(fs.readFileSync(cachePath(slug), 'utf8'));
    // The idle threshold is baked into agent-time, so changing it means re-indexing.
    if (s && s.v === CACHE_VERSION && s.idleMs === IDLE_MS) return s;
  } catch { /* missing or corrupt: rebuild */ }
  return emptyState(slug);
}

export function saveState(state) {
  const file = cachePath(state.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/** Non-blocking exclusive lock; returns a release fn or null if someone else holds it. */
export function tryLock(slug, staleMs = 120_000) {
  const file = `${cachePath(slug)}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
      } catch { continue; }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- entry classification

const NOT_PROMPT_PREFIXES = [
  '<local-command', '<bash-', '[Request interrupted', '<system-reminder>', 'Caveat:',
  '<task-notification', '<user-memory-input', '<command-name>/clear', '<command-name>/exit',
];

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const part of content) {
    if (part?.type === 'tool_result') return null; // a tool result, not a prompt
    if (part?.type === 'text') s += `${part.text} `;
    else if (part?.type === 'image') s += '[image] ';
  }
  return s;
}

/** A prompt the human typed (or a slash command they ran) in the main thread. */
export function promptText(d) {
  if (d.type !== 'user' || d.isSidechain || d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return null;
  if (d.origin?.kind && d.origin.kind !== 'human') return null;
  const text = contentText(d.message?.content);
  if (text == null) return null;
  const t = text.trim();
  if (!t || NOT_PROMPT_PREFIXES.some((p) => t.startsWith(p))) return null;
  return t;
}

/** Display form of a prompt: "/code-review high" for commands, tag-free text otherwise. */
export function promptLabel(text) {
  const cmd = /<command-name>\s*([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
    const name = cmd[1].trim();
    return `${name.startsWith('/') ? name : `/${name}`}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`;
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isInterrupt(d) {
  const c = d.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join('') : '';
  return t.startsWith('[Request interrupted');
}

// ---------------------------------------------------------------- folding entries into tasks

function newTask(key, sid, ts, label) {
  return {
    key, sid, start: ts, end: ts, prompt: label.slice(0, 240),
    in: 0, out: 0, cw: 0, cr: 0, msgs: 0, agentMsgs: 0, agents: [], models: {},
    stop: null, interrupted: false, ts: [Math.floor(ts / 1000)],
    // Per stream (main thread or one subagent): [lastSeenSec, activeMs]. Summed across
    // streams this is agent-time, which exceeds wall time when agents run in parallel.
    work: { main: [Math.floor(ts / 1000), 0] },
  };
}

function touch(task, ts, stream, idleMs) {
  if (!Number.isFinite(ts)) return;
  if (ts > task.end) task.end = ts;
  if (ts < task.start) task.start = ts;
  const s = Math.floor(ts / 1000);
  if (task.ts[task.ts.length - 1] !== s) task.ts.push(s);
  const w = task.work[stream];
  if (!w) task.work[stream] = [s, 0];
  else if (s > w[0]) { w[1] += Math.min((s - w[0]) * 1000, idleMs); w[0] = s; }
}

function usageOf(u) {
  return {
    in: u?.input_tokens || 0,
    out: u?.output_tokens || 0,
    cw: u?.cache_creation_input_tokens || 0,
    cr: u?.cache_read_input_tokens || 0,
  };
}

function applyEntry(state, f, d) {
  const ts = Date.parse(d.timestamp);
  const stream = f.agent ? (d.agentId || path.basename(f.rel, '.jsonl')) : 'main';
  if (!state.cwd && d.cwd && !f.agent) state.cwd = d.cwd;
  const sess = (state.sessions[f.sid] ||= { prompts: {}, last: null });

  const taskFor = () => {
    let key = f.curTask;
    if (!key && f.agent) key = (d.promptId && sess.prompts[d.promptId]) || sess.last;
    if (!key && !f.agent) {
      // A resumed/continued session whose first entries precede any prompt.
      key = `${f.sid}:${d.uuid || ts}`;
      state.tasks[key] = newTask(key, f.sid, ts, '(continued session)');
      sess.last = key;
    }
    if (key) f.curTask = key;
    return key ? state.tasks[key] : null;
  };

  if (d.type === 'user') {
    const text = f.agent ? null : promptText(d);
    if (text != null) {
      const key = d.promptId || d.uuid || `${f.sid}:${ts}`;
      if (!state.tasks[key]) state.tasks[key] = newTask(key, f.sid, ts, promptLabel(text));
      sess.prompts[key] = key;
      sess.last = key;
      f.curTask = key;
      return;
    }
    if (f.agent && d.promptId && sess.prompts[d.promptId]) f.curTask = sess.prompts[d.promptId];
    const task = taskFor();
    if (!task) return;
    if (!f.agent && d.promptId && !sess.prompts[d.promptId]) sess.prompts[d.promptId] = task.key;
    if (!f.agent && isInterrupt(d)) task.interrupted = true;
    touch(task, ts, stream, state.idleMs);
    return;
  }

  if (d.type !== 'assistant') return;
  const m = d.message || {};
  const task = taskFor();
  if (!task) return;
  touch(task, ts, stream, state.idleMs);
  if (!f.agent) task.stop = m.stop_reason || task.stop;
  if (!m.usage || m.model === '<synthetic>') return;

  // One API message is written as several entries (thinking / text / tool_use), each
  // repeating the usage block. Count it once, adding only what grew since last time.
  const u = usageOf(m.usage);
  const prev = f.lastMsgId === m.id ? f.lastUsage : { in: 0, out: 0, cw: 0, cr: 0 };
  const delta = { in: u.in - prev.in, out: u.out - prev.out, cw: u.cw - prev.cw, cr: u.cr - prev.cr };
  if (f.lastMsgId !== m.id) {
    task.msgs++;
    if (f.agent) {
      task.agentMsgs++;
      if (!task.agents.includes(stream)) task.agents.push(stream);
    }
  }
  f.lastMsgId = m.id;
  f.lastUsage = u;
  task.in += Math.max(0, delta.in);
  task.out += Math.max(0, delta.out);
  task.cw += Math.max(0, delta.cw);
  task.cr += Math.max(0, delta.cr);
  const model = shortModel(m.model);
  if (model) task.models[model] = (task.models[model] || 0) + Math.max(0, delta.out);
}

/** "claude-opus-5-5-20261001" -> "opus-5.5"; unknown names pass through. */
export function shortModel(id) {
  if (!id) return null;
  const m = /claude-(?:3-[57]-)?([a-z]+)-?(\d+)?(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const fam = m[1];
  if (!m[2]) return fam;
  return m[3] && m[3].length <= 2 ? `${fam}-${m[2]}.${m[3]}` : `${fam}-${m[2]}`;
}

// ---------------------------------------------------------------- reading

function readNewLines(abs, from, to, onLine) {
  const fd = fs.openSync(abs, 'r');
  let pos = from;
  let carry = Buffer.alloc(0);
  try {
    while (pos < to) {
      const len = Math.min(CHUNK, to - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let i = data.indexOf(10, start); i !== -1; i = data.indexOf(10, start)) {
        if (i > start) onLine(data.toString('utf8', start, i));
        start = i + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }
  // An unterminated last line may still be mid-write: leave it for the next pass.
  return pos - carry.length;
}

function processFile(state, file) {
  const f = (state.files[file.rel] ||= {
    sid: file.sid, agent: file.agent, size: 0, mtimeMs: 0, offset: 0,
    curTask: null, lastMsgId: null, lastUsage: null,
  });
  f.rel = file.rel;
  f.offset = readNewLines(file.abs, f.offset, file.size, (line) => {
    // Cheap prefilter: only user/assistant entries matter.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    applyEntry(state, f, d);
  });
  f.size = file.size;
  f.mtimeMs = file.mtimeMs;
  delete f.rel;
}

/** Bytes not yet indexed, and whether a file shrank (forcing a rebuild). */
export function pendingWork(state, files) {
  let bytes = 0, rebuild = false;
  for (const file of files) {
    const f = state.files[file.rel];
    if (!f) bytes += file.size;
    else if (file.size < f.offset) rebuild = true;
    else bytes += file.size - f.offset;
  }
  return { bytes: rebuild ? files.reduce((a, b) => a + b.size, 0) : bytes, rebuild };
}

/**
 * Bring a project's index up to date.
 * @returns {{state, deferred:boolean, pendingBytes:number, changed:boolean}}
 *   deferred=true when the work exceeds `maxBytes` (caller should index in background).
 */
export function indexProject(projectDir, { maxBytes = Infinity, save = true, state } = {}) {
  const slug = path.basename(projectDir);
  state ||= loadState(slug);
  const files = listTranscripts(projectDir);
  const { bytes, rebuild } = pendingWork(state, files);
  if (bytes > maxBytes) return { state, deferred: true, pendingBytes: bytes, changed: false };
  if (rebuild) state = emptyState(slug);
  let changed = rebuild;
  for (const file of files) {
    const f = state.files[file.rel];
    if (f && f.offset === file.size) continue;
    processFile(state, file);
    changed = true;
  }
  if (changed) {
    state.updatedAt = Date.now();
    if (save) saveState(state);
  }
  return { state, deferred: false, pendingBytes: 0, changed };
}
