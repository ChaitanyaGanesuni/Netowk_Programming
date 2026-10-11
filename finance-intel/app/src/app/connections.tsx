import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import { buildConnectionRows, formatAge, type ConnectionRowView } from '@fi/core';
import { useAppState } from '../lib/AppState';
import {
  Button,
  Card,
  DATA_KIND_LABEL,
  FreshnessPill,
  Label,
  Muted,
  PRODUCT_TYPE_LABEL,
  StatusPill,
  Title,
  formatTimestamp,
  styles as ui,
  usePalette,
} from '../components/ui';

function ConnectionCard({ row, onAction }: { row: ConnectionRowView; onAction: (row: ConnectionRowView) => void }) {
  const p = usePalette();
  const actionTitle = row.action === 'connect_gmail' ? 'Connect Gmail' : row.action === 'reconnect_gmail' ? 'Reconnect Gmail' : 'Retry';
  return (
    <Card>
      <View style={ui.row}>
        <Title>{row.name}</Title>
        <StatusPill status={row.status} label={row.statusLabel} />
      </View>
      {row.accountTypes.length > 0 && <Muted>{row.accountTypes.map((t) => PRODUCT_TYPE_LABEL[t]).join(' · ')}</Muted>}
      {row.products.length > 0 && <Label>{row.products.join(', ')}</Label>}
      <Muted>Data: {row.dataAvailable.map((k) => DATA_KIND_LABEL[k]).join(', ')}</Muted>
      <View style={ui.row}>
        <Muted>
          Last successful sync: {formatTimestamp(row.lastSuccessAt)}
          {row.freshness.ageMs !== null ? ` (${formatAge(row.freshness.ageMs)} ago)` : ''}
        </Muted>
        <FreshnessPill level={row.freshness.level} />
      </View>
      {row.messagesFound !== null && <Muted>Finance emails found: {row.messagesFound}</Muted>}
      <Muted>
        Consent: {row.consentExpiresAt ? `expires ${formatTimestamp(row.consentExpiresAt)}` : row.consentNote}
      </Muted>
      {row.lastError && <Text style={[ui.small, { color: p.danger }]}>Last error: {row.lastError}</Text>}
      {row.status === 'no_emails_found' && (
        <Muted>No emails from this institution’s known senders yet. Turn on email alerts/e-statements with them, or send a sample so the sender list can be corrected.</Muted>
      )}
      {row.limitations.map((limitation) => (
        <Muted key={limitation}>• {limitation}</Muted>
      ))}
      {row.action && <Button title={actionTitle} kind={row.action === 'retry' ? 'secondary' : 'primary'} onPress={() => onAction(row)} />}
    </Card>
  );
}

export default function ConnectionsScreen() {
  const state = useAppState();
  const p = usePalette();
  const { reload } = state;

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => undefined);
    }, [reload]),
  );

  const rows = useMemo(
    () => (state.snapshot ? buildConnectionRows(state.snapshot.connections, state.snapshot.feeds, Date.now()) : []),
    [state.snapshot],
  );
  const gmail = state.snapshot?.connections.find((c) => c.provider === 'gmail');

  if (!state.ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!state.credentials) return <Redirect href="/setup" />;

  const run = (task: () => Promise<void>) => {
    task().catch((error: unknown) => Alert.alert('Something went wrong', error instanceof Error ? error.message : String(error)));
  };

  const onAction = (row: ConnectionRowView) => {
    if (row.action === 'connect_gmail' || row.action === 'reconnect_gmail') run(state.connectGmail);
    else run(state.syncNow);
  };

  return (
    <ScrollView
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={screen.content}
      refreshControl={<RefreshControl refreshing={state.syncing} onRefresh={() => run(state.syncNow)} />}
    >
      <Card>
        <Title>Data sources</Title>
        <Muted>
          Bank, card and investment data arrive through read-only Gmail access to the emails your institutions already send you.
          The backend checks your mailbox every 30 minutes even when this app is closed. Mutual fund NAVs come from AMFI’s public feed.
        </Muted>
        {gmail ? (
          <Link href={`/connection/${gmail.id}`} style={[ui.body, { color: p.accent }]}>
            Gmail {gmail.accountLabel} — details, history and disconnect ›
          </Link>
        ) : (
          <Button title="Connect Gmail (read-only)" onPress={() => run(state.connectGmail)} />
        )}
        <Button title="Sync now" kind="secondary" busy={state.syncing} onPress={() => run(state.syncNow)} />
        {state.message && <Label>{state.message}</Label>}
        {state.snapshot && (
          <Muted>
            {state.snapshot.pendingMessages} finance emails waiting to be read · connection list updated{' '}
            {formatTimestamp(state.snapshot.connectionsFetchedAt)}
          </Muted>
        )}
      </Card>

      {rows.map((row) => (
        <ConnectionCard key={row.institutionId} row={row} onAction={onAction} />
      ))}

      <Card>
        <Title>Not connected</Title>
        <Muted>
          Account Aggregator (needs a regulated entity), broker APIs for Groww and Bajaj Broking (paid or unpublished pricing),
          digital/physical gold, EPF and PPF. See INTEGRATION_FEASIBILITY.md for details.
        </Muted>
      </Card>
      <Button title="Documents & statement passwords" kind="secondary" onPress={() => router.push('/documents')} />
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48 } });
