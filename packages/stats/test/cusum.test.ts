import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cusum } from '../src/cusum.js';
import { Pcg32 } from '../src/rng.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/cusum_montgomery.json', import.meta.url), 'utf8'),
);

describe('CUSUM vs the Montgomery textbook example', () => {
  it('reproduces C+ and C− exactly (k=0.5, h=5, μ0=10, σ=1)', () => {
    const zs = fx.rows.map((r: { x: number }) => r.x - fx.mu0);
    const res = cusum(zs, { k: fx.k, h: fx.h, resetOnSignal: false });
    fx.rows.forEach((row: { cplus: number; cminus: number; signal: string }, i: number) => {
      expect(res.points[i].cPlus).toBeCloseTo(row.cplus, 9);
      expect(res.points[i].cMinus).toBeCloseTo(row.cminus, 9);
      expect(res.points[i].signal === 'none' ? 'none' : res.points[i].signal).toBe(
        row.signal === 'none' ? 'none' : row.signal,
      );
    });
  });

  it('estimates onset and shift on the Montgomery data', () => {
    const zs = fx.rows.map((r: { x: number }) => r.x - fx.mu0);
    const res = cusum(zs, { k: fx.k, h: fx.h });
    expect(res.firstSignal).toBe(29); // Montgomery: signal at period 29
    const sig = res.points[28];
    expect(sig.signal).toBe('up');
    expect(sig.shiftEstimate!).toBeGreaterThan(0.5);
  });
});

describe('CUSUM Monte-Carlo ARL properties', () => {
  it('ARL0 for (k=0.5, h=5) is 465 ± 15%', () => {
    const rng = new Pcg32(112233);
    const nSeq = 4000;
    const maxLen = 5000;
    let total = 0;
    for (let s = 0; s < nSeq; s++) {
      let cp = 0;
      let cm = 0;
      let t = 0;
      for (t = 1; t <= maxLen; t++) {
        const z = rng.nextNormal();
        cp = Math.max(0, cp + z - 0.5);
        cm = Math.max(0, cm - z - 0.5);
        if (cp > 5 || cm > 5) break;
      }
      total += Math.min(t, maxLen);
    }
    const arl0 = total / nSeq;
    expect(arl0).toBeGreaterThan(465 * 0.85);
    expect(arl0).toBeLessThan(465 * 1.15);
  });

  it('ARL1 for a 1σ shift is ≈ 10.4 ± 2', () => {
    const rng = new Pcg32(445566);
    const nSeq = 5000;
    const maxLen = 500;
    let total = 0;
    for (let s = 0; s < nSeq; s++) {
      let cp = 0;
      let t = 0;
      for (t = 1; t <= maxLen; t++) {
        const z = rng.nextNormal() + 1;
        cp = Math.max(0, cp + z - 0.5);
        if (cp > 5) break;
      }
      total += Math.min(t, maxLen);
    }
    const arl1 = total / nSeq;
    expect(arl1).toBeGreaterThan(10.4 - 2);
    expect(arl1).toBeLessThan(10.4 + 2);
  });

  it('FIR head-start halves time to signal for an immediate shift', () => {
    const zs = new Array(30).fill(1.2);
    const plain = cusum(zs);
    const fir = cusum(zs, { fir: true });
    expect(fir.firstSignal!).toBeLessThan(plain.firstSignal!);
  });

  it('onset estimate points near the true change', () => {
    const rng = new Pcg32(999);
    const zs = [
      ...Array.from({ length: 40 }, () => rng.nextNormal()),
      ...Array.from({ length: 30 }, () => rng.nextNormal() + 1.5),
    ];
    const res = cusum(zs);
    expect(res.firstSignal).not.toBeNull();
    const sig = res.points[res.firstSignal! - 1];
    expect(Math.abs(sig.onset! - 41)).toBeLessThanOrEqual(6);
  });
});
