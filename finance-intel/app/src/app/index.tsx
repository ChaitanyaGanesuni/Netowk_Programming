import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, type Href } from 'expo-router';
import { formatPaise } from '@fi/core';
import { useAppState } from '../lib/AppState';
import { useFinance } from '../lib/useFinance';
import { IncomeExpenseBars, LineChart } from '../components/charts';
import { Button, Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

const NAV: Array<{ title: string; href: Href }> = [
  { title: 'Transactions', href: '/transactions' },
  { title: 'Spending insights', href: '/insights' },
  { title: 'Portfolio', href: '/portfolio' },
  { title: 'Ask the assistant', href: '/assistant' },
  { title: 'Monthly report', href: '/report' },
  { title: 'Documents & passwords', href: '/documents' },
  { title: 'Imported investments', href: '/investments' },
  { title: 'Connections', href: '/connections' },
  { title: 'Settings & privacy', href: '/setup' },
];

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

export default function Dashboard() {
  const app = useAppState();
  const p = usePalette();
  const { state, error, reload } = useFinance();

  if (!app.ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!app.credentials) return <Redirect href="/setup" />;

  const sync = () => {
    app
      .syncNow()
      .then(reload)
      .catch((e: unknown) => Alert.alert('Sync failed', e instanceof Error ? e.message : String(e)));
  };

  const nw = state?.netWorth;
  const month = state?.thisMonth;
  const stale = nw?.items.filter((i) => i.freshness === 'stale' || i.freshness === 'aging') ?? [];
  const upcomingRecurring = (state?.recurring ?? []).filter((r) => r.nextExpectedDate <= new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content} refreshControl={<RefreshControl refreshing={app.syncing} onRefresh={sync} />}>
      <Card>
        <Muted>Net worth</Muted>
        <Text style={[screen.big, { color: p.text }]}>{nw && nw.items.length ? formatPaise(nw.netWorthPaise) : '—'}</Text>
        {nw && nw.items.length > 0 && (
          <Muted>
            Assets {formatPaise(nw.assetsPaise)} · Liabilities {formatPaise(nw.liabilitiesPaise)}
            {'\n'}Bank {formatPaise(nw.bankPaise)} · Investments {formatPaise(nw.investmentsPaise)} · Cards owed {formatPaise(nw.cardOutstandingPaise)}
          </Muted>
        )}
        {nw && nw.items.length === 0 && <Muted>No balances or holdings imported yet. Connect Gmail, save your PAN under Documents, then sync.</Muted>}
        {stale.length > 0 && <Text style={[ui.small, { color: p.warn }]}>Older data: {stale.map((i) => `${i.label} (${i.asOf})`).slice(0, 4).join(', ')}</Text>}
        {nw?.notes.map((n) => <Muted key={n}>• {n}</Muted>)}
        <Button title="Sync now" kind="secondary" busy={app.syncing} onPress={sync} />
        {app.message && <Label>{app.message}</Label>}
        {error && <Text style={[ui.small, { color: p.danger }]}>{error}</Text>}
      </Card>

      {state && state.netWorthHistory.length >= 2 && (
        <Card>
          <Title>Net worth over time</Title>
          <LineChart points={state.netWorthHistory.map((h) => ({ label: h.date, value: h.netWorthPaise }))} />
        </Card>
      )}

      {month && (
        <Card>
          <Title>This month ({month.month})</Title>
          <Muted>
            Income {formatPaise(month.incomePaise)} · Spending {formatPaise(month.expensePaise)}
            {month.loanRepaymentPaise ? ` · Loans ${formatPaise(month.loanRepaymentPaise)}` : ''}
          </Muted>
          <Label>
            Net cash flow {formatPaise(month.netCashFlowPaise)} · Savings rate {pct(month.savingsRate)}
          </Label>
          <Muted>Invested this month {formatPaise(month.netInvestedPaise)} (not counted as spending).</Muted>
          {month.pendingPaise > 0 && <Muted>Includes {formatPaise(month.pendingPaise)} of card spends not yet on a statement.</Muted>}
          {state && (
            <IncomeExpenseBars months={state.months.slice(-6).map((m) => ({ label: m.month.slice(5), income: m.incomePaise, expense: m.expensePaise }))} />
          )}
          <Muted>Green: income · Red: spending</Muted>
        </Card>
      )}

      {state && (state.upcomingDues.length > 0 || upcomingRecurring.length > 0) && (
        <Card>
          <Title>Upcoming payments</Title>
          {state.upcomingDues.map((d) => (
            <View key={d.label + d.dueDate} style={ui.row}>
              <Label>{d.label}</Label>
              <Pill text={`due ${d.dueDate}`} tone="warn" />
              <Muted>
                {formatPaise(d.totalDuePaise)} (min {formatPaise(d.minDuePaise)})
              </Muted>
            </View>
          ))}
          {upcomingRecurring.map((r) => (
            <Muted key={r.counterparty + r.nextExpectedDate}>
              ~{r.nextExpectedDate} · {r.counterparty} · {formatPaise(r.typicalAmountPaise)} ({r.cadence})
            </Muted>
          ))}
        </Card>
      )}

      {state && state.insights.length > 0 && (
        <Card>
          <Title>Potential savings</Title>
          <Label>
            About {formatPaise(state.potentialSavings.monthlyPaise)}/month ({formatPaise(state.potentialSavings.annualPaise)}/year) — potential, not guaranteed.
          </Label>
          {state.insights.slice(0, 3).map((i) => (
            <Muted key={i.id}>• {i.title}: {i.finding}</Muted>
          ))}
          <Button title="See all insights" kind="secondary" onPress={() => router.push('/insights')} />
        </Card>
      )}

      {state && state.balanceGaps.length > 0 && (
        <Card>
          <Title>Balance checks</Title>
          <Muted>
            Stated balances don’t match the imported transactions in {state.balanceGaps.length} place(s) — usually a transaction that had no email alert (e.g. SMS-only).
            Enable email alerts for all transactions to close these gaps. Nothing is invented to fill them.
          </Muted>
        </Card>
      )}

      <View style={screen.grid}>
        {NAV.map((n) => (
          <Pressable key={n.title} accessibilityRole="button" onPress={() => router.push(n.href)} style={[screen.tile, { backgroundColor: p.card, borderColor: p.border }]}>
            <Text style={[ui.body, { color: p.accent }]}>{n.title}</Text>
          </Pressable>
        ))}
      </View>
      <Muted>Figures are calculated from your imported data. This app does not give investment advice or execute trades.</Muted>
    </ScrollView>
  );
}

const screen = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  big: { fontSize: 30, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tile: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 12, width: '48%' },
});
