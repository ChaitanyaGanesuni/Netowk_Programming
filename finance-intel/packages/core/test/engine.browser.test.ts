/**
 * Runs the app's real WebView PDF engine (app/assets/pdfjs/engine.html, built by
 * app/scripts/vendor-pdfjs.mjs) in headless Chromium — the engine Android's WebView uses —
 * with the same injected extractor and message bridge as the app. Its output must equal the
 * Node extraction and parse to the casparser-verified result.
 *
 * Skipped when Playwright/Chromium or the built engine page are unavailable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCas, PDF_PAGE_EXTRACTOR_JS, type RtaCasData } from '../src/cas';
import { fixturePath, loadFixturePages } from './pdfHelper';

const enginePath = fileURLToPath(new URL('../../../app/assets/pdfjs/engine.html', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwright: any = null;
try {
  const require = createRequire(import.meta.url);
  playwright = require(process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright');
} catch {
  playwright = null;
}
const available = playwright !== null && existsSync(enginePath);

describe.skipIf(!available)('WebView PDF engine (headless Chromium)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  const externalRequests: string[] = [];

  beforeAll(async () => {
    browser = await playwright.chromium.launch();
    page = await browser.newPage();
    const html = readFileSync(enginePath, 'utf8');
    // Serve the engine at the same origin the app uses (WebView baseUrl); block everything else.
    await page.route('**/*', (route: any) => {
      const url: string = route.request().url();
      if (url === 'https://pdf-engine.local/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      externalRequests.push(url);
      return route.abort();
    });
    // Mirrors the app's injectedJavaScriptBeforeContentLoaded + react-native-webview bridge.
    await page.addInitScript(
      `window.__msgs = []; window.ReactNativeWebView = { postMessage: (m) => window.__msgs.push(JSON.parse(m)) };
       window.__fiExtractor = ${PDF_PAGE_EXTRACTOR_JS};`,
    );
    await page.goto('https://pdf-engine.local/');
    await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'ready'), null, { timeout: 30000 });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  async function extract(name: string, password: string) {
    const data = readFileSync(fixturePath(`pdf/${name}`)).toString('base64');
    const id = `${name}-${password}`;
    await page.evaluate((req: unknown) => (window as any).__fiExtract(req), { id, data, password });
    await page.waitForFunction((rid: string) => (window as any).__msgs.some((m: any) => m.id === rid), id, { timeout: 30000 });
    return page.evaluate((rid: string) => (window as any).__msgs.find((m: any) => m.id === rid), id);
  }

  it('extracts the same atoms as Node and parses to the verified result', async () => {
    const result = await extract('cams_detailed.pdf', 'ABCDE1234F');
    expect(result.ok).toBe(true);
    const nodePages = await loadFixturePages('cams_detailed.pdf');
    // pdf.js numbers fonts per environment (g_d0_f2 vs g_d0_f3); only "same font or not"
    // matters to the parsers, so compare with ids renumbered by first appearance.
    const canonical = (pages: any[]) => {
      const ids = new Map<string, string>();
      return pages.map((p) => ({ ...p, atoms: p.atoms.map((a: any) => ({ ...a, font: ids.get(a.font) ?? ids.set(a.font, `f${ids.size}`).get(a.font) })) }));
    };
    expect(canonical(result.pages)).toEqual(canonical(JSON.parse(JSON.stringify(nodePages))));
    const parsed = parseCas(result.pages) as RtaCasData;
    expect(parsed.folios.flatMap((f) => f.schemes).map((s) => s.transactions.length)).toEqual([8, 2, 30]);
    expect(parsed.warnings).toEqual([]);
  }, 60000);

  it('reports wrong and missing passwords distinctly', async () => {
    expect(await extract('cdsl.pdf', 'WRONGPASS1')).toMatchObject({ ok: false, code: 'incorrect_password' });
    expect(await extract('kfin_detailed.pdf', '')).toMatchObject({ ok: false, code: 'password_required' });
  }, 60000);

  it('never touches the network', () => {
    expect(externalRequests).toEqual([]);
  });
});
