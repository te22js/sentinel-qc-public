/**
 * Batch QC entry: paste a historical run log in one go — values per level, optional
 * per-row dates (real bench dates, irregular intervals welcome) and per-row cutoffs
 * for E-ratio assays. Runs are created sequentially and evaluated in order.
 *
 * Limits philosophy: nothing is frozen here. When no baseline exists, the run log
 * evaluates every point against self-derived limits (mean/SD of the current runs),
 * exactly like the paper/PDF workflow labs already use; freezing a baseline in Admin
 * upgrades the assay to prospective QC at any time.
 */
import type Database from 'better-sqlite3';
import { getAssay, getScheme } from './context.js';
import { createRun, type CreateRunResult } from './runs.js';

export interface BatchEntryInput {
  assayId: string;
  userId: string;
  technician?: string | null;
  kitLot?: string | null;
  /** first run date (YYYY-MM-DD); consecutive rows advance one day (ignored when dates[] given) */
  startDate?: string;
  /** optional per-row dates (YYYY-MM-DD), oldest first, parallel to the value rows */
  dates?: string[];
  /** parallel arrays per level code; all levels must have the same length */
  valuesByLevel: Record<string, number[]>;
  /** per-row cutoffs for ratio_to_cutoff assays, parallel to the value rows */
  cutoffs?: number[];
}

export interface BatchEntryResult {
  ok: boolean;
  error?: string;
  created?: number;
  verdicts?: Record<string, number>;
  runs?: { runId: string; performedAt: string; verdict: string }[];
  firstError?: string;
}

export function batchEntry(sqlite: Database.Database, input: BatchEntryInput): BatchEntryResult {
  const assay = getAssay(sqlite, input.assayId);
  if (!assay || !assay.active) return { ok: false, error: 'assay not found or inactive' };
  const scheme = getScheme(assay);
  if (scheme.levels.some((l) => l.replicates > 1)) {
    return { ok: false, error: 'batch entry supports one observation per level per run; this assay uses replicates — enter runs singly' };
  }
  const levels = scheme.levels.map((l) => l.level_code);

  const lengths = new Set(levels.map((l) => (input.valuesByLevel[l] ?? []).length));
  if (lengths.size !== 1) {
    return { ok: false, error: 'every level must have the same number of values (align the rows)' };
  }
  const n = [...lengths][0];
  if (n === 0) return { ok: false, error: 'no values entered' };
  if (n > 400) return { ok: false, error: 'too many rows (max 400 per batch)' };
  for (const l of levels) {
    for (const v of input.valuesByLevel[l]) {
      if (!Number.isFinite(v)) return { ok: false, error: `level ${l} contains a non-numeric value` };
    }
  }
  const needsCutoff = assay.transform === 'ratio_to_cutoff';
  if (needsCutoff) {
    if (!input.cutoffs || input.cutoffs.length !== n) {
      return { ok: false, error: `this assay needs a cutoff per run — paste ${n} cutoff values alongside` };
    }
    for (const c of input.cutoffs) {
      if (!(Number.isFinite(c) && c > 0)) return { ok: false, error: 'cutoffs must be positive numbers' };
    }
  }

  // dates: explicit per-row dates > startDate + i days > ending today
  let dates: string[];
  if (input.dates && input.dates.length > 0) {
    if (input.dates.length !== n) return { ok: false, error: `dates column has ${input.dates.length} rows but values have ${n}` };
    for (const d of input.dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: `unparseable date "${d}" (use YYYY-MM-DD)` };
    }
    dates = input.dates.map((d) => `${d}T09:00:00Z`);
  } else {
    const today = new Date();
    const start = input.startDate
      ? new Date(`${input.startDate}T09:00:00Z`)
      : new Date(today.getTime() - (n - 1) * 86400_000);
    dates = Array.from({ length: n }, (_, i) => {
      const d = new Date(start.getTime() + i * 86400_000);
      return `${d.toISOString().slice(0, 10)}T09:00:00Z`;
    });
  }
  // evaluate chronologically even if pasted newest-first
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (dates[a] < dates[b] ? -1 : 1));

  const verdicts: Record<string, number> = { pass: 0, warning: 0, reject: 0 };
  const runs: { runId: string; performedAt: string; verdict: string }[] = [];
  let firstError: string | undefined;
  let createdCount = 0;
  for (const i of order) {
    const values: Record<string, number[]> = {};
    for (const l of levels) values[l] = [input.valuesByLevel[l][i]];
    const res: CreateRunResult = createRun(sqlite, {
      assayId: input.assayId,
      operatorUserId: input.userId,
      performedAt: dates[i],
      values,
      cutoff: needsCutoff ? input.cutoffs![i] : undefined,
      technician: input.technician,
      kitLot: input.kitLot,
    });
    if (res.ok) {
      createdCount++;
      verdicts[res.verdict!]++;
      runs.push({ runId: res.runId!, performedAt: dates[i], verdict: res.verdict! });
    } else if (!firstError) {
      firstError = res.error;
    }
  }
  return { ok: true, created: createdCount, verdicts, runs, firstError };
}
