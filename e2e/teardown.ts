import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export default function teardown() {
  const path = process.env.SENTINEL_E2E_DATA_DIR;
  if (path && dirname(resolve(path)) === resolve(tmpdir()) && basename(path).startsWith('sentinel-e2e-')) {
    rmSync(path, { recursive: true, force: true });
  }
}
