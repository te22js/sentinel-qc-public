/** Plate heat map (8×12) and row/column effect bars with p-values. */
import { useState } from 'react';

const ROWS = 'ABCDEFGHIJKLMNOP';

export function PlateHeatmap({
  grid,
  wellTypes,
  center,
  title,
  highlight = [],
}: {
  grid: (number | null)[][];
  wellTypes?: string[][];
  center?: number;
  title: string;
  highlight?: string[];
}) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const R = grid.length;
  const C = R > 0 ? grid[0].length : 0;
  const values = grid.flat().filter((v): v is number => v !== null);
  const mid = center ?? (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const spread = Math.max(...values.map((v) => Math.abs(v - mid)), 1e-9);
  const color = (v: number) => {
    const t = Math.max(-1, Math.min(1, (v - mid) / spread));
    if (t >= 0) return `rgb(255,${Math.round(255 - 165 * t)},${Math.round(255 - 195 * t)})`;
    return `rgb(${Math.round(255 + 175 * t)},${Math.round(255 + 115 * t)},255)`;
  };
  const cell = 30;
  const padL = 24;
  const padT = 20;
  const hl = new Set(highlight);
  return (
    <div>
      <div className="text-gray-600 mb-1">{title}</div>
      <svg viewBox={`0 0 ${padL + C * cell + 4} ${padT + R * cell + 16}`} className="w-full max-w-md" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: R }, (_, i) => (
          <text key={i} x={padL - 6} y={padT + i * cell + cell / 2 + 3} textAnchor="end" fontSize="10" fill="#6b7280" className="num">
            {ROWS[i]}
          </text>
        ))}
        {Array.from({ length: C }, (_, j) => (
          <text key={j} x={padL + j * cell + cell / 2} y={padT + R * cell + 12} textAnchor="middle" fontSize="9" fill="#6b7280" className="num">
            {j + 1}
          </text>
        ))}
        {grid.map((row, i) =>
          row.map((v, j) => {
            const wt = wellTypes?.[i]?.[j];
            const isHl = hl.has(`${ROWS[i]}${j + 1}`);
            return (
              <g key={`${i}-${j}`} onMouseEnter={() => setHover({ i, j })}>
                <rect
                  x={padL + j * cell}
                  y={padT + i * cell}
                  width={cell - 1.5}
                  height={cell - 1.5}
                  fill={v === null ? '#f3f4f6' : color(v)}
                  stroke={isHl ? '#dc2626' : '#d1d5db'}
                  strokeWidth={isHl ? 1.5 : 0.5}
                />
                {wt && wt !== 'sample' && v !== null && (
                  <text x={padL + j * cell + cell / 2} y={padT + i * cell + cell / 2 + 3} textAnchor="middle" fontSize="8" fill="#6b7280">
                    {wt === 'blank' ? 'B' : wt === 'neg_ctrl' ? 'N' : wt === 'pos_ctrl' ? 'P' : wt === 'calibrator' ? 'C' : ''}
                  </text>
                )}
              </g>
            );
          }),
        )}
        {hover && grid[hover.i][hover.j] !== null && (
          <text x={padL} y={12} fontSize="10" fill="#111827" className="num">
            {ROWS[hover.i]}{hover.j + 1}: {(grid[hover.i][hover.j] as number).toFixed(3)}
            {wellTypes?.[hover.i]?.[hover.j] !== 'sample' ? ` (${wellTypes?.[hover.i]?.[hover.j]})` : ''}
          </text>
        )}
      </svg>
    </div>
  );
}

export function EffectBars({
  labels,
  effects,
  pValues,
  title,
  alpha = 0.01,
}: {
  labels: string[];
  effects: number[];
  pValues: (number | null)[] | null;
  title: string;
  alpha?: number;
}) {
  const max = Math.max(...effects.map(Math.abs), 1e-9);
  const W = 320;
  const rowH = 16;
  const mid = W / 2 + 20;
  const scale = (W / 2 - 60) / max;
  return (
    <div>
      <div className="text-gray-600 mb-1">{title}</div>
      <svg viewBox={`0 0 ${W + 60} ${labels.length * rowH + 4}`} className="w-full max-w-sm">
        <line x1={mid} x2={mid} y1={0} y2={labels.length * rowH} stroke="#d1d5db" strokeWidth="1" />
        {labels.map((label, i) => {
          const e = effects[i] ?? 0;
          const p = pValues?.[i] ?? null;
          const sig = p !== null && p <= alpha;
          const w = Math.abs(e) * scale;
          return (
            <g key={label} transform={`translate(0,${i * rowH})`}>
              <text x={mid - (e < 0 ? w + 26 : 0) - 4} y={rowH - 5} textAnchor="end" fontSize="9" fill="#6b7280" className="num">
                {label}
              </text>
              <rect
                x={e >= 0 ? mid : mid - w}
                y={3}
                width={w}
                height={rowH - 7}
                fill={sig ? '#dc2626' : '#93c5fd'}
              />
              {p !== null && (
                <text x={mid + (e >= 0 ? w + 4 : 8)} y={rowH - 5} fontSize="8.5" fill={sig ? '#dc2626' : '#9ca3af'} className="num">
                  p={p.toFixed(3)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
