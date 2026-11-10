// src/ts/roboha/ai/aiAnalytics.ts
// 📊 Модуль аналітики для AI Атлас
// VIP-клієнти, рейтинг слюсарів, фінансова аналітика, інтелектуальне планування

import { supabase } from "../../vxid/supabaseClient";
import {
  getWorkloadForecast,
  getStockAlerts,
  scanAllCarsForMaintenance,
  getClientRetentionList,
} from "./aiAutomation";

async function readOperationalAnalytics(mode: string, args: Record<string, unknown> = {}): Promise<any> {
  const actor = localStorage.getItem("userAuthData");
  const { data, error } = await supabase.rpc("traffic_ai_operational", { p_mode: mode, p_args: {
    now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...args,
  } });
  if (error) throw error;
  if (actor !== localStorage.getItem("userAuthData")) throw new Error("Користувач змінився. Повторіть запит.");
  if (!data || data.complete !== true) throw new Error("Неповна відповідь аналітики");
  return data;
}

// ============================================================
// ТИПИ
// ============================================================

export interface AnalyticsResult {
  success: boolean;
  type: string;
  data?: any;
  summary?: string;
  error?: string;
  scope?: string;
  asOf?: string;
  hasMore?: boolean;
  total?: number;
  returnedRows?: number;
}

export interface ClientAnalytics {
  client_id: number;
  name: string;
  phone: string;
  total_acts: number;
  total_revenue: number;
  avg_check: number;
  first_visit: string;
  last_visit: string;
  vip_level: string;
  days_since_last_visit: number;
}

export interface SlyusarAnalytics {
  slyusar_id: number;
  name: string;
  specialization: string;
  total_acts: number;
  total_revenue: number;
  avg_check: number;
  rating: number;
  current_post: string;
  workload: string;
}

export interface FinancialPeriod {
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
  acts_count: number;
  avg_check: number;
}

// ============================================================
// VIP КЛІЄНТИ
// ============================================================

/**
 * Визначає VIP-клієнтів за сумою витрат та кількістю візитів.
 * @param periodDays — за який період (default 365 днів)
 * @param topN — кількість топ-клієнтів (default 20)
 */
export async function getVipClients(
  periodDays = 365,
  topN = 20,
): Promise<AnalyticsResult> {
  try {
    const since = new Date(
      Date.now() - periodDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    topN = Math.min(200, Math.max(1, Math.floor(topN) || 20));
    const { data, error } = await supabase.rpc("traffic_ai_vip", { p_since: since, p_limit: topN });
    if (error) throw error;
    if (!data?.complete || !Array.isArray(data.items)) throw new Error("Неповний рейтинг клієнтів");
    const sorted: Array<[number, { acts: number; revenue: number; name: string; phone: string; lastVisit: string }]> = data.items;

    const result: ClientAnalytics[] = sorted.map(([id, c]) => {
      const daysSince = Math.floor(
        (Date.now() - new Date(c.lastVisit).getTime()) / (24 * 60 * 60 * 1000),
      );

      let vipLevel: string;
      if (c.revenue >= 100000) vipLevel = "💎 VIP";
      else if (c.revenue >= 30000) vipLevel = "⭐ Постійний";
      else if (c.acts >= 3) vipLevel = "🔄 Повторний";
      else vipLevel = "🆕 Новий";

      return {
        client_id: id,
        name: c.name,
        phone: c.phone,
        total_acts: c.acts,
        total_revenue: Math.round(c.revenue),
        avg_check: c.acts > 0 ? Math.round(c.revenue / c.acts) : 0,
        first_visit: "", // Не визначаємо тут
        last_visit: c.lastVisit,
        vip_level: vipLevel,
        days_since_last_visit: daysSince,
      };
    });

    const totalVip = result.filter((c) => c.total_revenue >= 100000).length;
    const totalRegular = result.filter(
      (c) => c.total_revenue >= 30000 && c.total_revenue < 100000,
    ).length;

    return {
      success: true,
      type: "vip_clients",
      data: result,
      summary: `Топ-${topN} клієнтів за ${periodDays} днів: ${totalVip} 💎VIP, ${totalRegular} ⭐Постійних. Загальна виручка: ${Math.round(result.reduce((s, c) => s + c.total_revenue, 0))} грн`,
    };
  } catch (err: any) {
    return {
      success: false,
      type: "vip_clients",
      error: `Помилка: ${err.message}`,
    };
  }
}

// ============================================================
// РЕЙТИНГ СЛЮСАРІВ
// ============================================================

/**
 * Аналітика по слюсарях: виручка, кількість актів, спеціалізація, завантаженість.
 * @param periodDays — за який період (default 30)
 */
export async function getSlyusarRanking(
  periodDays = 30,
): Promise<AnalyticsResult> {
  try {
    const since = new Date(
      Date.now() - periodDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const slyusars: any[] = [];
    let after: number | null = null;
    while (true) {
      const response: any = await supabase.rpc("traffic_ai_staff_ranking", { p_since: since, p_after: after });
      if (response.error) throw response.error;
      const page: any = response.data;
      if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("Некоректний рейтинг працівників");
      slyusars.push(...page.items);
      if (!page.has_more) break;
      const cursor: number = Number(page.next_cursor);
      if (!page.items.length || !Number.isSafeInteger(cursor) || (after !== null && cursor <= after)) throw new Error("Некоректна сторінка рейтингу");
      after = cursor;
    }

    // Формуємо рейтинг
    const ranking: SlyusarAnalytics[] = slyusars
      .map((s) => {
        const stats = s.__stats || {
          acts: 0,
          revenue: 0,
          openActs: 0,
        };
        const d = s.data as any;
        const name = d?.Name || "—";
        const specialization = d?.["Спеціалізація"] || "Загальна";
        const rating = parseFloat(d?.["Рейтинг"]) || 0;

        let workload: string;
        if (stats.openActs >= 3) workload = "🔴 Перевантажений";
        else if (stats.openActs >= 2) workload = "🟠 Зайнятий";
        else if (stats.openActs === 1) workload = "🟡 Частково зайнятий";
        else workload = "🟢 Вільний";

        return {
          slyusar_id: s.slyusar_id,
          name,
          specialization,
          total_acts: stats.acts,
          total_revenue: Math.round(stats.revenue),
          avg_check:
            stats.acts > 0 ? Math.round(stats.revenue / stats.acts) : 0,
          rating,
          current_post: s.post_sluysar || "—",
          workload,
        };
      })
      .filter((s) => s.name !== "—")
      .sort((a, b) => b.total_revenue - a.total_revenue);

    return {
      success: true,
      type: "slyusar_ranking",
      data: ranking,
      summary: `Рейтинг ${ranking.length} слюсарів за ${periodDays} днів. Лідер: ${ranking[0]?.name || "—"} (${ranking[0]?.total_revenue || 0} грн)`,
    };
  } catch (err: any) {
    return {
      success: false,
      type: "slyusar_ranking",
      error: `Помилка: ${err.message}`,
    };
  }
}

// ============================================================
// ФІНАНСОВА АНАЛІТИКА
// ============================================================

/**
 * Повний фінансовий звіт за період з порівнянням з попереднім.
 * @param periodDays — поточний період (default 30)
 */
export async function getFinancialReport(
  periodDays = 30,
): Promise<AnalyticsResult> {
  try {
    const now = Date.now();
    const currentStart = new Date(
      now - periodDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const previousStart = new Date(
      now - periodDays * 2 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data, error } = await supabase.rpc("traffic_ai_financial", {
      p_current: currentStart, p_previous: previousStart,
    });
    if (error) throw error;
    if (!data?.complete || !data.current || !data.previous) throw new Error("Неповний фінансовий звіт");
    function calcPeriod(raw: { revenue: number; expenses: number; acts_count: number }): FinancialPeriod {
      const revenue = Number(raw.revenue), totalExpenses = Number(raw.expenses), count = Number(raw.acts_count);
      if (![revenue, totalExpenses, count].every(Number.isFinite)) throw new Error("Некоректні суми фінансового звіту");
      const profit = revenue - totalExpenses;
      const margin = revenue > 0 ? profit / revenue * 100 : 0;
      return { revenue: Math.round(revenue), expenses: Math.round(totalExpenses), profit: Math.round(profit),
        margin: Math.round(margin * 10) / 10, acts_count: count, avg_check: count > 0 ? Math.round(revenue / count) : 0 };
    }
    const current = calcPeriod(data.current);
    const previous = calcPeriod(data.previous);

    // Порівняння
    function trend(cur: number, prev: number): string {
      if (prev === 0) return cur > 0 ? "🔼 +100%" : "➡️ 0%";
      const pct = Math.round(((cur - prev) / prev) * 100);
      if (pct > 0) return `🔼 +${pct}%`;
      if (pct < 0) return `🔽 ${pct}%`;
      return "➡️ 0%";
    }

    return {
      success: true,
      type: "financial_report",
      data: {
        current,
        previous,
        trends: {
          revenue: trend(current.revenue, previous.revenue),
          profit: trend(current.profit, previous.profit),
          acts: trend(current.acts_count, previous.acts_count),
          avg_check: trend(current.avg_check, previous.avg_check),
        },
        period_days: periodDays,
      },
      summary: `За ${periodDays} днів: Виручка ${current.revenue} грн ${trend(current.revenue, previous.revenue)}, Прибуток ${current.profit} грн ${trend(current.profit, previous.profit)}, ${current.acts_count} актів, середній чек ${current.avg_check} грн`,
    };
  } catch (err: any) {
    return {
      success: false,
      type: "financial_report",
      error: `Помилка: ${err.message}`,
    };
  }
}

// ============================================================
// ІНТЕЛЕКТУАЛЬНЕ ПЛАНУВАННЯ
// ============================================================

/**
 * Рекомендує слюсаря для типу робіт, враховуючи:
 * - Спеціалізацію (data.Спеціалізація)
 * - Поточну завантаженість (кількість відкритих актів)
 * - Рейтинг (data.Рейтинг)
 */
export async function recommendSlyusar(
  workType: string,
): Promise<AnalyticsResult> {
  try {
    const report = await readOperationalAnalytics("recommend");
    const slyusars: any[] = report.items;
    if (!slyusars || slyusars.length === 0) {
      return {
        success: false,
        type: "recommend_slyusar",
        error: "Слюсарів не знайдено",
      };
    }

    // Оцінюємо кожного слюсаря
    const workTypeLower = workType.toLowerCase();
    const candidates = slyusars
      .map((s) => {
        const d = s.data as any;
        const name = d?.Name || "—";
        const spec = (d?.["Спеціалізація"] || "").toLowerCase();
        const rating = parseFloat(d?.["Рейтинг"]) || 5; // default 5
        const currentLoad = s.current_load || 0;

        // Оцінка: спеціалізація (40%) + рейтинг (30%) + вільність (30%)
        let specScore = 0;
        if (spec && workTypeLower.includes(spec)) specScore = 10;
        else if (spec && spec.includes(workTypeLower.split(" ")[0]))
          specScore = 7;
        else specScore = 3;

        const loadScore = Math.max(0, 10 - currentLoad * 3); // 0 актів = 10, 3+ = 1
        const ratingScore = rating * 2; // 1-5 → 2-10

        const totalScore =
          specScore * 0.4 + ratingScore * 0.3 + loadScore * 0.3;

        return {
          slyusar_id: s.slyusar_id,
          name,
          specialization: d?.["Спеціалізація"] || "Загальна",
          rating,
          current_load: currentLoad,
          post: s.post_sluysar || "—",
          score: Math.round(totalScore * 10) / 10,
          reason:
            specScore >= 7 ? `✅ Спеціалізація: ${spec}` : "Загальний профіль",
        };
      })
      .filter((c) => c.name !== "—")
      .sort((a, b) => b.score - a.score);

    return {
      success: true,
      type: "recommend_slyusar",
      scope: report.scope, asOf: report.as_of, hasMore: false, total: report.total,
      data: candidates,
      summary: `Для "${workType}" рекомендую: ${candidates[0]?.name || "—"} (оцінка ${candidates[0]?.score || 0}/10, завантаження: ${candidates[0]?.current_load || 0} актів)`,
    };
  } catch (err: any) {
    return {
      success: false,
      type: "recommend_slyusar",
      error: `Помилка: ${err.message}`,
    };
  }
}

// ============================================================
// ПЕРЕДБАЧЕННЯ ТЕХНІЧНОГО ОБСЛУГОВУВАННЯ (Predictive Maintenance)
// ============================================================

export interface MaintenancePrediction {
  car_id: number;
  work_name: string;
  last_date: string;
  last_mileage: number;
  current_mileage: number;
  interval_km: number;
  interval_days: number;
  km_left: number;
  days_left: number;
  urgency: "low" | "medium" | "high" | "critical";
  recommendation: string;
}

/**
 * Аналізує історію авто та передбачає наступні роботи.
 */
export async function getCarMaintenancePrediction(
  carId: number,
  currentMileage: number,
): Promise<AnalyticsResult> {
  try {
    const checkList = [
      {
        name: "Заміна масла",
        keywords: ["масло", "олива", "oil"],
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
        keywords: ["колодк", "тормозн"],
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
    ];
    const report = await readOperationalAnalytics("maintenance", { car: carId, checks: checkList.map(item => item.keywords) });
    const predictions: MaintenancePrediction[] = [];
    const now = new Date();


    for (const item of checkList) {
      const lastAct = report.latest.find((row: any) => row.index === checkList.indexOf(item));
      const lastMileage = parseInt(lastAct?.mileage) || 0;

      if (lastAct) {
        const lastDate = new Date(lastAct.date_off || lastAct.date_on);
        const diffKm = currentMileage - lastMileage;
        const diffDays = Math.floor(
          (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        const kmLeft = item.interval_km - diffKm;
        const daysLeft = item.interval_days - diffDays;

        let urgency: "low" | "medium" | "high" | "critical" = "low";
        if (kmLeft < 500 || daysLeft < 14) urgency = "critical";
        else if (kmLeft < 2000 || daysLeft < 30) urgency = "high";
        else if (kmLeft < 4000 || daysLeft < 90) urgency = "medium";

        if (urgency !== "low") {
          predictions.push({
            car_id: carId,
            work_name: item.name,
            last_date: lastDate.toISOString().split("T")[0],
            last_mileage: lastMileage,
            current_mileage: currentMileage,
            interval_km: item.interval_km,
            interval_days: item.interval_days,
            km_left: kmLeft,
            days_left: daysLeft,
            urgency,
            recommendation: `Пора планувати: ${item.name}. ${kmLeft < 0 ? "Пробіг перевищено!" : `Залишилось ~${kmLeft} км`}`,
          });
        }
      }
    }

    return {
      success: true,
      type: "maintenance",
      scope: report.scope, asOf: report.as_of, hasMore: false, total: report.total,
      data: predictions,
      summary:
        predictions.length > 0
          ? `Виявлено ${predictions.length} критичних рекомендацій по ТО`
          : "Автомобіль в хорошому стані, планових робіт найближчим часом не виявлено",
    };
  } catch (err: any) {
    return { success: false, type: "maintenance", error: err.message };
  }
}

// ============================================================
// ІСТОРІЯ АВТО (Vehicle History)
// ============================================================

export interface VehicleHistoryEntry {
  act_id: number;
  date_on: string | null;
  date_off: string | null;
  mileage: number;
  works: string[];
  details: string[];
  total_sum: number;
}

export interface VehicleHistoryHint {
  text: string;
  urgency: "info" | "warning" | "critical";
}

export interface VehicleHistoryResult {
  entries: VehicleHistoryEntry[];
  hints: VehicleHistoryHint[];
  total: number;
  hasMore: boolean;
  asOf: string;
}

/**
 * Повертає повну історію ремонтів авто + ШІ-підказки.
 * Пропускає поточний акт (excludeActId).
 * Якщо передано vinCode — шукає акти по всіх авто з таким VIN (для історії по різних власниках).
 */
export async function getVehicleHistory(
  carId: number,
  excludeActId: number,
  vinCode?: string,
  firstPageOnly = false,
): Promise<VehicleHistoryResult> {
  const hintChecks = [
    { keywords: ["масло", "олива", "oil"], label: "масло", maxDays: 365 },
    {
      keywords: ["колодк", "тормозн", "гальмів"],
      label: "гальмівні колодки",
      maxDays: 730,
    },
    { keywords: ["фільтр повітр"], label: "повітряний фільтр", maxDays: 365 },
    {
      keywords: ["фільтр палив", "топливн"],
      label: "паливний фільтр",
      maxDays: 730,
    },
    {
      keywords: ["фільтр салон", "кондиціон"],
      label: "фільтр салону",
      maxDays: 365,
    },
    {
      keywords: ["грм", "ремень грм", "ланцюг грм"],
      label: "ГРМ",
      maxDays: 1825,
    },
    { keywords: ["свічк", "свеч"], label: "свічки", maxDays: 1095 },
    {
      keywords: ["антифриз", "охолодж", "тосол"],
      label: "антифриз",
      maxDays: 730,
    },
  ];
  const historyActor = localStorage.getItem("userAuthData");
  const args = { car: carId, exclude: excludeActId, vin: vinCode || "", checks: hintChecks.map(check => check.keywords), limit: firstPageOnly ? 20 : 50 };
  const report = await readOperationalAnalytics("vehicle", args);
  const entries: VehicleHistoryEntry[] = report.items.map((row: any) => ({ ...row, mileage: parseInt(row.mileage) || 0 }));
  if (!firstPageOnly) {
    let page = report;
    while (page.has_more) {
      if (historyActor !== localStorage.getItem("userAuthData")) throw new Error("Користувач змінився. Повторіть запит.");
      page = await readOperationalAnalytics("vehicle", { ...args, offset: page.next_offset });
      if (page.total !== report.total || page.total_sum !== report.total_sum) throw new Error("Історія авто змінилася. Повторіть відкриття.");
      entries.push(...page.items.map((row: any) => ({ ...row, mileage: parseInt(row.mileage) || 0 })));
    }
    if (new Set(entries.map(row => row.act_id)).size !== report.total || entries.length !== report.total) throw new Error("Неповна історія авто. Повторіть відкриття.");
  }
  const now = new Date();
  const hints: VehicleHistoryHint[] = [];


  for (const check of hintChecks) {
    const latest = report.latest.find((row: any) => row.index === hintChecks.indexOf(check));
    const lastDate = latest ? new Date(latest.date_off || latest.date_on) : null;

    if (lastDate) {
      const diffDays = Math.floor(
        (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      const months = Math.floor(diffDays / 30);
      if (diffDays > check.maxDays) {
        hints.push({
          text: `⚠️ ${check.label} — міняли ${months} міс. тому (прострочено!)`,
          urgency: "critical",
        });
      } else if (diffDays > check.maxDays * 0.8) {
        hints.push({
          text: `⏰ ${check.label} — міняли ${months} міс. тому, скоро час`,
          urgency: "warning",
        });
      }
    }
  }

  if (entries.length > 0) {
    const totalSpent = report.total_sum;
    if (totalSpent > 0) {
      hints.push({
        text: `📊 Всього витрачено на ремонти: ${Math.round(totalSpent).toLocaleString("uk-UA")} грн (${report.total} візитів)`,
        urgency: "info",
      });
    }
  }

  if (historyActor !== localStorage.getItem("userAuthData")) throw new Error("Користувач змінився. Повторіть запит.");
  return { entries, hints, total: report.total, hasMore: firstPageOnly && report.has_more, asOf: report.as_of };
}

// ============================================================
// ОБГОРТКА vehicle_history ДЛЯ AI (без excludeActId)
// ============================================================

async function getVehicleHistoryForAI(carId: number): Promise<AnalyticsResult> {
  try {
    const result = await getVehicleHistory(carId, 0, undefined, true);
    return {
      success: true,
      type: "vehicle_history",
      scope: "car_history", asOf: result.asOf, hasMore: result.hasMore, total: result.total,
      data: {
        entries: result.entries.slice(0, 20),
        hints: result.hints,
        total_entries: result.total,
        has_more: result.hasMore,
      },
      summary:
        result.entries.length > 0
          ? `Знайдено ${result.total} ремонтів. ${result.hints.filter((h) => h.urgency !== "info").length} попереджень.`
          : "Історія ремонтів для цього авто відсутня.",
    };
  } catch (err: any) {
    return { success: false, type: "vehicle_history", error: err.message };
  }
}

// ============================================================
// НЕАКТИВНІ КЛІЄНТИ (inactive_clients)
// ============================================================

async function getInactiveClients(
  inactiveDays: number,
  topN: number,
): Promise<AnalyticsResult> {
  try {
    const report = await readOperationalAnalytics("inactive", { days: inactiveDays, limit: topN });
    const result = report.items;
    return {
      success: true,
      type: "inactive_clients",
      scope: report.scope, asOf: report.as_of, hasMore: report.has_more, total: report.total,
      data: result,
      summary: `Знайдено ${report.total} клієнтів, які не були більше ${inactiveDays} днів (${Math.floor(inactiveDays / 30)} міс). Показано топ-${result.length} за витратами.`,
    };
  } catch (err: any) {
    return { success: false, type: "inactive_clients", error: err.message };
  }
}

// ============================================================
// ДОСЯГНЕННЯ СЛЮСАРЯ (mechanic_achievements)
// ============================================================

interface Achievement {
  emoji: string;
  name: string;
  description: string;
  unlocked: boolean;
  progress?: string;
}

async function getMechanicAchievements(
  mechanicName: string,
): Promise<AnalyticsResult> {
  try {
    const now = new Date();
    const report = await readOperationalAnalytics("achievements", { name: mechanicName,
      month_start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), today: now.toISOString().split("T")[0] });
    if (!report.name) return { success: false, type: "achievements", error: `Слюсаря "${mechanicName}" не знайдено.` };
    const mechName = report.name;
    const totalActs = report.total_acts, totalClosed = report.closed_acts, totalRevenue = report.total_revenue;
    const thisMonthActs = { length: report.this_month }, todayActs = { length: report.today };
    const closeTimes: number[] = report.close_times;
    const avgCloseHours = closeTimes.length ? closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length : 0;
    const fastCloses = closeTimes.filter(t => t <= 3).length;
    const uniqueClients = { size: report.unique_clients }, loyalClients = report.loyal_clients;
    const workDays = new Set<string>(report.work_days);
    let currentStreak = 0;
    const checkDate = new Date(now);
    for (let i = 0; i < 365; i++) {
      const ds = checkDate.toISOString().split("T")[0];
      if (workDays.has(ds)) {
        currentStreak++;
      } else if (checkDate.getDay() !== 0 && checkDate.getDay() !== 6) {
        break; // Не вихідний і не працював — streak обривається
      }
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Формуємо досягнення
    const achievements: Achievement[] = [
      {
        emoji: "🔧",
        name: "Початківець",
        description: "Закрити перший акт",
        unlocked: totalClosed >= 1,
        progress: `${totalClosed}/1`,
      },
      {
        emoji: "⚡",
        name: "Швидкий",
        description: "Закрити акт за 3 години або менше",
        unlocked: fastCloses >= 1,
        progress: `${fastCloses} швидких`,
      },
      {
        emoji: "🔥",
        name: "Продуктивний день",
        description: "5 актів за один день",
        unlocked: todayActs.length >= 5,
        progress: `${todayActs.length}/5 сьогодні`,
      },
      {
        emoji: "💎",
        name: "Сотня",
        description: "100 закритих актів",
        unlocked: totalClosed >= 100,
        progress: `${totalClosed}/100`,
      },
      {
        emoji: "🏆",
        name: "Тисяча",
        description: "1000 закритих актів",
        unlocked: totalClosed >= 1000,
        progress: `${totalClosed}/1000`,
      },
      {
        emoji: "🌟",
        name: "Фаворит клієнтів",
        description: "3+ клієнти повернулись саме до тебе",
        unlocked: loyalClients >= 3,
        progress: `${loyalClients} постійних`,
      },
      {
        emoji: "🎯",
        name: "Майстер місяця",
        description: "20+ актів за місяць",
        unlocked: thisMonthActs.length >= 20,
        progress: `${thisMonthActs.length}/20 цей місяць`,
      },
      {
        emoji: "🔥",
        name: "Streak!",
        description: "10 робочих днів підряд",
        unlocked: currentStreak >= 10,
        progress: `${currentStreak} днів поспіль`,
      },
      {
        emoji: "💰",
        name: "Мільйонер",
        description: "Виручка 1 000 000 грн",
        unlocked: totalRevenue >= 1000000,
        progress: `${Math.round(totalRevenue).toLocaleString("uk-UA")} грн`,
      },
      {
        emoji: "👥",
        name: "Популярний",
        description: "Обслужити 50+ унікальних клієнтів",
        unlocked: uniqueClients.size >= 50,
        progress: `${uniqueClients.size}/50 клієнтів`,
      },
    ];

    const unlocked = achievements.filter((a) => a.unlocked);
    const locked = achievements.filter((a) => !a.unlocked);

    return {
      success: true,
      type: "achievements",
      scope: report.scope, asOf: report.as_of, hasMore: false,
      data: {
        mechanic: mechName,
        stats: {
          total_acts: totalActs,
          closed_acts: totalClosed,
          this_month: thisMonthActs.length,
          today: todayActs.length,
          avg_close_hours: Math.round(avgCloseHours * 10) / 10,
          fast_closes: fastCloses,
          unique_clients: uniqueClients.size,
          loyal_clients: loyalClients,
          total_revenue: Math.round(totalRevenue),
          streak_days: currentStreak,
        },
        unlocked,
        locked,
      },
      summary: `${mechName}: ${unlocked.length}/${achievements.length} досягнень. ${totalClosed} актів, ${thisMonthActs.length} цього місяця, streak ${currentStreak} днів.`,
    };
  } catch (err: any) {
    return { success: false, type: "achievements", error: err.message };
  }
}

/**
 * Повертає Gemini function declaration для get_analytics
 */
export function getAnalyticsToolDeclaration(): any {
  return {
    name: "get_analytics",
    description: `Аналітичні звіти СТО: vip_clients(топ клієнтів), slyusar_ranking(рейтинг), financial_report(фінзвіт), recommend_slyusar(рекомендація слюсаря), car_health(діагностика авто по cars_id+пробіг), vehicle_history(історія ремонтів авто), inactive_clients(клієнти які давно не були), mechanic_achievements(досягнення слюсаря), workload_forecast(прогноз завантаженості по днях тижня та годинах), stock_alerts(алерти мінімальних залишків складу), maintenance_scan(масове сканування ТО всіх авто), client_retention(неактивні клієнти з готовими SMS).`,
    parameters: {
      type: "object",
      properties: {
        analytics_type: {
          type: "string",
          description: "Тип аналітики",
          enum: [
            "vip_clients",
            "slyusar_ranking",
            "financial_report",
            "recommend_slyusar",
            "car_health",
            "vehicle_history",
            "inactive_clients",
            "mechanic_achievements",
            "workload_forecast",
            "stock_alerts",
            "maintenance_scan",
            "client_retention",
          ],
        },
        period_days: {
          type: "integer",
          description: "Період днів (замовч: VIP=365, інші=30)",
        },
        work_type: {
          type: "string",
          description:
            'Тип робіт для recommend_slyusar: "Двигун","Ходова","Електрика"',
        },
        top_n: {
          type: "integer",
          description: "К-сть записів у топі (замовч 20)",
        },
        car_id: {
          type: "integer",
          description: "ID авто (cars_id) для car_health та vehicle_history",
        },
        mileage: {
          type: "integer",
          description: "Поточний пробіг авто для car_health",
        },
        mechanic_name: {
          type: "string",
          description: "Ім'я слюсаря для mechanic_achievements",
        },
      },
      required: ["analytics_type"],
    },
  };
}

/**
 * Виконує аналітичний запит за типом.
 */
async function executeAnalyticsRequest(
  analyticsType: string,
  periodDays?: number,
  workType?: string,
  topN?: number,
  carId?: number,
  mileage?: number,
  mechanicName?: string,
): Promise<AnalyticsResult> {
  switch (analyticsType) {
    case "vip_clients":
      return getVipClients(periodDays || 365, topN || 20);
    case "slyusar_ranking":
      return getSlyusarRanking(periodDays || 30);
    case "financial_report":
      return getFinancialReport(periodDays || 30);
    case "recommend_slyusar":
      return recommendSlyusar(workType || "Загальний ремонт");
    case "car_health":
      return carId
        ? getCarMaintenancePrediction(carId, mileage || 0)
        : {
            success: false,
            type: "car_health",
            error: "Потрібен car_id (ID авто)",
          };
    case "vehicle_history":
      return carId
        ? getVehicleHistoryForAI(carId)
        : {
            success: false,
            type: "vehicle_history",
            error: "Потрібен car_id (ID авто)",
          };
    case "inactive_clients":
      return getInactiveClients(periodDays || 180, topN || 20);
    case "mechanic_achievements":
      return getMechanicAchievements(mechanicName || "");
    case "workload_forecast":
      return getWorkloadForecast(periodDays || 90);
    case "stock_alerts":
      return getStockAlerts(topN || 2);
    case "maintenance_scan":
      return scanAllCarsForMaintenance(topN || 30);
    case "client_retention":
      return getClientRetentionList(periodDays || 180, topN || 30);
    default:
      return {
        success: false,
        type: analyticsType,
        error: `Невідомий тип аналітики: ${analyticsType}. Доступні: vip_clients, slyusar_ranking, financial_report, recommend_slyusar, car_health, vehicle_history, inactive_clients, mechanic_achievements, workload_forecast, stock_alerts, maintenance_scan, client_retention`,
      };
  }
}

const analyticsPending = new Map<string, Promise<AnalyticsResult>>();
export async function executeAnalytics(...args: Parameters<typeof executeAnalyticsRequest>): Promise<AnalyticsResult> {
  const actor = localStorage.getItem("userAuthData") || "";
  const key = JSON.stringify([actor, ...args]);
  let pending = analyticsPending.get(key);
  if (!pending) {
    pending = executeAnalyticsRequest(...args).then(result => {
      if (actor !== (localStorage.getItem("userAuthData") || "")) throw new Error("Користувач змінився. Повторіть запит.");
      const type = args[0];
      const defaultPeriods: Record<string, number> = { vip_clients: 365, slyusar_ranking: 30, financial_report: 30, inactive_clients: 180, workload_forecast: 90, client_retention: 180 };
      const defaultLimits: Record<string, number> = { vip_clients: 20, inactive_clients: 20, maintenance_scan: 30, client_retention: 30 };
      const topLimited = ["vip_clients", "maintenance_scan", "client_retention", "inactive_clients", "vehicle_history"].includes(type);
      return { ...result, scope: JSON.stringify({ source: result.scope || (topLimited ? type + ":requested_top" : type + ":requested_filters"), analyticsType: type, periodDays: args[1] || defaultPeriods[type], workType: args[2] || (type === "recommend_slyusar" ? "Загальний ремонт" : undefined), topN: args[3] || defaultLimits[type], carId: args[4], mileage: type === "car_health" ? args[5] || 0 : args[5], mechanicName: args[6], stockThreshold: type === "stock_alerts" ? args[3] || 2 : undefined }),
        ...(Array.isArray(result.data) ? { returnedRows: result.data.length } : {}),
        asOf: result.asOf || new Date().toISOString(),
        ...(!topLimited && result.success && result.hasMore === undefined ? { hasMore: false } : {}) };
    });
    analyticsPending.set(key, pending);
    void pending.finally(() => { if (analyticsPending.get(key) === pending) analyticsPending.delete(key); }).catch(() => {});
  }
  return structuredClone(await pending);
}
