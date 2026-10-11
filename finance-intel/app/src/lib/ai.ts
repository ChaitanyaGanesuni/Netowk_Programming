import * as SecureStore from 'expo-secure-store';
import { acceptLlmAnswer, buildLlmMessages, LLM_EXCLUDED_INTENTS, type AssistantAnswer, type Intent } from '@fi/core';

/**
 * Optional AI rephrasing via Groq's free plan (OpenAI-compatible API), using YOUR API key,
 * stored in the Keystore. Only the computed answer and its facts are sent. Enable "Zero Data
 * Retention" in the Groq console. The default model name is a suggestion — check the
 * models list in your Groq console and change it in Assistant settings if needed.
 */
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const KEY = 'fi.aiSettings';
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export interface AiSettings {
  apiKey: string | null;
  model: string;
}

export async function loadAiSettings(): Promise<AiSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
    const parsed = raw ? (JSON.parse(raw) as Partial<AiSettings>) : {};
    return { apiKey: parsed.apiKey ?? null, model: parsed.model || DEFAULT_GROQ_MODEL };
  } catch {
    return { apiKey: null, model: DEFAULT_GROQ_MODEL };
  }
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(settings), OPTIONS);
}

export async function deleteAiSettings(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}

export type AiResult = { answer: AssistantAnswer; note: string | null };

/** Returns the AI rephrasing if it passes validation; otherwise the calculated answer. */
export async function rephrase(question: string, intent: Intent, base: AssistantAnswer, settings: AiSettings): Promise<AiResult> {
  if (!settings.apiKey) return { answer: base, note: null };
  if (LLM_EXCLUDED_INTENTS.has(intent)) return { answer: base, note: 'This answer lists individual transactions, so it is never sent to the AI service.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model, messages: buildLlmMessages(question, base), temperature: 0.2, response_format: { type: 'json_object' } }),
    });
    if (!response.ok) return { answer: base, note: `AI unavailable (HTTP ${response.status}); showing the calculated answer.` };
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const accepted = acceptLlmAnswer(body.choices?.[0]?.message?.content ?? '', base);
    return accepted ? { answer: accepted, note: null } : { answer: base, note: 'The AI reply did not match the verified figures, so the calculated answer is shown.' };
  } catch {
    return { answer: base, note: 'AI unavailable; showing the calculated answer.' };
  } finally {
    clearTimeout(timer);
  }
}
