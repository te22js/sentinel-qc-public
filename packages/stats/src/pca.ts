/**
 * PCA via cyclic Jacobi eigendecomposition of the sample covariance matrix.
 *
 * Reference: Golub & Van Loan, Matrix Computations, §8.5 (Jacobi methods).
 * Dimensions here are small (≤ ~24), where Jacobi is simple, robust and accurate.
 *
 * Eigenvalues are returned sorted descending with matching orthonormal eigenvectors
 * (columns of `vectors`).
 */

export interface EigenResult {
  values: number[]; // descending
  vectors: number[][]; // vectors[i][k] = component i of eigenvector k (column-major-ish)
}

/** Symmetric eigendecomposition by cyclic Jacobi rotations. */
export function jacobiEigen(A: readonly number[][], maxSweeps = 100): EigenResult {
  const n = A.length;
  const a = A.map((row) => row.slice());
  // V starts as identity
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (Math.sqrt(off) < 1e-14) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta === 0 ? 1 : theta) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // rotate rows/cols p,q of a
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
  const values = order.map((i) => a[i][i]);
  const vectors = Array.from({ length: n }, (_, row) => order.map((col) => V[row][col]));
  return { values, vectors };
}

/** Sample covariance matrix of rows-as-observations X (n × p). */
export function covarianceMatrix(X: readonly number[][]): number[][] {
  const n = X.length;
  const p = n > 0 ? X[0].length : 0;
  const means = new Array(p).fill(0);
  for (const row of X) for (let j = 0; j < p; j++) means[j] += row[j];
  for (let j = 0; j < p; j++) means[j] /= n;
  const S: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const row of X) {
    for (let j = 0; j < p; j++) {
      const dj = row[j] - means[j];
      for (let k = j; k < p; k++) S[j][k] += dj * (row[k] - means[k]);
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = j; k < p; k++) {
      S[j][k] /= n - 1;
      S[k][j] = S[j][k];
    }
  }
  return S;
}
