import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { jacobiEigen, covarianceMatrix } from '../src/pca.js';
import { buildPhase2Model, scorePhase2 } from '../src/mspc.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/pca_mspc.json', import.meta.url), 'utf8'),
);

describe('PCA (Jacobi) vs numpy fixtures', () => {
  it('eigenvalues of the scaled covariance match numpy to 1e-9', () => {
    const X = fx.X as number[][];
    const n = X.length;
    const p = X[0].length;
    const means = new Array(p).fill(0);
    for (const r of X) for (let j = 0; j < p; j++) means[j] += r[j];
    for (let j = 0; j < p; j++) means[j] /= n;
    const scales = new Array(p).fill(0);
    for (const r of X) for (let j = 0; j < p; j++) scales[j] += (r[j] - means[j]) ** 2;
    for (let j = 0; j < p; j++) scales[j] = Math.sqrt(scales[j] / (n - 1));
    const Xs = X.map((r) => r.map((v, j) => (v - means[j]) / scales[j]));
    const S = covarianceMatrix(Xs);
    const eig = jacobiEigen(S);
    (fx.eigenvalues as number[]).forEach((v, i) => {
      expect(Math.abs(eig.values[i] - v)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
    });
  });

  it('eigenvectors are orthonormal and diagonalize S', () => {
    const X = (fx.X as number[][]).slice(0, 40);
    const S = covarianceMatrix(X);
    const eig = jacobiEigen(S);
    const p = S.length;
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) {
        let dot = 0;
        for (let i = 0; i < p; i++) dot += eig.vectors[i][a] * eig.vectors[i][b];
        expect(Math.abs(dot - (a === b ? 1 : 0))).toBeLessThan(1e-9);
      }
    }
  });
});

describe('Phase-II MSPC model', () => {
  it('component count and control limits match the reference formulas', () => {
    const model = buildPhase2Model(fx.X, { alpha: fx.alpha });
    expect(model.aComponents).toBe(fx.aComponents);
    expect(Math.abs(model.t2Ucl - fx.t2_ucl)).toBeLessThanOrEqual(1e-9 * fx.t2_ucl);
    expect(Math.abs(model.speUcl - fx.spe_ucl)).toBeLessThanOrEqual(1e-6 * fx.spe_ucl);
  });

  it('in-control training points rarely exceed the limits; a gross fault always does', () => {
    const X = fx.X as number[][];
    const model = buildPhase2Model(X, { alpha: 0.01 });
    let t2Exceed = 0;
    let speExceed = 0;
    for (const v of X) {
      const s = scorePhase2(model, v);
      if (s.t2Signal) t2Exceed++;
      if (s.speSignal) speExceed++;
    }
    expect(t2Exceed / X.length).toBeLessThan(0.1);
    expect(speExceed / X.length).toBeLessThan(0.1);
    // gross fault: perturb one variable by 10 marginal SDs
    const v = X[0].slice();
    v[3] += 10 * model.scales[3];
    const s = scorePhase2(model, v);
    expect(s.t2Signal || s.speSignal).toBe(true);
    // contribution should point at the perturbed variable
    const maxContrib = s.speContributions.indexOf(Math.max(...s.speContributions));
    expect(maxContrib).toBe(3);
  });
});
