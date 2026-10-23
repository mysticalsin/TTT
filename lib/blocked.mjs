// "You blocked Claude for 23m today": time Claude sat waiting on a human, by cause, and the
// permission rules that would have avoided the avoidable part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUESTION = new Set(['AskUserQuestion']);

/** Permission rule for a blocked label, or null when it can't be pre-approved. */
export function ruleFor(label) {
  if (QUESTION.has(label)) return null; // a question for you, not a permission prompt
  if (label.startsWith('mcp__')) return label;
  if (/^[A-Z][A-Za-z]+$/.test(label)) return label; // a built-in tool: Edit, WebFetch, …
  return `Bash(${label}:*)`;
}

/** Ranked causes from a bucket's blocked map: [{label, count, ms, rule}] */
export function blockedCauses(blocked = {}) {
  return Object.entries(blocked)
    .map(([label, [count, ms]]) => ({ label, count, ms, rule: ruleFor(label) }))
    .sort((a, b) => b.ms - a.ms);
}

/** Add rules to <cwd>/.claude/settings.local.json (personal, not committed). Backs up first. */
export function applyRules(cwd, rules) {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  const allow = new Set(cfg.permissions?.allow || []);
  const added = rules.filter((r) => r && !allow.has(r));
  if (!added.length) return { file, added };
  if (fs.existsSync(file)) {
    const dir = path.join(process.env.TTT_CACHE_DIR || path.join(os.homedir(), '.cache', 'ttt'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `settings.local.${Date.now()}.json`));
  }
  cfg.permissions ||= {};
  cfg.permissions.allow = [...allow, ...added];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { file, added };
}
