import { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { getInstitution, type DiscoveryResponse, type SyncRunDto } from '@fi/core';
import { useAppState } from '../../lib/AppState';
import { recentLocalHistory } from '../../lib/sync';
import { Button, Card, Label, Muted, Pill, Title, formatTimestamp, styles as ui, usePalette } from '../../components/ui';

type LocalRun = Awaited<ReturnType<typeof recentLocalHistory>>[number];

export default function ConnectionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useAppState();
  const p = usePalette();
  const [runs, setRuns] = useState<SyncRunDto[]>([]);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const connection = state.snapshot?.connections.find((c) => c.id === id);
  const { client } = state;

  useFocusEffect(
    useCallback(() => {
      setLocalRuns([]);
      recentLocalHistory().then(setLocalRuns).catch(() => undefined);
      if (client && id) client.runs(id).then((r) => setRuns(r.runs)).catch(() => undefined);
    }, [client, id]),
  );

  const scan = async () => {
    if (!client || !id) return;
    setBusy('scan');
    try {
      setDiscovery(await client.discover(id));
    } catch (error) {
      Alert.alert('Scan failed', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const confirmDisconnect = () =>
    Alert.alert('Disconnect Gmail?', 'Access is revoked at Google and the backend deletes its tokens, message pointers and sync history for this account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          if (!id) return;
          state.disconnect(id).then(() => router.back()).catch((error: unknown) => Alert.alert('Disconnect failed', String(error)));
        },
      },
    ]);

  if (!connection) {
    return (
      <View style={[screen.content, { backgroundColor: p.bg, flex: 1 }]}>
        <Label>This connection is no longer available.</Label>
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      <Card>
        <Title>Gmail {connection.accountLabel}</Title>
        <Pill text={connection.status} tone={connection.status === 'active' ? 'ok' : 'danger'} />
        <Muted>Access: {connection.scopes.map((s) => s.split('/').pop()).join(', ')} (read-only)</Muted>
        <Muted>Connected: {formatTimestamp(connection.createdAt)}</Muted>
        <Muted>Last successful sync: {formatTimestamp(connection.lastSuccessAt)}</Muted>
        {connection.nextAttemptAt && <Muted>Next retry after errors: {formatTimestamp(connection.nextAttemptAt)}</Muted>}
        {connection.lastError && <Text style={[ui.small, { color: p.danger }]}>Last error: {connection.lastError}</Text>}
        <Muted>Consent expiry: none fixed. Revoke any time here or at myaccount.google.com → Security → Third-party access.</Muted>
        {connection.status === 'needs_reauth' && <Button title="Reconnect Gmail" onPress={() => void state.connectGmail()} />}
      </Card>

      <Card>
        <Title>Account discovery</Title>
        <Muted>Counts emails from each institution’s known senders (Gmail estimates). Zero means the sender list needs a sample from you, or alerts are SMS-only.</Muted>
        <Button title="Scan mailbox" kind="secondary" busy={busy === 'scan'} onPress={() => void scan()} />
        {discovery?.entries.map((entry) => (
          <View key={entry.institutionId} style={ui.row}>
            <Label>{getInstitution(entry.institutionId)?.name ?? entry.institutionId}</Label>
            <Pill text={`~${entry.estimatedMessages}`} tone={entry.estimatedMessages > 0 ? 'ok' : 'warn'} />
          </View>
        ))}
      </Card>

      <Card>
        <Title>Backend sync history</Title>
        {runs.length === 0 && <Muted>No runs yet. The first scheduled sweep starts within 30 minutes of connecting.</Muted>}
        {runs.slice(0, 20).map((run) => (
          <Muted key={run.id}>
            {formatTimestamp(run.startedAt)} · {run.status} · {run.newMessages} new{run.errorMessage ? ` · ${run.errorMessage}` : ''}
          </Muted>
        ))}
      </Card>

      <Card>
        <Title>On-device sync history</Title>
        {localRuns.length === 0 && <Muted>No local runs yet.</Muted>}
        {localRuns.slice(0, 20).map((run) => (
          <Muted key={run.id}>
            {formatTimestamp(run.started_at)} · {run.source} · {run.status} · {run.inserted} new of {run.received}
            {run.error_message ? ` · ${run.error_message}` : ''}
          </Muted>
        ))}
      </Card>

      <Button title="Disconnect and revoke access" kind="danger" onPress={confirmDisconnect} />
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48, gap: 4 } });
