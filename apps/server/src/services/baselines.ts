/**
 * Baseline management: Phase-I computation preview (with outlier exclusion for user
 * confirmation) and freezing. Frozen baselines are immutable; re-baselining closes the
 * previous row (effective_to) and inserts a new one. Every freeze is audited.
 */
import { computeBaseline } from '@sentinel/stats';
import { appendAudit, ulid } from '@sentinel/db';
import type Database from 'better-sqlite3';

export interface BaselinePreview {
  ok: boolean;
  error?: string;
  n?: number;
  mean?: number;
  sd?: number;
  robustMean?: number;
  robustSd?: number;
  excluded?: { id: string; rawValue: number; transformedValue: number; performedAt: string }[];
  provisional?: boolean;
  windowFrom?: string;
  windowTo?: string;
  observationCount?: number;
}

export function previewBaseline(
  sqlite: Database.Database,
  qcMaterialId: string,
  windowFrom?: string,
  windowTo?: string,
): BaselinePreview {
  const rows = sqlite
    .prepare(
      `SELECT o.id, o.raw_value, o.transformed_value, r.performed_at
       FROM observation o JOIN run r ON r.id = o.run_id
       WHERE o.qc_material_id = ? AND o.superseded = 0
         AND (? IS NULL OR r.performed_at >= ?)
         AND (? IS NULL OR r.performed_at <= ?)
       ORDER BY r.performed_at ASC`,
    )
    .all(qcMaterialId, windowFrom ?? null, windowFrom ?? null, windowTo ?? null, windowTo ?? null) as {
    id: string;
    raw_value: number;
    transformed_value: number;
    performed_at: string;
  }[];
  if (rows.length === 0) return { ok: false, error: 'no observations in the selected window' };
  const res = computeBaseline({
    values: rows.map((r) => r.transformed_value),
    ids: rows.map((r) => r.id),
  });
  if (!res.ok) return { ok: false, error: res.message, observationCount: rows.length };
  const excludedSet = new Set(res.excludedIds);
  return {
    ok: true,
    n: res.n,
    mean: res.mean,
    sd: res.sd,
    robustMean: res.robustMean,
    robustSd: res.robustSd,
    provisional: res.provisional,
    excluded: rows
      .filter((r) => excludedSet.has(r.id))
      .map((r) => ({ id: r.id, rawValue: r.raw_value, transformedValue: r.transformed_value, performedAt: r.performed_at })),
    windowFrom: rows[0].performed_at,
    windowTo: rows[rows.length - 1].performed_at,
    observationCount: rows.length,
  };
}

export interface FreezeInput {
  assayId: string;
  qcMaterialId: string;
  method: 'manual_manufacturer' | 'manual_lab' | 'computed_classical' | 'computed_robust';
  mean: number;
  sd: number;
  n: number;
  windowFrom?: string | null;
  windowTo?: string | null;
  excludedObservationIds?: string[];
  effectiveFrom?: string;
  userId: string;
}

export function freezeBaseline(sqlite: Database.Database, input: FreezeInput): { ok: boolean; error?: string; baselineId?: string } {
  if (!(input.sd > 0)) return { ok: false, error: 'sd must be > 0 (refusing to freeze a degenerate baseline)' };
  // manufacturer targets carry no observation count; computed/lab baselines need n ≥ 10
  if (input.method !== 'manual_manufacturer' && !(input.n >= 10)) {
    return { ok: false, error: 'at least 10 observations are required (20 for a non-provisional baseline)' };
  }
  const material = sqlite.prepare('SELECT id, assay_id FROM qc_material WHERE id = ?').get(input.qcMaterialId) as
    | { id: string; assay_id: string }
    | undefined;
  if (!material) return { ok: false, error: 'QC material not found' };
  if (material.assay_id !== input.assayId) return { ok: false, error: 'material does not belong to this assay' };

  const now = new Date().toISOString();
  const effectiveFrom = input.effectiveFrom ?? now;
  const id = ulid();
  const tx = sqlite.transaction(() => {
    // close any open baseline for this material
    sqlite
      .prepare('UPDATE baseline SET effective_to = ? WHERE qc_material_id = ? AND effective_to IS NULL')
      .run(effectiveFrom, input.qcMaterialId);
    sqlite
      .prepare(
        `INSERT INTO baseline (id, assay_id, qc_material_id, mean, sd, n, method, window_from, window_to, excluded_observation_ids_json, effective_from, frozen_at, frozen_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.assayId,
        input.qcMaterialId,
        input.mean,
        input.sd,
        input.n,
        input.method,
        input.windowFrom ?? null,
        input.windowTo ?? null,
        JSON.stringify(input.excludedObservationIds ?? []),
        effectiveFrom,
        now,
        input.userId,
      );
    appendAudit(sqlite, {
      userId: input.userId,
      entity: 'baseline',
      entityId: id,
      action: 'freeze',
      after: {
        qcMaterialId: input.qcMaterialId,
        mean: input.mean,
        sd: input.sd,
        n: input.n,
        method: input.method,
        effectiveFrom,
      },
    });
  });
  tx();
  return { ok: true, baselineId: id };
}
