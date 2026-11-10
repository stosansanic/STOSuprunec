// src/ts/roboha/sms/sendActSMS.ts

import { supabase } from "../../vxid/supabaseClient";
import { sendSMS } from "./smsAPI";
import { generateSMSText } from "./smsConfig";
import { refreshActsTable } from "../tablucya/tablucya";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { showSmsConfirmModal } from "./vikno_sms_confirm";
import { logAction } from "../../utils/auditLogger";

/**
 * Відправка SMS при закритті акту
 * Перевіряє налаштування в таблиці settings (setting_id = 5)
 */
export async function sendActClosedSMS(
  actId: number,
  clientPhone: string,
  clientName: string,
  totalSum: number,
): Promise<boolean> {
  try {
    // 1) Чи увімкнено SMS у settings (setting_id = 5)
    const { data: smsEnabledData } = await supabase
      .from("settings")
      .select("data")
      .eq("setting_id", 5)
      .maybeSingle();

    const smsEnabled =
      smsEnabledData?.data === true ||
      smsEnabledData?.data === "true" ||
      smsEnabledData?.data === 1;

    if (!smsEnabled) {
      return false;
    }

    // 2) Якщо сума ≈ 0 — НЕ відправляємо SMS
    const sum = Number(totalSum);
    if (!Number.isFinite(sum) || Math.abs(sum) < 0.01) {
      showNotification("ℹ️Сума = 0 грн. SMS не відправлено", "warning", 3000); // помаранчевим
      return false; // повертаємо false, щоб вище по коду знали: SMS не відправлялось
    }

    // 3) Формуємо повідомлення і відправляємо
    const message = generateSMSText(clientName, sum);

    showNotification("📤 Відправка SMS клієнту...", "info", 2000);

    const result = await sendSMS(clientPhone, message);

    if (result.success) {
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("acts")
        .update({ sms: now })
        .eq("act_id", actId);

      if (updateError) {
        // console.error("❌ Помилка оновлення поля sms:", updateError);
        showNotification(
          "SMS відправлено, але не вдалося оновити дату в БД",
          "warning",
          3000,
        );
        return true;
      }

      showNotification(
        `✅ SMS успішно відправлено на ${clientPhone}`,
        "success",
        3000,
      );
      await logAction(
        "act_sms",
        actId,
        { phone: clientPhone, totalSum },
        "act",
      );
      return true;
    } else {
      showNotification(
        `❌ Помилка відправки SMS: ${result.error}`,
        "error",
        4000,
      );
      return false;
    }
  } catch (error: any) {
    // console.error("💥 Критична помилка при відправці SMS:", error);
    showNotification(
      `❌ Критична помилка SMS: ${error.message}`,
      "error",
      4000,
    );
    return false;
  }
}

/**
 * Ручна відправка SMS при кліку на кнопку 📭/📨
 * Перевіряє налаштування в таблиці settings (setting_id = 5)
 */
export async function handleSmsButtonClick(actId: number): Promise<void> {
  try {
    // 1. Перевірка налаштування (setting_id = 5)
    const { data: settingData, error: settingError } = await supabase
      .from("settings")
      .select("data")
      .eq("setting_id", 5)
      .single();

    if (settingError) {
      // console.error("Помилка перевірки налаштувань:", settingError);
      showNotification("Помилка перевірки налаштувань SMS", "error");
      return;
    }

    const isSmsEnabled =
      settingData?.data === true ||
      settingData?.data === "true" ||
      settingData?.data === 1;

    if (!isSmsEnabled) {
      showNotification("SMS відключені (див. Налаштування)", "warning");
      return;
    }

    // 2. Отримання даних про акт і клієнта
    const { data: act, error: actError } = await supabase
      .from("acts")
      .select('client_id,sms,date_off,total:data->"Загальна сума"')
      .eq("act_id", actId)
      .single();

    if (actError || !act) {
      showNotification("Не знайдено дані акту", "error");
      return;
    }

    // Якщо акт закритий (є date_off), забороняємо відправку
    if (act.date_off) {
      showNotification(
        "SMS не надіслано. Для початку відкрийте акт",
        "warning",
        3000,
      );
      return;
    }

    // Якщо SMS вже відправлено (є дата в полі sms), просто повідомляємо і виходимо
    if (act.sms) {
      showNotification(
        "SMS повідомлення було відправлено раніше",
        "info",
        2000,
      );
      return;
    }

    let totalSum = Number(act.total || 0);
    // Object JSON uses only the projected total. A legacy string document (or
    // missing total) needs the existing full read to preserve its old behavior.
    if (act.total == null) {
      const { data: legacyAct, error: legacyError } = await supabase.from("acts")
        .select("data").eq("act_id", actId).single();
      if (legacyError || !legacyAct) throw legacyError || new Error("Акт недоступний");
      const body = typeof legacyAct.data === "string" ? JSON.parse(legacyAct.data) : legacyAct.data;
      totalSum = Number(body?.["Загальна сума"] || 0);
    }
    if (!Number.isFinite(totalSum)) throw new Error("Некоректна сума акта");

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select('phone_ua:data->"Телефон",phone:data->phone,name_ua:data->"ПІБ",fio:data->fio')
      .eq("client_id", act.client_id)
      .single();

    if (clientError || !client) {
      showNotification("Не знайдено дані клієнта", "error");
      return;
    }

    let clientPhone = String(client.phone_ua || client.phone || "");
    let clientName = String(client.name_ua || client.fio || "Клієнт");
    if ([client.phone_ua, client.phone, client.name_ua, client.fio].every(value => value == null)) {
      const { data: legacyClient, error: legacyError } = await supabase.from("clients")
        .select("data").eq("client_id", act.client_id).single();
      if (legacyError || !legacyClient) throw legacyError || new Error("Клієнт недоступний");
      const body = typeof legacyClient.data === "string" ? JSON.parse(legacyClient.data) : legacyClient.data;
      clientPhone = String(body?.["Телефон"] || body?.phone || "");
      clientName = String(body?.["ПІБ"] || body?.fio || "Клієнт");
    }

    if (!clientPhone) {
      showNotification("У клієнта не вказано номер телефону", "warning");
      return;
    }

    // 3. Підтвердження відправки
    const confirmed = await showSmsConfirmModal(
      clientName,
      totalSum,
      clientPhone,
    );

    if (!confirmed) {
      return;
    }

    // 4. Відправка
    showNotification("📤 Відправка SMS...", "info", 1500);
    const message = generateSMSText(clientName, totalSum);
    const result = await sendSMS(clientPhone, message);

    if (result.success) {
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("acts")
        .update({ sms: now })
        .eq("act_id", actId);

      if (updateError) {
        // console.error("Помилка оновлення статусу SMS:", updateError);
      }

      showNotification(`✅ SMS успішно відправлено!`, "success", 3000);
      await logAction(
        "act_sms",
        actId,
        { phone: clientPhone, totalSum },
        "act",
      );

      // Оновлюємо кнопку в інтерфейсі (якщо вона є)
      const btn = document.querySelector(`#sms-btn[data-act-id="${actId}"]`);
      if (btn) {
        btn.innerHTML = "📨";
        // Форматуємо дату для title
        try {
          const d = new Date(now);
          const m = (d.getMonth() + 1).toString().padStart(2, "0");
          const dd = d.getDate().toString().padStart(2, "0");
          const y = d.getFullYear();
          const h = d.getHours().toString().padStart(2, "0");
          const min = d.getMinutes().toString().padStart(2, "0");
          btn.setAttribute("title", `${h}:${min} / ${dd}.${m}.${y}`);
        } catch {
          btn.setAttribute("title", now);
        }
      }

      // Оновлюємо таблицю актів, щоб показати новий статус SMS
      refreshActsTable();
    } else {
      showNotification(`❌ Помилка: ${result.error}`, "error", 4000);
    }
  } catch (error: any) {
    // console.error("Помилка handleSmsButtonClick:", error);
    showNotification("Критична помилка при відправці SMS", "error");
  }
}
