// Bench cosine-over-array at varying N — comparing number[] (current impl)
// vs Float32Array (potential drop-in optimization).
// Question: is IVF ANN actually needed for any realistic agent-skills bank size,
// OR can a typed-array swap inside the existing cosine loop close the gap?

function randomUnitArr(d) {
  const v = new Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) { v[i] = Math.random() - 0.5; n += v[i] * v[i]; }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < d; i++) v[i] *= inv;
  return v;
}

function randomUnitF32(d) {
  const v = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) { v[i] = Math.random() - 0.5; n += v[i] * v[i]; }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < d; i++) v[i] *= inv;
  return v;
}

// Cosine for number[] — matches the current impl in src/lib/embed.ts.
function cosineArr(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Cosine for Float32Array. Same algorithm, but the JIT is more aggressive on
// typed arrays — no boxing, no `??` fallback, predictable memory layout.
function cosineF32(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// For very large N, store the corpus as ONE flat Float32Array (N*D long)
// instead of N separate vectors. Cache-friendly and avoids object overhead.
function cosineFlat(query, flatCorpus, d, n) {
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0, nb = 0;
    const off = i * d;
    for (let j = 0; j < d; j++) {
      const bj = flatCorpus[off + j];
      dot += query[j] * bj;
      nb += bj * bj;
    }
    scores[i] = dot / Math.sqrt(nb);  // query is unit, so we skip ||query||
  }
  return scores;
}

function benchArr(N, D) {
  const skills = new Array(N);
  for (let i = 0; i < N; i++) skills[i] = randomUnitArr(D);
  const query = randomUnitArr(D);
  const t0 = performance.now();
  const scored = new Array(N);
  for (let i = 0; i < N; i++) scored[i] = cosineArr(query, skills[i]);
  // Skip sort to isolate similarity cost; sorting is O(N log N) but tiny constant.
  const t1 = performance.now();
  return +(t1 - t0).toFixed(2);
}

function benchF32(N, D) {
  const skills = new Array(N);
  for (let i = 0; i < N; i++) skills[i] = randomUnitF32(D);
  const query = randomUnitF32(D);
  const t0 = performance.now();
  const scored = new Float32Array(N);
  for (let i = 0; i < N; i++) scored[i] = cosineF32(query, skills[i]);
  const t1 = performance.now();
  return +(t1 - t0).toFixed(2);
}

function benchFlat(N, D) {
  const flat = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    let n = 0;
    const off = i * D;
    for (let j = 0; j < D; j++) { flat[off + j] = Math.random() - 0.5; n += flat[off + j] ** 2; }
    const inv = 1 / Math.sqrt(n);
    for (let j = 0; j < D; j++) flat[off + j] *= inv;
  }
  const query = randomUnitF32(D);
  const t0 = performance.now();
  cosineFlat(query, flat, D, N);
  const t1 = performance.now();
  return +(t1 - t0).toFixed(2);
}

const median = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];

const dims = [384, 768];
const sizes = [100, 1_000, 10_000, 100_000];

for (const D of dims) {
  console.log(`\ndim=${D}\n` + "─".repeat(80));
  console.log(`${"N".padStart(8)}  ${"number[]".padStart(11)}  ${"Float32Array".padStart(13)}  ${"flat F32".padStart(11)}  speedup`);

  for (const N of sizes) {
    // Warm up.
    benchArr(Math.min(N, 1000), D);
    benchF32(Math.min(N, 1000), D);
    benchFlat(Math.min(N, 1000), D);

    const arr = median([benchArr(N, D), benchArr(N, D), benchArr(N, D)]);
    const f32 = median([benchF32(N, D), benchF32(N, D), benchF32(N, D)]);
    const flat = median([benchFlat(N, D), benchFlat(N, D), benchFlat(N, D)]);
    const speedup = +(arr / flat).toFixed(2);
    console.log(`${N.toString().padStart(8)}  ${arr.toFixed(2).padStart(8)} ms  ${f32.toFixed(2).padStart(10)} ms  ${flat.toFixed(2).padStart(8)} ms  ${speedup}x`);
  }
}

// Skip 1M because Node default heap dies on number[][] at that size.
// Run this separately with --max-old-space-size=4096 if needed.
console.log(`\nNote: 1M elided to fit Node default heap. The flat Float32Array variant
would handle 1M @ 384-d in ~1.5GB and run in ~1-3s on this machine; rerun with
--max-old-space-size=4096 to verify if you care about that scale.`);
