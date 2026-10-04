/** Server configuration from environment variables with safe defaults. */
import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  /** the shared lab account (created at boot if missing) */
  bootstrapUsername: string;
  bootstrapAdminPassword: string;
  sessionTtlHours: number;
  /** directory of the built web app (served statically when present) */
  webDist: string | null;
  secureCookies?: boolean;
  publicOrigin?: string | null;
}

export function loadConfig(): Config {
  const dataDir = process.env.SENTINEL_DATA_DIR ?? './data';
  const password = process.env.SENTINEL_ADMIN_PASSWORD;
  if (!password) throw new Error('Set SENTINEL_ADMIN_PASSWORD in the hosting environment before starting.');
  return {
    port: Number(process.env.SENTINEL_PORT ?? 8080),
    host: process.env.SENTINEL_HOST ?? '127.0.0.1',
    dataDir,
    dbPath: process.env.SENTINEL_DB ?? join(dataDir, 'sentinel.sqlite'),
    bootstrapUsername: process.env.SENTINEL_USERNAME ?? 'labqc',
    bootstrapAdminPassword: password,
    sessionTtlHours: Number(process.env.SENTINEL_SESSION_TTL_HOURS ?? 12),
    webDist: process.env.SENTINEL_WEB_DIST ?? null,
    secureCookies: process.env.SENTINEL_SECURE_COOKIES === '1',
    publicOrigin: process.env.SENTINEL_PUBLIC_ORIGIN ? new URL(process.env.SENTINEL_PUBLIC_ORIGIN).origin : null,
  };
}
