#!/usr/bin/env node
// Regenerate docs/ visuals from synthetic demo projects (never your real transcripts).
//   node scripts/visuals.mjs   ->  docs/*.svg, docs/hero.gif, docs/dashboard-*.png
// Needs Google Chrome (headless screenshots) and ffmpeg for the GIF; SVGs need nothing.
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

// Prompt families with characteristic lengths, so similar prompts really do take similar time.
const FAMILIES = [
  { m: 3, prompts: ['Update the README install section', 'Write docs for the webhooks module', 'Fix typos in the changelog', 'Document the env variables'] },
  { m: 9, prompts: ['Fix the flaky checkout e2e test', 'Fix the crash when the cart is empty', 'Debug why login fails on Safari', 'Fix the broken CSV export'] },
  { m: 16, prompts: ['Write integration tests for the orders API', 'Add test coverage for the payments service', 'Add e2e tests for onboarding'] },
  { m: 28, prompts: ['Add OAuth login with Google and GitHub', 'Build the admin audit log page', 'Add rate limiting to the public API', 'Implement CSV export for reports', 'Add dark mode across the app'] },
  { m: 45, prompts: ['Refactor the cart store to Zustand', 'Migrate the users table to Postgres 17', 'Upgrade to React 19 and fix the breakages'] },
  { m: 20, prompts: ['/code-review high', 'Review the payments PR for security issues'] },
];
const COMMANDS = ['npm test', 'npm run build', 'git status', 'git diff', 'pnpm lint', 'rg -n TODO src', 'node scripts/check.mjs', 'npx playwright test', 'ls -la'];

class Writer {
  constructor(slug, cwd) {
    this.dir = path.join(PROJECTS, slug);
    this.cwd = cwd;
    this.n = 0;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(rel) { const f = path.join(this.dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; }
  append(rel, entries) { if (entries.length) fs.appendFileSync(this.file(rel), entries.map((e) => `${JSON.stringify(e)}\n`).join('')); }
  write(byFile) { for (const [rel, entries] of Object.entries(byFile)) this.append(rel, entries); }
  id() { return `m${++this.n}`; }
  usage(out) {
    const cw = Math.round(between(500, 4000));
    return { input_tokens: 4, output_tokens: out, cache_creation_input_tokens: cw, cache_read_input_tokens: Math.round(between(30_000, 120_000)), cache_creation: { ephemeral_1h_input_tokens: cw } };
  }

  /** Entries for one task, split by file, so callers can stream them frame by frame. */
  task({ sid, start, minutes, prompt, agents = 0, model = 'claude-opus-5-5', live = false, waitP = 0.06, errorLoop = false }) {
    const pid = `P${++this.n}`;
    const main = [];
    const byFile = { [`${sid}.jsonl`]: main };
    main.push({ type: 'user', timestamp: iso(start), promptId: pid, uuid: `u${this.n}`, origin: { kind: 'human' }, cwd: this.cwd, message: { role: 'user', content: prompt } });
    const end = start + minutes * MIN;
    let t = start + between(3, 8) * 1000;
    while (t < end) {
      const tid = `tu${++this.n}`;
      const edit = !errorLoop && rnd() < 0.3;
      const cmd = errorLoop ? 'npm test' : pick(COMMANDS);
      const input = edit ? { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' } : { command: cmd };
      main.push({ type: 'assistant', timestamp: iso(t), effort: 'high', message: { id: this.id(), model, stop_reason: 'tool_use', usage: this.usage(Math.round(between(120, 1100))), content: [{ type: 'tool_use', id: tid, name: edit ? 'Edit' : 'Bash', input }] } });
      const human = !edit && rnd() < waitP;
      t += (human ? between(30, 150) : between(2, 25)) * 1000;
      main.push({
        type: 'user', timestamp: iso(t), promptId: pid, permissionDecision: { decision: 'accept', source: human ? 'user_temporary' : 'config' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: errorLoop, content: errorLoop ? 'FAIL src/cart.test.ts: expected 3 received 2' : 'ok' }] },
      });
      t += between(4, 30) * 1000;
    }
    if (!live) main.push({ type: 'assistant', timestamp: iso(end), effort: 'high', message: { id: this.id(), model, stop_reason: 'end_turn', usage: this.usage(600) } });
    for (let a = 0; a < agents; a++) {
      const aid = `a${this.n}x${a}`;
      const list = (byFile[`${sid}/subagents/agent-${aid}.jsonl`] = []);
      const s0 = start + between(0.3, 1) * MIN;
      const e0 = start + minutes * MIN * (0.35 + (0.5 * (a + 1)) / agents);
      list.push({ type: 'user', isSidechain: true, promptId: pid, agentId: aid, timestamp: iso(s0), message: { role: 'user', content: 'subtask' } });
      for (let ta = s0 + 4000; ta < e0; ta += between(8, 30) * 1000) {
        list.push({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ta), message: { id: this.id(), model: a % 2 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: this.usage(Math.round(between(200, 1200))) } });
      }
      list.push({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(e0), message: { id: this.id(), model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: this.usage(400) } });
    }
    return byFile;
  }
}

const NOW = Date.now();
const DAY = 24 * 60 * MIN;
const dayStart = (() => { const d = new Date(NOW); d.setHours(9, 0, 0, 0); return d.getTime(); })();

function history(w, days, perDay, { agentsP = 0.35, scale = 1, model } = {}) {
  for (let d = days; d >= 0; d--) {
    if (rnd() < 0.15 && d > 0) continue; // a day off
    const sid = `s-${w.n}-${d}`;
    let t = dayStart - d * DAY + between(0, 2) * 60 * MIN;
    const n = Math.max(1, Math.round(perDay * between(0.5, 1.5)));
    for (let i = 0; i < n; i++) {
      if (d === 0 && t > NOW - 60 * MIN) break;
      const fam = pick(FAMILIES);
      const minutes = fam.m * scale * Math.exp(between(-0.45, 0.45));
      const agents = minutes > 12 && rnd() < agentsP ? Math.ceil(between(1, 4)) : 0;
      const m = model || (fam.m <= 9 && rnd() < 0.4 ? 'claude-sonnet-5-5' : 'claude-opus-5-5');
      w.write(w.task({ sid, start: t, minutes, prompt: pick(fam.prompts), agents, model: m }));
      t += (minutes + between(3, 40)) * MIN;
    }
  }
}

const acme = new Writer('-Users-you-code-acme-web', `${HOME}/code/acme-web`);
history(acme, 20, 4);
const others = [
  ['api-gateway', 13, 3, {}], ['mobile-app', 10, 2, { agentsP: 0.6 }], ['infra', 7, 1, { scale: 0.6 }],
  ['docs-site', 5, 2, { scale: 0.4, agentsP: 0 }], ['ml-pipeline', 12, 1, { scale: 1.6, agentsP: 0.8 }],
];
for (const [name, days, per, o] of others) history(new Writer(`-Users-you-code-${name}`, `${HOME}/code/${name}`), days, per, o);

const ROADMAP = path.join(WORK, 'ROADMAP.md');
fs.writeFileSync(ROADMAP, `# v2.0
- [x] Add OAuth login with Google and GitHub
- [x] Fix the flaky checkout e2e test
- [ ] Add Stripe checkout with webhooks and tests
- [ ] Write integration tests for the orders API
- [ ] Fix the crash when the cart is empty
## Polish
- [ ] Add dark mode across the app
- [ ] Update the README install section
- [ ] Migrate the users table to Postgres 17
`);

// ------------------------------------------------------------------ helpers
const env = { ...process.env, TTT_PROJECTS_DIR: PROJECTS, TTT_CACHE_DIR: CACHE, COLUMNS: '170', CCSTATUSLINE_WIDTH: '170', TTT_WIDTH: '128', TTT_NOTIFY: '0', TTT_PLAN_FILE: ROADMAP, FORCE_COLOR: '1' };
delete env.NO_COLOR;
const run = (args, extra = {}, input) => execFileSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
const svg = (name, text, title, opts) => { fs.writeFileSync(path.join(DOCS, name), ansiToSvg(text, { title, ...opts })); console.log(`  docs/${name}`); };
const prompt = (s) => `\x1b[38;5;245m$\x1b[0m ${s}`;

run(['index', '--all', '--quiet']);

// ------------------------------------------------------------------ CLI shots
svg('report.svg', run(['report', '--dir', acme.dir, '--tasks', '6']), 'ttt report');
svg('all.svg', run(['all']), 'ttt all');
svg('convert.svg', [prompt('ttt convert 250k'), run(['convert', '250k', '--dir', acme.dir]).trimEnd(), prompt('ttt convert 1h30m'), run(['convert', '1h30m', '--dir', acme.dir]).trimEnd()].join('\n'), 'ttt convert');
svg('eta.svg', `${prompt('ttt eta "Add Apple Pay to the checkout flow"')}\n${run(['eta', 'Add Apple Pay to the checkout flow', '--dir', acme.dir])}`, 'ttt eta');
svg('plan.svg', `${prompt('ttt plan')}\n${run(['plan', ROADMAP, '--dir', acme.dir])}`, 'ttt plan');
svg('blocked.svg', `${prompt('ttt blocked')}\n${run(['blocked', '--dir', acme.dir])}`, 'ttt blocked');

// ------------------------------------------------------------------ the live task, frame by frame
const LIVE_START = NOW - 22 * MIN;
const RESET = Math.round((NOW + 70 * MIN) / 1000);
const liveSid = 'live-session';
const live = acme.task({ sid: liveSid, start: LIVE_START, minutes: 21, prompt: 'Add Stripe checkout with webhooks and tests', agents: 3, live: true, waitP: 0 });
const allLive = Object.entries(live).flatMap(([rel, es]) => es.map((e) => [rel, e])).sort((a, b) => Date.parse(a[1].timestamp) - Date.parse(b[1].timestamp));
const statusJson = (t, { sid = liveSid, pct } = {}) => JSON.stringify({
  session_id: sid, transcript_path: path.join(acme.dir, `${sid}.jsonl`), cwd: acme.cwd,
  workspace: { current_dir: acme.cwd, project_dir: acme.cwd },
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' },
  context_window: { used_percentage: 22 + Math.round((t - LIVE_START) / MIN), context_window_size: 1_000_000 },
  cost: { total_cost_usd: 1.2 + ((t - LIVE_START) / MIN) * 0.21 },
  rate_limits: {
    five_hour: { used_percentage: pct ?? Math.min(99, 18 + Math.round(((t - LIVE_START) / MIN) * 1.2)), resets_at: RESET },
    seven_day: { used_percentage: 46, resets_at: Math.round(NOW / 1000) + 260_000 },
  },
});

const hasCcstatusline = (process.env.PATH || '').split(':').some((d) => fs.existsSync(path.join(d, 'ccstatusline')));
const ccConfig = path.join(WORK, 'ccstatusline.json');
const tcc = path.join(os.homedir(), 'Documents', 'Projects', 'tonys-tcc', '.config', 'ccstatusline', 'settings.json');
if (hasCcstatusline && fs.existsSync(tcc)) {
  const cfg = JSON.parse(fs.readFileSync(tcc, 'utf8'));
  cfg.lines = cfg.lines.map((l) => l.map((w) => (w.commandPath ? { ...w, commandPath: w.commandPath.replace('$HOME/.claude/bin/ttt', `${process.execPath} ${CLI}`) } : w)));
  fs.writeFileSync(ccConfig, JSON.stringify(cfg));
}
// Running ccstatusline with --help/--version opens its TUI; only ever pipe JSON into it.
const frame = (t, extra = {}, json = statusJson(t)) => (fs.existsSync(ccConfig)
  ? execFileSync('ccstatusline', ['--config', ccConfig], { env: { ...env, TTT_NOW: String(t), ...extra }, input: json, encoding: 'utf8', timeout: 20_000 })
    .split('\n').filter((l) => !/📁|🌿/.test(l) || l.includes('🤖')).join('\n')
  : run(['bar'], { TTT_NOW: String(t), ...extra }, json));

const frames = [];
let cursor = 0;
const feedUntil = (t) => {
  const chunk = {};
  while (cursor < allLive.length && Date.parse(allLive[cursor][1].timestamp) <= t) {
    const [rel, e] = allLive[cursor++];
    (chunk[rel] ||= []).push(e);
  }
  acme.write(chunk); // appended live, exercising the incremental indexer
};
const shots = [0.05, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((m) => LIVE_START + m * MIN);
for (const [i, t] of shots.entries()) {
  feedUntil(t);
  frames.push(frame(t, { RB_OFF: String((i * 23) % 360) }));
}
acme.write({ [`${liveSid}.jsonl`]: [{ type: 'assistant', timestamp: iso(LIVE_START + 21 * MIN), message: { id: acme.id(), model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: acme.usage(900) } }] });
const doneAt = LIVE_START + 21.3 * MIN;
const doneFrame = frame(doneAt, { RB_OFF: '200' });
for (let k = 0; k < 4; k++) frames.push(doneFrame);

const cols = Math.max(...frames.flatMap((f) => f.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length))) + 2;
svg('bar.svg', frames[10], 'Claude Code status bar · with TTT', { cols });

// ------------------------------------------------------------------ every state of the TTT line
const ttt = (t, mode, json) => run(['bar', mode], { TTT_NOW: String(t) }, json);
const session = (sid, opts) => { acme.write(acme.task({ sid, live: true, waitP: 0, ...opts })); return sid; };
const T = NOW;
const sPre = session('st-pre', { start: T - 4000, minutes: 0.01, prompt: 'Add Apple Pay to the checkout flow' });
const sSim = session('st-sim', { start: T - 5 * MIN, minutes: 5, prompt: 'Write integration tests for the payouts API' });
const sLoop = session('st-loop', { start: T - 7 * MIN, minutes: 7, prompt: 'Fix the failing cart test', errorLoop: true });
const sCap = session('st-cap', { start: T - 2 * MIN, minutes: 2, prompt: 'Refactor the checkout store to Zustand' });
const sWait = 'st-wait';
acme.write(acme.task({ sid: sWait, start: T - 30 * MIN, minutes: 14, prompt: 'Fix the crash when the cart is empty', waitP: 0.5 }));
run(['index', '--dir', acme.dir, '--quiet']);
const at = (sid, t, pct) => statusJson(t, { sid, pct });
const label = (s) => `\x1b[38;5;245m${s.padEnd(24)}\x1b[0m`;
const states = [
  `${label('just sent')}${ttt(T, 'task', at(sPre, T))}`,
  `${label('running, similar tasks')}${ttt(T, 'task', at(sSim, T))}`,
  `${label('running, agents report')}${frames[15].split('\n').find((l) => l.includes('⏳')).split('🏗')[0].trimEnd()}`,
  `${label('stuck in a loop')}${ttt(T, 'task', at(sLoop, T))}`,
  `${label('will hit the 5h cap')}${ttt(T, 'task', at(sCap, T, 93))}`,
  `${label('finished, waited on you')}${ttt(T, 'task', at(sWait, T))}`,
  `${label('project')}${ttt(T, 'project', at(sWait, T))}`,
];
svg('states.svg', states.join('\n'), 'every state of the TTT line');
svg('why.svg', `${prompt('ttt why')}\n${run(['why', '--dir', acme.dir])}`, 'ttt why');

// ------------------------------------------------------------------ dashboard + GIF (Chrome)
function shoot(html, png, w, h) {
  const argv = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(WORK, 'chrome')}`,
    '--force-device-scale-factor=2', `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html}`];
  for (let attempt = 0; attempt < 3 && !fs.existsSync(png); attempt++) {
    try { execFileSync(CHROME, argv, { stdio: 'ignore', timeout: 30_000 }); } catch { /* retry */ }
  }
  if (!fs.existsSync(png)) throw new Error(`chrome could not render ${png}`);
}

if (fs.existsSync(CHROME)) {
  const dash = path.join(WORK, 'dash.html');
  run(['dashboard', '--all', '--no-open', '--out', dash]);
  for (const theme of ['dark', 'light']) {
    const themed = path.join(WORK, `dash-${theme}.html`);
    fs.writeFileSync(themed, fs.readFileSync(dash, 'utf8').replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`));
    const png = path.join(DOCS, `dashboard-${theme}.png`);
    fs.rmSync(png, { force: true });
    shoot(themed, png, 1240, 1480);
    console.log(`  docs/dashboard-${theme}.png`);
  }

  const fdir = path.join(WORK, 'frames');
  fs.mkdirSync(fdir);
  frames.forEach((f, i) => {
    const s = ansiToSvg(f, { title: 'Claude Code · TTT', cols });
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(s);
    const html = path.join(fdir, `f${i}.html`);
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#0d1117">${s}</body></html>`);
    shoot(html, path.join(fdir, `f${String(i).padStart(3, '0')}.png`), w, h);
  });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1.6', '-i', path.join(fdir, 'f%03d.png'),
    '-vf', 'scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=none', path.join(DOCS, 'hero.gif')]);
  console.log(`  docs/hero.gif (${frames.length} frames)`);
} else {
  console.log('  (no Chrome: skipped dashboard screenshots and docs/hero.gif)');
}
fs.rmSync(WORK, { recursive: true, force: true });
