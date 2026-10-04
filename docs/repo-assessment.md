# Repository Assessment (P0)

Date: 2026-08-22

## What exists

Nothing. The repository was an empty directory (`/Users/tanmaygoswami/Desktop/qctool`) with no
prior source, no git history, no configuration, and no data. `git init` was performed as the
first act of this implementation.

## What is reusable

Not applicable — greenfield build.

## Technical debt

None inherited. Debt introduced by this build is tracked in `docs/implementation-plan.md`
under "Known deviations and debt".

## Environment findings

| Item | Found | Consequence |
|---|---|---|
| Node | v24.11.1 | Modern runtime; better-sqlite3 v12+ required for ABI compatibility |
| pnpm | not on PATH; corepack cannot symlink into `/usr/local/bin` (EACCES) | invoke as `corepack pnpm` (pinned via `packageManager` field); documented in README |
| Python 3 | 3.9.6 with numpy 2.0.2, scipy 1.13.1 | sufficient for the reference oracle (`tools/reference`) |
| CPU | arm64 (Apple Silicon) | native-module prebuilds available for better-sqlite3 and argon2 |

## Decisions taken at P0

- Everything specified in the master prompt is built from scratch; there is nothing to migrate.
- The working name **Sentinel QC** is kept.
- Package manager is pinned with `"packageManager": "pnpm@9.15.9"` so `corepack pnpm` works
  without a global install.
