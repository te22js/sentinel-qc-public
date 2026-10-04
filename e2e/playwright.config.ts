import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.SENTINEL_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'sentinel-e2e-'));
process.env.SENTINEL_E2E_DATA_DIR = dataDir;

/**
 * E2E against the production build: `pnpm build` first, then `pnpm --filter @sentinel/e2e test`.
 * The webServer boots dist/server.js on a scratch database with a known admin password.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  globalTeardown: './teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:18080',
    extraHTTPHeaders: { 'x-sentinel-request': '1' },
  },
  webServer: {
    command: 'node ../dist/server.js',
    env: { SENTINEL_PORT: '18080', SENTINEL_HOST: '127.0.0.1', SENTINEL_DATA_DIR: dataDir, SENTINEL_ADMIN_PASSWORD: 'e2e-password-1', SENTINEL_SECURE_COOKIES: '0' },
    url: 'http://127.0.0.1:18080/api/v1/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
