import { ScrollView, StyleSheet, View } from 'react-native';
import { formatPaise } from '@fi/core';
import { useFinance } from '../lib/useFinance';
import { Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

export default function InsightsScreen() {
  const p = usePalette();
  const { state } = useFinance();
  if (!state) return null;
  const { insights, potentialSavings, recurring } = state;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content}>
      <Card>
        <Title>Potential savings</Title>
        <Label>
          {formatPaise(potentialSavings.monthlyPaise)} a month · {formatPaise(potentialSavings.annualPaise)} a year
        </Label>
        {potentialSavings.oneTimePaise > 0 && <Muted>Plus {formatPaise(potentialSavings.oneTimePaise)} in possible duplicate charges to check.</Muted>}
        <Muted>
          Based on your last 3 months compared with the 3 before. These are potential savings, not guaranteed. Each transaction counts towards at most one
          estimate, and essentials (groceries, rent, utilities, health…) are never treated as waste.
        </Muted>
      </Card>

      {insights.length === 0 && (
        <Card>
          <Muted>No avoidable-spending patterns found yet. Insights need a few months of imported transactions.</Muted>
        </Card>
      )}

      {insights.map((i) => (
        <Card key={i.id}>
          <View style={ui.row}>
            <Title>{i.title}</Title>
            <Pill text={`${i.confidence} confidence`} tone={i.confidence === 'high' ? 'ok' : i.confidence === 'medium' ? 'warn' : 'muted'} />
          </View>
          <Label>{i.finding}</Label>
          <Muted>
            Observed {formatPaise(i.observedMonthlyPaise)}/month
            {i.baselineMonthlyPaise !== null ? ` · before ${formatPaise(i.baselineMonthlyPaise)}/month` : ''}
          </Muted>
          {(i.estMonthlySavingsPaise > 0 || i.oneTimePaise > 0) && (
            <Label>
              {i.estMonthlySavingsPaise > 0 ? `Could save ${formatPaise(i.estMonthlySavingsPaise)}/month (${formatPaise(i.estAnnualSavingsPaise)}/year)` : `Possibly recoverable: ${formatPaise(i.oneTimePaise)}`}
            </Label>
          )}
          <Muted>Suggested: {i.action}</Muted>
          <Muted>Based on {i.evidence.length} transaction(s).</Muted>
        </Card>
      ))}

      {recurring.length > 0 && (
        <Card>
          <Title>Recurring payments</Title>
          {recurring.map((r) => (
            <Muted key={r.counterparty + r.lastDate}>
              {r.counterparty} · {formatPaise(r.typicalAmountPaise)} {r.cadence} · next ~{r.nextExpectedDate} ({r.occurrences} seen)
            </Muted>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const screen = StyleSheet.create({ content: { padding: 16, paddingBottom: 48 } });
