/**
 * Builds assets/pdfjs/engine.html: a self-contained page that runs pdf.js (legacy build, for
 * older Android WebViews) with its worker inlined as a Blob. The app loads it in a hidden
 * WebView and injects the shared extractor (PDF_PAGE_EXTRACTOR_JS) at runtime.
 * The page's Content-Security-Policy forbids all network access.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const lib = readFileSync(join(pdfjsRoot, 'legacy/build/pdf.min.mjs'), 'utf8');
const worker = readFileSync(join(pdfjsRoot, 'legacy/build/pdf.worker.min.mjs'), 'utf8');
for (const [name, src] of [['pdf.min.mjs', lib], ['pdf.worker.min.mjs', worker]]) {
  if (/<\/script/i.test(src)) throw new Error(`${name} contains </script; cannot inline safely`);
}
const workerLiteral = JSON.stringify(worker).replace(/<\//g, '<\\/');

const bridge = `
const lib = globalThis.pdfjsLib;
const post = (msg) => window.ReactNativeWebView.postMessage(JSON.stringify(msg));
try {
  const url = URL.createObjectURL(new Blob([window.__FI_WORKER_SRC__], { type: 'text/javascript' }));
  lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
} catch (e) {
  post({ type: 'log', message: 'worker unavailable: ' + e });
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
window.__fiExtract = async function (req) {
  let task = null;
  try {
    if (typeof window.__fiExtractor !== 'function') throw new Error('extractor not injected');
    task = lib.getDocument({ data: b64ToBytes(req.data), password: req.password, verbosity: 0, isOffscreenCanvasSupported: false });
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await window.__fiExtractor(lib.OPS, await doc.getPage(i)));
    post({ type: 'result', id: req.id, ok: true, pages });
  } catch (e) {
    const code = e && e.name === 'PasswordException' ? (e.code === 2 ? 'incorrect_password' : 'password_required') : 'failed';
    post({ type: 'result', id: req.id, ok: false, code, message: String((e && e.message) || e) });
  } finally {
    if (task) task.destroy();
  }
};
post({ type: 'ready', version: lib.version });
`;

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src blob: data:">
</head><body>
<script>window.__FI_WORKER_SRC__ = ${workerLiteral};</script>
<script type="module">${lib}</script>
<script type="module">${bridge}</script>
</body></html>
`;
mkdirSync(join(appRoot, 'assets/pdfjs'), { recursive: true });
writeFileSync(join(appRoot, 'assets/pdfjs/engine.html'), html);
console.log(`vendor-pdfjs: wrote assets/pdfjs/engine.html (${(html.length / 1024).toFixed(0)} KiB)`);
