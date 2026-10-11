import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput } from 'react-native';
import { router } from 'expo-router';
import { enrollDevice } from '../lib/api';
import { exportAllData } from '../lib/exportData';
import { useAppState } from '../lib/AppState';
import { saveBackendCredentials } from '../lib/secrets';
import { normalizeBackendUrl } from '../lib/url';
import { Button, Card, Label, Muted, Title, usePalette } from '../components/ui';

export default function SetupScreen() {
  const state = useAppState();
  const p = usePalette();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const input = [screen.input, { color: p.text, borderColor: p.border, backgroundColor: p.card }];

  const enroll = async () => {
    setBusy(true);
    try {
      const backendUrl = normalizeBackendUrl(url);
      const { deviceToken } = await enrollDevice(backendUrl, code.trim(), 'Android phone');
      const credentials = { backendUrl, deviceToken };
      await saveBackendCredentials(credentials);
      state.setCredentials(credentials);
      router.replace('/');
    } catch (error) {
      Alert.alert('Could not enrol this device', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmForget = () =>
    Alert.alert(
      'Delete all local data?',
      'This deletes the encrypted database and keys on this phone. Your Gmail connection stays on the backend; disconnect it first to revoke access.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void state.forgetDevice() },
      ],
    );

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content} keyboardShouldPersistTaps="handled">
      {!state.credentials ? (
        <Card>
          <Title>Connect this phone to your backend</Title>
          <Muted>
            Enter the URL of your Cloudflare Worker and the enrollment code you set with `wrangler secret put ENROLLMENT_CODE` (see SETUP.md).
            The device token is stored in the Android Keystore.
          </Muted>
          <TextInput style={input} placeholder="https://finance-intel.<you>.workers.dev" placeholderTextColor={p.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" value={url} onChangeText={setUrl} />
          <TextInput style={input} placeholder="Enrollment code" placeholderTextColor={p.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry value={code} onChangeText={setCode} />
          <Button title="Enrol device" busy={busy} disabled={!url || code.length < 16} onPress={() => void enroll()} />
        </Card>
      ) : (
        <Card>
          <Title>This device is enrolled</Title>
          <Label>{state.credentials.backendUrl}</Label>
        </Card>
      )}
      <Card>
        <Title>Privacy</Title>
        <Muted>
          • The app never asks for net-banking passwords, PINs or OTPs.{'\n'}
          • Gmail access is read-only, and the backend only lets this app open messages from known financial senders.{'\n'}
          • Parsed financial data stays in an encrypted database on this phone; Android cloud backup is disabled for the app.{'\n'}
          • The backend stores encrypted OAuth tokens and message IDs only — no email contents or amounts.
        </Muted>
        <Button
          title="Export all my data (JSON)"
          kind="secondary"
          onPress={() => void exportAllData().catch((e: unknown) => Alert.alert('Export failed', e instanceof Error ? e.message : String(e)))}
        />
        <Button title="Delete all local data" kind="danger" onPress={confirmForget} />
      </Card>
    </ScrollView>
  );
}

const screen = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
