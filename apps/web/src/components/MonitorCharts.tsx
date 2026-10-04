/** EWMA, CUSUM, variance and change-point charts — one restrained SVG idiom. */
import { useMemo } from 'react';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';

const W = 900;
const H = 260;
const PAD = { l: 44, r: 12, t: 10, b: 24 };

function frame(yTicks: { v: number; label: string }[], y: (v: number) => number) {
  return (
    <>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t.v)} y2={y(t.v)} stroke="#e5e7eb" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(t.v) + 3} textAnchor="end" fontSize="10" fill="#6b7280" className="num">
            {t.label}
          </text>
        </g>
      ))}
    </>
  );
}

export function EWMAChart({ points }: { points: { t: number; e: number; ucl: number; lcl: number; signal: boolean }[] }) {
  const x = useMemo(() => scaleLinear().domain([1, Math.max(points.length, 2)]).range([PAD.l, W - PAD.r]), [points.length]);
  const maxY = Math.max(1.2, ...points.map((p) => Math.max(Math.abs(p.e), p.ucl))) * 1.1;
  const y = useMemo(() => scaleLinear().domain([-maxY, maxY]).range([H - PAD.b, PAD.t]), [maxY]);
  const mk = (acc: (p: (typeof points)[0]) => number) =>
    line<(typeof points)[0]>()
      .x((p) => x(p.t))
      .y((p) => y(acc(p)))(points) ?? '';
  if (points.length === 0) return <NoData />;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {frame(
        [-maxY / 1.1, 0, maxY / 1.1].map((v) => ({ v, label: v.toFixed(1) })),
        y,
      )}
      <path d={mk((p) => p.ucl)} fill="none" stroke="#9ca3af" strokeWidth="1" strokeDasharray="3,3" />
      <path d={mk((p) => p.lcl)} fill="none" stroke="#9ca3af" strokeWidth="1" strokeDasharray="3,3" />
      <path d={mk((p) => p.e)} fill="none" stroke="#1d4ed8" strokeWidth="1" />
      {points.filter((p) => p.signal).map((p) => (
        <circle key={p.t} cx={x(p.t)} cy={y(p.e)} r="4" fill="none" stroke="#dc2626" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

export function CUSUMChart({ points, h }: { points: { t: number; cPlus: number; cMinus: number; signal: string }[]; h: number }) {
  const x = useMemo(() => scaleLinear().domain([1, Math.max(points.length, 2)]).range([PAD.l, W - PAD.r]), [points.length]);
  const maxY = Math.max(h * 1.3, ...points.map((p) => Math.max(p.cPlus, p.cMinus))) * 1.05;
  const y = useMemo(() => scaleLinear().domain([0, maxY]).range([H - PAD.b, PAD.t]), [maxY]);
  if (points.length === 0) return <NoData />;
  const mk = (acc: (p: (typeof points)[0]) => number) =>
    line<(typeof points)[0]>()
      .x((p) => x(p.t))
      .y((p) => y(acc(p)))(points) ?? '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {frame([0, h, maxY / 1.05].map((v) => ({ v, label: v.toFixed(0) })), y)}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(h)} y2={y(h)} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3,3" />
      <path d={mk((p) => p.cPlus)} fill="none" stroke="#1d4ed8" strokeWidth="1" />
      <path d={mk((p) => p.cMinus)} fill="none" stroke="#7c3aed" strokeWidth="1" />
      {points.filter((p) => p.signal !== 'none').map((p) => (
        <circle key={p.t} cx={x(p.t)} cy={y(p.signal === 'up' ? p.cPlus : p.cMinus)} r="4" fill="none" stroke="#dc2626" strokeWidth="1.5" />
      ))}
      <text x={W - PAD.r} y={PAD.t + 10} textAnchor="end" fontSize="10" fill="#1d4ed8">C+</text>
      <text x={W - PAD.r} y={PAD.t + 22} textAnchor="end" fontSize="10" fill="#7c3aed">C−</text>
    </svg>
  );
}

export function VarianceChart({ points, ucl }: { points: { t: number; v: number; signal: boolean }[]; ucl: number }) {
  const x = useMemo(() => scaleLinear().domain([1, Math.max(points.length, 2)]).range([PAD.l, W - PAD.r]), [points.length]);
  const maxY = Math.max(ucl * 1.2, ...points.map((p) => p.v)) * 1.05;
  const y = useMemo(() => scaleLinear().domain([0, maxY]).range([H - PAD.b, PAD.t]), [maxY]);
  if (points.length === 0) return <NoData />;
  const d = line<(typeof points)[0]>().x((p) => x(p.t)).y((p) => y(p.v))(points) ?? '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {frame([0, 1, ucl].map((v) => ({ v, label: v.toFixed(2) })), y)}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(ucl)} y2={y(ucl)} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3,3" />
      <path d={d} fill="none" stroke="#1d4ed8" strokeWidth="1" />
      {points.filter((p) => p.signal).map((p) => (
        <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r="4" fill="none" stroke="#dc2626" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

export function ChangePointChart({
  zs,
  segments,
}: {
  zs: number[];
  segments: { start: number; end: number; mean: number }[];
}) {
  const x = useMemo(() => scaleLinear().domain([0, Math.max(zs.length - 1, 1)]).range([PAD.l, W - PAD.r]), [zs.length]);
  const y = useMemo(() => scaleLinear().domain([-4, 4]).range([H - PAD.b, PAD.t]), []);
  if (zs.length === 0) return <NoData />;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {frame([-3, -2, -1, 0, 1, 2, 3].map((v) => ({ v, label: String(v) })), y)}
      {zs.map((z, i) => (
        <circle key={i} cx={x(i)} cy={y(Math.max(-4, Math.min(4, z)))} r="2" fill="#9ca3af" />
      ))}
      {segments.map((s, i) => (
        <line key={i} x1={x(s.start)} x2={x(Math.max(s.end - 1, s.start))} y1={y(s.mean)} y2={y(s.mean)} stroke="#1d4ed8" strokeWidth="1.5" />
      ))}
      {segments.slice(1).map((s, i) => (
        <line key={i} x1={x(s.start)} x2={x(s.start)} y1={PAD.t} y2={H - PAD.b} stroke="#dc2626" strokeWidth="1" strokeDasharray="4,3" />
      ))}
    </svg>
  );
}

function NoData() {
  return <div className="text-gray-400 py-16 text-center">Not enough data yet.</div>;
}
