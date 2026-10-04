import { describe, expect, it } from 'vitest';
import { applyTransform, zScore, LOG_EPSILON } from '../src/transform.js';
import { cv, quantile } from '../src/descriptive.js';

describe('transforms', () => {
  it('none is identity', () => {
    expect(applyTransform('none', 1.23)).toBe(1.23);
  });

  it('log clamps at epsilon', () => {
    expect(applyTransform('log', 0.5)).toBeCloseTo(Math.log(0.5), 12);
    expect(applyTransform('log', 0)).toBeCloseTo(Math.log(LOG_EPSILON), 12);
    expect(applyTransform('log', -1)).toBeCloseTo(Math.log(LOG_EPSILON), 12);
  });

  it('ratio_to_cutoff divides and validates the cutoff', () => {
    expect(applyTransform('ratio_to_cutoff', 0.5, 0.25)).toBeCloseTo(2, 12);
    expect(() => applyTransform('ratio_to_cutoff', 0.5)).toThrow(/cutoff/);
    expect(() => applyTransform('ratio_to_cutoff', 0.5, 0)).toThrow(/cutoff/);
  });

  it('zScore standardizes and refuses sd ≤ 0', () => {
    expect(zScore(1.2, 1.0, 0.1)).toBeCloseTo(2, 12);
    expect(() => zScore(1, 1, 0)).toThrow(/sd/);
  });
});

describe('descriptive extras', () => {
  it('cv is percent sd/mean', () => {
    expect(cv([9, 10, 11])).toBeCloseTo(10, 9);
    expect(Number.isNaN(cv([0, 0]))).toBe(true);
  });

  it('quantile matches numpy linear interpolation', () => {
    const xs = [1, 2, 3, 4];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
    expect(quantile(xs, 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile(xs, 0.25)).toBeCloseTo(1.75, 12);
  });
});
