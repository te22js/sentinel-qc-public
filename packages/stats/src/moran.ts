/**
 * Moran's I spatial autocorrelation on a grid with rook adjacency, supporting masked
 * (null) cells.
 *
 * Reference: Moran, Biometrika 1950; Cliff & Ord, Spatial Autocorrelation (1973).
 *
 * I = (n / W) · Σ_ij w_ij (x_i − x̄)(x_j − x̄) / Σ_i (x_i − x̄)²
 * with w_ij = 1 for rook neighbours (share an edge), W = Σ w_ij.
 * Significance in PSAD comes from the permutation null, not the normal approximation.
 */

export function moranI(grid: readonly (number | null)[][]): number {
  const R = grid.length;
  const C = R > 0 ? grid[0].length : 0;
  const cells: { i: number; j: number; v: number }[] = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const v = grid[i][j];
      if (v !== null) cells.push({ i, j, v });
    }
  }
  const n = cells.length;
  if (n < 3) return NaN;
  const mean = cells.reduce((a, c) => a + c.v, 0) / n;
  let denom = 0;
  for (const c of cells) denom += (c.v - mean) ** 2;
  if (denom === 0) return NaN;
  // index for neighbour lookup
  const idx = new Map<number, number>();
  cells.forEach((c, k) => idx.set(c.i * C + c.j, k));
  let num = 0;
  let W = 0;
  const deltas = [
    [0, 1],
    [1, 0],
  ]; // count each pair once, then double (symmetric weights)
  for (const c of cells) {
    for (const [di, dj] of deltas) {
      const ni = c.i + di;
      const nj = c.j + dj;
      const k = idx.get(ni * C + nj);
      if (k !== undefined) {
        const other = cells[k];
        num += (c.v - mean) * (other.v - mean);
        W += 1;
      }
    }
  }
  num *= 2;
  W *= 2;
  return (n / W) * (num / denom);
}
