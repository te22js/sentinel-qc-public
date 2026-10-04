/**
 * Plate import and analysis: parse a reader export (8×12 numeric grid), apply the
 * assay layout, run PSAD, persist plate + wells + analysis, and score against the
 * Phase-II MSPC model when one exists (≥30 validated plates).
 *
 * Importer safety: files are stripped to numeric grids + well types; any text found
 * in sample cells causes rejection (no patient identifiers can enter the database).
 */
import {
  psad,
  standardLayout,
  buildPhase2Model,
  scorePhase2,
  type WellType,
  type PsadResult,
  type Phase2Model,
} from '@sentinel/stats';
import { appendAudit, ulid } from '@sentinel/db';
import type Database from 'better-sqlite3';
import { getAssay } from './context.js';

export interface ParsedGrid {
  ok: boolean;
  error?: string;
  values?: (number | null)[][];
  rows?: number;
  cols?: number;
}

/**
 * Parse a plate file: CSV/TSV containing an 8×12 (or R×C) numeric block. Rows may be
 * labelled A..H and columns 1..12; labels are detected and stripped. Any non-numeric
 * content inside the data block rejects the file.
 */
export function parsePlateGrid(content: string, rows = 8, cols = 12): ParsedGrid {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const sep = content.includes('\t') ? '\t' : content.includes(';') && !content.includes(',') ? ';' : ',';
  const table = lines.map((l) => l.split(sep).map((c) => c.trim()));

  const isNum = (s: string) => s !== '' && Number.isFinite(Number(s));
  // find `rows` consecutive lines that each contain >= cols numeric-ish cells
  for (let start = 0; start + rows <= table.length; start++) {
    const block = table.slice(start, start + rows);
    // detect a leading label column (A..H) or index column
    const stripLabel = block.every(
      (r) => r.length >= cols + 1 && !isNum(r[0]) && r.slice(1, cols + 1).every(isNum),
    );
    const plain = block.every((r) => r.length >= cols && r.slice(0, cols).every(isNum));
    if (stripLabel || plain) {
      const values: (number | null)[][] = block.map((r) => {
        const cells = stripLabel ? r.slice(1, cols + 1) : r.slice(0, cols);
        return cells.map((c) => Number(c));
      });
      return { ok: true, values, rows, cols };
    }
    // reject explicitly when a block matches shape but has text inside
    const shapeMatches = block.every((r) => r.length >= cols);
    if (shapeMatches) {
      const offending = block.some((r) => {
        const cells = r.length >= cols + 1 && !isNum(r[0]) ? r.slice(1, cols + 1) : r.slice(0, cols);
        const numeric = cells.filter(isNum).length;
        return numeric >= cols - 2 && numeric < cols; // mostly numeric row with text mixed in
      });
      if (offending) {
        return { ok: false, error: 'The data block contains non-numeric text in sample cells; the file was rejected. Plate files must contain only numeric readings.' };
      }
    }
  }
  return { ok: false, error: `No ${rows}×${cols} numeric block found in the file.` };
}

export function getLayout(sqlite: Database.Database, layoutId: string | null, assayId: string): WellType[][] {
  if (layoutId) {
    const row = sqlite.prepare('SELECT well_types_json FROM plate_layout WHERE id = ?').get(layoutId) as
      | { well_types_json: string }
      | undefined;
    if (row) return JSON.parse(row.well_types_json);
  }
  const def = sqlite
    .prepare("SELECT well_types_json FROM plate_layout WHERE assay_id = ? ORDER BY rowid LIMIT 1")
    .get(assayId) as { well_types_json: string } | undefined;
  if (def) return JSON.parse(def.well_types_json);
  return standardLayout();
}

export interface ImportPlateInput {
  assayId: string;
  content: string;
  filename: string;
  layoutId?: string | null;
  runId?: string | null;
  transform?: 'log' | 'rank' | 'identity';
  B?: number;
  seed?: number;
  userId: string;
}

export function importPlate(sqlite: Database.Database, input: ImportPlateInput) {
  const assay = getAssay(sqlite, input.assayId);
  if (!assay) return { ok: false as const, error: 'assay not found' };
  const grid = parsePlateGrid(input.content);
  if (!grid.ok) return { ok: false as const, error: grid.error };
  const layout = getLayout(sqlite, input.layoutId ?? null, input.assayId);
  const transform = input.transform ?? 'log';

  const res = psad({
    values: grid.values!,
    wellTypes: layout,
    transform,
    B: input.B ?? 999,
    seed: input.seed ?? 12345,
    platingOrder: assay.plating_order,
  });

  const plateId = ulid();
  const now = new Date().toISOString();
  const analysisId = ulid();

  // Phase-II scoring when a model exists
  let t2: number | null = null;
  let spe: number | null = null;
  let phase2: ReturnType<typeof scorePhase2> | null = null;
  let phase2ModelId: string | null = null;
  const modelRow = latestPhase2Model(sqlite, input.assayId);
  if (modelRow && res.ok && res.featureVector) {
    const model = modelRow.model;
    if (model.dim === res.featureVector.length) {
      phase2 = scorePhase2(model, res.featureVector);
      t2 = phase2.t2;
      spe = phase2.spe;
      phase2ModelId = modelRow.id;
    }
  }

  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO plate (id, assay_id, run_id, rows, cols, imported_at, source_filename, transform_used, layout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(plateId, input.assayId, input.runId ?? null, grid.rows, grid.cols, now, input.filename, transform, input.layoutId ?? null);
    const insWell = sqlite.prepare(
      `INSERT INTO well_measurement (id, plate_id, row, col, well_type, raw_value, transformed_value, residual, z_local)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < grid.rows!; i++) {
      for (let j = 0; j < grid.cols!; j++) {
        insWell.run(
          ulid(),
          plateId,
          i,
          j,
          layout[i][j],
          grid.values![i][j],
          res.transformed[i]?.[j] ?? null,
          res.residuals[i]?.[j] ?? null,
          res.zLocal[i]?.[j] ?? null,
        );
      }
    }
    sqlite
      .prepare(
        `INSERT INTO plate_analysis (id, plate_id, params_json, mu, row_effects_json, col_effects_json, edge_stat, grad_json, moran_i, pvalues_json, findings_json, t2, spe, phase2_model_id, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        analysisId,
        plateId,
        JSON.stringify({
          B: res.B,
          alpha: res.alpha,
          seed: res.seed,
          transform,
          ok: res.ok,
          reason: res.reason ?? null,
          nSampleWells: res.nSampleWells,
          suppressedPValues: res.suppressedPValues,
          featureVector: res.featureVector,
          statistics: res.statistics,
        }),
        res.statistics?.mu ?? null,
        JSON.stringify(res.rowEffects),
        JSON.stringify(res.colEffects),
        res.statistics?.tEdge ?? null,
        JSON.stringify({ br: res.statistics?.gradientBr ?? null, bc: res.statistics?.gradientBc ?? null, tGrad: res.statistics?.tGrad ?? null }),
        res.statistics?.moranI ?? null,
        res.pValues ? JSON.stringify(res.pValues) : null,
        JSON.stringify(res.findings),
        t2,
        spe,
        phase2ModelId,
        now,
      );
    appendAudit(sqlite, {
      userId: input.userId,
      entity: 'plate',
      entityId: plateId,
      action: 'create',
      after: { assayId: input.assayId, filename: input.filename, findings: res.findings.length, ok: res.ok },
    });
  });
  tx();

  return { ok: true as const, plateId, analysisId, result: res, phase2, phase2Limits: modelRow ? { t2Ucl: modelRow.model.t2Ucl, speUcl: modelRow.model.speUcl } : null };
}

export function latestPhase2Model(
  sqlite: Database.Database,
  assayId: string,
): { id: string; model: Phase2Model } | null {
  const row = sqlite
    .prepare('SELECT * FROM plate_phase2_model WHERE assay_id = ? ORDER BY built_at DESC LIMIT 1')
    .get(assayId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const model: Phase2Model = {
    n: row.n_plates as number,
    dim: (JSON.parse(row.means_json as string) as number[]).length,
    means: JSON.parse(row.means_json as string),
    scales: JSON.parse(row.scales_json as string),
    loadings: JSON.parse(row.loadings_json as string),
    eigenvalues: (JSON.parse(row.eigen_json as string) as { retained: number[] }).retained,
    allEigenvalues: (JSON.parse(row.eigen_json as string) as { all: number[] }).all,
    aComponents: row.a_components as number,
    varExplained: 0,
    t2Ucl: row.t2_ucl as number,
    speUcl: row.spe_ucl as number,
    alpha: 0.01,
  };
  return { id: row.id as string, model };
}

/**
 * Rebuild the Phase-II model from "validated" plates: analyses that ran successfully
 * and produced no spatial findings (clean by PSAD's own test). Requires ≥30 plates.
 */
export function rebuildPhase2(
  sqlite: Database.Database,
  assayId: string,
  userId: string,
  minPlates = 30,
): { ok: boolean; error?: string; modelId?: string; nPlates?: number; aComponents?: number } {
  const analyses = sqlite
    .prepare(
      `SELECT pa.id, pa.plate_id, pa.params_json, pa.findings_json FROM plate_analysis pa
       JOIN plate p ON p.id = pa.plate_id
       WHERE p.assay_id = ?
       ORDER BY pa.analyzed_at ASC`,
    )
    .all(assayId) as { id: string; plate_id: string; params_json: string; findings_json: string }[];
  const vectors: number[][] = [];
  const plateIds: string[] = [];
  for (const a of analyses) {
    const params = JSON.parse(a.params_json);
    const findings = JSON.parse(a.findings_json) as { kind: string }[];
    const spatial = findings.filter((f) => f.kind !== 'local_outlier');
    if (params.ok && params.featureVector && spatial.length === 0) {
      vectors.push(params.featureVector);
      plateIds.push(a.plate_id);
    }
  }
  if (vectors.length < minPlates) {
    return { ok: false, error: `Only ${vectors.length} validated (clean) plates; ${minPlates} are required for a Phase-II model.` };
  }
  const model = buildPhase2Model(vectors, { alpha: 0.01 });
  const id = ulid();
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO plate_phase2_model (id, assay_id, n_plates, loadings_json, eigen_json, means_json, scales_json, a_components, t2_ucl, spe_ucl, built_at, plate_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        assayId,
        model.n,
        JSON.stringify(model.loadings),
        JSON.stringify({ retained: model.eigenvalues, all: model.allEigenvalues }),
        JSON.stringify(model.means),
        JSON.stringify(model.scales),
        model.aComponents,
        model.t2Ucl,
        model.speUcl,
        now,
        JSON.stringify(plateIds),
      );
    appendAudit(sqlite, {
      userId,
      entity: 'plate_phase2_model',
      entityId: id,
      action: 'create',
      after: { assayId, nPlates: model.n, aComponents: model.aComponents },
    });
  });
  tx();
  return { ok: true, modelId: id, nPlates: model.n, aComponents: model.aComponents };
}
