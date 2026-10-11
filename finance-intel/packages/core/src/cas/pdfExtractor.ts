/**
 * Text-atom extractor that runs wherever pdf.js runs (Node tests, the app's WebView).
 *
 * pdf.js `getTextContent()` merges neighbouring text-show operations when their gap is under
 * 0.6 em, which glues table cells together. casparser reads PDFium text objects instead —
 * one per show operation, with per-glyph positions. To match that, this extractor replays
 * the page's operator list using the same text-state rules as pdf.js's canvas renderer
 * (`CanvasGraphics.showText`) and emits one atom per show operation, in PDF user space.
 *
 * Kept as plain-JavaScript source (not a TS function) because Hermes cannot turn compiled
 * functions back into source; the app injects this string into its WebView, and tests
 * evaluate the same string, so both run identical code.
 *
 * Evaluates to `async function extractPage(OPS, page) -> { atoms, text }`.
 */
export const PDF_PAGE_EXTRACTOR_JS = String.raw`(function () {
  function mul(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
    ];
  }
  function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  function cloneState(s) {
    return {
      tm: s.tm.slice(), x: s.x, y: s.y, lineX: s.lineX, lineY: s.lineY, leading: s.leading,
      cs: s.cs, ws: s.ws, hs: s.hs, rise: s.rise, font: s.font, fontName: s.fontName,
      size: s.size, dir: s.dir, fontMatrix: s.fontMatrix
    };
  }
  return async function extractPage(OPS, page) {
    var ops = await page.getOperatorList();
    var fnArray = ops.fnArray, argsArray = ops.argsArray;
    var ctm = [1, 0, 0, 1, 0, 0];
    var stack = [];
    var st = { tm: [1, 0, 0, 1, 0, 0], x: 0, y: 0, lineX: 0, lineY: 0, leading: 0, cs: 0, ws: 0, hs: 1,
      rise: 0, font: null, fontName: '', size: 0, dir: 1, fontMatrix: [0.001, 0, 0, 0.001, 0, 0] };
    var atoms = [];
    var textParts = [];
    for (var i = 0; i < fnArray.length; i++) {
      var fn = fnArray[i];
      var a = argsArray[i] || [];
      if (fn === OPS.save) { stack.push({ ctm: ctm.slice(), st: cloneState(st) }); }
      else if (fn === OPS.restore) { var r = stack.pop(); if (r) { ctm = r.ctm; st = r.st; } }
      else if (fn === OPS.transform) { ctm = mul(a, ctm); }
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push({ ctm: ctm.slice(), st: cloneState(st) });
        if (a[0]) ctm = mul(a[0], ctm);
      }
      else if (fn === OPS.paintFormXObjectEnd) { var f = stack.pop(); if (f) { ctm = f.ctm; st = f.st; } }
      else if (fn === OPS.beginText) { st.tm = [1, 0, 0, 1, 0, 0]; st.x = st.lineX = 0; st.y = st.lineY = 0; }
      else if (fn === OPS.setFont) {
        var fontObj = null;
        try { fontObj = page.commonObjs.get(a[0]); } catch (e) { fontObj = null; }
        st.font = fontObj; st.fontName = a[0];
        st.fontMatrix = (fontObj && fontObj.fontMatrix) || [0.001, 0, 0, 0.001, 0, 0];
        var size = a[1];
        if (size < 0) { st.size = -size; st.dir = -1; } else { st.size = size; st.dir = 1; }
      }
      else if (fn === OPS.setTextMatrix) {
        st.tm = Array.isArray(a[0]) || (a[0] && a[0].length === 6) ? Array.prototype.slice.call(a[0]) : Array.prototype.slice.call(a, 0, 6);
        st.x = st.lineX = 0; st.y = st.lineY = 0;
      }
      else if (fn === OPS.moveText) { st.x = st.lineX += a[0]; st.y = st.lineY += a[1]; }
      else if (fn === OPS.setLeadingMoveText) { st.leading = a[1]; st.x = st.lineX += a[0]; st.y = st.lineY += a[1]; }
      else if (fn === OPS.setLeading) { st.leading = -a[0]; }
      else if (fn === OPS.nextLine) { st.x = st.lineX += 0; st.y = st.lineY += st.leading; }
      else if (fn === OPS.setCharSpacing) { st.cs = a[0]; }
      else if (fn === OPS.setWordSpacing) { st.ws = a[0]; }
      else if (fn === OPS.setHScale) { st.hs = a[0] / 100; }
      else if (fn === OPS.setTextRise) { st.rise = a[0]; }
      else if (fn === OPS.showText) {
        var glyphs = a[0] || [];
        if (!st.size) continue;
        var vertical = !!(st.font && st.font.vertical);
        var hscale = st.hs * st.dir;
        var widthScale = st.size * st.fontMatrix[0];
        var m = mul(st.tm, ctm);
        var ascent = (st.font && st.font.ascent) || 0.8;
        var descent = (st.font && st.font.descent) || -0.2;
        var gx = 0;
        var text = '';
        var chars = [];
        var minX = Infinity, maxX = -Infinity;
        for (var g = 0; g < glyphs.length; g++) {
          var glyph = glyphs[g];
          if (typeof glyph === 'number') { gx += (vertical ? 1 : -1) * glyph * st.size / 1000; continue; }
          var spacing = (glyph.isSpace ? st.ws : 0) + st.cs;
          var w = vertical ? -(glyph.vmetric ? glyph.vmetric[0] : 0) : glyph.width;
          var advance = vertical ? w * widthScale - spacing * st.dir : w * widthScale + spacing * st.dir;
          var unicode = glyph.unicode || '';
          text += unicode;
          var p0 = apply(m, st.x + gx * hscale, st.y + st.rise);
          var p1 = apply(m, st.x + (gx + w * widthScale) * hscale, st.y + st.rise);
          // Real space glyphs are kept, as PDFium reports them (casparser relies on that);
          // only gaps between show operations become synthetic spaces later.
          if (unicode && unicode !== '\n' && unicode !== '\r') {
            chars.push({ t: unicode, x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]) });
          }
          minX = Math.min(minX, p0[0], p1[0]);
          maxX = Math.max(maxX, p0[0], p1[0]);
          gx += advance;
        }
        var origin = apply(m, st.x, st.y + st.rise);
        var top = apply(m, st.x, st.y + st.rise + ascent * st.size);
        var bottom = apply(m, st.x, st.y + st.rise + descent * st.size);
        if (vertical) st.y -= gx; else st.x += gx * hscale;
        if (!text) continue;
        textParts.push(text);
        var rotated = Math.abs(m[1]) > Math.abs(m[0]);
        if (!text.trim() || rotated) continue;
        atoms.push({
          text: text, chars: chars, font: st.fontName,
          xLeft: minX === Infinity ? origin[0] : minX, xRight: maxX === -Infinity ? origin[0] : maxX,
          yTop: Math.max(top[1], bottom[1]), yBot: Math.min(top[1], bottom[1]), baseline: origin[1]
        });
      }
    }
    return { atoms: atoms, text: textParts.join(' ') };
  };
})()`;

/** One text-show operation, as produced by {@link PDF_PAGE_EXTRACTOR_JS}. */
export interface ExtractedAtom {
  text: string;
  /** Per-glyph extents, including real space glyphs. */
  chars: Array<{ t: string; x0: number; x1: number }>;
  font: string;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBot: number;
  baseline: number;
}

export interface ExtractedPage {
  atoms: ExtractedAtom[];
  /** All text on the page, including rotated watermarks (used for issuer detection). */
  text: string;
}
