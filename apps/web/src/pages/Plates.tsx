/** Plates: list of analysed plates + import + layout editor. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, type Assay, type PlateListItem } from '../api';
import { Collapsed, EmptyState, ErrorBox, Field } from '../components/bits';
import { useMe } from '../shell';

export function PlatesPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  const [showLayout, setShowLayout] = useState(false);
  const plates = useQuery({ queryKey: ['plates'], queryFn: () => api.get<PlateListItem[]>('/plates') });
  const assays = useQuery({ queryKey: ['assays'], queryFn: () => api.get<Assay[]>('/assays') });
  const rebuild = useMutation({
    mutationFn: (assayId: string) => api.post<any>('/plates/phase2/rebuild', { assayId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plates'] }),
  });
  const [exampleBusy, setExampleBusy] = useState(false);
  const loadExample = async () => {
    const assayId = assays.data?.[0]?.id;
    if (!assayId) return;
    setExampleBusy(true);
    try {
      const res = await api.post<{ faultPlateId: string }>('/plates/example', { assayId });
      await qc.invalidateQueries({ queryKey: ['plates'] });
      location.assign(`/plates/${res.faultPlateId}`);
    } finally {
      setExampleBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Plate anomaly detector</h1>
          <p className="page-sub max-w-xl">
            Scans a full 96-well reader export for row, column, edge and gradient artifacts that single control wells
            cannot see. Not sure what that means? Load the examples — one clean plate, one with a hidden fault.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={exampleBusy || !assays.data?.length} onClick={loadExample}>
            {exampleBusy ? 'Analysing…' : 'Load example plates'}
          </button>
          <button className="btn-primary" onClick={() => setShowImport(true)}>
            Import plate
          </button>
        </div>
      </div>

      {plates.isError && <ErrorBox error={plates.error} />}
      {plates.data && plates.data.length === 0 && (
        <EmptyState
          message="No plates analysed yet. Import a reader export (8×12 CSV), or load the example plates to see what a hidden fault looks like."
          action={
            <button className="btn-primary" disabled={exampleBusy} onClick={loadExample}>
              Load example plates
            </button>
          }
        />
      )}
      {plates.data && plates.data.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="px-3 py-1.5 font-normal">Imported</th>
                <th className="px-3 py-1.5 font-normal">File</th>
                <th className="px-3 py-1.5 font-normal">Assay</th>
                <th className="px-3 py-1.5 font-normal">Findings</th>
                <th className="px-3 py-1.5 font-normal">T² / SPE</th>
              </tr>
            </thead>
            <tbody>
              {plates.data.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1 num text-gray-600 whitespace-nowrap">{p.imported_at.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-3 py-1">
                    <Link to="/plates/$plateId" params={{ plateId: p.id }} className="text-blue-700 hover:underline">
                      {p.source_filename}
                    </Link>
                  </td>
                  <td className="px-3 py-1 text-gray-600">{p.assay_name}</td>
                  <td className="px-3 py-1">
                    {p.findingsCount > 0 ? (
                      <span className="text-red-600 font-medium">{p.findingsCount} spatial</span>
                    ) : (
                      <span className="text-green-600">clean</span>
                    )}
                    {p.outlierCount > 0 && <span className="text-gray-400"> · {p.outlierCount} outlier wells</span>}
                  </td>
                  <td className="px-3 py-1 num text-gray-600">
                    {p.t2 !== null ? `${p.t2.toFixed(1)} / ${p.spe?.toFixed(1)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {me.data?.role !== 'technician' && assays.data && assays.data.length > 0 && (
        <Collapsed title="Advanced — plate layouts & Phase-II model">
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn-secondary" onClick={() => setShowLayout(true)}>
                Layout editor
              </button>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">Phase-II model (needs ≥30 clean plates):</span>
              {assays.data.map((a) => (
                <button key={a.id} className="btn-secondary" disabled={rebuild.isPending} onClick={() => rebuild.mutate(a.id)}>
                  Rebuild for {a.name}
                </button>
              ))}
            </div>
            {rebuild.isError && <span className="text-red-600">{String((rebuild.error as Error).message)}</span>}
            {rebuild.data && (
              <span className="text-green-700">
                Model built: {rebuild.data.nPlates} plates, {rebuild.data.aComponents} components.
              </span>
            )}
          </div>
        </Collapsed>
      )}

      {showImport && <PlateImport assays={assays.data ?? []} onClose={() => setShowImport(false)} />}
      {showLayout && <LayoutEditor assays={assays.data ?? []} onClose={() => setShowLayout(false)} />}
    </div>
  );
}

function PlateImport({ assays, onClose }: { assays: Assay[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [assayId, setAssayId] = useState(assays[0]?.id ?? '');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [transform, setTransform] = useState<'log' | 'rank' | 'identity'>('log');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file || !assayId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<any>('/plates/import', {
        assayId,
        content: file.content,
        filename: file.name,
        transform,
      });
      qc.invalidateQueries({ queryKey: ['plates'] });
      onClose();
      location.assign(`/plates/${res.plateId}`);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/20" onClick={onClose}>
      <div className="card w-[480px] p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Import plate</h2>
        <Field label="Assay">
          <select className="w-full" value={assayId} onChange={(e) => setAssayId(e.target.value)}>
            {assays.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reader export (8×12 CSV/TSV)">
          <input
            type="file"
            accept=".csv,.txt,.tsv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setFile({ name: f.name, content: await f.text() });
            }}
          />
        </Field>
        <Field label="Transform">
          <select className="w-full" value={transform} onChange={(e) => setTransform(e.target.value as typeof transform)}>
            <option value="log">log (default; reader error is multiplicative)</option>
            <option value="rank">rank → normal scores (for plates dominated by extreme positives)</option>
            <option value="identity">identity (no transform)</option>
          </select>
        </Field>
        <p className="text-gray-400">
          The file is stripped to a numeric grid on import; files with text in sample cells are rejected.
        </p>
        {error && <ErrorBox error={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={!file || busy} onClick={submit}>
            {busy ? 'Analysing…' : 'Import & analyse'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const WELL_TYPES = ['sample', 'blank', 'neg_ctrl', 'pos_ctrl', 'calibrator', 'empty'] as const;
const WT_COLORS: Record<string, string> = {
  sample: '#dbeafe',
  blank: '#f3f4f6',
  neg_ctrl: '#dcfce7',
  pos_ctrl: '#fee2e2',
  calibrator: '#fef9c3',
  empty: '#ffffff',
};

function LayoutEditor({ assays, onClose }: { assays: Assay[]; onClose: () => void }) {
  const [assayId, setAssayId] = useState(assays[0]?.id ?? '');
  const [name, setName] = useState('Default layout');
  const [brush, setBrush] = useState<(typeof WELL_TYPES)[number]>('sample');
  const [grid, setGrid] = useState<string[][]>(() => {
    const g = Array.from({ length: 8 }, () => new Array(12).fill('sample'));
    g[0][0] = 'blank';
    g[1][0] = 'neg_ctrl';
    g[2][0] = 'neg_ctrl';
    g[3][0] = 'pos_ctrl';
    g[4][0] = 'pos_ctrl';
    return g;
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setError(null);
    try {
      await api.post('/layouts', { assayId, name, wellTypes: grid });
      setSaved(true);
      setTimeout(onClose, 700);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/20" onClick={onClose}>
      <div className="card w-[620px] p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Plate layout editor</h2>
        <div className="flex gap-3">
          <Field label="Assay">
            <select value={assayId} onChange={(e) => setAssayId(e.target.value)}>
              {assays.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Template name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {WELL_TYPES.map((wt) => (
            <button
              key={wt}
              className={`px-2 py-0.5 rounded border ${brush === wt ? 'border-blue-700 ring-1 ring-blue-700' : 'border-gray-300'}`}
              style={{ background: WT_COLORS[wt] }}
              onClick={() => setBrush(wt)}
            >
              {wt}
            </button>
          ))}
        </div>
        <div className="inline-grid grid-cols-[auto_repeat(12,1fr)] gap-0.5 select-none">
          <span />
          {Array.from({ length: 12 }, (_, j) => (
            <span key={j} className="text-center text-gray-400 num text-[10px]">
              {j + 1}
            </span>
          ))}
          {grid.map((row, i) => (
            <FragmentRow key={i} i={i} row={row} brush={brush} setGrid={setGrid} />
          ))}
        </div>
        {error && <ErrorBox error={error} />}
        <div className="flex gap-2 items-center">
          <button className="btn-primary" onClick={save}>
            Save template
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {saved && <span className="text-green-700">Saved.</span>}
        </div>
      </div>
    </div>
  );
}

function FragmentRow({
  i,
  row,
  brush,
  setGrid,
}: {
  i: number;
  row: string[];
  brush: string;
  setGrid: React.Dispatch<React.SetStateAction<string[][]>>;
}) {
  return (
    <>
      <span className="text-gray-400 num text-[10px] pr-1 self-center">{'ABCDEFGH'[i]}</span>
      {row.map((wt, j) => (
        <button
          key={j}
          className="w-9 h-7 border border-gray-300 text-[9px] text-gray-600"
          style={{ background: WT_COLORS[wt] }}
          title={`${'ABCDEFGH'[i]}${j + 1}: ${wt}`}
          onClick={() =>
            setGrid((g) => {
              const next = g.map((r) => r.slice());
              next[i][j] = brush;
              return next;
            })
          }
        >
          {wt === 'sample' ? '' : wt === 'blank' ? 'B' : wt === 'neg_ctrl' ? 'N' : wt === 'pos_ctrl' ? 'P' : wt === 'calibrator' ? 'C' : '·'}
        </button>
      ))}
    </>
  );
}
