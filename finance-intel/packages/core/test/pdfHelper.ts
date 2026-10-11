import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_PAGE_EXTRACTOR_JS, type ExtractedPage } from '../src/cas';

// The exact source string the app injects into its WebView.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const extractPage = new Function(`return ${PDF_PAGE_EXTRACTOR_JS}`)() as (ops: typeof OPS, page: unknown) => Promise<ExtractedPage>;

export const fixturePath = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));

export async function loadFixturePages(name: string, password = 'ABCDE1234F'): Promise<ExtractedPage[]> {
  const data = new Uint8Array(readFileSync(fixturePath(`pdf/${name}`)));
  const task = getDocument({ data, password, verbosity: 0 });
  const doc = await task.promise;
  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPage(OPS, await doc.getPage(i)));
  await task.destroy();
  return pages;
}
