/** The UI and background checker share one projected reminder stream. */
export const REMINDER_CHANGE_COLUMNS = [
  "reminder_id", "title", "description", "reminder_type", "trigger_at",
  "schedule", "condition_query", "condition_check_interval", "recipients",
  "channel", "priority", "status", "created_at", "updated_at", "created_by",
  "next_trigger_at", "last_triggered_at", "trigger_count", "meta",
];

export interface ReminderWatchRule {
  table: string;
  events: string[];
  check?: string;
  show_fields?: string[];
}

export function parseRealtimeWatchRule(value: string | null): ReminderWatchRule | null {
  if (!value?.trim().startsWith("{")) return null;
  try { return JSON.parse(value); } catch { return null; }
}

type ChangeEvent = "*" | "INSERT" | "UPDATE" | "DELETE";
export interface ReminderWatchEntry<T> { rem: T; rule: ReminderWatchRule | null; eventsUpper: string[] | null }
export interface ReminderWatchGroup<T> { event: ChangeEvent; entries: ReminderWatchEntry<T>[] }

/** Eligibility is resolved before allocating a transport, including tables used only by other recipients. */
export function buildReminderWatchGroups<T extends { reminder_type: string; schedule: unknown; condition_query: string | null }>(
  reminders: T[], accepts: (reminder: T) => boolean,
): Map<string, ReminderWatchGroup<T>> {
  const groups = new Map<string, ReminderWatchGroup<T>>();
  for (const rem of reminders) {
    if (rem.reminder_type !== "conditional" || !accepts(rem)) continue;
    let schedule: any;
    try { schedule = typeof rem.schedule === "string" ? JSON.parse(rem.schedule) : rem.schedule; } catch { continue; }
    if (schedule?.type !== "realtime") continue;
    const rule = parseRealtimeWatchRule(rem.condition_query);
    // SQL is evaluated once on the server; it is not an unconditional acts watch.
    if (!rule) continue;
    if (Array.isArray(rule?.events) && !rule.events.length) continue;
    const table = typeof rule?.table === "string" && rule.table.trim() ? rule.table.trim() : "acts";
    const eventsUpper = Array.isArray(rule?.events) && rule.events.length
      ? rule.events.map(event => String(event).toUpperCase()) : null;
    // Use the existing broad stream when several event types are required.
    const event: ChangeEvent = eventsUpper?.length === 1 && ["INSERT", "UPDATE", "DELETE"].includes(eventsUpper[0])
      ? eventsUpper[0] as ChangeEvent : "*";
    const group = groups.get(table);
    if (group) {
      if (group.event !== event) group.event = "*";
      group.entries.push({ rem, rule, eventsUpper });
    } else groups.set(table, { event, entries: [{ rem, rule, eventsUpper }] });
  }
  return groups;
}

/** Updating rule contents retains the same channel; removed-channel callbacks become inert immediately. */
export function createReminderWatchRegistry<T>(
  subscribe: (table: string, event: ChangeEvent, receive: (payload: any) => void) => { unsubscribe(): void },
  receive: (payload: any, currentEntries: () => ReminderWatchEntry<T>[]) => unknown,
) {
  const slots = new Map<string, { event: ChangeEvent; entries: ReminderWatchEntry<T>[]; active: boolean; dispose(): void }>();
  return {
    replace(groups: Map<string, ReminderWatchGroup<T>>) {
      for (const [table, slot] of slots) {
        if (groups.get(table)?.event === slot.event) continue;
        slot.active = false;
        slot.dispose();
        slots.delete(table);
      }
      for (const [table, group] of groups) {
        const existing = slots.get(table);
        if (existing) { existing.entries = group.entries; continue; }
        const slot = { ...group, active: true, dispose() {} };
        slots.set(table, slot);
        const subscription = subscribe(table, group.event, payload => {
          if (!slot.active) return;
          void Promise.resolve(receive(payload, () => slot.active ? slot.entries : [])).catch(() => {});
        });
        slot.dispose = () => subscription.unsubscribe();
      }
    },
    clear() {
      for (const slot of slots.values()) { slot.active = false; slot.dispose(); }
      slots.clear();
    },
  };
}
