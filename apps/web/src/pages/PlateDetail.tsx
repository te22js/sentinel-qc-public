/** Plate detail: side-by-side heat maps, effect bars with p-values, findings, Phase II. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { api, type PlateDetail } from '../api';
import { ErrorBox } from '../components/bits';
import { EffectBars, PlateHeatmap } from '../components/PlateViz';

export function PlateDetailPage() {
  const { plateId } = useParams({ strict: false }) as { plateId: string };
  const [highlight, setHighlight] = useState<string[]>([]);
  const q = useQuery({ queryKey: ['plate', plateId], queryFn: () => api.get<PlateDetail>(`/plates/${plateId}`) });

  const grids = useMemo(() => {
    if (!q.data) return null;
    const { rows, cols, wells } = q.data;
    const t: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const r: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const wt: string[][] = Array.from({ length: rows }, () => new Array(cols).fill('sample'));
    for (const w of wells) {
      t[w.row][w.col] = w.transformed_value;
      r[w.row][w.col] = w.residual;
      wt[w.row][w.col] = w.well_type;
    }
    return { t, r, wt };
  }, [q.data]);

  if (q.isLoading) return <p className="text-gray-400">Loading…</p>;
  if (q.isError) return <ErrorBox error={q.error} />;
  const p = q.data!;
  const a = p.analysis;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold">{p.source_filename}</h1>
        <p className="text-gray-500">
          {p.assay_name} · imported {p.imported_at.slice(0, 16).replace('T', ' ')} · transform {p.transform_used}
          {a?.params && ` · ${a.params.nSampleWells} sample wells · B = ${a.params.B} permutations`}
        </p>
      </div>

      {a?.params && a.params.ok === false && (
        <div className="border border-amber-300 bg-amber-50 text-amber-800 rounded px-3 py-2">{a.params.reason}</div>
      )}
      {a?.params.suppressedPValues && (
        <div className="border border-amber-300 bg-amber-50 text-amber-800 rounded px-3 py-2">
          This assay declares structured plating: sample placement is not exchangeable, so p-values are suppressed.
          Effects are shown descriptively only.
        </div>
      )}

      {grids && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card p-3">
            <PlateHeatmap grid={grids.t} wellTypes={grids.wt} title="Transformed values" highlight={highlight} />
          </div>
          <div className="card p-3">
            <PlateHeatmap grid={grids.r} wellTypes={grids.wt} center={0} title="Median-polish residuals" highlight={highlight} />
          </div>
        </div>
      )}

      {a && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card p-3">
            <EffectBars
              labels={'ABCDEFGH'.slice(0, p.rows).split('')}
              effects={a.rowEffects}
              pValues={a.pValues?.perRow ?? null}
              title="Row effects (transformed units)"
            />
          </div>
          <div className="card p-3">
            <EffectBars
              labels={Array.from({ length: p.cols }, (_, j) => String(j + 1))}
              effects={a.colEffects}
              pValues={a.pValues?.perCol ?? null}
              title="Column effects (transformed units)"
            />
          </div>
        </div>
      )}

      {a && (
        <div className="card p-3 space-y-2">
          <h2 className="font-medium text-gray-700">Findings</h2>
          {a.findings.length === 0 && (
            <p className="text-gray-500">
              No findings. {a.pValues && `All family p-values > ${0.01}: edge p = ${a.pValues.edge?.toFixed(3)}, gradient p = ${a.pValues.gradient?.toFixed(3)}, clustering p = ${a.pValues.moran?.toFixed(3)}.`}
            </p>
          )}
          {a.findings.map((f, i) => (
            <div
              key={i}
              className={`border-l-2 px-3 py-2 rounded-r cursor-pointer ${
                f.kind === 'local_outlier' ? 'border-gray-300 bg-gray-50' : 'border-red-600 bg-red-50'
              }`}
              onMouseEnter={() => setHighlight(f.wells)}
              onMouseLeave={() => setHighlight([])}
            >
              <p className="text-gray-800">{f.message}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">
                {f.kind.replace('_', ' ')}
                {f.wells.length > 0 && ` · wells ${f.wells.length > 6 ? `${f.wells.slice(0, 6).join(', ')}…` : f.wells.join(', ')}`}
                {f.p !== null && ` · threshold α = 0.01 per family`}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="card p-3 space-y-2">
        <h2 className="font-medium text-gray-700">Phase-II monitoring (T² / SPE)</h2>
        {a && a.t2 !== null && p.phase2Limits ? (
          <div className="flex gap-8 items-baseline">
            <Metric label="T²" value={a.t2} limit={p.phase2Limits.t2Ucl} />
            <Metric label="SPE" value={a.spe!} limit={p.phase2Limits.speUcl} />
            <span className="text-gray-400">
              model: {p.phase2Limits.n} plates, {p.phase2Limits.aComponents} components
            </span>
          </div>
        ) : (
          <p className="text-gray-500">
            {p.phase2Limits
              ? 'This plate was analysed before the Phase-II model existed — re-import to score it.'
              : 'No Phase-II model yet: it needs ≥30 validated (clean) plates for this assay, then “Rebuild” on the Plates page.'}
          </p>
        )}
      </div>

      <div>
        <button className="btn-secondary" onClick={() => api.post<any>('/reports/plate', { plateId }).then((r) => window.open(`/api/v1/reports/${r.id}/html`, '_blank'))}>
          Generate report
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, limit }: { label: string; value: number; limit: number }) {
  const over = value > limit;
  return (
    <span>
      <span className="text-gray-500">{label} </span>
      <span className={`num text-[18px] ${over ? 'text-red-600 font-semibold' : 'text-gray-800'}`}>{value.toFixed(2)}</span>
      <span className="text-gray-400 num"> / limit {limit.toFixed(2)}</span>
      {over && <span className="text-red-600"> — exceeds limit</span>}
    </span>
  );
}
