import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-test-'));
process.env.TTT_CACHE_DIR = path.join(tmp, 'cache');
process.env.TTT_PROJECTS_DIR = path.join(tmp, 'projects');
process.env.NO_COLOR = '1';

const { indexProject, promptText, promptLabel, shortModel } = await import('../lib/indexer.mjs');
const { summarize, forecast, segments, unionMs } = await import('../lib/model.mjs');
const { renderTask, renderProject, bar } = await import('../lib/bar.mjs');
const { fmtDur, fmtTok, parseDuration, parseTokens, width } = await import('../lib/util.mjs');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const usage = (out, extra = {}) => ({ input_tokens: 5, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, ...extra });

const human = (sec, text, promptId) => ({ type: 'user', timestamp: at(sec), promptId, uuid: `u${sec}`, origin: { kind: 'human' }, cwd: '/work/demo', message: { role: 'user', content: text } });
const toolResult = (sec, promptId) => ({ type: 'user', timestamp: at(sec), promptId, uuid: `r${sec}`, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const asst = (sec, id, out, stop = 'tool_use', model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: at(sec), uuid: `a${sec}`, message: { id, model, stop_reason: stop, usage: usage(out) } });

function project(name) {
  const dir = path.join(process.env.TTT_PROJECTS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const write = (file, entries, { append = false, partial = '' } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '') + partial;
  (append ? fs.appendFileSync : fs.writeFileSync)(file, body);
};

test('formatting and parsing', () => {
  assert.equal(fmtDur(4000), '4s');
  assert.equal(fmtDur(95_000), '1m35s');
  assert.equal(fmtDur(3_725_000), '1h02m');
  assert.equal(fmtTok(1234), '1.2k');
  assert.equal(fmtTok(2_210_000), '2.21M');
  assert.equal(parseTokens('250k'), 250_000);
  assert.equal(parseTokens('1.5M'), 1_500_000);
  assert.ok(Number.isNaN(parseTokens('45m tea')));
  assert.equal(parseDuration('1h30m'), 90 * 60_000);
  assert.equal(parseDuration('45m'), 45 * 60_000);
  assert.ok(Number.isNaN(parseDuration('250k')));
  assert.equal(width('⏳ ab'), 5);
});

test('prompt classification', () => {
  assert.equal(promptText(human(0, 'build it', 'p')), 'build it');
  assert.equal(promptText(toolResult(0, 'p')), null);
  assert.equal(promptText({ ...human(0, 'x', 'p'), origin: { kind: 'task-notification' } }), null);
  assert.equal(promptText({ ...human(0, 'x', 'p'), isMeta: true }), null);
  assert.equal(promptText(human(0, '<local-command-stdout>hi</local-command-stdout>', 'p')), null);
  assert.equal(promptText(human(0, '[Request interrupted by user]', 'p')), null);
  assert.equal(promptLabel('<command-name>/code-review</command-name><command-args>high</command-args>'), '/code-review high');
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5.5');
  assert.equal(shortModel('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModel('claude-opus-4-20250514'), 'opus-4');
});

test('segments cap idle gaps; union merges parallel work', () => {
  // 0..60s active, then a 20 minute gap (idle), then 30s more.
  const segs = segments([0, 30, 60, 1260, 1290], 5 * 60_000);
  assert.deepEqual(segs.map(([s, e]) => (e - s) / 1000), [60, 30]);
  assert.equal(unionMs([[0, 100], [50, 150], [300, 400]]), 250);
});

test('indexes tasks, dedupes repeated usage, attributes subagents by promptId', () => {
  const dir = project('-work-demo');
  const main = path.join(dir, 's1.jsonl');
  write(main, [
    human(0, 'build the thing', 'P1'),
    // One API message written as three entries, each repeating usage: count once.
    asst(5, 'm1', 200), asst(6, 'm1', 200), asst(7, 'm1', 200),
    toolResult(20, 'P1'),
    asst(60, 'm2', 300, 'end_turn'),
    human(400, '<command-name>/review</command-name>', 'P2'),
    asst(410, 'm3', 50, 'end_turn', 'claude-haiku-5-5'),
  ]);
  write(path.join(dir, 's1', 'subagents', 'agent-x.jsonl'), [
    { type: 'user', isSidechain: true, promptId: 'P1', agentId: 'x', timestamp: at(10), message: { role: 'user', content: 'sub task' } },
    { type: 'assistant', isSidechain: true, agentId: 'x', timestamp: at(15), message: { id: 's1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: usage(1000) } },
    { type: 'assistant', isSidechain: true, agentId: 'x', timestamp: at(50), message: { id: 's2', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: usage(500) } },
  ]);

  const { state } = indexProject(dir);
  const sum = summarize(state, T0 + 3600_000);
  assert.equal(sum.name, 'demo');
  assert.equal(sum.tasks.length, 2);
  const [t1, t2] = sum.tasks;
  assert.equal(t1.prompt, 'build the thing');
  assert.equal(t1.out, 200 + 300 + 1000 + 500);
  assert.equal(t1.msgs, 4);
  assert.equal(t1.agents, 1);
  assert.equal(t1.status, 'done');
  assert.equal(t1.active, 60_000);
  assert.deepEqual(t1.models, { 'opus-5.5': 500, 'sonnet-5.5': 1500 });
  assert.equal(t2.prompt, '/review');
  assert.equal(t2.out, 50);
  assert.equal(sum.total.out, 2050);
});

test('incremental: partial trailing line is deferred, then picked up exactly once', () => {
  const dir = project('-work-inc');
  const main = path.join(dir, 's.jsonl');
  const tail = JSON.stringify(asst(30, 'm2', 70, 'end_turn'));
  write(main, [human(0, 'go', 'P'), asst(10, 'm1', 30)], { partial: tail.slice(0, 25) });

  let { state } = indexProject(dir);
  let s = summarize(state, T0 + 20_000);
  assert.equal(s.tasks[0].out, 30);
  assert.equal(s.tasks[0].status, 'running');

  fs.appendFileSync(main, `${tail.slice(25)}\n`);
  ({ state } = indexProject(dir));
  s = summarize(state, T0 + 40_000);
  assert.equal(s.tasks[0].out, 100);
  assert.equal(s.tasks[0].status, 'done');

  // Nothing new: no double counting.
  const again = indexProject(dir);
  assert.equal(again.changed, false);
  assert.equal(summarize(again.state).tasks[0].out, 100);
});

test('interrupted and stalled tasks', () => {
  const dir = project('-work-stop');
  write(path.join(dir, 'a.jsonl'), [
    human(0, 'first', 'P1'), asst(5, 'm1', 10),
    { type: 'user', timestamp: at(8), promptId: 'P1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    human(100, 'second', 'P2'), asst(105, 'm2', 10),
  ]);
  const sum = summarize(indexProject(dir).state, T0 + 10 * 3600_000);
  assert.equal(sum.tasks[0].status, 'interrupted');
  assert.equal(sum.tasks[1].status, 'stalled');
});

test('forecast is a survival estimate over past durations', () => {
  const M = 60_000;
  const durations = [1, 2, 3, 4, 5, 6, 8, 10, 20, 30].map((m) => m * M);
  const early = forecast(0.5 * M, durations);
  assert.ok(early.ok);
  assert.equal(early.support, 10);
  const later = forecast(7 * M, durations); // survivors: 8,10,20,30 → remaining 1,3,13,23
  assert.ok(later.ok);
  assert.equal(later.remaining, 8 * M);
  assert.ok(later.progress > 0 && later.progress < 1);
  assert.equal(forecast(25 * M, durations).reason, 'beyond');
  assert.equal(forecast(M, durations.slice(0, 3)).reason, 'learning');
});

test('bar renders running task with ETA and project totals', () => {
  const dir = project('-work-bar');
  const entries = [];
  // Ten finished 2-minute tasks of history...
  for (let i = 0; i < 10; i++) {
    const b = i * 1000;
    entries.push(human(b, `task ${i}`, `H${i}`), asst(b + 60, `h${i}a`, 400), asst(b + 120, `h${i}b`, 400, 'end_turn'));
  }
  // ...and one running now.
  entries.push(human(20_000, 'live one', 'LIVE'), asst(20_030, 'live', 500));
  write(path.join(dir, 'sess.jsonl'), entries);

  const out = bar('full', { session_id: 'sess', transcript_path: path.join(dir, 'sess.jsonl') }, T0 + 20_045_000);
  assert.match(out, /⏳ 45s/);
  assert.match(out, /left/);
  assert.match(out, /🏗 demo|🏗 bar|🏗/);
  assert.match(out, /11 tasks/);

  const sum = summarize(indexProject(dir).state, T0 + 30_000_000);
  assert.match(renderTask(sum, sum.tasks.at(-1)), /💤|✅/);
  assert.match(renderProject(sum), /8\.5k · 11 tasks/);
});

test('bar never throws on empty or unknown input', () => {
  assert.match(bar('full', { cwd: '/nowhere/at/all' }), /no transcripts/);
});
