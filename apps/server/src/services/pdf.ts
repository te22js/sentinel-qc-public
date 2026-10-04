/**
 * Minimal dependency-free PDF writer (PDF 1.4, uncompressed content streams,
 * standard Type1 fonts). Enough for reports: text in Helvetica/Helvetica-Bold and
 * Courier/Courier-Bold (tabular numerals), lines with dash patterns, plain and
 * rounded rectangles, filled circles. Coordinates are given from the TOP-LEFT of the
 * page in points and converted internally to PDF's bottom-left space.
 */

export type FontName = 'helv' | 'helvB' | 'mono' | 'monoB';

// Standard AFM advance widths (per 1000 units) for ASCII 32..126
const HELV: number[] = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B: number[] = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const FONT_IDS: Record<FontName, string> = { helv: 'F1', helvB: 'F2', mono: 'F3', monoB: 'F4' };
const FONT_BASE: Record<FontName, string> = {
  helv: 'Helvetica',
  helvB: 'Helvetica-Bold',
  mono: 'Courier',
  monoB: 'Courier-Bold',
};

/** Replace non-WinAnsi/typographic characters with ASCII-safe equivalents. */
export function pdfSafe(s: string): string {
  return s
    .replace(/−/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·|•/g, '\xb7') // WinAnsi middle dot
    .replace(/±/g, '+/-')
    .replace(/≈/g, '~')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7e\xb7]/g, '?');
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export interface TextOpts {
  font?: FontName;
  size?: number;
  color?: [number, number, number];
  align?: 'left' | 'right' | 'center';
  /** extra character spacing in points (letterspaced caps) */
  charSpace?: number;
}

export interface StrokeOpts {
  color?: [number, number, number];
  width?: number;
  dash?: [number, number] | null;
}

export interface RectOpts {
  fill?: [number, number, number] | null;
  stroke?: [number, number, number] | null;
  lineWidth?: number;
  radius?: number;
}

export class Pdf {
  readonly pageW: number;
  readonly pageH: number;
  private pages: string[][] = [];
  private cur: string[] = [];

  constructor(pageW = 595.28, pageH = 841.89) {
    this.pageW = pageW;
    this.pageH = pageH;
    this.addPage();
  }

  addPage(): void {
    this.cur = [];
    this.pages.push(this.cur);
  }

  /** Point subsequent drawing at an existing page (0-based) — e.g. to add footers. */
  setPage(i: number): void {
    this.cur = this.pages[i];
  }

  get pageCount(): number {
    return this.pages.length;
  }

  measure(text: string, font: FontName = 'helv', size = 10, charSpace = 0): number {
    const s = pdfSafe(text);
    let base: number;
    if (font === 'mono' || font === 'monoB') {
      base = s.length * 0.6 * size;
    } else {
      const table = font === 'helvB' ? HELV_B : HELV;
      let w = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        w += table[c - 32] ?? 556;
      }
      base = (w / 1000) * size;
    }
    return base + Math.max(0, s.length - 1) * charSpace;
  }

  text(x: number, yTop: number, str: string, opts: TextOpts = {}): void {
    const font = opts.font ?? 'helv';
    const size = opts.size ?? 10;
    const cs = opts.charSpace ?? 0;
    const [r, g, b] = opts.color ?? [0.06, 0.09, 0.16];
    const s = pdfSafe(str);
    let tx = x;
    if (opts.align === 'right') tx = x - this.measure(str, font, size, cs);
    else if (opts.align === 'center') tx = x - this.measure(str, font, size, cs) / 2;
    const y = this.pageH - yTop - size * 0.78; // yTop = top of the text box
    this.cur.push(
      `BT /${FONT_IDS[font]} ${size} Tf ${cs.toFixed(2)} Tc ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${esc(s)}) Tj 0 Tc ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, opts: StrokeOpts = {}): void {
    const [r, g, b] = opts.color ?? [0, 0, 0];
    const w = opts.width ?? 1;
    const dash = opts.dash ? `[${opts.dash[0]} ${opts.dash[1]}] 0 d` : '[] 0 d';
    this.cur.push(
      `${dash} ${w.toFixed(2)} w ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${x1.toFixed(2)} ${(this.pageH - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.pageH - y2).toFixed(2)} l S [] 0 d`,
    );
  }

  rect(x: number, yTop: number, w: number, h: number, opts: RectOpts = {}): void {
    const y = this.pageH - yTop - h;
    const ops: string[] = ['[] 0 d'];
    if (opts.fill) ops.push(`${opts.fill.map((v) => v.toFixed(3)).join(' ')} rg`);
    if (opts.stroke) ops.push(`${opts.stroke.map((v) => v.toFixed(3)).join(' ')} RG ${(opts.lineWidth ?? 0.8).toFixed(2)} w`);
    const radius = opts.radius ?? 0;
    if (radius > 0) {
      const k = 0.5523 * radius;
      const x2 = x + w;
      const y2 = y + h;
      ops.push(
        `${(x + radius).toFixed(2)} ${y.toFixed(2)} m ` +
          `${(x2 - radius).toFixed(2)} ${y.toFixed(2)} l ` +
          `${(x2 - radius + k).toFixed(2)} ${y.toFixed(2)} ${x2.toFixed(2)} ${(y + radius - k).toFixed(2)} ${x2.toFixed(2)} ${(y + radius).toFixed(2)} c ` +
          `${x2.toFixed(2)} ${(y2 - radius).toFixed(2)} l ` +
          `${x2.toFixed(2)} ${(y2 - radius + k).toFixed(2)} ${(x2 - radius + k).toFixed(2)} ${y2.toFixed(2)} ${(x2 - radius).toFixed(2)} ${y2.toFixed(2)} c ` +
          `${(x + radius).toFixed(2)} ${y2.toFixed(2)} l ` +
          `${(x + radius - k).toFixed(2)} ${y2.toFixed(2)} ${x.toFixed(2)} ${(y2 - radius + k).toFixed(2)} ${x.toFixed(2)} ${(y2 - radius).toFixed(2)} c ` +
          `${x.toFixed(2)} ${(y + radius).toFixed(2)} l ` +
          `${x.toFixed(2)} ${(y + radius - k).toFixed(2)} ${(x + radius - k).toFixed(2)} ${y.toFixed(2)} ${(x + radius).toFixed(2)} ${y.toFixed(2)} c h`,
      );
    } else {
      ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    }
    ops.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S');
    this.cur.push(ops.join(' '));
  }

  circle(cx: number, cyTop: number, radius: number, opts: { fill?: [number, number, number] | null; stroke?: [number, number, number] | null; lineWidth?: number } = {}): void {
    const cy = this.pageH - cyTop;
    const k = 0.5523 * radius;
    const ops: string[] = ['[] 0 d'];
    if (opts.fill) ops.push(`${opts.fill.map((v) => v.toFixed(3)).join(' ')} rg`);
    if (opts.stroke) ops.push(`${opts.stroke.map((v) => v.toFixed(3)).join(' ')} RG ${(opts.lineWidth ?? 0.9).toFixed(2)} w`);
    ops.push(
      `${(cx + radius).toFixed(2)} ${cy.toFixed(2)} m ` +
        `${(cx + radius).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + radius).toFixed(2)} ${cx.toFixed(2)} ${(cy + radius).toFixed(2)} c ` +
        `${(cx - k).toFixed(2)} ${(cy + radius).toFixed(2)} ${(cx - radius).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - radius).toFixed(2)} ${cy.toFixed(2)} c ` +
        `${(cx - radius).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - radius).toFixed(2)} ${cx.toFixed(2)} ${(cy - radius).toFixed(2)} c ` +
        `${(cx + k).toFixed(2)} ${(cy - radius).toFixed(2)} ${(cx + radius).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + radius).toFixed(2)} ${cy.toFixed(2)} c h`,
    );
    ops.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S');
    this.cur.push(ops.join(' '));
  }

  /** Serialize the document. */
  toBuffer(): Buffer {
    const objects: string[] = [];
    const nPages = this.pages.length;
    // object numbering: 1 catalog, 2 pages, 3..6 fonts, then per page: content, page
    const fontObjNums: number[] = [3, 4, 5, 6];
    const firstContentObj = 7;
    const pageObjNum = (i: number) => firstContentObj + i * 2 + 1;
    const contentObjNum = (i: number) => firstContentObj + i * 2;

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[2] = `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ')}] /Count ${nPages} >>`;
    (Object.keys(FONT_IDS) as FontName[]).forEach((f, i) => {
      objects[fontObjNums[i]] = `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_BASE[f]} /Encoding /WinAnsiEncoding >>`;
    });
    const fontRes = `<< ${(Object.keys(FONT_IDS) as FontName[]).map((f, i) => `/${FONT_IDS[f]} ${fontObjNums[i]} 0 R`).join(' ')} >>`;
    this.pages.forEach((page, i) => {
      const stream = page.join('\n');
      objects[contentObjNum(i)] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
      objects[pageObjNum(i)] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] /Resources << /Font ${fontRes} >> /Contents ${contentObjNum(i)} 0 R >>`;
    });

    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    const maxObj = firstContentObj + nPages * 2 - 1;
    for (let n = 1; n <= maxObj; n++) {
      offsets[n] = Buffer.byteLength(out, 'latin1');
      out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= maxObj; n++) {
      out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
