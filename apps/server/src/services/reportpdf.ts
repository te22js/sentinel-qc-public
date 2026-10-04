import { workspaceLab } from '../workspace.js';
/**
 * Downloadable PDF reports, generated in-process (no browser, no native deps).
 *
 * Design language: editorial minimal — generous whitespace, hairlines instead of
 * boxes, letterspaced small caps for labels, tabular numerals for data, a single
 * accent for status. Two documents:
 *   - assayReportPdf: the QC report (status, KPIs, Levey–Jennings, limits, run log)
 *   - monitoringReportPdf: the advanced report (EWMA + CUSUM + variance + change
 *     points, one page, sentences first)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { appendAudit, ulid } from '@sentinel/db';
import { Pdf } from './pdf.js';
import { runLog, type RunLogResult } from './runlog.js';
import { ewmaTab, cusumTab, varianceTab, changePointTab } from './monitoring.js';

// palette
type RGB = [number, number, number];
const INK: RGB = [0.07, 0.09, 0.15];
const GRAY: RGB = [0.42, 0.47, 0.55];
const FAINT: RGB = [0.63, 0.68, 0.75];
const HAIR: RGB = [0.88, 0.9, 0.93];
const BLUE: RGB = [0.13, 0.3, 0.75];
const GREEN: RGB = [0.05, 0.55, 0.26];
const RED: RGB = [0.8, 0.11, 0.14];
const AMBER: RGB = [0.78, 0.42, 0.02];
const VIOLET: RGB = [0.42, 0.24, 0.72];

const M = 46; // page margin
const PW = 595.28;
const PH = 841.89;
const W = PW - 2 * M;

const RULE_LEGEND: [string, string][] = [
  ['1_2s', 'one control beyond +/-2SD (warning)'],
  ['1_3s', 'beyond +/-3SD (random error)'],
  ['2_2s', 'two consecutive beyond the same +/-2SD limit (systematic error)'],
  ['R_4s', 'opposite sides beyond +/-2SD within a run'],
  ['2of3_2s', 'two of three beyond the same +/-2SD limit'],
  ['3_1s', 'three consecutive beyond +/-1SD on the same side'],
  ['4_1s', 'four consecutive beyond +/-1SD on the same side'],
  ['6x', 'six consecutive on one side of the mean'],
  ['8x', 'eight consecutive on one side of the mean'],
  ['9x', 'nine consecutive on one side of the mean'],
  ['10x', 'ten consecutive on one side of the mean'],
  ['12x', 'twelve consecutive on one side of the mean'],
  ['7T', 'seven strictly trending'],
];

/** Draw a Westgard rule id with a true subscript (1_2s -> 1 with small lowered 2s). Returns width. */
function drawRule(pdf: Pdf, x: number, y: number, rule: string, size: number, color: RGB): number {
  let base = rule;
  let sub = '';
  const kx = rule.match(/^(\d+)x$/);
  const ms = rule.match(/^(.+)_(\d+)s$/);
  if (kx) {
    base = kx[1];
    sub = 'x';
  } else if (ms) {
    base = ms[1];
    sub = `${ms[2]}s`;
  }
  pdf.text(x, y, base, { font: 'helvB', size, color });
  const bw = pdf.measure(base, 'helvB', size);
  if (sub) {
    pdf.text(x + bw + 0.3, y + size * 0.32, sub, { font: 'helvB', size: size * 0.66, color });
    return bw + 0.3 + pdf.measure(sub, 'helvB', size * 0.66);
  }
  return bw;
}

interface SavedReport {
  id: string;
  filePath: string;
  filename: string;
}

function saveReportPdf(
  sqlite: Database.Database,
  dataDir: string,
  kind: string,
  filenameBase: string,
  params: Record<string, unknown>,
  pdf: Pdf,
  userId: string,
  workspaceId: string,
): SavedReport {
  const dir = join(dataDir, 'reports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = ulid();
  const filename = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.pdf`;
  const filePath = join(dir, `${kind}-${id}.pdf`);
  writeFileSync(filePath, Uint8Array.from(pdf.toBuffer()), { mode: 0o600 });
  sqlite
    .prepare('INSERT INTO report (id, kind, params_json, generated_at, generated_by, file_path, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, JSON.stringify({ ...params, filename }), new Date().toISOString(), userId, filePath, workspaceId);
  appendAudit(sqlite, { userId, entity: 'report', entityId: id, action: 'generate_report', after: { kind, ...params } });
  return { id, filePath, filename };
}

function labNameOf(sqlite: Database.Database, workspaceId: string): string {
  const lab = workspaceLab(sqlite, workspaceId);
  return lab?.name && lab.name !== 'Sentinel QC Laboratory' ? lab.name : 'Laboratory';
}

/** Letterhead: kicker · lab name · context line · status word — all type, one hairline. */
function letterhead(
  pdf: Pdf,
  kicker: string,
  labName: string,
  contextLine: string,
  status: { word: string; color: RGB; note: string } | null,
): number {
  let y = M;
  pdf.text(M, y, kicker.toUpperCase(), { font: 'helvB', size: 7, color: FAINT, charSpace: 1.6 });
  if (status) {
    pdf.text(M + W, y - 1, status.word, { font: 'helvB', size: 10.5, color: status.color, align: 'right' });
    pdf.text(M + W, y + 13, status.note, { size: 7.5, color: GRAY, align: 'right' });
  }
  y += 15;
  pdf.text(M, y, labName, { font: 'helvB', size: 21 });
  y += 30;
  pdf.text(M, y, contextLine, { size: 9.5, color: GRAY });
  y += 18;
  pdf.line(M, y, M + W, y, { color: INK, width: 1.1 });
  return y + 16;
}

function sectionLabel(pdf: Pdf, y: number, label: string): number {
  pdf.text(M, y, label.toUpperCase(), { font: 'helvB', size: 7, color: FAINT, charSpace: 1.4 });
  return y + 15;
}

function footerAll(pdf: Pdf, docName: string): void {
  const total = pdf.pageCount;
  for (let i = 0; i < total; i++) {
    pdf.setPage(i);
    pdf.line(M, PH - 34, M + W, PH - 34, { color: HAIR, width: 0.6 });
    pdf.text(M, PH - 29, `Sentinel QC - ${docName}`, { size: 6.5, color: FAINT });
    pdf.text(M + W, PH - 29, total > 1 ? `${i + 1} / ${total}` : new Date().toISOString().slice(0, 10), {
      font: 'mono',
      size: 6.5,
      color: FAINT,
      align: 'right',
    });
  }
}

function ensureRoom(pdf: Pdf, y: number, needed: number): number {
  if (y + needed > PH - 48) {
    pdf.addPage();
    return M;
  }
  return y;
}

function wrap(pdf: Pdf, text: string, x: number, y: number, maxW: number, size: number, color: RGB, lineGap = 3.2): number {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (pdf.measure(candidate, 'helv', size) > maxW && line) {
      pdf.text(x, yy, line, { size, color });
      yy += size + lineGap;
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) {
    pdf.text(x, yy, line, { size, color });
    yy += size + lineGap;
  }
  return yy;
}

// ===========================================================================
// main QC report
// ===========================================================================

export function assayReportPdf(
  sqlite: Database.Database,
  dataDir: string,
  assayId: string,
  userId: string,
  workspaceId: string,
  from?: string,
  to?: string,
): SavedReport | null {
  const user = sqlite.prepare('SELECT display_name FROM user WHERE id = ?').get(userId) as { display_name: string };
  const assay = sqlite.prepare('SELECT * FROM assay WHERE id = ?').get(assayId) as Record<string, unknown> | undefined;
  if (!assay) return null;
  const scheme = JSON.parse(assay.qc_scheme_json as string) as { levels: { level_code: string }[] };
  const logs = scheme.levels
    .map((lvl) => runLog(sqlite, assayId, lvl.level_code, from, to))
    .filter((l): l is RunLogResult & { ok: true } => l.ok && (l.rows?.length ?? 0) > 0);

  const allRows = logs.flatMap((l) => l.rows ?? []);
  const dates = allRows.map((r) => r.performedAt.slice(0, 10)).sort();
  const period =
    from || to
      ? `${from ? from.slice(0, 10) : 'start'} to ${to ? to.slice(0, 10) : 'today'}`
      : dates.length > 0
        ? `${dates[0]} to ${dates[dates.length - 1]}`
        : '-';
  const inControl = logs.every((l) => l.status!.inControl);
  const totalRejects = logs.reduce((a, l) => a + l.status!.rejects, 0);
  const totalWarnings = logs.reduce((a, l) => a + l.status!.warnings, 0);
  const statusNote = inControl
    ? totalWarnings === 0
      ? 'No rule violations detected'
      : `${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}, no rejection rule fired`
    : `${totalRejects} run${totalRejects === 1 ? '' : 's'} violate${totalRejects === 1 ? 's' : ''} rejection rules`;

  const subParts = [assay.name, assay.methodology, scheme.levels.length === 1 ? scheme.levels[0].level_code : '']
    .map((v) => String(v ?? '').trim())
    .filter((v) => v !== '');

  const pdf = new Pdf();
  let y = letterhead(pdf, 'Quality Control Report', labNameOf(sqlite, workspaceId), `${subParts.join('  ·  ')}    ·    ${period}`, {
    word: inControl ? 'IN CONTROL' : 'OUT OF CONTROL',
    color: inControl ? GREEN : RED,
    note: statusNote,
  });

  for (const log of logs) {
    const lim = log.limits;
    const st = log.stats!;
    const isRatio = log.valueLabel === 'E-ratio';
    if (logs.length > 1) {
      y = ensureRoom(pdf, y, 340);
      y = sectionLabel(pdf, y, `Level ${log.levelCode}`);
    }

    // ------------------------------------------------- KPI band (no boxes)
    y = ensureRoom(pdf, y, 320);
    const kpis: [string, string][] = [
      ['Runs', String(st.n)],
      [`Mean ${log.valueLabel}`, st.mean !== null ? st.mean.toFixed(3) : '-'],
      ['SD', st.sd !== null ? st.sd.toFixed(3) : '-'],
      ['CV', st.cv !== null ? `${st.cv.toFixed(2)}%` : '-'],
    ];
    const colW = W / 4;
    kpis.forEach(([label, value], i) => {
      const x = M + i * colW;
      if (i > 0) pdf.line(x, y + 2, x, y + 30, { color: HAIR, width: 0.6 });
      const xx = x + (i > 0 ? 14 : 0);
      pdf.text(xx, y, label.toUpperCase(), { font: 'helvB', size: 6.5, color: FAINT, charSpace: 1.1 });
      pdf.text(xx, y + 11, value, { font: 'monoB', size: 15 });
    });
    y += 44;

    // --------------------------------------------------------------- chart
    y = ensureRoom(pdf, y, 230);
    y = sectionLabel(pdf, y, 'Levey-Jennings');
    y = drawLjChart(pdf, log, y) + 14;

    // -------------------------------------------------------------- limits
    if (lim) {
      y = ensureRoom(pdf, y, 78);
      y = sectionLabel(pdf, y, 'Control limits');
      const src =
        lim.source === 'self'
          ? `Mean and SD from the current ${lim.n} runs${lim.scale === 'log' ? ', computed on the log scale (geometric bands, correct for ratio data)' : ''}; leave-one-out standardization${(lim.excluded ?? 0) > 0 ? `; ${lim.excluded} gross outlier${lim.excluded === 1 ? '' : 's'} excluded from the estimate (still flagged)` : ''}${lim.provisional ? '; PROVISIONAL - rule flags start at 6 runs' : ''}.`
          : `Frozen laboratory baseline (${lim.baselineMethod ?? ''}${lim.n ? `, n=${lim.n}` : ''}).`;
      pdf.text(M, y - 3, src, { size: 8, color: GRAY });
      y += 12;
      const bands: [string, number][] = [
        ['+3SD', lim.bands.p3],
        ['+2SD', lim.bands.p2],
        ['+1SD', lim.bands.p1],
        ['MEAN', lim.bands.mean],
        ['-1SD', lim.bands.m1],
        ['-2SD', lim.bands.m2],
        ['-3SD', lim.bands.m3],
      ];
      pdf.line(M, y, M + W, y, { color: HAIR, width: 0.6 });
      y += 7;
      const bw = W / 7;
      bands.forEach(([label, v], i) => {
        const cx = M + i * bw + bw / 2;
        const mean = label === 'MEAN';
        pdf.text(cx, y, label, { font: 'helvB', size: 6.5, color: mean ? INK : FAINT, charSpace: 0.8, align: 'center' });
        pdf.text(cx, y + 11, v.toFixed(3), { font: mean ? 'monoB' : 'mono', size: 9.5, color: mean ? INK : GRAY, align: 'center' });
      });
      y += 27;
      pdf.line(M, y, M + W, y, { color: HAIR, width: 0.6 });
      y += 18;
    }

    // ------------------------------------------------------------- run log
    y = ensureRoom(pdf, y, 90);
    y = sectionLabel(pdf, y, 'Run log');
    y = drawRunLog(pdf, log, y, isRatio) + 8;
  }

  if (logs.length === 0) {
    pdf.text(M, y, 'No runs in the selected period.', { size: 10, color: GRAY });
    y += 20;
  }

  // ------------------------------------------------------------- legend
  const fired = new Set(allRows.flatMap((r) => r.flags));
  const legend = RULE_LEGEND.filter(([r]) =>
    fired.size === 0 ? ['1_2s', '1_3s', '2_2s', 'R_4s', '4_1s', '10x'].includes(r) : fired.has(r) || ['1_2s', '1_3s'].includes(r),
  );
  y = ensureRoom(pdf, y, 24 + legend.length * 10);
  pdf.text(M, y, 'WESTGARD RULES', { font: 'helvB', size: 6.2, color: FAINT, charSpace: 1.1 });
  y += 11;
  for (const [r, d] of legend) {
    y = ensureRoom(pdf, y, 12);
    const w = drawRule(pdf, M, y, r, 7.2, GRAY);
    pdf.text(M + Math.max(w, 26) + 6, y, d, { size: 7, color: FAINT });
    y += 10;
  }
  y += 8;

  // ------------------------------------------------------------ sign-off
  y = ensureRoom(pdf, y, 64);
  pdf.line(M, y, M + W, y, { color: INK, width: 1.1 });
  y += 10;
  const signW = W / 3;
  pdf.text(M, y, 'PREPARED BY', { font: 'helvB', size: 6.5, color: FAINT, charSpace: 1.1 });
  pdf.text(M, y + 11, user.display_name, { font: 'helvB', size: 10.5 });
  pdf.text(M + signW, y, 'GENERATED ON', { font: 'helvB', size: 6.5, color: FAINT, charSpace: 1.1 });
  pdf.text(M + signW, y + 11, new Date().toISOString().slice(0, 10), { font: 'monoB', size: 10.5 });
  pdf.text(M + 2 * signW, y, 'SIGNATURE', { font: 'helvB', size: 6.5, color: FAINT, charSpace: 1.1 });
  pdf.line(M + 2 * signW, y + 22, M + W, y + 22, { color: GRAY, width: 0.8 });

  footerAll(pdf, 'QC Report');
  return saveReportPdf(
    sqlite,
    dataDir,
    'assay',
    `QC-Report-${String(assay.name).replace(/[^A-Za-z0-9]+/g, '-')}`,
    { assayId, from, to },
    pdf,
    userId,
    workspaceId,
  );
}

// ---------------------------------------------------------- LJ chart (minimal)

function drawLjChart(pdf: Pdf, log: RunLogResult, y: number): number {
  const H = 178;
  const padL = 34;
  const padR = 52;
  const padT = 8;
  const padB = 22;
  const plotX = M + padL;
  const plotW = W - padL - padR;
  const plotY = y + padT;
  const plotH = H - padT - padB;
  const midY = plotY + plotH / 2;
  const zToY = (z: number) => midY - (Math.max(-3.5, Math.min(3.5, z)) / 3.5) * (plotH / 2);

  const bands = log.limits?.bands;
  const bandValue = (z: number) =>
    bands ? [bands.p3, bands.p2, bands.p1, bands.mean, bands.m1, bands.m2, bands.m3][3 - z] : null;
  // band lines: mean solid ink; ±1 whisper; ±2 faint; ±3 red hairline
  const defs: [number, RGB, number, [number, number] | null][] = [
    [3, RED, 0.6, [1.5, 2.5]],
    [2, FAINT, 0.6, [1.5, 2.5]],
    [1, HAIR, 0.6, null],
    [0, INK, 0.9, null],
    [-1, HAIR, 0.6, null],
    [-2, FAINT, 0.6, [1.5, 2.5]],
    [-3, RED, 0.6, [1.5, 2.5]],
  ];
  for (const [z, color, width, dash] of defs) {
    const yy = zToY(z);
    pdf.line(plotX, yy, plotX + plotW, yy, { color, width, dash });
    pdf.text(plotX - 6, yy - 3.5, z === 0 ? 'x' : `${z > 0 ? '+' : ''}${z}`, { font: 'mono', size: 6.5, color: FAINT, align: 'right' });
    const v = bandValue(z);
    if (v !== null) {
      pdf.text(plotX + plotW + 7, yy - 3.5, v.toFixed(3), { font: z === 0 ? 'monoB' : 'mono', size: 6.5, color: z === 0 ? INK : GRAY });
    }
  }

  const series = log.series ?? [];
  const n = series.length;
  const xFor = (i: number) => plotX + 6 + (n <= 1 ? (plotW - 12) / 2 : (i / (n - 1)) * (plotW - 12));
  for (let i = 1; i < n; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (a.z === null || b.z === null) continue;
    pdf.line(xFor(i - 1), zToY(a.z), xFor(i), zToY(b.z), { color: BLUE, width: 1.0 });
  }
  series.forEach((p, i) => {
    if (p.z === null) return;
    const violated = p.flags.some((f) => f !== '1_2s');
    if (violated) {
      pdf.circle(xFor(i), zToY(p.z), 2.8, { stroke: RED, lineWidth: 1.2 });
    } else {
      pdf.circle(xFor(i), zToY(p.z), 1.9, { fill: [1, 1, 1], stroke: BLUE, lineWidth: 0.9 });
    }
  });
  // x axis: first/last dates + run ticks
  pdf.line(plotX, plotY + plotH + 4, plotX + plotW, plotY + plotH + 4, { color: HAIR, width: 0.6 });
  if (n > 0) {
    pdf.text(plotX, plotY + plotH + 9, series[0].performedAt.slice(0, 10), { font: 'mono', size: 6.5, color: FAINT });
    pdf.text(plotX + plotW, plotY + plotH + 9, series[n - 1].performedAt.slice(0, 10), {
      font: 'mono',
      size: 6.5,
      color: FAINT,
      align: 'right',
    });
    pdf.text(plotX + plotW / 2, plotY + plotH + 9, `${n} runs`, { font: 'mono', size: 6.5, color: FAINT, align: 'center' });
  }
  return y + H;
}

// ------------------------------------------------------------------ run log

function drawRunLog(pdf: Pdf, log: RunLogResult, y: number, isRatio: boolean): number {
  const cols: [string, number, 'left' | 'right'][] = isRatio
    ? [
        ['#', 22, 'left'],
        ['DATE', 64, 'left'],
        ['TECHNICIAN', 100, 'left'],
        ['KIT LOT', 78, 'left'],
        ['IQC OD', 50, 'right'],
        ['CUTOFF', 50, 'right'],
        ['E-RATIO', 52, 'right'],
        ['FLAGS', 87, 'left'],
      ]
    : [
        ['#', 22, 'left'],
        ['DATE', 68, 'left'],
        ['TECHNICIAN', 112, 'left'],
        ['KIT LOT', 86, 'left'],
        ['VALUE', 58, 'right'],
        ['Z', 44, 'right'],
        ['FLAGS', 113, 'left'],
      ];
  const colX: number[] = [];
  let acc = M;
  for (const [, w] of cols) {
    colX.push(acc);
    acc += w;
  }

  const header = () => {
    cols.forEach(([label, w, align], i) => {
      const hx = i === cols.length - 1 ? colX[i] + 12 : colX[i];
      pdf.text(align === 'right' ? colX[i] + w - 2 : hx, y, label, {
        font: 'helvB',
        size: 6.2,
        color: FAINT,
        charSpace: 0.9,
        align: align === 'right' ? 'right' : 'left',
      });
    });
    y += 11;
    pdf.line(M, y, M + W, y, { color: INK, width: 0.8 });
    y += 4.5;
  };
  header();

  const rowH = 15;
  log.rows!.forEach((r) => {
    if (y + rowH > PH - 50) {
      pdf.addPage();
      y = M;
      header();
    }
    const cells: [string, 'mono' | 'monoB' | 'helv', RGB][] = isRatio
      ? [
          [String(r.runNo), 'mono', FAINT],
          [r.performedAt.slice(0, 10), 'mono', INK],
          [r.technician ?? '-', 'helv', INK],
          [r.kitLot ?? '-', 'mono', GRAY],
          [r.raw.toFixed(3), 'mono', INK],
          [r.cutoff !== null ? r.cutoff.toFixed(3) : '-', 'mono', GRAY],
          [r.value.toFixed(3), 'monoB', INK],
        ]
      : [
          [String(r.runNo), 'mono', FAINT],
          [r.performedAt.slice(0, 10), 'mono', INK],
          [r.technician ?? '-', 'helv', INK],
          [r.kitLot ?? '-', 'mono', GRAY],
          [r.raw.toFixed(3), 'mono', INK],
          [r.z !== null ? (r.z >= 0 ? '+' : '') + r.z.toFixed(2) : '-', 'mono', GRAY],
        ];
    cells.forEach(([value, font, color], i) => {
      const [, w, align] = cols[i];
      let text = value;
      while (pdf.measure(text, font, 7.8) > w - 8 && text.length > 2) text = text.slice(0, -2);
      pdf.text(align === 'right' ? colX[i] + w - 2 : colX[i], y, text, {
        font,
        size: 7.8,
        color,
        align: align === 'right' ? 'right' : 'left',
      });
    });
    const fi = cols.length - 1;
    let fx = colX[fi] + 12;
    if (r.flags.length === 0) {
      pdf.text(fx, y, 'OK', { font: 'helvB', size: 7.2, color: GREEN, charSpace: 0.4 });
    } else {
      for (const f of r.flags) {
        const c = f === '1_2s' ? AMBER : RED;
        fx += drawRule(pdf, fx, y, f, 7.6, c) + 5;
      }
      if (r.overrideStatus === 'accepted') pdf.text(fx, y, '(accepted)', { size: 6.8, color: FAINT });
    }
    y += rowH;
    pdf.line(M, y - 4.5, M + W, y - 4.5, { color: HAIR, width: 0.5 });
  });
  return y;
}

// ===========================================================================
// advanced monitoring report (EWMA / CUSUM / variance / change points)
// ===========================================================================

export function monitoringReportPdf(
  sqlite: Database.Database,
  dataDir: string,
  assayId: string,
  userId: string,
  workspaceId: string,
): SavedReport | null {
  const user = sqlite.prepare('SELECT display_name FROM user WHERE id = ?').get(userId) as { display_name: string };
  const assay = sqlite.prepare('SELECT * FROM assay WHERE id = ?').get(assayId) as Record<string, unknown> | undefined;
  if (!assay) return null;
  const scheme = JSON.parse(assay.qc_scheme_json as string) as { levels: { level_code: string }[] };
  // one section per level that has data
  const materials = sqlite
    .prepare('SELECT id, level_code FROM qc_material WHERE assay_id = ? ORDER BY level_code')
    .all(assayId) as { id: string; level_code: string }[];

  const pdf = new Pdf();
  let y = letterhead(
    pdf,
    'Advanced Monitoring Report',
    labNameOf(sqlite, workspaceId),
    `${String(assay.name)}    ·    EWMA drift  ·  CUSUM  ·  imprecision  ·  change points    ·    ${new Date().toISOString().slice(0, 10)}`,
    null,
  );

  let any = false;
  for (const m of materials) {
    const ew = ewmaTab(sqlite, assayId, m.id);
    if (ew.series.length < 2) continue;
    any = true;
    const cu = cusumTab(sqlite, assayId, m.id);
    const va = varianceTab(sqlite, assayId, m.id);
    const cp = changePointTab(sqlite, assayId, m.id);

    if (materials.length > 1 || scheme.levels.length > 1) {
      y = ensureRoom(pdf, y, 300);
      y = sectionLabel(pdf, y, `Level ${m.level_code}`);
    }

    // ------------------------------------------------ findings, sentences first
    y = ensureRoom(pdf, y, 110);
    y = sectionLabel(pdf, y, 'Findings');
    const signalDot = (fired: boolean) => (fired ? RED : GREEN);
    const rows: [string, boolean, string][] = [
      ['EWMA drift', ew.ewma.firstSignal !== null, ew.summary],
      ['CUSUM', cu.cusum.firstSignal !== null, cu.summary],
      ['Imprecision', va.variance.firstSignal !== null, va.summary],
      ['Change points', cp.changePoints.length > 0, cp.summary],
    ];
    for (const [name, fired, sentence] of rows) {
      pdf.circle(M + 3, y + 4, 2, { fill: signalDot(fired) });
      pdf.text(M + 12, y, name.toUpperCase(), { font: 'helvB', size: 6.8, color: GRAY, charSpace: 0.9 });
      y = wrap(pdf, sentence, M + 96, y, W - 96, 8.2, INK) + 4;
      y = ensureRoom(pdf, y, 40);
    }
    y += 6;

    // ------------------------------------------------------------ EWMA chart
    y = ensureRoom(pdf, y, 165);
    y = sectionLabel(pdf, y, 'EWMA of standardized runs');
    y = drawSeriesChart(pdf, y, 128, (draw) => {
      const pts = ew.ewma.points;
      const maxY = Math.max(1.1, ...pts.map((p) => Math.max(Math.abs(p.e), p.ucl))) * 1.12;
      draw.setDomain(-maxY, maxY, pts.length);
      draw.gridZero();
      draw.path(pts.map((p) => p.ucl), FAINT, 0.6, [1.5, 2.5]);
      draw.path(pts.map((p) => p.lcl), FAINT, 0.6, [1.5, 2.5]);
      draw.path(pts.map((p) => p.e), BLUE, 1.0);
      pts.forEach((p, i) => {
        if (p.signal) draw.ring(i, p.e, RED);
      });
      draw.rightLabel(pts[pts.length - 1]?.ucl ?? 0, 'UCL');
      draw.rightLabel(pts[pts.length - 1]?.lcl ?? 0, 'LCL');
    }) + 12;

    // ----------------------------------------------------------- CUSUM chart
    y = ensureRoom(pdf, y, 165);
    y = sectionLabel(pdf, y, 'CUSUM (k = 0.5, h = 5)');
    y = drawSeriesChart(pdf, y, 128, (draw) => {
      const pts = cu.cusum.points;
      const h = cu.params.h;
      const maxY = Math.max(h * 1.25, ...pts.map((p) => Math.max(p.cPlus, p.cMinus))) * 1.08;
      draw.setDomain(0, maxY, pts.length);
      draw.hline(h, FAINT, [1.5, 2.5]);
      draw.rightLabel(h, 'h');
      draw.path(pts.map((p) => p.cPlus), BLUE, 1.0);
      draw.path(pts.map((p) => p.cMinus), VIOLET, 1.0);
      pts.forEach((p, i) => {
        if (p.signal !== 'none') draw.ring(i, p.signal === 'up' ? p.cPlus : p.cMinus, RED);
      });
      draw.legend([
        ['C+', BLUE],
        ['C-', VIOLET],
      ]);
    }) + 12;

    // params footnote
    y = ensureRoom(pdf, y, 30);
    y =
      wrap(
        pdf,
        `Methods - EWMA: lambda=${ew.params.lambda}, L=${ew.params.L} (ARL0 ~ 500, Monte-Carlo verified). CUSUM: tabular two-sided, k=0.5, h=${cu.params.h}. Imprecision: EWMA of z^2, calibrated UCL ${va.params.ucl?.toFixed(3) ?? ''}. Change points: PELT, penalty 3 log n. z-scores use the same control limits as the QC run log.`,
        M,
        y,
        W,
        7,
        FAINT,
      ) + 6;
  }

  if (!any) {
    pdf.text(M, y, 'Not enough runs yet - enter at least 2 runs on the QC page.', { size: 10, color: GRAY });
  }

  footerAll(pdf, 'Advanced Monitoring');
  return saveReportPdf(
    sqlite,
    dataDir,
    'monitoring',
    `Monitoring-Report-${String(assay.name).replace(/[^A-Za-z0-9]+/g, '-')}`,
    { assayId },
    pdf,
    userId,
    workspaceId,
  );
}

/** Tiny chart DSL for series charts (shared axes/scales handling). */
function drawSeriesChart(pdf: Pdf, y: number, H: number, body: (draw: SeriesDraw) => void): number {
  const padL = 10;
  const padR = 40;
  const plotX = M + padL;
  const plotW = W - padL - padR;
  const plotY = y + 4;
  const plotH = H - 18;
  let lo = 0;
  let hi = 1;
  let n = 1;
  const yFor = (v: number) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
  const xFor = (i: number) => plotX + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const draw: SeriesDraw = {
    setDomain(l, h, count) {
      lo = l;
      hi = h;
      n = Math.max(count, 1);
    },
    gridZero() {
      pdf.line(plotX, yFor(0), plotX + plotW, yFor(0), { color: INK, width: 0.8 });
    },
    hline(v, color, dash) {
      pdf.line(plotX, yFor(v), plotX + plotW, yFor(v), { color, width: 0.6, dash: dash ?? null });
    },
    path(values, color, width, dash) {
      for (let i = 1; i < values.length; i++) {
        pdf.line(xFor(i - 1), yFor(values[i - 1]), xFor(i), yFor(values[i]), { color, width, dash: dash ?? null });
      }
    },
    ring(i, v, color) {
      pdf.circle(xFor(i), yFor(v), 2.6, { stroke: color, lineWidth: 1.1 });
    },
    rightLabel(v, label) {
      pdf.text(plotX + plotW + 6, yFor(v) - 3.5, label, { font: 'mono', size: 6.5, color: FAINT });
    },
    legend(items) {
      let lx = plotX + plotW - items.length * 30;
      for (const [label, color] of items) {
        pdf.line(lx, plotY + 4, lx + 10, plotY + 4, { color, width: 1.2 });
        pdf.text(lx + 13, plotY, label, { font: 'mono', size: 6.5, color: GRAY });
        lx += 34;
      }
    },
  };
  body(draw);
  pdf.line(plotX, plotY + plotH + 4, plotX + plotW, plotY + plotH + 4, { color: HAIR, width: 0.6 });
  return y + H;
}

interface SeriesDraw {
  setDomain(lo: number, hi: number, n: number): void;
  gridZero(): void;
  hline(v: number, color: RGB, dash?: [number, number]): void;
  path(values: number[], color: RGB, width: number, dash?: [number, number]): void;
  ring(i: number, v: number, color: RGB): void;
  rightLabel(v: number, label: string): void;
  legend(items: [string, RGB][]): void;
}
