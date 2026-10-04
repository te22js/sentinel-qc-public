/**
 * Authentication: argon2id password hashes, opaque session tokens in an httpOnly
 * cookie, session rows in SQLite (revocable, auditable). No JWTs.
 */
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { ulid, appendAudit } from '@sentinel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'sentinel_session';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: 'technician' | 'supervisor' | 'admin';
  /** the session's id — used as the per-login workspace on the shared account */
  sessionId: string;
  expiresAt: string;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(sqlite: Database.Database, userId: string, ttlHours: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3600_000);
  const id = ulid();
  sqlite.transaction(() => {
    sqlite.prepare('INSERT INTO session (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, hashToken(token), now.toISOString(), expires.toISOString());
    sqlite.prepare('INSERT INTO workspace (id) VALUES (?)').run(id);
  })();
  return token;
}

export function destroySession(sqlite: Database.Database, token: string): void {
  sqlite.prepare('DELETE FROM session WHERE token_hash = ?').run(hashToken(token));
}

export function lookupSession(sqlite: Database.Database, token: string): SessionUser | null {
  const row = sqlite
    .prepare(
      `SELECT u.id, u.username, u.display_name as displayName, u.role, s.id as sessionId, s.expires_at as expiresAt
       FROM session s JOIN user u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(hashToken(token), new Date().toISOString()) as SessionUser | undefined;
  return row ?? null;
}

/** Remove expired/revoked workspaces, including generated downloads and layouts.
 * Audit records remain local and append-only; no browser endpoint exposes them.
 * Legacy unowned data is inaccessible and is left for the installation operator.
 */
export function purgeExpiredWorkspaces(sqlite: Database.Database, dataDir: string): number {
  sqlite.prepare('DELETE FROM session WHERE expires_at <= ?').run(new Date().toISOString());
  const dead = sqlite.prepare('SELECT id FROM workspace WHERE id NOT IN (SELECT id FROM session)').all() as { id: string }[];
  for (const { id } of dead) {
    const reports = sqlite.prepare('SELECT file_path FROM report WHERE workspace_id = ?').all(id) as { file_path: string }[];
    for (const report of reports) {
      const path = resolve(report.file_path);
      if (dirname(path) !== resolve(dataDir, 'reports')) throw new Error('Report file is outside the report directory');
      try { unlinkSync(path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    sqlite.transaction(() => {
      const assays = 'SELECT id FROM assay WHERE workspace_id = ?';
      const runs = `SELECT id FROM run WHERE assay_id IN (${assays})`;
      const plates = `SELECT id FROM plate WHERE assay_id IN (${assays})`;
      sqlite.prepare('DELETE FROM report WHERE workspace_id = ?').run(id);
      sqlite.prepare(`DELETE FROM monitor_signal WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM rule_evaluation WHERE run_id IN (${runs})`).run(id);
      sqlite.prepare(`DELETE FROM observation WHERE run_id IN (${runs})`).run(id);
      sqlite.prepare(`DELETE FROM plate_analysis WHERE plate_id IN (${plates})`).run(id);
      sqlite.prepare(`DELETE FROM well_measurement WHERE plate_id IN (${plates})`).run(id);
      sqlite.prepare(`DELETE FROM plate_phase2_model WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM plate WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM plate_layout WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM run WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM baseline WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM qc_material WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare(`DELETE FROM reagent_lot WHERE assay_id IN (${assays})`).run(id);
      sqlite.prepare('DELETE FROM assay WHERE workspace_id = ?').run(id);
      sqlite.prepare('DELETE FROM workspace WHERE id = ?').run(id);
    })();
  }
  return dead.length;
}

/** Cleanup failure must never restore access or prevent the server from starting.
 * Failed deletions remain queued as revoked workspaces and are retried each minute.
 */
export function cleanWorkspaces(sqlite: Database.Database, dataDir: string): void {
  try { purgeExpiredWorkspaces(sqlite, dataDir); }
  catch { console.error('Workspace cleanup needs attention; revoked data remains inaccessible. Cleanup will retry.'); }
}

/**
 * Ensure the shared lab account exists (single-login model: one account, private
 * workspaces, used by the whole lab). Created at every boot if missing, so existing
 * databases pick it up on upgrade. Installation-wide administration is not available through this account’s browser session.
 */
export async function ensureBootstrapAdmin(
  sqlite: Database.Database,
  username: string,
  password: string,
): Promise<void> {
  const existing = sqlite.prepare('SELECT id FROM user WHERE username = ?').get(username);
  if (existing) return;
  const id = ulid();
  const hash = await hashPassword(password);
  sqlite
    .prepare("INSERT INTO user (id, username, display_name, role, password_hash) VALUES (?, ?, 'Lab QC', 'admin', ?)")
    .run(id, username, hash);
  appendAudit(sqlite, {
    userId: null,
    entity: 'user',
    entityId: id,
    action: 'create',
    after: { username, role: 'admin', bootstrap: true },
  });
}

const ROLE_RANK = { technician: 0, supervisor: 1, admin: 2 } as const;

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = (req as FastifyRequest & { sessionUser?: SessionUser | null }).sessionUser;
  if (!user) {
    reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

export function requireRole(
  req: FastifyRequest,
  reply: FastifyReply,
  minRole: 'technician' | 'supervisor' | 'admin',
): SessionUser | null {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    reply.code(403).send({ error: `${minRole} role required` });
    return null;
  }
  return user;
}
