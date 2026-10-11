import { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { ledgerToCsv, monthlyReport } from '@fi/core';
import { currentMonth } from '../lib/finance';
import { shareTextFile } from '../lib/exportData';
import { useFinance } from '../lib/useFinance';
import { Button, Card, Muted, Title, styles as ui, usePalette } from '../components/ui';

export default function ReportScreen() {
  const p = usePalette();
  const { state } = useFinance();
  const [index, setIndex] = useState(0); // 0 = this month, 1 = last month, …

  const report = useMemo(() => {
    if (!state) return null;
    const months = state.months;
    const m = months[months.length - 1 - index];
    if (!m) return null;
    const prev = months[months.length - 2 - index] ?? null;
    return { month: m.month, text: monthlyReport(m, prev, index === 0 ? state.insights : [], index === 0 && state.netWorth.items.length ? state.netWorth.netWorthPaise : null) };
  }, [state, index]);

  if (!state || !report) return null;

  const share = (name: string, body: string, mime: string) => {
    shareTextFile(name, body, mime).catch((e: unknown) => Alert.alert('Could not share', e instanceof Error ? e.message : String(e)));
  };

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      <Card>
        <Title>Monthly report — {report.month}</Title>
        <Button title="Previous month" kind="secondary" disabled={index >= state.months.length - 1} onPress={() => setIndex(index + 1)} />
        <Button title="Next month" kind="secondary" disabled={index === 0} onPress={() => setIndex(index - 1)} />
        <Text style={[ui.small, screen.mono, { color: p.text }]}>{report.text}</Text>
        <Button title="Share report" onPress={() => share(`finance-report-${report.month}.txt`, report.text, 'text/plain')} />
        <Button title="Export all transactions (CSV)" kind="secondary" onPress={() => share(`transactions-${currentMonth()}.csv`, ledgerToCsv(state.ledger), 'text/csv')} />
        <Muted>Files are created on this phone and shared only where you choose.</Muted>
      </Card>
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48 }, mono: { fontFamily: 'monospace' } });
