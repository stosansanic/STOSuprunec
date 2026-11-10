// Compatibility entry point: the table and notification cards share one scoped subscription.
import { subscribeToActNotifications, unsubscribeActNotificationRealtime } from "../../tablucya/tablucya";
import { loadAndShowExistingNotifications } from "../../tablucya/povidomlennya_tablucya";

export async function initActChangesSubscription(): Promise<void> {
  if (!window.location.pathname.endsWith("/main.html")) return;
  subscribeToActNotifications();
  await loadAndShowExistingNotifications();
}
export function unsubscribeFromActChanges(): void {
  unsubscribeActNotificationRealtime();
}
