/**
 * Phase-I baseline establishment (CLSI C24-Ed4; Montgomery ch. 6 "Phase I").
 *
 * Classical: mean / sample SD with iterative |z| > 3 outlier exclusion, at most
 * MAX_PASSES = 2 passes; excluded observation ids are recorded and must be confirmed
 * by the user before freezing.
 * Robust option: median / 1.4826·MAD (both are always reported).
 *
 * Rules enforced here (spec §6.2):
 *  - n ≥ 20 for a full baseline; 10 ≤ n < 20 allowed with a "provisional" flag;
 *    n < 10 is refused.
 *  - σ = 0 is refused (degenerate data cannot set control limits).
 * Frozen baselines are immutable; re-baselining creates a new record (db layer).
 */

import { mean, sd, median, robustSd } from './descriptive.js';

export interface BaselineInput {
  /** parallel arrays: transformed values and their observation ids */
  values: number[];
  ids: string[];
  /** minimum n for a non-provisional baseline (default 20) */
  minN?: number;
  /** absolute minimum n (default 10) */
  hardMinN?: number;
  /** |z| threshold for outlier exclusion (default 3) */
  outlierZ?: number;
  /** maximum exclusion passes (default 2) */
  maxPasses?: number;
}

export interface BaselineResult {
  ok: true;
  n: number;
  mean: number;
  sd: number;
  robustMean: number; // median
  robustSd: number; // 1.4826 · MAD
  excludedIds: string[];
  provisional: boolean;
  passes: number;
}

export interface BaselineRefusal {
  ok: false;
  reason: 'too_few_observations' | 'zero_sd';
  message: string;
}

const MAX_PASSES = 2;

export function computeBaseline(input: BaselineInput): BaselineResult | BaselineRefusal {
  const minN = input.minN ?? 20;
  const hardMinN = input.hardMinN ?? 10;
  const outlierZ = input.outlierZ ?? 3;
  const maxPasses = input.maxPasses ?? MAX_PASSES;
  if (input.values.length !== input.ids.length) {
    throw new Error('values and ids must be parallel arrays');
  }

  let keptValues = input.values.slice();
  let keptIds = input.ids.slice();
  const excludedIds: string[] = [];
  let passes = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    if (keptValues.length < hardMinN) break;
    const m = mean(keptValues);
    const s = sd(keptValues);
    if (!(s > 0)) break;
    const keepV: number[] = [];
    const keepI: string[] = [];
    let excludedThisPass = 0;
    for (let i = 0; i < keptValues.length; i++) {
      const z = (keptValues[i] - m) / s;
      if (Math.abs(z) > outlierZ) {
        excludedIds.push(keptIds[i]);
        excludedThisPass++;
      } else {
        keepV.push(keptValues[i]);
        keepI.push(keptIds[i]);
      }
    }
    if (excludedThisPass === 0) break;
    passes = pass + 1;
    keptValues = keepV;
    keptIds = keepI;
  }

  const n = keptValues.length;
  if (n < hardMinN) {
    return {
      ok: false,
      reason: 'too_few_observations',
      message: `Only ${n} observations after exclusions; at least ${hardMinN} are required.`,
    };
  }
  const s = sd(keptValues);
  if (!(s > 0)) {
    return {
      ok: false,
      reason: 'zero_sd',
      message: 'Standard deviation is zero; a baseline cannot be frozen from degenerate data.',
    };
  }
  return {
    ok: true,
    n,
    mean: mean(keptValues),
    sd: s,
    robustMean: median(keptValues),
    robustSd: robustSd(keptValues),
    excludedIds,
    provisional: n < minN,
    passes,
  };
}
