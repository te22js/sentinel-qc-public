# Deployment

## Requirements

Node 24 LTS on the host (Windows, macOS or Linux). ~200 MB disk. No internet access
needed after installation.

## Single workstation or LAN server

```bash
pnpm install && pnpm build
SENTINEL_ADMIN_PASSWORD='choose-a-strong-one' node dist/server.js
```

The app listens on `127.0.0.1:8080` by default (`SENTINEL_PORT`/`SENTINEL_HOST` to change);
For LAN-only access, explicitly set `SENTINEL_HOST=0.0.0.0`; for publishing, use the
HTTPS reverse proxy in `deploy/HOSTINGER.md`. Data lives in `./data/sentinel.sqlite`
(`SENTINEL_DATA_DIR` / `SENTINEL_DB` to relocate). Run it under your OS's service
manager (systemd unit, launchd plist, or NSSM on Windows) restarting on failure.

## Backups

The database is one SQLite file in WAL mode.

- Nightly job: `sqlite3 data/sentinel.sqlite "PRAGMA wal_checkpoint(TRUNCATE)"` then
  copy `sentinel.sqlite` to backup storage (or simply copy all three
  `sentinel.sqlite*` files while the server is idle).
- Browser sessions cannot export the whole database. Backups require local server access.
- Restore: stop the server, replace the file, start the server. Then run
  `pnpm verify-audit` to confirm the audit chain is intact.

## HTTPS on the LAN

Terminate TLS in front of the app with any reverse proxy. Example with Caddy
(self-signed internal CA, two lines):

```
qc.lab.internal {
  tls internal
  reverse_proxy 127.0.0.1:8080
}
```

Set `SENTINEL_SECURE_COOKIES=1` and `SENTINEL_PUBLIC_ORIGIN=https://qc.lab.internal`.
The session cookie is HttpOnly/SameSite=Strict; behind TLS you get transport secrecy
on the LAN. Do not expose the port to the internet — the product is designed for
LAN use only.

## Upgrades

Stop the server, `git pull && pnpm install && pnpm build`, start the server.
Migrations apply automatically and are tracked in `_migrations`; take a backup
first.
