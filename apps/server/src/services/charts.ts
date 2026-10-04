/**
 * Levey–Jennings chart data: the observation series for one assay/level with the
 * baseline in effect, rule-violation markers and vertical event markers
 * (lot / instrument / baseline changes).
 */
import type Database from 'better-sqlite3';
import { mean, sd as sdOf, cv as cvOf } from '@sentinel/stats';

export interface LjPoint {
  observationId: string;
  runId: string;
  performedAt: string;
  raw: number;
  transformed: number;
  z: number | null;
  verdict: string;
  overrideStatus: string;
  violatedRules: string[];
  reagentLotId: string | null;
  instrumentId: string | null;
}

export interface LjEvent {
  index: number;
  performedAt: string;
  kind: 'reagent_lot' | 'instrument' | 'baseline' | 'control_lot';
  label: string;
}

export function ljData(
  sqlite: Database.Database,
  assayId: string,
  levelCode: string,
  from?: string,
  to?: string,
  reagentLotId?: string,
) {
  const material = sqlite
    .prepare(
      `SELECT id, lot FROM qc_material WHERE assay_id = ? AND level_code = ? ORDER BY active_from DESC NULLS LAST`,
    )
    .all(assayId, levelCode) as { id: string; lot: string }[];
  if (material.length === 0) return { ok: false as const, error: 'no material for this level' };
  const materialIds = material.map((m) => m.id);

  const points = (sqlite
    .prepare(
      `SELECT o.id as observationId, r.id as runId, r.performed_at as performedAt,
              o.raw_value as raw, o.transformed_value as transformed, o.z,
              r.verdict, r.override_status as overrideStatus,
              r.reagent_lot_id as reagentLotId, r.instrument_id as instrumentId,
              o.qc_material_id as materialId
       FROM observation o JOIN run r ON r.id = o.run_id
       WHERE o.qc_material_id IN (${materialIds.map(() => '?').join(',')})
         AND o.superseded = 0
         AND (? IS NULL OR r.performed_at >= ?)
         AND (? IS NULL OR r.performed_at <= ?)
         AND (? IS NULL OR r.reagent_lot_id = ?)
       ORDER BY r.performed_at ASC, o.replicate_index ASC`,
    )
    .all(...materialIds, from ?? null, from ?? null, to ?? null, to ?? null, reagentLotId ?? null, reagentLotId ?? null) as (LjPoint & {
    materialId: string;
  })[]);

  // violated rules per run
  const ruleStmt = sqlite.prepare(
    `SELECT rule, observation_ids_json FROM rule_evaluation WHERE run_id = ? AND status IN ('warning','reject')`,
  );
  for (const p of points) {
    const rules = ruleStmt.all(p.runId) as { rule: string; observation_ids_json: string }[];
    p.violatedRules = rules
      .filter((r) => (JSON.parse(r.observation_ids_json) as string[]).includes(p.observationId))
      .map((r) => r.rule);
  }

  // events
  const events: LjEvent[] = [];
  let prevLot: string | null = null;
  let prevInstrument: string | null = null;
  let prevMaterial: string | null = null;
  points.forEach((p, i) => {
    if (i > 0 && p.reagentLotId !== prevLot) {
      const lot = sqlite.prepare('SELECT lot FROM reagent_lot WHERE id = ?').get(p.reagentLotId) as { lot: string } | undefined;
      events.push({ index: i, performedAt: p.performedAt, kind: 'reagent_lot', label: `Lot ${lot?.lot ?? '?'} →` });
    }
    if (i > 0 && p.instrumentId !== prevInstrument) {
      const inst = sqlite.prepare('SELECT label FROM instrument WHERE id = ?').get(p.instrumentId) as { label: string } | undefined;
      events.push({ index: i, performedAt: p.performedAt, kind: 'instrument', label: `${inst?.label ?? 'instrument'} →` });
    }
    if (i > 0 && p.materialId !== prevMaterial) {
      const m = material.find((x) => x.id === p.materialId);
      events.push({ index: i, performedAt: p.performedAt, kind: 'control_lot', label: `Control lot ${m?.lot ?? '?'} →` });
    }
    prevLot = p.reagentLotId;
    prevInstrument = p.instrumentId;
    prevMaterial = p.materialId;
  });
  const baselines = sqlite
    .prepare(
      `SELECT id, mean, sd, n, method, effective_from, effective_to FROM baseline
       WHERE qc_material_id IN (${materialIds.map(() => '?').join(',')})
       ORDER BY effective_from ASC`,
    )
    .all(...materialIds) as { id: string; mean: number; sd: number; n: number; method: string; effective_from: string; effective_to: string | null }[];
  baselines.slice(1).forEach((b) => {
    const idx = points.findIndex((p) => p.performedAt >= b.effective_from);
    if (idx > 0) events.push({ index: idx, performedAt: b.effective_from, kind: 'baseline', label: 'Baseline →' });
  });

  const active = baselines.filter((b) => b.effective_to === null).at(-1) ?? baselines.at(-1) ?? null;
  const xs = points.map((p) => p.transformed);
  return {
    ok: true as const,
    points,
    events: events.sort((a, b) => a.index - b.index),
    baseline: active,
    stats: {
      n: xs.length,
      mean: xs.length ? mean(xs) : null,
      sd: xs.length > 1 ? sdOf(xs) : null,
      cv: xs.length > 1 ? cvOf(xs) : null,
    },
  };
}
