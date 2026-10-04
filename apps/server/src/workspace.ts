/** Fail-closed API ownership checks. Account identity is never workspace identity. */
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';

const resources = {
  assay: 'SELECT id AS assayId, workspace_id AS workspaceId FROM assay WHERE id = ?',
  material: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM qc_material r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  lot: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM reagent_lot r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  run: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM run r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  observation: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM observation o JOIN run r ON r.id = o.run_id JOIN assay a ON a.id = r.assay_id WHERE o.id = ?',
  plate: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM plate r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  layout: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM plate_layout r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  signal: 'SELECT a.id AS assayId, a.workspace_id AS workspaceId FROM monitor_signal r JOIN assay a ON a.id = r.assay_id WHERE r.id = ?',
  report: 'SELECT workspace_id AS workspaceId FROM report WHERE id = ?',
} as const;
type Resource = keyof typeof resources;

// Every API route must be explicitly classified; additions are denied by default.
const policies: Record<string, Resource | 'list' | 'public' | 'disabled'> = {};
for (const path of ['GET health', 'POST auth/login']) policies[path] = 'public';
for (const path of [
  'GET auth/me', 'POST auth/logout', 'GET today', 'GET assays', 'POST assays', 'GET profiles',
  'POST materials', 'POST reagent-lots', 'POST runs', 'POST batch-entry', 'GET runs',
  'POST baselines/preview', 'POST baselines/freeze', 'GET runlog', 'GET charts/lj',
  'GET monitoring/materials', 'GET monitoring/ewma', 'GET monitoring/cusum',
  'GET monitoring/variance', 'GET monitoring/changepoints', 'GET monitoring/lot-transition',
  'GET monitoring/signals', 'POST import/validate', 'POST import/commit', 'GET export/history.csv',
  'POST plates/import', 'POST plates/example', 'GET plates', 'POST plates/phase2/rebuild',
  'POST layouts', 'POST reports/daily', 'POST reports/monthly', 'POST reports/assay',
  'POST reports/monitoring', 'POST reports/plate', 'GET reports', 'GET instruments',
  'GET laboratory', 'PATCH laboratory',
]) policies[path] = 'list';
for (const path of ['PATCH assays/:id', 'GET assays/:id/materials', 'GET assays/:id/reagent-lots', 'GET assays/:id/run-context', 'GET assays/:id/layouts']) policies[path] = 'assay';
policies['GET materials/:id/baselines'] = 'material';
policies['GET runs/:id'] = policies['POST runs/:id/override'] = 'run';
policies['POST observations/:id/correct'] = 'observation';
policies['GET plates/:id'] = 'plate';
policies['POST monitoring/signals/:id/ack'] = 'signal';
policies['GET reports/:id/download'] = policies['GET reports/:id/html'] = 'report';
for (const path of [
  'GET users', 'POST users', 'PATCH users/:id', 'GET audit', 'GET audit/verify',
  'GET backup/export.json', 'POST profiles', 'PATCH profiles/:id', 'POST instruments',
]) policies[path] = 'disabled';

const fields: Record<string, Resource> = {
  assayId: 'assay', qcMaterialId: 'material', materialId: 'material', reagentLotId: 'lot',
  runId: 'run', plateId: 'plate', layoutId: 'layout',
};

export function authorizeWorkspace(sqlite: Database.Database, req: FastifyRequest, reply: FastifyReply): void {
  const route = req.routeOptions.url;
  if (!route?.startsWith('/api/')) return;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const policy = policies[`${method} ${route.replace('/api/v1/', '')}`];
  if (policy === 'public') return;
  const user = req.sessionUser;
  if (!user) { reply.code(401).send({ error: 'authentication required' }); return; }
  if (!policy || policy === 'disabled') {
    reply.code(403).send({ error: 'This operation is not available in a private workspace.' });
    return;
  }
  const expected = req.headers['x-sentinel-workspace'];
  if (expected !== undefined && expected !== user.sessionId) {
    reply.code(409).send({ error: 'Your session changed. Reload to continue.', code: 'SESSION_CHANGED' });
    return;
  }
  let assayId: string | undefined;
  const check = (kind: Resource, id: unknown): boolean => {
    if (typeof id !== 'string' || !id || id.length > 100) return false;
    const row = sqlite.prepare(resources[kind]).get(id) as { assayId?: string; workspaceId: string | null } | undefined;
    if (!row || row.workspaceId !== user.sessionId) return false;
    // A supplied material, lot, layout or run must belong to the supplied assay,
    // not just to some other assay in the same workspace.
    if (row.assayId) {
      if (assayId && assayId !== row.assayId) return false;
      assayId = row.assayId;
    }
    return true;
  };
  const missing = () => { reply.code(404).send({ error: 'Resource not found in this workspace.' }); };
  if (policy !== 'list' && !check(policy, (req.params as { id?: string }).id)) { missing(); return; }
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const data = source as Record<string, unknown>;
    for (const [field, kind] of Object.entries(fields)) {
      if (data[field] !== undefined && data[field] !== null && !check(kind, data[field])) { missing(); return; }
    }
    // Instruments/profiles are immutable installation templates, not user data.
    // Instruments are not exposed by the private-workspace UI.
    if (data.instrumentId) { missing(); return; }
    if (data.westgardProfileId !== undefined) {
      const profile = sqlite.prepare("SELECT id FROM westgard_profile WHERE id = ? AND name IN ('N2_classic', 'N3')").get(data.westgardProfileId);
      if (!profile) { missing(); return; }
    }
    if (Array.isArray(data.excludedObservationIds)) {
      if (data.excludedObservationIds.length > 1000 || !data.excludedObservationIds.every((id) => check('observation', id))) { missing(); return; }
      if (data.qcMaterialId && data.excludedObservationIds.some((id) => {
        const row = sqlite.prepare('SELECT qc_material_id FROM observation WHERE id = ?').get(id) as { qc_material_id: string };
        return row.qc_material_id !== data.qcMaterialId;
      })) { missing(); return; }
    }
  }
  // Bound storage/CPU growth for a public installation with shared credentials.
  // These limits are deliberately much larger than one bench session.
  const creates: Record<string, [string, number]> = {
    'POST layouts': ['SELECT COUNT(*) AS n FROM plate_layout r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 100],
    'POST materials': ['SELECT COUNT(*) AS n FROM qc_material r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 200],
    'POST reagent-lots': ['SELECT COUNT(*) AS n FROM reagent_lot r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 500],
    'POST assays': ['SELECT COUNT(*) AS n FROM assay WHERE workspace_id = ?', 25],
    'POST runs': ['SELECT COUNT(*) AS n FROM run r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 10000],
    'POST batch-entry': ['SELECT COUNT(*) AS n FROM run r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 9600],
    'POST import/commit': ['SELECT COUNT(*) AS n FROM run r JOIN assay a ON a.id = r.assay_id WHERE a.workspace_id = ?', 7600],
    'POST plates/import': ['SELECT COUNT(*) AS n FROM plate p JOIN assay a ON a.id = p.assay_id WHERE a.workspace_id = ?', 200],
    'POST plates/example': ['SELECT COUNT(*) AS n FROM plate p JOIN assay a ON a.id = p.assay_id WHERE a.workspace_id = ?', 199],
  };
  const quota = method === 'POST' && route.startsWith('/api/v1/reports/')
    ? ['SELECT COUNT(*) AS n FROM report WHERE workspace_id = ?', 100] as const
    : creates[`${method} ${route.replace('/api/v1/', '')}`];
  if (quota && (sqlite.prepare(quota[0]).get(user.sessionId) as { n: number }).n >= quota[1]) {
    reply.code(429).send({ error: 'This temporary workspace has reached its capacity. Download your reports before starting a new session.' });
  }
}

export function workspaceLab(sqlite: Database.Database, workspaceId: string): { name: string } {
  return (sqlite.prepare('SELECT lab_name AS name FROM workspace WHERE id = ?').get(workspaceId) as { name: string }) ?? { name: 'Laboratory' };
}
