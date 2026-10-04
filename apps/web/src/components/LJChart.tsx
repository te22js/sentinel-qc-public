/**
 * Levey–Jennings chart. Hand-built SVG per the visual spec: 1px series line,
 * dashed gray ±1/2/3 SD lines, 4px points, violations as hollow red circles with
 * the rule label on hover, vertical event markers, keyboard ←/→ stepping.
 */
import { useMemo, useState, useCallback } from 'react';
import { scaleLinear } from 'd3-scale';

export interface LJPointInput {
  z: number | null;
  raw: number;
  performedAt: string;
  violatedRules: string[];
  verdict: string;
}

export interface LJEventInput {
  index: number;
  label: string;
}

export interface LJBandValues {
  p3: number;
  p2: number;
  p1: number;
  mean: number;
  m1: number;
  m2: number;
  m3: number;
}

export function LJChart({
  points,
  events = [],
  height = 320,
  yMode = 'z',
  baseline,
  bandValues,
}: {
  points: LJPointInput[];
  events?: LJEventInput[];
  height?: number;
  yMode?: 'z' | 'value';
  baseline?: { mean: number; sd: number } | null;
  /** actual limit values labelled on the right axis (as on the printed report) */
  bandValues?: LJBandValues | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const width = 900;
  const pad = { l: 44, r: bandValues ? 62 : 12, t: 10, b: 26 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const x = useMemo(
    () => scaleLinear().domain([0, Math.max(points.length - 1, 1)]).range([pad.l, pad.l + innerW]),
    [points.length, innerW, pad.l],
  );
  const y = useMemo(() => {
    if (yMode === 'z') return scaleLinear().domain([-4, 4]).range([pad.t + innerH, pad.t]);
    const zs = points.map((p) => p.raw);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    const m = (hi - lo) * 0.1 || 1;
    return scaleLinear().domain([lo - m, hi + m]).range([pad.t + innerH, pad.t]);
  }, [yMode, points, innerH, pad.t]);

  const yz = useCallback(
    (p: LJPointInput) => (yMode === 'z' ? (p.z === null ? null : y(Math.max(-4, Math.min(4, p.z)))) : y(p.raw)),
    [y, yMode],
  );

  const sdLevels: { z: number; color: string; dash: string }[] = [
    { z: 3, color: '#6b7280', dash: '2,3' },
    { z: 2, color: '#9ca3af', dash: '3,3' },
    { z: 1, color: '#d1d5db', dash: '2,4' },
    { z: -1, color: '#d1d5db', dash: '2,4' },
    { z: -2, color: '#9ca3af', dash: '3,3' },
    { z: -3, color: '#6b7280', dash: '2,3' },
  ];
  const zToY = (z: number) =>
    yMode === 'z' ? y(z) : baseline ? y(baseline.mean + z * baseline.sd) : null;

  const linePath = useMemo(() => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const yy = yz(p);
      if (yy === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yy.toFixed(1)}`;
      pen = true;
    });
    return d;
  }, [points, x, yz]);

  const active = hover ?? focus;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setFocus((f) => Math.min((f ?? -1) + 1, points.length - 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocus((f) => Math.max((f ?? points.length) - 1, 0));
    }
  };

  if (points.length === 0) {
    return <div className="text-gray-400 py-16 text-center">No observations in the selected range.</div>;
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-700"
        tabIndex={0}
        role="img"
        aria-label="Levey-Jennings chart; use arrow keys to step through points"
        onKeyDown={onKey}
        onMouseLeave={() => setHover(null)}
      >
        {sdLevels.map((l) => {
          const yy = zToY(l.z);
          if (yy === null) return null;
          return (
            <g key={l.z}>
              <line x1={pad.l} x2={pad.l + innerW} y1={yy} y2={yy} stroke={l.color} strokeWidth="1" strokeDasharray={l.dash} />
              <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize="10" fill="#6b7280" className="num">
                {l.z > 0 ? `+${l.z}` : l.z}
              </text>
            </g>
          );
        })}
        {(() => {
          const yy = zToY(0);
          return yy === null ? null : (
            <>
              <line x1={pad.l} x2={pad.l + innerW} y1={yy} y2={yy} stroke="#374151" strokeWidth="1" />
              <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize="10" fill="#374151" className="num">
                x̄
              </text>
            </>
          );
        })()}
        {bandValues &&
          ([
            [3, bandValues.p3],
            [2, bandValues.p2],
            [1, bandValues.p1],
            [0, bandValues.mean],
            [-1, bandValues.m1],
            [-2, bandValues.m2],
            [-3, bandValues.m3],
          ] as [number, number][]).map(([z, v]) => {
            const yy = zToY(z);
            return yy === null ? null : (
              <text key={`b${z}`} x={pad.l + innerW + 8} y={yy + 3} fontSize="10" fill={z === 0 ? '#374151' : '#6b7280'} className="num">
                {v.toFixed(3)}
              </text>
            );
          })}
        {events.map((ev, i) => (
          <g key={i}>
            <line x1={x(ev.index)} x2={x(ev.index)} y1={pad.t} y2={pad.t + innerH} stroke="#9ca3af" strokeWidth="1" strokeDasharray="4,3" />
            <text x={x(ev.index) + 3} y={pad.t + 10} fontSize="9" fill="#6b7280">
              {ev.label}
            </text>
          </g>
        ))}
        <path d={linePath} fill="none" stroke="#1d4ed8" strokeWidth="1" />
        {points.map((p, i) => {
          const yy = yz(p);
          if (yy === null) return null;
          const violated = p.violatedRules.length > 0;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <circle cx={x(i)} cy={yy} r={active === i ? 5 : violated ? 4 : 2.5} fill={violated ? 'none' : '#1d4ed8'} stroke={violated ? '#dc2626' : active === i ? '#1d4ed8' : 'none'} strokeWidth="1.5" />
              <rect x={x(i) - 6} y={pad.t} width="12" height={innerH} fill="transparent" />
            </g>
          );
        })}
        {active !== null && points[active] && (
          <g pointerEvents="none">
            {(() => {
              const p = points[active];
              const yy = yz(p);
              if (yy === null) return null;
              const tx = Math.min(x(active) + 8, width - 190);
              const ty = Math.max(yy - 44, pad.t);
              return (
                <g transform={`translate(${tx},${ty})`}>
                  <rect width="182" height="40" rx="3" fill="white" stroke="#d1d5db" />
                  <text x="6" y="14" fontSize="10" fill="#374151">
                    {p.performedAt.slice(0, 16).replace('T', ' ')}
                  </text>
                  <text x="6" y="30" fontSize="10" fill="#111827" className="num">
                    {p.raw.toFixed(3)} {p.z !== null ? ` (z ${p.z >= 0 ? '+' : ''}${p.z.toFixed(2)})` : ''}
                    {p.violatedRules.length > 0 ? `  ${p.violatedRules.join(', ')}` : ''}
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}
