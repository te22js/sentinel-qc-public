/** Typed fetch wrapper for /api/v1 plus shared response types. */

let workspaceId: string | null = null;
const sessionChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sentinel-session') : null;
sessionChannel?.addEventListener('message', () => window.dispatchEvent(new Event('sentinel-session-ended')));
export function announceSessionChange() {
  workspaceId = null;
  sessionChannel?.postMessage('changed');
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${url}`, {
    method,
    headers: {
      'x-sentinel-request': '1',
      ...(workspaceId && url !== '/auth/me' && url !== '/auth/login' ? { 'x-sentinel-workspace': workspaceId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error ?? message;
      if (data.code === 'SESSION_CHANGED') window.dispatchEvent(new Event('sentinel-session-ended'));
    } catch {
      /* keep statusText */
    }
    if (res.status === 401 && workspaceId && url !== '/auth/login') {
      workspaceId = null;
      window.dispatchEvent(new Event('sentinel-session-ended'));
    }
    throw new ApiError(res.status, message);
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = await (ct.includes('json') ? res.json() : res.text());
  if (url === '/auth/me') {
    if (workspaceId && workspaceId !== data.sessionId) window.dispatchEvent(new Event('sentinel-session-ended'));
    workspaceId = data.sessionId;
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
};

// ---------------------------------------------------------------- types

export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: 'technician' | 'supervisor' | 'admin';
  sessionId: string;
  expiresAt: string;
}

export interface TodayData {
  date: string;
  labName: string;
  demoMode: boolean;
  tiles: { runs: number; warnings: number; rejects: number };
  awaiting: { id: string; name: string }[];
  recent: {
    id: string;
    performed_at: string;
    verdict: string;
    override_status: string;
    assay: string;
    operator: string;
    observations: { level: string; z: number | null }[];
  }[];
}

export interface Assay {
  id: string;
  name: string;
  methodology: string;
  units: string;
  transform: 'none' | 'log' | 'ratio_to_cutoff';
  qcScheme: { levels: { level_code: string; replicates: number }[] };
  westgard_profile_id: string;
  profile_name: string;
  plating_order: string;
  allowable_bias_pct: number | null;
  reader_max: number | null;
  active: number;
}

export interface RunContext {
  assay: Assay & Record<string, unknown>;
  levels: {
    levelCode: string;
    replicates: number;
    material: Record<string, unknown> | null;
    baseline: { id: string; mean: number; sd: number; n: number; method: string } | null;
  }[];
  reagentLot: { id: string; lot: string; expiry: string | null } | null;
  instruments: { id: string; label: string }[];
}

export interface RuleEvaluationDto {
  rule: string;
  scope: string;
  status: 'not_applicable' | 'pass' | 'warning' | 'reject';
  observationIds: string[];
  message: string;
}

export interface CreateRunResponse {
  ok: boolean;
  runId: string;
  verdict: 'pass' | 'warning' | 'reject';
  message: string;
  evaluations: RuleEvaluationDto[];
  observations: { id: string; level: string; replicate: number; raw: number; z: number | null; flags: string[] }[];
}

export interface RunListItem {
  id: string;
  performed_at: string;
  verdict: string;
  override_status: string;
  assay: string;
  assayId: string;
  operator: string;
  instrument: string | null;
  reagentLot: string | null;
  observations: { level: string; raw: number; z: number | null }[];
}

export interface LjResponse {
  ok: boolean;
  points: {
    observationId: string;
    runId: string;
    performedAt: string;
    raw: number;
    transformed: number;
    z: number | null;
    verdict: string;
    violatedRules: string[];
  }[];
  events: { index: number; performedAt: string; kind: string; label: string }[];
  baseline: { mean: number; sd: number; n: number; method: string; effective_from: string } | null;
  stats: { n: number; mean: number | null; sd: number | null; cv: number | null };
}

export interface RunLogRow {
  runNo: number;
  runId: string;
  obsId: string;
  performedAt: string;
  technician: string | null;
  kitLot: string | null;
  raw: number;
  cutoff: number | null;
  value: number;
  z: number | null;
  flags: string[];
  verdictStored: string;
  overrideStatus: string;
}

export interface RunLogResponse {
  ok: boolean;
  assayName: string;
  levelCode: string;
  valueLabel: string;
  limits: {
    source: 'self' | 'baseline';
    scale: 'log' | 'linear';
    mean: number;
    sd: number;
    n: number;
    baselineMethod?: string;
    excluded?: number;
    provisional?: boolean;
    bands: { p3: number; p2: number; p1: number; mean: number; m1: number; m2: number; m3: number };
  } | null;
  stats: { n: number; mean: number | null; sd: number | null; cv: number | null };
  status: { inControl: boolean; violations: number; rejects: number; warnings: number; message: string };
  rows: RunLogRow[];
  series: { performedAt: string; value: number; z: number | null; flags: string[] }[];
}

export interface MonitoringMaterial {
  id: string;
  level_code: string;
  lot: string;
  assay_id: string;
  assay_name: string;
  n: number;
}

export interface PlateListItem {
  id: string;
  imported_at: string;
  source_filename: string;
  assay_name: string;
  assay_id: string;
  findingsCount: number;
  outlierCount: number;
  t2: number | null;
  spe: number | null;
}

export interface PsadFindingDto {
  kind: string;
  index?: string;
  effect: number;
  effectSd: number;
  p: number | null;
  wells: string[];
  message: string;
}

export interface PlateDetail {
  id: string;
  assay_id: string;
  assay_name: string;
  rows: number;
  cols: number;
  imported_at: string;
  source_filename: string;
  transform_used: string;
  wells: {
    row: number;
    col: number;
    well_type: string;
    raw_value: number | null;
    transformed_value: number | null;
    residual: number | null;
    z_local: number | null;
  }[];
  analysis: {
    mu: number | null;
    rowEffects: number[];
    colEffects: number[];
    edge_stat: number | null;
    moran_i: number | null;
    grad: { br: number | null; bc: number | null; tGrad: number | null };
    pValues: {
      row: number | null;
      col: number | null;
      perRow: (number | null)[];
      perCol: (number | null)[];
      edge: number | null;
      gradient: number | null;
      moran: number | null;
    } | null;
    findings: PsadFindingDto[];
    t2: number | null;
    spe: number | null;
    params: { nSampleWells: number; suppressedPValues: boolean; B: number; statistics: { s: number } | null; ok?: boolean; reason?: string | null };
  } | null;
  phase2Limits: { t2Ucl: number; speUcl: number; n: number; aComponents: number } | null;
}
