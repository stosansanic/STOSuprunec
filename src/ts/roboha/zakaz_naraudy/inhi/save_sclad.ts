//src\ts\roboha\zakaz_naraudy\inhi\save_shops.ts
import { supabase } from "../../../vxid/supabaseClient";
import { showNotification } from "./vspluvauhe_povidomlenna";
import { globalCache } from "../globalCache";
import { safeParseJSON } from "./ctvorennia_papku_googleDrive.";

/* ===================== ХЕЛПЕРИ ДЛЯ СИНХРОНІЗАЦІЇ З SHOPS ===================== */

type ShopRow = { shop_id?: number; data: any };

function toISODateOnly(dt: string | Date | null | undefined): string | null {
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(+d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`; // YYYY-MM-DD
}

async function fetchActDates(
  actId: number
): Promise<{ date_on: string | null; date_off: string | null }> {
  const { data, error } = await supabase
    .from("acts")
    .select("date_on, date_off")
    .eq("act_id", actId)
    .single();
  if (error) {
    // console.warn("Не вдалося прочитати дати акту:", error.message);
    return { date_on: null, date_off: null };
  }
  return { date_on: data?.date_on ?? null, date_off: data?.date_off ?? null };
}

/**
 * Отримання даних клієнта та автомобіля з акту
 */
async function fetchActClientAndCarData(actId: number): Promise<{
  clientInfo: string;
  carInfo: string;
}> {
  try {
    // Отримуємо дані акту
    const { data: act, error: actError } = await supabase
      .from("acts")
      .select("client_id, cars_id")
      .eq("act_id", actId)
      .single();

    if (actError || !act) {
      // console.warn("Не вдалося отримати дані акту:", actError?.message);
      return { clientInfo: "—", carInfo: "—" };
    }

    // Отримуємо дані клієнта
    let clientInfo = "—";
    if (act.client_id) {
      const { data: client } = await supabase
        .from("clients")
        .select("data")
        .eq("client_id", act.client_id)
        .single();
      
      if (client?.data) {
        const clientData = safeParseJSON(client.data);
        clientInfo = clientData?.["ПІБ"] || clientData?.fio || "—";
      }
    }

    // Отримуємо дані автомобіля
    let carInfo = "—";
    if (act.cars_id) {
      const { data: car } = await supabase
        .from("cars")
        .select("data")
        .eq("cars_id", act.cars_id)
        .single();
      
      if (car?.data) {
        const carData = safeParseJSON(car.data);
        const auto = carData?.["Авто"] || "";
        const year = carData?.["Рік"] || "";
        const nomer = carData?.["Номер авто"] || "";
        carInfo = `${auto} ${year} ${nomer}`.trim() || "—";
      }
    }

    return { clientInfo, carInfo };
  } catch (error) {
    // console.warn("Помилка при отриманні даних клієнта та авто:", error);
    return { clientInfo: "—", carInfo: "—" };
  }
}

async function fetchScladMeta(
  scladIds: number[]
): Promise<
  Map<number, { rahunok: string | number | null; time_off: string | null }>
> {
  if (scladIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("sclad")
    .select("sclad_id, rahunok, time_off") // ✅ тягнемо rahunok
    .in("sclad_id", Array.from(new Set(scladIds)));
  if (error) {
    // console.warn("fetchScladMeta():", error.message);
    return new Map();
  }
  const m = new Map<
    number,
    { rahunok: string | number | null; time_off: string | null }
  >();
  for (const r of data || []) {
    m.set(Number(r.sclad_id), {
      rahunok: (r as any).rahunok ?? null,
      time_off: (r as any).time_off ?? null,
    });
  }
  return m;
}

async function fetchShopByName(shopName: string): Promise<ShopRow | null> {
  const { data, error } = await supabase
    .from("shops")
    .select("shop_id, data")
    .eq("data->>Name", shopName)
    .maybeSingle();

  if (error) {
    // console.warn(`fetchShopByName(${shopName}):`, error.message);
    return null;
  }
  if (!data) return null;
  return { shop_id: data.shop_id, data: data.data };
}

async function updateShopJson(shop: ShopRow): Promise<void> {
  if (!shop.shop_id) return;
  const { error } = await supabase
    .from("shops")
    .update({ data: shop.data })
    .eq("shop_id", shop.shop_id);
  if (error)
    throw new Error(
      `Не вдалося оновити shops#${shop.shop_id}: ${error.message}`
    );
}

function ensureShopHistoryRoot(shop: ShopRow): any {
  if (!shop.data || typeof shop.data !== "object") shop.data = {};
  if (!shop.data["Історія"] || typeof shop.data["Історія"] !== "object")
    shop.data["Історія"] = {};
  return shop.data["Історія"];
}

// Побудувати "попередні" деталі (до збереження) з кешу рендера модалки
function collectPrevDetailRowsFromCache(): Array<{
  shopName: string;
  sclad_id: number | null;
  Найменування: string;
  Каталог: string | null;
  Кількість: number;
  Ціна: number;
}> {
  const out: Array<{
    shopName: string;
    sclad_id: number | null;
    Найменування: string;
    Каталог: string | null;
    Кількість: number;
    Ціна: number;
  }> = [];

  for (const it of globalCache.initialActItems || []) {
    if (it.type !== "detail") continue;
    const shopName = (it.person_or_store || "").trim();
    if (!shopName) continue;

    out.push({
      shopName,
      sclad_id: it.sclad_id ?? null,
      Найменування: it.name || "",
      Каталог: (it.catalog ?? "") || null,
      Кількість: Number(it.quantity ?? 0),
      Ціна: Number(it.price ?? 0),
    });
  }
  return out;
}

/**
 * Синхронізація shops.data.Історія:
 * - повністю замінює "Деталі" у поточних магазинах (на дату + акт);
 * - записує ДатаЗакриття з acts.date_off (або null якщо акт не закритий);
 * - додає інформацію про Клієнта та Автомобіль;
 * - чистить старі магазини (прибирає запис "Акт": N у день, якщо він спорожнів).
 */
async function syncShopsHistoryForAct(params: {
  actId: number;
  dateKey: string;              // YYYY-MM-DD з acts.date_on
  dateClose: string | null;     // YYYY-MM-DD з acts.date_off або null
  clientInfo: string;           // інформація про клієнта
  carInfo: string;              // інформація про автомобіль
  currentRows: Array<{
    shopName: string;
    sclad_id: number | null;
    Найменування: string;
    Каталог: string | null;
    Кількість: number;
    Ціна: number;
  }>;
  prevRows: Array<{
    shopName: string;
    sclad_id: number | null;
  }>;
}): Promise<void> {
  // ---- 1) згрупувати поточні та попередні за магазином ----
  const group = (rows: any[]) => {
    const m = new Map<string, any[]>();
    for (const r of rows) {
      const k = String(r.shopName || "").trim();
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };

  const curByShop = group(params.currentRows);
  const prevByShop = group(params.prevRows);

  // зібрати sclad_id для метаданих
  const scladIds: number[] = [];
  for (const arr of curByShop.values())
    for (const r of arr) if (r.sclad_id) scladIds.push(r.sclad_id);
  const meta = await fetchScladMeta(scladIds);

  // ---- 2) ОНОВИТИ/СТВОРИТИ записи для поточних магазинів (повна заміна "Деталі") ----
  for (const [shopName, rows] of curByShop.entries()) {
    const shopRow = await fetchShopByName(shopName);
    if (!shopRow) {
      showNotification(
        `Магазин "${shopName}" не знайдено у shops — пропущено`,
        "warning",
        1800
      );
      continue;
    }
    const out: any[] = [];
    for (const r of rows) {
      const metaR = r.sclad_id ? meta.get(r.sclad_id) || null : null;
      out.push({
        sclad_id: r.sclad_id,
        Каталог: r.Каталог
          ? isNaN(Number(r.Каталог))
            ? r.Каталог
            : Number(r.Каталог)
          : null,
        Ціна: Number(r.Ціна) || 0,
        Рахунок: metaR ? metaR.rahunok ?? null : null, // ✅ беремо з колонки rahunok
        Кількість: Number(r.Кількість) || 0,
        Найменування: r.Найменування,
      });
    }

    const history = ensureShopHistoryRoot(shopRow);
    if (!history[params.dateKey]) history[params.dateKey] = [];
    const dayBucket = history[params.dateKey] as any[];

    let actEntry = dayBucket.find(
      (e: any) => Number(e?.["Акт"]) === Number(params.actId)
    );
    if (!actEntry) {
      actEntry = { 
        Акт: params.actId, 
        Деталі: [], 
        ДатаЗакриття: null,
        Клієнт: "",
        Автомобіль: ""
      };
      dayBucket.push(actEntry);
    }
    actEntry["Деталі"] = out;
    actEntry["ДатаЗакриття"] = params.dateClose; // YYYY-MM-DD або null
    actEntry["Клієнт"] = params.clientInfo;
    actEntry["Автомобіль"] = params.carInfo;

    await updateShopJson(shopRow);
  }

  // ---- 3) ОЧИСТИТИ старі магазини, яких вже немає в поточному наборі ----
  for (const [oldShop] of prevByShop.entries()) {
    if (curByShop.has(oldShop)) continue; // цей магазин лишився — його "Деталі" вже замінені в п.2

    const shopRow = await fetchShopByName(oldShop);
    if (!shopRow) continue;

    const history = ensureShopHistoryRoot(shopRow);
    const dayBucket = history[params.dateKey] as any[] | undefined;
    if (!dayBucket) continue;

    const idx = dayBucket.findIndex(
      (e: any) => Number(e?.["Акт"]) === Number(params.actId)
    );
    if (idx === -1) continue;

    // Прибираємо запис акту для цього дня (всі деталі з цього магазину пішли)
    dayBucket.splice(idx, 1);

    // Якщо день спорожнів — за бажанням можна видалити ключ (залишаю як є)
    await updateShopJson(shopRow);
  }
}

/**
 * Головна функція для синхронізації магазинів при збереженні акту
 */
export async function syncShopsOnActSave(
  actId: number,
  detailRowsForShops: Array<{
    shopName: string;
    sclad_id: number | null;
    Найменування: string;
    Каталог: string | null;
    Кількість: number;
    Ціна: number;
  }>
): Promise<void> {
  try {
    const { date_on, date_off } = await fetchActDates(actId);
    const dateKey = toISODateOnly(date_on);
    const dateClose = toISODateOnly(date_off);

    if (!dateKey) {
      showNotification(
        "Не вдалось визначити дату відкриття акту — Історія в shops не оновлена",
        "warning",
        2000
      );
      return;
    }

    // Отримуємо дані клієнта та автомобіля
    const { clientInfo, carInfo } = await fetchActClientAndCarData(actId);

    const prevDetailRows = collectPrevDetailRowsFromCache();

    await syncShopsHistoryForAct({
      actId,
      dateKey,
      dateClose,
      clientInfo,
      carInfo,
      currentRows: detailRowsForShops,
      prevRows: prevDetailRows.map((r) => ({
        shopName: r.shopName,
        sclad_id: r.sclad_id,
      })),
    });
  } catch (error: any) {
    // console.error("Помилка синхронізації з shops:", error);
    showNotification(
      "Помилка синхронізації з магазинами: " + (error?.message || error),
      "error",
      3000
    );
  }
}