import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { bytesToBase64, PDF_PAGE_EXTRACTOR_JS, type ExtractedPage } from '@fi/core';

/**
 * On-device PDF text extraction. pdf.js runs in a hidden WebView (engine.html, built by
 * scripts/vendor-pdfjs.mjs) whose Content-Security-Policy blocks all network access; PDFs and
 * passwords never leave the phone. The extractor injected here is the same string the
 * core test suite runs in Node and headless Chromium.
 */

export type PdfErrorCode = 'password_required' | 'incorrect_password' | 'failed' | 'engine_unavailable' | 'timeout';

export class PdfEngineError extends Error {
  override readonly name = 'PdfEngineError';
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ORIGIN = 'https://pdf-engine.local/';
const TIMEOUT_MS = 90_000;

type Pending = { resolve: (pages: ExtractedPage[]) => void; reject: (error: PdfEngineError) => void; timer: ReturnType<typeof setTimeout> };

let webView: WebView | null = null;
let ready = false;
let readyWaiters: Array<() => void> = [];
const pending = new Map<string, Pending>();
let counter = 0;

function waitUntilReady(): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PdfEngineError('engine_unavailable', 'PDF engine did not start')), 30_000);
    readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Decrypts (if needed) and extracts text atoms from a PDF. Requires <PdfEngineHost/> mounted. */
export async function extractPdf(bytes: Uint8Array, password: string): Promise<ExtractedPage[]> {
  await waitUntilReady();
  const view = webView;
  if (!view) throw new PdfEngineError('engine_unavailable', 'PDF engine is not mounted');
  const id = `pdf-${Date.now()}-${counter++}`;
  const request = JSON.stringify({ id, data: bytesToBase64(bytes), password });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new PdfEngineError('timeout', 'PDF extraction timed out'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    view.injectJavaScript(`window.__fiExtract(${request}); true;`);
  });
}

function onMessage(event: WebViewMessageEvent): void {
  let message: { type?: string; id?: string; ok?: boolean; pages?: ExtractedPage[]; code?: PdfErrorCode; message?: string };
  try {
    message = JSON.parse(event.nativeEvent.data);
  } catch {
    return;
  }
  if (message.type === 'ready') {
    ready = true;
    readyWaiters.forEach((wake) => wake());
    readyWaiters = [];
    return;
  }
  if (message.type !== 'result' || !message.id) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok && message.pages) entry.resolve(message.pages);
  else entry.reject(new PdfEngineError(message.code ?? 'failed', message.message ?? 'PDF extraction failed'));
}

/** Mount once near the app root. Renders an invisible, network-isolated WebView. */
export function PdfEngineHost() {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<WebView>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const asset = Asset.fromModule(require('../../assets/pdfjs/engine.html'));
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error('engine asset missing');
      const text = await new File(asset.localUri).text();
      if (!cancelled) setHtml(text);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      webView = null;
      ready = false;
    };
  }, []);

  if (!html) return null;
  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={(instance) => {
          ref.current = instance;
          webView = instance;
        }}
        source={{ html, baseUrl: ORIGIN }}
        originWhitelist={[ORIGIN, 'about:blank']}
        onShouldStartLoadWithRequest={(request) => request.url === ORIGIN || request.url === 'about:blank'}
        injectedJavaScriptBeforeContentLoaded={`window.__fiExtractor = ${PDF_PAGE_EXTRACTOR_JS}; true;`}
        onMessage={onMessage}
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        cacheEnabled={false}
        incognito
        mixedContentMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({ hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 } });
