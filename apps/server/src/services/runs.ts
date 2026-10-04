/**
 * Run entry: transform values, compute z against frozen baselines, evaluate the
 * assay's Westgard profile against the run history, persist run + observations +
 * rule evaluations atomically, and write the audit trail.
 */
import {
  applyTransform,
  evaluateRun,
  type WestgardProfile,
  type WestgardRun,
  type RuleEvaluation,
} from '@sentinel/stats';
import { appendAudit, ulid } from '@sentinel/db';
import type Database from 'better-sqlite3';
import { getAssay, getScheme, currentMaterial, currentBaseline, currentReagentLot } from './context.js';

export interface CreateRunInput {
  assayId: string;
  operatorUserId: string;
  instrumentId?: string | null;
  reagentLotId?: string | null;
  performedAt?: string;
  comment?: string;
  values: Record<string, number[]>;
  cutoff?: number;
  /** technician name as written at the bench (single-login model) */
  technician?: string | null;
  /** kit/reagent lot as written; auto-registered as a reagent lot for lot tracking */
  kitLot?: string | null;
}

export interface CreateRunResult {
  ok: boolean;
  error?: string;
  runId?: string;
  verdict?: 'pass' | 'warning' | 'reject';
  evaluations?: RuleEvaluation[];
  observations?: {
    id: string;
    level: string;
    replicate: number;
    raw: number;
    transformed: number;
    z: number | null;
    flags: string[];
  }[];
  message?: string;
}

/** History depth for across-run rules (12x is the longest look-back). */
const HISTORY_RUNS = 15;

export function loadProfile(sqlite: Database.Database, profileId: string): WestgardProfile {
  const row = sqlite.prepare('SELECT name, rules_json FROM westgard_profile WHERE id = ?').get(profileId) as
    | { name: string; rules_json: string }
    | undefined;
  if (!row) throw new Error('westgard profile not found');
  return { name: row.name, rules: JSON.parse(row.rules_json) };
}

/** Build the ordered stream of past runs (with z per level) for Westgard evaluation. */
export function buildHistory(
  sqlite: Database.Database,
  assayId: string,
  before: string,
  limit = HISTORY_RUNS,
): WestgardRun[] {
  const runs = sqlite
    .prepare(
      `SELECT id, verdict, override_status FROM run
       WHERE assay_id = ? AND performed_at < ?
       ORDER BY performed_at DESC, id DESC LIMIT ?`,
    )
    .all(assayId, before, limit) as { id: string; verdict: string; override_status: string }[];
  runs.reverse();
  const obsStmt = sqlite.prepare(
    `SELECT o.id, o.z, m.level_code as level, o.replicate_index
     FROM observation o JOIN qc_material m ON m.id = o.qc_material_id
     WHERE o.run_id = ? AND o.superseded = 0 AND o.z IS NOT NULL
     ORDER BY m.level_code, o.replicate_index`,
  );
  return runs.map((r) => ({
    runId: r.id,
    included: r.verdict !== 'reject' || r.override_status === 'accepted',
    observations: (obsStmt.all(r.id) as { id: string; z: number; level: string }[]).map((o) => ({
      id: o.id,
      level: o.level,
      z: o.z,
    })),
  }));
}

export function createRun(sqlite: Database.Database, input: CreateRunInput): CreateRunResult {
  const assay = getAssay(sqlite, input.assayId);
  if (!assay || !assay.active) return { ok: false, error: 'assay not found or inactive' };
  const scheme = getScheme(assay);
  const now = new Date().toISOString();
  const performedAt = input.performedAt ?? now;

  // scheme validation
  const levelCodes = scheme.levels.map((l) => l.level_code);
  for (const level of Object.keys(input.values)) {
    if (!levelCodes.includes(level)) return { ok: false, error: `unknown level "${level}" for this assay` };
  }
  for (const l of scheme.levels) {
    const vals = input.values[l.level_code];
    if (!vals || vals.length !== l.replicates) {
      return {
        ok: false,
        error: `level ${l.level_code} expects ${l.replicates} observation(s), got ${vals?.length ?? 0}`,
      };
    }
    for (const v of vals) {
      if (!Number.isFinite(v)) return { ok: false, error: `non-numeric value for level ${l.level_code}` };
    }
  }
  if (assay.transform === 'ratio_to_cutoff' && !(input.cutoff && input.cutoff > 0)) {
    return { ok: false, error: 'this assay requires a run cutoff value (ratio_to_cutoff transform)' };
  }

  // resolve reagent lot: explicit id > kit-lot text (find-or-create, so lot-change
  // events and lot-transition analysis work from the free-text field) > current lot
  let reagentLotId = input.reagentLotId ?? null;
  const kitLot = input.kitLot?.trim() || null;
  if (!reagentLotId && kitLot) {
    const existing = sqlite
      .prepare('SELECT id FROM reagent_lot WHERE assay_id = ? AND lot = ?')
      .get(assay.id, kitLot) as { id: string } | undefined;
    if (existing) {
      reagentLotId = existing.id;
    } else {
      reagentLotId = ulid();
      sqlite
        .prepare('INSERT INTO reagent_lot (id, assay_id, lot, active_from) VALUES (?, ?, ?, ?)')
        .run(reagentLotId, assay.id, kitLot, performedAt);
      appendAudit(sqlite, {
        userId: input.operatorUserId,
        entity: 'reagent_lot',
        entityId: reagentLotId,
        action: 'create',
        after: { assayId: assay.id, lot: kitLot, source: 'run_entry' },
      });
    }
  }
  if (!reagentLotId) {
    reagentLotId = (currentReagentLot(sqlite, assay.id, performedAt)?.id as string) ?? null;
  }

  // per-level material/baseline resolution + observation building
  interface PendingObs {
    id: string;
    materialId: string;
    level: string;
    replicate: number;
    raw: number;
    transformed: number;
    baselineId: string | null;
    z: number | null;
    flags: string[];
  }
  const pending: PendingObs[] = [];
  let missingBaseline = false;

  for (const l of scheme.levels) {
    const material = currentMaterial(sqlite, assay.id, l.level_code, performedAt);
    if (!material) return { ok: false, error: `no QC material configured for level ${l.level_code}` };
    const baseline = currentBaseline(sqlite, material.id as string, performedAt);
    if (!baseline) missingBaseline = true;
    input.values[l.level_code].forEach((raw, replicate) => {
      const flags: string[] = [];
      if (raw < 0) flags.push('negative_value');
      if (assay.reader_max !== null && raw > assay.reader_max) flags.push('above_reader_max');
      if (performedAt > now) flags.push('future_timestamp');
      if (material.expiry && (material.expiry as string) < performedAt.slice(0, 10)) flags.push('control_lot_expired');
      if (reagentLotId) {
        const lot = sqlite.prepare('SELECT expiry FROM reagent_lot WHERE id = ?').get(reagentLotId) as
          | { expiry: string | null }
          | undefined;
        if (lot?.expiry && lot.expiry < performedAt.slice(0, 10)) flags.push('reagent_lot_expired');
      }
      const dup = sqlite
        .prepare(
          `SELECT o.id FROM observation o JOIN run r ON r.id = o.run_id
           WHERE o.qc_material_id = ? AND r.performed_at = ? AND o.raw_value = ? AND o.superseded = 0 LIMIT 1`,
        )
        .get(material.id, performedAt, raw);
      if (dup) flags.push('possible_duplicate');
      if (!baseline) flags.push('no_baseline');

      const transformed = applyTransform(assay.transform, raw, input.cutoff);
      const z = baseline ? (transformed - baseline.mean) / baseline.sd : null;
      pending.push({
        id: ulid(),
        materialId: material.id as string,
        level: l.level_code,
        replicate,
        raw,
        transformed,
        baselineId: baseline?.id ?? null,
        z,
        flags,
      });
    });
  }

  // Westgard evaluation (only when every observation has a z)
  let verdict: 'pass' | 'warning' | 'reject' = 'pass';
  let evaluations: RuleEvaluation[] = [];
  let message = '';
  if (!missingBaseline) {
    const profile = loadProfile(sqlite, assay.westgard_profile_id);
    const history = buildHistory(sqlite, assay.id, performedAt);
    const current: WestgardRun = {
      runId: 'current',
      observations: pending.map((p) => ({ id: p.id, level: p.level, z: p.z as number })),
    };
    const res = evaluateRun(history, current, profile);
    verdict = res.verdict;
    evaluations = res.evaluations;
    const fired = evaluations.filter((e) => e.status === 'warning' || e.status === 'reject');
    message =
      verdict === 'pass'
        ? 'All controls within limits.'
        : fired.map((e) => e.message).join(' ');
  } else {
    message =
      'No frozen baseline for one or more levels — control rules were not evaluated. Freeze a baseline to enable QC verdicts.';
  }

  const runId = ulid();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO run (id, assay_id, instrument_id, operator_user_id, reagent_lot_id, performed_at, entered_at, verdict, comment, technician, kit_lot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        assay.id,
        input.instrumentId ?? null,
        input.operatorUserId,
        reagentLotId,
        performedAt,
        now,
        verdict,
        input.comment ?? null,
        input.technician?.trim() || null,
        kitLot,
      );
    const insObs = sqlite.prepare(
      `INSERT INTO observation (id, run_id, qc_material_id, replicate_index, raw_value, transformed_value, baseline_id, z, cutoff_value, flags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of pending) {
      insObs.run(p.id, runId, p.materialId, p.replicate, p.raw, p.transformed, p.baselineId, p.z, input.cutoff ?? null, JSON.stringify(p.flags));
    }
    const insEval = sqlite.prepare(
      `INSERT INTO rule_evaluation (id, run_id, rule, scope, status, observation_ids_json, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of evaluations) {
      insEval.run(ulid(), runId, e.rule, e.scope, e.status, JSON.stringify(e.observationIds), e.message);
    }
    appendAudit(sqlite, {
      userId: input.operatorUserId,
      entity: 'run',
      entityId: runId,
      action: 'create',
      after: { assayId: assay.id, performedAt, verdict, values: input.values },
    });
  });
  tx();

  return {
    ok: true,
    runId,
    verdict,
    evaluations,
    message,
    observations: pending.map((p) => ({
      id: p.id,
      level: p.level,
      replicate: p.replicate,
      raw: p.raw,
      transformed: p.transformed,
      z: p.z,
      flags: p.flags,
    })),
  };
}

export function overrideRun(
  sqlite: Database.Database,
  runId: string,
  supervisorId: string,
  reason: string,
): { ok: boolean; error?: string } {
  const run = sqlite.prepare('SELECT id, verdict, override_status FROM run WHERE id = ?').get(runId) as
    | { id: string; verdict: string; override_status: string }
    | undefined;
  if (!run) return { ok: false, error: 'run not found' };
  if (run.verdict !== 'reject') return { ok: false, error: 'only rejected runs can be accepted by override' };
  if (run.override_status === 'accepted') return { ok: false, error: 'run is already accepted' };
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare("UPDATE run SET override_status = 'accepted', override_reason = ?, override_by = ? WHERE id = ?")
      .run(reason, supervisorId, runId);
    appendAudit(sqlite, {
      userId: supervisorId,
      entity: 'run',
      entityId: runId,
      action: 'override',
      before: { override_status: run.override_status },
      after: { override_status: 'accepted' },
      reason,
    });
  });
  tx();
  return { ok: true };
}

/** Correct an observation: new version via supersedes_id; the original is never edited. */
export function correctObservation(
  sqlite: Database.Database,
  observationId: string,
  newRawValue: number,
  userId: string,
  reason: string,
  newCutoff?: number,
): { ok: boolean; error?: string; newObservationId?: string } {
  const obs = sqlite
    .prepare(
      `SELECT o.*, r.assay_id, r.performed_at FROM observation o JOIN run r ON r.id = o.run_id WHERE o.id = ?`,
    )
    .get(observationId) as Record<string, unknown> | undefined;
  if (!obs) return { ok: false, error: 'observation not found' };
  if (obs.superseded) return { ok: false, error: 'observation is already superseded' };
  const assay = getAssay(sqlite, obs.assay_id as string)!;
  const cutoff = newCutoff ?? ((obs.cutoff_value as number) ?? undefined);
  const transformed = applyTransform(assay.transform, newRawValue, cutoff);
  const baseline = obs.baseline_id
    ? (sqlite.prepare('SELECT mean, sd FROM baseline WHERE id = ?').get(obs.baseline_id) as { mean: number; sd: number })
    : null;
  const z = baseline ? (transformed - baseline.mean) / baseline.sd : null;
  const newId = ulid();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO observation (id, run_id, qc_material_id, replicate_index, raw_value, transformed_value, baseline_id, z, cutoff_value, flags_json, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["correction"]', ?)`,
      )
      .run(newId, obs.run_id, obs.qc_material_id, obs.replicate_index, newRawValue, transformed, obs.baseline_id, z, cutoff ?? null, observationId);
    sqlite.prepare('UPDATE observation SET superseded = 1 WHERE id = ?').run(observationId);
    appendAudit(sqlite, {
      userId,
      entity: 'observation',
      entityId: observationId,
      action: 'update',
      before: { raw_value: obs.raw_value, cutoff_value: obs.cutoff_value },
      after: { raw_value: newRawValue, cutoff_value: cutoff ?? null, correction_id: newId },
      reason,
    });
  });
  tx();
  return { ok: true, newObservationId: newId };
}
