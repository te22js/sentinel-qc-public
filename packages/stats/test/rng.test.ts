import { describe, expect, it } from 'vitest';
import { Pcg32 } from '../src/rng.js';

describe('Pcg32', () => {
  it('matches the canonical PCG32 demo output for seed 42, seq 54', () => {
    // Reference: pcg32-demo from pcg-random.org, pcg32_srandom_r(&rng, 42u, 54u)
    const rng = new Pcg32(42, 54);
    const got = Array.from({ length: 6 }, () => rng.nextUint32());
    expect(got).toEqual([0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e]);
  });

  it('is deterministic for a given seed and independent across seeds', () => {
    const a1 = new Pcg32(123);
    const a2 = new Pcg32(123);
    const b = new Pcg32(124);
    const s1 = Array.from({ length: 10 }, () => a1.nextUint32());
    const s2 = Array.from({ length: 10 }, () => a2.nextUint32());
    const s3 = Array.from({ length: 10 }, () => b.nextUint32());
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
  });

  it('nextFloat is uniform-ish and in [0,1)', () => {
    const rng = new Pcg32(7);
    let sum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const u = rng.nextFloat();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it('nextNormal has mean ~0 and sd ~1', () => {
    const rng = new Pcg32(99);
    const n = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.nextNormal();
      s += x;
      s2 += x * x;
    }
    const mean = s / n;
    const sd = Math.sqrt(s2 / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(sd - 1)).toBeLessThan(0.01);
  });

  it('nextInt is unbiased over a small modulus', () => {
    const rng = new Pcg32(5);
    const counts = new Array(7).fill(0);
    const n = 70_000;
    for (let i = 0; i < n; i++) counts[rng.nextInt(7)]++;
    for (const c of counts) expect(Math.abs(c - n / 7)).toBeLessThan((5 * Math.sqrt(n / 7)));
  });

  it('shuffle preserves elements', () => {
    const rng = new Pcg32(1);
    const arr = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = rng.shuffle(arr.slice());
    expect(shuffled.slice().sort((a, b) => a - b)).toEqual(arr);
  });
});
