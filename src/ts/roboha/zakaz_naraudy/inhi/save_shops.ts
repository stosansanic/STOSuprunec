import { supabase } from "../../../vxid/supabaseClient";
import { payrollActorScope } from "../../../utils/payrollSafeWrite";
import { stableActJson } from "../../../utils/actSafeWrite";

interface ShopDetail {
  shopName: string; sclad_id: number | null; Найменування: string;
  Каталог: string | null; Кількість: number; Ціна: number; recordId?: string;
}
interface ShopFragment { date: string; entry: Record<string, any> }
interface ScopedShop { shop_id: number; name: string; entries: ShopFragment[] }
interface ShopContext {
  act_id: number; revision: string; context_checksum: string;
  date_on: string; date_off: string | null; clientInfo: string; carInfo: string;
  shops: ScopedShop[];
  stock: Array<{ sclad_id: number; rahunok: string | number | null; time_off: string | null }>;
}
function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Некоректна дата акту для історії магазинів.");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function checkContext(value: any, actId: number, revision: string): ShopContext {
  if (!value || Number(value.act_id) !== actId || value.revision !== revision ||
      !/^[a-f0-9]{32}$/.test(value.context_checksum || "") || !Array.isArray(value.shops) || !Array.isArray(value.stock) ||
      typeof value.clientInfo !== "string" || typeof value.carInfo !== "string") throw new Error("Некоректний контекст історії магазинів.");
  const ids = new Set<number>();
  for (const shop of value.shops) {
    if (!Number.isSafeInteger(Number(shop.shop_id)) || Number(shop.shop_id) <= 0 || ids.has(Number(shop.shop_id)) ||
        typeof shop.name !== "string" || !Array.isArray(shop.entries)) throw new Error("Некоректний магазин в історії акту.");
    ids.add(Number(shop.shop_id));
    const dates = new Set<string>();
    for (const fragment of shop.entries) {
      if (typeof fragment.date !== "string" || !fragment.date || dates.has(fragment.date) ||
          !fragment.entry || Number(fragment.entry.Акт) !== actId || !Array.isArray(fragment.entry.Деталі)) {
        throw new Error("Акт дублюється або має некоректну історію магазину. Потрібна перевірка.");
      }
      dates.add(fragment.date);
    }
  }
  return value;
}

/** Read only this act's fragments; the existing server CAS preserves payment fields. */
export async function syncShopsOnActSave(actId: number, rows: ShopDetail[], revision: string, lockOwner: string): Promise<void> {
  const actor = payrollActorScope();
  const assertActor = () => { if (actor !== payrollActorScope()) throw new Error("Користувач змінився під час синхронізації магазинів."); };
  const grouped = new Map<string, ShopDetail[]>();
  for (const row of rows) {
    const name = String(row.shopName || "").trim();
    if (name) grouped.set(name, [...(grouped.get(name) || []), row]);
  }
  const response = await supabase.rpc("traffic_act_shop_context", { p_act_id: actId, p_revision: revision, p_names: [...grouped.keys()] });
  if (response.error) throw response.error;
  assertActor();
  const context = checkContext(response.data, actId, revision);
  const date = dateOnly(context.date_on);
  if (!date) throw new Error("Не вдалося визначити дату відкриття акту.");
  const closed = dateOnly(context.date_off);
  const stock = new Map(context.stock.map(row => [Number(row.sclad_id), row]));
  const byName = new Map<string, ScopedShop[]>();
  for (const shop of context.shops) byName.set(shop.name, [...(byName.get(shop.name) || []), shop]);
  for (const name of grouped.keys()) if (byName.get(name)?.length !== 1) {
    throw new Error(`Магазин «${name}» відсутній або його ім'я неоднозначне. Історію не змінено.`);
  }
  const writes: Array<{ shop_id: number; changes: any[] }> = [];
  for (const shop of context.shops) {
    const current = grouped.get(shop.name) || [];
    const expected = shop.entries.find(fragment => fragment.date === date)?.entry ?? null;
    let desired: Record<string, any> | null = null;
    if (current.length) {
      const previous = expected?.Деталі || [];
      const byId = new Map<string, any>();
      for (const detail of previous) if (detail.recordId) {
        if (byId.has(String(detail.recordId))) throw new Error("Деталь дублюється в історії магазину.");
        byId.set(String(detail.recordId), detail);
      }
      const details = current.map((row, index) => {
        const previousAtIndex = previous[index];
        const recordId = row.recordId || (previousAtIndex?.Найменування === row.Найменування ? previousAtIndex.recordId : null) ||
          `${actId}_${shop.shop_id}_detail_${crypto.randomUUID()}`;
        const meta = row.sclad_id == null ? null : stock.get(Number(row.sclad_id));
        if (row.sclad_id != null && !meta) throw new Error("Складська позиція більше недоступна. Історію магазинів не змінено.");
        return { ...(byId.get(String(recordId)) || {}), sclad_id: row.sclad_id,
          Каталог: row.Каталог ? (Number.isNaN(Number(row.Каталог)) ? row.Каталог : Number(row.Каталог)) : null,
          Ціна: Number(row.Ціна) || 0, Рахунок: meta?.rahunok ?? null, Кількість: Number(row.Кількість) || 0,
          Найменування: row.Найменування, recordId };
      });
      desired = { ...(expected || {}), Акт: actId, Деталі: details, ДатаЗакриття: closed,
        Клієнт: context.clientInfo, Автомобіль: context.carInfo };
    }
    const changes = [];
    if (stableActJson(expected) !== stableActJson(desired)) changes.push({ date, act: String(actId), expected, desired });
    // Preserve other dates; historical relocation is a separate accounting operation.
    if (changes.length) writes.push({ shop_id: Number(shop.shop_id), changes });
  }
  if (!writes.length) return;
  assertActor();
  const result = await supabase.rpc("guarded_write_act_shop_fragments", {
    p_act_id: actId, p_revision: revision, p_context_checksum: context.context_checksum, p_lock_owner: lockOwner, p_shops: writes,
  });
  if (result.error) throw result.error;
  assertActor();
  if (Number(result.data?.act_id) !== actId || result.data?.revision !== revision || result.data?.status !== "saved") {
    throw new Error("Не отримано підтвердження історії магазинів.");
  }
}
