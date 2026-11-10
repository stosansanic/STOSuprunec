import { supabase } from "../../vxid/supabaseClient";
import type { ActNotificationPayload } from "./povidomlennya_tablucya";
import { userAccessLevel, getSavedUserDataFromLocalStorage } from "./users";

const NOTIFICATION_FIELDS = "notification_id,act_id,changed_by_surname,item_name,dodav_vudaluv,data,pib,auto,pruimalnyk";

export function getNotificationAccessScope(): { key: string; reception: string | null } | null {
  if (userAccessLevel !== "Адміністратор" && userAccessLevel !== "Приймальник") return null;
  const reception = userAccessLevel === "Приймальник" ? getSavedUserDataFromLocalStorage()?.name || null : null;
  if (userAccessLevel === "Приймальник" && !reception) return null;
  return { key: JSON.stringify([localStorage.getItem("userAuthData"), userAccessLevel, reception]), reception };
}

const acknowledgements = new Map<string, Promise<boolean>>();
/** One conditional write; the returned ID confirms ownership/RLS permitted the update. */
export function markNotificationAsDeleted(notificationId: number): Promise<boolean> {
  const scope = getNotificationAccessScope();
  if (userAccessLevel !== "Приймальник" || !scope?.reception || !Number.isSafeInteger(notificationId)) return Promise.resolve(false);
  const key = scope.key + ":" + notificationId;
  const existing = acknowledgements.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const { data, error } = await supabase.from("act_changes_notifications")
        .update({ delit: true }).eq("notification_id", notificationId)
        .eq("pruimalnyk", scope.reception).select("notification_id").maybeSingle();
      return !error && Number(data?.notification_id) === notificationId && getNotificationAccessScope()?.key === scope.key;
    } catch { return false; }
  })();
  acknowledgements.set(key, pending);
  void pending.finally(() => { if (acknowledgements.get(key) === pending) acknowledgements.delete(key); });
  return pending;
}

export interface UnseenNotificationPage {
  items: ActNotificationPayload[];
  nextBefore: number | null;
}

/** Keyset pagination remains stable when notifications are acknowledged/deleted. */
export async function loadUnseenNotificationsPage(before: number | null = null): Promise<UnseenNotificationPage> {
  const scope = getNotificationAccessScope();
  if (!scope) return { items: [], nextBefore: null };
  let query = supabase.from("act_changes_notifications").select(NOTIFICATION_FIELDS)
    .eq("delit", false).order("notification_id", { ascending: false }).limit(21);
  if (scope.reception) query = query.eq("pruimalnyk", scope.reception);
  if (before !== null) query = query.lt("notification_id", before);
  const { data, error } = await query;
  if (error) throw error;
  if (getNotificationAccessScope()?.key !== scope.key) return { items: [], nextBefore: null };
  const rows = (data || []).slice(0, 20);
  return {
    items: rows.map((row: any) => ({ ...row, created_at: row.data,
      changed_by_surname: row.changed_by_surname || "Невідомо", item_name: row.item_name || "",
      dodav_vudaluv: row.dodav_vudaluv ?? true })),
    nextBefore: (data?.length || 0) > 20 ? Number(rows[rows.length - 1].notification_id) : null,
  };
}

/** Compatibility entry point: callers receive the first bounded page. */
export async function loadUnseenNotifications(): Promise<ActNotificationPayload[]> {
  return (await loadUnseenNotificationsPage()).items;
}

export async function readUnreadNotificationIds(ids: number[]): Promise<Set<number>> {
  const scope = getNotificationAccessScope();
  const alive = new Set<number>();
  if (!scope) return alive;
  for (let offset = 0; offset < ids.length; offset += 200) {
    let query = supabase.from("act_changes_notifications").select("notification_id")
      .in("notification_id", ids.slice(offset, offset + 200)).eq("delit", false);
    if (scope.reception) query = query.eq("pruimalnyk", scope.reception);
    const { data, error } = await query;
    if (error) throw error;
    if (getNotificationAccessScope()?.key !== scope.key) return new Set();
    for (const row of data || []) alive.add(Number(row.notification_id));
  }
  return alive;
}

/**
 * Видаляє всі повідомлення для конкретного акту при його закритті
 * Встановлює delit = TRUE для всіх записів з даним act_id
 *
 * @param actId - ID акту, для якого видаляємо повідомлення
 * @returns true якщо успішно, false якщо помилка
 */
export async function deleteActNotificationsOnClose(
  actId: number
): Promise<boolean> {
  try {

    const { error } = await supabase
      .from("act_changes_notifications")
      .update({ delit: true })
      .eq("act_id", actId)
      .eq("delit", false); // тільки ті, що ще не помічені як видалені

    if (error) {
      // console.error(
        // `❌ [deleteActNotificationsOnClose] Помилка видалення повідомлень для акту #${actId}:`,
        // error.message,
        // error
      // );
      return false;
    }

    return true;
  } catch (err: any) {
    // console.error(
      // `❌ [deleteActNotificationsOnClose] Виняток при видаленні повідомлень для акту #${actId}:`,
      // err?.message || err
    // );
    return false;
  }
}
