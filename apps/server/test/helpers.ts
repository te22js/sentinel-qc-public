import type { FastifyInstance } from 'fastify';
import { openDb, seedStructure, ulid, type OpenedDb } from '@sentinel/db';
import { buildApp } from '../src/app.js';
import { ensureBootstrapAdmin } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestContext {
  app: FastifyInstance;
  opened: OpenedDb;
  cookie: string;
  assayId: string;
  materialL1: string;
  materialL2: string;
  profileId: string;
  workspaceId: string;
  config: Config;
}

export async function makeTestApp(): Promise<TestContext> {
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: mkdtempSync(join(tmpdir(), 'sentinel-test-')),
    dbPath: ':memory:',
    bootstrapUsername: 'admin',
    bootstrapAdminPassword: 'test-password-123',
    sessionTtlHours: 1,
    webDist: null,
  };
  const opened = openDb(':memory:');
  seedStructure(opened.sqlite);
  await ensureBootstrapAdmin(opened.sqlite, config.bootstrapUsername, config.bootstrapAdminPassword);
  const app = await buildApp(config, opened);

  const login = await app.inject({
    method: 'POST',
    headers: { 'x-sentinel-request': '1' },
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'test-password-123' },
  });
  const setCookie = login.headers['set-cookie'] as string;
  const cookie = setCookie.split(';')[0];
  const workspaceId = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).json().sessionId;

  // fixture: one assay with two levels, materials and frozen baselines
  const s = opened.sqlite;
  const profile = s.prepare("SELECT id FROM westgard_profile WHERE name = 'N2_classic'").get() as { id: string };
  const assayId = ulid();
  s.prepare(
    `INSERT INTO assay (id, name, methodology, units, transform, qc_scheme_json, westgard_profile_id, workspace_id)
     VALUES (?, 'HBsAg ELISA', 'ELISA', 'OD', 'none', ?, ?, ?)`,
  ).run(assayId, JSON.stringify({ levels: [{ level_code: 'L1', replicates: 1 }, { level_code: 'L2', replicates: 1 }] }), profile.id, workspaceId);
  const materialL1 = ulid();
  const materialL2 = ulid();
  s.prepare("INSERT INTO qc_material (id, assay_id, level_code, lot, target_mean, target_sd) VALUES (?, ?, 'L1', 'CTRL-A', 0.1, 0.01)").run(materialL1, assayId);
  s.prepare("INSERT INTO qc_material (id, assay_id, level_code, lot, target_mean, target_sd) VALUES (?, ?, 'L2', 'CTRL-B', 1.4, 0.1)").run(materialL2, assayId);
  const admin = s.prepare("SELECT id FROM user WHERE username = 'admin'").get() as { id: string };
  const freeze = s.prepare(
    `INSERT INTO baseline (id, assay_id, qc_material_id, mean, sd, n, method, effective_from, frozen_at, frozen_by)
     VALUES (?, ?, ?, ?, ?, 20, 'manual_lab', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', ?)`,
  );
  freeze.run(ulid(), assayId, materialL1, 0.1, 0.01, admin.id);
  freeze.run(ulid(), assayId, materialL2, 1.4, 0.1, admin.id);

  return { app, opened, cookie, assayId, materialL1, materialL2, profileId: profile.id, workspaceId, config };
}

export async function apiPost(ctx: TestContext, url: string, payload: unknown) {
  return ctx.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { cookie: ctx.cookie, 'x-sentinel-request': '1' } });
}

export async function apiGet(ctx: TestContext, url: string) {
  return ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie, 'x-sentinel-request': '1' } });
}
