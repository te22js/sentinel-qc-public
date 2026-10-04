/**
 * Demo data generator (seeded, deterministic): three ELISA assays with 8 months of
 * daily QC runs containing every teachable event from the demo story, 60 clean
 * synthetic plates building a Phase-II model, and five fault-plate CSV files to
 * import live. Run with `pnpm demo`; adds a demo banner flag to the laboratory row.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { openDb, seedStructure, ulid, appendAudit } from '@sentinel/db';
import {
  Pcg32,
  applyTransform,
  evaluateRun,
  computeBaseline,
  psad,
  buildPhase2Model,
  generatePlate,
  injectRowBias,
  injectColBias,
  injectEdgeEffect,
  injectGradient,
  standardLayout,
  type WestgardRun,
  type TransformKind,
} from '@sentinel/stats';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PATH = process.env.SENTINEL_DB ?? join(REPO_ROOT, 'data', 'sentinel.sqlite');
const rng = new Pcg32(20260822);
const { sqlite } = openDb(DB_PATH);

console.log(`Seeding demo data into ${DB_PATH} …`);
seedStructure(sqlite, 'Riverside Clinical Laboratory');
sqlite
  .prepare("UPDATE laboratory SET settings_json = ?, name = 'Riverside Clinical Laboratory'")
  .run(JSON.stringify({ demo: true }));

// ---------------------------------------------------------------- users
async function ensureUser(username: string, displayName: string, role: string, password: string): Promise<string> {
  const existing = sqlite.prepare('SELECT id FROM user WHERE username = ?').get(username) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = ulid();
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  sqlite.prepare('INSERT INTO user (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, username, displayName, role, hash);
  return id;
}

const admin = await ensureUser(
  process.env.SENTINEL_USERNAME ?? 'labqc',
  'Lab QC',
  'admin',
  process.env.SENTINEL_ADMIN_PASSWORD ?? 'SET_VIA_SENTINEL_ADMIN_PASSWORD',
);
const sup = await ensureUser('mrivera', 'M. Rivera (supervisor)', 'supervisor', 'supervisor1');
const ops = [
  await ensureUser('jchen', 'J. Chen', 'technician', 'technician1'),
  await ensureUser('adiallo', 'A. Diallo', 'technician', 'technician1'),
  await ensureUser('tpetrov', 'T. Petrov', 'technician', 'technician1'),
  await ensureUser('skim', 'S. Kim', 'technician', 'technician1'),
];

// ------------------------------------------------------------ instruments
function ensureInstrument(label: string, manufacturer: string, model: string, serial: string): string {
  const ex = sqlite.prepare('SELECT id FROM instrument WHERE label = ?').get(label) as { id: string } | undefined;
  if (ex) return ex.id;
  const id = ulid();
  sqlite.prepare('INSERT INTO instrument (id, label, manufacturer, model, serial) VALUES (?, ?, ?, ?, ?)').run(id, label, manufacturer, model, serial);
  return id;
}
const inst1 = ensureInstrument('Reader 1', 'BioTek', 'ELx808', 'BT-88121');
const inst2 = ensureInstrument('Reader 2', 'Tecan', 'Sunrise', 'TC-40417');

// ---------------------------------------------------------------- assays
interface LevelSpec {
  code: string;
  mean: number;
  sd: number;
}
interface AssaySpec {
  name: string;
  profile: 'N2_classic' | 'N3';
  levels: LevelSpec[];
  transform: TransformKind;
}

const START = new Date(Date.now() - 240 * 86400_000);
const DAYS = 240;

function dayIso(day: number, hourMin = '08:30'): string {
  const d = new Date(START.getTime() + day * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${hourMin}:00Z`;
}

function ensureAssay(spec: AssaySpec): string {
  const ex = sqlite.prepare('SELECT id FROM assay WHERE name = ?').get(spec.name) as { id: string } | undefined;
  if (ex) {
    console.log(`assay ${spec.name} already present — skipping its runs`);
    return ex.id;
  }
  const profile = sqlite.prepare('SELECT id FROM westgard_profile WHERE name = ?').get(spec.profile) as { id: string };
  const id = ulid();
  sqlite
    .prepare(
      `INSERT INTO assay (id, name, methodology, units, transform, qc_scheme_json, westgard_profile_id, plating_order, allowable_bias_pct, reader_max)
       VALUES (?, ?, 'ELISA', 'OD', ?, ?, ?, 'randomized', 5, 4.0)`,
    )
    .run(id, spec.name, spec.transform, JSON.stringify({ levels: spec.levels.map((l) => ({ level_code: l.code, replicates: 1 })) }), profile.id);
  return id;
}

interface MaterialInfo {
  id: string;
  spec: LevelSpec;
  baselineId: string | null;
  baselineMean: number;
  baselineSd: number;
}

function addMaterial(assayId: string, spec: LevelSpec, lot: string, from: string, to: string | null): string {
  const id = ulid();
  sqlite
    .prepare(
      `INSERT INTO qc_material (id, assay_id, level_code, manufacturer, lot, expiry, target_mean, target_sd, active_from, active_to)
       VALUES (?, ?, ?, 'BioCheck', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, assayId, spec.code, lot, '2027-12-31', spec.mean, spec.sd, from, to);
  return id;
}

function addReagentLot(assayId: string, lot: string, from: string, to: string | null): string {
  const id = ulid();
  sqlite
    .prepare(`INSERT INTO reagent_lot (id, assay_id, lot, expiry, active_from, active_to) VALUES (?, ?, ?, '2027-12-31', ?, ?)`)
    .run(id, assayId, lot, from, to);
  return id;
}

function freezeBaselineRow(assayId: string, materialId: string, mean: number, sd: number, n: number, effectiveFrom: string): string {
  sqlite.prepare('UPDATE baseline SET effective_to = ? WHERE qc_material_id = ? AND effective_to IS NULL').run(effectiveFrom, materialId);
  const id = ulid();
  sqlite
    .prepare(
      `INSERT INTO baseline (id, assay_id, qc_material_id, mean, sd, n, method, effective_from, frozen_at, frozen_by)
       VALUES (?, ?, ?, ?, ?, ?, 'computed_classical', ?, ?, ?)`,
    )
    .run(id, assayId, materialId, mean, sd, n, effectiveFrom, effectiveFrom, sup);
  appendAudit(sqlite, { userId: sup, entity: 'baseline', entityId: id, action: 'freeze', after: { materialId, mean, sd, n }, at: effectiveFrom });
  return id;
}

/** Insert one run with observations, Westgard evaluation against history, and audit. */
function insertRun(opts: {
  assayId: string;
  profileName: 'N2_classic' | 'N3';
  performedAt: string;
  instrumentId: string;
  operatorId: string;
  reagentLotId: string | null;
  obs: { materialId: string; level: string; raw: number; baselineId: string | null; mean: number; sd: number }[];
  history: WestgardRun[];
  transform: TransformKind;
}): { runId: string; verdict: string; run: WestgardRun } {
  const profileRow = sqlite.prepare('SELECT name, rules_json FROM westgard_profile WHERE name = ?').get(opts.profileName) as { name: string; rules_json: string };
  const profile = { name: profileRow.name, rules: JSON.parse(profileRow.rules_json) };
  const pending = opts.obs.map((o) => {
    const x = applyTransform(opts.transform, o.raw);
    const z = o.baselineId ? (x - o.mean) / o.sd : null;
    return { id: ulid(), ...o, x, z };
  });
  const haveZ = pending.every((p) => p.z !== null);
  const current: WestgardRun = {
    runId: 'cur',
    observations: pending.filter((p) => p.z !== null).map((p) => ({ id: p.id, level: p.level, z: p.z as number })),
  };
  const evalRes = haveZ ? evaluateRun(opts.history, current, profile) : { verdict: 'pass' as const, evaluations: [] };
  const runId = ulid();
  sqlite
    .prepare(
      `INSERT INTO run (id, assay_id, instrument_id, operator_user_id, reagent_lot_id, performed_at, entered_at, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, opts.assayId, opts.instrumentId, opts.operatorId, opts.reagentLotId, opts.performedAt, opts.performedAt, evalRes.verdict);
  const insObs = sqlite.prepare(
    `INSERT INTO observation (id, run_id, qc_material_id, replicate_index, raw_value, transformed_value, baseline_id, z, flags_json)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );
  for (const p of pending) insObs.run(p.id, runId, p.materialId, p.raw, p.x, p.baselineId, p.z, JSON.stringify(p.baselineId ? [] : ['no_baseline']));
  const insEval = sqlite.prepare(
    `INSERT INTO rule_evaluation (id, run_id, rule, scope, status, observation_ids_json, message) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of evalRes.evaluations) insEval.run(ulid(), runId, e.rule, e.scope, e.status, JSON.stringify(e.observationIds), e.message);
  appendAudit(sqlite, { userId: opts.operatorId, entity: 'run', entityId: runId, action: 'create', after: { assayId: opts.assayId, verdict: evalRes.verdict }, at: opts.performedAt });
  current.runId = runId;
  current.included = evalRes.verdict !== 'reject';
  return { runId, verdict: evalRes.verdict, run: current };
}

function overrideRunRow(runId: string, reason: string, at: string): void {
  sqlite.prepare("UPDATE run SET override_status = 'accepted', override_reason = ?, override_by = ? WHERE id = ?").run(reason, sup, runId);
  appendAudit(sqlite, { userId: sup, entity: 'run', entityId: runId, action: 'override', reason, at });
}

// ================================================================ HBsAg — stable + rejections
{
  const spec: AssaySpec = {
    name: 'HBsAg ELISA',
    profile: 'N2_classic',
    transform: 'none',
    levels: [
      { code: 'L1', mean: 0.1, sd: 0.01 },
      { code: 'L2', mean: 1.4, sd: 0.12 },
    ],
  };
  const assayId = ensureAssay(spec);
  const already = sqlite.prepare('SELECT COUNT(*) c FROM run WHERE assay_id = ?').get(assayId) as { c: number };
  if (already.c === 0) {
    const mats = spec.levels.map((l) => ({ l, id: addMaterial(assayId, l, `HB-${l.code}-31`, dayIso(0), null) }));
    const lot1 = addReagentLot(assayId, '5A112', dayIso(0), dayIso(120));
    const lot2 = addReagentLot(assayId, '5B440', dayIso(120), null);
    const baselineByMat = new Map<string, { id: string | null; mean: number; sd: number }>();
    for (const m of mats) baselineByMat.set(m.id, { id: null, mean: m.l.mean, sd: m.l.sd });
    const history: WestgardRun[] = [];
    const raws: Record<string, number[]> = {};
    for (let day = 0; day < DAYS; day++) {
      if (day === 21) {
        // freeze baselines from the first 20 observations
        for (const m of mats) {
          const vals = raws[m.id] ?? [];
          const res = computeBaseline({ values: vals, ids: vals.map((_, i) => `x${i}`) });
          if (res.ok) baselineByMat.set(m.id, { id: freezeBaselineRow(assayId, m.id, res.mean, res.sd, res.n, dayIso(21, '07:00')), mean: res.mean, sd: res.sd });
        }
      }
      const operator = ops[rng.nextInt(ops.length)];
      const instrument = rng.nextFloat() < 0.7 ? inst1 : inst2;
      const obs = mats.map((m) => {
        let z = rng.nextNormal();
        // teachable events on specific days
        if (day === 150 && m.l.code === 'L1') z = 2.35; // isolated warning
        if (day === 190) z = m.l.code === 'L1' ? 2.3 : 2.4; // 2_2s rejection (overridden)
        if (day === 215 && m.l.code === 'L2') z = -3.4; // 1_3s rejection
        const bl = baselineByMat.get(m.id)!;
        const raw = bl.mean + z * bl.sd;
        (raws[m.id] ??= []).push(raw);
        return { materialId: m.id, level: m.l.code, raw, baselineId: bl.id, mean: bl.mean, sd: bl.sd };
      });
      const { runId, verdict, run } = insertRun({
        assayId,
        profileName: 'N2_classic',
        performedAt: dayIso(day),
        instrumentId: instrument,
        operatorId: operator,
        reagentLotId: day < 120 ? lot1 : lot2,
        obs,
        history: history.slice(-15),
        transform: 'none',
      });
      if (day === 190 && verdict === 'reject') {
        overrideRunRow(runId, 'Both controls re-run after fresh calibrator; repeat in range. Kit insert bulletin 26 noted.', dayIso(day, '10:05'));
        run.included = true;
      }
      history.push(run);
    }
    console.log('HBsAg ELISA: 240 runs');
  }
}

// ================================================================ Anti-HCV — control-lot change + variance increase
{
  const spec: AssaySpec = {
    name: 'Anti-HCV ELISA',
    profile: 'N2_classic',
    transform: 'none',
    levels: [
      { code: 'L1', mean: 0.09, sd: 0.008 },
      { code: 'L2', mean: 1.1, sd: 0.09 },
    ],
  };
  const assayId = ensureAssay(spec);
  const already = sqlite.prepare('SELECT COUNT(*) c FROM run WHERE assay_id = ?').get(assayId) as { c: number };
  if (already.c === 0) {
    const lotChangeDay = 160;
    const matsA = spec.levels.map((l) => ({ l, id: addMaterial(assayId, l, `HC-${l.code}-07`, dayIso(0), dayIso(lotChangeDay)) }));
    // new control lot with slightly different mean
    const matsB = spec.levels.map((l, i) => ({
      l: { ...l, mean: l.mean * 1.06 },
      id: addMaterial(assayId, { ...l, mean: l.mean * 1.06 }, `HC-${l.code}-08`, dayIso(lotChangeDay), null),
      old: matsA[i].id,
    }));
    const lot1 = addReagentLot(assayId, '7C221', dayIso(0), null);
    const baselineByMat = new Map<string, { id: string | null; mean: number; sd: number }>();
    const history: WestgardRun[] = [];
    const raws: Record<string, number[]> = {};
    for (const m of matsA) baselineByMat.set(m.id, { id: null, mean: m.l.mean, sd: m.l.sd });
    for (const m of matsB) baselineByMat.set(m.id, { id: null, mean: m.l.mean, sd: m.l.sd });
    for (let day = 0; day < DAYS; day++) {
      const freezeFrom = (mats: { id: string }[], onDay: number) => {
        for (const m of mats) {
          const vals = raws[m.id] ?? [];
          if (vals.length < 10) continue;
          const res = computeBaseline({ values: vals.slice(0, 20), ids: vals.slice(0, 20).map((_, i) => `x${i}`) });
          if (res.ok) baselineByMat.set(m.id, { id: freezeBaselineRow(assayId, m.id, res.mean, res.sd, res.n, dayIso(onDay, '07:00')), mean: res.mean, sd: res.sd });
        }
      };
      if (day === 21) freezeFrom(matsA, 21);
      if (day === lotChangeDay + 21) freezeFrom(matsB, lotChangeDay + 21);
      const mats = day < lotChangeDay ? matsA : matsB;
      const varInflate = day >= DAYS - 30 ? 1.8 : 1.0; // late variance increase
      const obs = mats.map((m) => {
        const z = rng.nextNormal() * varInflate;
        const bl = baselineByMat.get(m.id)!;
        // raw comes from the material's true distribution; stored z is vs the frozen baseline
        const raw = m.l.mean + z * m.l.sd;
        (raws[m.id] ??= []).push(raw);
        return { materialId: m.id, level: m.l.code, raw, baselineId: bl.id, mean: bl.mean, sd: bl.sd };
      });
      const { run } = insertRun({
        assayId,
        profileName: 'N2_classic',
        performedAt: dayIso(day, '09:10'),
        instrumentId: inst1,
        operatorId: ops[rng.nextInt(ops.length)],
        reagentLotId: lot1,
        obs,
        history: history.slice(-15),
        transform: 'none',
      });
      history.push(run);
    }
    console.log('Anti-HCV ELISA: 240 runs (control-lot change + late variance increase)');
  }
}

// ================================================================ HIV Ag/Ab — drift + reagent-lot shift
{
  const spec: AssaySpec = {
    name: 'HIV Ag/Ab ELISA',
    profile: 'N3',
    transform: 'none',
    levels: [
      { code: 'L1', mean: 0.12, sd: 0.012 },
      { code: 'L2', mean: 0.9, sd: 0.08 },
      { code: 'L3', mean: 2.2, sd: 0.2 },
    ],
  };
  const assayId = ensureAssay(spec);
  const already = sqlite.prepare('SELECT COUNT(*) c FROM run WHERE assay_id = ?').get(assayId) as { c: number };
  if (already.c === 0) {
    const mats = spec.levels.map((l) => ({ l, id: addMaterial(assayId, l, `HIV-${l.code}-12`, dayIso(0), null) }));
    const lotChangeDay = 100;
    const lot1 = addReagentLot(assayId, '7A005', dayIso(0), dayIso(lotChangeDay));
    const lot2 = addReagentLot(assayId, '7A019', dayIso(lotChangeDay), null);
    const baselineByMat = new Map<string, { id: string | null; mean: number; sd: number }>();
    for (const m of mats) baselineByMat.set(m.id, { id: null, mean: m.l.mean, sd: m.l.sd });
    const history: WestgardRun[] = [];
    const raws: Record<string, number[]> = {};
    for (let day = 0; day < DAYS; day++) {
      if (day === 21) {
        for (const m of mats) {
          const vals = raws[m.id] ?? [];
          const res = computeBaseline({ values: vals, ids: vals.map((_, i) => `x${i}`) });
          if (res.ok) baselineByMat.set(m.id, { id: freezeBaselineRow(assayId, m.id, res.mean, res.sd, res.n, dayIso(21, '07:00')), mean: res.mean, sd: res.sd });
        }
      }
      const obs = mats.map((m) => {
        let z = rng.nextNormal();
        // sudden +1 SD on L2 two runs after the reagent lot change
        if (m.l.code === 'L2' && day >= lotChangeDay + 2) z += 1.0;
        // slow upward drift on L1: +0.03 SD/run from run 142, capped at +1.2 SD.
        // EWMA/CUSUM signal near run ~155 while the first 6x rejection lands later —
        // the point of the demo is the earlier warning, not Westgard blindness forever.
        if (m.l.code === 'L1') {
          const driftStart = 142;
          if (day >= driftStart) z += Math.min((day - driftStart) * 0.03, 1.2);
        }
        const bl = baselineByMat.get(m.id)!;
        const raw = bl.mean + z * bl.sd;
        (raws[m.id] ??= []).push(raw);
        return { materialId: m.id, level: m.l.code, raw, baselineId: bl.id, mean: bl.mean, sd: bl.sd };
      });
      const { run } = insertRun({
        assayId,
        profileName: 'N3',
        performedAt: dayIso(day, '10:00'),
        instrumentId: rng.nextFloat() < 0.5 ? inst1 : inst2,
        operatorId: ops[rng.nextInt(ops.length)],
        reagentLotId: day < lotChangeDay ? lot1 : lot2,
        obs,
        history: history.slice(-15),
        transform: 'none',
      });
      history.push(run);
    }
    console.log('HIV Ag/Ab ELISA: 240 runs (drift caught by EWMA/CUSUM; +1 SD after lot change)');
  }
}

// ================================================================ plates (60 clean + phase II) on HBsAg
{
  const assay = sqlite.prepare("SELECT id FROM assay WHERE name = 'HBsAg ELISA'").get() as { id: string };
  const platesExist = sqlite.prepare('SELECT COUNT(*) c FROM plate WHERE assay_id = ?').get(assay.id) as { c: number };
  if (platesExist.c === 0) {
    const layout = standardLayout();
    const layoutId = ulid();
    sqlite
      .prepare('INSERT INTO plate_layout (id, assay_id, name, well_types_json) VALUES (?, ?, ?, ?)')
      .run(layoutId, assay.id, 'Standard 96-well screening', JSON.stringify(layout));
    const vectors: number[][] = [];
    const plateIds: string[] = [];
    const plateRng = new Pcg32(777);
    for (let k = 0; k < 60; k++) {
      const p = generatePlate(plateRng, { negSigma: 0.3, prevalence: 0.08 });
      const res = psad({ values: p.values, wellTypes: p.wellTypes, B: 499, seed: 1000 + k });
      const spatial = res.findings.filter((f) => f.kind !== 'local_outlier');
      const plateId = ulid();
      const at = dayIso(DAYS - 70 + k, '11:00');
      sqlite
        .prepare(
          `INSERT INTO plate (id, assay_id, rows, cols, imported_at, source_filename, transform_used, layout_id) VALUES (?, ?, 8, 12, ?, ?, 'log', ?)`,
        )
        .run(plateId, assay.id, at, `daily_plate_${String(k + 1).padStart(2, '0')}.csv`, layoutId);
      const insWell = sqlite.prepare(
        `INSERT INTO well_measurement (id, plate_id, row, col, well_type, raw_value, transformed_value, residual, z_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 12; j++) {
          insWell.run(ulid(), plateId, i, j, layout[i][j], p.values[i][j], res.transformed[i][j], res.residuals[i][j], res.zLocal[i][j]);
        }
      }
      sqlite
        .prepare(
          `INSERT INTO plate_analysis (id, plate_id, params_json, mu, row_effects_json, col_effects_json, edge_stat, grad_json, moran_i, pvalues_json, findings_json, analyzed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ulid(),
          plateId,
          JSON.stringify({ B: res.B, alpha: res.alpha, seed: res.seed, transform: 'log', ok: res.ok, nSampleWells: res.nSampleWells, suppressedPValues: false, featureVector: res.featureVector, statistics: res.statistics }),
          res.statistics!.mu,
          JSON.stringify(res.rowEffects),
          JSON.stringify(res.colEffects),
          res.statistics!.tEdge,
          JSON.stringify({ br: res.statistics!.gradientBr, bc: res.statistics!.gradientBc, tGrad: res.statistics!.tGrad }),
          res.statistics!.moranI,
          JSON.stringify(res.pValues),
          JSON.stringify(res.findings),
          at,
        );
      if (spatial.length === 0 && res.featureVector) {
        vectors.push(res.featureVector);
        plateIds.push(plateId);
      }
    }
    if (vectors.length >= 30) {
      const model = buildPhase2Model(vectors, { alpha: 0.01 });
      sqlite
        .prepare(
          `INSERT INTO plate_phase2_model (id, assay_id, n_plates, loadings_json, eigen_json, means_json, scales_json, a_components, t2_ucl, spe_ucl, built_at, plate_ids_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ulid(),
          assay.id,
          model.n,
          JSON.stringify(model.loadings),
          JSON.stringify({ retained: model.eigenvalues, all: model.allEigenvalues }),
          JSON.stringify(model.means),
          JSON.stringify(model.scales),
          model.aComponents,
          model.t2Ucl,
          model.speUcl,
          dayIso(DAYS - 5),
          JSON.stringify(plateIds),
        );
      console.log(`plates: 60 imported, Phase-II model from ${model.n} clean plates (${model.aComponents} components)`);
    } else {
      console.log(`plates: 60 imported, only ${vectors.length} clean — Phase-II model NOT built`);
    }
  }
}

// ================================================================ fault plate CSVs to import live
{
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plates');
  mkdirSync(outDir, { recursive: true });
  const writePlate = (name: string, mutate?: (p: ReturnType<typeof generatePlate>, r: Pcg32) => void) => {
    const r = new Pcg32(name.length * 7919 + 5);
    const p = generatePlate(r, { negSigma: 0.3, prevalence: 0.08 });
    // keep control wells tight so the accompanying QC run passes Westgard
    p.values[1][0] = 0.079;
    p.values[2][0] = 0.082;
    p.values[3][0] = 1.22;
    p.values[4][0] = 1.18;
    mutate?.(p, r);
    const csv = p.values.map((row) => row.map((v) => (v === null ? '' : (v as number).toFixed(4))).join(',')).join('\n');
    writeFileSync(join(outDir, name), csv);
  };
  writePlate('demo_plate_clean.csv');
  writePlate('demo_plate_edge.csv', (p) => injectEdgeEffect(p, -0.31));
  writePlate('demo_plate_rowF.csv', (p) => injectRowBias(p, 5, 0.8));
  writePlate('demo_plate_col11_12.csv', (p) => {
    injectColBias(p, 10, 0.9);
    injectColBias(p, 11, 0.9);
  });
  writePlate('demo_plate_gradient.csv', (p) => injectGradient(p, 1.6));
  console.log(`fault plate CSVs written to ${outDir}`);
}

console.log('Demo seed complete. Sign in as labqc / SET_VIA_SENTINEL_ADMIN_PASSWORD (extra demo accounts: mrivera/supervisor1, jchen/technician1).');
