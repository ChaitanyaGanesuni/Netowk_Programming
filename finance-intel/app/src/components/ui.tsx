import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { DataKind, FreshnessLevel, ProductType, RowStatus } from '@fi/core';

export interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  danger: string;
  ok: string;
  warn: string;
}

const LIGHT: Palette = { bg: '#F6F7F9', card: '#FFFFFF', text: '#14171C', muted: '#5D6673', border: '#E1E4E8', accent: '#1F5FBF', danger: '#B3261E', ok: '#1E7A3C', warn: '#9A6200' };
const DARK: Palette = { bg: '#0F1115', card: '#181B21', text: '#EEF0F3', muted: '#9AA3AF', border: '#2A2F37', accent: '#7FAAF0', danger: '#F2867E', ok: '#6CCB8B', warn: '#E0B15A' };

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export function Card({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>{children}</View>;
}

export function Button({ title, onPress, kind = 'primary', busy = false, disabled = false }: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}) {
  const p = usePalette();
  const color = kind === 'danger' ? p.danger : p.accent;
  const filled = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: filled ? color : 'transparent', borderColor: color, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={filled ? '#fff' : color} /> : <Text style={[styles.buttonText, { color: filled ? '#fff' : color }]}>{title}</Text>}
    </Pressable>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.small, { color: p.muted }]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.body, { color: p.text }]}>{children}</Text>;
}

export function Title({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.title, { color: p.text }]}>{children}</Text>;
}

const STATUS_TONE: Record<RowStatus, keyof Palette> = {
  connected: 'ok',
  backfilling: 'accent',
  no_emails_found: 'warn',
  not_connected: 'muted',
  never_fetched: 'muted',
  needs_reauth: 'danger',
  error: 'danger',
};

export function Pill({ text, tone }: { text: string; tone: keyof Palette }) {
  const p = usePalette();
  return (
    <View style={[styles.pill, { borderColor: p[tone] }]}>
      <Text style={[styles.pillText, { color: p[tone] }]}>{text}</Text>
    </View>
  );
}

export function StatusPill({ status, label }: { status: RowStatus; label: string }) {
  return <Pill text={label} tone={STATUS_TONE[status]} />;
}

const FRESHNESS_TONE: Record<FreshnessLevel, keyof Palette> = { fresh: 'ok', aging: 'warn', stale: 'danger', never: 'muted' };

export function FreshnessPill({ level }: { level: FreshnessLevel }) {
  return <Pill text={level === 'never' ? 'no data yet' : level} tone={FRESHNESS_TONE[level]} />;
}

export const DATA_KIND_LABEL: Record<DataKind, string> = {
  bank_transactions: 'Bank transactions',
  bank_balance: 'Balances',
  card_transactions: 'Card transactions',
  card_statement: 'Card statements',
  demat_holdings: 'Demat holdings',
  mf_holdings: 'MF holdings',
  mf_transactions: 'MF transactions',
  broker_contract_notes: 'Contract notes',
  fixed_deposits: 'Fixed deposits',
  nav_prices: 'NAVs',
};

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  savings_account: 'Savings account',
  credit_card: 'Credit card',
  demat_account: 'Demat',
  mutual_fund_folios: 'Mutual funds',
  market_feed: 'Market data',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "11 Oct 2026, 18:05" in device local time, without relying on Intl. */
export function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

export const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, marginBottom: 12, gap: 6 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 21 },
  title: { fontSize: 17, fontWeight: '600' },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
