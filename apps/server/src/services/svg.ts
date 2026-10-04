/**
 * Server-side SVG chart generators for reports (print-ready, self-contained).
 * Visual language mirrors the web client: 1px lines, dashed gray ±1/2/3 SD lines,
 * 4px points, hollow red circles for violations, JetBrains-style tabular numerals
 * left to the browser's monospace stack.
 */

export interface LjSvgPoint {
  z: number | null;
  violated: boolean;
}

export interface LjBandValues {
  p3: number;
  p2: number;
  p1: number;
  mean: number;
  m1: number;
  m2: number;
  m3: number;
}

export function ljChartSvg(
  points: LjSvgPoint[],
  width = 720,
  height = 220,
  bandValues?: LjBandValues,
): string {
  const pad = { l: 36, r: bandValues ? 52 : 8, t: 8, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const yFor = (z: number) => pad.t + h / 2 - (z / 4) * (h / 2); // ±4 SD range
  const xFor = (i: number) => pad.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * w);
  const sdLine = (z: number, cls: string, dash: string) =>
    `<line x1="${pad.l}" y1="${yFor(z)}" x2="${pad.l + w}" y2="${yFor(z)}" stroke="${cls}" stroke-width="1" stroke-dasharray="${dash}"/>` +
    (z !== 0
      ? `<text x="${pad.l - 4}" y="${yFor(z) + 3}" text-anchor="end" font-size="9" fill="#6b7280" font-family="ui-monospace,monospace">${z > 0 ? '+' : ''}${z}</text>`
      : `<text x="${pad.l - 4}" y="${yFor(0) + 3}" text-anchor="end" font-size="9" fill="#374151" font-family="ui-monospace,monospace">x̄</text>`);
  let body = '';
  for (const [z, dash, color] of [
    [3, '2,3', '#6b7280'],
    [-3, '2,3', '#6b7280'],
    [2, '3,3', '#9ca3af'],
    [-2, '3,3', '#9ca3af'],
    [1, '2,4', '#d1d5db'],
    [-1, '2,4', '#d1d5db'],
  ] as [number, string, string][]) {
    body += sdLine(z, color, dash);
  }
  body += `<line x1="${pad.l}" y1="${yFor(0)}" x2="${pad.l + w}" y2="${yFor(0)}" stroke="#374151" stroke-width="1"/>`;
  if (bandValues) {
    const rightLabel = (z: number, v: number, strong = false) =>
      `<text x="${pad.l + w + 6}" y="${yFor(z) + 3}" font-size="9" fill="${strong ? '#374151' : '#6b7280'}" font-family="ui-monospace,monospace">${v.toFixed(3)}</text>`;
    body += rightLabel(3, bandValues.p3) + rightLabel(2, bandValues.p2) + rightLabel(1, bandValues.p1);
    body += rightLabel(0, bandValues.mean, true);
    body += rightLabel(-1, bandValues.m1) + rightLabel(-2, bandValues.m2) + rightLabel(-3, bandValues.m3);
  }
  // polyline through points
  const path = points
    .map((p, i) => (p.z === null ? null : `${xFor(i).toFixed(1)},${yFor(Math.max(-4, Math.min(4, p.z))).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  if (path) body += `<polyline points="${path}" fill="none" stroke="#1d4ed8" stroke-width="1"/>`;
  points.forEach((p, i) => {
    if (p.z === null) return;
    const y = yFor(Math.max(-4, Math.min(4, p.z)));
    body += p.violated
      ? `<circle cx="${xFor(i).toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="none" stroke="#dc2626" stroke-width="1.2"/>`
      : `<circle cx="${xFor(i).toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#1d4ed8"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/** Diverging blue–white–red heat map of an 8×12 grid (nulls gray). */
export function heatmapSvg(
  grid: (number | null)[][],
  opts: { cell?: number; center?: number; scale?: number; title?: string } = {},
): string {
  const R = grid.length;
  const C = R > 0 ? grid[0].length : 0;
  const cell = opts.cell ?? 22;
  const padL = 20;
  const padT = opts.title ? 16 : 4;
  const values = grid.flat().filter((v): v is number => v !== null);
  const center = opts.center ?? (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const spread =
    opts.scale ?? Math.max(...values.map((v) => Math.abs(v - center)), 1e-9);
  const color = (v: number) => {
    const t = Math.max(-1, Math.min(1, (v - center) / spread));
    // blue (−) → white → red (+)
    if (t >= 0) {
      const g = Math.round(255 - 165 * t);
      const b = Math.round(255 - 195 * t);
      return `rgb(255,${g},${b})`;
    }
    const r = Math.round(255 + 175 * t);
    const g = Math.round(255 + 115 * t);
    return `rgb(${r},${g},255)`;
  };
  let body = '';
  if (opts.title) body += `<text x="${padL}" y="11" font-size="10" fill="#374151" font-family="ui-sans-serif,sans-serif">${opts.title}</text>`;
  for (let i = 0; i < R; i++) {
    body += `<text x="${padL - 6}" y="${padT + i * cell + cell / 2 + 3}" text-anchor="end" font-size="9" fill="#6b7280" font-family="ui-monospace,monospace">${'ABCDEFGHIJKLMNOP'[i]}</text>`;
    for (let j = 0; j < C; j++) {
      const v = grid[i][j];
      body += `<rect x="${padL + j * cell}" y="${padT + i * cell}" width="${cell - 1}" height="${cell - 1}" fill="${v === null ? '#e5e7eb' : color(v)}" stroke="#d1d5db" stroke-width="0.5"/>`;
    }
  }
  for (let j = 0; j < C; j++) {
    body += `<text x="${padL + j * cell + cell / 2}" y="${padT + R * cell + 10}" text-anchor="middle" font-size="8" fill="#6b7280" font-family="ui-monospace,monospace">${j + 1}</text>`;
  }
  const width = padL + C * cell + 4;
  const height = padT + R * cell + 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}
