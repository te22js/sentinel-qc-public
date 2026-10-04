/**
 * Lot-transition comparison: period A (old lot) vs period B (new lot), on the assay's
 * transformed scale.
 *
 * - Welch t-test on means (unequal variances; Welch–Satterthwaite df), matching
 *   SciPy `ttest_ind(equal_var=False)`.
 * - F-test on variances (two-sided; F = s_A²/s_B²).
 * - Brown–Forsythe / Levene test with median centering, matching SciPy
 *   `levene(center='median')`.
 * - bias% = (mean_B − mean_A)/mean_A with a CI from the Welch CI of the mean difference.
 *
 * This module implements a control-material parallel comparison. It is NOT CLSI EP26
 * (patient-sample lot verification), which is out of scope by design.
 */

import { mean, variance, median } from './descriptive.js';
import { tCdf, tQuantile, fCdf } from './distributions.js';

export interface WelchResult {
  t: number;
  df: number;
  p: number; // two-sided
  meanA: number;
  meanB: number;
  diff: number; // meanB − meanA
  ciLow: number; // CI of diff at the given level
  ciHigh: number;
}

export function welchT(a: readonly number[], b: readonly number[], ciLevel = 0.95): WelchResult {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) throw new Error('welchT requires at least 2 observations per group');
  const mA = mean(a);
  const mB = mean(b);
  const vA = variance(a);
  const vB = variance(b);
  const se2 = vA / nA + vB / nB;
  const se = Math.sqrt(se2);
  const t = (mA - mB) / se;
  const df = (se2 * se2) / ((vA / nA) ** 2 / (nA - 1) + (vB / nB) ** 2 / (nB - 1));
  const p = 2 * (1 - tCdf(Math.abs(t), df));
  const tCrit = tQuantile(1 - (1 - ciLevel) / 2, df);
  const diff = mB - mA;
  return { t, df, p, meanA: mA, meanB: mB, diff, ciLow: diff - tCrit * se, ciHigh: diff + tCrit * se };
}

export interface FTestResult {
  f: number; // s_A² / s_B²
  dfA: number;
  dfB: number;
  p: number; // two-sided
}

export function fTestVariances(a: readonly number[], b: readonly number[]): FTestResult {
  const vA = variance(a);
  const vB = variance(b);
  const f = vA / vB;
  const dfA = a.length - 1;
  const dfB = b.length - 1;
  const cdf = fCdf(f, dfA, dfB);
  const p = 2 * Math.min(cdf, 1 - cdf);
  return { f, dfA, dfB, p: Math.min(1, p) };
}

export interface LeveneResult {
  w: number;
  p: number;
}

/** Brown–Forsythe (Levene with median centering), two groups. */
export function leveneMedian(a: readonly number[], b: readonly number[]): LeveneResult {
  const groups = [a, b];
  const k = 2;
  const n = a.length + b.length;
  const zGroups = groups.map((g) => {
    const c = median(g);
    return g.map((x) => Math.abs(x - c));
  });
  const zMeans = zGroups.map((z) => mean(z));
  const zAll = zGroups.flat();
  const zBar = mean(zAll);
  let num = 0;
  for (let i = 0; i < k; i++) num += zGroups[i].length * (zMeans[i] - zBar) ** 2;
  num *= n - k;
  let den = 0;
  for (let i = 0; i < k; i++) {
    for (const z of zGroups[i]) den += (z - zMeans[i]) ** 2;
  }
  den *= k - 1;
  const w = num / den;
  const p = 1 - fCdf(w, k - 1, n - k);
  return { w, p };
}

export type LotRecommendation =
  | 'accept_rebaseline_mean'
  | 'accept_no_change'
  | 'investigate_bias'
  | 'investigate_precision';

export interface LotComparison {
  nA: number;
  nB: number;
  welch: WelchResult;
  fTest: FTestResult;
  levene: LeveneResult;
  biasPct: number;
  biasCiLowPct: number;
  biasCiHighPct: number;
  allowableBiasPct: number | null;
  recommendation: LotRecommendation;
  message: string;
}

/**
 * Full lot-transition comparison with a plain-language verdict. Never claims
 * compliance; the output is advisory.
 */
export function compareLots(
  a: readonly number[],
  b: readonly number[],
  allowableBiasPct: number | null = null,
): LotComparison {
  const welch = welchT(a, b);
  const fTest = fTestVariances(a, b);
  const levene = leveneMedian(a, b);
  const biasPct = welch.meanA !== 0 ? (welch.diff / Math.abs(welch.meanA)) * 100 : NaN;
  const biasCiLowPct = welch.meanA !== 0 ? (welch.ciLow / Math.abs(welch.meanA)) * 100 : NaN;
  const biasCiHighPct = welch.meanA !== 0 ? (welch.ciHigh / Math.abs(welch.meanA)) * 100 : NaN;

  const sdChanged = levene.p < 0.05;
  const meanShifted = welch.p < 0.05;
  const biasWithin =
    allowableBiasPct === null ? null : Math.abs(biasPct) <= allowableBiasPct;

  let recommendation: LotRecommendation;
  const parts: string[] = [];
  parts.push(
    `Mean shift ${biasPct >= 0 ? '+' : ''}${biasPct.toFixed(1)}% (95% CI ${biasCiLowPct.toFixed(1)}% to ${biasCiHighPct.toFixed(1)}%)` +
      (allowableBiasPct !== null
        ? ` ${biasWithin ? 'is within' : 'EXCEEDS'} allowable bias ${allowableBiasPct}%.`
        : '.'),
  );
  parts.push(
    sdChanged
      ? `Imprecision changed (Levene p = ${levene.p.toFixed(3)}, F = ${fTest.f.toFixed(2)}).`
      : `SD unchanged (F = ${fTest.f.toFixed(2)}, Levene p = ${levene.p.toFixed(2)}).`,
  );
  if (sdChanged) {
    recommendation = 'investigate_precision';
    parts.push('Investigate precision before accepting the new lot.');
  } else if (biasWithin === false) {
    recommendation = 'investigate_bias';
    parts.push('Bias exceeds the allowable limit — investigate before accepting the new lot.');
  } else if (meanShifted) {
    recommendation = 'accept_rebaseline_mean';
    parts.push('Re-baseline recommended: establish a new mean for the new lot, retain the SD.');
  } else {
    recommendation = 'accept_no_change';
    parts.push('No meaningful change detected; the existing baseline may be retained.');
  }
  return {
    nA: a.length,
    nB: b.length,
    welch,
    fTest,
    levene,
    biasPct,
    biasCiLowPct,
    biasCiHighPct,
    allowableBiasPct,
    recommendation,
    message: parts.join(' '),
  };
}
