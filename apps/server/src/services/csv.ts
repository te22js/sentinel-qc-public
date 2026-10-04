/**
 * CSV import (with dry-run validation preview) and history export.
 * The importer maps user-chosen columns onto {performedAt, level, value, operator?,
 * instrument?, lot?}, validates every row, and on commit groups rows by timestamp
 * into runs, evaluating Westgard rules in chronological order.
 */
import type Database from 'better-sqlite3';
import { createRun } from './runs.js';
import { getAssay, getScheme } from './context.js';

/** Minimal CSV parser handling quoted fields and both separators. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  const sep = content.includes('\t') && !content.split('\n')[0]?.includes(',') ? '\t' : ',';
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export interface ImportMapping {
  performedAt: string;
  level: string;
  value: string;
  operator?: string;
  instrument?: string;
  lot?: string;
}

export interface RowValidation {
  rowIndex: number;
  status: 'ok' | 'warning' | 'error';
  messages: string[];
  parsed?: { performedAt: string; level: string; value: number };
}

export interface ImportPreview {
  ok: boolean;
  error?: string;
  header?: string[];
  rows?: RowValidation[];
  runsToCreate?: number;
}

function parseTimestamp(s: string): string | null {
  const t = s.trim();
  // accepted: ISO 8601, or YYYY-MM-DD [HH:MM[:SS]]
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2}(:\d{2})?)?/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2] ?? '00:00'}${m[2] && !m[3] ? ':00' : ''}${m[2] ? '' : ':00'}`;
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function validateImport(
  sqlite: Database.Database,
  assayId: string,
  content: string,
  mapping: ImportMapping,
): ImportPreview {
  const assay = getAssay(sqlite, assayId);
  if (!assay) return { ok: false, error: 'assay not found' };
  const scheme = getScheme(assay);
  const levelCodes = scheme.levels.map((l) => l.level_code);
  const table = parseCsv(content);
  if (table.length > 2401) return { ok: false, error: 'CSV imports are limited to 2400 observation rows.' };
  if (table.length < 2) return { ok: false, error: 'file has no data rows' };
  const header = table[0].map((h) => h.trim());
  const col = (name: string | undefined) => (name ? header.indexOf(name) : -1);
  const iTime = col(mapping.performedAt);
  const iLevel = col(mapping.level);
  const iValue = col(mapping.value);
  if (iTime < 0 || iLevel < 0 || iValue < 0) {
    return { ok: false, error: 'mapping refers to columns not present in the header' };
  }
  const now = new Date().toISOString();
  const rows: RowValidation[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const messages: string[] = [];
    let status: RowValidation['status'] = 'ok';
    const ts = parseTimestamp(cells[iTime] ?? '');
    const level = (cells[iLevel] ?? '').trim();
    const rawStr = (cells[iValue] ?? '').trim();
    const value = Number(rawStr);
    if (!ts) {
      messages.push(`unparseable timestamp "${cells[iTime] ?? ''}"`);
      status = 'error';
    } else if (ts > now) {
      messages.push('timestamp is in the future');
      status = 'warning';
    }
    if (!levelCodes.includes(level)) {
      messages.push(`unknown level "${level}" (assay has: ${levelCodes.join(', ')})`);
      status = 'error';
    }
    if (rawStr === '' || !Number.isFinite(value)) {
      messages.push(`non-numeric value "${rawStr}"`);
      status = 'error';
    } else if (value < 0) {
      messages.push('negative value');
      if (status === 'ok') status = 'warning';
    } else if (assay.reader_max !== null && value > assay.reader_max) {
      messages.push(`above reader maximum (${assay.reader_max})`);
      if (status === 'ok') status = 'warning';
    }
    const key = `${ts}|${level}|${value}`;
    if (ts && seen.has(key)) {
      messages.push('duplicate row in file');
      if (status === 'ok') status = 'warning';
    }
    seen.add(key);
    rows.push({
      rowIndex: r,
      status,
      messages,
      parsed: ts && status !== 'error' ? { performedAt: ts, level, value } : undefined,
    });
  }
  const timestamps = new Set(rows.filter((r) => r.parsed).map((r) => r.parsed!.performedAt));
  return { ok: true, header, rows, runsToCreate: timestamps.size };
}

export function commitImport(
  sqlite: Database.Database,
  assayId: string,
  content: string,
  mapping: ImportMapping,
  userId: string,
): { ok: boolean; error?: string; created?: number; skipped?: number; verdicts?: Record<string, number> } {
  const preview = validateImport(sqlite, assayId, content, mapping);
  if (!preview.ok) return { ok: false, error: preview.error };
  const good = preview.rows!.filter((r) => r.parsed);
  // group by timestamp → runs
  const byTime = new Map<string, { level: string; value: number }[]>();
  for (const r of good) {
    const list = byTime.get(r.parsed!.performedAt) ?? [];
    list.push({ level: r.parsed!.level, value: r.parsed!.value });
    byTime.set(r.parsed!.performedAt, list);
  }
  const times = Array.from(byTime.keys()).sort();
  // no baseline is frozen here: when none exists, the run log evaluates the imported
  // series against self-derived limits (mean/SD of the current runs)
  let created = 0;
  let skipped = 0;
  const verdicts: Record<string, number> = { pass: 0, warning: 0, reject: 0 };
  for (const t of times) {
    const values: Record<string, number[]> = {};
    for (const { level, value } of byTime.get(t)!) {
      (values[level] ??= []).push(value);
    }
    const res = createRun(sqlite, { assayId, operatorUserId: userId, performedAt: t, values });
    if (res.ok) {
      created++;
      verdicts[res.verdict!]++;
    } else {
      skipped++;
    }
  }
  return { ok: true, created, skipped: skipped + (preview.rows!.length - good.length), verdicts };
}

export function exportHistoryCsv(sqlite: Database.Database, assayId: string): string {
  const rows = sqlite
    .prepare(
      `SELECT r.performed_at, m.level_code, o.replicate_index, o.raw_value, o.transformed_value, o.z,
              r.verdict, u.username as operator, i.label as instrument, rl.lot as reagent_lot, m.lot as control_lot
       FROM observation o
       JOIN run r ON r.id = o.run_id
       JOIN qc_material m ON m.id = o.qc_material_id
       JOIN user u ON u.id = r.operator_user_id
       LEFT JOIN instrument i ON i.id = r.instrument_id
       LEFT JOIN reagent_lot rl ON rl.id = r.reagent_lot_id
       WHERE r.assay_id = ? AND o.superseded = 0
       ORDER BY r.performed_at ASC, m.level_code, o.replicate_index`,
    )
    .all(assayId) as Record<string, unknown>[];
  const header = 'performed_at,level,replicate,raw_value,transformed_value,z,verdict,operator,instrument,reagent_lot,control_lot';
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    header,
    ...rows.map((r) =>
      [r.performed_at, r.level_code, r.replicate_index, r.raw_value, r.transformed_value, r.z, r.verdict, r.operator, r.instrument, r.reagent_lot, r.control_lot]
        .map(esc)
        .join(','),
    ),
  ].join('\n');
}
