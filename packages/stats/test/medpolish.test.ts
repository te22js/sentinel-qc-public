import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { medpolish } from '../src/medpolish.js';

const fx = JSON.parse(
  readFileSync(new URL('../../../fixtures/medpolish.json', import.meta.url), 'utf8'),
);

describe('median polish vs R-algorithm fixtures', () => {
  for (const c of fx.cases) {
    it(`matrix ${c.name}`, () => {
      const res = medpolish(c.matrix);
      expect(res.overall).toBeCloseTo(c.overall, 9);
      c.row.forEach((v: number, i: number) => expect(res.row[i]).toBeCloseTo(v, 9));
      c.col.forEach((v: number, j: number) => expect(res.col[j]).toBeCloseTo(v, 9));
      c.residuals.forEach((row: number[], i: number) =>
        row.forEach((v, j) => expect(res.residuals[i][j] as number).toBeCloseTo(v, 9)),
      );
    });
  }

  it('decomposition reconstructs the data: x = μ + α + β + r', () => {
    const m = fx.cases[0].matrix as number[][];
    const res = medpolish(m);
    for (let i = 0; i < m.length; i++) {
      for (let j = 0; j < m[0].length; j++) {
        const recon = res.overall + res.row[i] + res.col[j] + (res.residuals[i][j] as number);
        expect(recon).toBeCloseTo(m[i][j], 9);
      }
    }
  });

  it('handles masked cells (null)', () => {
    const m: (number | null)[][] = [
      [1, 2, null],
      [2, 3, 4],
      [3, null, 5],
    ];
    const res = medpolish(m);
    expect(res.residuals[0][2]).toBeNull();
    expect(res.residuals[2][1]).toBeNull();
    // reconstruction still holds on observed cells
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (m[i][j] === null) continue;
        const recon = res.overall + res.row[i] + res.col[j] + (res.residuals[i][j] as number);
        expect(recon).toBeCloseTo(m[i][j] as number, 9);
      }
    }
  });

  it('recovers a pure additive structure with zero residuals', () => {
    const rows = [0, 1, 2, 3];
    const cols = [0, 10, 20];
    const m = rows.map((r) => cols.map((c) => 5 + r + c));
    const res = medpolish(m);
    for (const row of res.residuals) for (const v of row) expect(Math.abs(v as number)).toBeLessThan(1e-9);
  });
});
