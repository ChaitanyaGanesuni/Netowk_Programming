import { useCallback, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { formatPaise, type Category, type LedgerTxn } from '@fi/core';
import { currentMonth, deleteCategoryRule, saveCategoryRule } from '../lib/finance';
import { getDatabase } from '../lib/database';
import { useFinance } from '../lib/useFinance';
import { Button, Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

const CATEGORIES: Category[] = [
  'groceries', 'food_delivery', 'dining', 'shopping', 'transport', 'fuel', 'travel', 'utilities', 'telecom', 'subscriptions',
  'entertainment', 'health', 'education', 'rent', 'insurance', 'loan_emi', 'investments', 'credit_card_payment', 'bank_charges',
  'late_fees', 'cash', 'transfers', 'taxes', 'salary', 'interest', 'refund', 'income_other', 'other',
];

const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};

export default function TransactionsScreen() {
  const p = usePalette();
  const { state, reload } = useFinance();
  const [month, setMonth] = useState(currentMonth());
  const [editing, setEditing] = useState<LedgerTxn | null>(null);
  const [rules, setRules] = useState<Array<{ pattern: string; category: string }>>([]);

  const loadRules = useCallback(async () => {
    const db = await getDatabase();
    setRules(await db.getAllAsync('SELECT pattern, category FROM category_rules ORDER BY created_at DESC'));
  }, []);
  useFocusEffect(
    useCallback(() => {
      void loadRules();
    }, [loadRules]),
  );

  const rows = useMemo(() => (state?.ledger ?? []).filter((t) => t.date.startsWith(month)).sort((a, b) => b.at - a.at), [state, month]);
  const accountLabel = (key: string) => state?.accounts.find((a) => a.key === key)?.label ?? key;

  const choose = async (category: Category) => {
    if (!editing) return;
    const pattern = editing.counterparty ?? editing.description;
    await saveCategoryRule(pattern, category, null);
    setEditing(null);
    await Promise.all([reload(), loadRules()]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(t) => t.key}
        contentContainerStyle={screen.content}
        ListHeaderComponent={
          <Card>
            <View style={ui.row}>
              <Button title="‹" kind="secondary" onPress={() => setMonth(shiftMonth(month, -1))} />
              <Title>{month}</Title>
              <Button title="›" kind="secondary" disabled={month >= currentMonth()} onPress={() => setMonth(shiftMonth(month, 1))} />
            </View>
            <Muted>
              {rows.length} transactions. Tap one to correct its category — the app remembers it for that counterparty. Transfers between your accounts and card bill
              payments are matched automatically and excluded from spending.
            </Muted>
          </Card>
        }
        ListEmptyComponent={<Muted>No transactions imported for this month.</Muted>}
        renderItem={({ item: t }) => (
          <Pressable onPress={() => setEditing(t)} accessibilityRole="button" accessibilityHint="Change category">
            <Card>
              <View style={ui.row}>
                <Label>{t.counterparty ?? t.description}</Label>
                <Text style={[ui.body, { color: t.direction === 'credit' ? p.ok : p.text, marginLeft: 'auto' }]}>
                  {t.direction === 'credit' ? '+' : '−'}
                  {formatPaise(t.amountPaise)}
                </Text>
              </View>
              <Muted>
                {t.date} · {accountLabel(t.accountKey)} · {t.channel}
              </Muted>
              <View style={ui.row}>
                <Pill text={t.category.replace(/_/g, ' ')} tone={t.categorySource === 'user' ? 'accent' : 'muted'} />
                <Pill text={t.kind.replace(/_/g, ' ')} tone={t.kind === 'expense' || t.kind === 'fee' ? 'warn' : 'muted'} />
                {t.status === 'pending' && <Pill text="pending" tone="muted" />}
                {t.confidence < 0.6 && <Pill text="check" tone="danger" />}
              </View>
            </Card>
          </Pressable>
        )}
        ListFooterComponent={
          rules.length ? (
            <Card>
              <Title>Your category rules</Title>
              {rules.map((r) => (
                <View key={r.pattern} style={ui.row}>
                  <Muted>
                    “{r.pattern}” → {r.category.replace(/_/g, ' ')}
                  </Muted>
                  <Button title="Remove" kind="secondary" onPress={() => void deleteCategoryRule(r.pattern).then(() => Promise.all([reload(), loadRules()]))} />
                </View>
              ))}
            </Card>
          ) : null
        }
      />
      <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={screen.modalBackdrop}>
          <View style={[screen.modal, { backgroundColor: p.card }]}>
            <Title>Category for “{editing?.counterparty ?? editing?.description}”</Title>
            <ScrollView>
              {CATEGORIES.map((c) => (
                <Pressable key={c} onPress={() => void choose(c)} style={screen.option} accessibilityRole="button">
                  <Text style={[ui.body, { color: c === editing?.category ? p.accent : p.text }]}>{c.replace(/_/g, ' ')}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button title="Cancel" kind="secondary" onPress={() => setEditing(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const screen = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { maxHeight: '75%', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 8 },
  option: { paddingVertical: 10 },
});
