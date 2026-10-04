/**
 * The main QC workspace — clean and entry-first:
 *   status line · entry card (date, technician, kit lot, IQC OD, cutoff OD → E-ratio)
 *   · newest-first run log with rule flags · Download report / Data CSV.
 * The Levey–Jennings chart opens on demand ("Open chart") and is embedded in the
 * report; it does not crowd the entry flow. Bulk paste / CSV import fold away below.
 * EWMA/CUSUM live under Monitoring; the plate anomaly detector under Plates.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Assay, type RunLogResponse } from '../api';
import { Collapsed, Combobox, ErrorBox, Field, prettyRule, prettyRuleText } from '../components/bits';
import { LJChart } from '../components/LJChart';

export function QCPage() {
  const qc = useQueryClient();
  const assays = useQuery({ queryKey: ['assays'], queryFn: () => api.get<Assay[]>('/assays') });
  const [assayId, setAssayId] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [chartOpen, setChartOpen] = useState(false);
  const [showNewAssay, setShowNewAssay] = useState(false);

  const effectiveAssay = assayId ?? assays.data?.[0]?.id ?? null;
  const selected = assays.data?.find((a) => a.id === effectiveAssay);
  const effectiveLevel = level || selected?.qcScheme.levels[0]?.level_code || '';

  const log = useQuery({
    queryKey: ['runlog', effectiveAssay, effectiveLevel],
    queryFn: () => api.get<RunLogResponse>(`/runlog?assayId=${effectiveAssay}&level=${encodeURIComponent(effectiveLevel)}`),
    enabled: !!effectiveAssay && !!effectiveLevel,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['runlog'] });
    qc.invalidateQueries({ queryKey: ['runs'] });
  };

  if (assays.data && assays.data.length === 0) {
    return (
      <div className="max-w-md mx-auto pt-12">
        <NewAssayCard
          title="Set up your first assay"
          subtitle="Name the test you run QC for — everything else is entered run by run."
          onCreated={(id) => {
            setAssayId(id);
            qc.invalidateQueries({ queryKey: ['assays'] });
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-60 flex-1 max-w-xs">
          <Field label="Assay">
            <Combobox
              items={assays.data ?? []}
              value={effectiveAssay}
              onChange={(id) => {
                setAssayId(id);
                setLevel('');
              }}
              display={(a) => a.name}
              placeholder="Type to search…"
            />
          </Field>
        </div>
        <button className="btn-secondary" title="Add another assay" onClick={() => setShowNewAssay(true)}>
          ＋ New
        </button>
        {selected && selected.qcScheme.levels.length > 1 && (
          <Field label="Level">
            <select value={effectiveLevel} onChange={(e) => setLevel(e.target.value)}>
              {selected.qcScheme.levels.map((l) => (
                <option key={l.level_code} value={l.level_code}>
                  {l.level_code}
                </option>
              ))}
            </select>
          </Field>
        )}
        {selected && (
          <div className="flex gap-2 ml-auto">
            <button className="btn-secondary" onClick={() => setChartOpen((v) => !v)}>
              {chartOpen ? 'Close chart' : 'Open chart'}
            </button>
            <ReportButton assay={selected} />
            <a
              className="btn-secondary"
              href={`/api/v1/export/history.csv?assayId=${selected.id}`}
              download={`${selected.name.replace(/\s+/g, '_')}_qc.csv`}
            >
              Data CSV
            </a>
          </div>
        )}
      </div>

      {showNewAssay && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/20" onClick={() => setShowNewAssay(false)}>
          <div className="w-[400px]" onClick={(e) => e.stopPropagation()}>
            <NewAssayCard
              title="New assay"
              subtitle=""
              onCreated={(id) => {
                setShowNewAssay(false);
                setAssayId(id);
                setLevel('');
                qc.invalidateQueries({ queryKey: ['assays'] });
              }}
            />
          </div>
        </div>
      )}

      {log.isError && <ErrorBox error={log.error} />}
      {selected && log.data && (
        <>
          <StatusStrip log={log.data} />
          {chartOpen && <ChartPanel key={selected.id} assay={selected} level={effectiveLevel} />}
          <EntryCard key={`${selected.id}-${effectiveLevel}`} assay={selected} log={log.data} onDone={refresh} />
          <RunLogTable log={log.data} />
          <Collapsed title="Bulk entry — paste many runs or import a CSV">
            <BulkPanels assay={selected} onDone={refresh} />
          </Collapsed>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- new assay

function NewAssayCard({ title, subtitle, onCreated }: { title: string; subtitle: string; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [useCutoff, setUseCutoff] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const profiles = await api.get<{ id: string; name: string }[]>('/profiles');
      const profileId = profiles.find((p) => p.name === 'N2_classic')?.id ?? profiles[0]?.id;
      const res = await api.post<{ id: string }>('/assays', {
        name: name.trim(),
        methodology: 'ELISA',
        units: 'OD',
        transform: useCutoff ? 'ratio_to_cutoff' : 'none',
        qcScheme: { levels: [{ level_code: 'IQC', replicates: 1 }] },
        westgardProfileId: profileId,
      });
      onCreated(res.id);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 space-y-3">
      <div>
        <h2 className="font-semibold text-[15px]">{title}</h2>
        {subtitle && <p className="text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      <Field label="Assay name">
        <input
          className="w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. HIV ELISA, HBsAg ELISA"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && create()}
        />
      </Field>
      <label className="flex items-start gap-2 text-gray-600 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={useCutoff} onChange={(e) => setUseCutoff(e.target.checked)} />
        <span>
          Uses a run cutoff — you enter IQC OD and cutoff OD, and the <span className="font-medium">E-ratio</span> (IQC ÷ cutoff)
          is charted
        </span>
      </label>
      {error && <ErrorBox error={error} />}
      <button className="btn-primary w-full" disabled={!name.trim() || busy} onClick={create}>
        {busy ? 'Creating…' : 'Create assay'}
      </button>
    </div>
  );
}

// -------------------------------------------------------------- status strip

function StatusStrip({ log }: { log: RunLogResponse }) {
  const st = log.status;
  const s = log.stats;
  return (
    <div className="card px-5 py-3 flex items-center gap-x-8 gap-y-2 flex-wrap">
      <span className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${st.inControl ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className={`font-semibold text-[15px] tracking-[-0.01em] ${st.inControl ? 'text-slate-900' : 'text-red-600'}`}>
          {st.inControl ? 'In Control' : 'Out of Control'}
        </span>
      </span>
      <span className="text-slate-400">{prettyRuleText(st.message)}</span>
      <span className="ml-auto flex gap-x-7">
        <Stat label="Runs" value={String(s.n)} />
        <Stat label={`Mean ${log.valueLabel}`} value={s.mean?.toFixed(3) ?? '—'} />
        <Stat label="SD" value={s.sd?.toFixed(3) ?? '—'} />
        <Stat label="CV" value={s.cv !== null ? `${s.cv.toFixed(2)}%` : '—'} />
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-right">
      <span className="microlabel block leading-3">{label}</span>
      <span className="num text-slate-900 text-[14px] font-medium">{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------- entry card

function EntryCard({ assay, log, onDone }: { assay: Assay; log: RunLogResponse; onDone: () => void }) {
  const isRatio = assay.transform === 'ratio_to_cutoff';
  const levels = assay.qcScheme.levels;
  const singleLevel = levels.length === 1;
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const last = log.rows[0] ?? null;
  const [technician, setTechnician] = useState(last?.technician ?? '');
  const [kitLot, setKitLot] = useState(last?.kitLot ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [cutoff, setCutoff] = useState('');
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  const firstValue = Number(values[levels[0]?.level_code] ?? NaN);
  const eratio = isRatio && firstValue > 0 && Number(cutoff) > 0 ? firstValue / Number(cutoff) : null;
  const complete =
    date !== '' &&
    levels.every((l) => {
      const s = values[l.level_code];
      return s !== undefined && s !== '' && Number.isFinite(Number(s));
    }) &&
    (!isRatio || Number(cutoff) > 0);

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ runId: string }>('/runs', {
        assayId: assay.id,
        performedAt: date === today ? new Date().toISOString() : `${date}T09:00:00Z`,
        values: Object.fromEntries(levels.map((l) => [l.level_code, [Number(values[l.level_code])]])),
        cutoff: isRatio ? Number(cutoff) : undefined,
        technician: technician.trim() || undefined,
        kitLot: kitLot.trim() || undefined,
      }),
    onSuccess: (res) => {
      setValues({});
      setCutoff('');
      setLastAdded(res.runId);
      onDone();
    },
  });

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && complete && !submit.isPending) submit.mutate();
  };

  const addedRow = lastAdded ? log.rows.find((r) => r.runId === lastAdded) : null;

  return (
    <div className="card p-4 space-y-4">
      <LabNameField />
      <div className="grid grid-cols-3 gap-3 max-w-xl">
        <Field label="Date">
          <input type="date" className="w-full" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Technician">
          <input className="w-full" value={technician} onChange={(e) => setTechnician(e.target.value)} placeholder="name" />
        </Field>
        <Field label="Kit lot">
          <input className="w-full num" value={kitLot} onChange={(e) => setKitLot(e.target.value)} placeholder="lot no." />
        </Field>
      </div>

      <div className="space-y-2">
        {levels.map((l) => (
          <div key={l.level_code} className="flex items-center gap-3">
            <span className="w-40 text-gray-600">
              {isRatio ? (singleLevel ? 'IQC OD' : `${l.level_code} OD`) : singleLevel ? `Value (${assay.units})` : l.level_code}
            </span>
            <input
              className="w-32 num"
              inputMode="decimal"
              aria-label={isRatio ? (singleLevel ? 'IQC OD' : `${l.level_code} OD`) : l.level_code}
              value={values[l.level_code] ?? ''}
              onChange={(e) => setValues({ ...values, [l.level_code]: e.target.value })}
              onKeyDown={onEnter}
            />
          </div>
        ))}
        {isRatio && (
          <div className="flex items-center gap-3">
            <span className="w-40 text-gray-600">Cutoff OD</span>
            <input
              className="w-32 num"
              inputMode="decimal"
              aria-label="Cutoff OD"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              onKeyDown={onEnter}
            />
            <span className="text-gray-400">
              E-ratio: <span className="num text-gray-700">{eratio !== null ? eratio.toFixed(3) : '—'}</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-gray-100 pt-3">
        <span aria-live="polite">
          {addedRow && (
            <span className="text-gray-700">
              Recorded {addedRow.performedAt.slice(0, 10)} — {log.valueLabel}{' '}
              <span className="num">{addedRow.value.toFixed(3)}</span>{' '}
              {addedRow.flags.length === 0 ? (
                <span className="text-green-600 font-medium">OK</span>
              ) : (
                addedRow.flags.map((f) => (
                  <span
                    key={f}
                    className={`inline-block ml-1 rounded px-1.5 py-0.5 text-[11px] ${f === '1_2s' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}
                  >
                    {prettyRule(f)}
                  </span>
                ))
              )}
            </span>
          )}
        </span>
        <button className="btn-primary" disabled={!complete || submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? 'Adding…' : 'Add run (Enter)'}
        </button>
      </div>
      {submit.isError && <ErrorBox error={submit.error} />}
    </div>
  );
}

// --------------------------------------------------------------- chart panel

function ChartPanel({ assay, level }: { assay: Assay; level: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = new URLSearchParams({ assayId: assay.id, level });
  if (from) params.set('from', `${from}T00:00:00Z`);
  if (to) params.set('to', `${to}T23:59:59Z`);
  const log = useQuery({
    queryKey: ['runlog', assay.id, level, from, to],
    queryFn: () => api.get<RunLogResponse>(`/runlog?${params.toString()}`),
  });
  const d = log.data;
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="mr-auto">
          <h2 className="font-medium text-gray-700">Levey–Jennings</h2>
          <p className="text-gray-400 text-[11px]">{d?.valueLabel ?? ''} vs control bands.</p>
        </div>
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {log.isError && <ErrorBox error={log.error} />}
      {d && d.series.length === 0 && <p className="text-gray-400 py-8 text-center">No runs in this range.</p>}
      {d && d.series.length > 0 && (
        <>
          <LJChart
            points={d.series.map((p) => ({
              z: p.z,
              raw: p.value,
              performedAt: p.performedAt,
              violatedRules: p.flags,
              verdict: p.flags.some((f) => f !== '1_2s') ? 'reject' : p.flags.length > 0 ? 'warning' : 'pass',
            }))}
            yMode="z"
            height={280}
            bandValues={d.limits?.bands ?? null}
          />
          {d.limits && (
            <div className="border-t border-gray-100 pt-2">
              <p className="text-gray-400 text-[11px] mb-1">
                {d.limits.source === 'self'
                  ? `Control limits from the mean and SD of the current ${d.limits.n} runs${d.limits.scale === 'log' ? ', computed on the log scale (geometric, asymmetric bands — correct for ratio data)' : ''}${(d.limits.excluded ?? 0) > 0 ? `; ${d.limits.excluded} gross outlier${d.limits.excluded === 1 ? '' : 's'} excluded from the estimate, still flagged` : ''}${d.limits.provisional ? ' — provisional, rule flags start at 6 runs' : ''}. Each run is judged against limits estimated from the other runs (leave-one-out), so a bad run cannot soften its own limits.`
                  : `Control limits from the frozen baseline (${d.limits.baselineMethod}${d.limits.n ? `, n=${d.limits.n}` : ''}).`}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-600">
                {(
                  [
                    ['+3SD', d.limits.bands.p3],
                    ['+2SD', d.limits.bands.p2],
                    ['+1SD', d.limits.bands.p1],
                    ['Mean', d.limits.bands.mean],
                    ['−1SD', d.limits.bands.m1],
                    ['−2SD', d.limits.bands.m2],
                    ['−3SD', d.limits.bands.m3],
                  ] as [string, number][]
                ).map(([label, v]) => (
                  <span key={label}>
                    <span className="text-gray-400">{label} </span>
                    <span className={`num ${label === 'Mean' ? 'text-gray-900 font-medium' : 'text-gray-700'}`}>{v.toFixed(3)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ run log

const RULE_TIPS: Record<string, string> = {
  '1_2s': 'One control beyond ±2SD — warning, inspect the run',
  '1_3s': 'Beyond ±3SD — random error, reject',
  '2_2s': 'Two consecutive beyond the same ±2SD limit — systematic error',
  R_4s: 'Opposite sides beyond ±2SD within a run — random error',
  '2of3_2s': 'Two of three beyond the same ±2SD limit',
  '3_1s': 'Three consecutive beyond ±1SD same side',
  '4_1s': 'Four consecutive beyond ±1SD same side',
  '6x': 'Six consecutive on the same side of the mean',
  '8x': 'Eight consecutive on the same side of the mean',
  '9x': 'Nine consecutive on the same side of the mean',
  '10x': 'Ten consecutive on the same side of the mean',
  '12x': 'Twelve consecutive on the same side of the mean',
  '7T': 'Seven strictly trending',
};

function RunLogTable({ log }: { log: RunLogResponse }) {
  const isRatio = log.valueLabel === 'E-ratio';
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null); // obsId being edited
  const [editRaw, setEditRaw] = useState('');
  const [editCutoff, setEditCutoff] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (obsId: string) =>
      api.post(`/observations/${obsId}/correct`, {
        rawValue: Number(editRaw),
        cutoff: isRatio && editCutoff.trim() !== '' ? Number(editCutoff) : undefined,
      }),
    onSuccess: () => {
      setEditing(null);
      setEditError(null);
      qc.invalidateQueries();
    },
    onError: (err) => setEditError(err instanceof Error ? err.message : 'correction failed'),
  });

  const startEdit = (obsId: string, raw: number, cutoff: number | null) => {
    setEditing(obsId);
    setEditRaw(String(raw));
    setEditCutoff(cutoff !== null ? String(cutoff) : '');
    setEditError(null);
  };
  const rawOk = Number.isFinite(Number(editRaw)) && editRaw.trim() !== '';
  const cutoffOk = !isRatio || (editCutoff.trim() !== '' && Number(editCutoff) > 0);
  const onEditKey = (e: React.KeyboardEvent, obsId: string) => {
    if (e.key === 'Enter' && rawOk && cutoffOk && !save.isPending) save.mutate(obsId);
    if (e.key === 'Escape') setEditing(null);
  };

  if (log.rows.length === 0) {
    return <div className="card p-6 text-gray-500">No runs yet — add the first one above.</div>;
  }
  return (
    <div className="card">
      <div className="px-3 pt-3 pb-1">
        <h2 className="font-semibold text-slate-900 tracking-[-0.01em]">QC Run Log</h2>
      </div>
      <div className="overflow-x-auto p-1">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="th-min">Run</th>
              <th className="th-min">Date</th>
              <th className="th-min">Technician</th>
              <th className="th-min">Kit lot</th>
              {isRatio ? (
                <>
                  <th className="th-min">IQC OD</th>
                  <th className="th-min">Cutoff OD</th>
                  <th className="th-min">E-ratio</th>
                </>
              ) : (
                <>
                  <th className="th-min">Value</th>
                  <th className="th-min">z</th>
                </>
              )}
              <th className="th-min">Flags</th>
              <th className="th-min"></th>
            </tr>
          </thead>
          <tbody>
            {log.rows.map((r) => {
              const isEditing = editing === r.obsId;
              return (
              <tr key={r.runId + r.runNo} className="border-b border-slate-100 hover:bg-slate-50/60">
                <td className="px-2 py-1.5 num text-slate-400">{r.runNo}</td>
                <td className="px-2 py-1.5 num text-slate-700 whitespace-nowrap">{r.performedAt.slice(0, 10)}</td>
                <td className="px-2 py-1.5 text-slate-700">{r.technician ?? '—'}</td>
                <td className="px-2 py-1.5 num text-slate-500">{r.kitLot ?? '—'}</td>
                {isRatio ? (
                  <>
                    <td className="px-2 py-1.5 num">
                      {isEditing ? (
                        <input className="w-20 num" autoFocus value={editRaw} onChange={(e) => setEditRaw(e.target.value)} onKeyDown={(e) => onEditKey(e, r.obsId)} aria-label="Edit IQC OD" />
                      ) : (
                        r.raw.toFixed(3)
                      )}
                    </td>
                    <td className="px-2 py-1.5 num">
                      {isEditing ? (
                        <input className="w-20 num" value={editCutoff} onChange={(e) => setEditCutoff(e.target.value)} onKeyDown={(e) => onEditKey(e, r.obsId)} aria-label="Edit cutoff OD" />
                      ) : (
                        r.cutoff?.toFixed(3) ?? '—'
                      )}
                    </td>
                    <td className="px-2 py-1.5 num font-medium">
                      {isEditing
                        ? rawOk && cutoffOk
                          ? (Number(editRaw) / Number(editCutoff)).toFixed(3)
                          : '—'
                        : r.value.toFixed(3)}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-2 py-1.5 num">
                      {isEditing ? (
                        <input className="w-20 num" autoFocus value={editRaw} onChange={(e) => setEditRaw(e.target.value)} onKeyDown={(e) => onEditKey(e, r.obsId)} aria-label="Edit value" />
                      ) : (
                        r.raw.toFixed(3)
                      )}
                    </td>
                    <td className="px-2 py-1.5 num">{r.z !== null ? (r.z >= 0 ? '+' : '') + r.z.toFixed(2) : '—'}</td>
                  </>
                )}
                <td className="px-2 py-1.5">
                  {r.flags.length === 0 ? (
                    <span className="text-green-600 font-medium">OK</span>
                  ) : (
                    r.flags.map((f) => (
                      <span
                        key={f}
                        title={RULE_TIPS[f] ?? f}
                        className={`inline-block mr-1 rounded px-1.5 py-0.5 text-[11px] ${
                          f === '1_2s' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {prettyRule(f)}
                      </span>
                    ))
                  )}
                  {r.overrideStatus === 'accepted' && <span className="text-gray-400 text-[11px]"> accepted</span>}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-right">
                  {isEditing ? (
                    <span className="inline-flex items-center gap-1">
                      <button
                        className="rounded px-1.5 py-0.5 text-[12px] font-medium bg-blue-700 text-white disabled:opacity-40"
                        disabled={!rawOk || !cutoffOk || save.isPending}
                        onClick={() => save.mutate(r.obsId)}
                        title="Save correction"
                      >
                        {save.isPending ? '…' : 'Save'}
                      </button>
                      <button className="rounded px-1.5 py-0.5 text-[12px] text-slate-500 hover:text-slate-800" onClick={() => setEditing(null)} title="Cancel">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="text-slate-300 hover:text-blue-700 align-middle"
                      title="Edit this run's values (kept as an audited correction)"
                      onClick={() => startEdit(r.obsId, r.raw, r.cutoff)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {editError && editing && <p className="px-3 pb-2 text-red-600 text-[12px]">{editError}</p>}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- report

/**
 * The lab / blood bank name lives with the report data (no separate admin):
 * loaded once, autosaved on blur, and printed as the report header.
 */
function LabNameField() {
  const qc = useQueryClient();
  const lab = useQuery({ queryKey: ['laboratory'], queryFn: () => api.get<{ name: string }>('/laboratory') });
  const stored = lab.data?.name === 'Sentinel QC Laboratory' ? '' : (lab.data?.name ?? '');
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = value ?? stored;

  const save = async () => {
    const next = (value ?? '').trim();
    if (value === null || next === stored || next === '') return;
    await api.patch('/laboratory', { name: next });
    qc.invalidateQueries({ queryKey: ['laboratory'] });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="max-w-xl">
      <Field label="Lab / blood bank name (printed on the report)">
        <div className="flex items-center gap-2">
          <input
            className="w-full"
            value={current}
            placeholder="e.g. Blood Center, District Hospital"
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {saved && <span className="text-green-600 text-[11px]">saved</span>}
        </div>
      </Field>
    </div>
  );
}

function ReportButton({ assay }: { assay: Assay }) {
  const [busy, setBusy] = useState(false);
  const report = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>('/reports/assay', { assayId: assay.id });
      // navigating to the download endpoint saves the PDF with its proper filename
      window.location.href = `/api/v1/reports/${res.id}/download`;
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn-primary" disabled={busy} onClick={report}>
      {busy ? 'Generating…' : 'Download report (PDF)'}
    </button>
  );
}

// ------------------------------------------------------- bulk (batch + CSV)

function BulkPanels({ assay, onDone }: { assay: Assay; onDone: () => void }) {
  const [tab, setTab] = useState<'paste' | 'csv'>('paste');
  return (
    <div className="space-y-3 pt-1">
      <div className="flex gap-2">
        <button className={tab === 'paste' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('paste')}>
          Paste values
        </button>
        <button className={tab === 'csv' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('csv')}>
          CSV file
        </button>
      </div>
      {tab === 'paste' ? <BatchPanel assay={assay} onDone={onDone} /> : <CsvPanel assay={assay} onDone={onDone} />}
    </div>
  );
}

interface BatchResponse {
  ok: boolean;
  created: number;
  verdicts: Record<string, number>;
  firstError?: string;
}

function BatchPanel({ assay, onDone }: { assay: Assay; onDone: () => void }) {
  const isRatio = assay.transform === 'ratio_to_cutoff';
  const levels = assay.qcScheme.levels.map((l) => l.level_code);
  const [text, setText] = useState<Record<string, string>>({});
  const [cutoffText, setCutoffText] = useState('');
  const [datesText, setDatesText] = useState('');
  const [technician, setTechnician] = useState('');
  const [kitLot, setKitLot] = useState('');
  const [result, setResult] = useState<BatchResponse | null>(null);

  const parseCol = (s: string) =>
    s
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter((x) => x !== '');

  const parsed = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const l of levels) out[l] = parseCol(text[l] ?? '').map(Number);
    return out;
  }, [text, levels]);
  const cutoffs = useMemo(() => parseCol(cutoffText).map(Number), [cutoffText]);
  const dates = useMemo(() => parseCol(datesText), [datesText]);

  const counts = levels.map((l) => parsed[l].length);
  const n = counts[0] ?? 0;
  const aligned = new Set(counts).size === 1 && n > 0;
  const cutoffOk = !isRatio || cutoffs.length === n;
  const datesOk = dates.length === 0 || dates.length === n;
  const anyBad =
    levels.some((l) => parsed[l].some((v) => !Number.isFinite(v))) ||
    (isRatio && cutoffs.some((v) => !Number.isFinite(v)));

  const submit = useMutation({
    mutationFn: () =>
      api.post<BatchResponse>('/batch-entry', {
        assayId: assay.id,
        valuesByLevel: parsed,
        cutoffs: isRatio ? cutoffs : undefined,
        dates: dates.length > 0 ? dates : undefined,
        technician: technician.trim() || undefined,
        kitLot: kitLot.trim() || undefined,
      }),
    onSuccess: (res) => {
      setResult(res);
      onDone();
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-gray-600">
        Paste one value per line, straight from Excel. Optional date column (YYYY-MM-DD) keeps your real bench dates;
        without it, rows land on consecutive days ending today.
      </p>
      <div className="flex gap-3 flex-wrap">
        <Field label="Dates (optional)">
          <textarea className="w-32 h-40 num" placeholder={'2025-08-25\n2025-08-31\n…'} value={datesText} onChange={(e) => { setDatesText(e.target.value); setResult(null); }} />
        </Field>
        {levels.map((l) => (
          <Field key={l} label={`${isRatio ? (levels.length === 1 ? 'IQC OD' : `${l} OD`) : l} (${parsed[l].length})`}>
            <textarea className="w-32 h-40 num" placeholder={'1.263\n1.990\n…'} value={text[l] ?? ''} onChange={(e) => { setText({ ...text, [l]: e.target.value }); setResult(null); }} />
          </Field>
        ))}
        {isRatio && (
          <Field label={`Cutoff OD (${cutoffs.length})`}>
            <textarea className="w-32 h-40 num" placeholder={'0.201\n0.212\n…'} value={cutoffText} onChange={(e) => { setCutoffText(e.target.value); setResult(null); }} />
          </Field>
        )}
        <div className="space-y-2">
          <Field label="Technician">
            <input className="w-32" value={technician} onChange={(e) => setTechnician(e.target.value)} />
          </Field>
          <Field label="Kit lot">
            <input className="w-32 num" value={kitLot} onChange={(e) => setKitLot(e.target.value)} />
          </Field>
        </div>
      </div>
      {!aligned && counts.some((c) => c > 0) && <p className="text-amber-600">Value columns have different row counts.</p>}
      {!cutoffOk && n > 0 && <p className="text-amber-600">Cutoff column needs {n} rows (has {cutoffs.length}).</p>}
      {!datesOk && <p className="text-amber-600">Date column needs {n} rows (has {dates.length}).</p>}
      {anyBad && <p className="text-red-600">Some values are not numbers.</p>}
      <button className="btn-primary" disabled={!aligned || !cutoffOk || !datesOk || anyBad || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? 'Evaluating…' : `Add ${aligned ? n : ''} runs`}
      </button>
      {submit.isError && <ErrorBox error={submit.error} />}
      {result && (
        <p className="text-gray-800" aria-live="polite">
          <span className="num">{result.created}</span> runs added — see the log and status above.
          {result.firstError && <span className="text-amber-600"> Some rows skipped: {result.firstError}</span>}
        </p>
      )}
    </div>
  );
}

function CsvPanel({ assay, onDone }: { assay: Assay; onDone: () => void }) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [mapping, setMapping] = useState({ performedAt: '', level: '', value: '' });
  const [preview, setPreview] = useState<any>(null);
  const [commitResult, setCommitResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const header: string[] = content ? content.split('\n')[0].split(',').map((s) => s.trim()) : [];

  const validate = async () => {
    setError(null);
    setCommitResult(null);
    try {
      const res = await api.post<any>('/import/validate', { assayId: assay.id, content, mapping });
      if (!res.ok) setError(res.error);
      else setPreview(res);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const commit = async () => {
    setError(null);
    try {
      const res = await api.post<any>('/import/commit', { assayId: assay.id, content, mapping });
      setCommitResult(res);
      onDone();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-gray-600">
        CSV with a timestamp column, a level column and a value column. Rows sharing a timestamp become one run.
      </p>
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="CSV file">
          <input
            type="file"
            accept=".csv,.txt,.tsv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setContent(await f.text());
                setFilename(f.name);
                setPreview(null);
                setCommitResult(null);
              }
            }}
          />
        </Field>
        {(['performedAt', 'level', 'value'] as const).map((k) => (
          <Field key={k} label={k === 'performedAt' ? 'Timestamp column' : k === 'level' ? 'Level column' : 'Value column'}>
            <select value={mapping[k]} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })} disabled={!content}>
              <option value="">Choose…</option>
              {header.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <button className="btn-secondary" disabled={!content || !mapping.performedAt || !mapping.level || !mapping.value} onClick={validate}>
          Validate
        </button>
      </div>
      {filename && <p className="text-gray-400">{filename} loaded</p>}
      {error && <ErrorBox error={error} />}
      {preview && !commitResult && (
        <div className="space-y-2">
          <p className="text-gray-600">
            {preview.rows.length} rows · {preview.runsToCreate} runs will be created ·{' '}
            {preview.rows.filter((r: any) => r.status === 'error').length} error rows will be skipped
          </p>
          <div className="max-h-56 overflow-y-auto border border-gray-200 rounded">
            <table className="w-full">
              <tbody>
                {preview.rows.map((r: any) => (
                  <tr key={r.rowIndex} className={r.status === 'error' ? 'bg-red-50' : r.status === 'warning' ? 'bg-amber-50' : 'bg-green-50/40'}>
                    <td className="px-2 py-0.5 num text-gray-500">{r.rowIndex}</td>
                    <td className="px-2 py-0.5 num text-gray-700">
                      {r.parsed ? `${r.parsed.performedAt.slice(0, 16)} · ${r.parsed.level} · ${r.parsed.value}` : '—'}
                    </td>
                    <td className="px-2 py-0.5 text-gray-600">{r.messages.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn-primary" onClick={commit}>
            Commit import
          </button>
        </div>
      )}
      {commitResult && (
        <p className="text-gray-800" aria-live="polite">
          Imported <span className="num">{commitResult.created}</span> runs; <span className="num">{commitResult.skipped}</span>{' '}
          rows skipped — see the log and status above.
        </p>
      )}
    </div>
  );
}
