// Walk-away mode: a macOS notification (and optionally Sam's voice) when a task you
// walked away from finishes, or when a running task looks stuck in a loop.
//   TTT_NOTIFY=0          off
//   TTT_NOTIFY_MIN=3      only for tasks that ran at least this many minutes
//   TTT_VOICE=1           also speak it (uses `sam` from .claude/bin, else macOS `say`)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cacheRoot } from './paths.mjs';
import { fmtDur, fmtTok, MIN } from './util.mjs';

const ON = process.env.TTT_NOTIFY !== '0' && process.platform === 'darwin';
const MIN_MS = Number(process.env.TTT_NOTIFY_MIN || 3) * MIN;
const file = () => path.join(cacheRoot(), 'notified.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}
function save(s) {
  try {
    const keys = Object.keys(s);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete s[k];
    fs.mkdirSync(cacheRoot(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s));
  } catch { /* best effort */ }
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function speak(text) {
  if (process.env.TTT_VOICE !== '1') return;
  let cmd = 'say';
  try { execFileSync('/bin/sh', ['-c', 'command -v sam'], { stdio: 'ignore' }); cmd = 'sam'; } catch { /* say */ }
  try { spawn(cmd, [text], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

function post(title, body, sayIt) {
  try {
    spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
  speak(sayIt || body);
}

/** Natural sentence for Sam. */
function spoken(v, typical) {
  const mins = Math.max(1, Math.round(v.active / MIN));
  const tok = v.tokens >= 1000 ? `${Math.round(v.tokens / 1000)} thousand tokens` : `${v.tokens} tokens`;
  let vs = '';
  if (typical > 0) {
    const d = Math.round((typical - v.active) / MIN);
    if (d >= 1) vs = `, ${d} minute${d > 1 ? 's' : ''} faster than usual`;
    else if (d <= -1) vs = `, ${-d} minute${d < -1 ? 's' : ''} longer than usual`;
  }
  return `Done. ${mins} minute${mins > 1 ? 's' : ''}, ${tok}${vs}.`;
}

/**
 * Call on every bar refresh with the session's current task view. Fires at most once per
 * task per event, and only after we've seen the task running (no spam on startup).
 */
export function maybeNotify(project, v, { typical, loop } = {}) {
  if (!ON || !v) return;
  const s = load();
  const rec = (s[v.key] ||= { seenRunning: false, done: false, loop: false });
  let changed = false;
  if (v.status === 'running' && !rec.seenRunning) { rec.seenRunning = true; changed = true; }
  if (v.status === 'running' && loop && !rec.loop) {
    rec.loop = true; changed = true;
    post(`🌀 ${project}: Claude may be looping`, `${loop.why} · ${fmtDur(v.active)} in · ${truncate(v.prompt)}`, `Heads up. Claude might be stuck: ${loop.why}.`);
  }
  if ((v.status === 'done' || v.status === 'interrupted') && rec.seenRunning && !rec.done) {
    rec.done = true; changed = true;
    if (v.status === 'done' && v.active >= MIN_MS) {
      post(`✅ ${project}: done in ${fmtDur(v.active)}`, `${fmtTok(v.tokens)} tok · ${truncate(v.prompt)}`, spoken(v, typical));
    }
  }
  if (changed) save(s);
}

function truncate(s, n = 70) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
