/**
 * Database bootstrap: opens the SQLite file (WAL mode, foreign keys on), applies
 * pending migrations from ./migrations (tracked in _migrations), and returns a
 * drizzle instance plus the raw better-sqlite3 handle.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDb {
  db: Db;
  sqlite: Database.Database;
}

function migrationsDir(): string {
  // works from src (tsx/vitest) and from dist (built): migrations sit next to the
  // package root in src mode and are copied into dist at build time
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'migrations'), join(here, '..', 'migrations')]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

export function openDb(path: string): OpenedDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      if ((sqlite.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error(`Migration ${f} would leave invalid foreign keys`);
      }
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(f, new Date().toISOString());
    });
    // SQLite table rebuilds require this outside the migration transaction.
    sqlite.pragma('foreign_keys = OFF');
    try {
      tx();
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }
  }
}
