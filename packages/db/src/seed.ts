/**
 * Idempotent structural seed: the laboratory row and the two built-in Westgard
 * profiles (N2_classic, N3). Users are created by the server (argon2 lives there).
 */
import type Database from 'better-sqlite3';
import { ulid } from './ulid.js';

export const BUILTIN_PROFILES = [
  {
    name: 'N2_classic',
    rules: [
      { rule: '1_2s', enabled: true, scope: 'within_run', severity: 'warning' },
      { rule: '1_3s', enabled: true, scope: 'within_run', severity: 'reject' },
      { rule: '2_2s', enabled: true, scope: 'both', severity: 'reject' },
      { rule: 'R_4s', enabled: true, scope: 'within_run', severity: 'reject' },
      { rule: '4_1s', enabled: true, scope: 'across_runs', severity: 'reject' },
      { rule: '10x', enabled: true, scope: 'across_runs', severity: 'reject' },
    ],
  },
  {
    name: 'N3',
    rules: [
      { rule: '1_2s', enabled: true, scope: 'within_run', severity: 'warning' },
      { rule: '1_3s', enabled: true, scope: 'within_run', severity: 'reject' },
      { rule: '2of3_2s', enabled: true, scope: 'within_run', severity: 'reject' },
      { rule: 'R_4s', enabled: true, scope: 'within_run', severity: 'reject' },
      { rule: '3_1s', enabled: true, scope: 'both', severity: 'reject' },
      { rule: '6x', enabled: true, scope: 'across_runs', severity: 'reject' },
      { rule: '9x', enabled: false, scope: 'across_runs', severity: 'reject' },
    ],
  },
] as const;

export function seedStructure(sqlite: Database.Database, labName = 'Sentinel QC Laboratory'): void {
  const lab = sqlite.prepare('SELECT id FROM laboratory LIMIT 1').get();
  if (!lab) {
    sqlite
      .prepare('INSERT INTO laboratory (id, name, timezone) VALUES (?, ?, ?)')
      .run(ulid(), labName, Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  }
  const insert = sqlite.prepare('INSERT INTO westgard_profile (id, name, rules_json) VALUES (?, ?, ?)');
  for (const p of BUILTIN_PROFILES) {
    const exists = sqlite.prepare('SELECT id FROM westgard_profile WHERE name = ?').get(p.name);
    if (!exists) insert.run(ulid(), p.name, JSON.stringify(p.rules));
  }
}
