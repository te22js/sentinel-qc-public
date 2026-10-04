# Implementation Plan — Sentinel QC

Kept current as phases complete. ✔ = done, ▶ = in progress, ○ = not started.

## Phases

- ✔ **P0** Repo assessment + this plan.
- ✔ **P1** Monorepo scaffold; `packages/db` schema/migrations; audit hash chain; auth foundation.
- ✔ **P2** `packages/stats`: RNG, distributions, descriptive/robust, baseline, Westgard engine;
  `tools/reference` Python oracle generating `fixtures/*.json`; fixture tests at 1e-9.
- ✔ **P3** `apps/server`: Fastify REST `/api/v1`, argon2 + cookie sessions, CSV import (dry-run)
  and export. 25 API integration tests.
- ✔ **P4** `apps/web`: shell + left rail, Today, New Run with verdict, History, LJ chart.
- ✔ **P5** EWMA, CUSUM, variance EWMA, PELT, lot transition (stats + Monitoring UI).
- ✔ **P6** Median polish, PSAD, plate import + layout editor, Plates UI.
- ✔ **P7** Phase-II MSPC on plate effect vectors; `pnpm experiments` writing `docs/validation.md`
  (full-size run: 2000-plate null study, power curves, ablations, Phase-II calibration).
- ✔ **P8** Reports (daily, monthly, plate) as print-CSS HTML with server-rendered SVG; audited.
- ✔ **P9** Demo data (`tools/demo`, seeded PCG32) + demo mode banner/tour; demo story verified
  end-to-end through the API (rejection+override, EWMA drift, lot-transition bias, PSAD edge
  plate with Phase-II SPE signal, clean plate with zero findings).
- ✔ **P10** Polish: empty states, keyboard flow, error handling; Playwright e2e (3 flows) green
  against the production build; stats coverage 94%.
- ✔ **P11** Documentation set (README, architecture, statistics, validation, user guide,
  deployment, security-and-privacy, research) + final review against the definition of done.

## Architecture (fixed by spec)

pnpm monorepo, TypeScript strict, Node 20+ (found: 24).

```
packages/stats    pure TS, zero runtime deps — all mathematics
packages/db       drizzle-orm + better-sqlite3, migrations, audit chain
packages/shared   zod DTOs shared by server and web
apps/server       fastify REST, auth, importers, report renderer, serves web build
apps/web          react 18 + vite + tailwind + tanstack router/query, hand-built SVG charts
tools/reference   python oracle (dev-only) → fixtures/*.json (committed)
tools/demo        seeded synthetic data generator + fault-plate CSVs
e2e               Playwright flows against dist/server.js
fixtures/         committed reference outputs
docs/             this file + architecture, statistics, validation, guides
```

## Key implementation decisions

- **pnpm via corepack** (`corepack pnpm …`) — the host denies global symlinks; root scripts
  invoke `corepack pnpm` explicitly.
- **iCloud mitigation**: the repo lives on an iCloud-synced Desktop, which evicted
  `node_modules` and stalled every build; `.npmrc` sets
  `virtual-store-dir=${HOME}/.cache/sentinel-qc-store` so heavy package content lives outside
  the synced tree. (For real work, keep clones outside iCloud.)
- **Sessions**: opaque random token in an httpOnly cookie, session rows in SQLite.
- **Server bundle**: esbuild → `dist/server.js` with native modules external (declared as root
  dependencies so Node resolves them from the repo's `node_modules`); web build → `dist/public`;
  migrations copied to `dist/migrations`.
- **Tailwind v3.4**, Inter + JetBrains Mono self-hosted (`@fontsource`), PostCSS config inlined
  into `vite.config.ts` (cosmiconfig's directory walk was flaky under iCloud).
- **Distributions**: Lanczos lgamma; incomplete gamma/beta; Wichura AS241; safeguarded Newton
  quantiles. |Δ| < 1e-9 vs SciPy fixtures.
- **Westgard engine** consumes an ordered run stream; the pooled across-run stream reproduces
  the published 6x-without-2of3_2s example. Strict inequalities at the 1/2/3 SD boundaries.
- **Monitoring series include rejected runs** (Westgard look-back excludes them; retrospective
  monitors must not, or a persistent shift hides its own evidence).
- **Variance-EWMA limits** Monte-Carlo calibrated (fixtures); **EWMA design constants
  corrected** to L=2.962/2.814 for ARL₀≈500 (the spec's cited 2.86/2.70 give ≈368).

## Known deviations and debt

- Report charts are dedicated server-side SVG generators mirroring the client components'
  visual language (no React SSR on the server).
- PDF export = browser print dialog (print CSS ships); headless-Chromium optional.
- `pnpm package` (single executable) not implemented; documented as optional follow-up.
- Phase-II SPE limit (Jackson–Mudholkar) is anti-conservative at lab-scale plate histories —
  measured and documented in `docs/validation.md`; SPE is presented as a screening hint.
- Experiments default to B=499 for the 2000-plate null study (B=999 elsewhere); recorded in
  `docs/validation.md`.
