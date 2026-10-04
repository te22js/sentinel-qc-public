/** REST API under /api/v1. All handlers validate with zod and enforce roles. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateRunRequest,
  OverrideRunRequest,
  LoginRequest,
  QcSchemeSchema,
} from '@sentinel/shared';
import { appendAudit, ulid } from '@sentinel/db';
import type { Ctx } from './services/context.js';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  cleanWorkspaces,
  verifyPassword,
  requireRole,
  requireUser,
} from './auth.js';
import { createRun, overrideRun, correctObservation } from './services/runs.js';
import { previewBaseline, freezeBaseline } from './services/baselines.js';
import { ljData } from './services/charts.js';
import {
  ewmaTab,
  cusumTab,
  varianceTab,
  changePointTab,
  lotTransitionTab,
  acknowledgeSignal,
} from './services/monitoring.js';
import { importPlate, rebuildPhase2, latestPhase2Model } from './services/plates.js';
import { validateImport, commitImport, exportHistoryCsv } from './services/csv.js';
import { batchEntry } from './services/batch.js';
import { runLog } from './services/runlog.js';
import { dailyReport, monthlyReport, plateReport } from './services/reports.js';
import { assayReportPdf, monitoringReportPdf } from './services/reportpdf.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { workspaceLab } from './workspace.js';
import { Pcg32, generatePlate, injectRowBias, injectEdgeEffect } from '@sentinel/stats';

export function registerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sqlite, config } = ctx;
  const api = '/api/v1';
  let activeLogins = 0;

  // ---------------------------------------------------------------- auth
  app.post(`${api}/auth/login`, async (req, reply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'username and password required' });
    const user = sqlite
      .prepare('SELECT * FROM user WHERE username = ? AND active = 1')
      .get(body.data.username) as { id: string; password_hash: string; username: string; display_name: string; role: string } | undefined;
    if (activeLogins >= 4) return reply.header('retry-after', '5').code(429).send({ error: 'Sign-in is busy. Please try again shortly.' });
    activeLogins++;
    let valid = false;
    try { valid = !!user && await verifyPassword(user.password_hash, body.data.password); }
    finally { activeLogins--; }
    if (!user || !valid) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    // Re-signing in in the same browser ends its previous private workspace.
    const previous = req.cookies[SESSION_COOKIE];
    if (previous) destroySession(sqlite, previous);
    cleanWorkspaces(sqlite, config.dataDir);
    const token = createSession(sqlite, user.id, config.sessionTtlHours);
    appendAudit(sqlite, { userId: user.id, entity: 'user', entityId: user.id, action: 'login' });
    reply
      .setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.secureCookies === true })
      .send({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
  });

  app.post(`${api}/auth/logout`, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) destroySession(sqlite, token);
    cleanWorkspaces(sqlite, config.dataDir);
    reply.header('clear-site-data', '"cache", "storage"');
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get(`${api}/auth/me`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(user);
  });

  // ---------------------------------------------------------------- today
  app.get(`${api}/today`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const today = new Date().toISOString().slice(0, 10);
    const tiles = sqlite
      .prepare(
        `SELECT COUNT(*) as runs,
                SUM(CASE WHEN verdict = 'warning' THEN 1 ELSE 0 END) as warnings,
                SUM(CASE WHEN verdict = 'reject' THEN 1 ELSE 0 END) as rejects
         FROM run r JOIN assay a ON a.id = r.assay_id WHERE date(performed_at) = ? AND a.workspace_id = ?`,
      )
      .get(today, user.sessionId) as { runs: number; warnings: number | null; rejects: number | null };
    const awaiting = sqlite
      .prepare(
        `SELECT a.id, a.name FROM assay a WHERE a.active = 1 AND a.workspace_id = ?
           AND NOT EXISTS (SELECT 1 FROM run r WHERE r.assay_id = a.id AND date(r.performed_at) = ?)
         ORDER BY a.name`,
      )
      .all(user.sessionId, today);
    const recent = sqlite
      .prepare(
        `SELECT r.id, r.performed_at, r.verdict, r.override_status, a.name as assay, u.display_name as operator
         FROM run r JOIN assay a ON a.id = r.assay_id JOIN user u ON u.id = r.operator_user_id
         WHERE a.workspace_id = ? ORDER BY r.performed_at DESC LIMIT 15`,
      )
      .all(user.sessionId) as Record<string, unknown>[];
    const obsStmt = sqlite.prepare(
      `SELECT m.level_code as level, o.z FROM observation o JOIN qc_material m ON m.id = o.qc_material_id
       WHERE o.run_id = ? AND o.superseded = 0 ORDER BY m.level_code, o.replicate_index`,
    );
    for (const r of recent) r.observations = obsStmt.all(r.id);
    const lab = workspaceLab(sqlite, user.sessionId);
    reply.send({
      date: today,
      labName: lab?.name ?? 'Laboratory',
      demoMode: false,
      tiles: { runs: tiles.runs ?? 0, warnings: tiles.warnings ?? 0, rejects: tiles.rejects ?? 0 },
      awaiting,
      recent,
    });
  });

  // ---------------------------------------------------------------- assays & profiles
  app.get(`${api}/assays`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const assays = sqlite
      .prepare(
        `SELECT a.*, w.name as profile_name FROM assay a JOIN westgard_profile w ON w.id = a.westgard_profile_id
         WHERE a.workspace_id = ? ORDER BY a.name`,
      )
      .all(user.sessionId) as Record<string, unknown>[];
    for (const a of assays) {
      a.qcScheme = JSON.parse(a.qc_scheme_json as string);
      delete a.qc_scheme_json;
    }
    reply.send(assays);
  });

  const AssayBody = z.object({
    name: z.string().trim().min(1).max(120),
    methodology: z.string().max(200).default(''),
    units: z.string().max(40).default('OD'),
    transform: z.enum(['none', 'log', 'ratio_to_cutoff']).default('none'),
    qcScheme: QcSchemeSchema,
    westgardProfileId: z.string(),
    platingOrder: z.enum(['randomized', 'sequential', 'structured']).default('randomized'),
    allowableBiasPct: z.number().nullable().default(null),
    readerMax: z.number().nullable().default(null),
    active: z.boolean().default(true),
  });

  app.post(`${api}/assays`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const body = AssayBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid body' });
    const id = ulid();
    const b = body.data;
    sqlite
      .prepare(
        `INSERT INTO assay (id, name, methodology, units, transform, qc_scheme_json, westgard_profile_id, plating_order, allowable_bias_pct, reader_max, active, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.name, b.methodology, b.units, b.transform, JSON.stringify(b.qcScheme), b.westgardProfileId, b.platingOrder, b.allowableBiasPct, b.readerMax, b.active ? 1 : 0, user.sessionId);
    // one QC material per level so run entry works with zero further setup
    for (const l of b.qcScheme.levels) {
      sqlite
        .prepare(`INSERT INTO qc_material (id, assay_id, level_code, lot, manufacturer) VALUES (?, ?, ?, 'IQC', '')`)
        .run(ulid(), id, l.level_code);
    }
    appendAudit(sqlite, { userId: user.id, entity: 'assay', entityId: id, action: 'create', after: b });
    reply.send({ id });
  });

  app.patch(`${api}/assays/:id`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const before = sqlite.prepare('SELECT * FROM assay WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!before) return reply.code(404).send({ error: 'assay not found' });
    const body = AssayBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const b = body.data;
    const updates: Record<string, unknown> = {};
    if (b.name !== undefined) updates.name = b.name;
    if (b.methodology !== undefined) updates.methodology = b.methodology;
    if (b.units !== undefined) updates.units = b.units;
    if (b.transform !== undefined) updates.transform = b.transform;
    if (b.qcScheme !== undefined) updates.qc_scheme_json = JSON.stringify(b.qcScheme);
    if (b.westgardProfileId !== undefined) updates.westgard_profile_id = b.westgardProfileId;
    if (b.platingOrder !== undefined) updates.plating_order = b.platingOrder;
    if (b.allowableBiasPct !== undefined) updates.allowable_bias_pct = b.allowableBiasPct;
    if (b.readerMax !== undefined) updates.reader_max = b.readerMax;
    if (b.active !== undefined) updates.active = b.active ? 1 : 0;
    if (Object.keys(updates).length === 0) return reply.send({ ok: true });
    const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    sqlite.prepare(`UPDATE assay SET ${setSql} WHERE id = ?`).run(...Object.values(updates), id);
    appendAudit(sqlite, { userId: user.id, entity: 'assay', entityId: id, action: 'config_change', before, after: updates });
    reply.send({ ok: true });
  });

  app.get(`${api}/profiles`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const profiles = sqlite.prepare("SELECT * FROM westgard_profile WHERE name IN ('N2_classic', 'N3') ORDER BY name").all() as Record<string, unknown>[];
    for (const p of profiles) {
      p.rules = JSON.parse(p.rules_json as string);
      delete p.rules_json;
    }
    reply.send(profiles);
  });

  // ------------------------------------------------------- materials & lots
  app.get(`${api}/assays/:id/materials`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    reply.send(sqlite.prepare('SELECT * FROM qc_material WHERE assay_id = ? ORDER BY level_code, active_from DESC').all(id));
  });

  const MaterialBody = z.object({
    assayId: z.string(),
    levelCode: z.string().trim().min(1).max(40),
    manufacturer: z.string().max(200).default(''),
    lot: z.string().trim().min(1).max(120),
    expiry: z.string().nullable().default(null),
    targetMean: z.number().nullable().default(null),
    targetSd: z.number().nullable().default(null),
    targetLow: z.number().nullable().default(null),
    targetHigh: z.number().nullable().default(null),
    activeFrom: z.string().nullable().default(null),
    activeTo: z.string().nullable().default(null),
  });

  app.post(`${api}/materials`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const body = MaterialBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid material' });
    const b = body.data;
    const id = ulid();
    sqlite
      .prepare(
        `INSERT INTO qc_material (id, assay_id, level_code, manufacturer, lot, expiry, target_mean, target_sd, target_low, target_high, active_from, active_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.assayId, b.levelCode, b.manufacturer, b.lot, b.expiry, b.targetMean, b.targetSd, b.targetLow, b.targetHigh, b.activeFrom, b.activeTo);
    appendAudit(sqlite, { userId: user.id, entity: 'qc_material', entityId: id, action: 'create', after: b });
    reply.send({ id });
  });

  app.get(`${api}/assays/:id/reagent-lots`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(sqlite.prepare('SELECT * FROM reagent_lot WHERE assay_id = ? ORDER BY active_from DESC NULLS LAST').all((req.params as { id: string }).id));
  });

  app.post(`${api}/reagent-lots`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      lot: z.string().trim().min(1).max(120),
      expiry: z.string().nullable().default(null),
      activeFrom: z.string().nullable().default(null),
      activeTo: z.string().nullable().default(null),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid lot' });
    const b = body.data;
    const id = ulid();
    sqlite.prepare('INSERT INTO reagent_lot (id, assay_id, lot, expiry, active_from, active_to) VALUES (?, ?, ?, ?, ?, ?)').run(id, b.assayId, b.lot, b.expiry, b.activeFrom, b.activeTo);
    appendAudit(sqlite, { userId: user.id, entity: 'reagent_lot', entityId: id, action: 'create', after: b });
    reply.send({ id });
  });

  // --------------------------------------------------------------- new run
  app.get(`${api}/assays/:id/run-context`, async (req, reply) => {
    // autofill data for the New Run card
    const user = requireUser(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const assay = sqlite.prepare('SELECT * FROM assay WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!assay) return reply.code(404).send({ error: 'assay not found' });
    const now = new Date().toISOString();
    const scheme = JSON.parse(assay.qc_scheme_json as string) as { levels: { level_code: string; replicates: number }[] };
    const levels = scheme.levels.map((l) => {
      const material = sqlite
        .prepare(
          `SELECT * FROM qc_material WHERE assay_id = ? AND level_code = ?
             AND (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to >= ?)
           ORDER BY active_from DESC NULLS LAST LIMIT 1`,
        )
        .get(id, l.level_code, now, now) as Record<string, unknown> | undefined;
      const baseline = material
        ? (sqlite
            .prepare(
              `SELECT id, mean, sd, n, method FROM baseline WHERE qc_material_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
               ORDER BY effective_from DESC LIMIT 1`,
            )
            .get(material.id, now, now) as Record<string, unknown> | undefined)
        : undefined;
      return { levelCode: l.level_code, replicates: l.replicates, material: material ?? null, baseline: baseline ?? null };
    });
    const reagentLot = sqlite
      .prepare(
        `SELECT * FROM reagent_lot WHERE assay_id = ? AND (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to >= ?)
         ORDER BY active_from DESC NULLS LAST LIMIT 1`,
      )
      .get(id, now, now);
    const instruments: unknown[] = [];
    reply.send({
      assay: { ...assay, qcScheme: scheme, qc_scheme_json: undefined },
      levels,
      reagentLot: reagentLot ?? null,
      instruments,
    });
  });

  app.post(`${api}/runs`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = CreateRunRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid run' });
    const res = createRun(sqlite, {
      assayId: body.data.assayId,
      operatorUserId: user.id,
      instrumentId: body.data.instrumentId,
      reagentLotId: body.data.reagentLotId,
      performedAt: body.data.performedAt,
      comment: body.data.comment,
      values: body.data.values,
      cutoff: body.data.cutoff,
      technician: body.data.technician,
      kitLot: body.data.kitLot,
    });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  app.post(`${api}/batch-entry`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dates: z.array(z.string()).max(400).optional(),
      valuesByLevel: z.record(z.string(), z.array(z.number().finite()).max(400)),
      cutoffs: z.array(z.number()).max(400).optional(),
      technician: z.string().max(120).nullable().optional(),
      kitLot: z.string().max(120).nullable().optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid batch' });
    const res = batchEntry(sqlite, { ...body.data, userId: user.id });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  app.get(`${api}/runs`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (q.assayId) { conditions.push('r.assay_id = ?'); params.push(q.assayId); }
    if (q.verdict) { conditions.push('r.verdict = ?'); params.push(q.verdict); }
    if (q.operatorId) { conditions.push('r.operator_user_id = ?'); params.push(q.operatorId); }
    if (q.instrumentId) { conditions.push('r.instrument_id = ?'); params.push(q.instrumentId); }
    if (q.reagentLotId) { conditions.push('r.reagent_lot_id = ?'); params.push(q.reagentLotId); }
    if (q.from) { conditions.push('r.performed_at >= ?'); params.push(q.from); }
    if (q.to) { conditions.push('r.performed_at <= ?'); params.push(q.to); }
    conditions.push('(a.workspace_id = ?)');
    params.push(user.sessionId);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const runs = sqlite
      .prepare(
        `SELECT r.id, r.performed_at, r.verdict, r.override_status, a.name as assay, a.id as assayId,
                u.display_name as operator, i.label as instrument, rl.lot as reagentLot
         FROM run r
         JOIN assay a ON a.id = r.assay_id
         JOIN user u ON u.id = r.operator_user_id
         LEFT JOIN instrument i ON i.id = r.instrument_id
         LEFT JOIN reagent_lot rl ON rl.id = r.reagent_lot_id
         ${where} ORDER BY r.performed_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    const obsStmt = sqlite.prepare(
      `SELECT m.level_code as level, o.raw_value as raw, o.z FROM observation o JOIN qc_material m ON m.id = o.qc_material_id
       WHERE o.run_id = ? AND o.superseded = 0 ORDER BY m.level_code, o.replicate_index`,
    );
    for (const r of runs) r.observations = obsStmt.all(r.id);
    reply.send(runs);
  });

  app.get(`${api}/runs/:id`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const run = sqlite
      .prepare(
        `SELECT r.*, a.name as assay_name, u.display_name as operator, i.label as instrument, rl.lot as reagent_lot,
                ou.display_name as override_by_name
         FROM run r
         JOIN assay a ON a.id = r.assay_id
         JOIN user u ON u.id = r.operator_user_id
         LEFT JOIN instrument i ON i.id = r.instrument_id
         LEFT JOIN reagent_lot rl ON rl.id = r.reagent_lot_id
         LEFT JOIN user ou ON ou.id = r.override_by
         WHERE r.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    run.observations = sqlite
      .prepare(
        `SELECT o.*, m.level_code as level, m.lot as material_lot FROM observation o JOIN qc_material m ON m.id = o.qc_material_id
         WHERE o.run_id = ? ORDER BY m.level_code, o.replicate_index, o.id`,
      )
      .all(id);
    run.evaluations = sqlite.prepare('SELECT * FROM rule_evaluation WHERE run_id = ?').all(id);
    run.audit = sqlite
      .prepare(`SELECT at, action, reason, user_id FROM audit_event WHERE entity = 'run' AND entity_id = ? ORDER BY seq`)
      .all(id);
    reply.send(run);
  });

  app.post(`${api}/runs/:id/override`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const body = OverrideRunRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'a reason of at least 3 characters is required' });
    const res = overrideRun(sqlite, (req.params as { id: string }).id, user.id, body.data.reason);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send({ ok: true });
  });

  app.post(`${api}/observations/:id/correct`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({
      rawValue: z.number().finite(),
      cutoff: z.number().finite().positive().optional(),
      reason: z.string().min(3).max(2000).optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'rawValue required (reason, if given, ≥3 chars)' });
    const res = correctObservation(
      sqlite,
      (req.params as { id: string }).id,
      body.data.rawValue,
      user.id,
      body.data.reason ?? 'corrected entry',
      body.data.cutoff,
    );
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  // -------------------------------------------------------------- baselines
  app.get(`${api}/materials/:id/baselines`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(
      sqlite
        .prepare('SELECT b.*, u.display_name as frozen_by_name FROM baseline b JOIN user u ON u.id = b.frozen_by WHERE b.qc_material_id = ? ORDER BY b.effective_from DESC')
        .all((req.params as { id: string }).id),
    );
  });

  app.post(`${api}/baselines/preview`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({ qcMaterialId: z.string(), windowFrom: z.string().optional(), windowTo: z.string().optional() });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request' });
    reply.send(previewBaseline(sqlite, body.data.qcMaterialId, body.data.windowFrom, body.data.windowTo));
  });

  app.post(`${api}/baselines/freeze`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      qcMaterialId: z.string(),
      method: z.enum(['manual_manufacturer', 'manual_lab', 'computed_classical', 'computed_robust']),
      mean: z.number().finite(),
      sd: z.number(),
      n: z.number().int(),
      windowFrom: z.string().nullable().optional(),
      windowTo: z.string().nullable().optional(),
      excludedObservationIds: z.array(z.string()).max(1000).default([]),
      effectiveFrom: z.string().optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid baseline' });
    const res = freezeBaseline(sqlite, { ...body.data, userId: user.id });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  // ---------------------------------------------------------------- run log
  app.get(`${api}/runlog`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as Record<string, string | undefined>;
    if (!q.assayId) return reply.code(400).send({ error: 'assayId required' });
    const res = runLog(sqlite, q.assayId, q.level, q.from, q.to);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  // ----------------------------------------------------------------- charts
  app.get(`${api}/charts/lj`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as Record<string, string | undefined>;
    if (!q.assayId || !q.level) return reply.code(400).send({ error: 'assayId and level are required' });
    const res = ljData(sqlite, q.assayId, q.level, q.from, q.to, q.reagentLotId);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  // ------------------------------------------------------------- monitoring
  app.get(`${api}/monitoring/materials`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(
      sqlite
        .prepare(
          `SELECT m.id, m.level_code, m.lot, a.id as assay_id, a.name as assay_name,
                  (SELECT COUNT(*) FROM observation o WHERE o.qc_material_id = m.id AND o.superseded = 0) as n
           FROM qc_material m JOIN assay a ON a.id = m.assay_id
           WHERE a.active = 1 AND (a.workspace_id = ?) ORDER BY a.name, m.level_code`,
        )
        .all(user.sessionId),
    );
  });

  app.get(`${api}/monitoring/ewma`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.materialId || !q.assayId) return reply.code(400).send({ error: 'assayId and materialId required' });
    reply.send(ewmaTab(sqlite, q.assayId, q.materialId, q.preset === 'sensitive' ? 'sensitive' : 'default'));
  });

  app.get(`${api}/monitoring/cusum`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.materialId || !q.assayId) return reply.code(400).send({ error: 'assayId and materialId required' });
    reply.send(cusumTab(sqlite, q.assayId, q.materialId, q.h ? Number(q.h) : 5, q.k ? Number(q.k) : 0.5, q.fir === 'true'));
  });

  app.get(`${api}/monitoring/variance`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.materialId || !q.assayId) return reply.code(400).send({ error: 'assayId and materialId required' });
    reply.send(varianceTab(sqlite, q.assayId, q.materialId, q.lambda ? Number(q.lambda) : 0.2));
  });

  app.get(`${api}/monitoring/changepoints`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.materialId || !q.assayId) return reply.code(400).send({ error: 'assayId and materialId required' });
    reply.send(changePointTab(sqlite, q.assayId, q.materialId, q.penaltyC ? Number(q.penaltyC) : 3));
  });

  app.get(`${api}/monitoring/lot-transition`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.materialId || !q.assayId) return reply.code(400).send({ error: 'assayId and materialId required' });
    reply.send(lotTransitionTab(sqlite, q.assayId, q.materialId, q.nA ? Number(q.nA) : 20, q.nB ? Number(q.nB) : 20));
  });

  app.get(`${api}/monitoring/signals`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    reply.send(
      sqlite
        .prepare(
          `SELECT s.*, a.name as assay_name, m.level_code, r.performed_at
           FROM monitor_signal s
           JOIN assay a ON a.id = s.assay_id
           LEFT JOIN qc_material m ON m.id = s.qc_material_id
           LEFT JOIN run r ON r.id = s.run_id
           WHERE a.workspace_id = ? ORDER BY r.performed_at DESC LIMIT 100`,
        )
        .all(user.sessionId),
    );
  });

  app.post(`${api}/monitoring/signals/:id/ack`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const res = acknowledgeSignal(sqlite, (req.params as { id: string }).id, user.id);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send({ ok: true });
  });

  // ------------------------------------------------------------- CSV import
  app.post(`${api}/import/validate`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      content: z.string().max(5_000_000),
      mapping: z.object({
        performedAt: z.string(),
        level: z.string(),
        value: z.string(),
        operator: z.string().optional(),
        instrument: z.string().optional(),
        lot: z.string().optional(),
      }),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid import request' });
    reply.send(validateImport(sqlite, body.data.assayId, body.data.content, body.data.mapping));
  });

  app.post(`${api}/import/commit`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      content: z.string().max(5_000_000),
      mapping: z.object({
        performedAt: z.string(),
        level: z.string(),
        value: z.string(),
        operator: z.string().optional(),
        instrument: z.string().optional(),
        lot: z.string().optional(),
      }),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid import request' });
    const res = commitImport(sqlite, body.data.assayId, body.data.content, body.data.mapping, user.id);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  app.get(`${api}/export/history.csv`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as Record<string, string>;
    if (!q.assayId) return reply.code(400).send({ error: 'assayId required' });
    reply.header('content-type', 'text/csv').send(exportHistoryCsv(sqlite, q.assayId));
  });

  // ----------------------------------------------------------------- plates
  app.post(`${api}/plates/import`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      content: z.string().max(2_000_000),
      filename: z.string().max(200).default('plate.csv'),
      layoutId: z.string().nullable().optional(),
      runId: z.string().nullable().optional(),
      transform: z.enum(['log', 'rank', 'identity']).optional(),
      B: z.number().int().min(199).max(999).optional(),
      seed: z.number().int().optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid plate import request' });
    const res = importPlate(sqlite, { ...body.data, userId: user.id });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  app.post(`${api}/plates/example`, async (req, reply) => {
    // two synthetic example plates so the anomaly detector explains itself:
    // one clean, one with a pipetting artifact injected into row F
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({ assayId: z.string() });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'assayId required' });
    const toCsv = (values: (number | null)[][]) =>
      values.map((row) => row.map((v) => (v === null ? '' : v.toFixed(4))).join(',')).join('\n');
    const cleanPlate = generatePlate(new Pcg32(41), { negSigma: 0.3, prevalence: 0.08 });
    injectEdgeEffect(cleanPlate, -0.05); // barely-there, stays below detection
    const faultPlate = generatePlate(new Pcg32(97), { negSigma: 0.3, prevalence: 0.08 });
    injectRowBias(faultPlate, 5, 0.9); // row F systematically high
    const clean = importPlate(sqlite, {
      assayId: body.data.assayId,
      content: toCsv(cleanPlate.values),
      filename: 'EXAMPLE-clean-plate.csv',
      userId: user.id,
    });
    const fault = importPlate(sqlite, {
      assayId: body.data.assayId,
      content: toCsv(faultPlate.values),
      filename: 'EXAMPLE-row-F-artifact.csv',
      userId: user.id,
    });
    if (!clean.ok || !fault.ok) return reply.code(400).send({ error: (!clean.ok && clean.error) || (!fault.ok && fault.error) || 'failed' });
    reply.send({ cleanPlateId: clean.plateId, faultPlateId: fault.plateId });
  });

  app.get(`${api}/plates`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const plates = sqlite
      .prepare(
        `SELECT p.id, p.imported_at, p.source_filename, p.transform_used, a.name as assay_name, a.id as assay_id,
                pa.findings_json, pa.t2, pa.spe, pa.phase2_model_id
         FROM plate p
         JOIN assay a ON a.id = p.assay_id
         LEFT JOIN plate_analysis pa ON pa.plate_id = p.id
         WHERE a.workspace_id = ?
         ORDER BY p.imported_at DESC LIMIT 200`,
      )
      .all(user.sessionId) as Record<string, unknown>[];
    for (const p of plates) {
      const findings = p.findings_json ? (JSON.parse(p.findings_json as string) as { kind: string }[]) : [];
      p.findingsCount = findings.filter((f) => f.kind !== 'local_outlier').length;
      p.outlierCount = findings.filter((f) => f.kind === 'local_outlier').length;
      delete p.findings_json;
    }
    reply.send(plates);
  });

  app.get(`${api}/plates/:id`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const plate = sqlite
      .prepare('SELECT p.*, a.name as assay_name FROM plate p JOIN assay a ON a.id = p.assay_id WHERE p.id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!plate) return reply.code(404).send({ error: 'plate not found' });
    plate.wells = sqlite.prepare('SELECT * FROM well_measurement WHERE plate_id = ? ORDER BY row, col').all(id);
    const analysis = sqlite
      .prepare('SELECT * FROM plate_analysis WHERE plate_id = ? ORDER BY analyzed_at DESC LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    if (analysis) {
      analysis.params = JSON.parse(analysis.params_json as string);
      analysis.rowEffects = JSON.parse(analysis.row_effects_json as string);
      analysis.colEffects = JSON.parse(analysis.col_effects_json as string);
      analysis.grad = JSON.parse(analysis.grad_json as string);
      analysis.pValues = analysis.pvalues_json ? JSON.parse(analysis.pvalues_json as string) : null;
      analysis.findings = JSON.parse(analysis.findings_json as string);
      delete analysis.params_json;
      delete analysis.row_effects_json;
      delete analysis.col_effects_json;
      delete analysis.grad_json;
      delete analysis.pvalues_json;
      delete analysis.findings_json;
    }
    plate.analysis = analysis ?? null;
    const model = latestPhase2Model(sqlite, plate.assay_id as string);
    plate.phase2Limits = model ? { t2Ucl: model.model.t2Ucl, speUcl: model.model.speUcl, n: model.model.n, aComponents: model.model.aComponents } : null;
    reply.send(plate);
  });

  app.post(`${api}/plates/phase2/rebuild`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({ assayId: z.string() });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'assayId required' });
    const res = rebuildPhase2(sqlite, body.data.assayId, user.id);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    reply.send(res);
  });

  app.get(`${api}/assays/:id/layouts`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const layouts = sqlite.prepare('SELECT * FROM plate_layout WHERE assay_id = ?').all((req.params as { id: string }).id) as Record<string, unknown>[];
    for (const l of layouts) {
      l.wellTypes = JSON.parse(l.well_types_json as string);
      delete l.well_types_json;
    }
    reply.send(layouts);
  });

  app.post(`${api}/layouts`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      name: z.string().trim().min(1).max(120),
      wellTypes: z.array(z.array(z.enum(['sample', 'blank', 'neg_ctrl', 'pos_ctrl', 'calibrator', 'empty'])).length(12)).length(8),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid layout' });
    const id = ulid();
    sqlite
      .prepare('INSERT INTO plate_layout (id, assay_id, name, well_types_json) VALUES (?, ?, ?, ?)')
      .run(id, body.data.assayId, body.data.name, JSON.stringify(body.data.wellTypes));
    appendAudit(sqlite, { userId: user.id, entity: 'plate_layout', entityId: id, action: 'create', after: { name: body.data.name } });
    reply.send({ id });
  });

  // ---------------------------------------------------------------- reports
  app.post(`${api}/reports/daily`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'date (YYYY-MM-DD) required' });
    reply.send(dailyReport(sqlite, config.dataDir, body.data.date, user.id, user.sessionId));
  });

  app.post(`${api}/reports/monthly`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'month (YYYY-MM) required' });
    reply.send(monthlyReport(sqlite, config.dataDir, body.data.month, user.id, user.sessionId));
  });

  app.post(`${api}/reports/assay`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({
      assayId: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'assayId required' });
    const res = assayReportPdf(sqlite, config.dataDir, body.data.assayId, user.id, user.sessionId, body.data.from, body.data.to);
    if (!res) return reply.code(404).send({ error: 'assay not found' });
    reply.send({ id: res.id, filename: res.filename });
  });

  app.post(`${api}/reports/monitoring`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({ assayId: z.string() });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'assayId required' });
    const res = monitoringReportPdf(sqlite, config.dataDir, body.data.assayId, user.id, user.sessionId);
    if (!res) return reply.code(404).send({ error: 'assay not found' });
    reply.send({ id: res.id, filename: res.filename });
  });

  app.get(`${api}/reports/:id/download`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const row = sqlite.prepare('SELECT file_path, params_json FROM report WHERE id = ?').get((req.params as { id: string }).id) as
      | { file_path: string; params_json: string }
      | undefined;
    if (!row || dirname(resolve(row.file_path)) !== resolve(config.dataDir, 'reports')) return reply.code(404).send({ error: 'report not found' });
    const isPdf = row.file_path.endsWith('.pdf');
    const filename = (JSON.parse(row.params_json).filename as string | undefined) ?? (isPdf ? 'qc-report.pdf' : 'report.html');
    reply
      .header('content-type', isPdf ? 'application/pdf' : 'text/html')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .send(readFileSync(row.file_path));
  });

  app.post(`${api}/reports/plate`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const Body = z.object({ plateId: z.string() });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'plateId required' });
    const res = plateReport(sqlite, config.dataDir, body.data.plateId, user.id, user.sessionId);
    if (!res) return reply.code(404).send({ error: 'plate not found' });
    reply.send(res);
  });

  app.get(`${api}/reports`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(
      sqlite
        .prepare('SELECT r.id, r.kind, r.params_json, r.generated_at, u.display_name as generated_by FROM report r JOIN user u ON u.id = r.generated_by WHERE r.workspace_id = ? ORDER BY r.generated_at DESC LIMIT 100')
        .all(user.sessionId),
    );
  });

  app.get(`${api}/reports/:id/html`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const row = sqlite.prepare('SELECT file_path FROM report WHERE id = ?').get((req.params as { id: string }).id) as { file_path: string } | undefined;
    if (!row || dirname(resolve(row.file_path)) !== resolve(config.dataDir, 'reports')) return reply.code(404).send({ error: 'report not found' });
    if (!row.file_path.endsWith('.html')) return reply.code(404).send({ error: 'HTML report not found' });
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'none'");
    reply.header('content-type', 'text/html').send(readFileSync(row.file_path, 'utf8'));
  });

  // Installation administration is deliberately unavailable to shared logins.
  for (const url of ['/users', '/users/:id', '/audit', '/audit/verify', '/backup/export.json', '/profiles/:id']) {
    app.route({ method: ['GET', 'POST', 'PATCH'], url: `${api}${url}`, handler: async (_req, reply) => reply.code(403).send({ error: 'Installation administration is not available in private workspaces.' }) });
  }
  for (const url of ['/profiles', '/instruments']) {
    app.post(`${api}${url}`, async (_req, reply) => reply.code(403).send({ error: 'Installation configuration is read-only.' }));
  }

  app.get(`${api}/instruments`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send([]);
  });

  app.get(`${api}/laboratory`, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    reply.send(workspaceLab(sqlite, user.sessionId));
  });

  app.patch(`${api}/laboratory`, async (req, reply) => {
    const user = requireRole(req, reply, 'supervisor');
    if (!user) return;
    const body = z.object({ name: z.string().trim().min(1).max(160) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'name required (up to 160 characters)' });
    sqlite.prepare('UPDATE workspace SET lab_name = ? WHERE id = ?').run(body.data.name, user.sessionId);
    reply.send({ ok: true });
  });

  app.get(`${api}/health`, async (_req, reply) => {
    reply.send({ ok: true, version: '0.1.0' });
  });
}
