import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppStateProvider } from '../lib/AppState';
import { PdfEngineHost } from '../lib/pdfEngine';

export default function RootLayout() {
  return (
    <AppStateProvider>
      <StatusBar style="auto" />
      <PdfEngineHost />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Connections' }} />
        <Stack.Screen name="setup" options={{ title: 'Set up' }} />
        <Stack.Screen name="connection/[id]" options={{ title: 'Gmail connection' }} />
        <Stack.Screen name="documents" options={{ title: 'Documents' }} />
        <Stack.Screen name="investments" options={{ title: 'Imported investments' }} />
        <Stack.Screen name="oauth" options={{ headerShown: false }} />
      </Stack>
    </AppStateProvider>
  );
}
