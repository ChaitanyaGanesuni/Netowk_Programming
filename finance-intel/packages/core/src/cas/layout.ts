/**
 * PDF text layout reconstruction for CAS parsing — a TypeScript port of casparser 1.4.1's
 * `parsers/extract.py` (per-glyph lines) and `parsers/pageobj.py` (blocks/cells).
 * casparser is MIT-licensed © Sandeep Somasekharan (github.com/codereverser/casparser).
 *
 * Input is the output of PDF_PAGE_EXTRACTOR_JS: one atom per PDF text-show operation with
 * per-glyph x extents — the same granularity casparser reads through PDFium.
 */

import type { ExtractedPage } from './pdfExtractor';

export interface Atom {
  page: number;
  text: string;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBot: number;
  baseline: number;
  font: string;
  /** Per-glyph horizontal extents from the extractor (real spaces included, as in PDFium). */
  glyphs: Array<{ t: string; x0: number; x1: number }>;
}

export interface Char {
  text: string;
  x0: number;
  /** baseline */
  y0: number;
  x1: number;
  /** glyph top */
  y1: number;
  font: string;
}

export interface Line {
  page: number;
  baseline: number;
  chars: Char[];
}

export interface Page {
  number: number;
  lines: Line[];
}

/**
 * casparser drops atoms in the Devanagari "Mangal" font that NSDL/CDSL overlay on English
 * text. pdf.js does not expose reliable base-font names, so drop Devanagari text instead.
 */
const DEVANAGARI_RE = /[\u0900-\u097F]/;

/** Horizontal, Latin-script atoms per page (rotated watermarks are already excluded). */
export function atomsFromPages(pages: readonly ExtractedPage[]): Atom[][] {
  return pages.map((page, index) =>
    page.atoms
      .filter((a) => a.text.trim() && !DEVANAGARI_RE.test(a.text))
      .map((a) => ({
        page: index + 1,
        text: a.text,
        xLeft: a.xLeft,
        xRight: a.xRight,
        yTop: a.yTop,
        yBot: a.yBot,
        baseline: a.baseline,
        font: a.font,
        glyphs: a.chars,
      })),
  );
}

/** Text of the first `maxPages` pages, including rotated watermarks (used for detection). */
export function sampleText(pages: readonly ExtractedPage[], maxPages = 2): string {
  return pages.slice(0, maxPages).map((page) => page.text).join('\n');
}

// ---------------------------------------------------------------- extract.py port

const Y_TOL = 1.5;
const Y_OVERLAY_ROW_TOL = 3.0;
const Y_OVERLAY_MIN_OFFSET = 0.05;
const X_OVERLAY_MIN_FRAC = 0.5;

function atomChars(atom: Atom): Char[] {
  return atom.glyphs
    .filter((g) => g.t !== '\uFFFD' && g.x1 - g.x0 > 0)
    .map((g) => ({ text: g.t, x0: g.x0, y0: atom.baseline, x1: g.x1, y1: atom.yTop, font: atom.font }));
}

function dedupeOverlayAtoms(atoms: Atom[]): Atom[] {
  if (atoms.length < 2) return atoms;
  const sorted = atoms.map((a, i) => [i, a] as const).sort((p, q) => q[1].yTop - p[1].yTop);
  const rows: Array<Array<readonly [number, Atom]>> = [];
  let anchor: number | null = null;
  for (const entry of sorted) {
    if (anchor === null || Math.abs(entry[1].yTop - anchor) > Y_OVERLAY_ROW_TOL) {
      rows.push([entry]);
      anchor = entry[1].yTop;
    } else {
      rows[rows.length - 1]?.push(entry);
    }
  }
  const drop = new Set<number>();
  for (const row of rows) {
    if (row.length < 2) continue;
    const ys = row.map(([, a]) => a.yTop).sort((p, q) => p - q);
    const medianY = ys[Math.floor(ys.length / 2)] ?? 0;
    for (let ii = 0; ii < row.length; ii++) {
      const [oi, ai] = row[ii] ?? [-1, null];
      if (ai === null || drop.has(oi)) continue;
      for (let jj = ii + 1; jj < row.length; jj++) {
        const [oj, aj] = row[jj] ?? [-1, null];
        if (aj === null || drop.has(oj) || !ai.font || ai.font !== aj.font) continue;
        const xo = Math.min(ai.xRight, aj.xRight) - Math.max(ai.xLeft, aj.xLeft);
        if (xo <= 0) continue;
        const narrower = Math.min(ai.xRight - ai.xLeft, aj.xRight - aj.xLeft);
        if (narrower <= 0 || xo / narrower < X_OVERLAY_MIN_FRAC) continue;
        if (Math.abs(ai.yTop - aj.yTop) < Y_OVERLAY_MIN_OFFSET) continue;
        drop.add(Math.abs(ai.yTop - medianY) > Math.abs(aj.yTop - medianY) ? oi : oj);
      }
    }
  }
  return atoms.filter((_, i) => !drop.has(i));
}

function clusterIntoLines(atoms: Atom[], pageNumber: number): Line[] {
  const chars = atoms.flatMap(atomChars).sort((p, q) => q.y0 - p.y0);
  const lines: Line[] = [];
  for (const c of chars) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(c.y0 - last.baseline) <= Y_TOL) {
      last.chars.push(c);
      const n = last.chars.length;
      last.baseline = (last.baseline * (n - 1) + c.y0) / n;
    } else {
      lines.push({ page: pageNumber, baseline: c.y0, chars: [c] });
    }
  }
  return lines;
}

/** Pages of baseline-clustered lines of glyphs (casparser `extract_pages`). */
export function extractPages(atomPages: readonly Atom[][]): Page[] {
  return atomPages.map((atoms, i) => ({ number: i + 1, lines: clusterIntoLines(dedupeOverlayAtoms(atoms), i + 1) }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Joins glyphs left-to-right, inserting a space where the x-gap is significant. */
export function renderChars(chars: readonly Char[]): string {
  const cs = [...chars].sort((p, q) => p.x0 - q.x0);
  if (cs.length === 0) return '';
  const gap = Math.max(1.5, 0.6 * median(cs.map((c) => c.y1 - c.y0)));
  let out = '';
  let prevX1: number | null = null;
  for (const c of cs) {
    if (prevX1 !== null && c.x0 - prevX1 > gap) out += ' ';
    out += c.text;
    prevX1 = c.x1;
  }
  return out;
}

export function lineText(line: Line): string {
  return renderChars(line.chars);
}

// ---------------------------------------------------------------- pageobj.py port

export interface Cell {
  xLeft: number;
  xRight: number;
  yTop: number;
  yBot: number;
  text: string;
}

export interface Block {
  page: number;
  cells: Cell[];
}

export function blockText(block: Block): string {
  return block.cells.filter((c) => c.text).map((c) => c.text).join('\t\t');
}

const Y_LINE_TOL = 1.5;
const Y_BLOCK_TOL = 9.0;
const X_LEFT_TOL = 3.0;
const STRIP_VERTICAL_GAP = 9.0;
const CENTER_LEFT_ALIGN_TOL = 1.0;
const LEFT_EDGE_X = 100.0;
const SOFT_HYPHEN = '­';

const round1 = (x: number) => Math.round(x * 10) / 10;

function dedupeAtoms(atoms: Atom[]): Atom[] {
  const seen = new Set<string>();
  const unique = atoms.filter((a) => {
    const key = `${round1(a.xLeft)}|${round1(a.yTop)}|${a.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const byLine = new Map<number, Atom[]>();
  for (const a of unique) {
    const y = round1(a.yTop);
    byLine.set(y, [...(byLine.get(y) ?? []), a]);
  }
  const keep: Atom[] = [];
  for (const lineAtoms of byLine.values()) {
    const kept: Atom[] = [];
    for (const a of lineAtoms) {
      const text = a.text.trim();
      const dup = kept.some((k) => k.text.trim() === text && a.xLeft < k.xRight && k.xLeft < a.xRight);
      if (!dup) kept.push(a);
    }
    keep.push(...kept);
  }
  return keep;
}

function clusterRawLines(atoms: Atom[]): Atom[][] {
  if (atoms.length === 0) return [];
  const sorted = [...atoms].sort((p, q) => q.yTop - p.yTop || p.xLeft - q.xLeft);
  const first = sorted[0] as Atom;
  const lines: Atom[][] = [[first]];
  let curY = first.yTop;
  for (const a of sorted.slice(1)) {
    if (Math.abs(a.yTop - curY) <= Y_LINE_TOL) lines[lines.length - 1]?.push(a);
    else {
      lines.push([a]);
      curY = a.yTop;
    }
  }
  return lines;
}

function clusterBlocks(rawLines: Atom[][]): Atom[][] {
  if (rawLines.length === 0) return [];
  const blocks: Atom[][] = [[...(rawLines[0] ?? [])]];
  let prevY = rawLines[0]?.[0]?.yTop ?? 0;
  for (const line of rawLines.slice(1)) {
    const curY = line[0]?.yTop ?? 0;
    if (prevY - curY <= Y_BLOCK_TOL) blocks[blocks.length - 1]?.push(...line);
    else blocks.push([...line]);
    prevY = curY;
  }
  return blocks;
}

function columnCluster(blockAtoms: Atom[]): Atom[][] {
  const strips: Atom[][] = [];
  for (const a of [...blockAtoms].sort((p, q) => q.yTop - p.yTop || p.xLeft - q.xLeft)) {
    const aCenter = (a.xLeft + a.xRight) / 2;
    let placed = false;
    for (const strip of strips) {
      const last = strip[strip.length - 1] as Atom;
      const xLeftOk = Math.abs(a.xLeft - last.xLeft) <= X_LEFT_TOL;
      const dy = last.yTop - a.yTop;
      if (!(xLeftOk && dy >= -0.1 && dy <= STRIP_VERTICAL_GAP)) continue;
      const atLeftEdge = a.xLeft < LEFT_EDGE_X;
      const centerDrifts = Math.abs(aCenter - (last.xLeft + last.xRight) / 2) > CENTER_LEFT_ALIGN_TOL;
      if (atLeftEdge || centerDrifts) {
        strip.push(a);
        placed = true;
        break;
      }
    }
    if (!placed) strips.push([a]);
  }
  return strips;
}

function joinColumnAtoms(atomsTopDown: Atom[]): string {
  const pieces: string[] = [];
  let continuation = false;
  for (const atom of atomsTopDown) {
    const part = atom.text.trim();
    if (!part) continue;
    if (continuation && pieces.length) pieces[pieces.length - 1] += part;
    else pieces.push(part);
    const last = pieces[pieces.length - 1] ?? '';
    if (last.endsWith(SOFT_HYPHEN)) {
      pieces[pieces.length - 1] = last.slice(0, -1);
      continuation = true;
    } else {
      continuation = false;
    }
  }
  return pieces.join('\n').split(SOFT_HYPHEN).join('');
}

/** Row blocks of column cells, in reading order (casparser `blocks_from_atoms`). */
export function blocksFromAtoms(atomPages: readonly Atom[][]): Block[] {
  const out: Block[] = [];
  atomPages.forEach((atoms, index) => {
    for (const blockAtoms of clusterBlocks(clusterRawLines(dedupeAtoms(atoms)))) {
      const strips = columnCluster(blockAtoms).sort(
        (p, q) => Math.min(...p.map((a) => a.xLeft)) - Math.min(...q.map((a) => a.xLeft)),
      );
      const cells: Cell[] = [];
      for (const strip of strips) {
        const sortedStrip = [...strip].sort((p, q) => q.yTop - p.yTop || p.xLeft - q.xLeft);
        const text = joinColumnAtoms(sortedStrip);
        if (!text) continue;
        cells.push({
          xLeft: Math.min(...strip.map((a) => a.xLeft)),
          xRight: Math.max(...strip.map((a) => a.xRight)),
          yTop: Math.max(...strip.map((a) => a.yTop)),
          yBot: Math.min(...strip.map((a) => a.yBot)),
          text,
        });
      }
      if (cells.length) out.push({ page: index + 1, cells });
    }
  });
  return out;
}
