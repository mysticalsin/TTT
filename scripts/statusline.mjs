#!/usr/bin/env node
// Add or remove the TTT line in a ccstatusline settings.json, keeping a timestamped backup.
// Writes through symlinks (tonys-tcc links its config into ~/.config), never replacing them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [action, cfgPath] = process.argv.slice(2);
const real = fs.realpathSync(cfgPath);
const cfg = JSON.parse(fs.readFileSync(real, 'utf8'));
cfg.lines ||= [];

const isTTT = (w) => typeof w?.id === 'string' && w.id.startsWith('v-ttt');
const has = cfg.lines.some((line) => line.some(isTTT));

const LINE = [
  { id: 'v-ttt-task', type: 'custom-command', commandPath: '$HOME/.claude/bin/ttt bar task', preserveColors: true, timeout: 1500 },
  { id: 'v-ttt-project', type: 'custom-command', commandPath: '$HOME/.claude/bin/ttt bar project', preserveColors: true, timeout: 1500 },
];

function backup() {
  // Back up outside the config's folder so a dotfiles repo doesn't pick up stray files.
  const dir = path.join(process.env.TTT_CACHE_DIR || path.join(os.homedir(), '.cache', 'ttt'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const bak = path.join(dir, `ccstatusline-settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(real, bak);
  console.log(`bak  ${bak}`);
}

// Edit the text, not a re-serialised object, so hand formatting (one widget per line)
// survives and the dotfiles diff is exactly the TTT line.
const text = fs.readFileSync(real, 'utf8');
const widgetLine = (w, indent) => `${indent}${JSON.stringify(w).replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/":/g, '": ').replace(/,"/g, ', "')}`;

function write(next) {
  JSON.parse(next); // never leave an invalid config behind
  backup();
  fs.writeFileSync(real, next);
}

if (action === 'add') {
  if (has) { console.log(`ok   TTT line already in ${cfgPath}`); process.exit(0); }
  // Sit just above the rainbow rule if there is one, else at the bottom.
  const m = /\n([ \t]*)\[\s*\n([ \t]*)\{[^\n]*rainbow/.exec(text);
  let next;
  if (m) {
    const [, outer, inner] = m;
    const block = `\n${outer}[\n${LINE.map((w) => widgetLine(w, inner)).join(',\n')}\n${outer}],`;
    next = text.slice(0, m.index) + block + text.slice(m.index);
  } else {
    cfg.lines.push(LINE);
    next = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  write(next);
  console.log(`add  TTT line -> ${cfgPath}${real !== cfgPath ? ` (${real})` : ''}`);
} else if (action === 'remove') {
  if (!has) { console.log('ok   no TTT line to remove'); process.exit(0); }
  const block = /\n[ \t]*\[\s*\n(?:[ \t]*\{[^\n]*"v-ttt[^\n]*\n)+[ \t]*\],?/;
  let next = text.replace(block, '');
  try { if (JSON.parse(next).lines.some((l) => l.some(isTTT))) throw 0; } catch {
    cfg.lines = cfg.lines.map((line) => line.filter((w) => !isTTT(w))).filter((line) => line.length);
    next = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  write(next);
  console.log(`rm   TTT line from ${cfgPath}`);
} else {
  console.error('usage: statusline.mjs add|remove <settings.json>');
  process.exit(1);
}
