// src/ts/roboha/sms/smsConfig.ts

/**
 * Конфігурація SMS Club API
 */
export interface SMSConfig {
  token: string;
  alphaName: string;
}

/**
 * Отримання конфігурації з Supabase (таблиця sms, sms_id = 6)
 */
export async function getSMSConfig(): Promise<SMSConfig> {
  try {
    const { supabase } = await import("../../vxid/supabaseClient");

    const { data, error } = await supabase
      .from("sms")
      .select("data")
      .eq("sms_id", 6)
      .single();

    if (error) {
      // console.error("Помилка завантаження налаштувань SMS:", error);
      throw error;
    }

    if (!data?.data) {
      throw new Error("Налаштування SMS не знайдено в базі даних");
    }

    const smsSettings =
      typeof data.data === "string" ? JSON.parse(data.data) : data.data;

    if (!smsSettings?.token) {
      throw new Error("SMS токен відсутній в налаштуваннях");
    }

    return {
      token: smsSettings.token,
      alphaName: smsSettings.alphaName || "REMONT",
    };
  } catch (err: any) {
    // console.error("❌ Помилка завантаження SMS конфігурації:", err);
    throw new Error(`Не вдалося завантажити налаштування SMS: ${err.message}`);
  }
}

/* ===================== ГЕНЕРАЦІЯ ТЕКСТУ ===================== */

// Імпортуємо globalCache для отримання налаштувань SMS тексту
import { globalCache } from "../zakaz_naraudy/globalCache";

/**
 * Форматує суму з пробілами між тисячами.
 * Приклади:
 * 600 -> "600"
 * 1000 -> "1 000"
 * 10500.50 -> "10 500.50"
 */
function formatSum(sum: number): string {
  const n = Number(sum);
  if (!Number.isFinite(n)) return String(sum);

  // 1. Округляємо до 2 знаків після коми
  const fixed = n.toFixed(2);

  // 2. Розділяємо цілу (integer) та дробову (decimal) частини
  const parts = fixed.split(".");
  const integerPart = parts[0];
  const decimalPart = parts[1];

  // 3. Додаємо пробіли в цілу частину (регулярний вираз для тисяч)
  const integerWithSpaces = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  // 4. Якщо дробова частина "00", відкидаємо її. Інакше додаємо назад.
  if (decimalPart === "00") {
    return integerWithSpaces;
  } else {
    return `${integerWithSpaces}.${decimalPart}`;
  }
}

/**
 * Генерація тексту SMS: Без імені та відмінювання.
 * Приклад: "Ваше замовлення виконане. Сума: 1 600 грн. Дякуємо за довіру!"
 * Текст до і після суми налаштовується в секції "Загальні" налаштувань.
 */
export function generateSMSText(_clientName: string, totalSum: number): string {
  const textBefore =
    globalCache.generalSettings?.smsTextBefore ||
    "Ваше замовлення виконане. Сума:";
  const textAfter =
    globalCache.generalSettings?.smsTextAfter || "грн. Дякуємо за довіру!";
  return `${textBefore} ${formatSum(totalSum)} ${textAfter}`;
}

/* ===================== ТЕЛЕФОН ===================== */

/**
 * Форматування номера телефону для API (має бути у форматі 380XXXXXXXXX)
 */
export function formatPhoneForAPI(phone: string): string {
  // Видаляємо всі символи крім цифр
  let cleaned = String(phone || "").replace(/\D/g, "");

  // Якщо починається з 0 - замінюємо на 380
  if (cleaned.startsWith("0")) cleaned = "380" + cleaned.substring(1);

  // Якщо не починається з 380 - додаємо
  if (!cleaned.startsWith("380")) cleaned = "380" + cleaned;

  return cleaned;
}
