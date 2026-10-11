import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { formatPaise, UNAVAILABLE_ANALYTICS } from '@fi/core';
import { useFinance } from '../lib/useFinance';
import { ShareBars } from '../components/charts';
import { Button, Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

export default function PortfolioScreen() {
  const p = usePalette();
  const { state } = useFinance();
  if (!state) return null;
  const pf = state.portfolio;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      <Card>
        <Title>Portfolio</Title>
        <Label>Value {formatPaise(pf.valuePaise)}</Label>
        <Muted>
          Invested (cost of units held) {formatPaise(pf.investedPaise)} · Unrealised gain {formatPaise(pf.unrealizedGainPaise)} · Realised gain {formatPaise(pf.realizedGainPaise)}
        </Muted>
        <Label>XIRR {pct(pf.xirr)}</Label>
        {pf.costIncomplete && (
          <Muted>
            Some holdings lack full purchase history (or are demat holdings without cost data), so totals marked “—” exclude them. Request a Detailed CAS since inception to complete it.
          </Muted>
        )}
        <Button title="Imported holdings (verification view)" kind="secondary" onPress={() => router.push('/investments')} />
      </Card>

      {pf.allocation.length > 0 && (
        <Card>
          <Title>Asset allocation (incl. bank balances)</Title>
          <ShareBars rows={pf.allocation.map((s) => ({ label: s.assetClass.replace(/_/g, ' '), share: s.share, caption: `${pct(s.share)} · ${formatPaise(s.valuePaise)}` }))} />
          <Muted>Fund classes come from AMFI’s SEBI category for each scheme.</Muted>
        </Card>
      )}

      <Card>
        <Title>Risk</Title>
        <Muted>
          Largest holding: {pf.concentration.largest ? `${pf.concentration.largest.name} (${pct(pf.concentration.largest.share)})` : '—'} · Top 5: {pct(pf.concentration.top5Share)}
        </Muted>
        <Muted>Emergency reserve: {state.emergencyReserveMonths === null ? 'needs a few months of spending data' : `${state.emergencyReserveMonths} months of spending in bank balances`}</Muted>
        <Title>Hypothetical scenarios</Title>
        {pf.scenarios.map((s) => (
          <Muted key={s.name}>
            {s.name}: {formatPaise(s.impactPaise)}
          </Muted>
        ))}
        <Muted>Illustrations of sensitivity, not forecasts. No returns are promised and no trades are suggested.</Muted>
      </Card>

      <Card>
        <Title>Holdings</Title>
        {pf.holdings.length === 0 && <Muted>No holdings imported yet.</Muted>}
        {pf.holdings.map((h) => (
          <View key={h.id} style={screen.holding}>
            <View style={ui.row}>
              <Label>{h.name}</Label>
              <Pill text={h.assetClass.replace(/_/g, ' ')} tone="muted" />
            </View>
            <Muted>
              {formatPaise(h.valuePaise)}
              {h.gainPaise !== null ? ` · gain ${formatPaise(h.gainPaise)}` : ''}
              {h.xirr !== null ? ` · XIRR ${pct(h.xirr)}` : ''}
              {h.costIncomplete ? ' · cost history incomplete' : ''}
            </Muted>
          </View>
        ))}
      </Card>

      <Card>
        <Title>Not available</Title>
        {UNAVAILABLE_ANALYTICS.map((u) => (
          <Muted key={u.metric}>
            • {u.metric}: {u.reason}
          </Muted>
        ))}
      </Card>
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48 }, holding: { paddingVertical: 6, gap: 2 } });
