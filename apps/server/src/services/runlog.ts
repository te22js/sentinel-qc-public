/**
 * The QC run log — the lab's actual mental model, after the report they already use:
 * a sequence of runs (date · technician · kit lot · value [+ cutoff → E-ratio]),
 * control limits, per-run rule flags, and a single In-Control / Out-of-Control status.
 *
 * Limits come from one of two sources, chosen automatically per level:
 *  - a frozen baseline when one exists (prospective QC, the rigorous mode), or
 *  - self-derived limits estimated from the runs in view.
 *
 * Two methodological safeguards on self-derived limits (both would otherwise be
 * genuine statistical flaws of the naive approach):
 *
 *  1. LEAVE-ONE-OUT STANDARDIZATION. A run judged against limits that include
 *     itself pulls the mean toward itself and inflates the SD, shrinking its own
 *     z-score (masking). Each run's flagging z is therefore computed against limits
 *     estimated from the OTHER runs (deletion/externally-studentized form), after a
 *     robust screen (modified z > 3.5 on median/MAD) removes gross outliers from
 *     estimation entirely. Rule flags are additionally suppressed until
 *     MIN_FLAG_N runs exist — below that the SD estimate is too uncertain for
 *     ±2SD/±3SD limits to mean anything (limits shown, marked provisional).
 *
 *  2. LOG SCALE FOR RATIOS. The E-ratio (IQC OD / cutoff OD) is a positive ratio
 *     with multiplicative error — right-skewed, so symmetric mean±kSD limits
 *     over-alarm on the high side and squash the lower limit toward the physical
 *     floor, blunting sensitivity to the clinically important low-signal failures.
 *     For ratio assays limits and z-scores are computed on ln(E-ratio); the
 *     displayed bands are back-transformed (geometric, asymmetric in E-ratio units).
 *
 * Westgard evaluation is sequential over the chronological series with the same
 * engine used everywhere else.
 */
import { evaluateRun, mean as meanOf, sd as sdOf, median, robustSd, type WestgardRun } from '@sentinel/stats';
import type Database from 'better-sqlite3';
import { getAssay, getScheme, currentBaseline } from './context.js';
import { loadProfile } from './runs.js';

/** rule flags are suppressed below this many kept runs (limits shown as provisional) */
export const MIN_FLAG_N = 6;

export interface RunLogRow {
  runNo: number; // 1 = newest (report convention)
  runId: string;
  /** current (non-superseded) observation id — target for corrections */
  obsId: string;
  performedAt: string;
  technician: string | null;
  kitLot: string | null;
  /** raw entered value(s) for this level (replicates joined) */
  raw: number;
  cutoff: number | null;
  /** transformed value (E-ratio for ratio assays; otherwise per transform) */
  value: number;
  z: number | null;
  flags: string[]; // fired rule ids, [] = OK
  verdictStored: string;
  overrideStatus: string;
}

export interface Bands {
  p3: number;
  p2: number;
  p1: number;
  mean: number;
  m1: number;
  m2: number;
  m3: number;
}

export interface RunLogResult {
  ok: boolean;
  error?: string;
  assayName?: string;
  levelCode?: string;
  valueLabel?: string; // "E-ratio" | units
  limits?: {
    source: 'self' | 'baseline';
    /** estimation scale — 'log' for ratio assays in self mode (geometric bands) */
    scale: 'log' | 'linear';
    /** display-scale center (geometric mean when scale = 'log') */
    mean: number;
    /** estimation-scale SD (log-SD when scale = 'log') */
    sd: number;
    n: number;
    baselineMethod?: string;
    /** gross outliers excluded from self-limit estimation (still plotted and flagged) */
    excluded?: number;
    /** flags suppressed until MIN_FLAG_N runs (self mode only) */
    provisional?: boolean;
    bands: Bands;
  } | null;
  stats?: { n: number; mean: number | null; sd: number | null; cv: number | null };
  status?: { inControl: boolean; violations: number; rejects: number; warnings: number; message: string };
  /** newest first, as on the printed log */
  rows?: RunLogRow[];
  /** oldest first, for the chart */
  series?: { performedAt: string; value: number; z: number | null; flags: string[] }[];
}

// ---------------------------------------------------------------------------
// self-derived limit evaluator
// ---------------------------------------------------------------------------

export interface SelfEval {
  /** kept (estimation) count after the robust screen */
  n: number;
  excluded: number;
  scale: 'log' | 'linear';
  /** display-scale center and bands (null when limits are undefined) */
  center: number | null;
  bands: Bands | null;
  /** estimation-scale full statistics */
  muS: number;
  sdS: number;
  /** enough runs for rule flags */
  eligible: boolean;
  /** flagging z for value index i: leave-one-out for kept points, screen-z for excluded */
  zFor(i: number): number | null;
  /** plain z against the full kept statistics (for monitors, which need one common scale) */
  zPlainFor(i: number): number | null;
}

/**
 * Build the self-derived evaluator over a chronological value series.
 * `useLog` puts estimation on ln(x) (ratio data); falls back to linear if any
 * value is non-positive.
 */
export function makeSelfEval(values: readonly number[], useLog: boolean): SelfEval | null {
  if (values.length === 0) return null;
  const log = useLog && values.every((v) => v > 0);
  const scale: 'log' | 'linear' = log ? 'log' : 'linear';
  const s = values.map((v) => (log ? Math.log(v) : v));

  // robust screen on the estimation scale
  const med = median(s);
  const rsd = robustSd(s);
  const keptIdx = new Set<number>();
  s.forEach((v, i) => {
    if (!(rsd > 0) || Math.abs(v - med) / rsd <= 3.5) keptIdx.add(i);
  });
  if (keptIdx.size < 2) s.forEach((_, i) => keptIdx.add(i));
  const kept = [...keptIdx].map((i) => s[i]);
  const n = kept.length;
  const excluded = values.length - n;

  const muS = meanOf(kept);
  const sdS = n >= 2 ? sdOf(kept) : 0;
  const disp = (v: number) => (log ? Math.exp(v) : v);
  const defined = sdS > 0;
  const S1 = kept.reduce((a, b) => a + b, 0);
  const S2 = kept.reduce((a, b) => a + b * b, 0);

  const zFor = (i: number): number | null => {
    if (!defined) return null;
    const si = s[i];
    if (!keptIdx.has(i) || n < 3) return (si - muS) / sdS;
    // leave-one-out mean/SD from running sums
    const m1 = (S1 - si) / (n - 1);
    const varLoo = (S2 - si * si - (n - 1) * m1 * m1) / (n - 2);
    if (!(varLoo > 0)) return (si - muS) / sdS;
    return (si - m1) / Math.sqrt(varLoo);
  };

  return {
    n,
    excluded,
    scale,
    center: defined ? disp(muS) : null,
    bands: defined
      ? {
          p3: disp(muS + 3 * sdS),
          p2: disp(muS + 2 * sdS),
          p1: disp(muS + sdS),
          mean: disp(muS),
          m1: disp(muS - sdS),
          m2: disp(muS - 2 * sdS),
          m3: disp(muS - 3 * sdS),
        }
      : null,
    muS,
    sdS,
    eligible: defined && n >= MIN_FLAG_N,
    zFor,
    zPlainFor: (i: number) => (defined ? (s[i] - muS) / sdS : null),
  };
}

// ---------------------------------------------------------------------------

export function runLog(
  sqlite: Database.Database,
  assayId: string,
  levelCode?: string,
  from?: string,
  to?: string,
): RunLogResult {
  const assay = getAssay(sqlite, assayId);
  if (!assay) return { ok: false, error: 'assay not found' };
  const scheme = getScheme(assay);
  const level = levelCode ?? scheme.levels[0]?.level_code;
  if (!level) return { ok: false, error: 'assay has no levels' };
  const isRatio = assay.transform === 'ratio_to_cutoff';
  const valueLabel = isRatio ? 'E-ratio' : assay.units;

  // fetch ALL levels' observations — within-run rules (2_2s, R_4s, 2of3_2s) span
  // levels, so the Westgard evaluation must see complete runs; the returned rows
  // and series are then filtered to the requested level
  const allObs = sqlite
    .prepare(
      `SELECT o.id as obsId, o.raw_value as raw, o.transformed_value as value, o.z as zStored,
              o.cutoff_value as cutoff, m.level_code as levelCode, m.id as materialId,
              r.id as runId, r.performed_at as performedAt,
              r.technician, r.kit_lot as kitLot, r.verdict, r.override_status as overrideStatus,
              u.display_name as operator
       FROM observation o
       JOIN qc_material m ON m.id = o.qc_material_id
       JOIN run r ON r.id = o.run_id
       JOIN user u ON u.id = r.operator_user_id
       WHERE m.assay_id = ? AND o.superseded = 0
         AND (? IS NULL OR r.performed_at >= ?)
         AND (? IS NULL OR r.performed_at <= ?)
       ORDER BY r.performed_at ASC, r.id ASC, m.level_code ASC, o.replicate_index ASC`,
    )
    .all(assayId, from ?? null, from ?? null, to ?? null, to ?? null) as {
    obsId: string;
    raw: number;
    value: number;
    zStored: number | null;
    cutoff: number | null;
    levelCode: string;
    materialId: string;
    runId: string;
    performedAt: string;
    technician: string | null;
    kitLot: string | null;
    verdict: string;
    overrideStatus: string;
    operator: string;
  }[];
  const obs = allObs.filter((o) => o.levelCode === level);

  const empty: RunLogResult = {
    ok: true,
    assayName: assay.name,
    levelCode: level,
    valueLabel,
    limits: null,
    stats: { n: 0, mean: null, sd: null, cv: null },
    status: { inControl: true, violations: 0, rejects: 0, warnings: 0, message: 'No runs yet.' },
    rows: [],
    series: [],
  };
  if (obs.length === 0) return empty;

  // ----- per-level evaluators: frozen baseline > self-derived (LOO, log for ratios)
  const now = new Date().toISOString();
  const zByObs = new Map<string, number | null>();
  const levelEligible = new Map<string, boolean>();
  let selectedEval: SelfEval | null = null;
  let selectedBaseline: ReturnType<typeof currentBaseline> = null;

  for (const lc of new Set(allObs.map((o) => o.levelCode))) {
    const levelObs = allObs.filter((o) => o.levelCode === lc);
    const bl = currentBaseline(sqlite, levelObs[0].materialId, now);
    if (bl) {
      for (const o of levelObs) zByObs.set(o.obsId, (o.value - bl.mean) / bl.sd);
      levelEligible.set(lc, true);
      if (lc === level) selectedBaseline = bl;
    } else {
      const ev = makeSelfEval(levelObs.map((o) => o.value), isRatio);
      levelObs.forEach((o, i) => zByObs.set(o.obsId, ev?.zFor(i) ?? null));
      levelEligible.set(lc, ev?.eligible ?? false);
      if (lc === level) selectedEval = ev;
    }
  }

  // ----- selected-level limits object
  const values = obs.map((o) => o.value);
  let limits: RunLogResult['limits'] = null;
  if (selectedBaseline) {
    limits = {
      source: 'baseline',
      scale: 'linear',
      mean: selectedBaseline.mean,
      sd: selectedBaseline.sd,
      n: selectedBaseline.n,
      baselineMethod: selectedBaseline.method,
      bands: linearBands(selectedBaseline.mean, selectedBaseline.sd),
    };
  } else if (selectedEval?.bands) {
    limits = {
      source: 'self',
      scale: selectedEval.scale,
      mean: selectedEval.center!,
      sd: selectedEval.sdS,
      n: selectedEval.n,
      excluded: selectedEval.excluded,
      provisional: !selectedEval.eligible,
      bands: selectedEval.bands,
    };
  }

  // ----- sequential Westgard evaluation over COMPLETE runs (eligible levels only)
  const profile = loadProfile(sqlite, assay.westgard_profile_id);
  const flagsByObs = new Map<string, Set<string>>();
  const stream: WestgardRun[] = [];
  const runsInOrder: { runId: string; obs: typeof allObs }[] = [];
  for (const o of allObs) {
    const last = runsInOrder[runsInOrder.length - 1];
    if (last && last.runId === o.runId) last.obs.push(o);
    else runsInOrder.push({ runId: o.runId, obs: [o] });
  }
  for (const r of runsInOrder) {
    const observations = r.obs
      .filter((o) => levelEligible.get(o.levelCode) === true)
      .map((o) => ({ id: o.obsId, level: o.levelCode, z: zByObs.get(o.obsId) ?? null }))
      .filter((x): x is { id: string; level: string; z: number } => x.z !== null);
    if (observations.length === 0) continue;
    const current: WestgardRun = { runId: r.runId, observations };
    const res = evaluateRun(stream, current, profile);
    for (const ev of res.evaluations) {
      if (ev.status === 'warning' || ev.status === 'reject') {
        for (const id of ev.observationIds) {
          (flagsByObs.get(id) ?? flagsByObs.set(id, new Set()).get(id)!).add(ev.rule);
        }
      }
    }
    current.included = res.verdict !== 'reject';
    stream.push(current);
  }

  // ----- assemble
  const seriesAsc = obs.map((o) => ({
    performedAt: o.performedAt,
    value: o.value,
    z: zByObs.get(o.obsId) ?? null,
    flags: Array.from(flagsByObs.get(o.obsId) ?? []),
  }));
  const rows = obs
    .slice()
    .reverse()
    .map((o, i) => ({
      runNo: i + 1,
      runId: o.runId,
      obsId: o.obsId,
      performedAt: o.performedAt,
      technician: o.technician ?? o.operator,
      kitLot: o.kitLot,
      raw: o.raw,
      cutoff: o.cutoff,
      value: o.value,
      z: zByObs.get(o.obsId) ?? null,
      flags: Array.from(flagsByObs.get(o.obsId) ?? []),
      verdictStored: o.verdict,
      overrideStatus: o.overrideStatus,
    }));

  const rejects = new Set<string>();
  const warned = new Set<string>();
  const levelObsIds = new Set(obs.map((o) => o.obsId));
  for (const [obsId, rules] of flagsByObs) {
    if (!levelObsIds.has(obsId)) continue; // status reflects the selected level
    const onlyWarning = Array.from(rules).every((r) => r === '1_2s');
    (onlyWarning ? warned : rejects).add(obsId);
  }
  const m = meanOf(values);
  const s = values.length >= 2 ? sdOf(values) : null;
  const provisional = limits?.source === 'self' && limits.provisional;
  const status = {
    inControl: rejects.size === 0,
    violations: flagsByObs.size,
    rejects: rejects.size,
    warnings: warned.size,
    message:
      limits === null
        ? values.length < 2
          ? 'Enter at least 2 runs to establish control limits.'
          : 'Values are identical — limits undefined.'
        : provisional
          ? `Provisional limits from ${limits.n} runs — rule flags start at ${MIN_FLAG_N} runs.`
          : rejects.size === 0
            ? warned.size === 0
              ? 'No rule violations detected'
              : `${warned.size} warning${warned.size === 1 ? '' : 's'} (1_2s) — no rejection rule fired`
            : `${rejects.size} run${rejects.size === 1 ? '' : 's'} violate${rejects.size === 1 ? 's' : ''} rejection rules`,
  };
  return {
    ok: true,
    assayName: assay.name,
    levelCode: level,
    valueLabel,
    limits,
    stats: { n: values.length, mean: m, sd: s, cv: s !== null && m !== 0 ? (s / Math.abs(m)) * 100 : null },
    status,
    rows,
    series: seriesAsc,
  };
}

function linearBands(mean: number, sd: number): Bands {
  return {
    p3: mean + 3 * sd,
    p2: mean + 2 * sd,
    p1: mean + sd,
    mean,
    m1: mean - sd,
    m2: mean - 2 * sd,
    m3: mean - 3 * sd,
  };
}
