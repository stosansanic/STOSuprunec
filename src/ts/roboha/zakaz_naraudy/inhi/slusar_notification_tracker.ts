// src/ts/roboha/zakaz_naraudy/inhi/slusar_notification_tracker.ts
// ============================================================================
// МОДУЛЬ ДЛЯ ЗАПИСУ PUSH-ПОВІДОМЛЕНЬ ПРО ЗАВЕРШЕННЯ РОБОТИ СЛЮСАРЕМ
// ============================================================================
// Призначення: Створювати повідомлення в slusar_complete_notifications,
//              коли Слюсар змінює slusarsOn на true/false
// ============================================================================

import { supabase } from "../../../vxid/supabaseClient";

const NOTIFICATION_BATCH_SIZE = 200;

/** Capture the cancellation boundary before changing acts.slusarsOn. */
export async function capturePendingSlusarNotificationIds(
  actId: number,
  isCurrent: () => boolean,
): Promise<number[]> {
  const ids: number[] = [];
  let before: number | undefined;
  try {
    while (isCurrent()) {
      let query = supabase.from("slusar_complete_notifications")
        .select("notification_id")
        .eq("act_id", actId)
        .eq("delit", false)
        .order("notification_id", { ascending: false })
        .limit(NOTIFICATION_BATCH_SIZE);
      if (before !== undefined) query = query.lt("notification_id", before);
      const { data, error } = await query;
      if (!isCurrent() || error || !data) return [];
      const page = data.map(row => Number(row.notification_id));
      if (page.some(id => !Number.isSafeInteger(id) || id <= 0)) return [];
      ids.push(...page);
      if (page.length < NOTIFICATION_BATCH_SIZE) return ids;
      const next = page[page.length - 1];
      if (before !== undefined && next >= before) return [];
      before = next;
    }
  } catch {
    // This optional history table may not be exposed by the installation.
  }
  return [];
}

/** Never hide a completion inserted after the cancellation was prepared. */
export async function hideCapturedSlusarNotifications(
  actId: number,
  notificationIds: readonly number[],
  isCurrent: () => boolean,
): Promise<void> {
  const ids = [...new Set(notificationIds)].filter(id => Number.isSafeInteger(id) && id > 0);
  try {
    for (let offset = 0; offset < ids.length && isCurrent(); offset += NOTIFICATION_BATCH_SIZE) {
      const { error } = await supabase.from("slusar_complete_notifications")
        .update({ delit: true })
        .eq("act_id", actId)
        .in("notification_id", ids.slice(offset, offset + NOTIFICATION_BATCH_SIZE))
        .eq("delit", false);
      if (error) return;
    }
  } catch {
    // Completion state remains authoritative when optional history is unavailable.
  }
}

/**
 * Записує повідомлення про завершення роботи Слюсарем
 *
 * @param actId - ID акту
 * @param actNumber - Номер акту (наприклад, "123")
 * @param slusarsOn - Нове значення (true = завершено, false = скасовано)
 * @param completedBySurname - Прізвище Слюсаря
 * @param completedByName - Повне ПІБ Слюсаря (опціонально)
 * @param pruimalnyk - ПІБ Приймальника з acts.pruimalnyk (для фільтрації)
 */
export async function recordSlusarCompletion(
  actId: number,
  actNumber: string,
  slusarsOn: boolean,
  completedBySurname: string,
  completedByName?: string,
  pruimalnyk?: string,
): Promise<void> {
  try {
    // Cancellation uses only the notification IDs captured before its write.
    if (!slusarsOn) return;

    const notificationData = {
      act_id: actId,
      act_number: actNumber,
      completed_by_surname: completedBySurname,
      completed_by_name: completedByName || null,
      pruimalnyk: pruimalnyk || null,
      viewed: false,
      delit: false,
      data: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("slusar_complete_notifications")
      .insert([notificationData]);

    if (error) {
      // Таблиця не опублікована - це опціональна функція
      return;
    }
  } catch (error) {
    // Мовчки пропускаємо помилки
  }
}

/**
 * Видаляє (ховає) всі повідомлення для конкретного акту
 * Використовується при закритті акту (date_off != null)
 *
 * @param actId - ID акту
 */
export async function hideSlusarNotificationsForAct(
  actId: number,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("slusar_complete_notifications")
      .update({ delit: true })
      .eq("act_id", actId)
      .eq("delit", false); // Оновлюємо тільки ті, що ще не приховані

    if (error) {
      // Ігноруємо 404 - таблиця просто не опублікована в REST API
      // Це не критично, тому що ця таблиця опціональна
      if (error.code !== "PGRST116") {
        // console.debug(
          // "ℹ️ [SlusarNotification] Таблиця slusar_complete_notifications недоступна (не опублікована)",
        // );
      }
      return;
    }
  } catch (error) {
    // Мовчки ігноруємо помилки - це допоміжна операція
    // console.debug("[SlusarNotification] Критична помилка:", error);
  }
}

/**
 * Отримує кількість непереглянутих повідомлень для поточного користувача
 *
 * @param userAccessLevel - Рівень доступу ("Адміністратор" / "Приймальник")
 * @param userName - ПІБ користувача (для Приймальника)
 * @returns Кількість непереглянутих повідомлень
 */
export async function getUnviewedSlusarNotificationsCount(
  userAccessLevel: string,
  userName?: string,
): Promise<number> {
  try {
    let query = supabase
      .from("slusar_complete_notifications")
      .select("notification_id", { count: "exact", head: true })
      .eq("delit", false)
      .eq("viewed", false);

    // Фільтрація для Приймальника
    if (userAccessLevel === "Приймальник" && userName) {
      query = query.eq("pruimalnyk", userName);
    }

    const { count, error } = await query;

    if (error) {
      // Таблиця не опублікована - це нормально
      return 0;
    }

    return count || 0;
  } catch (error) {
    // Мовчки обробляємо помилки
    return 0;
  }
}

/**
 * Позначає повідомлення як переглянуте
 *
 * @param notificationId - ID повідомлення
 */
export async function markSlusarNotificationAsViewed(
  notificationId: number,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("slusar_complete_notifications")
      .update({ viewed: true })
      .eq("notification_id", notificationId)
      .eq("viewed", false);

    if (error) {
      // Таблиця не опублікована
    }
  } catch (error) {
    // Мовчки пропускаємо помилки
  }
}
