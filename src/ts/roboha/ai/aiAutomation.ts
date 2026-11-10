// src/ts/roboha/ai/aiAutomation.ts
// 🤖 Блок 5: Автоматизація СТО
// — AI прогноз ТО (масове сканування всіх авто)
// — Авто-нагадування клієнтам (неактивні клієнти)
// — AI аналітика завантаженості (по днях тижня / годинах)
// — Stock-алерти складу (мінімальні залишки)
// Використовує ТІЛЬКИ існуючі таблиці та поля — 0 змін у БД

import { supabase } from "../../vxid/supabaseClient";
import type { AnalyticsResult } from "./aiAnalytics";

/** Complete-history calculations run in SQL; only the requested candidates cross HTTP. */
async function readAutomationSummary(name: string, args: Record<string, unknown>): Promise<any> {
  const owner = localStorage.getItem("userAuthData");
  const { data, error } = await supabase.rpc(name, {
    ...args, p_now: new Date().toISOString(), p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (error) throw error;
  if (owner !== localStorage.getItem("userAuthData")) throw new Error("Користувач змінився");
  if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean" || !Number.isFinite(data.total)) throw new Error("Неповна відповідь аналітики");
  return data;
}
// ============================================================
// ТИПИ
// ============================================================

export interface WorkloadForecast {
  dayOfWeek: number;
  dayName: string;
  avgActsPerDay: number;
  avgRevenuePerDay: number;
  peakHours: string[];
  busyLevel: "low" | "medium" | "high" | "peak";
  recommendation: string;
}

export interface HourlyLoad {
  hour: number;
  label: string;
  avgActs: number;
  percentage: number;
}

export interface StockAlert {
  sclad_id: number | string;
  name: string;
  part_number: string;
  current_qty: number;
  threshold: number;
  shops: string;
  urgency: "warning" | "critical" | "out_of_stock";
  recommendation: string;
}

export interface MaintenanceScanResult {
  car_id: number;
  client_name: string;
  car_name: string;
  plate: string;
  phone: string;
  last_visit_date: string;
  last_mileage: number;
  alerts: {
    work_name: string;
    urgency: "medium" | "high" | "critical";
    days_since: number;
    km_since: number;
    recommendation: string;
  }[];
}

export interface ClientRetentionInfo {
  client_id: number;
  name: string;
  phone: string;
  last_visit: string;
  months_since: number;
  total_spent: number;
  total_acts: number;
  last_car: string;
  loyalty: string;
  suggested_message: string;
}

// ============================================================
// 1. AI АНАЛІТИКА ЗАВАНТАЖЕНОСТІ
// ============================================================

const DAY_NAMES_UK = [
  "Неділя",
  "Понеділок",
  "Вівторок",
  "Середа",
  "Четвер",
  "П'ятниця",
  "Субота",
];

/**
 * Аналізує розподіл актів по днях тижня та годинах.
 * Дає прогноз навантаження і рекомендації.
 */
export async function getWorkloadForecast(
  periodDays: number = 90,
): Promise<AnalyticsResult> {
  try {
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    const { data: aggregate, error } = await supabase.rpc("traffic_ai_workload", {
      p_since: since.toISOString(),
      p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (error) throw error;
    if (!aggregate?.complete || !Array.isArray(aggregate.days) || !Array.isArray(aggregate.hours)) {
      throw new Error("Неповна відповідь статистики завантаженості");
    }
    const totalActs = Number(aggregate.total);
    if (!Number.isSafeInteger(totalActs) || totalActs < 0) throw new Error("Некоректна кількість актів");
    if (totalActs === 0) {
      return { success: true, type: "workload_forecast",
        data: { weekly: [], hourly: [], totalActs: 0 },
        summary: `Немає даних за останні ${periodDays} днів.` };
    }
    const dayStats = new Map<number, {count: number; revenue: number; dates: number}>();
    for (let d = 0; d < 7; d++) dayStats.set(d, {count: 0, revenue: 0, dates: 0});
    for (const row of aggregate.days) {
      if (!dayStats.has(row.dow) || !Number.isFinite(row.revenue) || !Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.dates)) {
        throw new Error("Некоректна денна статистика");
      }
      dayStats.set(row.dow, row);
    }
    const hourStats = new Map<number, number>();
    for (let h = 0; h < 24; h++) hourStats.set(h, 0);
    for (const row of aggregate.hours) {
      if (!hourStats.has(row.hour) || !Number.isSafeInteger(row.count)) throw new Error("Некоректна погодинна статистика");
      hourStats.set(row.hour, row.count);
    }

    // Формуємо прогноз по днях
    const weekly: WorkloadForecast[] = [];
    let maxAvg = 0;

    for (const [dow, stat] of dayStats) {
      const uniqueDays = stat.dates || 1;
      const avgActs = stat.count / uniqueDays;
      if (avgActs > maxAvg) maxAvg = avgActs;

      weekly.push({
        dayOfWeek: dow,
        dayName: DAY_NAMES_UK[dow],
        avgActsPerDay: Math.round(avgActs * 10) / 10,
        avgRevenuePerDay: Math.round(stat.revenue / uniqueDays),
        peakHours: [],
        busyLevel: "low",
        recommendation: "",
      });
    }

    // Визначаємо рівень завантаженості
    for (const day of weekly) {
      const ratio = maxAvg > 0 ? day.avgActsPerDay / maxAvg : 0;
      if (ratio >= 0.85) day.busyLevel = "peak";
      else if (ratio >= 0.6) day.busyLevel = "high";
      else if (ratio >= 0.3) day.busyLevel = "medium";
      else day.busyLevel = "low";

      switch (day.busyLevel) {
        case "peak":
          day.recommendation = `🔴 Піковий день! Потрібні всі слюсарі. Середній дохід: ${day.avgRevenuePerDay.toLocaleString("uk-UA")} грн`;
          break;
        case "high":
          day.recommendation = `🟠 Високе навантаження. Рекомендується додатковий слюсар`;
          break;
        case "medium":
          day.recommendation = `🟡 Помірно. Гарний день для планових ТО`;
          break;
        case "low":
          day.recommendation = `🟢 Спокійний день. Можна планувати акції та знижки для залучення клієнтів`;
          break;
      }
    }

    // Сортуємо: пн-нд
    weekly.sort((a, b) => {
      const order = [1, 2, 3, 4, 5, 6, 0];
      return order.indexOf(a.dayOfWeek) - order.indexOf(b.dayOfWeek);
    });

    // Формуємо погодинну статистику
    const totalHourActs = [...hourStats.values()].reduce((a, b) => a + b, 0);
    const hourly: HourlyLoad[] = [];
    for (let h = 7; h <= 20; h++) {
      const count = hourStats.get(h) || 0;
      hourly.push({
        hour: h,
        label: `${h.toString().padStart(2, "0")}:00`,
        avgActs: Math.round((count / Math.max(periodDays / 7, 1)) * 10) / 10,
        percentage:
          totalHourActs > 0 ? Math.round((count / totalHourActs) * 100) : 0,
      });
    }

    // Піки по днях тижня
    const peakHoursGlobal = hourly
      .filter((h) => h.percentage >= 10)
      .map((h) => h.label);
    for (const day of weekly) day.peakHours = peakHoursGlobal;

    // Прогноз на сьогодні
    const todayDow = new Date().getDay();
    const todayForecast = weekly.find((d) => d.dayOfWeek === todayDow);

    const busyDay = weekly.reduce((max, d) =>
      d.avgActsPerDay > max.avgActsPerDay ? d : max,
    );
    const quietDay = weekly
      .filter((d) => d.avgActsPerDay > 0)
      .reduce(
        (min, d) => (d.avgActsPerDay < min.avgActsPerDay ? d : min),
        weekly[0],
      );

    return {
      success: true,
      type: "workload_forecast",
      data: {
        weekly,
        hourly,
        totalActs: totalActs,
        periodDays,
        todayForecast: todayForecast
          ? `${todayForecast.dayName}: ~${todayForecast.avgActsPerDay} актів, ${todayForecast.busyLevel}`
          : "—",
        insight: {
          busiest: `${busyDay.dayName} (~${busyDay.avgActsPerDay} актів/день)`,
          quietest: `${quietDay.dayName} (~${quietDay.avgActsPerDay} актів/день)`,
          peakHours: peakHoursGlobal.join(", ") || "—",
          avgDailyRevenue: Math.round(
            weekly.reduce((s, d) => s + d.avgRevenuePerDay, 0) /
              weekly.filter((d) => d.avgActsPerDay > 0).length,
          ),
        },
      },
      summary: `📊 За ${periodDays} днів: ${totalActs} актів. Найзавантаженіший: ${busyDay.dayName} (~${busyDay.avgActsPerDay} актів). Найспокійніший: ${quietDay.dayName}. Пікові години: ${peakHoursGlobal.join(", ") || "—"}`,
    };
  } catch (err: any) {
    return { success: false, type: "workload_forecast", error: err.message };
  }
}

// ============================================================
// 2. STOCK АЛЕРТИ СКЛАДУ
// ============================================================

/**
 * Перевіряє залишки на складі та генерує алерти.
 * Порогове значення зберігається в полі prumitka як "min:N" або за замовчуванням = 2.
 * Не потребує нових стовпців.
 */
export async function getStockAlerts(
  defaultThreshold: number = 2,
): Promise<AnalyticsResult> {
  try {
    if (!Number.isFinite(defaultThreshold)) throw new Error("Некоректний поріг залишку");
    const items: any[] = [];
    let offset = 0;
    let totalStock = 0;
    for (;;) {
      const { data: page, error } = await supabase.rpc("traffic_ai_stock_alerts", {
        p_threshold: defaultThreshold, p_offset: offset,
      });
      if (error) throw error;
      if (!Array.isArray(page?.items) || typeof page.has_more !== "boolean") throw new Error("Неповна відповідь складських попереджень");
      totalStock = page.total_stock;
      items.push(...page.items);
      if (!page.has_more) break;
      if (page.items.length !== 200) throw new Error("Неповна сторінка складських попереджень");
      offset += page.items.length;
    }
    if (totalStock === 0) return { success: true, type: "stock_alerts", data: [], summary: "Склад порожній." };

    const alerts: StockAlert[] = [];

    for (const item of items) {
      const currentQty = item.current_qty;
      const threshold = item.threshold;
      if (!Number.isFinite(currentQty) || !Number.isFinite(threshold)) throw new Error("Некоректні дані залишку");

      if (currentQty <= 0) {
        alerts.push({
          sclad_id: item.sclad_id,
          name: item.name || "—",
          part_number: item.part_number || "—",
          current_qty: currentQty,
          threshold,
          shops: item.shops || "—",
          urgency: "out_of_stock",
          recommendation: `🔴 Закінчився! Замовити терміново у ${item.shops || "постачальника"}`,
        });
      } else if (currentQty <= threshold) {
        alerts.push({
          sclad_id: item.sclad_id,
          name: item.name || "—",
          part_number: item.part_number || "—",
          current_qty: currentQty,
          threshold,
          shops: item.shops || "—",
          urgency: currentQty <= threshold / 2 ? "critical" : "warning",
          recommendation:
            currentQty <= threshold / 2
              ? `🟠 Критично мало (${currentQty} шт). Замовити якнайшвидше`
              : `🟡 Залишок ${currentQty} шт (мін: ${threshold}). Запланувати замовлення`,
        });
      }
    }

    // Сортуємо: out_of_stock → critical → warning
    const urgencyOrder = { out_of_stock: 0, critical: 1, warning: 2 };
    alerts.sort(
      (a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency],
    );

    const outOfStock = alerts.filter(
      (a) => a.urgency === "out_of_stock",
    ).length;
    const critical = alerts.filter((a) => a.urgency === "critical").length;
    const warning = alerts.filter((a) => a.urgency === "warning").length;

    return {
      success: true,
      type: "stock_alerts",
      total: alerts.length, hasMore: false, scope: `stock_threshold=${defaultThreshold}`,
      data: alerts,
      summary:
        alerts.length > 0
          ? `⚠️ Знайдено ${alerts.length} алертів: ${outOfStock} закінчились, ${critical} критичних, ${warning} попереджень`
          : "✅ Всі позиції на складі в нормі",
    };
  } catch (err: any) {
    return { success: false, type: "stock_alerts", error: err.message };
  }
}

// ============================================================
// 3. МАСОВЕ СКАНУВАННЯ ТО ВСІХ АВТО
// ============================================================

const MAINTENANCE_CHECKS = [
  {
    name: "Заміна масла",
    keywords: ["масло", "олива", "oil", "масл"],
    interval_km: 10000,
    interval_days: 365,
  },
  {
    name: "Заміна ГРМ",
    keywords: ["грм", "ремень грм", "ланцюг грм"],
    interval_km: 60000,
    interval_days: 1825,
  },
  {
    name: "Гальмівні колодки",
    keywords: ["колодк", "тормозн", "гальмів"],
    interval_km: 30000,
    interval_days: 730,
  },
  {
    name: "Свічки запалювання",
    keywords: ["свічк", "свеч"],
    interval_km: 40000,
    interval_days: 1095,
  },
  {
    name: "Фільтр паливний",
    keywords: ["фільтр палив", "топливн"],
    interval_km: 30000,
    interval_days: 730,
  },
  {
    name: "Фільтр повітряний",
    keywords: ["фільтр повітр"],
    interval_km: 20000,
    interval_days: 365,
  },
  {
    name: "Фільтр салону",
    keywords: ["фільтр салон", "кондиціон"],
    interval_km: 15000,
    interval_days: 365,
  },
  {
    name: "Антифриз",
    keywords: ["антифриз", "охолодж", "тосол"],
    interval_km: 50000,
    interval_days: 730,
  },
  {
    name: "Гальмівна рідина",
    keywords: ["гальмівн рідин", "тормозн жидк", "dot"],
    interval_km: 60000,
    interval_days: 730,
  },
];

/**
 * Сканує ВСІ авто з історією актів та генерує список тих,
 * кому потрібне ТО. Використовує дані пробігу з acts.data.Пробіг.
 */
export async function scanAllCarsForMaintenance(
  topN: number = 30,
): Promise<AnalyticsResult> {
  try {
    const report = await readAutomationSummary("traffic_ai_maintenance_summary", { p_checks: MAINTENANCE_CHECKS, p_limit: topN });
    const results: MaintenanceScanResult[] = report.items.map((car: any) => ({
      ...car, alerts: car.alerts.map((entry: any) => {
        const { km_left: kmLeft, days_left: daysLeft, ...alert } = entry;
        return { ...alert, recommendation: kmLeft < 0 || daysLeft < 0
          ? `⚠️ Прострочено! ${alert.work_name} — ${Math.abs(kmLeft)} км або ${Math.abs(daysLeft)} днів понад норму`
          : `${alert.work_name} — залишилось ~${kmLeft} км або ~${daysLeft} днів` };
      }),
    }));
    return {
      success: true, type: "maintenance_scan", total: report.total, hasMore: report.has_more,
      asOf: report.as_of, scope: "all_closed_act_history:maintenance_candidates", data: results,
      summary: `🔍 Просканованно ${report.scanned} авто. Потребують уваги: ${report.total} (${report.critical} критичних). Показано топ-${results.length}.`,
    };
  } catch (err: any) {
    return { success: false, type: "maintenance_scan", error: err.message };
  }
}
// ============================================================
// 4. АВТО-НАГАДУВАННЯ КЛІЄНТАМ (Retention)
// ============================================================

/**
 * Знаходить клієнтів, що давно не були, та генерує
 * персоналізовані повідомлення для відправки (SMS/Telegram).
 * Використовує існуючу структуру acts.data без змін БД.
 */
export async function getClientRetentionList(
  inactiveDays: number = 180,
  topN: number = 30,
): Promise<AnalyticsResult> {
  try {
    const report = await readAutomationSummary("traffic_ai_retention_summary", { p_days: inactiveDays, p_limit: topN });
    const results: ClientRetentionInfo[] = report.items.map((info: any) => ({
      ...info, suggested_message: info.total_acts >= 5
        ? `Вітаємо! Ви наш постійний клієнт 🌟 Вже ${info.months_since} міс. як Ваше ${info.last_car} не проходило обслуговування. Запишіться на діагностику зі знижкою!`
        : info.months_since >= 12
          ? `Нагадуємо, що Ваше ${info.last_car} потребує регулярного обслуговування. Минуло вже ${info.months_since} міс. Запишіться на ТО!`
          : `Пора перевірити Ваше ${info.last_car}! Минуло ${info.months_since} міс. від останнього візиту. Чекаємо Вас!`,
    }));
    const vipCount = results.filter(info => info.total_acts >= 5).length;
    return {
      success: true, type: "client_retention", total: report.total, hasMore: report.has_more,
      asOf: report.as_of, scope: `all_closed_act_history:inactive_days=${inactiveDays}`, data: results,
      summary: `📋 Знайдено ${report.total} клієнтів, які не відвідували СТО більше ${inactiveDays / 30} міс. Серед них ${vipCount} постійних. Готові SMS-шаблони для кожного.`,
    };
  } catch (err: any) {
    return { success: false, type: "client_retention", error: err.message };
  }
}