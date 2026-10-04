import { describe, expect, it } from 'vitest';
import {
  evaluateRun,
  PROFILE_N2_CLASSIC,
  PROFILE_N3,
  type WestgardProfile,
  type WestgardRun,
} from '../src/westgard.js';

let obsCounter = 0;

/** build a run: zs per level in order, e.g. run('r1', { L1: [0.5], L2: [1.2] }) */
function run(runId: string, zsByLevel: Record<string, number[]>, included = true): WestgardRun {
  const observations = Object.entries(zsByLevel).flatMap(([level, zs]) =>
    zs.map((z) => ({ id: `o${obsCounter++}`, level, z })),
  );
  return { runId, observations, included };
}

function firedRules(res: ReturnType<typeof evaluateRun>): string[] {
  return res.evaluations
    .filter((e) => e.status === 'warning' || e.status === 'reject')
    .map((e) => `${e.rule}:${e.scope}`);
}

describe('Westgard engine — deterministic sequences', () => {
  // ---- basic verdicts, N2 classic ----
  it('01 all controls within 1 SD → pass', () => {
    const r = evaluateRun([], run('c', { L1: [0.4], L2: [-0.8] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('pass');
    expect(firedRules(r)).toEqual([]);
  });

  it('02 single control at +2.1 SD → warning via 1_2s only', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [0.1] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('warning');
    expect(firedRules(r)).toEqual(['1_2s:within_run']);
  });

  it('03 boundary: exactly 2.0 SD does not trigger 1_2s', () => {
    const r = evaluateRun([], run('c', { L1: [2.0], L2: [0.0] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('pass');
  });

  it('04 +3.01 SD → reject via 1_3s', () => {
    const r = evaluateRun([], run('c', { L1: [3.01], L2: [0.2] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('1_3s:within_run');
  });

  it('05 −3.2 SD → reject via 1_3s', () => {
    const r = evaluateRun([], run('c', { L1: [-3.2], L2: [0.2] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
  });

  it('06 exactly 3.0 SD → 1_3s does not fire; 1_2s warning', () => {
    const r = evaluateRun([], run('c', { L1: [3.0], L2: [0.0] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('warning');
    expect(firedRules(r)).toEqual(['1_2s:within_run']);
  });

  // ---- 2_2s ----
  it('07 2_2s within run: +2.1 and +2.2 → reject', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [2.2] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('2_2s:within_run');
  });

  it('08 2_2s within run negative side: −2.1 and −2.3 → reject', () => {
    const r = evaluateRun([], run('c', { L1: [-2.1], L2: [-2.3] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('2_2s:within_run');
  });

  it('09 opposite signs +2.1/−2.3: not 2_2s, but R_4s fires', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [-2.3] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('R_4s:within_run');
    expect(firedRules(r)).not.toContain('2_2s:within_run');
  });

  it('10 2_2s across runs within level → reject', () => {
    const h = [run('p', { L1: [2.1], L2: [0.3] })];
    const r = evaluateRun(h, run('c', { L1: [2.4], L2: [0.1] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('2_2s:across_runs');
  });

  it('11 2_2s across runs opposite signs → no fire', () => {
    const h = [run('p', { L1: [2.1], L2: [0.3] })];
    const r = evaluateRun(h, run('c', { L1: [-2.4], L2: [0.1] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('2_2s:across_runs');
  });

  it('12 2_2s across runs boundary: previous at exactly 2.0 → no fire', () => {
    const h = [run('p', { L1: [2.0], L2: [0.3] })];
    const r = evaluateRun(h, run('c', { L1: [2.4], L2: [0.1] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('2_2s:across_runs');
  });

  // ---- R_4s ----
  it('13 R_4s: +2.1 / −2.1 fires', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [-2.1] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('R_4s:within_run');
  });

  it('14 R_4s: +2.1 / −1.9 does NOT fire (both must exceed 2s)', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [-1.9] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('R_4s:within_run');
    expect(r.verdict).toBe('warning'); // 1_2s from the +2.1
  });

  it('15 R_4s: +2.5 / −1.6 (range 4.1) does NOT fire — range-only variant is off', () => {
    const r = evaluateRun([], run('c', { L1: [2.5], L2: [-1.6] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('R_4s:within_run');
  });

  it('16 R_4s boundary: exactly +2.0/−2.0 → no fire', () => {
    const r = evaluateRun([], run('c', { L1: [2.0], L2: [-2.0] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('R_4s:within_run');
    expect(r.verdict).toBe('pass');
  });

  it('17 R_4s is within-run only: +2.1 then −2.1 in the NEXT run → no fire', () => {
    const h = [run('p', { L1: [2.1], L2: [0.0] })];
    const r = evaluateRun(h, run('c', { L1: [-2.1], L2: [0.0] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('R_4s:within_run');
  });

  // ---- 4_1s ----
  it('18 4_1s across runs within level → reject', () => {
    const h = [
      run('p1', { L1: [1.1], L2: [0.0] }),
      run('p2', { L1: [1.2], L2: [-0.1] }),
      run('p3', { L1: [1.3], L2: [0.2] }),
    ];
    const r = evaluateRun(h, run('c', { L1: [1.1], L2: [0.0] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('4_1s:across_runs');
  });

  it('19 4_1s across levels over two runs (N=2 pooled) → reject', () => {
    const h = [run('p', { L1: [1.2], L2: [1.4] })];
    const r = evaluateRun(h, run('c', { L1: [1.1], L2: [1.3] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('4_1s:across_runs');
  });

  it('20 4_1s boundary: a 1.0 in the window breaks it (strict >1)', () => {
    const h = [run('p', { L1: [1.2], L2: [1.0] })];
    const r = evaluateRun(h, run('c', { L1: [1.1], L2: [1.3] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('4_1s:across_runs');
  });

  it('21 4_1s negative side → reject', () => {
    const h = [run('p', { L1: [-1.2], L2: [-1.4] })];
    const r = evaluateRun(h, run('c', { L1: [-1.1], L2: [-1.3] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('4_1s:across_runs');
  });

  it('22 4_1s mixed signs → no fire', () => {
    const h = [run('p', { L1: [1.2], L2: [-1.4] })];
    const r = evaluateRun(h, run('c', { L1: [1.1], L2: [1.3] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('4_1s:across_runs');
  });

  // ---- 10x ----
  it('23 10x: ten consecutive same-side observations (5 runs × 2 levels) → reject', () => {
    const h = Array.from({ length: 4 }, (_, i) => run(`p${i}`, { L1: [0.3], L2: [0.5] }));
    const r = evaluateRun(h, run('c', { L1: [0.4], L2: [0.6] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('10x:across_runs');
  });

  it('24 9 same-side observations do not trigger 10x', () => {
    const h = [
      run('p0', { L1: [-0.2], L2: [0.5] }),
      ...Array.from({ length: 3 }, (_, i) => run(`p${i + 1}`, { L1: [0.3], L2: [0.5] })),
    ];
    const r = evaluateRun(h, run('c', { L1: [0.4], L2: [0.6] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('10x:across_runs');
  });

  it('25 z = 0 breaks a same-side chain', () => {
    const h = [
      run('p0', { L1: [0.3], L2: [0.4] }),
      run('p1', { L1: [0.3], L2: [0.0] }),
      run('p2', { L1: [0.3], L2: [0.4] }),
      run('p3', { L1: [0.3], L2: [0.4] }),
    ];
    const r = evaluateRun(h, run('c', { L1: [0.4], L2: [0.6] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('10x:across_runs');
  });

  it('26 10x within a single level across 10 runs → reject', () => {
    const h = Array.from({ length: 9 }, (_, i) => run(`p${i}`, { L1: [0.2 + 0.01 * i], L2: [i % 2 === 0 ? -0.3 : 0.3] }));
    const r = evaluateRun(h, run('c', { L1: [0.5], L2: [-0.2] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('10x:across_runs');
  });

  // ---- look-back exclusion ----
  it('27 rejected-not-accepted runs are excluded from look-back', () => {
    const h = [
      run('p1', { L1: [1.1], L2: [1.2] }),
      run('rejected', { L1: [3.5], L2: [0.9] }, false), // excluded
    ];
    // without the rejected run, pooled stream is p1.L1, p1.L2, c.L1, c.L2 → all > 1 → 4_1s
    const r = evaluateRun(h, run('c', { L1: [1.3], L2: [1.4] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('4_1s:across_runs');
  });

  it('28 excluded run breaks nothing when its values would have broken the chain', () => {
    const h = [
      run('p1', { L1: [1.1], L2: [1.2] }),
      run('rejected', { L1: [-0.5], L2: [-0.5] }, false),
    ];
    const r = evaluateRun(h, run('c', { L1: [1.3], L2: [1.4] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('4_1s:across_runs');
  });

  it('29 supervisor-accepted runs are included in look-back', () => {
    const h = [
      run('p1', { L1: [1.1], L2: [1.2] }),
      run('accepted', { L1: [-0.5], L2: [-0.5] }, true), // accepted → included, breaks chain
    ];
    const r = evaluateRun(h, run('c', { L1: [1.3], L2: [1.4] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).not.toContain('4_1s:across_runs');
  });

  it('30 includeRejectedRuns profile option keeps rejected runs in the stream', () => {
    const profile: WestgardProfile = { ...PROFILE_N2_CLASSIC, includeRejectedRuns: true };
    const h = [
      run('p1', { L1: [1.1], L2: [1.2] }),
      run('rejected', { L1: [-0.5], L2: [-0.5] }, false),
    ];
    const r = evaluateRun(h, run('c', { L1: [1.3], L2: [1.4] }), profile);
    expect(firedRules(r)).not.toContain('4_1s:across_runs');
  });

  // ---- N3 profile ----
  it('31 THE Westgard example: 6x fires while 2of3_2s does not', () => {
    // previous run +0.5, +2.2, +1.7; current +2.1, +1.8, +1.7
    const h = [run('p', { L1: [0.5], L2: [2.2], L3: [1.7] })];
    const r = evaluateRun(h, run('c', { L1: [2.1], L2: [1.8], L3: [1.7] }), PROFILE_N3);
    expect(r.verdict).toBe('reject');
    const fired = firedRules(r);
    expect(fired).toContain('6x:across_runs');
    expect(fired).not.toContain('2of3_2s:within_run');
  });

  it('32 2of3_2s: two of three controls above +2 → reject', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [2.2], L3: [0.5] }), PROFILE_N3);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('2of3_2s:within_run');
  });

  it('33 2of3_2s requires the same side: +2.1/−2.2/+0.1 → no 2of3, R_4s instead', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [-2.2], L3: [0.1] }), PROFILE_N3);
    const fired = firedRules(r);
    expect(fired).not.toContain('2of3_2s:within_run');
    expect(fired).toContain('R_4s:within_run');
  });

  it('34 3_1s within run: all three controls above +1 → reject', () => {
    const r = evaluateRun([], run('c', { L1: [1.1], L2: [1.2], L3: [1.5] }), PROFILE_N3);
    expect(r.verdict).toBe('reject');
    expect(firedRules(r)).toContain('3_1s:within_run');
  });

  it('35 3_1s across runs within level → reject', () => {
    const h = [run('p1', { L1: [1.1], L2: [0.0], L3: [-0.5] }), run('p2', { L1: [1.3], L2: [0.1], L3: [0.5] })];
    const r = evaluateRun(h, run('c', { L1: [1.2], L2: [-0.2], L3: [-0.6] }), PROFILE_N3);
    expect(firedRules(r)).toContain('3_1s:across_runs');
  });

  it('36 single +2.5 in N3 → warning only', () => {
    const r = evaluateRun([], run('c', { L1: [2.5], L2: [0.1], L3: [-0.4] }), PROFILE_N3);
    expect(r.verdict).toBe('warning');
  });

  it('37 2of3_2s not applicable to a 2-observation run', () => {
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [2.2] }), PROFILE_N3);
    const ev = r.evaluations.find((e) => e.rule === '2of3_2s');
    expect(ev?.status).toBe('not_applicable');
  });

  // ---- custom profiles ----
  it('38 1_2s promoted to reject in a single-rule profile', () => {
    const profile: WestgardProfile = {
      name: 'strict',
      rules: [{ rule: '1_2s', enabled: true, scope: 'within_run', severity: 'reject' }],
    };
    const r = evaluateRun([], run('c', { L1: [2.1], L2: [0.0] }), profile);
    expect(r.verdict).toBe('reject');
  });

  it('39 7T: seven strictly increasing observations in a level → fires', () => {
    const profile: WestgardProfile = {
      name: 'trend',
      rules: [{ rule: '7T', enabled: true, scope: 'across_runs', severity: 'reject' }],
    };
    const h = Array.from({ length: 6 }, (_, i) => run(`p${i}`, { L1: [0.1 * (i + 1)] }));
    const r = evaluateRun(h, run('c', { L1: [0.75] }), profile);
    expect(firedRules(r)).toContain('7T:across_runs');
  });

  it('40 7T requires strict monotonicity: a repeat breaks it', () => {
    const profile: WestgardProfile = {
      name: 'trend',
      rules: [{ rule: '7T', enabled: true, scope: 'across_runs', severity: 'reject' }],
    };
    const zs = [0.1, 0.2, 0.3, 0.3, 0.4, 0.5];
    const h = zs.map((z, i) => run(`p${i}`, { L1: [z] }));
    const r = evaluateRun(h, run('c', { L1: [0.6] }), profile);
    expect(firedRules(r)).not.toContain('7T:across_runs');
  });

  it('41 8x fires on 8 same-side, 12x needs 12', () => {
    const profile: WestgardProfile = {
      name: 'kx',
      rules: [
        { rule: '8x', enabled: true, scope: 'across_runs', severity: 'reject' },
        { rule: '12x', enabled: true, scope: 'across_runs', severity: 'reject' },
      ],
    };
    const h = Array.from({ length: 3 }, (_, i) => run(`p${i}`, { L1: [0.2], L2: [0.4] }));
    const r = evaluateRun(h, run('c', { L1: [0.3], L2: [0.5] }), profile);
    const fired = firedRules(r);
    expect(fired).toContain('8x:across_runs');
    expect(fired).not.toContain('12x:across_runs');
  });

  it('42 multiple rules fire together; verdict is max severity; observation ids recorded', () => {
    const r = evaluateRun([], run('c', { L1: [3.5], L2: [2.2] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('reject');
    const fired = firedRules(r);
    expect(fired).toContain('1_3s:within_run');
    expect(fired).toContain('2_2s:within_run');
    const ev13 = r.evaluations.find((e) => e.rule === '1_3s')!;
    expect(ev13.observationIds).toHaveLength(1);
  });

  it('43 replicates: two replicates of one level both beyond +2 → 2_2s within run', () => {
    const r = evaluateRun([], run('c', { L1: [2.3, 2.4] }), PROFILE_N2_CLASSIC);
    expect(firedRules(r)).toContain('2_2s:within_run');
  });

  it('44 disabled rules never fire', () => {
    const profile: WestgardProfile = {
      name: 'off',
      rules: [{ rule: '1_3s', enabled: false, scope: 'within_run', severity: 'reject' }],
    };
    const r = evaluateRun([], run('c', { L1: [5.0] }), profile);
    expect(r.verdict).toBe('pass');
    expect(r.evaluations).toHaveLength(0);
  });
});

describe('Westgard engine — property tests', () => {
  it('no rule fires on a stream with all |z| ≤ 1 and alternating signs', () => {
    // alternating signs with |z| ≤ 1 cannot produce any defined pattern
    const h: WestgardRun[] = [];
    for (let i = 0; i < 30; i++) {
      const s = i % 2 === 0 ? 1 : -1;
      h.push(run(`p${i}`, { L1: [0.5 * s], L2: [-0.5 * s] }));
    }
    const r = evaluateRun(h, run('c', { L1: [0.5], L2: [-0.5] }), PROFILE_N2_CLASSIC);
    expect(r.verdict).toBe('pass');
  });

  it('random small-z streams never reject (invariant: no defining pattern → no fire)', () => {
    // |z| < 1 and sign alternates every observation → no rule in either profile can fire
    let x = 0.37;
    const next = () => {
      x = (x * 9301 + 49297) % 233280;
      return (x / 233280) * 0.98 + 0.01; // (0.01, 0.99)
    };
    for (let trial = 0; trial < 20; trial++) {
      const h: WestgardRun[] = [];
      for (let i = 0; i < 15; i++) {
        const sign = (i + trial) % 2 === 0 ? 1 : -1;
        h.push(run(`t${trial}p${i}`, { L1: [sign * next()], L2: [-sign * next()] }));
      }
      const sign = (15 + trial) % 2 === 0 ? 1 : -1;
      const r = evaluateRun(h, run(`t${trial}c`, { L1: [sign * next()], L2: [-sign * next()] }), PROFILE_N2_CLASSIC);
      expect(r.verdict).toBe('pass');
    }
  });
});
