/** History: dense filterable table, run detail drawer, CSV import wizard. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Assay, type RunListItem } from '../api';
import { EmptyState, ErrorBox, Field, VerdictWord, ZChip, prettyRule } from '../components/bits';
import { useMe } from '../shell';

export function HistoryPage() {
  const [filters, setFilters] = useState({ assayId: '', verdict: '', from: '', to: '' });
  const [drawerRun, setDrawerRun] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const assays = useQuery({ queryKey: ['assays'], queryFn: () => api.get<Assay[]>('/assays') });
  const params = new URLSearchParams();
  if (filters.assayId) params.set('assayId', filters.assayId);
  if (filters.verdict) params.set('verdict', filters.verdict);
  if (filters.from) params.set('from', `${filters.from}T00:00:00Z`);
  if (filters.to) params.set('to', `${filters.to}T23:59:59Z`);
  const runs = useQuery({
    queryKey: ['runs', filters],
    queryFn: () => api.get<RunListItem[]>(`/runs?${params.toString()}`),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div><h1 className="page-title">History</h1><p className="page-sub">Every run in this workspace — click a row for details, corrections and overrides.</p></div>
        <div className="flex gap-2">
          {filters.assayId && (
            <a className="btn-secondary" href={`/api/v1/export/history.csv?assayId=${filters.assayId}`} download>
              Export CSV
            </a>
          )}
          <button className="btn-secondary" onClick={() => setShowImport(true)}>
            Import CSV
          </button>
        </div>
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <Field label="Assay">
          <select value={filters.assayId} onChange={(e) => setFilters({ ...filters, assayId: e.target.value })}>
            <option value="">All</option>
            {assays.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Verdict">
          <select value={filters.verdict} onChange={(e) => setFilters({ ...filters, verdict: e.target.value })}>
            <option value="">All</option>
            <option value="pass">Pass</option>
            <option value="warning">Warning</option>
            <option value="reject">Reject</option>
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </Field>
      </div>

      {runs.isError && <ErrorBox error={runs.error} />}
      {runs.data && runs.data.length === 0 && <EmptyState message="No runs match these filters." />}
      {runs.data && runs.data.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="px-3 py-1.5 font-normal">Date</th>
                <th className="px-3 py-1.5 font-normal">Assay</th>
                <th className="px-3 py-1.5 font-normal">Levels</th>
                <th className="px-3 py-1.5 font-normal">Verdict</th>
                <th className="px-3 py-1.5 font-normal">Operator</th>
                <th className="px-3 py-1.5 font-normal">Instrument</th>
                <th className="px-3 py-1.5 font-normal">Reagent lot</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setDrawerRun(r.id)}
                >
                  <td className="px-3 py-1 num text-gray-600 whitespace-nowrap">{r.performed_at.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-3 py-1">{r.assay}</td>
                  <td className="px-3 py-1 whitespace-nowrap">
                    {r.observations.map((o, i) => (
                      <ZChip key={i} level={o.level} z={o.z} />
                    ))}
                  </td>
                  <td className="px-3 py-1">
                    <VerdictWord verdict={r.verdict} override={r.override_status} />
                  </td>
                  <td className="px-3 py-1 text-gray-600">{r.operator}</td>
                  <td className="px-3 py-1 text-gray-600">{r.instrument ?? '—'}</td>
                  <td className="px-3 py-1 text-gray-600 num">{r.reagentLot ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerRun && <RunDrawer runId={drawerRun} onClose={() => setDrawerRun(null)} />}
      {showImport && <ImportWizard assays={assays.data ?? []} onClose={() => setShowImport(false)} />}
    </div>
  );
}

function RunDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['run', runId], queryFn: () => api.get<Record<string, any>>(`/runs/${runId}`) });
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const correct = useMutation({
    mutationFn: () => api.post(`/observations/${correcting}/correct`, { rawValue: Number(newValue), reason }),
    onSuccess: () => {
      setCorrecting(null);
      qc.invalidateQueries({ queryKey: ['run', runId] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const [overrideReason, setOverrideReason] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const override = useMutation({
    mutationFn: () => api.post(`/runs/${runId}/override`, { reason: overrideReason }),
    onSuccess: () => {
      setShowOverride(false);
      qc.invalidateQueries({ queryKey: ['run', runId] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['runlog'] });
    },
  });
  const r = q.data;
  return (
    <div className="fixed inset-0 z-30 flex" onClick={onClose}>
      <div className="flex-1 bg-black/20" />
      <div className="w-[480px] bg-white border-l border-gray-200 h-full overflow-y-auto p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Run detail</h2>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ✕
          </button>
        </div>
        {q.isLoading && <p className="text-gray-400">Loading…</p>}
        {r && (
          <>
            <div className="text-gray-600 space-y-0.5">
              <p>
                <span className="font-medium text-gray-800">{r.assay_name}</span> · {r.performed_at.slice(0, 16).replace('T', ' ')}
              </p>
              <p>
                <VerdictWord verdict={r.verdict} override={r.override_status} />
              </p>
              {r.override_reason && (
                <p className="text-gray-500">
                  Override by {r.override_by_name}: “{r.override_reason}”
                </p>
              )}
              {r.verdict === 'reject' && r.override_status !== 'accepted' && me.data?.role !== 'technician' && (
                <div className="pt-1">
                  {!showOverride ? (
                    <button className="text-red-700 hover:underline" onClick={() => setShowOverride(true)}>
                      Supervisor override — accept this run
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <Field label="Reason for accepting this rejected run (audited)">
                        <textarea className="w-full" rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                      </Field>
                      {override.isError && <ErrorBox error={override.error} />}
                      <button
                        className="btn-primary bg-red-700 hover:bg-red-800"
                        disabled={overrideReason.trim().length < 3 || override.isPending}
                        onClick={() => override.mutate()}
                      >
                        Accept run
                      </button>
                    </div>
                  )}
                </div>
              )}
              <p>
                Operator {r.operator} · {r.instrument ?? 'no instrument'} · reagent lot {r.reagent_lot ?? '—'}
              </p>
            </div>

            <div>
              <h3 className="font-medium text-gray-700 mb-1">Observations</h3>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-1 pr-2 font-normal">Level</th>
                    <th className="py-1 pr-2 font-normal">Raw</th>
                    <th className="py-1 pr-2 font-normal">z</th>
                    <th className="py-1 pr-2 font-normal">Flags</th>
                    <th className="py-1 font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {r.observations.map((o: any) => (
                    <tr key={o.id} className={`border-b border-gray-100 ${o.superseded ? 'opacity-40 line-through' : ''}`}>
                      <td className="py-1 pr-2">{o.level}</td>
                      <td className="py-1 pr-2 num">{o.raw_value.toFixed(4)}</td>
                      <td className="py-1 pr-2 num">{o.z === null ? '—' : o.z.toFixed(2)}</td>
                      <td className="py-1 pr-2 text-gray-500 text-[11px]">{JSON.parse(o.flags_json).join(', ')}</td>
                      <td className="py-1">
                        {!o.superseded && me.data?.role !== 'technician' && (
                          <button
                            className="text-blue-700 text-[11px] hover:underline"
                            onClick={() => {
                              setCorrecting(o.id);
                              setNewValue(String(o.raw_value));
                              setReason('');
                            }}
                          >
                            correct
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {correcting && (
              <div className="border border-gray-200 rounded p-3 space-y-2 bg-gray-50">
                <Field label="Corrected raw value">
                  <input className="num" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
                </Field>
                <Field label="Reason (audited)">
                  <input className="w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                {correct.isError && <ErrorBox error={correct.error} />}
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={reason.trim().length < 3 || correct.isPending} onClick={() => correct.mutate()}>
                    Save correction
                  </button>
                  <button className="btn-secondary" onClick={() => setCorrecting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div>
              <h3 className="font-medium text-gray-700 mb-1">Rules evaluated</h3>
              <ul className="space-y-0.5">
                {r.evaluations.map((e: any) => (
                  <li key={e.id} className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 inline-block w-2 h-2 rounded-full ${
                        e.status === 'reject' ? 'bg-red-600' : e.status === 'warning' ? 'bg-amber-500' : e.status === 'pass' ? 'bg-green-600' : 'bg-gray-300'
                      }`}
                    />
                    <span className="text-gray-700">
                      <span className="num">{prettyRule(e.rule)}</span> <span className="text-gray-400">({e.scope.replace('_', ' ')})</span>
                      {e.status !== 'pass' && e.status !== 'not_applicable' && <span className="block text-gray-500">{e.message}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="font-medium text-gray-700 mb-1">Audit trail</h3>
              <ul className="space-y-0.5 text-gray-500">
                {r.audit.map((a: any, i: number) => (
                  <li key={i}>
                    <span className="num">{a.at.slice(0, 16).replace('T', ' ')}</span> · {a.action}
                    {a.reason ? ` — “${a.reason}”` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ImportWizard({ assays, onClose }: { assays: Assay[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [assayId, setAssayId] = useState('');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [mapping, setMapping] = useState({ performedAt: '', level: '', value: '' });
  const [preview, setPreview] = useState<any>(null);
  const [commitResult, setCommitResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const header: string[] = preview?.header ?? (content ? content.split('\n')[0].split(',').map((s: string) => s.trim()) : []);

  const validate = async () => {
    setError(null);
    try {
      const res = await api.post<any>('/import/validate', { assayId, content, mapping });
      if (!res.ok) setError(res.error);
      else {
        setPreview(res);
        setStep(3);
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const commit = async () => {
    setError(null);
    try {
      const res = await api.post<any>('/import/commit', { assayId, content, mapping });
      setCommitResult(res);
      setStep(4);
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['today'] });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/20" onClick={onClose}>
      <div className="card w-[640px] max-h-[80vh] overflow-y-auto p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">CSV import — step {step} of 4</h2>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ✕
          </button>
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <Field label="Assay">
              <select className="w-full" value={assayId} onChange={(e) => setAssayId(e.target.value)}>
                <option value="">Choose…</option>
                {assays.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="CSV file">
              <input
                type="file"
                accept=".csv,.txt,.tsv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setContent(await f.text());
                    setFilename(f.name);
                  }
                }}
              />
            </Field>
            {filename && <p className="text-gray-500">{filename} loaded</p>}
            <button className="btn-primary" disabled={!assayId || !content} onClick={() => setStep(2)}>
              Next: map columns
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            {(['performedAt', 'level', 'value'] as const).map((k) => (
              <Field key={k} label={k === 'performedAt' ? 'Timestamp column' : k === 'level' ? 'Level column' : 'Value column'}>
                <select className="w-full" value={mapping[k]} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}>
                  <option value="">Choose…</option>
                  {header.map((hh) => (
                    <option key={hh} value={hh}>
                      {hh}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            {error && <ErrorBox error={error} />}
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="btn-primary" disabled={!mapping.performedAt || !mapping.level || !mapping.value} onClick={validate}>
                Validate
              </button>
            </div>
          </div>
        )}

        {step === 3 && preview && (
          <div className="space-y-3">
            <p className="text-gray-600">
              {preview.rows.length} rows · {preview.runsToCreate} runs will be created ·{' '}
              {preview.rows.filter((r: any) => r.status === 'error').length} errors will be skipped
            </p>
            <div className="max-h-72 overflow-y-auto border border-gray-200 rounded">
              <table className="w-full">
                <tbody>
                  {preview.rows.map((r: any) => (
                    <tr
                      key={r.rowIndex}
                      className={r.status === 'error' ? 'bg-red-50' : r.status === 'warning' ? 'bg-amber-50' : 'bg-green-50/40'}
                    >
                      <td className="px-2 py-0.5 num text-gray-500">{r.rowIndex}</td>
                      <td className="px-2 py-0.5">
                        {r.parsed ? (
                          <span className="num text-gray-700">
                            {r.parsed.performedAt.slice(0, 16)} · {r.parsed.level} · {r.parsed.value}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-0.5 text-gray-600">{r.messages.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <ErrorBox error={error} />}
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setStep(2)}>
                Back
              </button>
              <button className="btn-primary" onClick={commit}>
                Commit import
              </button>
            </div>
          </div>
        )}

        {step === 4 && commitResult && (
          <div className="space-y-3">
            <p className="text-gray-700">
              Imported <span className="num">{commitResult.created}</span> runs (
              <span className="num">{commitResult.verdicts.pass}</span> pass,{' '}
              <span className="num">{commitResult.verdicts.warning}</span> warning,{' '}
              <span className="num">{commitResult.verdicts.reject}</span> reject);{' '}
              <span className="num">{commitResult.skipped}</span> rows skipped.
            </p>
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
