// API-equivalent cost of a task, from its per-model token mix.
// USD per million tokens: [input, output, cache read]. Cache writes are priced from input:
// 1.25× for the 5-minute TTL, 2× for the 1-hour TTL. Override any row with TTT_PRICES, e.g.
//   TTT_PRICES='{"opus-5.5":[4,20,0.2]}'
// If you're on a subscription these are what the same work would cost on the API.
const BASE = {
  'fable-5.1': [10, 50, 0.25], 'fable-5': [10, 50, 1], 'mythos-5.1': [10, 50, 0.25],
  'opus-5.5': [4, 20, 0.2], 'opus-5': [5, 25, 0.5], 'opus-4.8': [5, 25, 0.5], 'opus-4.7': [5, 25, 0.5],
  'opus-4.6': [5, 25, 0.5], 'opus-4.5': [5, 25, 0.5], 'opus-4.1': [15, 75, 1.5], 'opus-4': [15, 75, 1.5],
  'sonnet-5.5': [2, 10, 0.2], 'sonnet-5': [2, 10, 0.2], 'sonnet-4.6': [3, 15, 0.3], 'sonnet-4.5': [3, 15, 0.3], 'sonnet-4': [3, 15, 0.3],
  'haiku-5.5': [0.1, 0.5, 0.01], 'haiku-4.5': [1, 5, 0.1], 'haiku-3.5': [0.8, 4, 0.08],
};

let table = BASE;
try { if (process.env.TTT_PRICES) table = { ...BASE, ...JSON.parse(process.env.TTT_PRICES) }; } catch { /* keep base */ }

/** Family fallback for model names we don't list: "sonnet-9.1" -> the newest sonnet we know. */
function priceFor(model) {
  if (table[model]) return table[model];
  const fam = String(model).split('-')[0];
  const known = Object.keys(table).find((k) => k.startsWith(`${fam}-`));
  return known ? table[known] : table['sonnet-5.5'];
}

/** mt: { model: [in, out, cw5m, cw1h, cacheRead] } -> USD */
export function costOf(mt = {}) {
  let usd = 0;
  for (const [model, [i, o, w5, w1, r]] of Object.entries(mt)) {
    const [pi, po, pr] = priceFor(model);
    usd += (i * pi + o * po + w5 * pi * 1.25 + w1 * pi * 2 + r * pr) / 1e6;
  }
  return usd;
}

export function fmtUsd(usd) {
  if (!Number.isFinite(usd)) return '–';
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(0)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}
