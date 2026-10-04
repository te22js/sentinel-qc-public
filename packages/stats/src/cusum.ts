/**
 * Two-sided tabular CUSUM on standardized values.
 *
 * References: Page, Biometrika 1954; Westgard, Groth, Aronsson, de Verdier,
 * Clin Chem 1977 (Shewhart–CUSUM for clinical labs); Montgomery, Introduction to
 * Statistical Quality Control (tabular form, ARL tables, FIR).
 *
 * C⁺_t = max(0, C⁺_{t−1} + z_t − k),  C⁻_t = max(0, C⁻_{t−1} − z_t − k).
 * Signal when C⁺ > h or C⁻ > h. Defaults k = 0.5, h = 5 (ARL0 ≈ 465); h = 4 offered
 * (ARL0 ≈ 168). FIR head-start C₀ = h/2 optional.
 *
 * Change-onset estimate: the last index at which the signalling sum was zero
 * (Montgomery §9.1.2). Shift estimate: k + C/N, N = points since onset.
 * After a signal the signalling side resets to 0 (configurable).
 */

export interface CusumOptions {
  k?: number; // default 0.5
  h?: number; // default 5
  fir?: boolean; // head-start h/2, default false
  resetOnSignal?: boolean; // default true
}

export interface CusumPoint {
  t: number;
  z: number;
  cPlus: number;
  cMinus: number;
  signal: 'none' | 'up' | 'down';
  /** points since the signalling sum last left zero (only set on a signal point) */
  nSinceOnset?: number;
  /** estimated onset index (1-based, first point after the last zero) */
  onset?: number;
  /** estimated shift magnitude in SD units, signed */
  shiftEstimate?: number;
}

export interface CusumResult {
  points: CusumPoint[];
  firstSignal: number | null;
  k: number;
  h: number;
}

export function cusum(zs: readonly number[], opts: CusumOptions = {}): CusumResult {
  const k = opts.k ?? 0.5;
  const h = opts.h ?? 5;
  const fir = opts.fir ?? false;
  const resetOnSignal = opts.resetOnSignal ?? true;
  let cPlus = fir ? h / 2 : 0;
  let cMinus = fir ? h / 2 : 0;
  // index of the last time each sum was at zero (0 = before the series)
  let lastZeroPlus = 0;
  let lastZeroMinus = 0;
  const points: CusumPoint[] = [];
  let firstSignal: number | null = null;
  for (let i = 0; i < zs.length; i++) {
    const t = i + 1;
    cPlus = Math.max(0, cPlus + zs[i] - k);
    cMinus = Math.max(0, cMinus - zs[i] - k);
    const p: CusumPoint = { t, z: zs[i], cPlus, cMinus, signal: 'none' };
    if (cPlus > h) {
      p.signal = 'up';
      const n = t - lastZeroPlus;
      p.nSinceOnset = n;
      p.onset = lastZeroPlus + 1;
      p.shiftEstimate = k + cPlus / n;
      if (resetOnSignal) {
        cPlus = 0;
        lastZeroPlus = t;
      }
    } else if (cMinus > h) {
      p.signal = 'down';
      const n = t - lastZeroMinus;
      p.nSinceOnset = n;
      p.onset = lastZeroMinus + 1;
      p.shiftEstimate = -(k + cMinus / n);
      if (resetOnSignal) {
        cMinus = 0;
        lastZeroMinus = t;
      }
    }
    if (cPlus === 0) lastZeroPlus = t;
    if (cMinus === 0) lastZeroMinus = t;
    points.push(p);
    if (p.signal !== 'none' && firstSignal === null) firstSignal = t;
  }
  return { points, firstSignal, k, h };
}
