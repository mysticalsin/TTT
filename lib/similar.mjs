// "This looks like your other X tasks": prompt similarity without any model calls.
// TF-IDF over prompt words (plus kind tags), cosine similarity, weighted neighbours.

const STOP = new Set(('a an the and or but if then so to of in on at for with by from into onto is are was were be been ' +
  'it its this that these those i me my we our you your he she they them can could should would will do does did ' +
  'make sure please just also all any some more most very really like need want get got let lets go going keep ' +
  'about as up out over than too not no yes ok okay hey hi now new use using way thing things').split(' '));

/** Coarse task kinds, used for grouping (model economics) and as extra similarity features. */
const KINDS = [
  ['review', /\b(review|audit|critique|check over|code-review|security-review)\b/],
  ['test', /\b(tests?|spec|e2e|qa|coverage|flaky)\b/],
  ['fix', /\b(fix|bug|broken|error|crash|fails?|failing|debug|issue|wrong)\b/],
  ['refactor', /\b(refactor|clean ?up|simplif|rename|restructure|migrat|upgrade)\b/],
  ['explain', /\b(explain|why|what is|how does|understand|summari[sz]e|research|investigate|find)\b/],
  ['docs', /\b(docs?|readme|document|write ?up|changelog)\b/],
  ['ops', /\b(deploy|ci|pipeline|release|publish|install|setup|set up|config|docker|push)\b/],
  ['design', /\b(design|ui|ux|layout|style|css|visual|mockup)\b/],
  ['build', /\b(build|add|implement|create|make|feature|support|new)\b/],
];

export function kindOf(prompt) {
  const p = String(prompt).toLowerCase();
  if (p.startsWith('/')) return p.includes('review') ? 'review' : 'command';
  for (const [k, re] of KINDS) if (re.test(p)) return k;
  return 'other';
}

export function tokenize(prompt) {
  const p = String(prompt).toLowerCase();
  const words = p.replace(/[^a-z0-9/+#.\- ]+/g, ' ').split(/\s+/)
    .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w));
  return [...words, `kind:${kindOf(p)}`];
}

/** Build an index over tasks [{prompt,...}] -> { vecs, idf }. */
export function buildIndex(tasks) {
  const docs = tasks.map((t) => tokenize(t.prompt));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length || 1;
  const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;
  const vec = (words) => {
    const tf = new Map();
    for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
    let norm = 0;
    const v = new Map();
    for (const [w, n] of tf) { const x = n * idf(w); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  };
  return { vecs: docs.map(vec), vec: (prompt) => vec(tokenize(prompt)) };
}

export function cosine(a, b) {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [w, x] of small) { const y = big.get(w); if (y) s += x * y; }
  return s;
}

/**
 * Neighbours of `query` among `tasks` (same order as the index), weighted by similarity,
 * with a bonus when the model / effort match what's running now.
 */
export function neighbours(index, tasks, query, { model, effort, k = 9, minSim = 0.12 } = {}) {
  const q = index.vec(query);
  const out = [];
  tasks.forEach((t, i) => {
    const sim = cosine(q, index.vecs[i]);
    if (sim < minSim) return;
    let w = sim;
    if (model && t.model === model) w *= 1.5;
    if (effort && t.effort === effort) w *= 1.3;
    out.push({ task: t, sim, w });
  });
  return out.sort((a, b) => b.w - a.w).slice(0, k);
}

export function weightedQuantile(pairs, q) {
  // pairs: [value, weight]
  const s = pairs.filter(([v, w]) => Number.isFinite(v) && w > 0).sort((a, b) => a[0] - b[0]);
  const total = s.reduce((a, [, w]) => a + w, 0);
  if (!total) return NaN;
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= q * total) return v; }
  return s.at(-1)[0];
}
