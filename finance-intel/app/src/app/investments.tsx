import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { formatPaise, formatUnits } from '@fi/core';
import { loadInvestments, type HoldingView, type ImportWarning, type SchemeView } from '../lib/investments';
import { Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

/**
 * Verification view of everything imported from statements, so you can compare it with your
 * CAS before the dashboards (Phase 5) build on it. Figures are statement data, not estimates.
 */
export default function InvestmentsScreen() {
  const p = usePalette();
  const [data, setData] = useState<{ schemes: SchemeView[]; holdings: HoldingView[]; warnings: ImportWarning[] } | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadInvestments().then(setData).catch(() => undefined);
    }, []),
  );

  if (!data) return null;
  const accounts = [...new Set(data.holdings.map((h) => h.accountKey))];

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      {data.schemes.length === 0 && data.holdings.length === 0 && (
        <Card>
          <Title>Nothing imported yet</Title>
          <Muted>Save your PAN under Documents and sync. Imports appear here after a CAS statement email is processed.</Muted>
        </Card>
      )}

      {data.warnings.length > 0 && (
        <Card>
          <Title>Statement checks</Title>
          <Muted>The parser cross-checks every row against the statement’s running unit balance. These need a look:</Muted>
          {data.warnings.flatMap((w) => w.warnings.map((text, i) => (
            <Text key={`${w.issuer}${w.periodTo}${i}`} style={[ui.small, { color: p.warn }]}>
              {w.issuer} {w.periodTo ?? ''}: {text}
            </Text>
          )))}
        </Card>
      )}

      {data.schemes.length > 0 && <Title>Mutual fund folios</Title>}
      {data.schemes.map((s) => {
        const historyIncomplete = s.transactionUnitsMicro !== null && s.unitsMicro !== null && s.transactionUnitsMicro !== s.unitsMicro;
        return (
          <Card key={s.key}>
            <Label>{s.scheme}</Label>
            <Muted>
              {s.amc} · folio {s.folio} · {s.isin ?? 'ISIN unknown'}
            </Muted>
            <Muted>
              Units: {formatUnits(s.unitsMicro)} (statement of {s.unitsAsOf ?? '—'}) · statement value {formatPaise(s.statementValuePaise)}
              {s.costPaise !== null ? ` · cost ${formatPaise(s.costPaise)}` : ''}
            </Muted>
            <Muted>
              {s.currentValuePaise !== null
                ? `Value at AMFI NAV ${formatUnits(s.navMicro)} on ${s.navDate}: ${formatPaise(s.currentValuePaise)}`
                : 'No AMFI NAV for this ISIN yet (sync to fetch NAVs).'}
            </Muted>
            <View style={ui.row}>
              <Muted>
                {s.transactionCount} transactions{s.lastTransactionDate ? `, last on ${s.lastTransactionDate}` : ''}
              </Muted>
              {historyIncomplete && <Pill text="history incomplete" tone="warn" />}
            </View>
            {historyIncomplete && (
              <Muted>
                Imported transactions add up to {formatUnits(s.transactionUnitsMicro)} units, not {formatUnits(s.unitsMicro)}. Request a Detailed CAS
                “since inception” to fill the gap; nothing is guessed.
              </Muted>
            )}
          </Card>
        );
      })}

      {accounts.length > 0 && <Title>Demat holdings</Title>}
      {accounts.map((key) => {
        const rows = data.holdings.filter((h) => h.accountKey === key);
        const first = rows[0]!;
        return (
          <Card key={key}>
            <Label>
              {first.broker} {first.clientIdTail ? `(…${first.clientIdTail})` : ''}
            </Label>
            <Muted>
              {first.depository} statement as on {first.asOf}. Prices are the statement’s closing prices.
            </Muted>
            {rows.map((h) => (
              <Muted key={`${h.isin}${h.asOf}`}>
                {h.name ?? h.isin} · {formatUnits(h.quantityMicro)} {h.kind === 'equity' ? 'shares' : 'units'} · {formatPaise(h.valuePaise)}
              </Muted>
            ))}
          </Card>
        );
      })}
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48, gap: 4 } });
