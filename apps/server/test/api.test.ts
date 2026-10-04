import { describe, expect, it, beforeAll } from 'vitest';
import { ulid, verifyAuditChain } from '@sentinel/db';
import { hashPassword } from '../src/auth.js';
import { makeTestApp, apiGet, apiPost, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await makeTestApp();
});

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/today' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      headers: { 'x-sentinel-request': '1' },
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('me returns the session user', async () => {
    const res = await apiGet(ctx, '/api/v1/auth/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('admin');
    expect(res.json().role).toBe('admin');
  });
});

describe('runs', () => {
  it('creates a passing run', async () => {
    const res = await apiPost(ctx, '/api/v1/runs', {
      assayId: ctx.assayId,
      values: { L1: [0.102], L2: [1.43] },
      performedAt: '2026-02-01T09:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe('pass');
    expect(body.message).toMatch(/within limits/);
    expect(body.observations).toHaveLength(2);
    expect(body.observations[0].z).toBeCloseTo(0.2, 9);
  });

  it('warns on a single 1_2s violation', async () => {
    const res = await apiPost(ctx, '/api/v1/runs', {
      assayId: ctx.assayId,
      values: { L1: [0.1 + 0.021], L2: [1.4] },
      performedAt: '2026-02-02T09:00:00Z',
    });
    expect(res.json().verdict).toBe('warning');
  });

  it('rejects on 2_2s within run and supports supervisor override', async () => {
    const res = await apiPost(ctx, '/api/v1/runs', {
      assayId: ctx.assayId,
      values: { L1: [0.1 + 0.023], L2: [1.4 + 0.24] },
      performedAt: '2026-02-03T09:00:00Z',
    });
    const body = res.json();
    expect(body.verdict).toBe('reject');
    const fired = body.evaluations.filter((e: { status: string }) => e.status === 'reject');
    expect(fired.map((e: { rule: string }) => e.rule)).toContain('2_2s');

    const noReason = await apiPost(ctx, `/api/v1/runs/${body.runId}/override`, { reason: '' });
    expect(noReason.statusCode).toBe(400);
    const override = await apiPost(ctx, `/api/v1/runs/${body.runId}/override`, {
      reason: 'Verified: control vial swap, values documented',
    });
    expect(override.statusCode).toBe(200);
    const detail = await apiGet(ctx, `/api/v1/runs/${body.runId}`);
    expect(detail.json().override_status).toBe('accepted');
    expect(detail.json().audit.length).toBeGreaterThanOrEqual(2);
  });

  it('validates scheme (missing level)', async () => {
    const res = await apiPost(ctx, '/api/v1/runs', {
      assayId: ctx.assayId,
      values: { L1: [0.1] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/L2/);
  });

  it('run detail includes rule evaluations', async () => {
    const list = await apiGet(ctx, `/api/v1/runs?assayId=${ctx.assayId}`);
    const first = list.json()[0];
    const detail = await apiGet(ctx, `/api/v1/runs/${first.id}`);
    expect(detail.json().evaluations.length).toBeGreaterThan(0);
  });

  it('supports observation correction with supersede chain', async () => {
    const created = await apiPost(ctx, '/api/v1/runs', {
      assayId: ctx.assayId,
      values: { L1: [0.5], L2: [1.4] }, // typo: 0.5 instead of 0.105
      performedAt: '2026-02-04T09:00:00Z',
    });
    const obsId = created.json().observations[0].id;
    const corr = await apiPost(ctx, `/api/v1/observations/${obsId}/correct`, {
      rawValue: 0.105,
      reason: 'transcription error, reader printout shows 0.105',
    });
    expect(corr.statusCode).toBe(200);
    const again = await apiPost(ctx, `/api/v1/observations/${obsId}/correct`, {
      rawValue: 0.2,
      reason: 'double correction',
    });
    expect(again.statusCode).toBe(400); // already superseded
  });
});

describe('today', () => {
  it('returns tiles, awaiting list, recent runs', async () => {
    const res = await apiGet(ctx, '/api/v1/today');
    const body = res.json();
    expect(body.tiles).toBeDefined();
    expect(Array.isArray(body.awaiting)).toBe(true);
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent[0].observations).toBeDefined();
  });
});

describe('charts', () => {
  it('LJ data has points, baseline, stats', async () => {
    const res = await apiGet(ctx, `/api/v1/charts/lj?assayId=${ctx.assayId}&level=L1`);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.baseline.mean).toBeCloseTo(0.1, 9);
    expect(body.stats.n).toBe(body.points.length);
  });
});

describe('baselines', () => {
  it('preview refuses too-few observations, freeze works with manual values', async () => {
    const preview = await apiPost(ctx, '/api/v1/baselines/preview', { qcMaterialId: ctx.materialL1 });
    // only a handful of observations exist — expect refusal or provisional
    const pb = preview.json();
    if (pb.ok) expect(pb.n).toBeGreaterThanOrEqual(10);
    else expect(pb.error).toBeDefined();

    const freeze = await apiPost(ctx, '/api/v1/baselines/freeze', {
      assayId: ctx.assayId,
      qcMaterialId: ctx.materialL1,
      method: 'manual_manufacturer',
      mean: 0.1,
      sd: 0.012,
      n: 20,
    });
    expect(freeze.statusCode).toBe(200);
    const zeroSd = await apiPost(ctx, '/api/v1/baselines/freeze', {
      assayId: ctx.assayId,
      qcMaterialId: ctx.materialL1,
      method: 'manual_manufacturer',
      mean: 0.1,
      sd: 0,
      n: 20,
    });
    expect(zeroSd.statusCode).toBe(400);
  });
});

describe('csv import', () => {
  const csv = [
    'timestamp,level,od',
    '2026-03-01 09:00,L1,0.101',
    '2026-03-01 09:00,L2,1.41',
    '2026-03-02 09:00,L1,0.099',
    '2026-03-02 09:00,L2,1.38',
    '2026-03-03 09:00,L1,not-a-number',
    '2026-03-03 09:00,L9,0.1',
  ].join('\n');
  const mapping = { performedAt: 'timestamp', level: 'level', value: 'od' };

  it('dry-run validates row by row', async () => {
    const res = await apiPost(ctx, '/api/v1/import/validate', { assayId: ctx.assayId, content: csv, mapping });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(6);
    expect(body.rows.filter((r: { status: string }) => r.status === 'error')).toHaveLength(2);
    // both 03-03 rows are errors, so only two timestamps produce runs
    expect(body.runsToCreate).toBe(2);
  });

  it('commit creates runs and skips error rows', async () => {
    const res = await apiPost(ctx, '/api/v1/import/commit', { assayId: ctx.assayId, content: csv, mapping });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBeGreaterThanOrEqual(2);
    expect(body.skipped).toBeGreaterThanOrEqual(2);
  });

  it('export produces CSV with header', async () => {
    const res = await apiGet(ctx, `/api/v1/export/history.csv?assayId=${ctx.assayId}`);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body.split('\n')[0]).toMatch(/performed_at,level/);
  });
});

describe('plates', () => {
  function plateCsv(bias?: { row: number; delta: number }): string {
    // deterministic synthetic plate: log-normal-ish around 0.08
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      const cells: string[] = [];
      for (let j = 0; j < 12; j++) {
        let od = 0.08 * Math.exp(0.3 * Math.sin(i * 3.7 + j * 1.3) * Math.cos(j * 2.1));
        if ((i * 12 + j) % 11 === 3) od = 1.5; // scattered positives
        if (bias && i === bias.row) od *= Math.exp(bias.delta);
        cells.push(od.toFixed(4));
      }
      lines.push(cells.join(','));
    }
    return lines.join('\n');
  }

  it('imports a plate and runs PSAD', async () => {
    const res = await apiPost(ctx, '/api/v1/plates/import', {
      assayId: ctx.assayId,
      content: plateCsv(),
      filename: 'clean.csv',
      B: 199,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.ok).toBe(true);
    expect(body.result.nSampleWells).toBeGreaterThanOrEqual(40);
  });

  it('detects an injected row bias', async () => {
    const res = await apiPost(ctx, '/api/v1/plates/import', {
      assayId: ctx.assayId,
      content: plateCsv({ row: 5, delta: 1.2 }),
      filename: 'rowf.csv',
      B: 199,
    });
    const body = res.json();
    const rowFindings = body.result.findings.filter((f: { kind: string }) => f.kind === 'row_effect');
    expect(rowFindings.map((f: { index: string }) => f.index)).toContain('F');
  });

  it('rejects files with text in the data block', async () => {
    const bad = plateCsv().split('\n');
    bad[3] = bad[3].replace(/^[^,]+/, 'PATIENT-123');
    const res = await apiPost(ctx, '/api/v1/plates/import', {
      assayId: ctx.assayId,
      content: bad.join('\n'),
      filename: 'bad.csv',
    });
    expect(res.statusCode).toBe(400);
  });

  it('plate detail returns wells and analysis', async () => {
    const list = await apiGet(ctx, '/api/v1/plates');
    const id = list.json()[0].id;
    const detail = await apiGet(ctx, `/api/v1/plates/${id}`);
    const body = detail.json();
    expect(body.wells).toHaveLength(96);
    expect(body.analysis).not.toBeNull();
    expect(body.analysis.rowEffects).toHaveLength(8);
  });

  it('phase-2 rebuild refuses with too few plates', async () => {
    const res = await apiPost(ctx, '/api/v1/plates/phase2/rebuild', { assayId: ctx.assayId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/30/);
  });
});

describe('run log (E-ratio workflow)', () => {
  let ratioAssayId: string;

  it('creates a ratio assay and enters runs with technician/kit lot/cutoff', async () => {
    const profiles = await apiGet(ctx, '/api/v1/profiles');
    const profileId = profiles.json().find((p: { name: string }) => p.name === 'N2_classic').id;
    const created = await apiPost(ctx, '/api/v1/assays', {
      name: 'HIV ELISA QC',
      methodology: 'ELISA',
      transform: 'ratio_to_cutoff',
      qcScheme: { levels: [{ level_code: 'IQC-POS', replicates: 1 }] },
      westgardProfileId: profileId,
    });
    ratioAssayId = created.json().id;
    await apiPost(ctx, '/api/v1/materials', { assayId: ratioAssayId, levelCode: 'IQC-POS', lot: 'IQC' });

    const run = await apiPost(ctx, '/api/v1/runs', {
      assayId: ratioAssayId,
      performedAt: '2025-08-25T09:00:00Z',
      values: { 'IQC-POS': [1.263] },
      cutoff: 0.201,
      technician: 'Sarika TS',
      kitLot: 'HIV-ELISA',
    });
    expect(run.statusCode).toBe(200);
  });

  it('batch entry with per-row dates and cutoffs', async () => {
    const res = await apiPost(ctx, '/api/v1/batch-entry', {
      assayId: ratioAssayId,
      dates: ['2025-08-31', '2025-09-08', '2025-09-11', '2025-09-24'],
      valuesByLevel: { 'IQC-POS': [1.99, 1.272, 2.321, 1.884] },
      cutoffs: [0.212, 0.202, 0.141, 0.134],
      technician: 'Sarika TS',
      kitLot: 'HIV-ELISA',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(4);
  });

  it('run log computes E-ratios, self-derived limits and status', async () => {
    const res = await apiGet(ctx, `/api/v1/runlog?assayId=${ratioAssayId}`);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.valueLabel).toBe('E-ratio');
    expect(body.rows).toHaveLength(5);
    // newest first; 1.884/0.134 = 14.060
    expect(body.rows[0].value).toBeCloseTo(1.884 / 0.134, 3);
    expect(body.rows[0].technician).toBe('Sarika TS');
    expect(body.rows[0].kitLot).toBe('HIV-ELISA');
    expect(body.limits.source).toBe('self');
    expect(body.limits.n).toBe(5);
    expect(body.stats.cv).toBeGreaterThan(0);
    expect(body.status.inControl).toBe(true);
    // kit lot text auto-registered as a reagent lot
    const lots = await apiGet(ctx, `/api/v1/assays/${ratioAssayId}/reagent-lots`);
    expect(lots.json().map((l: { lot: string }) => l.lot)).toContain('HIV-ELISA');
  });

  it('flags a gross outlier against self-derived limits', async () => {
    await apiPost(ctx, '/api/v1/batch-entry', {
      assayId: ratioAssayId,
      dates: ['2025-10-01', '2025-10-14', '2025-10-26', '2025-11-03', '2025-11-16'],
      valuesByLevel: { 'IQC-POS': [1.61, 2.407, 1.626, 1.345, 2.24] },
      cutoffs: [0.132, 0.134, 0.14, 0.132, 0.132],
    });
    // extreme outlier: E-ratio ≈ 40 vs series ~6–18
    await apiPost(ctx, '/api/v1/runs', {
      assayId: ratioAssayId,
      performedAt: '2025-11-30T09:00:00Z',
      values: { 'IQC-POS': [5.3] },
      cutoff: 0.132,
    });
    const res = await apiGet(ctx, `/api/v1/runlog?assayId=${ratioAssayId}`);
    const body = res.json();
    expect(body.status.inControl).toBe(false);
    expect(body.rows[0].flags).toContain('1_3s');
  });

  it('monitoring imports the entered runs with no baseline (self-derived z)', async () => {
    const mats = await apiGet(ctx, `/api/v1/assays/${ratioAssayId}/materials`);
    const materialId = mats.json()[0].id;
    const ewma = await apiGet(ctx, `/api/v1/monitoring/ewma?assayId=${ratioAssayId}&materialId=${materialId}`);
    expect(ewma.statusCode).toBe(200);
    expect(ewma.json().series.length).toBeGreaterThanOrEqual(10);
    expect(ewma.json().summary).toBeDefined();
    const cp = await apiGet(ctx, `/api/v1/monitoring/changepoints?assayId=${ratioAssayId}&materialId=${materialId}`);
    expect(cp.json().series.length).toBeGreaterThanOrEqual(10);
    // the materials list counts these runs
    const list = await apiGet(ctx, '/api/v1/monitoring/materials');
    const entry = list.json().find((m: { id: string }) => m.id === materialId);
    expect(entry.n).toBeGreaterThanOrEqual(10);
  });

  it('assay report downloads as a real PDF with the run log', async () => {
    const rep = await apiPost(ctx, '/api/v1/reports/assay', { assayId: ratioAssayId });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().filename).toMatch(/^QC-Report-.*\.pdf$/);
    const dl = await apiGet(ctx, `/api/v1/reports/${rep.json().id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    const raw = dl.rawPayload.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('%%EOF');
    // uncompressed content streams: the report text is greppable
    for (const probe of ['OUT OF CONTROL', 'Sarika TS', 'RUN LOG', 'SIGNATURE', 'CONTROL LIMITS', 'E-RATIO']) {
      expect(raw, `pdf should contain "${probe}"`).toContain(probe);
    }
  });

  it('advanced monitoring report downloads as PDF with EWMA and CUSUM', async () => {
    const rep = await apiPost(ctx, '/api/v1/reports/monitoring', { assayId: ratioAssayId });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().filename).toMatch(/^Monitoring-Report-.*\.pdf$/);
    const dl = await apiGet(ctx, `/api/v1/reports/${rep.json().id}/download`);
    expect(dl.headers['content-type']).toBe('application/pdf');
    const raw = dl.rawPayload.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    for (const probe of ['ADVANCED MONITORING REPORT', 'FINDINGS', 'EWMA', 'CUSUM']) {
      expect(raw, `pdf should contain "${probe}"`).toContain(probe);
    }
  });

  it('example plates load and the fault plate names row F', async () => {
    const res = await apiPost(ctx, '/api/v1/plates/example', { assayId: ratioAssayId });
    expect(res.statusCode).toBe(200);
    const detail = await apiGet(ctx, `/api/v1/plates/${res.json().faultPlateId}`);
    const findings = detail.json().analysis.findings.filter((f: { kind: string }) => f.kind === 'row_effect');
    expect(findings.map((f: { index: string }) => f.index)).toContain('F');
    const clean = await apiGet(ctx, `/api/v1/plates/${res.json().cleanPlateId}`);
    const cleanSpatial = clean.json().analysis.findings.filter((f: { kind: string }) => f.kind !== 'local_outlier');
    expect(cleanSpatial).toHaveLength(0);
  });

  it('a wrong entry can be edited (correction) and the log re-evaluates', async () => {
    const before = (await apiGet(ctx, `/api/v1/runlog?assayId=${ratioAssayId}`)).json();
    expect(before.status.inControl).toBe(false);
    const bad = before.rows[0]; // the 5.3 / 0.132 outlier entered above
    expect(bad.raw).toBeCloseTo(5.3, 6);
    expect(bad.obsId).toBeDefined();
    const res = await apiPost(ctx, `/api/v1/observations/${bad.obsId}/correct`, { rawValue: 1.53, cutoff: 0.14 });
    expect(res.statusCode).toBe(200);
    const after = (await apiGet(ctx, `/api/v1/runlog?assayId=${ratioAssayId}`)).json();
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows[0].raw).toBeCloseTo(1.53, 6);
    expect(after.rows[0].cutoff).toBeCloseTo(0.14, 6);
    expect(after.rows[0].value).toBeCloseTo(1.53 / 0.14, 3);
    expect(after.rows[0].flags).not.toContain('1_3s');
    expect(after.status.inControl).toBe(true);
  });
});

describe('monitoring', () => {
  it('EWMA endpoint returns series and summary', async () => {
    const res = await apiGet(ctx, `/api/v1/monitoring/ewma?assayId=${ctx.assayId}&materialId=${ctx.materialL1}`);
    const body = res.json();
    expect(body.summary).toBeDefined();
    expect(Array.isArray(body.series)).toBe(true);
  });

  it('technicians cannot access monitoring', async () => {
    // Installation administrators provision users locally, not through the shared login.
    const techId = ulid();
    ctx.opened.sqlite.prepare("INSERT INTO user (id, username, display_name, role, password_hash) VALUES (?, 'tech1', 'Tech One', 'technician', ?)").run(techId, await hashPassword('password123'));
    const login = await ctx.app.inject({
      method: 'POST',
      headers: { 'x-sentinel-request': '1' },
      url: '/api/v1/auth/login',
      payload: { username: 'tech1', password: 'password123' },
    });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/monitoring/ewma',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('reports & audit', () => {
  it('generates a daily report (audited)', async () => {
    const res = await apiPost(ctx, '/api/v1/reports/daily', { date: '2026-02-03' });
    expect(res.statusCode).toBe(200);
    const html = await apiGet(ctx, `/api/v1/reports/${res.json().id}/html`);
    expect(html.body).toMatch(/Daily QC report/);
    expect(html.body).toMatch(/HBsAg/);
  });

  it('generates a monthly report with an SVG chart', async () => {
    const res = await apiPost(ctx, '/api/v1/reports/monthly', { month: '2026-02' });
    const html = await apiGet(ctx, `/api/v1/reports/${res.json().id}/html`);
    expect(html.body).toMatch(/<svg/);
  });

  it('audit chain remains intact and is unavailable to shared browser sessions', async () => {
    expect((await apiGet(ctx, '/api/v1/audit/verify')).statusCode).toBe(403);
    const result = verifyAuditChain(ctx.opened.sqlite);
    expect(result.ok).toBe(true);
    expect(result.events).toBeGreaterThan(5);
  });
});
