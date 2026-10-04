/**
 * Descriptive and robust statistics.
 *
 * mean / sd: two-pass (numerically stable for lab-scale n).
 * sd uses the n−1 (sample) denominator throughout, matching CLSI C24 practice.
 * median: midpoint of sorted order statistics.
 * MAD: median(|x − median(x)|); robustSd = 1.4826 · MAD, the consistency-scaled MAD
 *   for the normal distribution (matches SciPy `median_abs_deviation(scale='normal')`
 *   up to its constant 1/Φ⁻¹(3/4) = 1.482602218505602).
 */

export const MAD_SCALE = 1.4826022185056018;

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n−1 denominator). */
export function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / (n - 1);
}

export function sd(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

export function cv(xs: readonly number[]): number {
  const m = mean(xs);
  return m === 0 ? NaN : (sd(xs) / Math.abs(m)) * 100;
}

export function median(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const s = Array.from(xs).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** 1.4826 · MAD — robust estimate of the normal SD. */
export function robustSd(xs: readonly number[]): number {
  return MAD_SCALE * mad(xs);
}

/** Linear-interpolation quantile, matching numpy's default (linear) method. q in [0,1]. */
export function quantile(xs: readonly number[], q: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const s = Array.from(xs).sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[n - 1];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
