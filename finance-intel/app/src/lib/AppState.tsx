import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { openAuthSessionAsync } from 'expo-web-browser';
import { BackendClient } from './api';
import { deleteLocalDatabase } from './database';
import { deleteAllSecrets, loadBackendCredentials, type BackendCredentials } from './secrets';
import { queryParams } from './url';
import { forgetConnectionLocally, loadSnapshot, refreshConnections, syncAll, type LocalSnapshot } from './sync';

/** Must match APP_REDIRECT_URI in backend/wrangler.jsonc and the "scheme" in app.json. */
export const OAUTH_REDIRECT = 'financeintel://oauth';

interface AppState {
  ready: boolean;
  credentials: BackendCredentials | null;
  snapshot: LocalSnapshot | null;
  syncing: boolean;
  message: string | null;
  setCredentials: (credentials: BackendCredentials) => void;
  reload: () => Promise<void>;
  syncNow: () => Promise<void>;
  connectGmail: () => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
  forgetDevice: () => Promise<void>;
  client: BackendClient | null;
}

const Context = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [credentials, setCredentials] = useState<BackendCredentials | null>(null);
  const [snapshot, setSnapshot] = useState<LocalSnapshot | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const client = useMemo(() => (credentials ? new BackendClient(credentials) : null), [credentials]);

  const reload = useCallback(async () => {
    setSnapshot(await loadSnapshot());
  }, []);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const summary = await syncAll(credentials);
      const problems = [
        summary.backendError && `Backend: ${summary.backendError}`,
        summary.inbox && summary.inbox.status === 'failed' && `Inbox: ${summary.inbox.errorMessage}`,
        summary.nav.status === 'failed' && `NAV feed: ${summary.nav.errorMessage}`,
      ].filter(Boolean);
      const docs = summary.documents;
      const docNote = docs && docs.processed
        ? ` Documents: ${docs.processed} read, ${docs.imported} statements imported (${docs.newTransactions} new transactions)${docs.needsPassword ? `, ${docs.needsPassword} need a password` : ''}.`
        : '';
      setMessage(problems.length ? `Kept last good data. ${problems.join(' · ')}${docNote}` : `Sync complete.${docNote}`);
    } finally {
      await reload();
      setSyncing(false);
    }
  }, [credentials, reload]);

  const connectGmail = useCallback(async () => {
    if (!client) return;
    setMessage(null);
    const { authUrl } = await client.startGmailAuth();
    const result = await openAuthSessionAsync(authUrl, OAUTH_REDIRECT);
    if (result.type !== 'success') {
      setMessage('Gmail connection was cancelled.');
      return;
    }
    const params = queryParams(result.url);
    if (params.status !== 'success') {
      setMessage(`Gmail connection failed (${params.code ?? 'unknown'}).`);
      return;
    }
    setMessage('Gmail connected. Importing history runs in the background every 30 minutes.');
    await refreshConnections(client);
    await reload();
  }, [client, reload]);

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (!client) return;
      await client.disconnect(connectionId);
      await forgetConnectionLocally(connectionId);
      await reload();
      setMessage('Disconnected and access revoked at Google.');
    },
    [client, reload],
  );

  const forgetDevice = useCallback(async () => {
    await deleteLocalDatabase();
    await deleteAllSecrets();
    setCredentials(null);
    setSnapshot(null);
    setMessage('All local data and keys were deleted from this device.');
  }, []);

  useEffect(() => {
    (async () => {
      setCredentials(await loadBackendCredentials());
      await reload().catch(() => undefined);
      setReady(true);
    })();
  }, [reload]);

  const value: AppState = {
    ready,
    credentials,
    snapshot,
    syncing,
    message,
    setCredentials,
    reload,
    syncNow,
    connectGmail,
    disconnect,
    forgetDevice,
    client,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppState(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider');
  return value;
}
