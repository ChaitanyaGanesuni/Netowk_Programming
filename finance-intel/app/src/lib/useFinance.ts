import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { loadFinanceState, type FinanceState } from './finance';

/** Loads (and reloads on focus) the computed finance state for a screen. */
export function useFinance(): { state: FinanceState | null; error: string | null; reload: () => Promise<void> } {
  const [state, setState] = useState<FinanceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await loadFinanceState());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return { state, error, reload };
}
