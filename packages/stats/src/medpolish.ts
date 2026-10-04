/**
 * Tukey median polish for a two-way table, with support for missing cells (masks).
 *
 * Reference: Tukey, Exploratory Data Analysis (1977); the algorithm and stopping rule
 * match R's stats::medpolish (iterate row sweeps and column sweeps; after each column
 * sweep move the median of the row effects into the overall effect and vice versa;
 * stop when the decrease in Σ|r| is below eps · Σ|r| or maxiter is reached).
 *
 * Model: x_ij = μ + α_i + β_j + r_ij with median(α) = median(β) = 0.
 */

import { median } from './descriptive.js';

export interface MedpolishResult {
  overall: number; // μ
  row: number[]; // α, length R (NaN for rows with no data)
  col: number[]; // β, length C
  residuals: (number | null)[][]; // r, null where input was null
  iterations: number;
  converged: boolean;
}

export function medpolish(
  data: readonly (number | null)[][],
  opts: { eps?: number; maxIter?: number } = {},
): MedpolishResult {
  const eps = opts.eps ?? 1e-6;
  const maxIter = opts.maxIter ?? 10;
  const R = data.length;
  const C = R > 0 ? data[0].length : 0;
  const r: (number | null)[][] = data.map((row) => row.slice());
  const alpha = new Array<number>(R).fill(0);
  const beta = new Array<number>(C).fill(0);
  let overall = 0;

  const rowValues = (i: number): number[] =>
    (r[i].filter((v) => v !== null) as number[]);
  const colValues = (j: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < R; i++) {
      const v = r[i][j];
      if (v !== null) out.push(v);
    }
    return out;
  };
  const sumAbs = (): number => {
    let s = 0;
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < C; j++) {
        const v = r[i][j];
        if (v !== null) s += Math.abs(v);
      }
    }
    return s;
  };

  let oldSum = 0;
  let converged = false;
  let iter = 0;
  for (iter = 1; iter <= maxIter; iter++) {
    // row sweep
    for (let i = 0; i < R; i++) {
      const vals = rowValues(i);
      if (vals.length === 0) continue;
      const m = median(vals);
      alpha[i] += m;
      for (let j = 0; j < C; j++) if (r[i][j] !== null) r[i][j] = (r[i][j] as number) - m;
    }
    // move median of column effects into overall
    const mBeta = median(beta.filter((v) => Number.isFinite(v)));
    overall += mBeta;
    for (let j = 0; j < C; j++) beta[j] -= mBeta;
    // column sweep
    for (let j = 0; j < C; j++) {
      const vals = colValues(j);
      if (vals.length === 0) continue;
      const m = median(vals);
      beta[j] += m;
      for (let i = 0; i < R; i++) if (r[i][j] !== null) r[i][j] = (r[i][j] as number) - m;
    }
    // move median of row effects into overall
    const mAlpha = median(alpha.filter((v) => Number.isFinite(v)));
    overall += mAlpha;
    for (let i = 0; i < R; i++) alpha[i] -= mAlpha;

    const newSum = sumAbs();
    if (newSum === 0 || (iter > 1 && Math.abs(newSum - oldSum) < eps * newSum)) {
      converged = true;
      oldSum = newSum;
      break;
    }
    oldSum = newSum;
  }
  return { overall, row: alpha, col: beta, residuals: r, iterations: Math.min(iter, maxIter), converged };
}
