import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ewma, varianceEwma, VARIANCE_EWMA_UCL } from '../src/ewma.js';
import { Pcg32 } from '../src/rng.js';

const fx = JSON.parse(readFileSync(new URL('../../../fixtures/ewma.json', import.meta.url), 'utf8'));
const cal = JSON.parse(
  readFileSync(new URL('../../../fixtures/variance_ewma_calibration.json', import.meta.url), 'utf8'),
);

describe('EWMA vs Python fixtures', () => {
  it('E_t and time-varying limits match to 1e-9', () => {
    for (const c of fx.cases) {
      const res = ewma(c.z, { lambda: c.lambda, L: c.L });
      for (let i = 0; i < c.z.length; i++) {
        expect(Math.abs(res.points[i].e - c.e[i])).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(res.points[i].ucl - c.limit[i])).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('signals on a sustained shift and estimates it', () => {
    const zs = [...new Array(20).fill(0), ...new Array(20).fill(1.5)];
    const res = ewma(zs);
    expect(res.firstSignal).not.toBeNull();
    expect(res.firstSignal!).toBeGreaterThan(20);
    expect(res.shiftEstimate!).toBeGreaterThan(0.5);
  });
});

describe('EWMA Monte-Carlo properties', () => {
  it('ARL0 for the default design (λ=0.2, L=2.962) is 500 ± 15%', () => {
    const rng = new Pcg32(20240822);
    const nSeq = 4000;
    const maxLen = 5000;
    const lambda = 0.2;
    const L = 2.962;
    const asym = Math.sqrt(lambda / (2 - lambda));
    let total = 0;
    for (let s = 0; s < nSeq; s++) {
      let e = 0;
      let t = 0;
      for (t = 1; t <= maxLen; t++) {
        e = lambda * rng.nextNormal() + (1 - lambda) * e;
        const w = L * asym * Math.sqrt(1 - Math.pow(1 - lambda, 2 * t));
        if (Math.abs(e) > w) break;
      }
      total += Math.min(t, maxLen);
    }
    const arl0 = total / nSeq;
    expect(arl0).toBeGreaterThan(500 * 0.85);
    expect(arl0).toBeLessThan(500 * 1.15);
  });

  it('sensitive preset (λ=0.1, L=2.814) detects a 1σ shift before run 15 in ≥ 90% of 1000 sims', () => {
    const rng = new Pcg32(77);
    let detected = 0;
    for (let s = 0; s < 1000; s++) {
      const zs = Array.from({ length: 15 }, () => rng.nextNormal() + 1);
      const res = ewma(zs, { lambda: 0.1, L: 2.814 });
      if (res.firstSignal !== null && res.firstSignal <= 15) detected++;
    }
    expect(detected / 1000).toBeGreaterThanOrEqual(0.9);
  });

  it('default design detects a 1σ shift before run 15 in ≥ 80% of 1000 sims (measured ≈ 84%)', () => {
    const rng = new Pcg32(78);
    let detected = 0;
    for (let s = 0; s < 1000; s++) {
      const zs = Array.from({ length: 15 }, () => rng.nextNormal() + 1);
      const res = ewma(zs);
      if (res.firstSignal !== null && res.firstSignal <= 15) detected++;
    }
    expect(detected / 1000).toBeGreaterThanOrEqual(0.8);
  });
});

describe('variance EWMA', () => {
  it('default limits match the committed Monte-Carlo calibration', () => {
    expect(VARIANCE_EWMA_UCL['0.2']).toBeCloseTo(cal['0.2'].ucl, 10);
    expect(VARIANCE_EWMA_UCL['0.1']).toBeCloseTo(cal['0.1'].ucl, 10);
  });

  it('calibrated limit gives ARL0 ≈ 500 ± 15% (λ=0.2)', () => {
    const rng = new Pcg32(31337);
    const lambda = 0.2;
    const ucl = VARIANCE_EWMA_UCL['0.2'];
    const nSeq = 4000;
    const maxLen = 5000;
    let total = 0;
    for (let s = 0; s < nSeq; s++) {
      let v = 1;
      let t = 0;
      for (t = 1; t <= maxLen; t++) {
        const z = rng.nextNormal();
        v = lambda * z * z + (1 - lambda) * v;
        if (v > ucl) break;
      }
      total += Math.min(t, maxLen);
    }
    const arl0 = total / nSeq;
    expect(arl0).toBeGreaterThan(500 * 0.85);
    expect(arl0).toBeLessThan(500 * 1.15);
  });

  it('signals on a variance increase', () => {
    const rng = new Pcg32(4242);
    const zs = [
      ...Array.from({ length: 30 }, () => rng.nextNormal()),
      ...Array.from({ length: 30 }, () => rng.nextNormal() * 1.9),
    ];
    const res = varianceEwma(zs);
    expect(res.firstSignal).not.toBeNull();
    expect(res.firstSignal!).toBeGreaterThan(25);
  });
});
