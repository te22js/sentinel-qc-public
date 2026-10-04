/** CLI: verify the audit hash chain. Exit 0 if intact, 1 if tampered/broken. */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { verifyAuditChain } from '../audit.js';

// resolve relative paths against where the user invoked pnpm (INIT_CWD), not the package dir
const base = process.env.INIT_CWD ?? process.cwd();
const raw = process.env.SENTINEL_DB ?? process.argv[2] ?? './data/sentinel.sqlite';
const path = isAbsolute(raw) ? raw : join(base, raw);
if (!existsSync(path)) {
  console.error(`database not found: ${path}`);
  process.exit(2);
}
const sqlite = new Database(path, { readonly: true });
const res = verifyAuditChain(sqlite);
console.log(res.message);
process.exit(res.ok ? 0 : 1);
