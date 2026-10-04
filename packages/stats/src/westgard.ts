/**
 * Westgard multirule engine.
 *
 * Reference: Westgard JO, Barry PL, Hunt MR, Groth T. "A multi-rule Shewhart chart for
 * quality control in clinical chemistry." Clin Chem 1981;27:493–501; and the rule
 * semantics described at westgard.com (within-run vs across-run interpretations).
 *
 * The engine evaluates the CURRENT run against an ordered history of runs for one assay.
 * Each run is an ordered list of observations (level order, then replicate order),
 * each observation a z-score against its frozen baseline.
 *
 * Streams:
 *  - within-run stream: the current run's observations in order.
 *  - per-level stream:  observations of one level across included runs, run order.
 *  - pooled stream:     all observations run by run (each run in level order). This is the
 *    stream on which 6x can fire while 2of3_2s does not (the Westgard example).
 *
 * "Consecutive" always means consecutive in the evaluated stream. Runs that were rejected
 * and not supervisor-accepted are excluded from across-run look-back by default
 * (configurable via `includeRejectedRuns`).
 *
 * Boundary convention: all limits are strict (|z| > 2, not ≥), so z = 2.0 exactly does
 * not trigger a 2s rule.
 */

export type RuleId =
  | '1_2s'
  | '1_3s'
  | '2_2s'
  | '2of3_2s'
  | 'R_4s'
  | '3_1s'
  | '4_1s'
  | '6x'
  | '8x'
  | '9x'
  | '10x'
  | '12x'
  | '7T';

export type RuleScope = 'within_run' | 'across_runs' | 'both';
export type Severity = 'warning' | 'reject';
export type RuleStatus = 'not_applicable' | 'pass' | 'warning' | 'reject';
export type Verdict = 'pass' | 'warning' | 'reject';

export interface WestgardObs {
  id: string;
  level: string;
  z: number;
}

export interface WestgardRun {
  runId: string;
  /** ordered: level order, then replicate order */
  observations: WestgardObs[];
  /** false when the run was rejected and not supervisor-accepted (excluded from look-back) */
  included?: boolean;
}

export interface ProfileRule {
  rule: RuleId;
  enabled: boolean;
  scope: RuleScope;
  severity: Severity;
}

export interface WestgardProfile {
  name: string;
  rules: ProfileRule[];
  /** include rejected-not-accepted runs in across-run look-back (default false) */
  includeRejectedRuns?: boolean;
}

export interface RuleEvaluation {
  rule: RuleId;
  scope: 'within_run' | 'across_runs';
  status: RuleStatus;
  observationIds: string[];
  message: string;
}

export interface WestgardResult {
  verdict: Verdict;
  evaluations: RuleEvaluation[];
}

/** Built-in profile for N=2 controls per run: 1_2s(warn)/1_3s/2_2s/R_4s/4_1s/10x. */
export const PROFILE_N2_CLASSIC: WestgardProfile = {
  name: 'N2_classic',
  rules: [
    { rule: '1_2s', enabled: true, scope: 'within_run', severity: 'warning' },
    { rule: '1_3s', enabled: true, scope: 'within_run', severity: 'reject' },
    { rule: '2_2s', enabled: true, scope: 'both', severity: 'reject' },
    { rule: 'R_4s', enabled: true, scope: 'within_run', severity: 'reject' },
    { rule: '4_1s', enabled: true, scope: 'across_runs', severity: 'reject' },
    { rule: '10x', enabled: true, scope: 'across_runs', severity: 'reject' },
  ],
};

/** Built-in profile for N=3: 1_3s/2of3_2s/R_4s/3_1s/6x (9x optional, off). */
export const PROFILE_N3: WestgardProfile = {
  name: 'N3',
  rules: [
    { rule: '1_2s', enabled: true, scope: 'within_run', severity: 'warning' },
    { rule: '1_3s', enabled: true, scope: 'within_run', severity: 'reject' },
    { rule: '2of3_2s', enabled: true, scope: 'within_run', severity: 'reject' },
    { rule: 'R_4s', enabled: true, scope: 'within_run', severity: 'reject' },
    { rule: '3_1s', enabled: true, scope: 'both', severity: 'reject' },
    { rule: '6x', enabled: true, scope: 'across_runs', severity: 'reject' },
    { rule: '9x', enabled: false, scope: 'across_runs', severity: 'reject' },
  ],
};

const K_OF: Partial<Record<RuleId, number>> = { '6x': 6, '8x': 8, '9x': 9, '10x': 10, '12x': 12 };

/** last n items of an array (fewer if shorter) */
function lastN<T>(xs: T[], n: number): T[] {
  return xs.slice(Math.max(0, xs.length - n));
}

function sameSignBeyond(obs: WestgardObs[], limit: number): boolean {
  if (obs.length === 0) return false;
  return obs.every((o) => o.z > limit) || obs.every((o) => o.z < -limit);
}

function sameSideOfMean(obs: WestgardObs[]): boolean {
  if (obs.length === 0) return false;
  return obs.every((o) => o.z > 0) || obs.every((o) => o.z < 0);
}

function fmt(z: number): string {
  return (z >= 0 ? '+' : '') + z.toFixed(2);
}

export function evaluateRun(
  history: WestgardRun[],
  current: WestgardRun,
  profile: WestgardProfile,
): WestgardResult {
  const includeRejected = profile.includeRejectedRuns ?? false;
  const included = history.filter((r) => includeRejected || r.included !== false);
  const stream = [...included, current];

  const cur = current.observations;
  const levels = Array.from(new Set(stream.flatMap((r) => r.observations.map((o) => o.level))));
  const levelStreams = new Map<string, WestgardObs[]>();
  for (const level of levels) {
    levelStreams.set(
      level,
      stream.flatMap((r) => r.observations.filter((o) => o.level === level)),
    );
  }
  const pooled = stream.flatMap((r) => r.observations);

  const evaluations: RuleEvaluation[] = [];

  const push = (
    rule: RuleId,
    scope: 'within_run' | 'across_runs',
    fired: boolean,
    severity: Severity,
    ids: string[],
    firedMessage: string,
    applicable = true,
  ) => {
    evaluations.push({
      rule,
      scope,
      status: !applicable ? 'not_applicable' : fired ? severity : 'pass',
      observationIds: fired ? ids : [],
      message: !applicable
        ? `${rule}: not applicable to this run`
        : fired
          ? firedMessage
          : `${rule}: no violation`,
    });
  };

  for (const pr of profile.rules) {
    if (!pr.enabled) continue;
    const withinScope = pr.scope === 'within_run' || pr.scope === 'both';
    const acrossScope = pr.scope === 'across_runs' || pr.scope === 'both';

    switch (pr.rule) {
      case '1_2s': {
        const hits = cur.filter((o) => Math.abs(o.z) > 2);
        push(
          '1_2s',
          'within_run',
          hits.length > 0,
          pr.severity,
          hits.map((o) => o.id),
          `1_2s: ${hits.map((o) => `level ${o.level} at ${fmt(o.z)} SD`).join(', ')} exceeds 2 SD — inspect the run`,
        );
        break;
      }
      case '1_3s': {
        const hits = cur.filter((o) => Math.abs(o.z) > 3);
        push(
          '1_3s',
          'within_run',
          hits.length > 0,
          pr.severity,
          hits.map((o) => o.id),
          `1_3s: ${hits.map((o) => `level ${o.level} at ${fmt(o.z)} SD`).join(', ')} exceeds 3 SD`,
        );
        break;
      }
      case '2_2s': {
        if (withinScope) {
          const pos = cur.filter((o) => o.z > 2);
          const neg = cur.filter((o) => o.z < -2);
          const hits = pos.length >= 2 ? pos : neg.length >= 2 ? neg : [];
          push(
            '2_2s',
            'within_run',
            hits.length >= 2,
            pr.severity,
            hits.map((o) => o.id),
            `2_2s (within run): ${hits.length} controls exceed ${hits === pos ? '+' : '−'}2 SD in this run`,
            cur.length >= 2,
          );
        }
        if (acrossScope) {
          let firedIds: string[] = [];
          let firedLevel = '';
          for (const level of levels) {
            const s = levelStreams.get(level)!;
            const last2 = lastN(s, 2);
            if (
              last2.length === 2 &&
              last2.some((o) => cur.includes(o)) &&
              sameSignBeyond(last2, 2)
            ) {
              firedIds = last2.map((o) => o.id);
              firedLevel = level;
              break;
            }
          }
          push(
            '2_2s',
            'across_runs',
            firedIds.length > 0,
            pr.severity,
            firedIds,
            `2_2s (across runs): level ${firedLevel} exceeds the same 2 SD limit in two consecutive runs`,
          );
        }
        break;
      }
      case '2of3_2s': {
        const applicable = cur.length >= 3;
        const pos = cur.filter((o) => o.z > 2);
        const neg = cur.filter((o) => o.z < -2);
        const hits = pos.length >= 2 ? pos : neg.length >= 2 ? neg : [];
        push(
          '2of3_2s',
          'within_run',
          applicable && hits.length >= 2,
          pr.severity,
          hits.map((o) => o.id),
          `2of3_2s: ${hits.length} of ${cur.length} controls exceed the same 2 SD limit in this run`,
          applicable,
        );
        break;
      }
      case 'R_4s': {
        // within run only; classic definition requires one control > +2 SD and one < −2 SD
        const maxObs = cur.reduce((a, b) => (b.z > a.z ? b : a), cur[0]);
        const minObs = cur.reduce((a, b) => (b.z < a.z ? b : a), cur[0]);
        const fired = cur.length >= 2 && maxObs.z > 2 && minObs.z < -2;
        push(
          'R_4s',
          'within_run',
          fired,
          pr.severity,
          fired ? [maxObs.id, minObs.id] : [],
          `R_4s: range ${(maxObs?.z - minObs?.z).toFixed(2)} SD within this run (${fmt(maxObs?.z)} and ${fmt(minObs?.z)})`,
          cur.length >= 2,
        );
        break;
      }
      case '3_1s':
      case '4_1s': {
        const k = pr.rule === '3_1s' ? 3 : 4;
        if (withinScope) {
          let hits: WestgardObs[] = [];
          for (let i = 0; i + k <= cur.length; i++) {
            const win = cur.slice(i, i + k);
            if (sameSignBeyond(win, 1)) {
              hits = win;
              break;
            }
          }
          push(
            pr.rule,
            'within_run',
            hits.length > 0,
            pr.severity,
            hits.map((o) => o.id),
            `${pr.rule} (within run): ${k} consecutive controls exceed 1 SD on the same side`,
            cur.length >= k,
          );
        }
        if (acrossScope) {
          let hits: WestgardObs[] = [];
          let where = '';
          for (const level of levels) {
            const s = lastN(levelStreams.get(level)!, k);
            if (s.length === k && sameSignBeyond(s, 1)) {
              hits = s;
              where = `level ${level}`;
              break;
            }
          }
          if (hits.length === 0) {
            const s = lastN(pooled, k);
            if (s.length === k && sameSignBeyond(s, 1)) {
              hits = s;
              where = 'across levels';
            }
          }
          push(
            pr.rule,
            'across_runs',
            hits.length > 0,
            pr.severity,
            hits.map((o) => o.id),
            `${pr.rule} (across runs, ${where}): ${k} consecutive observations exceed 1 SD on the same side`,
          );
        }
        break;
      }
      case '6x':
      case '8x':
      case '9x':
      case '10x':
      case '12x': {
        const k = K_OF[pr.rule]!;
        let hits: WestgardObs[] = [];
        let where = '';
        for (const level of levels) {
          const s = lastN(levelStreams.get(level)!, k);
          if (s.length === k && sameSideOfMean(s)) {
            hits = s;
            where = `level ${level}`;
            break;
          }
        }
        if (hits.length === 0) {
          const s = lastN(pooled, k);
          if (s.length === k && sameSideOfMean(s)) {
            hits = s;
            where = 'across levels';
          }
        }
        const side = hits.length > 0 && hits[0].z > 0 ? 'above' : 'below';
        push(
          pr.rule,
          'across_runs',
          hits.length > 0,
          pr.severity,
          hits.map((o) => o.id),
          `${pr.rule} (${where}): ${k} consecutive observations ${side} the mean — persistent systematic error`,
        );
        break;
      }
      case '7T': {
        let hits: WestgardObs[] = [];
        let dir = '';
        for (const level of levels) {
          const s = lastN(levelStreams.get(level)!, 7);
          if (s.length === 7) {
            const inc = s.every((o, i) => i === 0 || o.z > s[i - 1].z);
            const dec = s.every((o, i) => i === 0 || o.z < s[i - 1].z);
            if (inc || dec) {
              hits = s;
              dir = inc ? 'increasing' : 'decreasing';
              break;
            }
          }
        }
        push(
          '7T',
          'across_runs',
          hits.length > 0,
          pr.severity,
          hits.map((o) => o.id),
          `7T: 7 consecutive strictly ${dir} observations — trend`,
        );
        break;
      }
    }
  }

  let verdict: Verdict = 'pass';
  for (const ev of evaluations) {
    if (ev.status === 'reject') verdict = 'reject';
    else if (ev.status === 'warning' && verdict === 'pass') verdict = 'warning';
  }
  return { verdict, evaluations };
}
