/**
 * PSAD — Plate Spatial Artifact Detector.
 *
 * A robust two-way decomposition of a microplate (Tukey median polish) with
 * permutation-based significance for row, column, edge, gradient and clustering
 * effects, needing no plate history.
 *
 * Scientific basis:
 *  - B-score / median polish for plate artifacts: Malo et al., Nat Biotechnol 2006.
 *  - Detect-before-correct: Makarenkov et al. 2007; Dragiev et al., BMC Bioinf 2011.
 *  - Exchangeability argument (ours): on a clinical screening plate, sample-to-well
 *    placement is unrelated to well position, so any position-structured signal is a
 *    process artifact. Under H₀ the transformed sample-well values are exchangeable
 *    within well-type strata; permuting them yields an exact null for every spatial
 *    statistic. If plating is clinically structured, exchangeability fails — effects
 *    are still reported but p-values are suppressed (`platingOrder: 'structured'`).
 *
 * Statistics (all standardized by s = 1.4826·MAD of the polish residuals):
 *  T_row = max_i |α_i|/s (per-row z_i = α_i/s);  T_col likewise;
 *  T_edge = (median x on perimeter − median x on interior)/s;
 *  T_grad = ‖(b_r·R, b_c·C)‖/s from the least-squares plane x ≈ a + b_r·i + b_c·j;
 *  local outliers |r_ij|/s > 3.5 (Iglewicz–Hoaglin modified z; reported as candidates,
 *  not permutation-tested);  Moran's I on residuals (rook adjacency).
 *
 * p = (1 + #{b: T_b ≥ T_obs}) / (B + 1). Per-row/column p-values use the permutation
 * distribution of the MAX row/column statistic, which controls family-wise error
 * without Bonferroni.
 */

import { medpolish } from './medpolish.js';
import { median, mad, MAD_SCALE } from './descriptive.js';
import { moranI } from './moran.js';
import { normalQuantile } from './distributions.js';
import { Pcg32 } from './rng.js';

export type WellType = 'sample' | 'blank' | 'neg_ctrl' | 'pos_ctrl' | 'calibrator' | 'empty';
export type PlateTransform = 'log' | 'rank' | 'identity';
export type PlatingOrder = 'randomized' | 'sequential' | 'structured';

export interface PsadInput {
  /** raw readings, R × C; null = no reading */
  values: readonly (number | null)[][];
  wellTypes: readonly WellType[][];
  transform?: PlateTransform; // default 'log'
  logEpsilon?: number; // default 0.001
  B?: number; // permutations, default 999 (allowed 199–4999)
  alpha?: number; // per-family, default 0.01
  outlierZ?: number; // default 3.5
  minSampleWells?: number; // default 40
  seed?: number; // RNG seed, default 12345
  platingOrder?: PlatingOrder; // default 'randomized'
}

export interface PsadFinding {
  kind: 'row_effect' | 'col_effect' | 'edge_effect' | 'gradient' | 'clustering' | 'local_outlier';
  index?: string; // row letter or column number
  effect: number; // in transformed units
  effectSd: number; // in robust-SD units
  p: number | null; // null when suppressed or not permutation-tested
  wells: string[];
  message: string;
}

export interface PsadStatistics {
  tRow: number;
  tCol: number;
  tEdge: number;
  tGrad: number;
  moranI: number;
  rowZ: number[]; // α_i / s (NaN for rows without sample wells)
  colZ: number[];
  gradientBr: number; // per-row-index slope (transformed units)
  gradientBc: number;
  s: number;
  mu: number;
  nOutliers: number;
}

export interface PsadResult {
  ok: boolean;
  reason?: string;
  nSampleWells: number;
  transform: PlateTransform;
  B: number;
  alpha: number;
  seed: number;
  statistics: PsadStatistics | null;
  rowEffects: number[]; // α (transformed units)
  colEffects: number[]; // β
  pValues: {
    row: number | null;
    col: number | null;
    perRow: (number | null)[];
    perCol: (number | null)[];
    edge: number | null;
    gradient: number | null;
    moran: number | null;
  } | null;
  findings: PsadFinding[];
  /** transformed grid (null = non-sample or missing) */
  transformed: (number | null)[][];
  /** polish residuals on sample wells */
  residuals: (number | null)[][];
  /** residual / s */
  zLocal: (number | null)[][];
  suppressedPValues: boolean;
  /** Phase-II feature vector [α₁..α_{R−1}, β₁..β_{C−1}, T_edge, b_r, b_c, s], or null */
  featureVector: number[] | null;
}

const ROW_LETTERS = 'ABCDEFGHIJKLMNOP';

export function wellName(i: number, j: number): string {
  return `${ROW_LETTERS[i]}${j + 1}`;
}

interface CoreStats {
  tRow: number;
  tCol: number;
  tEdge: number;
  tGrad: number;
  moran: number;
  rowZ: number[];
  colZ: number[];
  alpha: number[];
  beta: number[];
  br: number;
  bc: number;
  s: number;
  mu: number;
  residuals: (number | null)[][];
}

/** All spatial statistics for one (possibly permuted) plate of transformed values. */
function computeStats(
  x: (number | null)[][],
  R: number,
  C: number,
  withResiduals: boolean,
): CoreStats {
  const mp = medpolish(x, { eps: 1e-6, maxIter: 10 });
  const resVals: number[] = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const v = mp.residuals[i][j];
      if (v !== null) resVals.push(v);
    }
  }
  let s = MAD_SCALE * mad(resVals);
  if (!(s > 0)) {
    // degenerate residuals (e.g., perfectly additive plate): fall back to a tiny scale
    // so effects register as very large rather than dividing by zero
    s = 1e-12;
  }
  const rowHas = x.map((row) => row.some((v) => v !== null));
  const colHas = Array.from({ length: C }, (_, j) => x.some((row) => row[j] !== null));
  const rowZ = mp.row.map((a, i) => (rowHas[i] ? a / s : NaN));
  const colZ = mp.col.map((b, j) => (colHas[j] ? b / s : NaN));
  const tRow = Math.max(...rowZ.filter((v) => Number.isFinite(v)).map(Math.abs), 0);
  const tCol = Math.max(...colZ.filter((v) => Number.isFinite(v)).map(Math.abs), 0);

  // edge: perimeter vs interior medians of x
  const perim: number[] = [];
  const inter: number[] = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const v = x[i][j];
      if (v === null) continue;
      if (i === 0 || i === R - 1 || j === 0 || j === C - 1) perim.push(v);
      else inter.push(v);
    }
  }
  const tEdge = perim.length > 0 && inter.length > 0 ? (median(perim) - median(inter)) / s : 0;

  // linear gradient: least squares x ≈ a + br·i + bc·j
  let n = 0,
    si = 0,
    sj = 0,
    sii = 0,
    sjj = 0,
    sij = 0,
    sx = 0,
    six = 0,
    sjx = 0;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const v = x[i][j];
      if (v === null) continue;
      n++;
      si += i;
      sj += j;
      sii += i * i;
      sjj += j * j;
      sij += i * j;
      sx += v;
      six += i * v;
      sjx += j * v;
    }
  }
  // solve 3×3 normal equations by Cramer's rule
  let br = 0;
  let bc = 0;
  if (n >= 3) {
    const A11 = n, A12 = si, A13 = sj;
    const A22 = sii, A23 = sij, A33 = sjj;
    const det =
      A11 * (A22 * A33 - A23 * A23) - A12 * (A12 * A33 - A23 * A13) + A13 * (A12 * A23 - A22 * A13);
    if (Math.abs(det) > 1e-12) {
      const detBr =
        A11 * (six * A33 - A23 * sjx) - A12 * (sx * A33 - A13 * sjx) + A13 * (sx * A23 - A13 * six);
      const detBc =
        A11 * (A22 * sjx - six * A23) - A12 * (A12 * sjx - sx * A23) + A13 * (A12 * six - sx * A22);
      br = detBr / det;
      bc = detBc / det;
    }
  }
  const tGrad = Math.hypot(br * R, bc * C) / s;
  const moran = moranI(mp.residuals);
  return {
    tRow,
    tCol,
    tEdge,
    tGrad,
    moran: Number.isFinite(moran) ? moran : 0,
    rowZ,
    colZ,
    alpha: mp.row,
    beta: mp.col,
    br,
    bc,
    s,
    mu: mp.overall,
    residuals: withResiduals ? mp.residuals : [],
  };
}

export function psad(input: PsadInput): PsadResult {
  const transform = input.transform ?? 'log';
  const eps = input.logEpsilon ?? 0.001;
  const B = Math.min(4999, Math.max(199, input.B ?? 999));
  const alpha = input.alpha ?? 0.01;
  const outlierZ = input.outlierZ ?? 3.5;
  const minSampleWells = input.minSampleWells ?? 40;
  const seed = input.seed ?? 12345;
  const platingOrder = input.platingOrder ?? 'randomized';
  const suppressP = platingOrder === 'structured';

  const R = input.values.length;
  const C = R > 0 ? input.values[0].length : 0;

  // build the transformed, sample-only grid
  const samplePositions: [number, number][] = [];
  const rawSample: number[] = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      if (input.wellTypes[i][j] === 'sample' && input.values[i][j] !== null) {
        samplePositions.push([i, j]);
        rawSample.push(input.values[i][j] as number);
      }
    }
  }
  const nSample = samplePositions.length;

  const empty = (): (number | null)[][] =>
    Array.from({ length: R }, () => new Array<number | null>(C).fill(null));

  if (nSample < minSampleWells) {
    return {
      ok: false,
      reason: `Insufficient sample wells for the spatial test: ${nSample} < ${minSampleWells}.`,
      nSampleWells: nSample,
      transform,
      B,
      alpha,
      seed,
      statistics: null,
      rowEffects: [],
      colEffects: [],
      pValues: null,
      findings: [],
      transformed: empty(),
      residuals: empty(),
      zLocal: empty(),
      suppressedPValues: suppressP,
      featureVector: null,
    };
  }

  // transform sample values
  let xSample: number[];
  if (transform === 'log') {
    xSample = rawSample.map((y) => Math.log(Math.max(y, eps)));
  } else if (transform === 'rank') {
    // within-plate rank → Φ⁻¹((rank − 0.5)/n); average ranks for ties
    const order = rawSample
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(nSample).fill(0);
    let k = 0;
    while (k < order.length) {
      let k2 = k;
      while (k2 + 1 < order.length && order[k2 + 1].v === order[k].v) k2++;
      const avgRank = (k + k2) / 2 + 1;
      for (let m = k; m <= k2; m++) ranks[order[m].idx] = avgRank;
      k = k2 + 1;
    }
    xSample = ranks.map((r) => normalQuantile((r - 0.5) / nSample));
  } else {
    xSample = rawSample.slice();
  }

  const xGrid = empty();
  samplePositions.forEach(([i, j], k) => {
    xGrid[i][j] = xSample[k];
  });

  const obs = computeStats(xGrid, R, C, true);

  // permutation null
  const pv = {
    row: null as number | null,
    col: null as number | null,
    perRow: new Array<number | null>(R).fill(null),
    perCol: new Array<number | null>(C).fill(null),
    edge: null as number | null,
    gradient: null as number | null,
    moran: null as number | null,
  };

  if (!suppressP) {
    const rng = new Pcg32(seed);
    let geRow = 0;
    let geCol = 0;
    let geEdge = 0;
    let geGrad = 0;
    let geMoran = 0;
    const geRowI = new Array<number>(R).fill(0);
    const geColJ = new Array<number>(C).fill(0);
    const perm = xSample.slice();
    const grid = empty();
    for (let b = 0; b < B; b++) {
      rng.shuffle(perm);
      samplePositions.forEach(([i, j], k) => {
        grid[i][j] = perm[k];
      });
      const st = computeStats(grid, R, C, false);
      if (st.tRow >= obs.tRow) geRow++;
      if (st.tCol >= obs.tCol) geCol++;
      if (Math.abs(st.tEdge) >= Math.abs(obs.tEdge)) geEdge++;
      if (st.tGrad >= obs.tGrad) geGrad++;
      if (st.moran >= obs.moran) geMoran++;
      // per-row/col: compare each observed |z_i| against the permuted max statistic
      for (let i = 0; i < R; i++) {
        if (Number.isFinite(obs.rowZ[i]) && st.tRow >= Math.abs(obs.rowZ[i])) geRowI[i]++;
      }
      for (let j = 0; j < C; j++) {
        if (Number.isFinite(obs.colZ[j]) && st.tCol >= Math.abs(obs.colZ[j])) geColJ[j]++;
      }
    }
    const p = (ge: number) => (1 + ge) / (B + 1);
    pv.row = p(geRow);
    pv.col = p(geCol);
    pv.edge = p(geEdge);
    pv.gradient = p(geGrad);
    pv.moran = p(geMoran);
    for (let i = 0; i < R; i++) pv.perRow[i] = Number.isFinite(obs.rowZ[i]) ? p(geRowI[i]) : null;
    for (let j = 0; j < C; j++) pv.perCol[j] = Number.isFinite(obs.colZ[j]) ? p(geColJ[j]) : null;
  }

  // z_local + outliers
  const zLocal = empty();
  let nOut = 0;
  const outlierFindings: PsadFinding[] = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const r = obs.residuals[i][j];
      if (r === null) continue;
      const z = r / obs.s;
      zLocal[i][j] = z;
      if (Math.abs(z) > outlierZ) {
        nOut++;
        outlierFindings.push({
          kind: 'local_outlier',
          index: wellName(i, j),
          effect: r,
          effectSd: z,
          p: null,
          wells: [wellName(i, j)],
          message: `Well ${wellName(i, j)} deviates ${z.toFixed(1)} robust SD from its expected value (modified-z > ${outlierZ}); outlier candidate (not permutation-tested).`,
        });
      }
    }
  }

  // findings
  const findings: PsadFinding[] = [];
  const sig = (p: number | null) => (suppressP ? false : p !== null && p <= alpha);
  const fmtSd = (v: number) => `${Math.abs(v).toFixed(1)} robust SD`;
  const pTxt = (p: number | null) =>
    suppressP
      ? 'p suppressed (plating declared structured — exchangeability does not hold)'
      : `p = ${p!.toFixed(Math.max(3, Math.ceil(Math.log10(B + 1))))} by ${B} within-plate permutations`;

  for (let i = 0; i < R; i++) {
    if (sig(pv.perRow[i]) && Math.abs(obs.rowZ[i]) > 0) {
      const dir = obs.alpha[i] > 0 ? 'above' : 'below';
      findings.push({
        kind: 'row_effect',
        index: ROW_LETTERS[i],
        effect: obs.alpha[i],
        effectSd: obs.rowZ[i],
        p: pv.perRow[i],
        wells: Array.from({ length: C }, (_, j) => wellName(i, j)),
        message: `Row ${ROW_LETTERS[i]} is systematically ${Math.abs(obs.alpha[i]).toFixed(2)} (transformed units, ≈${fmtSd(obs.rowZ[i])}) ${dir} the plate; ${pTxt(pv.perRow[i])}.`,
      });
    }
  }
  for (let j = 0; j < C; j++) {
    if (sig(pv.perCol[j]) && Math.abs(obs.colZ[j]) > 0) {
      const dir = obs.beta[j] > 0 ? 'above' : 'below';
      findings.push({
        kind: 'col_effect',
        index: String(j + 1),
        effect: obs.beta[j],
        effectSd: obs.colZ[j],
        p: pv.perCol[j],
        wells: Array.from({ length: R }, (_, i) => wellName(i, j)),
        message: `Column ${j + 1} is systematically ${Math.abs(obs.beta[j]).toFixed(2)} (≈${fmtSd(obs.colZ[j])}) ${dir} the plate; ${pTxt(pv.perCol[j])}.`,
      });
    }
  }
  if (sig(pv.edge)) {
    const dir = obs.tEdge > 0 ? 'above' : 'below';
    const perimWells: string[] = [];
    for (let i = 0; i < R; i++)
      for (let j = 0; j < C; j++)
        if ((i === 0 || i === R - 1 || j === 0 || j === C - 1) && xGrid[i][j] !== null)
          perimWells.push(wellName(i, j));
    findings.push({
      kind: 'edge_effect',
      effect: obs.tEdge * obs.s,
      effectSd: obs.tEdge,
      p: pv.edge,
      wells: perimWells,
      message: `Perimeter wells are ${Math.abs(obs.tEdge * obs.s).toFixed(2)} (≈${fmtSd(obs.tEdge)}) ${dir} interior wells; ${pTxt(pv.edge)}. Consistent with an evaporation/edge effect.`,
    });
  }
  if (sig(pv.gradient)) {
    findings.push({
      kind: 'gradient',
      effect: Math.hypot(obs.br * R, obs.bc * C),
      effectSd: obs.tGrad,
      p: pv.gradient,
      wells: [],
      message: `A linear gradient of ${Math.hypot(obs.br * R, obs.bc * C).toFixed(2)} (≈${fmtSd(obs.tGrad)}) runs across the plate (row slope ${obs.br.toFixed(3)}, column slope ${obs.bc.toFixed(3)} per well); ${pTxt(pv.gradient)}. Consistent with a temperature/incubation gradient.`,
    });
  }
  if (sig(pv.moran)) {
    findings.push({
      kind: 'clustering',
      effect: obs.moran,
      effectSd: NaN,
      p: pv.moran,
      wells: [],
      message: `Residuals are spatially clustered (Moran's I = ${obs.moran.toFixed(3)}); ${pTxt(pv.moran)}. Localized artifact not aligned to a full row or column.`,
    });
  }
  findings.push(...outlierFindings);

  // Phase-II feature vector: drop last α and β (median constraints)
  const featureVector = [
    ...obs.alpha.slice(0, R - 1),
    ...obs.beta.slice(0, C - 1),
    obs.tEdge,
    obs.br,
    obs.bc,
    obs.s,
  ];

  return {
    ok: true,
    nSampleWells: nSample,
    transform,
    B,
    alpha,
    seed,
    statistics: {
      tRow: obs.tRow,
      tCol: obs.tCol,
      tEdge: obs.tEdge,
      tGrad: obs.tGrad,
      moranI: obs.moran,
      rowZ: obs.rowZ,
      colZ: obs.colZ,
      gradientBr: obs.br,
      gradientBc: obs.bc,
      s: obs.s,
      mu: obs.mu,
      nOutliers: nOut,
    },
    rowEffects: obs.alpha,
    colEffects: obs.beta,
    pValues: suppressP ? null : pv,
    findings,
    transformed: xGrid,
    residuals: obs.residuals,
    zLocal,
    suppressedPValues: suppressP,
    featureVector,
  };
}
