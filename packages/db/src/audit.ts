/**
 * Append-only, hash-chained audit log.
 *
 * Each event stores hash = sha256(prev_hash || canonical_json(payload)), where payload
 * is every column except prev_hash and hash, with recursively sorted keys. The first
 * event chains from the constant GENESIS. `verifyAuditChain` walks the chain in seq
 * order and reports the first divergence; the verify-audit CLI exits non-zero on tamper.
 *
 * DB triggers (0001_init.sql) additionally forbid UPDATE/DELETE on audit_event.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from './canonical.js';
import { ulid } from './ulid.js';

export const GENESIS = 'sentinel-qc-genesis';

export interface AuditInput {
  userId: string | null;
  entity: string;
  entityId: string;
  action: 'create' | 'update' | 'override' | 'freeze' | 'generate_report' | 'login' | 'config_change';
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  at?: string;
}

function hashEvent(prevHash: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(payload)).digest('hex');
}

/** Append one audit event inside the caller's transaction (or standalone). */
export function appendAudit(sqlite: Database.Database, input: AuditInput): string {
  const last = sqlite
    .prepare('SELECT seq, hash FROM audit_event ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS;
  const id = ulid();
  const at = input.at ?? new Date().toISOString();
  const payload = {
    id,
    seq,
    at,
    user_id: input.userId,
    entity: input.entity,
    entity_id: input.entityId,
    action: input.action,
    before_json: input.before === undefined ? null : canonicalJson(input.before),
    after_json: input.after === undefined ? null : canonicalJson(input.after),
    reason: input.reason ?? null,
  };
  const hash = hashEvent(prevHash, payload);
  sqlite
    .prepare(
      `INSERT INTO audit_event (id, seq, at, user_id, entity, entity_id, action, before_json, after_json, reason, prev_hash, hash)
       VALUES (@id, @seq, @at, @user_id, @entity, @entity_id, @action, @before_json, @after_json, @reason, @prev_hash, @hash)`,
    )
    .run({ ...payload, prev_hash: prevHash, hash });
  return id;
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  failedAtSeq?: number;
  message: string;
}

export function verifyAuditChain(sqlite: Database.Database): VerifyResult {
  const rows = sqlite
    .prepare('SELECT * FROM audit_event ORDER BY seq ASC')
    .all() as Record<string, unknown>[];
  let prevHash = GENESIS;
  let prevSeq = 0;
  for (const row of rows) {
    const seq = row.seq as number;
    if (seq !== prevSeq + 1) {
      return { ok: false, events: rows.length, failedAtSeq: seq, message: `gap in sequence: expected ${prevSeq + 1}, found ${seq}` };
    }
    if (row.prev_hash !== prevHash) {
      return { ok: false, events: rows.length, failedAtSeq: seq, message: `prev_hash mismatch at seq ${seq}` };
    }
    const payload = {
      id: row.id,
      seq: row.seq,
      at: row.at,
      user_id: row.user_id,
      entity: row.entity,
      entity_id: row.entity_id,
      action: row.action,
      before_json: row.before_json,
      after_json: row.after_json,
      reason: row.reason,
    };
    const expected = hashEvent(prevHash, payload);
    if (expected !== row.hash) {
      return { ok: false, events: rows.length, failedAtSeq: seq, message: `hash mismatch at seq ${seq} (row content altered)` };
    }
    prevHash = row.hash as string;
    prevSeq = seq;
  }
  return { ok: true, events: rows.length, message: `audit chain intact (${rows.length} events)` };
}
