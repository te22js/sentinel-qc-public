import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalCdf,
  normalQuantile,
  tCdf,
  tQuantile,
  chi2Cdf,
  chi2Quantile,
  fCdf,
  fQuantile,
  betaCdf,
  betaQuantile,
} from '../src/distributions.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/distributions.json', import.meta.url), 'utf8'),
);

const TOL = 1e-9;

/** absolute tolerance for cdf values; relative for quantiles with large magnitude */
function closeTo(got: number, want: number) {
  const tol = TOL * Math.max(1, Math.abs(want));
  expect(Math.abs(got - want), `got ${got}, want ${want}`).toBeLessThanOrEqual(tol);
}

describe('distributions vs SciPy fixtures', () => {
  it('normal cdf and quantile', () => {
    for (const c of fx.normal) {
      if ('cdf' in c) closeTo(normalCdf(c.x), c.cdf);
      else closeTo(normalQuantile(c.p), c.ppf);
    }
  });

  it('t cdf and quantile', () => {
    for (const c of fx.t) {
      if ('cdf' in c) closeTo(tCdf(c.x, c.df), c.cdf);
      else closeTo(tQuantile(c.p, c.df), c.ppf);
    }
  });

  it('chi2 cdf and quantile', () => {
    for (const c of fx.chi2) {
      if ('cdf' in c) closeTo(chi2Cdf(c.x, c.k), c.cdf);
      else closeTo(chi2Quantile(c.p, c.k), c.ppf);
    }
  });

  it('F cdf and quantile', () => {
    for (const c of fx.f) {
      if ('cdf' in c) closeTo(fCdf(c.x, c.d1, c.d2), c.cdf);
      else closeTo(fQuantile(c.p, c.d1, c.d2), c.ppf);
    }
  });

  it('beta cdf and quantile', () => {
    for (const c of fx.beta) {
      if ('cdf' in c) closeTo(betaCdf(c.x, c.a, c.b), c.cdf);
      else closeTo(betaQuantile(c.p, c.a, c.b), c.ppf);
    }
  });
});
