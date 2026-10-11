import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppStateProvider } from '../lib/AppState';

export default function RootLayout() {
  return (
    <AppStateProvider>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Connections' }} />
        <Stack.Screen name="setup" options={{ title: 'Set up' }} />
        <Stack.Screen name="connection/[id]" options={{ title: 'Gmail connection' }} />
        <Stack.Screen name="oauth" options={{ headerShown: false }} />
      </Stack>
    </AppStateProvider>
  );
}
