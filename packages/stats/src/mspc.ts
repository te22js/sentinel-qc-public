/**
 * PCA-based multivariate SPC (Phase II) over per-plate effect vectors.
 *
 * References: Hotelling (1947) T²; Jackson & Mudholkar, Technometrics 1979 (SPE/Q
 * residual statistic and its limit); Kourti & MacGregor, J Qual Technol 1996
 * (T² on retained scores + SPE on residuals, contribution plots).
 *
 * Phase I: center/scale training vectors, PCA of the covariance, retain A components by
 * cumulative variance ≥ 80% (capped at 6).
 * Phase II, new observation v:
 *   t = Pᵀ v_scaled,  T² = Σ_a t_a²/λ_a,
 *   UCL_T² = A(n−1)(n+1) / (n(n−A)) · F_{1−α; A, n−A}         (Phase-II F limit)
 *   SPE = ‖v_scaled − P t‖²,  UCL_SPE by Jackson–Mudholkar.
 * Contribution of variable k to SPE is e_k² (squared residual element).
 */

import { covarianceMatrix, jacobiEigen } from './pca.js';
import { fQuantile, normalQuantile } from './distributions.js';

export interface Phase2Model {
  n: number;
  dim: number;
  means: number[];
  scales: number[];
  /** loadings: dim × A (columns = retained components) */
  loadings: number[][];
  /** retained eigenvalues, length A */
  eigenvalues: number[];
  /** all eigenvalues (descending) for reference */
  allEigenvalues: number[];
  aComponents: number;
  varExplained: number;
  t2Ucl: number;
  speUcl: number;
  alpha: number;
}

export interface Phase2Score {
  t2: number;
  spe: number;
  t2Signal: boolean;
  speSignal: boolean;
  scores: number[];
  /** per-variable squared residuals (SPE contributions) */
  speContributions: number[];
  /** per-variable contribution to T² (score-weighted loadings decomposition) */
  t2Contributions: number[];
}

export function buildPhase2Model(
  X: readonly number[][],
  opts: { alpha?: number; varTarget?: number; maxComponents?: number } = {},
): Phase2Model {
  const alpha = opts.alpha ?? 0.01;
  const varTarget = opts.varTarget ?? 0.8;
  const maxA = opts.maxComponents ?? 6;
  const n = X.length;
  const dim = X[0].length;
  if (n < dim + 2) {
    // T² F-limit needs n > A; PCA needs a well-conditioned covariance. Callers gate on
    // n ≥ 30 plates; this is a hard floor.
    if (n < 8) throw new Error(`Phase II model requires more history (n=${n})`);
  }
  const means = new Array(dim).fill(0);
  for (const row of X) for (let j = 0; j < dim; j++) means[j] += row[j];
  for (let j = 0; j < dim; j++) means[j] /= n;
  const scales = new Array(dim).fill(0);
  for (const row of X) for (let j = 0; j < dim; j++) scales[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < dim; j++) {
    scales[j] = Math.sqrt(scales[j] / (n - 1));
    if (!(scales[j] > 0)) scales[j] = 1; // constant variable: leave centered only
  }
  const Xs = X.map((row) => row.map((v, j) => (v - means[j]) / scales[j]));
  const S = covarianceMatrix(Xs);
  const eig = jacobiEigen(S);
  const values = eig.values.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0);
  let a = 0;
  let cum = 0;
  while (a < values.length && (cum / total < varTarget || a === 0)) {
    cum += values[a];
    a++;
    if (a >= maxA) break;
  }
  const A = a;
  const loadings = eig.vectors.map((row) => row.slice(0, A)); // dim × A
  const eigenvalues = values.slice(0, A);
  const t2Ucl =
    ((A * (n - 1) * (n + 1)) / (n * (n - A))) * fQuantile(1 - alpha, A, n - A);
  // Jackson–Mudholkar SPE limit from residual eigenvalues
  const resid = values.slice(A);
  const th1 = resid.reduce((s, v) => s + v, 0);
  const th2 = resid.reduce((s, v) => s + v * v, 0);
  const th3 = resid.reduce((s, v) => s + v * v * v, 0);
  let speUcl: number;
  if (th1 <= 0 || th2 <= 0) {
    speUcl = 0;
  } else {
    const h0raw = 1 - (2 * th1 * th3) / (3 * th2 * th2);
    const h0 = h0raw <= 0 ? 1e-3 : h0raw;
    const za = normalQuantile(1 - alpha);
    const inner =
      (za * Math.sqrt(2 * th2 * h0 * h0)) / th1 + 1 + (th2 * h0 * (h0 - 1)) / (th1 * th1);
    speUcl = th1 * Math.pow(Math.max(inner, 0), 1 / h0);
  }
  return {
    n,
    dim,
    means,
    scales,
    loadings,
    eigenvalues,
    allEigenvalues: values,
    aComponents: A,
    varExplained: total > 0 ? cum / total : 0,
    t2Ucl,
    speUcl,
    alpha,
  };
}

export function scorePhase2(model: Phase2Model, v: readonly number[]): Phase2Score {
  const { dim, means, scales, loadings, eigenvalues, aComponents: A } = model;
  if (v.length !== dim) throw new Error(`vector length ${v.length} != model dim ${dim}`);
  const vs = v.map((x, j) => (x - means[j]) / scales[j]);
  const scores = new Array(A).fill(0);
  for (let k = 0; k < A; k++) {
    let s = 0;
    for (let j = 0; j < dim; j++) s += loadings[j][k] * vs[j];
    scores[k] = s;
  }
  let t2 = 0;
  for (let k = 0; k < A; k++) t2 += (scores[k] * scores[k]) / Math.max(eigenvalues[k], 1e-12);
  const recon = new Array(dim).fill(0);
  for (let j = 0; j < dim; j++) {
    for (let k = 0; k < A; k++) recon[j] += loadings[j][k] * scores[k];
  }
  const speContributions = vs.map((x, j) => (x - recon[j]) ** 2);
  const spe = speContributions.reduce((a, b) => a + b, 0);
  // T² contribution: sum over components of (t_a/λ_a)·p_ja·v_j (Kourti–MacGregor style)
  const t2Contributions = new Array(dim).fill(0);
  for (let j = 0; j < dim; j++) {
    let c = 0;
    for (let k = 0; k < A; k++) {
      c += (scores[k] / Math.max(eigenvalues[k], 1e-12)) * loadings[j][k] * vs[j];
    }
    t2Contributions[j] = c;
  }
  return {
    t2,
    spe,
    t2Signal: t2 > model.t2Ucl,
    speSignal: model.speUcl > 0 && spe > model.speUcl,
    scores,
    speContributions,
    t2Contributions,
  };
}
