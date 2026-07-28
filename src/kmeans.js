/**
 * k-means for sparse-ish dense vectors, with cosine distance.
 *  - k-means++ seeding (deterministic via a seeded PRNG so repeat scans agree)
 *  - k chosen automatically by mean silhouette score over a candidate range
 * Pure JS, no dependencies.
 */

/** Mulberry32 — small deterministic PRNG so a rescan gives the same clusters. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L2-normalise in place so cosine distance reduces to 1 - dot. */
export function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine distance in [0, 2]; inputs must already be L2-normalised. */
function cosineDistance(a, b) {
  return 1 - dot(a, b);
}

/** k-means++ seeding: spread initial centroids out by squared distance. */
function seedCentroids(vectors, k, rng) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const centroids = [];
  const first = Math.floor(rng() * n);
  centroids.push(Float64Array.from(vectors[first]));

  const closest = new Float64Array(n).fill(Infinity);

  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = cosineDistance(vectors[i], latest);
      if (d < closest[i]) closest[i] = d;
      total += closest[i] * closest[i];
    }
    if (total === 0) {
      // All remaining points coincide with a centroid — pad and stop.
      const pad = new Float64Array(dim);
      pad[0] = 1;
      centroids.push(pad);
      continue;
    }
    let target = rng() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= closest[i] * closest[i];
      if (target <= 0) { chosen = i; break; }
    }
    centroids.push(Float64Array.from(vectors[chosen]));
  }
  return centroids;
}

/**
 * Run Lloyd's algorithm with cosine distance.
 * @returns {{assignments:Int32Array, centroids:Float64Array[], inertia:number}}
 */
export function kmeans(vectors, k, { maxIter = 60, seed = 42 } = {}) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const rng = makeRng(seed);
  let centroids = seedCentroids(vectors, k, rng);
  const assignments = new Int32Array(n).fill(-1);
  let inertia = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    inertia = 0;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = cosineDistance(vectors[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      inertia += bestDist * bestDist;
      if (assignments[i] !== best) { assignments[i] = best; moved++; }
    }

    const next = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      const t = next[c];
      for (let d = 0; d < dim; d++) t[d] += v[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // Empty cluster — reseed it on the point furthest from its centroid.
        let worst = 0;
        let worstDist = -1;
        for (let i = 0; i < n; i++) {
          const d = cosineDistance(vectors[i], centroids[assignments[i]]);
          if (d > worstDist) { worstDist = d; worst = i; }
        }
        next[c] = Float64Array.from(vectors[worst]);
      }
      l2Normalize(next[c]);
    }
    centroids = next;

    if (moved === 0) break;
  }

  return { assignments, centroids, inertia };
}

/**
 * Mean silhouette score over all points. Uses a precomputed distance matrix,
 * so keep n modest (we cap the clustered keyword set at a few hundred).
 */
export function silhouette(vectors, assignments, k) {
  const n = vectors.length;
  if (k < 2 || n <= k) return -1;

  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) counts[assignments[i]]++;
  for (let c = 0; c < k; c++) if (counts[c] === 0) return -1;

  // Sum of distances from each point to every cluster.
  const sums = Array.from({ length: n }, () => new Float64Array(k));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(vectors[i], vectors[j]);
      sums[i][assignments[j]] += d;
      sums[j][assignments[i]] += d;
    }
  }

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i];
    const a = counts[own] > 1 ? sums[i][own] / (counts[own] - 1) : 0;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || counts[c] === 0) continue;
      const mean = sums[i][c] / counts[c];
      if (mean < b) b = mean;
    }
    if (!isFinite(b)) continue;
    const denom = Math.max(a, b);
    total += denom === 0 ? 0 : (b - a) / denom;
  }
  return total / n;
}

/**
 * Try every k in [kMin, kMax] and keep the partition with the best mean
 * silhouette. This is what picks "how many topic groups does this niche have"
 * instead of us hard-coding a number.
 */
export function autoCluster(vectors, { kMin = 2, kMax = 8, seed = 42, penalizeSingletons = false } = {}) {
  const n = vectors.length;
  if (n === 0) return { assignments: new Int32Array(0), k: 0, score: -1, centroids: [], scores: [] };
  if (n < 4) {
    return {
      assignments: new Int32Array(n).fill(0),
      k: 1,
      score: -1,
      centroids: [l2Normalize(Float64Array.from(vectors[0]))],
      scores: [],
    };
  }

  const upper = Math.max(kMin, Math.min(kMax, Math.floor(n / 3)));
  let best = null;
  const scores = [];

  for (let k = kMin; k <= upper; k++) {
    const run = kmeans(vectors, k, { seed });
    const score = silhouette(vectors, run.assignments, k);

    // A partition full of one-item clusters can score well on silhouette while
    // being useless to read. Discount it in proportion to how many there are.
    let ranked = score;
    if (penalizeSingletons) {
      const sizes = new Int32Array(k);
      for (const c of run.assignments) sizes[c]++;
      const singletons = Array.from(sizes).filter((s) => s < 2).length;
      ranked -= (singletons / k) * 0.35;
    }

    scores.push({ k, score, ranked, inertia: run.inertia });
    if (!best || ranked > best.ranked) best = { ...run, k, score, ranked };
  }

  if (!best) {
    const run = kmeans(vectors, kMin, { seed });
    best = { ...run, k: kMin, score: -1, ranked: -1 };
  }
  return { ...best, scores };
}
