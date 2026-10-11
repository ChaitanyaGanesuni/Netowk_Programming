import { useCallback, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getInstitution } from '@fi/core';
import { useAppState } from '../lib/AppState';
import { listDocuments, redactedSampleFor, requeueDocuments, type DocumentRow, type DocumentStatus } from '../lib/documents';
import { loadDocumentPasswords, saveDocumentPasswords } from '../lib/secrets';
import { Button, Card, Label, Muted, Pill, Title, formatTimestamp, styles as ui, usePalette, type Palette } from '../components/ui';

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

const STATUS: Record<DocumentStatus, { label: string; tone: keyof Palette }> = {
  imported: { label: 'Imported', tone: 'ok' },
  needs_password: { label: 'Needs password', tone: 'warn' },
  unsupported: { label: 'Unsupported', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
  awaiting_parser: { label: 'No parser yet', tone: 'muted' },
  skipped: { label: 'Not financial data', tone: 'muted' },
};

export default function DocumentsScreen() {
  const state = useAppState();
  const p = usePalette();
  const [pan, setPan] = useState('');
  const [panSaved, setPanSaved] = useState(false);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await listDocuments();
    setRows(result.rows);
    setCounts(result.counts);
    setPanSaved(Boolean((await loadDocumentPasswords()).pan));
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => undefined);
    }, [reload]),
  );

  const savePan = async () => {
    const value = pan.trim().toUpperCase();
    if (!PAN_RE.test(value)) {
      Alert.alert('Check the PAN', 'A PAN looks like ABCDE1234F.');
      return;
    }
    setBusy('pan');
    try {
      const passwords = await loadDocumentPasswords();
      await saveDocumentPasswords({ ...passwords, pan: value });
      setPan('');
      const requeued = await requeueDocuments(['needs_password']);
      await reload();
      Alert.alert('Saved', requeued ? `${requeued} statement(s) will be retried on the next sync.` : 'Statements will open on the next sync.');
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('retry');
    try {
      const n = await requeueDocuments(['failed', 'needs_password']);
      await state.syncNow();
      await reload();
      if (!n) Alert.alert('Nothing to retry');
    } finally {
      setBusy(null);
    }
  };

  const shareSample = async (row: DocumentRow) => {
    if (!state.client) return;
    setBusy(row.message_id);
    try {
      const sample = await redactedSampleFor(state.client, row.connection_id, row.message_id);
      Alert.alert('Review before sharing', `${sample.slice(0, 700)}${sample.length > 700 ? '…' : ''}`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Share', onPress: () => void Share.share({ message: sample }) },
      ]);
    } catch (error) {
      Alert.alert('Could not load the email', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      <Card>
        <Title>Statement passwords</Title>
        <Muted>
          CAS statements from CAMS, KFintech, CDSL and NSDL are PDFs locked with your PAN. It is stored in the Android Keystore and used only on this
          phone to open those PDFs. It is not a banking password.
        </Muted>
        <Label>{panSaved ? 'PAN saved ✓ (enter again to replace)' : 'PAN not saved yet'}</Label>
        <TextInput
          style={[screen.input, { color: p.text, borderColor: p.border, backgroundColor: p.card }]}
          placeholder="ABCDE1234F"
          placeholderTextColor={p.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          secureTextEntry
          maxLength={10}
          value={pan}
          onChangeText={setPan}
        />
        <Button title="Save PAN" busy={busy === 'pan'} disabled={pan.trim().length !== 10} onPress={() => void savePan()} />
      </Card>

      <Card>
        <Title>Mutual fund history</Title>
        <Muted>
          For your full history since your first investment, request a Detailed CAS once from CAMS and once from KFintech (period: since inception),
          delivered to this Gmail. It is imported automatically when it arrives. Monthly CDSL/NSDL statements then keep holdings current.
        </Muted>
      </Card>

      <Card>
        <Title>Processed emails</Title>
        <View style={ui.row}>
          {(Object.keys(STATUS) as DocumentStatus[]).map((s) =>
            counts[s] ? <Pill key={s} text={`${STATUS[s].label}: ${counts[s]}`} tone={STATUS[s].tone} /> : null,
          )}
        </View>
        {rows.length === 0 && <Muted>Nothing processed yet. Documents are read during each sync, statements first.</Muted>}
        <Button title="Retry failed and password-locked" kind="secondary" busy={busy === 'retry'} onPress={() => void retry()} />
      </Card>

      {rows.map((row) => (
        <Card key={`${row.connection_id}:${row.message_id}`}>
          <View style={ui.row}>
            <Label>{getInstitution(row.institution_id)?.name ?? row.institution_id}</Label>
            <Pill text={STATUS[row.status].label} tone={STATUS[row.status].tone} />
          </View>
          <Muted>
            {formatTimestamp(row.received_at)} · {row.kind.replace(/_/g, ' ')}
          </Muted>
          <Text style={[ui.small, { color: p.text }]} numberOfLines={2}>
            {row.subject || '(no subject)'}
          </Text>
          {row.detail && <Muted>{row.detail}</Muted>}
          {row.warnings && (
            <Text style={[ui.small, { color: p.warn }]}>
              Check: {(JSON.parse(row.warnings) as string[]).slice(0, 3).join(' · ')}
            </Text>
          )}
          {(row.status === 'awaiting_parser' || row.status === 'unsupported') && (
            <Button title="Share a redacted sample (helps build its parser)" kind="secondary" busy={busy === row.message_id} onPress={() => void shareSample(row)} />
          )}
        </Card>
      ))}
    </ScrollView>
  );
}

const screen = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, letterSpacing: 2 },
});
