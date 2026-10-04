/** Sentinel QC server entry point. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { openDb, seedStructure } from '@sentinel/db';
import { loadConfig } from './config.js';
import { ensureBootstrapAdmin } from './auth.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  // default web dist: ./public next to the built server.js, or apps/web/dist in dev
  if (!config.webDist) {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, 'public'), join(here, '..', 'apps', 'web', 'dist'), join(here, '..', '..', 'apps', 'web', 'dist')]) {
      if (existsSync(candidate)) {
        config.webDist = candidate;
        break;
      }
    }
  }
  const opened = openDb(config.dbPath);
  seedStructure(opened.sqlite);
  await ensureBootstrapAdmin(opened.sqlite, config.bootstrapUsername, config.bootstrapAdminPassword);
  const app = await buildApp(config, opened);
  await app.listen({ port: config.port, host: config.host });
  console.log(`Sentinel QC listening on http://localhost:${config.port} (db: ${config.dbPath})`);
  if (config.webDist) console.log(`serving web app from ${config.webDist}`);
  else console.log('web app not built yet — API only (run: pnpm build)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
