/** Shared service context and small query helpers used across services. */
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';

export interface Ctx {
  sqlite: Database.Database;
  config: Config;
}

export interface AssayRow {
  id: string;
  name: string;
  methodology: string;
  units: string;
  transform: 'none' | 'log' | 'ratio_to_cutoff';
  qc_scheme_json: string;
  westgard_profile_id: string;
  plating_order: 'randomized' | 'sequential' | 'structured';
  allowable_bias_pct: number | null;
  reader_max: number | null;
  active: number;
}

export interface QcScheme {
  levels: { level_code: string; replicates: number }[];
}

export function getAssay(sqlite: Database.Database, assayId: string): AssayRow | null {
  return (sqlite.prepare('SELECT * FROM assay WHERE id = ?').get(assayId) as AssayRow) ?? null;
}

export function getScheme(assay: AssayRow): QcScheme {
  return JSON.parse(assay.qc_scheme_json) as QcScheme;
}

/** Current QC material for a level: active window contains `at`, latest active_from wins. */
export function currentMaterial(
  sqlite: Database.Database,
  assayId: string,
  levelCode: string,
  at: string,
): Record<string, unknown> | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM qc_material
       WHERE assay_id = ? AND level_code = ?
         AND (active_from IS NULL OR active_from <= ?)
         AND (active_to IS NULL OR active_to >= ?)
       ORDER BY active_from DESC NULLS LAST LIMIT 1`,
    )
    .get(assayId, levelCode, at, at) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * Frozen baseline in effect for a material at time `at`. If the observation predates
 * every baseline (e.g., targets frozen today, then last month's data imported), the
 * earliest baseline is applied retrospectively — the alternative would be historical
 * data with no z-scores at all.
 */
export function currentBaseline(
  sqlite: Database.Database,
  qcMaterialId: string,
  at: string,
): { id: string; mean: number; sd: number; n: number; method: string } | null {
  const row = sqlite
    .prepare(
      `SELECT id, mean, sd, n, method FROM baseline
       WHERE qc_material_id = ? AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(qcMaterialId, at, at) as { id: string; mean: number; sd: number; n: number; method: string } | undefined;
  if (row) return row;
  const earliest = sqlite
    .prepare(
      `SELECT id, mean, sd, n, method FROM baseline
       WHERE qc_material_id = ? ORDER BY effective_from ASC LIMIT 1`,
    )
    .get(qcMaterialId) as { id: string; mean: number; sd: number; n: number; method: string } | undefined;
  return earliest ?? null;
}

/** Current reagent lot for an assay at time `at`. */
export function currentReagentLot(
  sqlite: Database.Database,
  assayId: string,
  at: string,
): Record<string, unknown> | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM reagent_lot
       WHERE assay_id = ?
         AND (active_from IS NULL OR active_from <= ?)
         AND (active_to IS NULL OR active_to >= ?)
       ORDER BY active_from DESC NULLS LAST LIMIT 1`,
    )
    .get(assayId, at, at) as Record<string, unknown> | undefined;
  return row ?? null;
}
