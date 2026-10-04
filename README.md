# Sentinel QC — public deployment source

Sanitized deployment source for the laboratory QC application. No private Git
history, login password, local database, recorded walkthrough, or sample exports
are included. Provide `SENTINEL_ADMIN_PASSWORD` privately in the hosting settings.
The username defaults to `labqc`.

Use the root `render.yaml` to deploy one free Node 24 service. See
[Render setup and custom domains](deploy/RENDER.md). Free hosting loses temporary
data on sleep/restart; download reports promptly.

Build: `corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build`.
Start: set `SENTINEL_ADMIN_PASSWORD` in your environment, then `node dist/server.js`.
