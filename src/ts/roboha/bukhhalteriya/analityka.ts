import { isCancelled } from "./accountingRequests";
import { readAnalyticsDashboard, invalidateAnalyticsDashboard, cancelAnalyticsDashboardRead } from "./analyticsDashboardRead";
import { accountingToday, requireAccountingPeriod } from "./accountingPeriod";
import { createFinancialOverviewRead } from "./financialOverviewRead";
import { renderFinancialOverview } from "./financialOverviewUI";
import type { FinancialOverview } from "./financialOverviewTypes";
// src/ts/roboha/bukhhalteriya/analityka.ts
// 📊 Аналітика — Dashboard для бухгалтерії (Priority #3)

import ApexCharts from "apexcharts";
import { isActFrozen } from "../../utils/actFrozenState";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

// ===================== ІНТЕРФЕЙСИ =====================

interface ActRow {
  act_id: number;
  date_on: string | null;
  date_off: string | null;
  frozen?: boolean;
  rosraxovano: string | null;
  data: ActData | null;
  avans: number | string | null;
  tupOplatu: string | null;
  client_id: number | null;
  cars_id: number | null;
}

interface ActData {
  "Прибуток за деталі"?: number;
  "Прибуток за роботу"?: number;
  "За деталі"?: number;
  "За роботу"?: number;
  Знижка?: number;
  Роботи?: Array<{
    Робота?: string;
    Кількість?: number;
    Ціна?: number;
    Зарплата?: number;
    Прибуток?: number;
  }>;
  Деталі?: Array<{
    Деталь?: string;
    Кількість?: number;
    Ціна?: number;
    sclad_id?: number;
  }>;
}

interface SlyusarRow {
  slyusar_id: number;
  data: {
    Name: string;
    Доступ?: string;
    ПроцентРоботи?: number;
    Історія?: Record<
      string,
      Array<{
        Акт: string;
        СуммаРоботи: number;
        ДатаЗакриття: string | null;
        Записи?: Array<{
          Ціна: number;
          Робота: string;
          Кількість: number;
          Зарплата?: number;
          Розраховано?: string;
        }>;
      }>
    >;
  };
}

interface VutratuRow {
  vutratu_id: number;
  dataOnn: string | null;
  kategoria: string | null;
  suma: number;
  act: number | null;
  opys_vytraty: string | null;
}

interface ClientRow {
  client_id: number;
  data: { ПІБ?: string; Телефон?: string } | null;
}

interface CarRow {
  cars_id: number;
  data: { Авто?: string; "Номер авто"?: string } | null;
}

interface PostArxivRow {
  post_arxiv_id: number;
  data_on: string | null;
  data_off: string | null;
  name_post: string | null;
  slyusar_id: number | null;
  status: string | null;
}

interface PostNameRow {
  post_id: number;
  name: string;
}

interface MonthlyRevenue {
  month: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
  actsCount: number;
}

interface TopWork {
  name: string;
  totalRevenue: number;
  count: number;
}

interface ServiceCategory {
  name: string;
  value: number;
}

interface MechanicStats {
  name: string;
  actsCount: number;
  totalEarned: number;
  totalSalary: number;
  avgPerAct: number;
  totalWorks: number;
}

interface Anomaly {
  type: "warning" | "danger" | "info";
  icon: string;
  message: string;
  actId?: number;
}

interface TopClient {
  clientId: number;
  pib: string;
  totalSum: number;
  actsCount: number;
}

interface TopCar {
  carsId: number;
  carName: string;
  plate: string;
  totalSum: number;
  actsCount: number;
}

// ===================== СТАН МОДУЛЯ =====================

let revenueChart: ApexCharts | null = null;
let topWorksChart: ApexCharts | null = null;
let topServicesDonutChart: ApexCharts | null = null;
let mechanicsChart: ApexCharts | null = null;
let mechanicLoadChart: ApexCharts | null = null;
let workloadHeatmapChart: ApexCharts | null = null;
let dayOfWeekChart: ApexCharts | null = null;
let avgCheckTrendChart: ApexCharts | null = null;
let isLoading = false;

// Кешовані дані
let cachedActs: ActRow[] = [];
let cachedSlyusars: SlyusarRow[] = [];
let cachedVutratu: VutratuRow[] = [];
let cachedClients: ClientRow[] = [];
let cachedCars: CarRow[] = [];
let cachedPostArxiv: PostArxivRow[] = [];
let cachedPosts: PostNameRow[] = [];

interface DashboardDTO {
 monthly: Omit<MonthlyRevenue,'label'>[]; avg_check:{month:string;avg:number}[];
 top_works:TopWork[]; categories:ServiceCategory[]; mechanics:MechanicStats[];
 days:{day:number;count:number;revenue:number}[]; clients_sum:TopClient[];clients_count:TopClient[];
 cars_sum:TopCar[];cars_count:TopCar[];parts_sum:TopPart[];parts_count:TopPart[];
 anomalies:{kind:string;actId:number;value:number;days:number}[];
 summary:{totalActs:number;openActs:number;closedCount:number;avgCheck:number;maxAct:{id:number;total:number};uniqueClients:number;avgDays:number};
 planning:PostArxivRow[];posts_count:number;min_date:string|null;as_of:string;
}
let cachedDashboard:DashboardDTO|null=null;
let cachedFinancial: FinancialOverview | null = null;
let analyticsView: 'financial' | 'operations' = 'financial';
const financialReader = createFinancialOverviewRead();
let disposeFinancial: (() => void) | undefined;
let analyticsRequest=0;
let analyticsOwner = '';
const monthLabel=(key:string)=>{const [y,m]=key.split('-').map(Number);return ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'][m-1]+' '+y;};
// Фільтр дат
let filterDateFrom: Date | null = null;
let filterDateTo: Date | null = null;

/** Повертає акти, відфільтровані по обраному діапазону дат */
function getFilteredActs(): ActRow[] {
  // ❄️ Виключаємо заморожені акти з фінансових розрахунків
  const nonFrozen = cachedActs.filter((a) => !isActFrozen(a));
  if (!filterDateFrom && !filterDateTo) return nonFrozen;
  return nonFrozen.filter((a) => {
    const dateStr = a.date_off || a.date_on;
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (filterDateFrom && d < filterDateFrom) return false;
    if (filterDateTo && d > filterDateTo) return false;
    return true;
  });
}

function getFilteredVutratu(): VutratuRow[] {
  if (!filterDateFrom && !filterDateTo) return cachedVutratu;
  return cachedVutratu.filter((v) => {
    if (!v.dataOnn) return false;
    const d = new Date(v.dataOnn);
    if (filterDateFrom && d < filterDateFrom) return false;
    if (filterDateTo && d > filterDateTo) return false;
    return true;
  });
}

// ===================== ЗАВАНТАЖЕННЯ ДАНИХ =====================

// ===================== ОБЧИСЛЕННЯ =====================

/** Дохід по місяцях (останні 12 місяців) */
function calcMonthlyRevenue(): MonthlyRevenue[] {
  if(cachedDashboard) return cachedDashboard.monthly.map(row=>({...row,label:monthLabel(row.month)}));
  const monthMap = new Map<string, MonthlyRevenue>();
  const monthNames = [
    "Січ",
    "Лют",
    "Бер",
    "Кві",
    "Тра",
    "Чер",
    "Лип",
    "Сер",
    "Вер",
    "Жов",
    "Лис",
    "Гру",
  ];

  const acts = getFilteredActs();

  // Дохід з актів (по date_off — закриті)
  for (const act of acts) {
    if (!act.date_off) continue;
    const dateStr = act.date_off;

    const d = new Date(dateStr);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;

    if (!monthMap.has(key)) {
      monthMap.set(key, {
        month: key,
        label,
        revenue: 0,
        expenses: 0,
        profit: 0,
        actsCount: 0,
      });
    }
    const m = monthMap.get(key)!;

    const data = act.data;
    if (data) {
      const workRev = data["За роботу"] || 0;
      const detailRev = data["За деталі"] || 0;
      m.revenue += workRev + detailRev;
    }
    m.actsCount++;
  }

  // Витрати (тільки від'ємні суми без актів)
  for (const v of getFilteredVutratu()) {
    if (!v.dataOnn || v.act) continue;
    const d = new Date(v.dataOnn);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;

    if (!monthMap.has(key)) {
      monthMap.set(key, {
        month: key,
        label,
        revenue: 0,
        expenses: 0,
        profit: 0,
        actsCount: 0,
      });
    }
    const m = monthMap.get(key)!;
    if (v.suma < 0) {
      m.expenses += Math.abs(v.suma);
    }
  }

  // Підраховуємо прибуток
  for (const m of monthMap.values()) {
    m.profit = m.revenue - m.expenses;
  }

  // Сортуємо по місяцю та беремо останні 12
  const sorted = Array.from(monthMap.values()).sort((a, b) =>
    a.month.localeCompare(b.month),
  );

  return sorted.slice(-12);
}

/** Топ-10 найприбутковіших робіт */
function calcTopWorks(): TopWork[] {
  if(cachedDashboard) return cachedDashboard.top_works;
  const workMap = new Map<string, TopWork>();

  for (const act of getFilteredActs()) {
    const works = act.data?.Роботи;
    if (!works) continue;

    for (const w of works) {
      const name = w.Робота?.trim();
      if (!name) continue;
      const price = (w.Ціна || 0) * (w.Кількість || 1);

      if (!workMap.has(name)) {
        workMap.set(name, { name, totalRevenue: 0, count: 0 });
      }
      const tw = workMap.get(name)!;
      tw.totalRevenue += price;
      tw.count++;
    }
  }

  return Array.from(workMap.values())
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10);
}

/** Групування послуг для Donut Chart */
function calcServiceCategories(): ServiceCategory[] {
  if(cachedDashboard) return cachedDashboard.categories;
  const categories: Record<string, string[]> = {
    Ходова: [
      "важіль",
      "амортизатор",
      "сайлентблок",
      "тяга",
      "наконечник",
      "кульова",
      "підшипник",
      "пружина",
      "втулка",
      "стійка",
      "ходова",
      "кулак",
      "балка",
      "развал",
      "сход",
    ],
    Двигун: [
      "двигун",
      "гзм",
      "грм",
      "масло",
      "фільтр",
      "прокладка",
      "сальник",
      "свічки",
      "клапан",
      "головка",
      "циліндр",
      "поршень",
      "ремен",
      "ланцюг",
      "турбіна",
      "гбц",
    ],
    Гальмівна: [
      "гальм",
      "колодки",
      "диск",
      "супорт",
      "шланг",
      "циліндр гальм",
      "абс",
      "abs",
      "ручник",
    ],
    Трансмісія: [
      "кпп",
      "акпп",
      "зчеплення",
      "демпфер",
      "шрус",
      "піввісь",
      "редуктор",
      "кардан",
      "масло кпп",
    ],
    Електрика: [
      "світло",
      "фара",
      "ламп",
      "провод",
      "датчик",
      "стартер",
      "генератор",
      "акумулятор",
      "діагностика",
      "комп",
      "електри",
    ],
    ТО: [
      "діагностика",
      "огляд",
      "перевірка",
      "то-",
      "технічне обслуговування",
      "фільтр повітр",
      "фільтр палив",
    ],
    Вихлопна: ["глушник", "резонатор", "каталізатор", "зварювання", "гофра"],
    Охолодження: [
      "радіатор",
      "помпа",
      "термостат",
      "антифриз",
      "патрубок",
      "вентилятор",
    ],
  };

  const results = new Map<string, number>();
  const acts = getFilteredActs();

  for (const act of acts) {
    const works = act.data?.Роботи;
    if (!works) continue;

    for (const w of works) {
      const name = (w.Робота || "").toLowerCase();
      const sum = (w.Ціна || 0) * (w.Кількість || 1);

      let assigned = false;
      for (const [catName, keywords] of Object.entries(categories)) {
        if (keywords.some((k) => name.includes(k))) {
          results.set(catName, (results.get(catName) || 0) + sum);
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        results.set("Інше", (results.get("Інше") || 0) + sum);
      }
    }
  }

  return Array.from(results.entries())
    .map(([name, value]) => ({ name, value }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
}

/** Дохід по днях тижня */
function calcRevenueByDayOfWeek(): {
  day: string;
  revenue: number;
  count: number;
}[] {
  if(cachedDashboard) return [1,2,3,4,5,6,0].map(day=>({...(cachedDashboard!.days.find(row=>row.day===day)||{count:0,revenue:0}),day:['Нд','Пн','Вт','Ср','Чт','Пт','Сб'][day]}));
  const dayNames = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const map: { revenue: number; count: number }[] = Array.from(
    { length: 7 },
    () => ({ revenue: 0, count: 0 }),
  );

  for (const act of getFilteredActs()) {
    const dateStr = act.date_off || act.date_on;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    const dayIdx = d.getDay();
    const data = act.data;
    if (data) {
      map[dayIdx].revenue +=
        (data["За роботу"] || 0) + (data["За деталі"] || 0);
    }
    map[dayIdx].count++;
  }

  // Переставляємо щоб тиждень починався з Пн
  const reordered = [1, 2, 3, 4, 5, 6, 0];
  return reordered.map((i) => ({
    day: dayNames[i],
    revenue: map[i].revenue,
    count: map[i].count,
  }));
}

/** Тренд середнього чеку по місяцях */
function calcAvgCheckTrend(): { label: string; avg: number }[] {
  if(cachedDashboard) return cachedDashboard.avg_check.map(row=>({label:monthLabel(row.month),avg:row.avg}));
  const monthNames = [
    "Січ",
    "Лют",
    "Бер",
    "Кві",
    "Тра",
    "Чер",
    "Лип",
    "Сер",
    "Вер",
    "Жов",
    "Лис",
    "Гру",
  ];
  const monthMap = new Map<string, { total: number; count: number }>();

  for (const act of getFilteredActs()) {
    if (!act.date_off) continue;
    const d = new Date(act.date_off);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const data = act.data;
    const total = data
      ? (data["За роботу"] || 0) + (data["За деталі"] || 0)
      : 0;
    if (!monthMap.has(key)) monthMap.set(key, { total: 0, count: 0 });
    const m = monthMap.get(key)!;
    m.total += total;
    m.count++;
  }

  return Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([key, val]) => {
      const [y, mm] = key.split("-").map(Number);
      return {
        label: `${monthNames[mm - 1]} ${y}`,
        avg: val.count > 0 ? Math.round(val.total / val.count) : 0,
      };
    });
}

/** Ефективність механіків (з урахуванням фільтра дат) */
function calcMechanicStats(): MechanicStats[] {
  if(cachedDashboard) return cachedDashboard.mechanics;
  const stats: MechanicStats[] = [];

  for (const s of cachedSlyusars) {
    const data = s.data;
    if (!data?.Name || !data?.Історія) continue;

    // Пропускаємо приймальників для цієї статистики
    if (data.Доступ === "Приймальник") continue;

    let actsCount = 0;
    let totalEarned = 0;
    let totalSalary = 0;
    let totalWorks = 0;

    const history = data.Історія;
    for (const dateKey of Object.keys(history)) {
      // Фільтруємо по даті
      if (filterDateFrom || filterDateTo) {
        const d = new Date(dateKey);
        if (isNaN(d.getTime())) continue;
        if (filterDateFrom && d < filterDateFrom) continue;
        if (filterDateTo && d > filterDateTo) continue;
      }

      const entries = history[dateKey];
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        actsCount++;
        totalEarned += entry.СуммаРоботи || 0;

        if (entry.Записи) {
          totalWorks += entry.Записи.length;
          for (const rec of entry.Записи) {
            totalSalary += rec.Зарплата || 0;
          }
        }
      }
    }

    if (actsCount === 0) continue;

    stats.push({
      name: data.Name,
      actsCount,
      totalEarned,
      totalSalary,
      avgPerAct: Math.round(totalEarned / actsCount),
      totalWorks,
    });
  }

  return stats.sort((a, b) => b.totalEarned - a.totalEarned);
}

/** Аномалії */
function detectAnomalies(): Anomaly[] {
 if(cachedDashboard)return cachedDashboard.anomalies.map(a=>({actId:a.actId,type:a.kind==='salary'?'warning':a.kind==='zero'?'danger':'info',icon:a.kind==='salary'?'⚠️':a.kind==='zero'?'🔴':'📋',message:a.kind==='salary'?`Акт #${a.actId}: сума роботи ${formatMoney(a.value)} грн, але зарплата = 0`:a.kind==='zero'?`Акт #${a.actId}: закритий з нульовою сумою`:`Акт #${a.actId}: відкритий вже ${a.days} днів`}));
  const anomalies: Anomaly[] = [];
  const acts = getFilteredActs();

  // 1. Акти без зарплати (закриті, але зарплата = 0)
  for (const act of acts) {
    if (!act.date_off) continue;
    const data = act.data;
    if (!data) continue;
    const workRev = data["За роботу"] || 0;
    if (workRev > 0) {
      const hasWorks = data.Роботи && data.Роботи.length > 0;
      const totalSalary = (data.Роботи || []).reduce(
        (sum, w) => sum + (w.Зарплата || 0),
        0,
      );
      if (hasWorks && totalSalary === 0) {
        anomalies.push({
          type: "warning",
          icon: "⚠️",
          message: `Акт #${act.act_id}: сума роботи ${formatMoney(workRev)} грн, але зарплата = 0`,
          actId: act.act_id,
        });
      }
    }
  }

  // 2. Акти з нульовою сумою (закриті)
  for (const act of acts) {
    if (!act.date_off) continue;
    const data = act.data;
    if (!data) continue;
    const total = (data["За роботу"] || 0) + (data["За деталі"] || 0);
    if (total === 0) {
      anomalies.push({
        type: "danger",
        icon: "🔴",
        message: `Акт #${act.act_id}: закритий з нульовою сумою`,
        actId: act.act_id,
      });
    }
  }

  // 3. Відкриті акти старше 30 днів
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  for (const act of acts) {
    if (act.date_off) continue;
    if (!act.date_on) continue;
    const openDate = new Date(act.date_on);
    if (openDate < thirtyDaysAgo) {
      const days = Math.floor(
        (Date.now() - openDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      anomalies.push({
        type: "info",
        icon: "📋",
        message: `Акт #${act.act_id}: відкритий вже ${days} днів`,
        actId: act.act_id,
      });
    }
  }

  // Обмежуємо до 20 аномалій
  return anomalies.slice(0, 20);
}

/** Прогноз (лінійна регресія на основі місячних даних) */
function calcForecast(monthlyData: MonthlyRevenue[]): {
  nextMonthLabel: string;
  forecastRevenue: number;
  forecastProfit: number;
  trend: "up" | "down" | "stable";
} {
  const monthNames = [
    "Січ",
    "Лют",
    "Бер",
    "Кві",
    "Тра",
    "Чер",
    "Лип",
    "Сер",
    "Вер",
    "Жов",
    "Лис",
    "Гру",
  ];

  // Наступний місяць
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthLabel = `${monthNames[nextMonth.getMonth()]} ${nextMonth.getFullYear()}`;

  if (monthlyData.length < 3) {
    return {
      nextMonthLabel,
      forecastRevenue: 0,
      forecastProfit: 0,
      trend: "stable",
    };
  }

  // Лінійна регресія
  const n = monthlyData.length;
  const revenues = monthlyData.map((m) => m.revenue);
  const profits = monthlyData.map((m) => m.profit);

  const xMean = (n - 1) / 2;
  const yMeanRev = revenues.reduce((s, v) => s + v, 0) / n;
  const yMeanProf = profits.reduce((s, v) => s + v, 0) / n;

  let numRev = 0,
    numProf = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    numRev += dx * (revenues[i] - yMeanRev);
    numProf += dx * (profits[i] - yMeanProf);
    den += dx * dx;
  }

  const slopeRev = den !== 0 ? numRev / den : 0;
  const slopeProf = den !== 0 ? numProf / den : 0;
  const forecastRevenue = Math.max(
    0,
    Math.round(yMeanRev + slopeRev * (n - xMean)),
  );
  const forecastProfit = Math.round(yMeanProf + slopeProf * (n - xMean));

  // Визначаємо тренд за останні 3 місяці
  const last3 = revenues.slice(-3);
  const trend: "up" | "down" | "stable" =
    last3[2] > last3[0] * 1.05
      ? "up"
      : last3[2] < last3[0] * 0.95
        ? "down"
        : "stable";

  return { nextMonthLabel, forecastRevenue, forecastProfit, trend };
}

/** Розрахунок теплової карти завантаженості (по годинах і днях) */
function calcWorkloadHeatmap() {
  const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const postCount = Math.max(1, cachedPosts.length);

  // Визначаємо період
  let start: Date;
  let end: Date;

  if (filterDateFrom && filterDateTo) {
    // Якщо вибрано обидві дати — показуємо саме цей період
    start = new Date(filterDateFrom);
    end = new Date(filterDateTo);
  } else if (filterDateFrom) {
    // Якщо тільки "Від" — показуємо 15 днів від цієї дати
    start = new Date(filterDateFrom);
    end = new Date(start);
    end.setDate(start.getDate() + 14);
  } else if (filterDateTo) {
    // Якщо тільки "До" — показуємо 15 днів до цієї дати
    end = new Date(filterDateTo);
    start = new Date(end);
    start.setDate(end.getDate() - 14);
  } else {
    // За замовчуванням — останні 15 днів (включаючи сьогодні)
    end = new Date();
    start = new Date();
    start.setDate(end.getDate() - 14);
  }

  // Очищаємо час для коректного порівняння днів
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  const days: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(fmtInputDate(d));
  }

  const heatmapData: Record<number, Record<string, number>> = {};
  hours.forEach((h) => {
    heatmapData[h] = {};
    days.forEach((d) => {
      heatmapData[h][d] = 0;
    });
  });

  cachedPostArxiv.forEach((item) => {
    if (!item.data_on || !item.data_off || item.status === "Скасовано") return;
    const tOn = new Date(item.data_on);
    const tOff = new Date(item.data_off);

    // Перевіряємо чи запис входить у наш діапазон
    if (tOff < start || tOn > end) return;

    // Спрощений розрахунок: кожні 15хв
    for (let t = new Date(tOn); t < tOff; t.setMinutes(t.getMinutes() + 15)) {
      const dStr = fmtInputDate(t);
      const h = t.getHours();
      if (heatmapData[h] && heatmapData[h][dStr] !== undefined) {
        heatmapData[h][dStr] += 15;
      }
    }
  });

  return hours
    .map((h) => ({
      name: `${String(h).padStart(2, "0")}:00`,
      data: days.map((d) => {
        const mins = heatmapData[h][d];
        const val = Math.min(100, Math.round((mins / (60 * postCount)) * 100));
        return { x: d.split("-").reverse().slice(0, 2).join("."), y: val };
      }),
    }))
    .reverse();
}

// ===================== РЕНДЕРИНГ ГРАФІКІВ =====================

function renderWorkloadHeatmap(): void {
  const el = document.getElementById("analityka-workload-heatmap");
  if (!el) return;
  if (workloadHeatmapChart) {
    workloadHeatmapChart.destroy();
    workloadHeatmapChart = null;
  }

  const series = calcWorkloadHeatmap();
  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "heatmap",
      height: 380, // Трохи збільшимо висоту
      toolbar: { show: true },
      animations: { enabled: false },
    },
    dataLabels: { enabled: false },
    series: series,
    xaxis: {
      type: "category",
      position: "top", // Дати будуть зверху
      labels: {
        rotate: -45, // Нахил для кращої читаємості
        style: { fontSize: "10px", fontWeight: 500 },
      },
      tooltip: { enabled: false },
    },
    yaxis: {
      labels: {
        style: { fontSize: "12px", fontWeight: 600 },
      },
    },
    tooltip: {
      y: {
        formatter: (val: number) => `${val}% завантажено`,
      },
      x: { show: true },
    },
    plotOptions: {
      heatmap: {
        shadeIntensity: 0.5,
        radius: 2,
        useFillColorAsStroke: true,
        colorScale: {
          ranges: [
            { from: 0, to: 0, name: "Пусто", color: "#f5f5f5" },
            { from: 1, to: 30, name: "Низька", color: "#e8f5e9" },
            { from: 31, to: 60, name: "Середня", color: "#81c784" },
            { from: 61, to: 90, name: "Висока", color: "#4caf50" },
            { from: 91, to: 100, name: "Аншлаг", color: "#1b5e20" },
          ],
        },
      },
    },
    legend: {
      position: "bottom",
      horizontalAlign: "center",
    },
    title: {
      text: "🌡️ Завантаженість постів по годинах (%)",
      align: "left",
      style: { fontSize: "16px", fontWeight: 600, color: "#333" },
    },
  };

  workloadHeatmapChart = new ApexCharts(el, options);
  workloadHeatmapChart.render();
}

function renderRevenueChart(data: MonthlyRevenue[]): void {
  const el = document.getElementById("analityka-revenue-chart");
  if (!el) return;

  if (revenueChart) {
    revenueChart.destroy();
    revenueChart = null;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "area",
      height: 350,
      fontFamily: "inherit",
      toolbar: { show: true },
      animations: { enabled: true, speed: 800 },
    },
    series: [
      { name: "Дохід", data: data.map((m) => m.revenue) },
      { name: "Витрати", data: data.map((m) => m.expenses) },
      { name: "Прибуток", data: data.map((m) => m.profit) },
    ],
    xaxis: {
      categories: data.map((m) => m.label),
    },
    yaxis: {
      labels: {
        formatter: (val: number) => formatMoney(val),
      },
    },
    colors: ["#667eea", "#ef5350", "#66bb6a"],
    fill: {
      type: "gradient",
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.45,
        opacityTo: 0.05,
        stops: [0, 100],
      },
    },
    stroke: { curve: "smooth", width: 3 },
    dataLabels: { enabled: false },
    tooltip: { y: { formatter: (v) => formatMoney(v) + " грн" } },
  };

  revenueChart = new ApexCharts(el, options);
  revenueChart.render();
}

function renderTopServicesDonut(data: ServiceCategory[]): void {
  const el = document.getElementById("analityka-services-donut");
  if (!el) return;

  if (topServicesDonutChart) {
    topServicesDonutChart.destroy();
    topServicesDonutChart = null;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "donut",
      height: 350,
      fontFamily: "inherit",
    },
    series: data.map((d) => d.value),
    labels: data.map((d) => d.name),
    colors: [
      "#667eea",
      "#66bb6a",
      "#ffa726",
      "#ef5350",
      "#42a5f5",
      "#ab47bc",
      "#26c6da",
      "#78909c",
    ],
    legend: { position: "bottom" },
    plotOptions: {
      pie: {
        donut: {
          labels: {
            show: true,
            total: {
              show: true,
              label: "Всього",
              formatter: (w) => {
                const total = w.globals.seriesTotals.reduce(
                  (a: number, b: number) => a + b,
                  0,
                );
                return formatMoney(total) + " ₴";
              },
            },
          },
        },
      },
    },
    tooltip: { y: { formatter: (v) => formatMoney(v) + " грн" } },
    title: {
      text: "Топ категорій послуг",
      align: "center",
      style: { fontSize: "16px" },
    },
  };

  topServicesDonutChart = new ApexCharts(el, options);
  topServicesDonutChart.render();
}

function renderMechanicLoadChart(data: MechanicStats[]): void {
  const el = document.getElementById("analityka-mechanics-load-chart");
  if (!el) return;

  if (mechanicLoadChart) {
    mechanicLoadChart.destroy();
    mechanicLoadChart = null;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "bar",
      height: 350,
      fontFamily: "inherit",
      toolbar: { show: false },
    },
    series: [
      { name: "Кількість робіт", data: data.map((m) => m.totalWorks) },
      { name: "Закрито актів", data: data.map((m) => m.actsCount) },
    ],
    xaxis: {
      categories: data.map((m) => m.name),
    },
    colors: ["#667eea", "#00e396"],
    plotOptions: {
      bar: {
        borderRadius: 4,
        columnWidth: "55%",
        distributed: false,
        dataLabels: { position: "top" },
      },
    },
    dataLabels: {
      enabled: true,
      offsetY: -20,
      style: { fontSize: "10px", colors: ["#333"] },
    },
    legend: { position: "top" },
    title: {
      text: "Завантаженість майстрів",
      align: "center",
      style: { fontSize: "16px" },
    },
  };

  mechanicLoadChart = new ApexCharts(el, options);
  mechanicLoadChart.render();
}

function renderDayOfWeekChart(): void {
  const el = document.getElementById("analityka-day-of-week-chart");
  if (!el) return;
  if (dayOfWeekChart) {
    dayOfWeekChart.destroy();
    dayOfWeekChart = null;
  }

  const data = calcRevenueByDayOfWeek();
  const maxRevenue = Math.max(...data.map((d) => d.revenue));

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "bar",
      height: 280,
      fontFamily: "inherit",
      toolbar: { show: false },
      animations: { enabled: true, speed: 600 },
    },
    series: [{ name: "Дохід", data: data.map((d) => d.revenue) }],
    xaxis: {
      categories: data.map((d) => d.day),
      labels: { style: { fontSize: "13px", fontWeight: 600 } },
    },
    yaxis: {
      labels: {
        formatter: (val: number) => formatMoney(val),
        style: { fontSize: "11px" },
      },
    },
    colors: data.map((d) => (d.revenue === maxRevenue ? "#667eea" : "#c5cff6")),
    plotOptions: {
      bar: { borderRadius: 8, columnWidth: "55%", distributed: true },
    },
    tooltip: {
      y: { formatter: (val: number) => `${formatMoney(val)} грн` },
      x: {
        formatter: (_val: number, opts: { dataPointIndex: number }) =>
          `${data[opts.dataPointIndex].day} — ${data[opts.dataPointIndex].count} актів`,
      },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
  };

  dayOfWeekChart = new ApexCharts(el, options);
  dayOfWeekChart.render();
}

function renderAvgCheckTrendChart(): void {
  const el = document.getElementById("analityka-avg-check-trend-chart");
  if (!el) return;
  if (avgCheckTrendChart) {
    avgCheckTrendChart.destroy();
    avgCheckTrendChart = null;
  }

  const data = calcAvgCheckTrend();
  if (data.length < 2) {
    el.innerHTML =
      '<div style="text-align:center;color:#999;padding:40px;">Недостатньо даних</div>';
    return;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "line",
      height: 280,
      fontFamily: "inherit",
      toolbar: { show: false },
      animations: { enabled: true, speed: 600 },
    },
    series: [{ name: "Сер. чек", data: data.map((d) => d.avg) }],
    xaxis: {
      categories: data.map((d) => d.label),
      labels: { rotate: -45, style: { fontSize: "10px" } },
    },
    yaxis: {
      labels: {
        formatter: (val: number) => formatMoney(val),
        style: { fontSize: "11px" },
      },
    },
    colors: ["#7c4dff"],
    stroke: { curve: "smooth", width: 3 },
    markers: {
      size: 5,
      colors: ["#7c4dff"],
      strokeColors: "#fff",
      strokeWidth: 2,
      hover: { size: 7 },
    },
    fill: {
      type: "gradient",
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.3,
        opacityTo: 0.05,
        stops: [0, 100],
      },
    },
    tooltip: { y: { formatter: (v: number) => formatMoney(v) + " грн" } },
    dataLabels: { enabled: false },
  };

  avgCheckTrendChart = new ApexCharts(el, options);
  avgCheckTrendChart.render();
}

function renderTopWorksChart(data: TopWork[]): void {
  const el = document.getElementById("analityka-top-works-chart");
  if (!el) return;

  if (topWorksChart) {
    topWorksChart.destroy();
    topWorksChart = null;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "bar",
      height: 320,
      fontFamily: "Arial, sans-serif",
      toolbar: { show: false },
      animations: { enabled: true, speed: 600 },
    },
    series: [{ name: "Дохід", data: data.map((w) => w.totalRevenue) }],
    xaxis: {
      categories: data.map((w) => truncateText(w.name, 25)),
      labels: {
        style: { fontSize: "10px" },
        rotate: -45,
        rotateAlways: data.length > 5,
      },
    },
    yaxis: {
      labels: {
        formatter: (val: number) => formatMoney(val),
        style: { fontSize: "11px" },
      },
    },
    colors: ["#667eea"],
    plotOptions: {
      bar: {
        borderRadius: 6,
        columnWidth: "60%",
        distributed: true,
      },
    },
    tooltip: {
      y: { formatter: (val: number) => `${formatMoney(val)} грн` },
      x: {
        formatter: (_val: number, opts: { dataPointIndex: number }) => {
          const idx = opts.dataPointIndex;
          return `${data[idx].name} (×${data[idx].count})`;
        },
      },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
  };

  topWorksChart = new ApexCharts(el, options);
  topWorksChart.render();
}

function renderMechanicsChart(data: MechanicStats[]): void {
  const el = document.getElementById("analityka-mechanics-chart");
  if (!el) return;

  if (mechanicsChart) {
    mechanicsChart.destroy();
    mechanicsChart = null;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "bar",
      height: 320,
      fontFamily: "Arial, sans-serif",
      toolbar: { show: false },
      stacked: false,
    },
    series: [
      { name: "Заробив для СТО", data: data.map((m) => m.totalEarned) },
      { name: "Зарплата", data: data.map((m) => m.totalSalary) },
    ],
    xaxis: {
      categories: data.map((m) => m.name),
      labels: { style: { fontSize: "11px" } },
    },
    yaxis: {
      labels: {
        formatter: (val: number) => formatMoney(val),
        style: { fontSize: "11px" },
      },
    },
    colors: ["#66bb6a", "#ffa726"],
    plotOptions: {
      bar: { borderRadius: 4, columnWidth: "50%" },
    },
    tooltip: {
      shared: true,
      intersect: false,
      y: { formatter: (val: number) => `${formatMoney(val)} грн` },
    },
    legend: { position: "top" },
    dataLabels: { enabled: false },
  };

  mechanicsChart = new ApexCharts(el, options);
  mechanicsChart.render();
}

// ===================== РЕНДЕРИНГ КАРТОК =====================

function renderSummaryCards(
  monthly: MonthlyRevenue[],
  forecast: ReturnType<typeof calcForecast>,
): void {
  const container = document.getElementById("analityka-summary-cards");
  if (!container) return;

  // Financial totals have their own complete report. These cards describe work only.
  if (analyticsView === 'operations' && cachedDashboard) {
    const summary = cachedDashboard.summary;
    const cards = [
      ['📋', 'Актів за період', summary.totalActs],
      ['✅', 'Закритих актів', summary.closedCount],
      ['👥', 'Клієнтів', summary.uniqueClients],
      ['⏱', 'Середній час закриття, днів', summary.avgDays],
    ];
    container.innerHTML = cards.map(([icon, label, value]) =>
      `<div class="analityka-card"><div class="analityka-card-icon">${icon}</div><div class="analityka-card-body"><div class="analityka-card-label">${label}</div><div class="analityka-card-value">${Number(value).toLocaleString('uk-UA')}</div></div></div>`).join('');
    return;
  }

  const acts = getFilteredActs();

  // Поточний місяць
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentMonth = monthly.find((m) => m.month === currentKey);
  const prevKey = `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, "0")}`;
  const prevMonth = monthly.find((m) => m.month === prevKey);

  const totalRevenue = monthly.reduce((s, m) => s + m.revenue, 0);
  const totalActs = cachedDashboard?.summary.totalActs ?? acts.length;
  const openActs = cachedDashboard?.summary.openActs ?? acts.filter((a) => !a.date_off).length;
  const closedActs = acts.filter((a) => !!a.date_off);

  // Помірний чек (по закритих актах)
  const avgCheck = cachedDashboard?.summary.avgCheck ?? (
    closedActs.length > 0
      ? Math.round(
          closedActs.reduce((sum, a) => {
            const d = a.data;
            return (
              sum + (d ? (d["За роботу"] || 0) + (d["За деталі"] || 0) : 0)
            );
          }, 0) / closedActs.length,
        )
      : 0);

  // Найдорожчий акт
  let maxAct = { id: 0, total: 0 };
  for (const a of closedActs) {
    const d = a.data;
    const total = d ? (d["За роботу"] || 0) + (d["За деталі"] || 0) : 0;
    if (total > maxAct.total) maxAct = { id: a.act_id, total };
  }

  // Клієнтів обслуговано (унікальні client_id в актах)
  const uniqueClients = new Set(acts.map((a) => a.client_id).filter(Boolean));

  // Помірний час закриття акту (днів)
  let avgDays = 0;
  const closedWithDates = closedActs.filter((a) => a.date_on && a.date_off);
  if (closedWithDates.length > 0) {
    const totalDays = closedWithDates.reduce((sum, a) => {
      const diff =
        new Date(a.date_off!).getTime() - new Date(a.date_on!).getTime();
      return sum + Math.max(0, diff / (1000 * 60 * 60 * 24));
    }, 0);
    avgDays = Math.round((totalDays / closedWithDates.length) * 10) / 10;
  }

  if(cachedDashboard){maxAct=cachedDashboard.summary.maxAct;avgDays=cachedDashboard.summary.avgDays;}
  const closedCount=cachedDashboard?.summary.closedCount ?? closedActs.length;
  const clientCount=cachedDashboard?.summary.uniqueClients ?? uniqueClients.size;
  const trendIcon =
    forecast.trend === "up" ? "📈" : forecast.trend === "down" ? "📉" : "➡️";
  const trendColor =
    forecast.trend === "up"
      ? "#4caf50"
      : forecast.trend === "down"
        ? "#f44336"
        : "#ff9800";

  // Порівняння з минулим місяцем (або останні 2 місяці у фільтрі)
  let changePercent = "";
  const hasFilter = filterDateFrom || filterDateTo;
  if (hasFilter && monthly.length >= 2) {
    // При фільтрі: порівнюємо останній місяць у діапазоні з передостаннім
    const last = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    if (prev.revenue > 0) {
      const pct = Math.round(
        ((last.revenue - prev.revenue) / prev.revenue) * 100,
      );
      const sign = pct >= 0 ? "+" : "";
      changePercent = `<span class="analityka-card-sub" style="color:${pct >= 0 ? "#4caf50" : "#f44336"}">${sign}${pct}%</span>`;
    }
  } else if (!hasFilter && currentMonth && prevMonth && prevMonth.revenue > 0) {
    const pct = Math.round(
      ((currentMonth.revenue - prevMonth.revenue) / prevMonth.revenue) * 100,
    );
    const sign = pct >= 0 ? "+" : "";
    changePercent = `<span class="analityka-card-sub" style="color:${pct >= 0 ? "#4caf50" : "#f44336"}">${sign}${pct}%</span>`;
  }

  // Визначаємо дохід в залежності від фільтра
  const incomeLabel = hasFilter ? "Дохід за період" : "Дохід місяця";
  const incomeValue = hasFilter ? totalRevenue : currentMonth?.revenue || 0;

  // Рентабельність (прибуток / дохід %)
  const totalExpenses = monthly.reduce((s, m) => s + m.expenses, 0);
  const totalProfit = totalRevenue - totalExpenses;
  const profitMargin =
    totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 100) : 0;
  const profitColor =
    profitMargin >= 30 ? "#4caf50" : profitMargin >= 15 ? "#ff9800" : "#f44336";

  // Конверсія (закриті / всі)
  const conversionRate =
    totalActs > 0 ? Math.round((closedCount / totalActs) * 100) : 0;

  container.innerHTML = `
    <div class="analityka-card">
      <div class="analityka-card-icon">💰</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">${incomeLabel}</div>
        <div class="analityka-card-value">${formatMoney(incomeValue)}</div>
        ${changePercent}
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">🧾</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Сер. чек</div>
        <div class="analityka-card-value">${formatMoney(avgCheck)}</div>
        <span class="analityka-card-sub">${closedCount} закр.</span>
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">📋</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Актів / відкр.</div>
        <div class="analityka-card-value">${totalActs} / <span style="color:#f44336">${openActs}</span></div>
        <span class="analityka-card-sub">⏱ ${avgDays} дн.</span>
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">👥</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Клієнтів</div>
        <div class="analityka-card-value">${clientCount}</div>
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">📊</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Рентабельність</div>
        <div class="analityka-card-value" style="color:${profitColor}">${profitMargin}%</div>
        <span class="analityka-card-sub">${formatMoney(totalProfit)} грн</span>
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">✅</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Конверсія</div>
        <div class="analityka-card-value">${conversionRate}%</div>
        <span class="analityka-card-sub">${closedCount} з ${totalActs}</span>
      </div>
    </div>
    <div class="analityka-card">
      <div class="analityka-card-icon">🏆</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Макс. акт</div>
        <div class="analityka-card-value">#${maxAct.id}</div>
        <span class="analityka-card-sub">${formatMoney(maxAct.total)} грн</span>
      </div>
    </div>
    <div class="analityka-card" style="border-left: 3px solid ${trendColor}">
      <div class="analityka-card-icon">${trendIcon}</div>
      <div class="analityka-card-body">
        <div class="analityka-card-label">Прогноз</div>
        <div class="analityka-card-value">${formatMoney(forecast.forecastRevenue)}</div>
        <span class="analityka-card-sub">${forecast.nextMonthLabel}</span>
      </div>
    </div>
  `;
}

// ===================== ТОП КЛІЄНТІВ / МАШИН =====================

function getClientPIB(clientId: number | null): string {
  if (!clientId) return "Невідомий";
  const c = cachedClients.find((cl) => cl.client_id === clientId);
  const d = c?.data;
  if (typeof d === "string") {
    try {
      return JSON.parse(d)?.["ПІБ"] || "Невідомий";
    } catch {
      return "Невідомий";
    }
  }
  return d?.["ПІБ"] || "Невідомий";
}

function getCarNamePlate(carsId: number | null): {
  name: string;
  plate: string;
} {
  if (!carsId) return { name: "Невідомо", plate: "" };
  const c = cachedCars.find((cr) => cr.cars_id === carsId);
  let d = c?.data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return { name: "Невідомо", plate: "" };
    }
  }
  return {
    name: (d as any)?.["Авто"] || "Невідомо",
    plate: (d as any)?.["Номер авто"] || "",
  };
}

function getActTotal(act: ActRow): number {
  const d = act.data;
  if (!d) return 0;
  return (d["За роботу"] || 0) + (d["За деталі"] || 0);
}

function calcTopClientsBySum(): TopClient[] {
  if(cachedDashboard) return cachedDashboard.clients_sum;
  const map = new Map<number, TopClient>();
  for (const act of getFilteredActs()) {
    if (!act.client_id) continue;
    if (!map.has(act.client_id)) {
      map.set(act.client_id, {
        clientId: act.client_id,
        pib: getClientPIB(act.client_id),
        totalSum: 0,
        actsCount: 0,
      });
    }
    const c = map.get(act.client_id)!;
    c.totalSum += getActTotal(act);
    c.actsCount++;
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalSum - a.totalSum)
    .slice(0, 10);
}

function calcTopClientsByFrequency(): TopClient[] {
  if(cachedDashboard) return cachedDashboard.clients_count;
  const map = new Map<number, TopClient>();
  for (const act of getFilteredActs()) {
    if (!act.client_id) continue;
    if (!map.has(act.client_id)) {
      map.set(act.client_id, {
        clientId: act.client_id,
        pib: getClientPIB(act.client_id),
        totalSum: 0,
        actsCount: 0,
      });
    }
    const c = map.get(act.client_id)!;
    c.totalSum += getActTotal(act);
    c.actsCount++;
  }
  return Array.from(map.values())
    .sort((a, b) => b.actsCount - a.actsCount)
    .slice(0, 10);
}

function calcTopCarsBySum(): TopCar[] {
  if(cachedDashboard) return cachedDashboard.cars_sum;
  const map = new Map<number, TopCar>();
  for (const act of getFilteredActs()) {
    if (!act.cars_id) continue;
    if (!map.has(act.cars_id)) {
      const info = getCarNamePlate(act.cars_id);
      map.set(act.cars_id, {
        carsId: act.cars_id,
        carName: info.name,
        plate: info.plate,
        totalSum: 0,
        actsCount: 0,
      });
    }
    const c = map.get(act.cars_id)!;
    c.totalSum += getActTotal(act);
    c.actsCount++;
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalSum - a.totalSum)
    .slice(0, 10);
}

function calcTopCarsByFrequency(): TopCar[] {
  if(cachedDashboard) return cachedDashboard.cars_count;
  const map = new Map<number, TopCar>();
  for (const act of getFilteredActs()) {
    if (!act.cars_id) continue;
    if (!map.has(act.cars_id)) {
      const info = getCarNamePlate(act.cars_id);
      map.set(act.cars_id, {
        carsId: act.cars_id,
        carName: info.name,
        plate: info.plate,
        totalSum: 0,
        actsCount: 0,
      });
    }
    const c = map.get(act.cars_id)!;
    c.totalSum += getActTotal(act);
    c.actsCount++;
  }
  return Array.from(map.values())
    .sort((a, b) => b.actsCount - a.actsCount)
    .slice(0, 10);
}

// ===================== ТОП ДЕТАЛЕЙ =====================

interface TopPart {
  name: string;
  totalSum: number;
  totalQty: number;
  actsCount: number;
}

/** Топ-10 найдорожчих деталей (за загальною сумою) */
function calcTopPartsBySum(): TopPart[] {
  if(cachedDashboard) return cachedDashboard.parts_sum;
  const map = new Map<string, TopPart>();
  for (const act of getFilteredActs()) {
    const details = act.data?.Деталі;
    if (!details) continue;
    for (const det of details) {
      const name = det.Деталь?.trim();
      if (!name) continue;
      const qty = det.Кількість || 1;
      const price = det.Ціна || 0;
      const sum = qty * price;
      if (!map.has(name)) {
        map.set(name, { name, totalSum: 0, totalQty: 0, actsCount: 0 });
      }
      const p = map.get(name)!;
      p.totalSum += sum;
      p.totalQty += qty;
      p.actsCount++;
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalSum - a.totalSum)
    .slice(0, 10);
}

/** Топ-10 деталей, що встановлюються найчастіше */
function calcTopPartsByFrequency(): TopPart[] {
  if(cachedDashboard) return cachedDashboard.parts_count;
  const map = new Map<string, TopPart>();
  for (const act of getFilteredActs()) {
    const details = act.data?.Деталі;
    if (!details) continue;
    for (const det of details) {
      const name = det.Деталь?.trim();
      if (!name) continue;
      const qty = det.Кількість || 1;
      const price = det.Ціна || 0;
      const sum = qty * price;
      if (!map.has(name)) {
        map.set(name, { name, totalSum: 0, totalQty: 0, actsCount: 0 });
      }
      const p = map.get(name)!;
      p.totalSum += sum;
      p.totalQty += qty;
      p.actsCount++;
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.actsCount - a.actsCount || b.totalQty - a.totalQty)
    .slice(0, 10);
}

function renderTopPartsSection(): void {
  const container = document.getElementById("analityka-top-parts");
  if (!container) return;

  const bySum = calcTopPartsBySum();
  const byFreq = calcTopPartsByFrequency();

  // Перетин
  const sumNames = new Set(bySum.map((p) => p.name));
  const freqNames = new Set(byFreq.map((p) => p.name));
  const overlap = new Set([...sumNames].filter((n) => freqNames.has(n)));

  const rowsSum = bySum
    .map((p, i) => {
      const cls = overlap.has(p.name) ? "analityka-overlap-row" : "";
      const badge = overlap.has(p.name)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${truncateText(p.name, 40)}${badge}</td>
      <td>${formatMoney(p.totalSum)} грн</td>
      <td>${p.totalQty}</td>
      <td>${p.actsCount}</td>
    </tr>`;
    })
    .join("");

  const rowsFreq = byFreq
    .map((p, i) => {
      const cls = overlap.has(p.name) ? "analityka-overlap-row" : "";
      const badge = overlap.has(p.name)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${truncateText(p.name, 40)}${badge}</td>
      <td>${p.actsCount}</td>
      <td>${p.totalQty}</td>
      <td>${formatMoney(p.totalSum)} грн</td>
    </tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🔩 Топ-10 найдорожчих деталей</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Деталь</th><th>Сума</th><th>Кіл.</th><th>Актів</th></tr></thead>
          <tbody>${rowsSum || '<tr><td colspan="5" style="text-align:center;color:#999">Немає даних</td></tr>'}</tbody>
        </table>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🔄 Топ-10 найчастіших деталей</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Деталь</th><th>Актів</th><th>Кіл.</th><th>Сума</th></tr></thead>
          <tbody>${rowsFreq || '<tr><td colspan="5" style="text-align:center;color:#999">Немає даних</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    ${overlap.size > 0 ? `<div class="analityka-overlap-legend">⭐ — деталь у обох списках (найдорожча + найчастіша)</div>` : ""}
  `;
}

function renderTopClientsSection(): void {
  const container = document.getElementById("analityka-top-clients");
  if (!container) return;

  const bySum = calcTopClientsBySum();
  const byFreq = calcTopClientsByFrequency();

  // Знаходимо тих, хто в обох списках
  const sumIds = new Set(bySum.map((c) => c.clientId));
  const freqIds = new Set(byFreq.map((c) => c.clientId));
  const overlap = new Set([...sumIds].filter((id) => freqIds.has(id)));

  const rowsSum = bySum
    .map((c, i) => {
      const cls = overlap.has(c.clientId) ? "analityka-overlap-row" : "";
      const badge = overlap.has(c.clientId)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${c.pib}${badge}</td>
      <td>${formatMoney(c.totalSum)} грн</td>
      <td>${c.actsCount}</td>
    </tr>`;
    })
    .join("");

  const rowsFreq = byFreq
    .map((c, i) => {
      const cls = overlap.has(c.clientId) ? "analityka-overlap-row" : "";
      const badge = overlap.has(c.clientId)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${c.pib}${badge}</td>
      <td>${c.actsCount}</td>
      <td>${formatMoney(c.totalSum)} грн</td>
    </tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">💰 Топ-10 клієнтів (найбільший чек)</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Клієнт</th><th>Сума</th><th>Актів</th></tr></thead>
          <tbody>${rowsSum}</tbody>
        </table>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🔄 Топ-10 постійних клієнтів</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Клієнт</th><th>Актів</th><th>Сума</th></tr></thead>
          <tbody>${rowsFreq}</tbody>
        </table>
      </div>
    </div>
    ${overlap.size > 0 ? `<div class="analityka-overlap-legend">⭐ — клієнт у обох списках (найбільший чек + постійний)</div>` : ""}
  `;
}

function renderTopCarsSection(): void {
  const container = document.getElementById("analityka-top-cars");
  if (!container) return;

  const bySum = calcTopCarsBySum();
  const byFreq = calcTopCarsByFrequency();

  // Знаходимо тих, хто в обох списках
  const sumIds = new Set(bySum.map((c) => c.carsId));
  const freqIds = new Set(byFreq.map((c) => c.carsId));
  const overlap = new Set([...sumIds].filter((id) => freqIds.has(id)));

  const rowsSum = bySum
    .map((c, i) => {
      const cls = overlap.has(c.carsId) ? "analityka-overlap-row" : "";
      const badge = overlap.has(c.carsId)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${c.carName}${badge}</td>
      <td>${c.plate}</td>
      <td>${formatMoney(c.totalSum)} грн</td>
      <td>${c.actsCount}</td>
    </tr>`;
    })
    .join("");

  const rowsFreq = byFreq
    .map((c, i) => {
      const cls = overlap.has(c.carsId) ? "analityka-overlap-row" : "";
      const badge = overlap.has(c.carsId)
        ? ' <span class="analityka-overlap-badge">⭐</span>'
        : "";
      return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${c.carName}${badge}</td>
      <td>${c.plate}</td>
      <td>${c.actsCount}</td>
      <td>${formatMoney(c.totalSum)} грн</td>
    </tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">💰 Топ-10 авто (найбільший чек)</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Авто</th><th>Номер</th><th>Сума</th><th>Актів</th></tr></thead>
          <tbody>${rowsSum}</tbody>
        </table>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🔄 Топ-10 постійних авто</h3>
        <table class="analityka-table">
          <thead><tr><th>#</th><th>Авто</th><th>Номер</th><th>Актів</th><th>Сума</th></tr></thead>
          <tbody>${rowsFreq}</tbody>
        </table>
      </div>
    </div>
    ${overlap.size > 0 ? `<div class="analityka-overlap-legend">⭐ — авто у обох списках (найбільший чек + постійне)</div>` : ""}
  `;
}

function renderAnomalies(anomalies: Anomaly[]): void {
  const container = document.getElementById("analityka-anomalies");
  if (!container) return;

  if (anomalies.length === 0) {
    container.innerHTML = `<div class="analityka-anomaly-empty">✅ Аномалій не виявлено</div>`;
    return;
  }

  container.innerHTML = anomalies
    .map((a) => {
      const cls = `analityka-anomaly-item analityka-anomaly-${a.type}`;
      const actLink = a.actId
        ? `<span class="analityka-anomaly-act-link" data-act-id="${a.actId}">#${a.actId}</span>`
        : "";
      const msgWithLink = a.actId
        ? a.message.replace(`#${a.actId}`, actLink)
        : a.message;
      return `<div class="${cls}">${a.icon} ${msgWithLink}</div>`;
    })
    .join("");

  container.querySelectorAll(".analityka-anomaly-act-link").forEach((el) => {
    el.addEventListener("click", (e) => {
      const actId = (e.currentTarget as HTMLElement).dataset.actId;
      if (actId && (window as any).openActModalWithClient) {
        (window as any).openActModalWithClient(Number(actId));
      }
    });
  });
}

function renderMechanicsTable(data: MechanicStats[]): void {
  const container = document.getElementById("analityka-mechanics-table");
  if (!container) return;

  if (data.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:#999; padding:20px;">Немає даних</div>`;
    return;
  }

  const rows = data
    .map(
      (m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${m.name}</strong></td>
      <td>${m.actsCount}</td>
      <td>${formatMoney(m.totalEarned)} грн</td>
      <td>${formatMoney(m.totalSalary)} грн</td>
      <td>${formatMoney(m.avgPerAct)} грн</td>
    </tr>
  `,
    )
    .join("");

  container.innerHTML = `
    <table class="analityka-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Механік</th>
          <th>Актів</th>
          <th>Заробив для СТО</th>
          <th>Зарплата</th>
          <th>Сер. за акт</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ===================== УТИЛІТИ =====================

function formatMoney(val: number): string {
  return Math.round(val)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ===================== ГОЛОВНА ФУНКЦІЯ =====================

/** Перемальовує все без повторного завантаження з бази */
function redrawDashboard(): void {
  const dashboard=document.getElementById("analityka-dashboard");
  if(dashboard&&cachedDashboard)dashboard.dataset.asOf=cachedDashboard.as_of;
  const monthlyData = calcMonthlyRevenue();
  const topWorks = calcTopWorks();
  const serviceCategories = calcServiceCategories();
  const mechanicStats = calcMechanicStats();
  const anomalies = detectAnomalies();
  const forecast = calcForecast(monthlyData);

  // Знищуємо всі старі графіки перед перемальовуванням
  [
    revenueChart,
    topWorksChart,
    topServicesDonutChart,
    mechanicsChart,
    mechanicLoadChart,
    dayOfWeekChart,
    avgCheckTrendChart,
  ].forEach((ch) => {
    if (ch) ch.destroy();
  });
  revenueChart = null;
  topWorksChart = null;
  topServicesDonutChart = null;
  mechanicsChart = null;
  mechanicLoadChart = null;
  dayOfWeekChart = null;
  avgCheckTrendChart = null;

  renderSummaryCards(monthlyData, forecast);
  renderRevenueChart(monthlyData);
  renderDayOfWeekChart();
  renderAvgCheckTrendChart();
  renderWorkloadHeatmap();
  renderTopWorksChart(topWorks);
  renderTopServicesDonut(serviceCategories);
  renderMechanicsChart(mechanicStats);
  renderMechanicLoadChart(mechanicStats);
  renderMechanicsTable(mechanicStats);
  renderTopPartsSection();
  renderTopClientsSection();
  renderTopCarsSection();
  renderAnomalies(anomalies);
}

function destroyAnalyticsCharts(): void {
  [revenueChart, topWorksChart, topServicesDonutChart, mechanicsChart,
    mechanicLoadChart, workloadHeatmapChart, dayOfWeekChart, avgCheckTrendChart]
    .forEach(chart => chart?.destroy());
  revenueChart = topWorksChart = topServicesDonutChart = mechanicsChart = null;
  mechanicLoadChart = workloadHeatmapChart = dayOfWeekChart = avgCheckTrendChart = null;
}

function setAnalyticsMessage(message: string, error = false): void {
  const status = document.getElementById("analityka-report-status");
  if (status) {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  }
}

function renderAnalyticsEmpty(): void {
  const container = document.getElementById("analityka-dashboard");
  if (container) {
    container.innerHTML = '<div class="analityka-empty">📊 Виберіть дати «Від» і «До» та натисніть «Пошук», щоб переглянути звіт.</div>';
    delete container.dataset.asOf;
  }
}

function setAnalyticsLoading(loading: boolean): void {
  isLoading = loading;
  const container = document.getElementById("analityka-dashboard");
  container?.setAttribute("aria-busy", String(loading));
  document.querySelectorAll<HTMLButtonElement>(".Bukhhalter-add-button").forEach(button => {
    button.disabled = loading;
    button.textContent = loading ? "⏳ Завантаження…" : "🔍 Пошук";
    button.setAttribute("aria-busy", String(loading));
  });
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    "#Bukhhalter-analityka-section input, #Bukhhalter-analityka-section button",
  ).forEach(control => { control.disabled = loading; });
}

/** Cancel an unfinished explicit search when leaving the tab; keep the displayed report. */
export function suspendAnalityka(): void {
  analyticsRequest++;
  cancelAnalyticsDashboardRead();
  financialReader.cancel();
  if (isLoading) {
    setAnalyticsLoading(false);
    setAnalyticsMessage((analyticsView === 'financial' ? cachedFinancial : cachedDashboard)
      ? "Завантаження скасовано. На екрані попередній звіт."
      : "Завантаження скасовано. Натисніть «Пошук», щоб повторити.");
  }
}

export function clearAnalityka(): void {
  suspendAnalityka();
  invalidateAnalyticsDashboard();
  financialReader.clear();
  disposeFinancial?.(); disposeFinancial = undefined;
  destroyAnalyticsCharts();
  cachedDashboard = null;
  cachedFinancial = null;
  cachedPostArxiv = [];
  cachedPosts = [];
  filterDateFrom = filterDateTo = null;
  analyticsOwner = localStorage.getItem("userAuthData") || "";
  const from = document.getElementById("analityka-date-from") as HTMLInputElement | null;
  const to = document.getElementById("analityka-date-to") as HTMLInputElement | null;
  if (from) from.value = "";
  if (to) to.value = accountingToday();
  highlightQuickBtn("");
  setAnalyticsMessage("Дані завантажуються після натискання «Пошук».");
  renderAnalyticsEmpty();
}

/** Draft presets only: selecting dates does not query the database. */
function applyQuickRange(type: string): void {
  const fromInput = document.getElementById("analityka-date-from") as HTMLInputElement | null;
  const toInput = document.getElementById("analityka-date-to") as HTMLInputElement | null;
  if (!fromInput || !toInput) return;
  const today = accountingToday();
  const from = new Date(today + "T12:00:00");
  switch (type) {
    case "week": from.setDate(from.getDate() - 6); break;
    case "month": from.setDate(1); break;
    case "quarter": from.setMonth(Math.floor(from.getMonth() / 3) * 3, 1); break;
    case "year": from.setMonth(0, 1); break;
    default: return;
  }
  fromInput.value = fmtInputDate(from);
  toInput.value = today;
  highlightQuickBtn(type);
}

function fmtInputDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

function highlightQuickBtn(active: string): void {
  document.querySelectorAll<HTMLElement>("#Bukhhalter-analityka-section .analityka-quick-btn")
    .forEach(button => button.classList.toggle("active", button.dataset.range === active));
}

function setupDateFilter(): void {
  const from = document.getElementById("analityka-date-from") as HTMLInputElement | null;
  const to = document.getElementById("analityka-date-to") as HTMLInputElement | null;
  if (!from || !to || from.dataset.analyticsReady) return;
  from.dataset.analyticsReady = "true";
  if (!to.value) to.value = accountingToday();
  [from, to].forEach(input => {
    // The shared initializeDateInputs() already opens calendars for these static inputs.
    input.addEventListener("change", () => highlightQuickBtn(""));
  });
  document.querySelectorAll<HTMLElement>("#Bukhhalter-analityka-section .analityka-quick-btn")
    .forEach(button => button.addEventListener("click", () => applyQuickRange(button.dataset.range || "")));
  document.querySelectorAll<HTMLButtonElement>('[data-analytics-view]').forEach(button => {
    button.addEventListener('click', () => {
      const view = button.dataset.analyticsView;
      if ((view !== 'financial' && view !== 'operations') || view === analyticsView) return;
      suspendAnalityka();
      analyticsView = view;
      document.querySelectorAll<HTMLButtonElement>('[data-analytics-view]').forEach(item => {
        const active = item.dataset.analyticsView === view;
        item.setAttribute('aria-pressed', String(active)); item.classList.toggle('active', active);
      });
      renderCurrentAnalytics();
    });
  });
  const invalidate = () => {
    financialReader.clear(); invalidateAnalyticsDashboard();
    if (cachedFinancial || cachedDashboard) setAnalyticsMessage('Дані змінилися. Натисніть «Пошук», щоб оновити зведення.');
  };
  for (const name of ['sto:accounting-changed', 'sto:act-saved', 'sto:stock-saved', 'sto:stock-updated', 'sto:employee-saved', 'online']) {
    window.addEventListener(name, invalidate);
  }
  window.addEventListener("storage", event => {
    if ((event.key === null || event.key === "userAuthData") &&
        analyticsOwner !== (localStorage.getItem("userAuthData") || "")) clearAnalityka();
    else if (event.key === 'sto:accounting-revision') invalidate();
  });
}

function renderCurrentAnalytics(): void {
  disposeFinancial?.(); disposeFinancial = undefined;
  destroyAnalyticsCharts();
  const container = document.getElementById('analityka-dashboard');
  if (!container) return;
  let from: string, to: string;
  if (analyticsView === 'financial' && cachedFinancial) {
    disposeFinancial = renderFinancialOverview(container, cachedFinancial);
    container.dataset.asOf = cachedFinancial.generatedAt;
    from = cachedFinancial.from; to = cachedFinancial.to;
  } else if (analyticsView === 'operations' && cachedDashboard && filterDateFrom && filterDateTo) {
    renderDashboardLayout(); redrawDashboard();
    from = fmtInputDate(filterDateFrom); to = fmtInputDate(filterDateTo);
  } else {
    renderAnalyticsEmpty();
    setAnalyticsMessage('Дані завантажуються після натискання «Пошук».');
    return;
  }
  setAnalyticsMessage('Період звіту: ' + from.split('-').reverse().join('.') + ' — ' +
    to.split('-').reverse().join('.') + '. Для перевірки оновлень натисніть «Пошук».');
}

/** Opening the tab only prepares controls. It never reads Supabase or starts subscriptions. */
export function initAnalityka(): void {
  setupDateFilter();
  if ((cachedDashboard || cachedFinancial) && analyticsOwner !== (localStorage.getItem("userAuthData") || "")) clearAnalityka();
  const container = document.getElementById("analityka-dashboard");
  if (container && !container.childElementCount) {
    renderAnalyticsEmpty();
    setAnalyticsMessage("Дані завантажуються після натискання «Пошук».");
  }
}

/** One compact RPC per selected view. Operational graphs are loaded only on request. */
export async function searchAnalityka(): Promise<void> {
  if (isLoading) return;
  initAnalityka();
  const fromInput = document.getElementById("analityka-date-from") as HTMLInputElement | null;
  const toInput = document.getElementById("analityka-date-to") as HTMLInputElement | null;
  if (!fromInput || !toInput) return;
  let period: {from: string; to: string};
  try {
    if (fromInput.validity.badInput || toInput.validity.badInput) throw new Error("Введіть коректну дату.");
    period = requireAccountingPeriod(fromInput.value, toInput.value);
  } catch (error) {
    showNotification((error as Error).message, "warning");
    (!fromInput.value ? fromInput : toInput).focus();
    return;
  }
  const from = new Date(period.from + "T00:00:00.000");
  const to = new Date(period.to + "T23:59:59.999");
  const request = ++analyticsRequest;
  const owner = localStorage.getItem("userAuthData") || "";
  const view = analyticsView;
  if (view === 'operations') invalidateAnalyticsDashboard();
  setAnalyticsLoading(true);
  setAnalyticsMessage("Завантаження аналітики за вибраний період…");
  try {
    const isCurrent = () => request === analyticsRequest && owner === (localStorage.getItem('userAuthData') || '') && view === analyticsView;
    if (view === 'financial') {
      const dto = await financialReader.read(period.from, period.to, owner, isCurrent);
      if (!isCurrent()) return;
      cachedFinancial = dto;
    } else {
      const dto = await readAnalyticsDashboard<DashboardDTO>(from, to);
      if (!isCurrent()) return;
      cachedDashboard = dto;
      cachedPostArxiv = dto.planning;
      cachedPosts = Array.from({length: dto.posts_count}, (_, index) => ({post_id: index, name: ""}));
      filterDateFrom = from;
      filterDateTo = to;
    }
    analyticsOwner = owner;
    toInput.value = period.to;
    renderCurrentAnalytics();
  } catch (error) {
    if (request !== analyticsRequest || isCancelled(error)) return;
    const message = error instanceof Error ? error.message : "Помилка завантаження аналітики";
    setAnalyticsMessage(message + ((view === 'financial' ? cachedFinancial : cachedDashboard) ? " На екрані попередній звіт." : ""), true);
    showNotification(message, "error");
  } finally {
    if (request === analyticsRequest) setAnalyticsLoading(false);
  }
}

/** Compatibility for the previous explicit refresh action; always validates the dates. */
export async function refreshAnalityka(): Promise<void> {
  await searchAnalityka();
}

function renderDashboardLayout(): void {
  const container = document.getElementById("analityka-dashboard");
  if (!container) return;
  // Рендеримо структуру
  container.innerHTML = `
    <!-- Картки -->
    <div id="analityka-summary-cards" class="analityka-summary-cards"></div>

    <p class="analityka-report-status">Статистика робіт і завантаження. Вартість у графіках наведена до знижок; підсумки прибутку та всіх зарплат — у режимі «Фінанси».</p>

    <!-- Дохід по днях тижня + Тренд середнього чеку -->
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">📅 Вартість актів за днями тижня</h3>
        <div id="analityka-day-of-week-chart"></div>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">📉 Тренд середнього чеку</h3>
        <div id="analityka-avg-check-trend-chart"></div>
      </div>
    </div>

    <!-- 🌡️ Теплова карта завантаженості -->
    <div class="analityka-chart-block">
      <h3 class="analityka-chart-title">🌡️ Теплова карта завантаженості СТО</h3>
      <div id="analityka-workload-heatmap"></div>
    </div>

    <!-- Два блока: Топ робіт + Топ категорій (Пончик) -->
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🏆 Топ-10 робіт за вартістю</h3>
        <div id="analityka-top-works-chart"></div>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">🍩 Розподіл по категоріях послуг</h3>
        <div id="analityka-services-donut"></div>
      </div>
    </div>

    <!-- Два блока: Ефективність + Завантаженість -->
    <div class="analityka-row">
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">👨‍🔧 Фінансова ефективність майстрів</h3>
        <div id="analityka-mechanics-chart"></div>
      </div>
      <div class="analityka-chart-block analityka-half">
        <h3 class="analityka-chart-title">📊 Завантаженість (кількість робіт)</h3>
        <div id="analityka-mechanics-load-chart"></div>
      </div>
    </div>

    <!-- Таблиця механіків -->
    <div class="analityka-chart-block">
      <h3 class="analityka-chart-title">📊 Детальна статистика механіків</h3>
      <div id="analityka-mechanics-table"></div>
    </div>

    <!-- � Топ деталей -->
    <div id="analityka-top-parts"></div>

    <!-- �👤 Топ клієнтів -->
    <div id="analityka-top-clients"></div>

    <!-- 🚗 Топ машин -->
    <div id="analityka-top-cars"></div>

    <!-- Аномалії -->
    <div class="analityka-chart-block">
      <h3 class="analityka-chart-title">⚠️ Аномалії та попередження</h3>
      <div id="analityka-anomalies" class="analityka-anomalies"></div>
    </div>
  `;

}
