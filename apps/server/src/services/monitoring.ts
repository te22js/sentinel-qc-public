/**
 * Supervisor monitoring: EWMA drift, CUSUM, variance EWMA, PELT change points and
 * lot-transition comparison, all on the standardized (z) series of one QC material.
 *
 * Sentences first, charts second: every endpoint returns a one-line plain-language
 * summary alongside the series.
 *
 * EWMA/CUSUM reset semantics: acknowledged signals mark a corrective action; the
 * series fed to the monitors restarts after the run of the latest acknowledged signal.
 */
import {
  ewma,
  cusum,
  varianceEwma,
  pelt,
  compareLots,
  EWMA_PRESETS,
  VARIANCE_EWMA_UCL,
} from '@sentinel/stats';
import { appendAudit, ulid } from '@sentinel/db';
import type Database from 'better-sqlite3';
import { makeSelfEval } from './runlog.js';

export interface SeriesPoint {
  observationId: string;
  runId: string;
  performedAt: string;
  z: number;
  reagentLotId: string | null;
}

/**
 * Monitoring series: ALL non-superseded observations, including rejected runs.
 * (Westgard look-back excludes rejected runs, but retrospective monitors must not —
 * a persistent shift causes rejections, and excluding those observations would hide
 * exactly the signal the supervisor is investigating.)
 *
 * The series imports straight from the runs entered on the QC page: when the level
 * has no frozen baseline (so no stored z), z is computed on the fly against
 * self-derived limits — the same limits the run log and report use. Zero setup.
 */
export function zSeries(sqlite: Database.Database, qcMaterialId: string, afterTime?: string): SeriesPoint[] {
  const rows = sqlite
    .prepare(
      `SELECT o.id as observationId, r.id as runId, r.performed_at as performedAt, o.z,
              o.transformed_value as x, r.reagent_lot_id as reagentLotId,
              a.transform as transform
       FROM observation o
       JOIN run r ON r.id = o.run_id
       JOIN qc_material m ON m.id = o.qc_material_id
       JOIN assay a ON a.id = m.assay_id
       WHERE o.qc_material_id = ? AND o.superseded = 0
         AND (? IS NULL OR r.performed_at > ?)
       ORDER BY r.performed_at ASC, r.id ASC, o.replicate_index ASC`,
    )
    .all(qcMaterialId, afterTime ?? null, afterTime ?? null) as (SeriesPoint & {
    x: number;
    z: number | null;
    transform: string;
  })[];
  if (rows.length === 0) return [];
  if (rows.every((r) => r.z !== null)) return rows as SeriesPoint[];
  // self-derived standardization, matching the run log: robust screen + log scale
  // for ratio assays; plain (full-statistics) z so all points share one scale
  const ev = makeSelfEval(rows.map((r) => r.x), rows[0].transform === 'ratio_to_cutoff');
  if (!ev) return [];
  const out: SeriesPoint[] = [];
  rows.forEach((r, i) => {
    const z = ev.zPlainFor(i);
    if (z !== null) out.push({ ...r, z });
  });
  return out;
}

function lastAcknowledgedTime(
  sqlite: Database.Database,
  qcMaterialId: string,
  monitor: string,
): string | undefined {
  const row = sqlite
    .prepare(
      `SELECT r.performed_at as t FROM monitor_signal s JOIN run r ON r.id = s.run_id
       WHERE s.qc_material_id = ? AND s.monitor = ? AND s.acknowledged_at IS NOT NULL
       ORDER BY r.performed_at DESC LIMIT 1`,
    )
    .get(qcMaterialId, monitor) as { t: string } | undefined;
  return row?.t;
}

/** Record a signal row for the newest point if one fired and is not already recorded. */
function recordSignal(
  sqlite: Database.Database,
  assayId: string,
  qcMaterialId: string,
  monitor: 'ewma' | 'cusum' | 'ewma_var' | 'changepoint',
  runId: string,
  statistic: number,
  limit: number,
  message: string,
): void {
  const exists = sqlite
    .prepare('SELECT id FROM monitor_signal WHERE qc_material_id = ? AND monitor = ? AND run_id = ?')
    .get(qcMaterialId, monitor, runId);
  if (exists) return;
  sqlite
    .prepare(
      `INSERT INTO monitor_signal (id, assay_id, qc_material_id, monitor, run_id, statistic, "limit", message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ulid(), assayId, qcMaterialId, monitor, runId, statistic, limit, message);
}

export function ewmaTab(
  sqlite: Database.Database,
  assayId: string,
  qcMaterialId: string,
  preset: 'default' | 'sensitive' = 'default',
) {
  const after = lastAcknowledgedTime(sqlite, qcMaterialId, 'ewma');
  const series = zSeries(sqlite, qcMaterialId, after);
  const params = EWMA_PRESETS[preset];
  const res = ewma(series.map((p) => p.z), params);
  let summary = `No EWMA signal in the last ${series.length} runs.`;
  if (res.firstSignal !== null) {
    const at = series[res.firstSignal - 1];
    const onsetIdx = Math.max(0, res.firstSignal - Math.ceil(1 / params.lambda));
    summary = `EWMA crossed its limit at run ${res.firstSignal} (${at.performedAt.slice(0, 10)}); estimated sustained shift ${res.shiftEstimate! >= 0 ? '+' : ''}${res.shiftEstimate!.toFixed(1)} SD since ~run ${onsetIdx + 1}.`;
    recordSignal(sqlite, assayId, qcMaterialId, 'ewma', at.runId, res.points[res.firstSignal - 1].e, res.points[res.firstSignal - 1].ucl, summary);
  }
  return { series, ewma: res, summary, params, resetAfter: after ?? null };
}

export function cusumTab(sqlite: Database.Database, assayId: string, qcMaterialId: string, h = 5, k = 0.5, fir = false) {
  const after = lastAcknowledgedTime(sqlite, qcMaterialId, 'cusum');
  const series = zSeries(sqlite, qcMaterialId, after);
  const res = cusum(series.map((p) => p.z), { h, k, fir });
  let summary = `No CUSUM signal in the last ${series.length} runs.`;
  if (res.firstSignal !== null) {
    const p = res.points[res.firstSignal - 1];
    const at = series[res.firstSignal - 1];
    summary = `CUSUM signalled ${p.signal === 'up' ? 'upward' : 'downward'} at run ${res.firstSignal} (${at.performedAt.slice(0, 10)}); estimated shift ${p.shiftEstimate! >= 0 ? '+' : ''}${p.shiftEstimate!.toFixed(1)} SD with onset ~run ${p.onset}.`;
    recordSignal(sqlite, assayId, qcMaterialId, 'cusum', at.runId, Math.max(p.cPlus, p.cMinus), h, summary);
  }
  return { series, cusum: res, summary, params: { h, k, fir } };
}

export function varianceTab(sqlite: Database.Database, assayId: string, qcMaterialId: string, lambda = 0.2) {
  const after = lastAcknowledgedTime(sqlite, qcMaterialId, 'ewma_var');
  const series = zSeries(sqlite, qcMaterialId, after);
  const res = varianceEwma(series.map((p) => p.z), { lambda });
  let summary = `No imprecision signal in the last ${series.length} runs.`;
  if (res.firstSignal !== null) {
    const at = series[res.firstSignal - 1];
    const v = res.points[res.firstSignal - 1].v;
    summary = `Variance EWMA exceeded its limit at run ${res.firstSignal} (${at.performedAt.slice(0, 10)}): imprecision ≈ ${Math.sqrt(v).toFixed(2)}× the baseline SD.`;
    recordSignal(sqlite, assayId, qcMaterialId, 'ewma_var', at.runId, v, res.ucl, summary);
  }
  return { series, variance: res, summary, params: { lambda, ucl: VARIANCE_EWMA_UCL[String(lambda)] } };
}

export interface AnnotatedChangePoint {
  index: number;
  performedAt: string;
  before: number;
  after: number;
  nearbyEvent: string | null;
}

export function changePointTab(sqlite: Database.Database, assayId: string, qcMaterialId: string, penaltyC = 3) {
  const series = zSeries(sqlite, qcMaterialId);
  const res = pelt(series.map((p) => p.z), { penaltyC });
  const events = seriesEvents(sqlite, assayId, qcMaterialId, series);
  const annotated: AnnotatedChangePoint[] = res.changePoints.map((cp) => {
    const seg = res.segments;
    const segIdx = seg.findIndex((s) => s.start === cp);
    const nearby = events.find((e) => Math.abs(e.index - cp) <= 3);
    return {
      index: cp,
      performedAt: series[cp]?.performedAt ?? '',
      before: seg[segIdx - 1]?.mean ?? NaN,
      after: seg[segIdx]?.mean ?? NaN,
      nearbyEvent: nearby ? nearby.label : null,
    };
  });
  const summary =
    annotated.length === 0
      ? `No change points detected over ${series.length} runs.`
      : annotated
          .map(
            (a) =>
              `Change at run ${a.index + 1} (${a.performedAt.slice(0, 10)}): mean ${a.before.toFixed(1)} → ${a.after.toFixed(1)} SD${a.nearbyEvent ? `, ${a.nearbyEvent}` : ''}.`,
          )
          .join(' ');
  return { series, segments: res.segments, changePoints: annotated, summary, params: { penaltyC, beta: res.beta } };
}

interface SeriesEvent {
  index: number;
  label: string;
}

/** Reagent-lot changes and baseline changes mapped onto series indices. */
export function seriesEvents(
  sqlite: Database.Database,
  assayId: string,
  qcMaterialId: string,
  series: SeriesPoint[],
): SeriesEvent[] {
  const events: SeriesEvent[] = [];
  let prevLot: string | null = null;
  series.forEach((p, i) => {
    if (p.reagentLotId !== prevLot && i > 0) {
      const lot = sqlite.prepare('SELECT lot FROM reagent_lot WHERE id = ?').get(p.reagentLotId) as { lot: string } | undefined;
      events.push({ index: i, label: `reagent lot → ${lot?.lot ?? '?'}` });
    }
    prevLot = p.reagentLotId;
  });
  const baselines = sqlite
    .prepare('SELECT effective_from FROM baseline WHERE qc_material_id = ? ORDER BY effective_from ASC')
    .all(qcMaterialId) as { effective_from: string }[];
  for (const b of baselines.slice(1)) {
    const idx = series.findIndex((p) => p.performedAt >= b.effective_from);
    if (idx > 0) events.push({ index: idx, label: `baseline change` });
  }
  return events;
}

export function lotTransitionTab(
  sqlite: Database.Database,
  assayId: string,
  qcMaterialId: string,
  nA = 20,
  nB = 20,
) {
  const series = zSeries(sqlite, qcMaterialId);
  // use transformed values (x scale), not z, for the comparison
  const xs = sqlite
    .prepare(
      `SELECT o.transformed_value as x, r.reagent_lot_id as lotId, r.performed_at
       FROM observation o JOIN run r ON r.id = o.run_id
       WHERE o.qc_material_id = ? AND o.superseded = 0
       ORDER BY r.performed_at ASC`,
    )
    .all(qcMaterialId) as { x: number; lotId: string | null; performed_at: string }[];
  // find the latest lot boundary
  let boundary = -1;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i].lotId !== xs[i - 1].lotId) boundary = i;
  }
  if (boundary < 0) {
    return { ok: false as const, summary: 'No reagent-lot change found in this series.', series };
  }
  const a = xs.slice(Math.max(0, boundary - nA), boundary).map((r) => r.x);
  const b = xs.slice(boundary, boundary + nB).map((r) => r.x);
  if (a.length < 5 || b.length < 5) {
    return {
      ok: false as const,
      summary: `Not enough observations around the lot change yet (${a.length} before, ${b.length} after; need ≥5 each).`,
      series,
    };
  }
  const assay = sqlite.prepare('SELECT allowable_bias_pct FROM assay WHERE id = ?').get(assayId) as {
    allowable_bias_pct: number | null;
  };
  const cmp = compareLots(a, b, assay.allowable_bias_pct);
  const lotA = xs[boundary - 1].lotId;
  const lotB = xs[boundary].lotId;
  const lotName = (id: string | null) =>
    id ? ((sqlite.prepare('SELECT lot FROM reagent_lot WHERE id = ?').get(id) as { lot: string } | undefined)?.lot ?? '?') : 'none';
  return {
    ok: true as const,
    lotA: lotName(lotA),
    lotB: lotName(lotB),
    boundaryAt: xs[boundary].performed_at,
    comparison: cmp,
    summary: cmp.message,
    series,
  };
}

export function acknowledgeSignal(
  sqlite: Database.Database,
  signalId: string,
  userId: string,
): { ok: boolean; error?: string } {
  const sig = sqlite.prepare('SELECT id, acknowledged_at FROM monitor_signal WHERE id = ?').get(signalId) as
    | { id: string; acknowledged_at: string | null }
    | undefined;
  if (!sig) return { ok: false, error: 'signal not found' };
  if (sig.acknowledged_at) return { ok: false, error: 'already acknowledged' };
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite.prepare('UPDATE monitor_signal SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?').run(userId, now, signalId);
    appendAudit(sqlite, {
      userId,
      entity: 'monitor_signal',
      entityId: signalId,
      action: 'update',
      after: { acknowledged: true },
      reason: 'corrective action acknowledged; monitor resets after this run',
    });
  });
  tx();
  return { ok: true };
}
