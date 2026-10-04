import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { ulid, verifyAuditChain } from '@sentinel/db';
import { makeTestApp, apiPost, apiGet, type TestContext } from './helpers.js';
import { purgeExpiredWorkspaces } from '../src/auth.js';
import { RequestLimits } from '../src/security.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await makeTestApp(); });
afterEach(async () => { await ctx.app.close(); ctx.opened.sqlite.close(); });
function request(cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'HEAD', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie, 'x-sentinel-request': '1' }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}
async function login(cookie = '') {
  const res = await request(cookie, 'POST', '/auth/login', { username: 'admin', password: 'test-password-123' });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}
function assay(cookie: string, name = 'HBsAg ELISA') {
  return request(cookie, 'POST', '/assays', { name, qcScheme: { levels: [{ level_code: 'IQC', replicates: 1 }] }, westgardProfileId: ctx.profileId });
}
async function fixture() {
  const run = (await apiPost(ctx, '/api/v1/runs', { assayId: ctx.assayId, values: { L1: [0.11], L2: [1.41] }, performedAt: '2026-02-03T09:00:00Z' })).json();
  const s = ctx.opened.sqlite;
  const layoutId = ulid(), plateId = ulid(), lotId = ulid(), signalId = ulid();
  s.prepare("INSERT INTO plate_layout (id, assay_id, name, well_types_json) VALUES (?, ?, 'Private layout', ?)").run(layoutId, ctx.assayId, JSON.stringify(Array.from({ length: 8 }, () => Array(12).fill('sample'))));
  s.prepare("INSERT INTO plate (id, assay_id, run_id, imported_at, source_filename, layout_id) VALUES (?, ?, ?, ?, 'private-plate.csv', ?)").run(plateId, ctx.assayId, run.runId, new Date().toISOString(), layoutId);
  s.prepare("INSERT INTO reagent_lot (id, assay_id, lot) VALUES (?, ?, 'private-lot')").run(lotId, ctx.assayId);
  s.prepare("INSERT INTO monitor_signal (id, assay_id, qc_material_id, monitor, run_id, message) VALUES (?, ?, ?, 'ewma', ?, 'Private signal')").run(signalId, ctx.assayId, ctx.materialL1, run.runId);
  const report = await apiPost(ctx, '/api/v1/reports/daily', { date: '2026-02-03' });
  expect(report.statusCode).toBe(200);
  return { runId: run.runId, observationId: run.observations[0].id, layoutId, plateId, lotId, signalId, reportId: report.json().id };
}

describe('workspace isolation with the same admin credentials', () => {
  it('isolates lists, lab names, aggregate reports and identical assay names', async () => {
    await fixture();
    await request(ctx.cookie, 'PATCH', '/laboratory', { name: 'Alpha Laboratory' });
    const other = await login();
    for (const path of ['/assays', '/runs', '/plates', '/reports', '/monitoring/materials', '/monitoring/signals']) {
      const res = await request(other, 'GET', path);
      expect(res.statusCode, path).toBe(200); expect(res.json(), path).toEqual([]);
    }
    const today = (await request(other, 'GET', '/today')).json();
    expect(today.recent).toEqual([]); expect(today.awaiting).toEqual([]); expect(today.tiles.runs).toBe(0);
    expect((await request(other, 'GET', '/laboratory')).json().name).toBe('Laboratory');
    await request(other, 'PATCH', '/laboratory', { name: 'Beta Laboratory' });
    expect((await apiGet(ctx, '/api/v1/laboratory')).json().name).toBe('Alpha Laboratory');
    for (const [path, payload] of [['daily', { date: '2026-02-03' }], ['monthly', { month: '2026-02' }]] as const) {
      const report = await request(other, 'POST', `/reports/${path}`, payload);
      expect(report.statusCode).toBe(200);
      const html = await request(other, 'GET', `/reports/${report.json().id}/html`);
      expect(html.body).toContain('Beta Laboratory'); expect(html.body).not.toMatch(/Alpha Laboratory|HBsAg/);
    }
    expect((await assay(other)).statusCode).toBe(200);
    const duplicate = await assay(other);
    expect(duplicate.statusCode).toBe(409); expect(duplicate.body).not.toContain('SQLITE');
  });

  it('blocks direct access to every resource family and all writes from a second login', async () => {
    const f = await fixture(), other = await login(), aid = ctx.assayId, mid = ctx.materialL1;
    const reads = [
      `/assays/${aid}/materials`, `/assays/${aid}/reagent-lots`, `/assays/${aid}/run-context`, `/assays/${aid}/layouts`,
      `/runs/${f.runId}`, `/materials/${mid}/baselines`, `/runlog?assayId=${aid}`, `/charts/lj?assayId=${aid}&level=L1`,
      `/export/history.csv?assayId=${aid}`, `/plates/${f.plateId}`, `/reports/${f.reportId}/html`, `/reports/${f.reportId}/download`,
      ...['ewma', 'cusum', 'variance', 'changepoints', 'lot-transition'].map(x => `/monitoring/${x}?assayId=${aid}&materialId=${mid}`),
    ];
    for (const url of reads) expect((await request(other, 'GET', url)).statusCode, url).toBe(404);
    expect((await request(other, 'HEAD', `/reports/${f.reportId}/download`)).statusCode).toBe(404);
    const writes: [string, Record<string, unknown>][] = [
      ...['materials', 'reagent-lots', 'runs', 'batch-entry', 'import/validate', 'import/commit', 'plates/import', 'plates/example', 'plates/phase2/rebuild', 'layouts', 'reports/assay', 'reports/monitoring'].map(p => [`/${p}`, { assayId: aid }] as [string, Record<string, unknown>]),
      ['/baselines/preview', { qcMaterialId: mid }], ['/baselines/freeze', { assayId: aid, qcMaterialId: mid }],
      ['/reports/plate', { plateId: f.plateId }], [`/observations/${f.observationId}/correct`, { rawValue: 999 }],
      [`/runs/${f.runId}/override`, { reason: 'bad override' }], [`/monitoring/signals/${f.signalId}/ack`, {}],
    ];
    const before = ctx.opened.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_event').get();
    for (const [url, payload] of writes) expect((await request(other, 'POST', url, payload)).statusCode, url).toBe(404);
    expect((await request(other, 'PATCH', `/assays/${aid}`, { name: 'Changed' })).statusCode).toBe(404);
    expect(ctx.opened.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_event').get()).toEqual(before);
  });

  it('rejects references to another assay even within the same workspace', async () => {
    const f = await fixture(), second = (await assay(ctx.cookie, 'Second')).json().id;
    for (const field of ['runId', 'layoutId'] as const) expect((await request(ctx.cookie, 'POST', '/plates/import', { assayId: second, [field]: f[field] })).statusCode).toBe(404);
    expect((await request(ctx.cookie, 'POST', '/runs', { assayId: second, reagentLotId: f.lotId })).statusCode).toBe(404);
    expect((await request(ctx.cookie, 'GET', `/monitoring/ewma?assayId=${second}&materialId=${ctx.materialL1}`)).statusCode).toBe(404);
    expect((await request(ctx.cookie, 'POST', '/baselines/freeze', { assayId: second, qcMaterialId: ctx.materialL1 })).statusCode).toBe(404);
    expect((await request(ctx.cookie, 'POST', '/baselines/freeze', { assayId: ctx.assayId, qcMaterialId: ctx.materialL2, excludedObservationIds: [f.observationId] })).statusCode).toBe(404);
  });

  it('hides unowned legacy data and removes shared-account administration', async () => {
    const f = await fixture();
    ctx.opened.sqlite.prepare('UPDATE assay SET workspace_id = NULL WHERE id = ?').run(ctx.assayId);
    ctx.opened.sqlite.prepare('UPDATE report SET workspace_id = NULL WHERE id = ?').run(f.reportId);
    expect((await apiGet(ctx, '/api/v1/assays')).json()).toEqual([]);
    expect((await request(ctx.cookie, 'GET', `/reports/${f.reportId}/download`)).statusCode).toBe(404);
    expect((await apiGet(ctx, `/api/v1/runlog?assayId=${ctx.assayId}`)).statusCode).toBe(404);
    for (const path of ['/backup/export.json', '/audit', '/audit/verify', '/users']) expect((await request(ctx.cookie, 'GET', path)).statusCode).toBe(403);
    for (const path of ['/profiles', '/instruments', '/users']) expect((await request(ctx.cookie, 'POST', path, {})).statusCode).toBe(403);
    expect((await request(ctx.cookie, 'PATCH', `/users/${(await apiGet(ctx, '/api/v1/auth/me')).json().id}`, { password: 'changed-password' })).statusCode).toBe(403);
    expect(await login()).toContain('sentinel_session=');
  });
});

describe('session lifecycle and HTTP protections', () => {
  it('deletes revoked workspace data, correction chains, layouts and downloads without affecting another login', async () => {
    const f = await fixture();
    await apiPost(ctx, `/api/v1/observations/${f.observationId}/correct`, { rawValue: 0.105 });
    const other = await login(), otherId = (await assay(other, 'Other survives')).json().id;
    const file = (ctx.opened.sqlite.prepare('SELECT file_path FROM report WHERE id = ?').get(f.reportId) as { file_path: string }).file_path;
    expect(existsSync(file)).toBe(true);
    expect((await apiPost(ctx, '/api/v1/auth/logout', {})).statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    for (const table of ['observation', 'run', 'plate', 'plate_layout', 'report', 'monitor_signal']) expect((ctx.opened.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    expect(ctx.opened.sqlite.prepare('SELECT id FROM workspace WHERE id = ?').get(ctx.workspaceId)).toBeUndefined();
    expect((await apiGet(ctx, '/api/v1/assays')).statusCode).toBe(401);
    expect((await request(other, 'GET', '/assays')).json().map((a: { id: string }) => a.id)).toEqual([otherId]);
    expect(verifyAuditChain(ctx.opened.sqlite).ok).toBe(true);
    expect(purgeExpiredWorkspaces(ctx.opened.sqlite, ctx.config.dataDir)).toBe(0);
  });

  it('rejects expiry immediately and purges data without a restart', async () => {
    await fixture();
    ctx.opened.sqlite.prepare("UPDATE session SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(ctx.workspaceId);
    expect((await apiGet(ctx, '/api/v1/assays')).statusCode).toBe(401);
    expect(purgeExpiredWorkspaces(ctx.opened.sqlite, ctx.config.dataDir)).toBe(1);
  });

  it('rotates sessions on re-login and prevents stale tabs from writing into or ending the new session', async () => {
    const cookie = await login(ctx.cookie);
    expect(cookie).not.toBe(ctx.cookie);
    expect((await apiGet(ctx, '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await request(cookie, 'GET', '/assays')).json()).toEqual([]);
    for (const url of ['/api/v1/auth/logout', '/api/v1/laboratory']) {
      const res = await ctx.app.inject({ method: url.endsWith('logout') ? 'POST' : 'PATCH', url, headers: { cookie, 'x-sentinel-request': '1', 'x-sentinel-workspace': ctx.workspaceId }, payload: { name: 'Wrong session' } });
      expect(res.statusCode).toBe(409);
    }
    expect((await request(cookie, 'GET', '/auth/me')).statusCode).toBe(200);
  });

  it('blocks CSRF and cross-site reads and serves private responses with no-store and security headers', async () => {
    for (const headers of [
      { cookie: ctx.cookie },
      { cookie: ctx.cookie, 'x-sentinel-request': '1', origin: 'https://attacker.example' },
      { cookie: ctx.cookie, 'x-sentinel-request': '1', 'sec-fetch-site': 'cross-site' },
      { cookie: ctx.cookie, 'x-sentinel-request': '1', 'sec-fetch-site': 'same-site' },
    ]) expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'test-password-123' } })).statusCode).toBe(403);
    const res = await apiGet(ctx, '/api/v1/assays');
    expect(res.headers['cache-control']).toContain('no-store'); expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/assays', headers: { cookie: ctx.cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    const valid = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/laboratory', headers: { cookie: ctx.cookie, 'x-sentinel-request': '1', origin: 'http://localhost:80' }, payload: { name: 'Allowed' } });
    expect(valid.statusCode).toBe(200);
  });

  it('throttles sign-ins and rejects malformed layouts without internal error details', async () => {
    let status = 0;
    for (let i = 0; i < 11; i++) status = (await request('', 'POST', '/auth/login', { username: 'unknown', password: 'wrong' })).statusCode;
    expect(status).toBe(429);
    const res = await apiPost(ctx, '/api/v1/layouts', { assayId: ctx.assayId, name: 'bad', wellTypes: [[]] });
    expect(res.statusCode).toBe(400); expect(res.body).not.toMatch(/SQLITE|stack|\.ts:/);
    const limits = new RequestLimits();
    expect(limits.take('test', 1, 1000, 0)).toBe(0);
    expect(limits.take('test', 1, 1000, 1)).toBe(1);
    expect(limits.take('test', 1, 1000, 1001)).toBe(0);
  });

  it('uses secure production cookies and ignores forwarded IPs from untrusted connections', async () => {
    ctx.config.secureCookies = true;
    ctx.config.publicOrigin = 'https://qc.example';
    const result = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-sentinel-request': '1', origin: 'https://qc.example' }, payload: { username: 'admin', password: 'test-password-123' } });
    const cookie = String(result.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
    expect(result.headers['strict-transport-security']).toBe('max-age=31536000');
    let status = 0;
    for (let i = 0; i < 11; i++) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '198.51.100.20', headers: { 'x-sentinel-request': '1', 'x-forwarded-for': `203.0.113.${i + 1}` }, payload: { username: 'unknown', password: 'wrong' } });
      status = res.statusCode;
    }
    expect(status).toBe(429);
  });
});
