#!/usr/bin/env node
// ttt — Token to Time. How much real time your Claude tokens buy, per task and per project.
import fs from 'node:fs';
import path from 'node:path';
import { bar } from '../lib/bar.mjs';
import { indexProject, tryLock } from '../lib/indexer.mjs';
import { summarize, tokensToMs, msToTokens } from '../lib/model.mjs';
import { projectDirFor, projectsRoot, slugForCwd } from '../lib/paths.mjs';
import { projectReport, allReport } from '../lib/report.mjs';
import { recordDurations, globalRate } from '../lib/global.mjs';
import { fmtDur, fmtTok, parseDuration, parseTokens } from '../lib/util.mjs';
import { c } from '../lib/style.mjs';

const HELP = `
  ${c.bold(c.gold('⏱ ttt'))} ${c.dim('— Token to Time')}

  ${c.white('ttt bar')} [full|task|project]   status-line segment (reads Claude Code JSON on stdin)
  ${c.white('ttt report')} [dir] [--tasks N]   real time, agent time, tokens and tasks for a project
  ${c.white('ttt all')}                       every project, ranked by real time
  ${c.white('ttt convert')} <250k|1.5M|45m|2h>  token ⇄ time at this project's measured rate
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
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['dir', 'tasks'].includes(k)) args[k] = argv[++i];
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
      else console.log(projectReport(sum, { tasks: Number(args.tasks) || 12 }));
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
