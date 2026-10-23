#!/usr/bin/env node
// ttt — Token to Time. How much real time your Claude tokens buy, per task and per project.
import fs from 'node:fs';
import path from 'node:path';
import { bar } from '../lib/bar.mjs';
import { indexProject, tryLock } from '../lib/indexer.mjs';
import { summarize, tokensToMs, msToTokens } from '../lib/model.mjs';
import { projectDirFor, projectsRoot, slugForCwd } from '../lib/paths.mjs';
import { projectReport, allReport, breakdownRows } from '../lib/report.mjs';
import { recordDurations, globalRate, globalTasks, globalDurations } from '../lib/global.mjs';
import { backtest, estimate } from '../lib/forecast.mjs';
import { buildIndex, neighbours } from '../lib/similar.mjs';
import { blockedCauses, applyRules } from '../lib/blocked.mjs';
import { findPlanFile, parseChecklist, githubIssues, forecastPlan } from '../lib/plan.mjs';
import { writeDashboard } from '../lib/dashboard.mjs';
import { fmtUsd } from '../lib/pricing.mjs';
import { execFileSync } from 'node:child_process';
import { fmtDur, fmtTok, parseDuration, parseTokens } from '../lib/util.mjs';
import { c } from '../lib/style.mjs';

const HELP = `
  ${c.bold(c.gold('⏱ ttt'))} ${c.dim('— Token to Time')}

  ${c.white('ttt bar')} [full|task|project]   status-line segment (reads Claude Code JSON on stdin)
  ${c.white('ttt report')} [dir] [--tasks N]   real time, agent time, tokens and tasks for a project
  ${c.white('ttt all')}                       every project, ranked by real time
  ${c.white('ttt convert')} <250k|1.5M|45m|2h>  token ⇄ time at this project's measured rate
  ${c.white('ttt eta')} "<prompt>"              forecast a task before you send it (similar past tasks)
  ${c.white('ttt why')} [n]                     where the time went in the last (or nth-last) task
  ${c.white('ttt blocked')} [--apply] [--all]   time Claude waited on you, and rules to stop it
  ${c.white('ttt plan')} [file] [--issues]      forecast your roadmap: TODO.md/ROADMAP.md or GitHub issues
  ${c.white('ttt dashboard')} [--all]           open the local visual dashboard
  ${c.white('ttt index')} [--dir D] [--all]    (re)build the cache; the bar does this automatically
  ${c.white('ttt help')}

  ${c.dim('Flags:')} --json  machine-readable output   ${c.dim('Env:')} TTT_TOKENS=out|work|all  TTT_IDLE_MIN=5  NO_COLOR=1
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['dir', 'tasks', 'out'].includes(k)) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

function resolveProjectDir(arg) {
  if (!arg) return projectDirFor({ slug: slugForCwd(process.cwd()) });
  if (fs.existsSync(path.join(arg)) && path.resolve(arg).startsWith(projectsRoot())) return path.resolve(arg);
  return projectDirFor({ slug: slugForCwd(arg) });
}

function load(projectDir, { quiet } = {}) {
  if (!fs.existsSync(projectDir)) {
    console.error(c.red(`no Claude Code transcripts for ${projectDir}`));
    process.exit(1);
  }
  const t0 = Date.now();
  const release = tryLock(path.basename(projectDir));
  let r;
  try { r = indexProject(projectDir); } finally { release?.(); }
  const sum = summarize(r.state);
  recordDurations(sum);
  if (!quiet && Date.now() - t0 > 1500) console.error(c.dim(`  indexed in ${fmtDur(Date.now() - t0)}`));
  return sum;
}

function allProjectDirs() {
  return fs.readdirSync(projectsRoot(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(projectsRoot(), e.name));
}

function stripForJson(sum) {
  return { ...sum, tasks: sum.tasks.map(({ segs, ...t }) => t) };
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'report';

try {
  switch (cmd) {
    case 'bar': {
      // TTT_NOW (epoch ms) pins the clock, for demos and reproducible screenshots.
      process.stdout.write(bar(args._[1] || 'full', undefined, Number(process.env.TTT_NOW) || Date.now()));
      break;
    }
    case 'report': {
      const sum = load(resolveProjectDir(args.dir || args._[1]));
      if (args.json) console.log(JSON.stringify(stripForJson(sum), null, 2));
      else console.log(projectReport(sum, { tasks: Number(args.tasks) || 12, calib: backtest(sum, globalTasks(sum.slug)) }));
      break;
    }
    case 'all': {
      const dirs = allProjectDirs();
      const sums = dirs.map((d, i) => {
        if (process.stderr.isTTY) process.stderr.write(`\r${c.dim(`  indexing ${i + 1}/${dirs.length}…`)}\x1b[K`);
        return load(d, { quiet: true });
      });
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      if (args.json) console.log(JSON.stringify(sums.map((s) => ({ name: s.name, cwd: s.cwd, total: s.total, today: s.today })), null, 2));
      else console.log(allReport(sums));
      break;
    }
    case 'convert': {
      const q = args._.slice(1).join(' ');
      if (!q) throw new Error('usage: ttt convert <250k | 1.5M | 45m | 2h>');
      const dir = resolveProjectDir(args.dir);
      const sum = fs.existsSync(dir) ? load(dir, { quiet: true }) : null;
      const own = sum && sum.total.active > 10 * 60_000 ? sum.total.rate : 0;
      const r = own || globalRate();
      const basis = own ? `${sum.name}'s pace (${fmtTok(r)}/min over ${sum.total.n} tasks)` : `your all-project pace (${fmtTok(r)}/min)`;
      if (!(r > 0)) throw new Error('no history yet — run `ttt all` once to learn your pace');
      const ms = parseDuration(q), tok = parseTokens(q);
      const mode = sum?.tokenMode || 'out';
      if (Number.isFinite(tok)) console.log(`  ${c.cyan(fmtTok(tok))} ${c.dim(mode + ' tok')} ≈ ${c.bold(c.white(fmtDur(tokensToMs(tok, r))))} ${c.dim('of Claude work at ' + basis)}`);
      else if (Number.isFinite(ms)) console.log(`  ${c.white(fmtDur(ms))} ≈ ${c.bold(c.cyan(fmtTok(msToTokens(ms, r))))} ${c.dim(mode + ' tok at ' + basis)}`);
      else throw new Error(`can't read "${q}" — try 250k, 1.5M, 45m or 1h30m`);
      break;
    }
    case 'eta': {
      const prompt = args._.slice(1).join(' ');
      if (!prompt) throw new Error('usage: ttt eta "<what you are about to ask Claude>"');
      const sum = load(resolveProjectDir(args.dir), { quiet: true });
      const others = globalTasks(sum.slug);
      const e = estimate(sum, { key: 'eta', prompt, active: 0 }, { others, fallbackDurations: globalDurations(sum.slug) });
      const done = sum.tasks.filter((t) => t.status === 'done' && t.active > 0);
      const pool = [...done, ...others];
      const nb = neighbours(buildIndex(pool), pool, prompt, { k: 5 });
      const calib = backtest(sum, others);
      if (args.json) { console.log(JSON.stringify({ estimate: e, similar: nb.map((n) => ({ prompt: n.task.prompt, active: n.task.active, tokens: n.task.tokens, sim: n.sim })) }, null, 2)); break; }
      console.log('');
      if (!e.ok) { console.log(c.dim('  Not enough history yet: finish a few tasks first.')); break; }
      const range = calib.ok ? c.dim(` (likely ${fmtDur(e.total * calib.r20)}–${fmtDur(e.total * calib.r80)})`) : '';
      const icon = { plan: '📋', similar: '🔮', history: '⏳' }[e.source];
      console.log(`  ${icon} ${c.bold(c.white(`~${fmtDur(e.total)}`))}${range}  ${Number.isFinite(e.tokens) ? `${c.dim('·')} ${c.cyan(`~${fmtTok(e.tokens)}`)} ${c.dim(sum.tokenMode)}` : ''}`);
      console.log(c.dim(`     based on ${e.source === 'similar' ? `${e.support} similar past tasks` : 'all your past tasks'}`));
      if (nb.length) {
        console.log('');
        console.log(`  ${c.bold('Most similar')}`);
        for (const n of nb) console.log(`  ${c.dim(`${Math.round(n.sim * 100)}%`.padStart(4))}  ${c.white(fmtDur(n.task.active).padStart(7))}  ${c.cyan(fmtTok(n.task.tokens).padStart(6))}  ${n.task.prompt.slice(0, 64)}${n.task.proj ? c.faint(`  (${n.task.proj.split('-').pop()})`) : ''}`);
      }
      console.log('');
      break;
    }
    case 'why': {
      const sum = load(resolveProjectDir(args.dir), { quiet: true });
      // Default: the last task that finished; `ttt why 3` = third-last finished.
      const n = Math.max(1, Number(args._[1]) || 1);
      const finished = sum.tasks.filter((t) => t.status !== 'running' && t.msgs > 0);
      const v = (finished.length ? finished : sum.tasks).at(-n);
      if (!v) throw new Error('no such task');
      if (args.json) { const { segs, ...rest } = v; console.log(JSON.stringify(rest, null, 2)); break; }
      const prior = sum.tasks.filter((t) => t.start < v.start && t.status === 'done' && t.active > 0);
      const others = globalTasks(sum.slug).filter((o) => o.start + o.active < v.start);
      const pre = estimate(sum, { key: v.key, prompt: v.prompt, active: 0, model: v.model, effort: v.effort }, { done: prior, others });
      console.log('');
      console.log(`  ${c.bold(c.white(v.prompt.slice(0, 90)))}`);
      console.log(`  ${c.dim([v.status, v.model, v.effort && `${v.effort} effort`, v.kind].filter(Boolean).join(' · '))}`);
      console.log('');
      console.log(`  ${c.dim('active'.padEnd(12))}${c.bold(fmtDur(v.active))}  ${c.dim('wall')} ${fmtDur(v.wall)}  ${v.agents ? `${c.dim('agent-time')} ${c.violet(fmtDur(v.agentTime))} ${c.dim(`(${v.agents} subagents)`)}` : ''}`);
      console.log(`  ${c.dim('tokens'.padEnd(12))}${c.cyan(fmtTok(v.out))} ${c.dim('out')}  ${c.dim('·')}  ${fmtTok(v.in + v.cw)} ${c.dim('in')}  ${c.dim('·')}  ${c.faint(`${fmtTok(v.cr)} cache-read`)}  ${c.dim('·')}  ${c.gold(fmtUsd(v.cost))}`);
      if (pre.ok && v.status === 'done') {
        const ratio = v.active / pre.total;
        const verdict = ratio > 1.6 ? c.amber(`took ${ratio.toFixed(1)}× longer`) : ratio < 0.6 ? c.green(`${(1 / ratio).toFixed(1)}× faster`) : c.green('on target');
        console.log(`  ${c.dim('forecast'.padEnd(12))}${c.white(`~${fmtDur(pre.total)}`)} ${c.dim(`at the start (${pre.source})`)}  ${c.dim('→')} ${verdict}`);
      }
      if (v.plan) console.log(`  ${c.dim('plan'.padEnd(12))}${v.plan.done}/${v.plan.total} ${c.dim(v.plan.kind === 'agents' ? 'subagents finished' : 'todos done')}`);
      console.log('');
      console.log(`  ${c.bold('Where the time went')}`);
      for (const r of breakdownRows(v.br)) console.log(`  ${r}`);
      const causes = blockedCauses(v.blocked);
      if (causes.length) {
        console.log('');
        console.log(`  ${c.bold('Waiting on you')}`);
        for (const k of causes) console.log(`  ${c.white(k.label.padEnd(26))} ${c.amber(fmtDur(k.ms).padStart(7))} ${c.dim(`×${k.count}`)}`);
      }
      console.log('');
      break;
    }
    case 'blocked': {
      const sums = args.all ? allProjectDirs().map((d) => load(d, { quiet: true })) : [load(resolveProjectDir(args.dir), { quiet: true })];
      const merged = {};
      let total = 0;
      for (const s of sums) for (const [k, [n, ms]] of Object.entries(s.total.blocked)) { const x = (merged[k] ||= [0, 0]); x[0] += n; x[1] += ms; total += ms; }
      const today = sums.reduce((a, s) => a + s.today.wait, 0);
      const causes = blockedCauses(merged);
      if (args.json) { console.log(JSON.stringify({ total, today, causes }, null, 2)); break; }
      console.log('');
      console.log(`  ${c.bold('⏸ Claude waited on you')} ${c.amber(fmtDur(total))}${today ? ` ${c.dim('·')} ${c.amber(fmtDur(today))} ${c.dim('today')}` : ''}  ${c.faint(args.all ? 'all projects' : sums[0].name)}`);
      console.log('');
      if (!causes.length) { console.log(c.green('  Nothing — Claude never had to wait for you.\n')); break; }
      for (const k of causes.slice(0, 12)) {
        console.log(`  ${c.white(k.label.padEnd(28))} ${c.amber(fmtDur(k.ms).padStart(7))} ${c.dim(`×${String(k.count).padEnd(4)}`)} ${k.rule ? c.sky(k.rule) : c.faint('Claude asked you a question')}`);
      }
      const rules = causes.filter((k) => k.rule).map((k) => k.rule);
      const avoidable = causes.filter((k) => k.rule).reduce((a, k) => a + k.ms, 0);
      if (rules.length) {
        console.log('');
        console.log(`  ${c.dim('Pre-approving these would have saved')} ${c.green(fmtDur(avoidable))}${c.dim('. Review before applying — only allow commands you trust.')}`);
        if (args.all) {
          console.log(c.faint('  run `ttt blocked --apply` inside a project to add its rules there'));
        } else if (args.apply) {
          const { file, added } = applyRules(sums[0].cwd || process.cwd(), rules);
          console.log(added.length ? `  ${c.green('✓')} added ${added.length} rules to ${file}` : `  ${c.dim('already allowed in')} ${file}`);
        } else {
          console.log(c.faint(`  ttt blocked --apply   adds the rules above to ${sums[0].cwd || '.'}/.claude/settings.local.json`));
        }
      }
      console.log('');
      break;
    }
    case 'plan': {
      const sum = load(resolveProjectDir(args.dir), { quiet: true });
      const cwd = sum.cwd || process.cwd();
      let items, source;
      if (args.issues) { items = githubIssues(cwd); source = 'GitHub issues'; if (!items) throw new Error('could not read issues (is `gh` installed and authenticated here?)'); }
      else {
        const file = args._[1] ? path.resolve(args._[1]) : findPlanFile(cwd);
        if (!file) throw new Error(`no TODO.md / ROADMAP.md / PLAN.md in ${cwd} — pass a file, or use --issues`);
        items = parseChecklist(fs.readFileSync(file, 'utf8'));
        const rel = path.relative(cwd, file);
        source = rel && !rel.startsWith('..') ? rel : path.basename(file);
      }
      const f = forecastPlan(sum, items, { others: globalTasks(sum.slug) });
      if (args.json) { console.log(JSON.stringify(f, null, 2)); break; }
      console.log('');
      console.log(`  ${c.bold('🏁 Roadmap forecast')}  ${c.faint(`${source} · ${f.doneCount}/${f.total} done`)}`);
      console.log('');
      let section = null;
      for (const i of f.open) {
        if (i.section && i.section !== section) { section = i.section; console.log(`  ${c.dim(section)}`); }
        const icon = { plan: '📋', similar: '🔮', history: '⏳', median: '·' }[i.source] || '·';
        console.log(`   ${icon} ${c.white(fmtDur(i.ms).padStart(7))}  ${c.cyan(fmtTok(i.tokens).padStart(6))}  ${i.title.slice(0, 70)}`);
      }
      console.log('');
      console.log(`  ${c.bold('Σ')} ${c.bold(c.white(fmtDur(f.totalMs)))} ${c.dim('of Claude time')}  ${c.dim('·')}  ${c.cyan(fmtTok(f.totalTok))} ${c.dim(sum.tokenMode)}${f.finishAt ? `  ${c.dim('·')}  ${c.dim('at your pace of')} ${fmtDur(f.pace)}${c.dim('/day →')} ${c.green(new Date(f.finishAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}` : ''}`);
      console.log(c.faint('  🔮 = estimated from similar past tasks · ⏳ = from your typical task · forecasts are typically off by ×2–3 per item, less in total'));
      console.log('');
      break;
    }
    case 'dashboard': {
      const dirs = args.all ? allProjectDirs() : [resolveProjectDir(args.dir)];
      const sums = dirs.map((d) => load(d, { quiet: true }));
      const calib = !args.all ? backtest(sums[0], globalTasks(sums[0].slug)) : null;
      const out = writeDashboard(sums, { calib, file: args.out });
      console.log(`  ${c.green('✓')} ${out}`);
      if (!args['no-open'] && process.platform === 'darwin') execFileSync('open', [out]);
      break;
    }
    case 'index': {
      const dirs = args.all ? allProjectDirs() : [args.dir ? path.resolve(args.dir) : resolveProjectDir(args._[1])];
      for (const d of dirs) {
        const sum = load(d, { quiet: true });
        if (!args.quiet) console.log(`  ${c.gold(sum.name)} ${c.dim('·')} ${sum.total.n} tasks ${c.dim('·')} ${fmtDur(sum.total.wall)}`);
      }
      break;
    }
    case 'help': case '-h': case '--help':
      console.log(HELP);
      break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
} catch (err) {
  if (cmd === 'bar') process.stdout.write(c.dim('⏱ TTT ·') + c.red(' err')); // never break the status line
  else { console.error(c.red(`  ${err.message}`)); process.exitCode = 1; }
  if (process.env.TTT_DEBUG) console.error(err);
}
