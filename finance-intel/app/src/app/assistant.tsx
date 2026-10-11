import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { answer, detectIntent, type AssistantAnswer, type Intent } from '@fi/core';
import { DEFAULT_GROQ_MODEL, deleteAiSettings, loadAiSettings, rephrase, saveAiSettings, type AiSettings } from '../lib/ai';
import { buildFacts, loadFinanceState } from '../lib/finance';
import { Button, Card, Label, Muted, Pill, Title, styles as ui, usePalette } from '../components/ui';

const QUESTIONS: Array<[string, Intent]> = [
  ['Where did my money go this month?', 'where_money_went'],
  ['What are my largest discretionary expenses?', 'largest_discretionary'],
  ['How much could I save by reducing avoidable spending?', 'savings_potential'],
  ['What is my current net worth?', 'net_worth_now'],
  ['How has my net worth changed over the past year?', 'net_worth_change'],
  ['What is my portfolio worth today?', 'portfolio_value'],
  ['Which holdings contributed most to my gains?', 'top_contributors'],
  ['What is my current asset allocation?', 'asset_allocation'],
  ['Am I spending more than usual?', 'spending_vs_usual'],
  ['What should I prioritize to improve my financial position?', 'priorities'],
];

export default function AssistantScreen() {
  const p = usePalette();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AssistantAnswer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AiSettings>({ apiKey: null, model: DEFAULT_GROQ_MODEL });
  const [useAi, setUseAi] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [modelInput, setModelInput] = useState(DEFAULT_GROQ_MODEL);

  useFocusEffect(
    useCallback(() => {
      loadAiSettings().then((s) => {
        setSettings(s);
        setModelInput(s.model);
        setUseAi(Boolean(s.apiKey));
      });
    }, []),
  );

  const ask = async (q: string, known?: Intent) => {
    const intent = known ?? detectIntent(q);
    setQuestion(q);
    setNote(null);
    if (!intent) {
      setResult(null);
      setNote('I can answer questions about spending, savings, net worth, portfolio, allocation and priorities. Try one of the suggestions.');
      return;
    }
    setBusy(true);
    try {
      const base = answer(intent, buildFacts(await loadFinanceState()));
      if (useAi && settings.apiKey) {
        const r = await rephrase(q, base, settings);
        setResult(r.answer);
        setNote(r.note);
      } else {
        setResult(base);
      }
    } catch (e) {
      Alert.alert('Could not answer', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    const next = { apiKey: keyInput.trim() || settings.apiKey, model: modelInput.trim() || DEFAULT_GROQ_MODEL };
    await saveAiSettings(next);
    setSettings(next);
    setKeyInput('');
    setUseAi(Boolean(next.apiKey));
  };

  const input = [screen.input, { color: p.text, borderColor: p.border, backgroundColor: p.card }];

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={screen.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Title>Ask about your finances</Title>
        <TextInput style={input} placeholder="Type a question" placeholderTextColor={p.muted} value={question} onChangeText={setQuestion} onSubmitEditing={() => void ask(question)} />
        <Button title="Ask" busy={busy} disabled={!question.trim()} onPress={() => void ask(question)} />
        <View style={screen.chips}>
          {QUESTIONS.map(([q, intent]) => (
            <Pressable key={intent} onPress={() => void ask(q, intent)} style={[screen.chip, { borderColor: p.border }]} accessibilityRole="button">
              <Text style={[ui.small, { color: p.accent }]}>{q}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      {note && (
        <Card>
          <Muted>{note}</Muted>
        </Card>
      )}

      {result && (
        <Card>
          <View style={ui.row}>
            <Pill text={result.source === 'ai_rephrased' ? 'AI-worded · figures verified' : 'Calculated'} tone={result.source === 'ai_rephrased' ? 'accent' : 'ok'} />
          </View>
          <Label>{result.text}</Label>
          {result.facts.length > 0 && (
            <>
              <Title>Figures used</Title>
              {result.facts.map((f) => (
                <Muted key={f.id}>
                  {f.label}: {f.value}
                </Muted>
              ))}
            </>
          )}
          {result.uncertainty.length > 0 && (
            <>
              <Title>Caveats</Title>
              {result.uncertainty.map((u) => (
                <Muted key={u}>• {u}</Muted>
              ))}
            </>
          )}
        </Card>
      )}

      <Card>
        <Title>Optional AI wording</Title>
        <Muted>
          Answers are always calculated on this phone. If you add a free Groq API key, the calculated answer and its figures (no transactions, names or account
          numbers) are sent to Groq to be reworded; any reply that changes a figure is discarded. Turn on Zero Data Retention in your Groq console.
        </Muted>
        <View style={ui.row}>
          <Label>Use AI wording</Label>
          <Switch value={useAi} onValueChange={setUseAi} disabled={!settings.apiKey} />
        </View>
        <TextInput style={input} placeholder={settings.apiKey ? 'API key saved (enter to replace)' : 'Groq API key'} placeholderTextColor={p.muted} secureTextEntry autoCapitalize="none" value={keyInput} onChangeText={setKeyInput} />
        <TextInput style={input} placeholder="Model" placeholderTextColor={p.muted} autoCapitalize="none" value={modelInput} onChangeText={setModelInput} />
        <Muted>Check the model name against your Groq console’s model list.</Muted>
        <Button title="Save AI settings" kind="secondary" onPress={() => void saveKey()} />
        {settings.apiKey && (
          <Button
            title="Remove API key"
            kind="danger"
            onPress={() =>
              void deleteAiSettings().then(() => {
                setSettings({ apiKey: null, model: DEFAULT_GROQ_MODEL });
                setUseAi(false);
              })
            }
          />
        )}
      </Card>
    </ScrollView>
  );
}

const screen = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
});
