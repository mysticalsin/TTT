#!/usr/bin/env node
// Regenerate docs/ visuals from synthetic demo projects (never your real transcripts).
//   node scripts/visuals.mjs          -> docs/*.svg, docs/hero.gif
// Needs: Google Chrome (headless screenshots) and ffmpeg for the GIF; SVGs need nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ansiToSvg } from './ansi2svg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-visuals-'));
const PROJECTS = path.join(WORK, 'projects');
const CACHE = path.join(WORK, 'cache');
const HOME = '/Users/you';
const CLI = path.join(ROOT, 'bin', 'ttt.mjs');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(DOCS, { recursive: true });

// ------------------------------------------------------------------ deterministic fixtures
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (a, b) => a + rnd() * (b - a);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

const PROMPTS = [
  'Add OAuth login with Google and GitHub', 'Fix the flaky checkout e2e test', 'Refactor the cart store to Zustand',
  'Write integration tests for the orders API', 'Make the dashboard load under 1s', 'Add dark mode across the app',
  'Migrate the users table to Postgres 17', 'Explain why the build is slow and fix it', 'Add rate limiting to the public API',
  '/code-review high', 'Build the admin audit log page', 'Upgrade to React 19 and fix the breakages',
  'Set up CI with preview deploys', 'Add i18n for French and Spanish', 'Profile memory use in the worker',
  'Implement CSV export for reports', 'Add Sentry and clean up error handling', 'Design the onboarding flow',
];

class Writer {
  constructor(slug, cwd) {
    this.dir = path.join(PROJECTS, slug);
    this.cwd = cwd;
    this.n = 0;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(rel) { const f = path.join(this.dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; }
  append(rel, entries) { fs.appendFileSync(this.file(rel), entries.map((e) => `${JSON.stringify(e)}\n`).join('')); }
  id() { return `m${++this.n}`; }

  /** Entries for one task; returns them split by file so callers can stream them. */
  task({ sid, start, minutes, prompt, agents = 0, model = 'claude-opus-5-5', live = false }) {
    const pid = `P${++this.n}`;
    const byFile = { [`${sid}.jsonl`]: [] };
    const main = byFile[`${sid}.jsonl`];
    main.push({ type: 'user', timestamp: iso(start), promptId: pid, uuid: `u${this.n}`, origin: { kind: 'human' }, cwd: this.cwd, message: { role: 'user', content: prompt } });
    const end = start + minutes * MIN;
    let t = start + between(3, 8) * 1000;
    while (t < end) {
      const out = Math.round(between(120, 1100));
      main.push({ type: 'assistant', timestamp: iso(t), message: { id: this.id(), model, stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: out, cache_creation_input_tokens: Math.round(between(500, 4000)), cache_read_input_tokens: Math.round(between(30_000, 120_000)) } } });
      t += between(2, 25) * 1000;
      main.push({ type: 'user', timestamp: iso(t), promptId: pid, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
      t += between(4, 30) * 1000;
    }
    if (!live) main.push({ type: 'assistant', timestamp: iso(end), message: { id: this.id(), model, stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 600, cache_creation_input_tokens: 800, cache_read_input_tokens: 90_000 } } });
    for (let a = 0; a < agents; a++) {
      const aid = `a${this.n}x${a}`;
      const rel = `${sid}/subagents/agent-${aid}.jsonl`;
      const list = (byFile[rel] = []);
      const s0 = start + between(0.5, 2) * MIN;
      const e0 = Math.min(end, s0 + minutes * between(0.5, 0.85) * MIN);
      list.push({ type: 'user', isSidechain: true, promptId: pid, agentId: aid, timestamp: iso(s0), message: { role: 'user', content: 'subtask' } });
      for (let ta = s0 + 4000; ta < e0; ta += between(8, 30) * 1000) {
        list.push({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ta), message: { id: this.id(), model: a % 2 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: Math.round(between(200, 1200)), cache_creation_input_tokens: 900, cache_read_input_tokens: 40_000 } } });
      }
    }
    return byFile;
  }
  write(byFile) { for (const [rel, entries] of Object.entries(byFile)) this.append(rel, entries); }
}

const NOW = Date.now();
const DAY = 24 * 60 * MIN;
const dayStart = (() => { const d = new Date(NOW); d.setHours(9, 0, 0, 0); return d.getTime(); })();

function history(w, days, perDay, { agentsP = 0.35, scale = 1 } = {}) {
  for (let d = days; d >= 0; d--) {
    if (rnd() < 0.15 && d > 0) continue; // a day off
    const sid = `s-${w.n}-${d}`;
    let t = dayStart - d * DAY + between(0, 2) * 60 * MIN;
    const n = Math.max(1, Math.round(perDay * between(0.5, 1.5)));
    for (let i = 0; i < n; i++) {
      if (d === 0 && t > NOW - 40 * MIN) break;
      const minutes = Math.min(75, Math.exp(between(0.3, 3.4))) * scale;
      const agents = rnd() < agentsP ? Math.ceil(between(1, 5)) : 0;
      w.write(w.task({ sid, start: t, minutes, prompt: pick(PROMPTS), agents }));
      t += (minutes + between(3, 40)) * MIN;
    }
  }
}

const acme = new Writer('-Users-you-code-acme-web', `${HOME}/code/acme-web`);
history(acme, 13, 4);
const others = [
  ['api-gateway', 13, 3, {}], ['mobile-app', 10, 2, { agentsP: 0.6 }], ['infra', 7, 1, { scale: 0.6 }],
  ['docs-site', 5, 2, { scale: 0.4, agentsP: 0 }], ['ml-pipeline', 12, 1, { scale: 1.6, agentsP: 0.8 }],
];
for (const [name, days, per, o] of others) history(new Writer(`-Users-you-code-${name}`, `${HOME}/code/${name}`), days, per, o);

// ------------------------------------------------------------------ helpers
const env = { ...process.env, TTT_PROJECTS_DIR: PROJECTS, TTT_CACHE_DIR: CACHE, COLUMNS: '170', CCSTATUSLINE_WIDTH: '170', TTT_WIDTH: '124', FORCE_COLOR: '1' };
delete env.NO_COLOR;
const run = (args, extra = {}, input) => execFileSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
const svg = (name, text, title, opts) => { fs.writeFileSync(path.join(DOCS, name), ansiToSvg(text, { title, ...opts })); console.log(`  docs/${name}`); };

run(['index', '--all', '--quiet']);

// ------------------------------------------------------------------ static shots
svg('report.svg', run(['report', '--dir', acme.dir, '--tasks', '8']), 'ttt report');
svg('all.svg', run(['all']), 'ttt all');
svg('convert.svg', [
  `\x1b[38;5;245m$\x1b[0m ttt convert 250k`, run(['convert', '250k', '--dir', `${HOME}/code/acme-web`], { PWD: acme.cwd }).trimEnd(),
  `\x1b[38;5;245m$\x1b[0m ttt convert 1h30m`, run(['convert', '1h30m', '--dir', `${HOME}/code/acme-web`]).trimEnd(),
].join('\n'), 'ttt convert');

// ------------------------------------------------------------------ the live task, frame by frame
const LIVE_START = NOW - 12 * MIN;
const liveSid = 'live-session';
const live = acme.task({ sid: liveSid, start: LIVE_START, minutes: 12, prompt: 'Add Stripe checkout with webhooks and tests', agents: 3, live: true });
const allLive = Object.entries(live).flatMap(([rel, es]) => es.map((e) => [rel, e])).sort((a, b) => Date.parse(a[1].timestamp) - Date.parse(b[1].timestamp));
const statusJson = (t) => JSON.stringify({
  session_id: liveSid, transcript_path: path.join(acme.dir, `${liveSid}.jsonl`), cwd: acme.cwd,
  workspace: { current_dir: acme.cwd, project_dir: acme.cwd },
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' },
  context_window: { used_percentage: 34 + Math.round((t - LIVE_START) / MIN), context_window_size: 1_000_000 },
  cost: { total_cost_usd: 1.2 + (t - LIVE_START) / MIN * 0.21 },
  rate_limits: { five_hour: { used_percentage: 31 + Math.round((t - LIVE_START) / MIN), resets_at: Math.round(NOW / 1000) + 7200 }, seven_day: { used_percentage: 46, resets_at: Math.round(NOW / 1000) + 260_000 } },
});

// Look it up on PATH: running `ccstatusline --version` opens its interactive TUI.
const hasCcstatusline = (process.env.PATH || '').split(':').some((d) => fs.existsSync(path.join(d, 'ccstatusline')));
const ccConfig = path.join(WORK, 'ccstatusline.json');
const tcc = path.join(os.homedir(), 'Documents', 'Projects', 'tonys-tcc', '.config', 'ccstatusline', 'settings.json');
if (hasCcstatusline && fs.existsSync(tcc)) {
  // tonys-tcc's layout, with git + dir widgets dropped (the demo cwd is fictional).
  const cfg = JSON.parse(fs.readFileSync(tcc, 'utf8'));
  cfg.lines = cfg.lines.map((l) => l.map((w) => (w.commandPath ? { ...w, commandPath: w.commandPath.replace('$HOME/.claude/bin/ttt', `${process.execPath} ${CLI}`) } : w)));
  fs.writeFileSync(ccConfig, JSON.stringify(cfg));
}

const frames = [];
let cursor = 0;
const shots = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => LIVE_START + m * MIN);
for (const [i, t] of shots.entries()) {
  const chunk = {};
  while (cursor < allLive.length && Date.parse(allLive[cursor][1].timestamp) <= t) {
    const [rel, e] = allLive[cursor++];
    (chunk[rel] ||= []).push(e);
  }
  acme.write(chunk); // appended live, exercising the incremental indexer
  let text;
  if (fs.existsSync(ccConfig)) {
    text = execFileSync('ccstatusline', ['--config', ccConfig], { env: { ...env, TTT_NOW: String(t), RB_OFF: String((i * 23) % 360) }, input: statusJson(t), encoding: 'utf8', timeout: 20_000 });
    text = text.split('\n').filter((l) => !/📁|🌿/.test(l) || l.includes('🤖')).join('\n');
  } else {
    text = run(['bar'], { TTT_NOW: String(t) }, statusJson(t));
  }
  frames.push(text);
}
// Finished: Claude wraps up.
acme.write({ [`${liveSid}.jsonl`]: [{ type: 'assistant', timestamp: iso(LIVE_START + 12.2 * MIN), message: { id: acme.id(), model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 900, cache_creation_input_tokens: 800, cache_read_input_tokens: 90_000 } } }] });
const doneAt = LIVE_START + 12.5 * MIN;
const doneFrame = fs.existsSync(ccConfig)
  ? execFileSync('ccstatusline', ['--config', ccConfig], { env: { ...env, TTT_NOW: String(doneAt), RB_OFF: '200' }, input: statusJson(doneAt), encoding: 'utf8', timeout: 20_000 })
  : run(['bar'], { TTT_NOW: String(doneAt) }, statusJson(doneAt));
for (let k = 0; k < 4; k++) frames.push(doneFrame);

const cols = Math.max(...frames.flatMap((f) => f.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length))) + 2;
svg('bar.svg', frames[8], 'Claude Code status bar · with TTT', { cols });

// The bar's states, one per line.
const ttt = (t, mode = 'task') => run(['bar', mode], { TTT_NOW: String(t) }, statusJson(t));
fs.writeFileSync(path.join(WORK, 'noop'), '');
const states = [
  `\x1b[38;5;245mrunning, on pace       \x1b[0m${frames[3].split('\n').find((l) => l.includes('⏳')) || ''}`,
  `\x1b[38;5;245mrunning, past median   \x1b[0m${frames[12].split('\n').find((l) => l.includes('⏳')) || ''}`,
  `\x1b[38;5;245mfinished               \x1b[0m${ttt(doneAt)}`,
  `\x1b[38;5;245mproject segment        \x1b[0m${ttt(doneAt, 'project')}`,
];
svg('states.svg', states.join('\n'), 'what the TTT line can say');

// ------------------------------------------------------------------ GIF (Chrome + ffmpeg)
if (fs.existsSync(CHROME)) {
  const fdir = path.join(WORK, 'frames');
  fs.mkdirSync(fdir);
  frames.forEach((f, i) => {
    const s = ansiToSvg(f, { title: 'Claude Code · TTT', cols });
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(s);
    const html = path.join(fdir, `f${i}.html`);
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#0d1117">${s}</body></html>`);
    const png = path.join(fdir, `f${String(i).padStart(3, '0')}.png`);
    // Own throwaway profile, so it never collides with the Chrome you have open.
    const argv = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(WORK, 'chrome')}`,
      '--force-device-scale-factor=2', `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html}`];
    for (let attempt = 0; attempt < 3 && !fs.existsSync(png); attempt++) {
      try { execFileSync(CHROME, argv, { stdio: 'ignore', timeout: 30_000 }); } catch { /* retry */ }
    }
    if (!fs.existsSync(png)) throw new Error(`chrome could not render frame ${i}`);
  });
  const gif = path.join(DOCS, 'hero.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1.6', '-i', path.join(fdir, 'f%03d.png'),
    '-vf', 'scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=none', gif]);
  console.log(`  docs/hero.gif (${frames.length} frames)`);
} else {
  console.log('  (no Chrome: skipped docs/hero.gif)');
}
fs.rmSync(WORK, { recursive: true, force: true });
