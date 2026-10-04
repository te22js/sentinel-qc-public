import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type OpenedDb } from '../src/db.js';
import { appendAudit, verifyAuditChain, GENESIS } from '../src/audit.js';
import { seedStructure } from '../src/seed.js';
import { ulid } from '../src/ulid.js';
import { canonicalJson } from '../src/canonical.js';

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(':memory:');
  seedStructure(opened.sqlite);
});

function makeUser(): string {
  const id = ulid();
  opened.sqlite
    .prepare("INSERT INTO user (id, username, display_name, role, password_hash) VALUES (?, ?, ?, 'admin', 'x')")
    .run(id, `u_${id}`, 'Test User');
  return id;
}

function makeAssayFixture() {
  const s = opened.sqlite;
  const profile = s.prepare("SELECT id FROM westgard_profile WHERE name = 'N2_classic'").get() as { id: string };
  const assayId = ulid();
  s.prepare(
    "INSERT INTO assay (id, name, qc_scheme_json, westgard_profile_id) VALUES (?, ?, ?, ?)",
  ).run(assayId, `HBsAg-${assayId}`, JSON.stringify({ levels: [{ level_code: 'L1', replicates: 1 }] }), profile.id);
  const materialId = ulid();
  s.prepare("INSERT INTO qc_material (id, assay_id, level_code, lot) VALUES (?, ?, 'L1', 'LOT1')").run(
    materialId,
    assayId,
  );
  return { assayId, materialId };
}

describe('migrations and schema', () => {
  it('applies migrations idempotently with WAL and foreign keys', () => {
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const tables = opened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ['assay', 'run', 'observation', 'audit_event', 'baseline', 'plate', 'well_measurement']) {
      expect(tables).toContain(t);
    }
  });

  it('seeds the built-in Westgard profiles once', () => {
    seedStructure(opened.sqlite); // second call is a no-op
    const n = opened.sqlite.prepare('SELECT COUNT(*) c FROM westgard_profile').get() as { c: number };
    expect(n.c).toBe(2);
  });
});

describe('observation immutability', () => {
  it('blocks UPDATE of raw_value via trigger; corrections use supersedes_id', () => {
    const s = opened.sqlite;
    const userId = makeUser();
    const { assayId, materialId } = makeAssayFixture();
    const runId = ulid();
    s.prepare(
      "INSERT INTO run (id, assay_id, operator_user_id, performed_at, entered_at, verdict) VALUES (?, ?, ?, ?, ?, 'pass')",
    ).run(runId, assayId, userId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const obsId = ulid();
    s.prepare(
      'INSERT INTO observation (id, run_id, qc_material_id, raw_value, transformed_value) VALUES (?, ?, ?, 1.0, 1.0)',
    ).run(obsId, runId, materialId);

    expect(() => s.prepare('UPDATE observation SET raw_value = 2.0 WHERE id = ?').run(obsId)).toThrow(
      /immutable/,
    );
    // marking as superseded (metadata) is allowed
    s.prepare('UPDATE observation SET superseded = 1 WHERE id = ?').run(obsId);
    const corrId = ulid();
    s.prepare(
      'INSERT INTO observation (id, run_id, qc_material_id, raw_value, transformed_value, supersedes_id) VALUES (?, ?, ?, 2.0, 2.0, ?)',
    ).run(corrId, runId, materialId, obsId);
    const rows = s.prepare('SELECT COUNT(*) c FROM observation WHERE run_id = ?').get(runId) as { c: number };
    expect(rows.c).toBe(2);
  });
});

describe('audit hash chain', () => {
  it('appends events chained from genesis and verifies', () => {
    const userId = makeUser();
    appendAudit(opened.sqlite, { userId, entity: 'run', entityId: 'r1', action: 'create', after: { a: 1 } });
    appendAudit(opened.sqlite, { userId, entity: 'run', entityId: 'r1', action: 'override', reason: 'ok' });
    appendAudit(opened.sqlite, { userId: null, entity: 'user', entityId: userId, action: 'login' });
    const res = verifyAuditChain(opened.sqlite);
    expect(res.ok).toBe(true);
    expect(res.events).toBe(3);
    const first = opened.sqlite.prepare('SELECT prev_hash FROM audit_event WHERE seq = 1').get() as any;
    expect(first.prev_hash).toBe(GENESIS);
  });

  it('detects a tampered row', () => {
    const userId = makeUser();
    appendAudit(opened.sqlite, { userId, entity: 'run', entityId: 'r1', action: 'create', after: { v: 'original' } });
    appendAudit(opened.sqlite, { userId, entity: 'run', entityId: 'r2', action: 'create', after: { v: 'second' } });
    // an attacker with DB access drops the protective trigger and edits history
    opened.sqlite.exec('DROP TRIGGER audit_event_no_update');
    opened.sqlite.prepare("UPDATE audit_event SET after_json = ? WHERE seq = 1").run(canonicalJson({ v: 'FORGED' }));
    const res = verifyAuditChain(opened.sqlite);
    expect(res.ok).toBe(false);
    expect(res.failedAtSeq).toBe(1);
  });

  it('detects a deleted event (sequence gap)', () => {
    const userId = makeUser();
    for (let i = 0; i < 3; i++) {
      appendAudit(opened.sqlite, { userId, entity: 'x', entityId: String(i), action: 'create' });
    }
    opened.sqlite.exec('DROP TRIGGER audit_event_no_delete');
    opened.sqlite.prepare('DELETE FROM audit_event WHERE seq = 2').run();
    const res = verifyAuditChain(opened.sqlite);
    expect(res.ok).toBe(false);
  });

  it('audit UPDATE and DELETE are blocked by triggers', () => {
    const userId = makeUser();
    appendAudit(opened.sqlite, { userId, entity: 'x', entityId: '1', action: 'create' });
    expect(() => opened.sqlite.prepare("UPDATE audit_event SET reason = 'edited'").run()).toThrow(/append-only/);
    expect(() => opened.sqlite.prepare('DELETE FROM audit_event').run()).toThrow(/append-only/);
  });
});

describe('canonical json', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});

describe('ulid', () => {
  it('generates sortable unique ids', () => {
    const ids = Array.from({ length: 200 }, () => ulid());
    expect(new Set(ids).size).toBe(200);
    const sorted = ids.slice().sort();
    expect(sorted).toEqual(ids); // monotonic within the same process
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('workspace migration upgrades', () => {
  it('preserves existing observations and references while allowing identical names in separate workspaces', async () => {
    const { default: Database } = await import('better-sqlite3');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-upgrade-'));
    const file = join(dir, 'old.sqlite');
    const old = new Database(file);
    old.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const name of ['0001_init.sql', '0002_run_fields.sql', '0003_workspace.sql']) {
      old.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      old.prepare('INSERT INTO _migrations VALUES (?, ?)').run(name, new Date().toISOString());
    }
    seedStructure(old);
    const profile = (old.prepare('SELECT id FROM westgard_profile LIMIT 1').get() as { id: string }).id;
    old.exec("INSERT INTO user (id, username, display_name, role, password_hash) VALUES ('u', 'u', 'U', 'admin', 'hash')");
    old.exec("INSERT INTO session VALUES ('w1', 'u', 'token', '2026-01-01', '2099-01-01')");
    old.prepare("INSERT INTO assay (id, name, qc_scheme_json, westgard_profile_id, workspace_id) VALUES ('a', 'Same assay', '{}', ?, 'w1')").run(profile);
    old.exec("INSERT INTO qc_material (id, assay_id, level_code, lot) VALUES ('m', 'a', 'L1', 'lot')");
    old.exec("INSERT INTO run (id, assay_id, operator_user_id, performed_at, entered_at, verdict) VALUES ('r', 'a', 'u', '2026-01-01', '2026-01-01', 'pass')");
    old.exec("INSERT INTO observation (id, run_id, qc_material_id, raw_value, transformed_value) VALUES ('o', 'r', 'm', 1.25, 1.25)");
    old.exec("INSERT INTO plate_layout VALUES ('l', 'a', 'layout', '[]')");
    appendAudit(old, { userId: 'u', entity: 'run', entityId: 'r', action: 'create', after: { value: 1.25 } });
    old.close();
    const upgraded = openDb(file);
    try {
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(upgraded.sqlite.prepare("SELECT raw_value FROM observation WHERE id = 'o'").get()).toEqual({ raw_value: 1.25 });
      expect(upgraded.sqlite.prepare("SELECT lab_name FROM workspace WHERE id = 'w1'").get()).toEqual({ lab_name: 'Laboratory' });
      upgraded.sqlite.prepare("INSERT INTO assay (id, name, qc_scheme_json, westgard_profile_id, workspace_id) VALUES ('b', 'Same assay', '{}', ?, 'w2')").run(profile);
      expect(() => upgraded.sqlite.prepare("INSERT INTO assay (id, name, qc_scheme_json, westgard_profile_id, workspace_id) VALUES ('c', 'Same assay', '{}', ?, 'w1')").run(profile)).toThrow(/UNIQUE/);
      expect(verifyAuditChain(upgraded.sqlite).ok).toBe(true);
    } finally { upgraded.sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
