/** Assemble the single runnable dist/: server.js (built by esbuild) + public/ (web build). */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDist = join(root, 'apps', 'web', 'dist');
const out = join(root, 'dist', 'public');

if (!existsSync(join(root, 'dist', 'server.js'))) {
  console.error('dist/server.js missing — server build failed?');
  process.exit(1);
}
if (!existsSync(webDist)) {
  console.error('apps/web/dist missing — web build failed?');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
cpSync(webDist, out, { recursive: true });
// the bundled db layer loads migrations relative to dist/server.js
cpSync(join(root, 'packages', 'db', 'migrations'), join(root, 'dist', 'migrations'), {
  recursive: true,
});
writeFileSync(join(root, 'dist', 'package.json'), '{"type":"module"}\n');
console.log('dist/ assembled: node dist/server.js serves app + API on :8080');
