import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-feat-'));
process.env.TTT_CACHE_DIR = path.join(tmp, 'cache');
process.env.TTT_PROJECTS_DIR = path.join(tmp, 'projects');
process.env.NO_COLOR = '1';
process.env.TTT_NOTIFY = '0';

const { indexProject, commandLabel } = await import('../lib/indexer.mjs');
const { summarize } = await import('../lib/model.mjs');
const { estimate, backtest } = await import('../lib/forecast.mjs');
const { costOf } = await import('../lib/pricing.mjs');
const { kindOf } = await import('../lib/similar.mjs');
const { runway, burnRate } = await import('../lib/limits.mjs');
const { parseChecklist, forecastPlan } = await import('../lib/plan.mjs');
const { ruleFor, blockedCauses, applyRules } = await import('../lib/blocked.mjs');
const { writeDashboard } = await import('../lib/dashboard.mjs');
const { bar } = await import('../lib/bar.mjs');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const MIN = 60_000;
let n = 0;
const usage = (out) => ({ input_tokens: 5, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 100 } });
const human = (sec, text, pid) => ({ type: 'user', timestamp: at(sec), promptId: pid, uuid: `u${++n}`, origin: { kind: 'human' }, cwd: '/work/feat', message: { role: 'user', content: text } });
const call = (sec, name, input, stop = 'tool_use') => ({ type: 'assistant', timestamp: at(sec), message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: stop, usage: usage(100), content: [{ type: 'tool_use', id: `t${n}`, name, input }] } });
const result = (sec, pid, toolId, { error = false, text = 'ok', source = 'config' } = {}) => ({
  type: 'user', timestamp: at(sec), promptId: pid, permissionDecision: { decision: 'accept', source },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: error, content: text }] },
});
const say = (sec, out = 100, stop = 'end_turn') => ({ type: 'assistant', timestamp: at(sec), message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: stop, usage: usage(out) } });

function project(name, files) {
  const dir = path.join(process.env.TTT_PROJECTS_DIR, name);
  for (const [rel, entries] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}
const lastToolId = () => `t${n}`;

test('time breakdown and human-approval waits', () => {
  const e = [human(0, 'run the tests', 'P')];
  e.push(call(10, 'Bash', { command: 'cd app && npm test -- --watch=false' }));
  const id1 = lastToolId();
  e.push(result(130, 'P', id1, { source: 'user_temporary' })); // you approved after ~2 min
  e.push(call(140, 'Read', { file_path: '/x' }));
  const id2 = lastToolId();
  e.push(result(145, 'P', id2));
  e.push(say(160));
  const sum = summarize(indexProject(project('-work-feat', { 's.jsonl': e })).state, T0 + 3600_000);
  const t = sum.tasks[0];
  assert.equal(t.br.wait, 120_000);
  assert.deepEqual(t.blocked, { 'npm test': [1, 120_000] });
  assert.equal(t.br.tools.Read, 5000);
  assert.equal(t.br.model, 10_000 + 10_000 + 15_000);
  assert.equal(sum.total.blocked['npm test'][0], 1);
  assert.ok(t.cost > 0);
});

test('plan progress from subagents and todos; loop detection', () => {
  const main = [human(0, 'build it', 'P'), call(5, 'TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] })];
  const sub = (id, stop) => [
    { type: 'user', isSidechain: true, promptId: 'P', agentId: id, timestamp: at(6), message: { role: 'user', content: 'go' } },
    { type: 'assistant', isSidechain: true, agentId: id, timestamp: at(20), message: { id: `s${id}`, model: 'claude-sonnet-5-5', stop_reason: stop, usage: usage(50) } },
  ];
  // Same failing call, four times in a row.
  for (let i = 0; i < 4; i++) {
    main.push(call(30 + i * 10, 'Bash', { command: 'npm test' }));
    main.push(result(35 + i * 10, 'P', lastToolId(), { error: true, text: 'Error: expected 2 got 3' }));
  }
  const dir = project('-work-plan', { 's.jsonl': main, 's/subagents/agent-a.jsonl': sub('a', 'end_turn'), 's/subagents/agent-b.jsonl': sub('b', 'tool_use') });
  const sum = summarize(indexProject(dir).state, T0 + 80_000);
  const t = sum.tasks[0];
  assert.equal(t.status, 'running');
  assert.deepEqual(t.plan, { kind: 'todos', done: 1, total: 3 });
  assert.match(t.loop.why, /same error ×4/);
});

test('API cost uses per-model prices and cache-write TTLs', () => {
  // 1M in, 1M out on opus-5.5 = $4 + $20; 1M 1h cache writes = 2 × $4; 1M reads = $0.20
  assert.equal(Math.round(costOf({ 'opus-5.5': [1e6, 1e6, 0, 1e6, 1e6] }) * 100) / 100, 32.2);
  assert.ok(costOf({ 'haiku-5.5': [1e6, 1e6, 0, 0, 0] }) < 1);
});

test('kinds and command labels', () => {
  assert.equal(kindOf('Fix the flaky login test'), 'test');
  assert.equal(kindOf('fix the crash on save'), 'fix');
  assert.equal(kindOf('/code-review high'), 'review');
  assert.equal(commandLabel('Bash', { command: 'cd x && FOO=1 npm run build' }), 'npm run');
  assert.equal(commandLabel('Bash', { command: 'timeout 30 node bin/x.mjs' }), 'node');
  assert.equal(commandLabel('Bash', { command: 'for f in *; do magick $f out; done' }), 'magick');
  assert.equal(commandLabel('mcp__github__create_issue', {}), 'mcp__github');
});

function history(dir, items) {
  // items: [prompt, minutes]
  const e = [];
  let t = 0;
  for (const [p, m] of items) {
    const pid = `H${++n}`;
    e.push(human(t, p, pid));
    for (let s = 30; s < m * 60; s += 60) e.push(say(t + s, 300, 'tool_use'));
    e.push(say(t + m * 60, 300, 'end_turn'));
    t += m * 60 + 600;
  }
  return project(dir, { 'h.jsonl': e });
}

test('similar prompts drive the estimate; backtest measures it', () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    items.push([`write docs for module ${i} readme`, 2]);
    items.push([`refactor the payment engine part ${i}`, 30]);
  }
  const sum = summarize(indexProject(history('-work-sim', items)).state, T0 + 100 * 3600_000);
  const docs = estimate(sum, { key: 'q1', prompt: 'write docs readme for the cli', active: 0 });
  const big = estimate(sum, { key: 'q2', prompt: 'refactor the payment engine retries', active: 0 });
  assert.equal(docs.source, 'similar');
  assert.ok(docs.total < 5 * MIN, `docs ${docs.total}`);
  assert.ok(big.total > 20 * MIN, `refactor ${big.total}`);
  const b = backtest(sum);
  assert.ok(b.ok);
  assert.ok(b.offBy < b.naiveOffBy, 'beats the median baseline');
  assert.ok(b.within2x > 0.8);
});

test('limits runway: burn per working minute → tasks left and cap warning', () => {
  const reset = Math.round((T0 + 3 * 3600_000) / 1000);
  let r;
  for (let i = 0; i <= 10; i++) {
    r = runway({ five_hour: { used_percentage: 50 + i * 2, resets_at: reset } }, { working: true, typicalMs: 10 * MIN, remainingMs: 60 * MIN, now: T0 + i * MIN });
  }
  assert.equal(Math.round(r.burn * 10) / 10, 2); // 2% per working minute
  assert.equal(Math.round(r.tasksLeft * 10) / 10, 1.5); // 30% headroom / (2%/min × 10m)
  assert.ok(r.capAt && r.capAt < T0 + 30 * MIN);
  assert.equal(burnRate({}), null);
  // A second session on another account reporting different numbers must not fake a burn.
  const w = { samples: [[0, 10, 1, 'a'], [20_000, 40, 1, 'b'], [40_000, 10, 1, 'a'], [60_000, 41, 1, 'b'], [5 * MIN, 12, 1, 'a']] };
  assert.ok(burnRate({ k: w }) < 3, `burn ${burnRate({ k: w })}`);
});

test('roadmap checklist forecast', () => {
  const items = parseChecklist('# v1\n- [x] done thing\n- [ ] write docs readme\n  - [ ] refactor the payment engine\n## later\n* [ ] something new');
  assert.equal(items.length, 4);
  assert.equal(items.filter((i) => !i.done).length, 3);
  assert.equal(items[3].section, 'later');
  const dir = path.join(process.env.TTT_PROJECTS_DIR, '-work-sim');
  const sum = summarize(indexProject(dir).state, T0 + 100 * 3600_000);
  const f = forecastPlan(sum, items, { now: T0 + 100 * 3600_000 });
  assert.equal(f.open.length, 3);
  assert.ok(f.totalMs > 25 * MIN);
});

test('permission rules for blocked causes', () => {
  assert.equal(ruleFor('npm test'), 'Bash(npm test:*)');
  assert.equal(ruleFor('WebFetch'), 'WebFetch');
  assert.equal(ruleFor('mcp__github'), 'mcp__github');
  assert.equal(ruleFor('AskUserQuestion'), null);
  assert.equal(blockedCauses({ a: [1, 5], b: [2, 50] })[0].label, 'b');
  const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const r1 = applyRules(cwd, ['Bash(npm test:*)', null]);
  assert.deepEqual(r1.added, ['Bash(npm test:*)']);
  assert.deepEqual(applyRules(cwd, ['Bash(npm test:*)']).added, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8')).permissions.allow, ['Bash(npm test:*)']);
});

test('dashboard is one self-contained file with the data inlined', () => {
  const dir = path.join(process.env.TTT_PROJECTS_DIR, '-work-sim');
  const sum = summarize(indexProject(dir).state);
  const out = writeDashboard([sum], { file: path.join(tmp, 'dash.html') });
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<title>TTT · feat/);
  assert.match(html, /refactor the payment engine/);
  assert.doesNotMatch(html, /<script[^>]+src=/); // no external scripts
  assert.doesNotMatch(html, /__DATA__/);
});

test('bar: pre-flight forecast right after sending, loop alert while running', () => {
  const dir = path.join(process.env.TTT_PROJECTS_DIR, '-work-sim');
  const file = path.join(dir, 'live.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(human(0, 'refactor the payment engine webhooks', 'LIVE'))}\n`);
  const input = { session_id: 'live', transcript_path: file };
  const pre = bar('task', input, T0 + 5000);
  assert.match(pre, /⏳ 5s 🔮 ~\d/);

  const e = [];
  for (let i = 0; i < 5; i++) {
    e.push(call(10 + i * 10, 'Bash', { command: 'npm test' }));
    e.push(result(15 + i * 10, 'LIVE', lastToolId(), { error: true, text: 'same failure' }));
  }
  fs.appendFileSync(file, e.map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.match(bar('task', input, T0 + 70_000), /🌀 same (error|call) ×5/);
});

test('trace: nested spans, handoff → subagent via meta.json, and $-safe HTML', async () => {
  const { buildTrace, renderTraceTty } = await import('../lib/trace.mjs');
  const { writeTraceHtml } = await import('../lib/trace-html.mjs');
  const e = [human(0, "deploy it with $'quotes' and $PWD", 'TR')];
  e.push(call(5, 'Agent', { description: 'Research the API', prompt: 'go' }));
  const agentTool = lastToolId();
  e.push({ ...result(8, 'TR', agentTool), toolUseResult: { agentId: 'ag1', isAsync: true, status: 'async_launched' } });
  e.push(call(20, 'Bash', { command: 'cd app && export X=1 && npm test' }));
  e.push(result(50, 'TR', lastToolId(), { error: true, text: 'FAIL' }));
  e.push(call(60, 'Bash', { command: 'npm run deploy' }));
  e.push(result(130, 'TR', lastToolId(), { source: 'user_temporary' }));
  e.push(say(140));
  const sub = [
    { type: 'user', isSidechain: true, promptId: 'TR', agentId: 'ag1', timestamp: at(9), message: { role: 'user', content: 'go' } },
    { type: 'assistant', isSidechain: true, agentId: 'ag1', timestamp: at(30), message: { id: 'sx1', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: usage(80) } },
  ];
  const dir = project('-work-trace', { 't.jsonl': e, 't/subagents/agent-ag1.jsonl': sub });
  fs.writeFileSync(path.join(dir, 't/subagents/agent-ag1.meta.json'), JSON.stringify({ toolUseId: agentTool, description: 'Research the API' }));
  const sum = summarize(indexProject(dir).state, T0 + 3600_000);
  const tr = buildTrace(dir, sum.tasks[0]);
  const kinds = tr.spans.map((s) => s.kind);
  assert.equal(tr.spans[0].kind, 'orchestrator');
  assert.ok(kinds.includes('handoff') && kinds.includes('agent') && kinds.includes('failed') && kinds.includes('waiting'));
  const agent = tr.spans.find((s) => s.kind === 'agent');
  const handoff = tr.spans.find((s) => s.kind === 'handoff');
  assert.equal(agent.parent, handoff.id); // nested under the call that spawned it
  assert.equal(agent.name, 'Research the API');
  assert.equal(tr.summary.errors, 1);
  assert.equal(tr.summary.waiting, 70_000);
  assert.equal(tr.spans.find((s) => s.kind === 'failed').detail, 'npm test'); // setup noise stripped
  assert.match(renderTraceTty(tr), /Orchestrator[\s\S]*Research the API[\s\S]*Slowest/);
  const html = fs.readFileSync(writeTraceHtml(tr, { file: path.join(tmp, 'trace.html') }), 'utf8');
  assert.ok(html.includes("$'quotes' and $PWD"), 'replacement patterns must not corrupt the page');
  assert.doesNotMatch(html, /__DATA__|<script[^>]+src=/);
});
