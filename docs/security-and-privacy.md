# Security & privacy

## Shared credentials, private workspaces

The shared sign-in is unchanged. Each successful login receives a new random,
server-side session and an independent workspace. Knowing the shared password does
not grant access to existing workspaces. Ownership is checked using the session ID,
not the shared user ID, on every API resource read and write.

Assays, observations, materials, lots, layouts, plates, monitoring, report lists,
downloads and lab names are private to that workspace. Related IDs must also belong
to the same assay. Global backups, audit history, user management and editing global
rule templates are unavailable through browser sessions, including admin sessions.
Built-in Westgard profiles remain read-only. Unowned legacy assays and reports are
not exposed or automatically assigned to new visitors.

Tabs within one browser profile share cookies and therefore share a session. Use
separate browser profiles or separate devices for different people. The interface
clears cached data on sign-out, expiry and session changes; stale tabs cannot submit
against a replacement session. No workspace token is stored in localStorage.

## Lifetime and retention

Sessions expire after 12 hours by default. Signing out, or signing in again in the
same browser, revokes the previous session immediately. Cleanup runs at startup,
on login/logout and every minute. It removes expired workspace settings, assays,
observations (including correction versions), layouts, plates, signals, models,
report rows and generated report files. Failed cleanup is retried while access stays
revoked. Download reports before signing out; copies already downloaded to a device
remain on that device.

The existing append-only audit chain is retained on the server and may contain
historical measurement values, corrections and names. It is not exposed through the
shared login. Old unowned data/reports and operator-created backups are retained for
local administration. SQLite deletion is not forensic secure erasure; data can remain
in free pages, WAL files and backups. This is session privacy, not a promise of zero
server-side retention.

## HTTP and authentication

Passwords use argon2id. Session tokens are 256-bit random values stored hashed in
SQLite. Cookies are HttpOnly, SameSite=Strict and Secure in the HTTPS deployment.
Re-login rotates the session and closes its old workspace.

All API mutations require `X-Sentinel-Request: 1`; browsers also undergo Origin and
Fetch Metadata checks. No cross-origin API access is enabled. The UI supplies
`X-Sentinel-Workspace` to catch stale-session requests. Login, ordinary API calls,
and expensive analysis/report requests have bounded in-process rate limits. Workspace
quotas bound large imports, analysis and report storage. Proxy headers are trusted
only from loopback; production uses Caddy on the same host.

API responses use `Cache-Control: no-store, private`. CSP, frame restrictions,
no-referrer, nosniff and permissions headers apply. Internal server and SQL errors
are not returned to browsers. CSV exports neutralize formula-like text cells. Report
files use private filesystem permissions. Production enables HSTS and restricts Node
to loopback behind HTTPS.

The request-origin and browser-cache measures follow the
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
and [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Deployment boundary

Use Node 24 LTS (see the [Node release schedule](https://github.com/nodejs/Release#release-schedule))
and HTTPS via the supplied Caddy deployment and set `SENTINEL_PUBLIC_ORIGIN` to the
exact public origin. Do not expose Node's port directly. The shared password allows
any holder to create their own workspace; it does not identify a person or protect
against someone using an already signed-in browser. Keep server access and backups
restricted. Rate limits are designed for one Node process; a multi-process deployment
needs shared limits at the reverse proxy.

The schema has no dedicated patient fields and plate imports require numeric data
cells. Free-text labels can still contain information users type; avoid identifiers.
This project makes no medical-device or regulatory-compliance claim.
