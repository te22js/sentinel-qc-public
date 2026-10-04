/**
 * PELT offline change-point detection with L2 (mean-shift) cost.
 *
 * Reference: Killick, Fearnhead, Eckley. "Optimal detection of changepoints with a
 * linear computational cost." JASA 2012;107:1590–1598.
 *
 * Cost of a segment y_{s+1..t}: C(s,t) = Σ y² − (Σ y)²/(t−s)   (L2 / negative
 * log-likelihood up to constants for a Gaussian mean-change with known variance).
 * Objective: minimize Σ_segments C + β·(#changepoints). Default penalty β = c·log n with
 * c = 3 (BIC-like; the series is standardized so σ² ≈ 1). Minimum segment length 5.
 */

export interface PeltOptions {
  /** penalty multiplier c in β = c·log n (default 3) */
  penaltyC?: number;
  /** explicit penalty β (overrides penaltyC) */
  beta?: number;
  /** minimum segment length (default 5) */
  minSegment?: number;
}

export interface PeltSegment {
  /** 0-based start index (inclusive) */
  start: number;
  /** 0-based end index (exclusive) */
  end: number;
  mean: number;
}

export interface PeltResult {
  /** 0-based indices at which a new segment starts (excluding 0) */
  changePoints: number[];
  segments: PeltSegment[];
  beta: number;
}

export function pelt(ys: readonly number[], opts: PeltOptions = {}): PeltResult {
  const n = ys.length;
  const minSeg = opts.minSegment ?? 5;
  const beta = opts.beta ?? (opts.penaltyC ?? 3) * Math.log(Math.max(n, 2));
  if (n < 2 * minSeg) {
    return {
      changePoints: [],
      segments: n > 0 ? [{ start: 0, end: n, mean: ys.reduce((a, b) => a + b, 0) / n }] : [],
      beta,
    };
  }
  // prefix sums for O(1) segment cost
  const S = new Float64Array(n + 1);
  const S2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    S[i + 1] = S[i] + ys[i];
    S2[i + 1] = S2[i] + ys[i] * ys[i];
  }
  const segCost = (s: number, t: number): number => {
    const len = t - s;
    const sum = S[t] - S[s];
    return S2[t] - S2[s] - (sum * sum) / len;
  };

  const F = new Float64Array(n + 1).fill(Infinity);
  F[0] = -beta;
  const prev = new Int32Array(n + 1).fill(-1);
  let candidates: number[] = [0];

  for (let t = minSeg; t <= n; t++) {
    let best = Infinity;
    let bestS = -1;
    for (const s of candidates) {
      if (t - s < minSeg) continue;
      const c = F[s] + segCost(s, t) + beta;
      if (c < best) {
        best = c;
        bestS = s;
      }
    }
    F[t] = best;
    prev[t] = bestS;
    // PELT pruning: drop evaluable s with F[s] + C(s,t) > F[t]
    candidates = candidates.filter((s) => t - s < minSeg || F[s] + segCost(s, t) <= F[t]);
    // t becomes a candidate last-change-point for future times t' ≥ t + minSeg
    candidates.push(t);
  }

  // backtrack
  const cps: number[] = [];
  let t = n;
  while (t > 0) {
    const s = prev[t];
    if (s > 0) cps.push(s);
    t = s;
  }
  cps.reverse();

  const bounds = [0, ...cps, n];
  const segments: PeltSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    segments.push({ start: a, end: b, mean: (S[b] - S[a]) / (b - a) });
  }
  return { changePoints: cps, segments, beta };
}
