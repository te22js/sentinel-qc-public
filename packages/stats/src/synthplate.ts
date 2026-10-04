/**
 * Synthetic ELISA plate generator for validation, experiments and demo data.
 *
 * A realistic screening plate: mostly negative patient samples with OD distributed
 * log-normally near the kit cutoff, a minority of positives at 5–20× signal, plus a
 * standard control column (blank, 2 × negative control, 2 × positive control).
 * Faults are injected multiplicatively in OD (additively in log-OD), which is how
 * dispensing/evaporation/incubation artifacts act physically.
 */

import { Pcg32 } from './rng.js';
import type { WellType } from './psad.js';

export interface SynthPlateOptions {
  rows?: number; // default 8
  cols?: number; // default 12
  /** fraction of sample wells that are positive (default 0.1) */
  prevalence?: number;
  /** median OD of negatives (default 0.08) */
  negMedianOd?: number;
  /** log-scale SD of negatives (default 0.35) */
  negSigma?: number;
  /** median OD of positives (default 1.2) */
  posMedianOd?: number;
  posSigma?: number; // default 0.5
}

export interface SynthPlate {
  values: (number | null)[][];
  wellTypes: WellType[][];
  /** true where the sample well is a positive */
  isPositive: boolean[][];
}

/** Standard layout: A1 blank, B1/C1 negative controls, D1/E1 positive controls, rest samples. */
export function standardLayout(rows = 8, cols = 12): WellType[][] {
  const wt: WellType[][] = Array.from({ length: rows }, () =>
    new Array<WellType>(cols).fill('sample'),
  );
  wt[0][0] = 'blank';
  if (rows > 2) {
    wt[1][0] = 'neg_ctrl';
    wt[2][0] = 'neg_ctrl';
  }
  if (rows > 4) {
    wt[3][0] = 'pos_ctrl';
    wt[4][0] = 'pos_ctrl';
  }
  return wt;
}

export function generatePlate(rng: Pcg32, opts: SynthPlateOptions = {}): SynthPlate {
  const rows = opts.rows ?? 8;
  const cols = opts.cols ?? 12;
  const prevalence = opts.prevalence ?? 0.1;
  const negMu = Math.log(opts.negMedianOd ?? 0.08);
  const negSigma = opts.negSigma ?? 0.35;
  const posMu = Math.log(opts.posMedianOd ?? 1.2);
  const posSigma = opts.posSigma ?? 0.5;
  const wellTypes = standardLayout(rows, cols);
  const values: (number | null)[][] = Array.from({ length: rows }, () =>
    new Array<number | null>(cols).fill(null),
  );
  const isPositive: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      switch (wellTypes[i][j]) {
        case 'blank':
          values[i][j] = Math.max(0.001, 0.04 + 0.005 * rng.nextNormal());
          break;
        case 'neg_ctrl':
          values[i][j] = Math.exp(negMu + 0.15 * rng.nextNormal());
          break;
        case 'pos_ctrl':
          values[i][j] = Math.exp(posMu + 0.1 * rng.nextNormal());
          break;
        default: {
          const positive = rng.nextFloat() < prevalence;
          isPositive[i][j] = positive;
          values[i][j] = positive
            ? Math.exp(posMu + posSigma * rng.nextNormal())
            : Math.exp(negMu + negSigma * rng.nextNormal());
        }
      }
    }
  }
  return { values, wellTypes, isPositive };
}

/** Multiply the OD of all (non-null) wells in row `i` by exp(deltaLog). */
export function injectRowBias(p: SynthPlate, i: number, deltaLog: number): void {
  for (let j = 0; j < p.values[i].length; j++) {
    if (p.values[i][j] !== null) p.values[i][j] = (p.values[i][j] as number) * Math.exp(deltaLog);
  }
}

export function injectColBias(p: SynthPlate, j: number, deltaLog: number): void {
  for (let i = 0; i < p.values.length; i++) {
    if (p.values[i][j] !== null) p.values[i][j] = (p.values[i][j] as number) * Math.exp(deltaLog);
  }
}

/** Perimeter wells shifted by exp(deltaLog) (negative = edge depression/evaporation). */
export function injectEdgeEffect(p: SynthPlate, deltaLog: number): void {
  const R = p.values.length;
  const C = p.values[0].length;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      if (i === 0 || i === R - 1 || j === 0 || j === C - 1) {
        if (p.values[i][j] !== null)
          p.values[i][j] = (p.values[i][j] as number) * Math.exp(deltaLog);
      }
    }
  }
}

/** Linear gradient totalling deltaLog from corner to corner (split across rows+cols). */
export function injectGradient(p: SynthPlate, deltaLog: number): void {
  const R = p.values.length;
  const C = p.values[0].length;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      if (p.values[i][j] === null) continue;
      const f = ((i / (R - 1) + j / (C - 1)) / 2) * deltaLog;
      p.values[i][j] = (p.values[i][j] as number) * Math.exp(f);
    }
  }
}

export function injectGlobalShift(p: SynthPlate, deltaLog: number): void {
  for (let i = 0; i < p.values.length; i++) {
    for (let j = 0; j < p.values[i].length; j++) {
      if (p.values[i][j] !== null) p.values[i][j] = (p.values[i][j] as number) * Math.exp(deltaLog);
    }
  }
}

/** Corrupt `count` random sample wells by exp(deltaLog). Returns corrupted positions. */
export function injectOutliers(
  p: SynthPlate,
  rng: Pcg32,
  count: number,
  deltaLog: number,
): [number, number][] {
  const samples: [number, number][] = [];
  for (let i = 0; i < p.values.length; i++) {
    for (let j = 0; j < p.values[i].length; j++) {
      if (p.wellTypes[i][j] === 'sample' && p.values[i][j] !== null) samples.push([i, j]);
    }
  }
  rng.shuffle(samples);
  const chosen = samples.slice(0, count);
  for (const [i, j] of chosen) {
    p.values[i][j] = (p.values[i][j] as number) * Math.exp(deltaLog);
  }
  return chosen;
}
