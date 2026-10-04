import { describe, expect, it } from 'vitest';
import { psad } from '../src/psad.js';
import { Pcg32 } from '../src/rng.js';
import {
  generatePlate,
  injectRowBias,
  injectColBias,
  injectEdgeEffect,
  injectGradient,
  injectGlobalShift,
  injectOutliers,
} from '../src/synthplate.js';

const B_TEST = 199; // smaller B for unit tests; experiments use 499–999

describe('PSAD — Plate Spatial Artifact Detector', () => {
  it('clean plates: few plate-wise false positives at α=0.01 per family', () => {
    const rng = new Pcg32(1);
    let flagged = 0;
    const plates = 25;
    for (let s = 0; s < plates; s++) {
      const p = generatePlate(rng);
      const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 100 + s });
      expect(res.ok).toBe(true);
      const spatial = res.findings.filter((f) => f.kind !== 'local_outlier');
      if (spatial.length > 0) flagged++;
    }
    // 5 families at α=0.01 → ≈5% of plates may show something; allow ≤ 4/25
    expect(flagged).toBeLessThanOrEqual(4);
  });

  it('detects and localizes a strong row effect (row F, +1.0 log-OD)', () => {
    const rng = new Pcg32(21);
    const p = generatePlate(rng);
    injectRowBias(p, 5, 1.0);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 7 });
    const rowFindings = res.findings.filter((f) => f.kind === 'row_effect');
    expect(rowFindings.length).toBeGreaterThanOrEqual(1);
    expect(rowFindings.map((f) => f.index)).toContain('F');
    const f = rowFindings.find((x) => x.index === 'F')!;
    expect(f.p!).toBeLessThanOrEqual(0.01);
    expect(f.effect).toBeGreaterThan(0.4);
    expect(f.wells).toContain('F1');
  });

  it('detects a column effect', () => {
    // Column power is intrinsically lower than row power: only 8 wells per column, and a
    // strong fault inflates its own permutation null (the permuted plates contain the
    // shifted values). α = 0.05 here; the experiments suite maps the full power curve.
    const rng = new Pcg32(3);
    const p = generatePlate(rng, { prevalence: 0.05 });
    injectColBias(p, 10, 1.6); // column 11
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 8, alpha: 0.05 });
    const colFindings = res.findings.filter((f) => f.kind === 'col_effect');
    expect(colFindings.map((f) => f.index)).toContain('11');
    const f = colFindings.find((x) => x.index === '11')!;
    expect(f.p!).toBeLessThanOrEqual(0.05);
    expect(f.effectSd).toBeGreaterThan(3);
  });

  it('detects an edge depression', () => {
    const rng = new Pcg32(4);
    const p = generatePlate(rng);
    injectEdgeEffect(p, -0.5);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 9 });
    const edge = res.findings.find((f) => f.kind === 'edge_effect');
    expect(edge).toBeDefined();
    expect(edge!.effectSd).toBeLessThan(0); // below interior
    expect(edge!.p!).toBeLessThanOrEqual(0.01);
  });

  it('detects a gradient', () => {
    const rng = new Pcg32(5);
    const p = generatePlate(rng);
    injectGradient(p, 1.8);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 10 });
    const grad = res.findings.find((f) => f.kind === 'gradient');
    expect(grad).toBeDefined();
    expect(grad!.p!).toBeLessThanOrEqual(0.01);
  });

  it('a global shift does NOT trigger spatial findings (that is Westgard\'s job)', () => {
    const rng = new Pcg32(6);
    const p = generatePlate(rng);
    injectGlobalShift(p, 1.0);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 11 });
    const spatial = res.findings.filter((f) => f.kind !== 'local_outlier');
    expect(spatial).toHaveLength(0);
  });

  it('flags corrupted wells as local outlier candidates', () => {
    const rng = new Pcg32(7);
    const p = generatePlate(rng);
    const where = injectOutliers(p, new Pcg32(70), 2, 2.5);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 12 });
    const outliers = res.findings.filter((f) => f.kind === 'local_outlier');
    const names = outliers.map((f) => f.index);
    // at least one of the two corrupted wells is flagged (both usually)
    const rowLetters = 'ABCDEFGH';
    const expected = where.map(([i, j]) => `${rowLetters[i]}${j + 1}`);
    expect(expected.some((w) => names.includes(w))).toBe(true);
  });

  it('refuses plates with < 40 sample wells', () => {
    const rng = new Pcg32(8);
    const p = generatePlate(rng, { rows: 4, cols: 8 }); // 27 sample wells
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Insufficient sample wells/);
  });

  it('structured plating suppresses p-values but still reports effects', () => {
    const rng = new Pcg32(9);
    const p = generatePlate(rng);
    injectRowBias(p, 5, 1.0);
    const res = psad({
      values: p.values,
      wellTypes: p.wellTypes,
      B: B_TEST,
      platingOrder: 'structured',
    });
    expect(res.suppressedPValues).toBe(true);
    expect(res.pValues).toBeNull();
    expect(res.statistics!.tRow).toBeGreaterThan(1);
    expect(res.rowEffects[5]).toBeGreaterThan(0.3);
    expect(res.findings.filter((f) => f.kind === 'row_effect')).toHaveLength(0);
  });

  it('is deterministic for a fixed seed', () => {
    const rng = new Pcg32(10);
    const p = generatePlate(rng);
    const a = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 42 });
    const b = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST, seed: 42 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rank transform detects an edge effect on a plate with many extreme positives', () => {
    // The rank transform bounds the influence of extreme positives; the 34-well
    // perimeter median gives it solid power even at 20% prevalence.
    const rng = new Pcg32(11);
    const p = generatePlate(rng, { prevalence: 0.2, posMedianOd: 2.5 });
    injectEdgeEffect(p, -0.8);
    const res = psad({
      values: p.values,
      wellTypes: p.wellTypes,
      transform: 'rank',
      B: B_TEST,
      seed: 13,
    });
    const edge = res.findings.find((f) => f.kind === 'edge_effect');
    expect(edge).toBeDefined();
    expect(edge!.p!).toBeLessThanOrEqual(0.01);
    expect(edge!.effectSd).toBeLessThan(0);
  });

  it('produces the 22-dimensional Phase-II feature vector for 8×12 plates', () => {
    const rng = new Pcg32(12);
    const p = generatePlate(rng);
    const res = psad({ values: p.values, wellTypes: p.wellTypes, B: B_TEST });
    expect(res.featureVector).toHaveLength(7 + 11 + 4);
  });

  it('performance: B=999 on a 96-well plate completes in < 500 ms', () => {
    const rng = new Pcg32(13);
    const p = generatePlate(rng);
    const t0 = performance.now();
    psad({ values: p.values, wellTypes: p.wellTypes, B: 999, seed: 1 });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});
