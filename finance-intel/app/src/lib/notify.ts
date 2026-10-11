import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { FinanceState } from './finance';

/**
 * Local notifications only (no push server): card due-date reminders and connection alerts.
 * Scheduled on the phone after each sync; nothing is sent to any notification service.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

let channelReady = false;

async function ensurePermission(): Promise<boolean> {
  if (Platform.OS === 'android' && !channelReady) {
    await Notifications.setNotificationChannelAsync('finance', { name: 'Finance reminders', importance: Notifications.AndroidImportance.DEFAULT });
    channelReady = true;
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Re-schedules card due reminders: 3 days before and on the due date, at 9:00 India time. */
export async function scheduleDueReminders(state: FinanceState): Promise<number> {
  if (!state.upcomingDues.length || !(await ensurePermission())) return 0;
  await Notifications.cancelAllScheduledNotificationsAsync();
  let scheduled = 0;
  for (const due of state.upcomingDues) {
    for (const daysBefore of [3, 0]) {
      const at = Date.parse(`${due.dueDate}T03:30:00Z`) - daysBefore * 86_400_000; // 09:00 IST
      if (at <= Date.now()) continue;
      const amount = due.totalDuePaise !== null ? ` ₹${(due.totalDuePaise / 100).toFixed(2)}` : '';
      await Notifications.scheduleNotificationAsync({
        content: { title: daysBefore ? `${due.label}: bill due in ${daysBefore} days` : `${due.label}: bill due today`, body: `Total due${amount}. Pay at least the minimum to avoid late fees.` },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'finance' },
      });
      scheduled++;
    }
  }
  return scheduled;
}

export async function notifyNow(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}
