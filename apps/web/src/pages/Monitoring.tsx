/** Monitoring: Drift (EWMA) · CUSUM · Variance · Change points · Lot transitions. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MonitoringMaterial } from '../api';
import { Collapsed, EmptyState, ErrorBox, Field, Tabs, prettyRuleText } from '../components/bits';
import { CUSUMChart, ChangePointChart, EWMAChart, VarianceChart } from '../components/MonitorCharts';
import { useMe } from '../shell';

const TABS = ['Drift (EWMA)', 'CUSUM', 'Variance', 'Change points', 'Lot transitions'];

export function MonitoringPage() {
  const me = useMe();
  const [tab, setTab] = useState(TABS[0]);
  const [materialId, setMaterialId] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const materials = useQuery({
    queryKey: ['monitoring-materials'],
    queryFn: () => api.get<MonitoringMaterial[]>('/monitoring/materials'),
    enabled: me.data?.role !== 'technician',
  });

  if (me.data?.role === 'technician') {
    return <EmptyState message="Monitoring is available to supervisors. Ask a supervisor to review drift and change points." />;
  }

  const mats = materials.data ?? [];
  const selected = mats.find((m) => m.id === materialId) ?? mats.find((m) => m.n > 0) ?? mats[0];

  const downloadReport = async () => {
    if (!selected) return;
    setReportBusy(true);
    try {
      const res = await api.post<{ id: string }>('/reports/monitoring', { assayId: selected.assay_id });
      window.location.href = `/api/v1/reports/${res.id}/download`;
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Monitoring</h1>
          <p className="page-sub">Early-warning statistics over your entered runs — drift, accumulating shifts, imprecision, and change points.</p>
        </div>
        {selected && (
          <button className="btn-primary" disabled={reportBusy} onClick={downloadReport}>
            {reportBusy ? 'Generating…' : 'Download report (PDF)'}
          </button>
        )}
      </div>
      {mats.length === 0 && !materials.isLoading && (
        <EmptyState message="No runs yet - enter runs on the QC page and they appear here automatically." />
      )}
      {selected && (
        <>
          <div className="card p-3 space-y-1">
            <Field label="Series (assay · level)">
              <select value={selected.id} onChange={(e) => setMaterialId(e.target.value)}>
                {mats.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.assay_name} · {m.level_code} ({m.n} runs)
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-gray-400 text-[11px]">
              Imported live from the runs entered on the QC page — z-scores against the same control limits as the run
              log and report. Nothing extra to set up.
            </p>
          </div>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === 'Drift (EWMA)' && <EwmaTab assayId={selected.assay_id} materialId={selected.id} />}
          {tab === 'CUSUM' && <CusumTab assayId={selected.assay_id} materialId={selected.id} />}
          {tab === 'Variance' && <VarianceTab assayId={selected.assay_id} materialId={selected.id} />}
          {tab === 'Change points' && <CpTab assayId={selected.assay_id} materialId={selected.id} />}
          {tab === 'Lot transitions' && <LotTab assayId={selected.assay_id} materialId={selected.id} />}
        </>
      )}
    </div>
  );
}

function Summary({ text }: { text: string }) {
  return <p className="text-gray-800 text-[14px]">{prettyRuleText(text)}</p>;
}

function EwmaTab({ assayId, materialId }: { assayId: string; materialId: string }) {
  const [preset, setPreset] = useState<'default' | 'sensitive'>('default');
  const q = useQuery({
    queryKey: ['ewma', assayId, materialId, preset],
    queryFn: () => api.get<any>(`/monitoring/ewma?assayId=${assayId}&materialId=${materialId}&preset=${preset}`),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-gray-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <Summary text={q.data.summary} />
      <div className="card p-3">
        <EWMAChart points={q.data.ewma.points} />
      </div>
      <Collapsed title="Settings">
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <select value={preset} onChange={(e) => setPreset(e.target.value as 'default' | 'sensitive')}>
              <option value="default">λ = 0.2, L = 2.962 (ARL₀ ≈ 500)</option>
              <option value="sensitive">λ = 0.1, L = 2.814 (more sensitive to small shifts)</option>
            </select>
          </label>
          <p>λ — weight of the newest run; smaller values average over more history and see smaller shifts.</p>
          <p>L — limit width in multiples of the EWMA's standard deviation; sets the in-control alarm rate.</p>
          <p>Assumes independent, approximately normal z-scores; autocorrelation inflates false alarms.</p>
        </div>
      </Collapsed>
    </div>
  );
}

function CusumTab({ assayId, materialId }: { assayId: string; materialId: string }) {
  const [h, setH] = useState(5);
  const q = useQuery({
    queryKey: ['cusum', assayId, materialId, h],
    queryFn: () => api.get<any>(`/monitoring/cusum?assayId=${assayId}&materialId=${materialId}&h=${h}`),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-gray-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <Summary text={q.data.summary} />
      <div className="card p-3">
        <CUSUMChart points={q.data.cusum.points} h={h} />
      </div>
      <Collapsed title="Settings">
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            h (decision interval):
            <select value={h} onChange={(e) => setH(Number(e.target.value))}>
              <option value={5}>5 (ARL₀ ≈ 465)</option>
              <option value={4}>4 (ARL₀ ≈ 168, faster but noisier)</option>
            </select>
          </label>
          <p>k = 0.5 — tuned to detect a sustained 1 SD shift fastest (k = δ/2).</p>
          <p>The chart accumulates deviations beyond ±k; a side that exceeds h signals and resets.</p>
        </div>
      </Collapsed>
    </div>
  );
}

function VarianceTab({ assayId, materialId }: { assayId: string; materialId: string }) {
  const q = useQuery({
    queryKey: ['variance', assayId, materialId],
    queryFn: () => api.get<any>(`/monitoring/variance?assayId=${assayId}&materialId=${materialId}`),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-gray-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <Summary text={q.data.summary} />
      <div className="card p-3">
        <VarianceChart points={q.data.variance.points} ucl={q.data.variance.ucl} />
      </div>
      <Collapsed title="Settings">
        <div className="space-y-1">
          <p>EWMA of z² (λ = 0.2), one-sided upper limit {q.data.variance.ucl.toFixed(3)}, Monte-Carlo calibrated for ARL₀ ≈ 500.</p>
          <p>Detects increases in imprecision (random error) that mean-based rules miss (Neubauer 1997).</p>
        </div>
      </Collapsed>
    </div>
  );
}

function CpTab({ assayId, materialId }: { assayId: string; materialId: string }) {
  const q = useQuery({
    queryKey: ['cp', assayId, materialId],
    queryFn: () => api.get<any>(`/monitoring/changepoints?assayId=${assayId}&materialId=${materialId}`),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-gray-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <Summary text={q.data.summary} />
      <div className="card p-3">
        <ChangePointChart zs={q.data.series.map((p: any) => p.z)} segments={q.data.segments} />
      </div>
      <Collapsed title="Settings">
        <div className="space-y-1">
          <p>PELT with an L2 (mean-shift) cost; penalty β = 3·log n; minimum segment length 5 runs.</p>
          <p>A retrospective tool: it finds where the mean level of the series changed, for correlating with lot or instrument events (shown when within ±3 runs).</p>
        </div>
      </Collapsed>
    </div>
  );
}

function LotTab({ assayId, materialId }: { assayId: string; materialId: string }) {
  const q = useQuery({
    queryKey: ['lot-transition', assayId, materialId],
    queryFn: () => api.get<any>(`/monitoring/lot-transition?assayId=${assayId}&materialId=${materialId}`),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-gray-400">Loading…</p>;
  const d = q.data;
  return (
    <div className="space-y-3">
      <Summary text={d.summary} />
      {d.ok && (
        <div className="card p-3 space-y-2">
          <p className="text-gray-600">
            Lot <span className="num">{d.lotA}</span> → <span className="num">{d.lotB}</span> at{' '}
            <span className="num">{d.boundaryAt.slice(0, 10)}</span>
          </p>
          <table className="w-auto">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1 pr-6 font-normal"></th>
                <th className="py-1 pr-6 font-normal">Old lot (n={d.comparison.nA})</th>
                <th className="py-1 pr-6 font-normal">New lot (n={d.comparison.nB})</th>
                <th className="py-1 font-normal">Test</th>
              </tr>
            </thead>
            <tbody className="text-gray-700">
              <tr>
                <td className="py-1 pr-6 text-gray-500">Mean</td>
                <td className="py-1 pr-6 num">{d.comparison.welch.meanA.toFixed(4)}</td>
                <td className="py-1 pr-6 num">{d.comparison.welch.meanB.toFixed(4)}</td>
                <td className="py-1 num">Welch t = {d.comparison.welch.t.toFixed(2)}, p = {d.comparison.welch.p.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-6 text-gray-500">Variance</td>
                <td className="py-1 pr-6 num" colSpan={2}>
                  F = {d.comparison.fTest.f.toFixed(2)}
                </td>
                <td className="py-1 num">Levene p = {d.comparison.levene.p.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-6 text-gray-500">Bias</td>
                <td className="py-1 pr-6 num" colSpan={2}>
                  {d.comparison.biasPct >= 0 ? '+' : ''}
                  {d.comparison.biasPct.toFixed(2)}% (CI {d.comparison.biasCiLowPct.toFixed(2)} to {d.comparison.biasCiHighPct.toFixed(2)}%)
                </td>
                <td className="py-1 text-gray-500">
                  {d.comparison.allowableBiasPct !== null ? `allowable ±${d.comparison.allowableBiasPct}%` : 'no allowable bias set'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <Collapsed title="Settings">
        <p>
          Compares the last 20 observations of the old reagent lot with the first ≥10 of the new lot on the transformed scale.
          This is a control-material comparison, not a CLSI EP26 patient-sample protocol.
        </p>
      </Collapsed>
    </div>
  );
}
