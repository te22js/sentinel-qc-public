import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeBaseline } from '../src/baseline.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/baseline.json', import.meta.url), 'utf8'),
);

describe('baseline (Phase I) vs oracle datasets', () => {
  for (const ds of fx.datasets) {
    it(`dataset ${ds.name}`, () => {
      const res = computeBaseline({ values: ds.values, ids: ds.ids });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.n).toBe(ds.expected.n);
      expect(res.mean).toBeCloseTo(ds.expected.mean, 9);
      expect(res.sd).toBeCloseTo(ds.expected.sd, 9);
      expect(res.robustMean).toBeCloseTo(ds.expected.median, 9);
      expect(res.robustSd).toBeCloseTo(ds.expected.robustSd, 9);
      expect(res.excludedIds).toEqual(ds.expected.excludedIds);
      expect(res.provisional).toBe(ds.expected.n < 20);
    });
  }

  it('refuses n < 10', () => {
    const res = computeBaseline({ values: [1, 2, 3], ids: ['a', 'b', 'c'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('too_few_observations');
  });

  it('refuses sd = 0', () => {
    const vals = new Array(20).fill(5);
    const res = computeBaseline({ values: vals, ids: vals.map((_, i) => `i${i}`) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('zero_sd');
  });

  it('flags 10 ≤ n < 20 as provisional', () => {
    const vals = Array.from({ length: 12 }, (_, i) => 10 + 0.1 * Math.sin(i * 2.3));
    const res = computeBaseline({ values: vals, ids: vals.map((_, i) => `i${i}`) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.provisional).toBe(true);
  });

  it('stops excluding after 2 passes', () => {
    // construct data where a third pass would exclude more
    const base = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 10.0 : 10.2));
    const vals = [...base, 30, 14, 11.5];
    const res = computeBaseline({ values: vals, ids: vals.map((_, i) => `i${i}`) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.passes).toBeLessThanOrEqual(2);
  });
});
