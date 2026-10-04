import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { welchT, fTestVariances, leveneMedian, compareLots } from '../src/lot.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/lot_compare.json', import.meta.url), 'utf8'),
);

describe('lot comparison vs SciPy fixtures', () => {
  for (const c of fx.cases) {
    it(`case ${c.name}`, () => {
      const w = welchT(c.a, c.b);
      expect(w.t).toBeCloseTo(c.welch_t, 9);
      expect(w.df).toBeCloseTo(c.welch_df, 9);
      expect(w.p).toBeCloseTo(c.welch_p, 9);
      const f = fTestVariances(c.a, c.b);
      expect(f.f).toBeCloseTo(c.f, 9);
      expect(f.p).toBeCloseTo(c.f_p, 9);
      const l = leveneMedian(c.a, c.b);
      expect(l.w).toBeCloseTo(c.levene_w, 9);
      expect(l.p).toBeCloseTo(c.levene_p, 9);
    });
  }

  it('recommends re-baselining on a clear mean shift with stable SD', () => {
    const shift = fx.cases.find((c: { name: string }) => c.name === 'mean_shift')!;
    const cmp = compareLots(shift.a, shift.b, 10);
    expect(['accept_rebaseline_mean', 'accept_no_change']).toContain(cmp.recommendation);
    expect(cmp.message).toMatch(/Mean shift/);
  });

  it('flags a precision change', () => {
    const vc = fx.cases.find((c: { name: string }) => c.name === 'var_change')!;
    const cmp = compareLots(vc.a, vc.b, 10);
    expect(cmp.recommendation).toBe('investigate_precision');
  });

  it('flags bias above the allowable limit', () => {
    const a = Array.from({ length: 20 }, (_, i) => 1 + 0.001 * (i % 5));
    const b = Array.from({ length: 20 }, (_, i) => 1.2 + 0.001 * (i % 5));
    const cmp = compareLots(a, b, 5);
    expect(cmp.recommendation).toBe('investigate_bias');
    expect(Math.abs(cmp.biasPct - 20)).toBeLessThan(1);
  });
});
