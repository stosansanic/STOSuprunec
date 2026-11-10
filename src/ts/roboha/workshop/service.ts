import { workshopReadCache } from "./resourceCache";
import { supabase } from "../../vxid/supabaseClient";
import { readActJson } from "../../utils/actSafeWrite";
import { canUserOpenActs, canUserViewActs, userAccessLevel, userName } from "../tablucya/users";
import { readWorkshop, validateEntry, type Collection, type Entry } from "./model";

function databaseError(error: any): never {
  if (["PGRST202", "42883"].includes(error?.code)) throw new Error("Встановіть SQL 9.1 «Оптимізація PostgREST». Введені дані залишаються у формі.");
  throw error;
}

export interface WorkshopAct { act_id: number; cars_id: number | null; date_off: string | null; pruimalnyk: string | null; data: Record<string, any> }
export function canEditWorkshopAct(act: WorkshopAct): boolean {
  if (!userName) return false;
  if (userAccessLevel === "Адміністратор") return true;
  if (userAccessLevel === "Приймальник") return act.pruimalnyk === userName;
  if (userAccessLevel === "Слюсар") return (act.data.Роботи || []).some((w: any) => w.Слюсар === userName);
  return false;
}

export async function loadWorkshopAct(actId: number): Promise<WorkshopAct> {
  const scope = localStorage.getItem("userAuthData") || "";
  const role = userAccessLevel, name = userName;
  const assertOwner = () => {
    if (scope !== (localStorage.getItem("userAuthData") || "") || role !== userAccessLevel || name !== userName) throw new Error("Працівник змінився. Відкрийте картку повторно.");
  };
  if (!userAccessLevel || !await canUserOpenActs() || !await canUserViewActs()) throw new Error("Немає доступу до актів.");
  assertOwner();
  const { data, error } = await supabase.rpc("traffic_workshop_act", { p_act_id: actId });
  assertOwner();
  if (error) databaseError(error);
  if (error || !data) throw new Error("Не вдалося завантажити картку з бази.");
  const act = { ...data, data: readActJson(data.data) } as WorkshopAct;
  // The new workflow does not broaden the mechanic's scope to other jobs.
  if (userAccessLevel === "Слюсар" && !canEditWorkshopAct(act)) throw new Error("Картка доступна слюсарю, призначеному в цьому акті.");
  readWorkshop(act.data);
  return act;
}

export async function saveWorkshopEntry(actId: number, collection: Collection, expected: Entry | null, next: Entry) {
  if (!navigator.onLine) throw new Error("Для збереження потрібен інтернет. Дані залишаються у формі; локальна копія не створюється.");
  const scope = localStorage.getItem("userAuthData") || "";
  const employeeId = Number(JSON.parse(scope || "null")?.slyusar_id);
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0 || !userName) throw new Error("Підтвердіть вхід працівника.");
  // Preserve the submitted timestamp so a lost-response retry is identical.
  const saved = { ...next, author: userName! };
  validateEntry(collection, saved);
  const { data, error } = await supabase.rpc("traffic_workshop_entry_write", {
    p_act_id: actId, p_collection: collection, p_expected: expected, p_next: saved, p_employee_id: employeeId,
  });
  if (error) databaseError(error);
  if (scope !== (localStorage.getItem("userAuthData") || "")) throw new Error("Працівник змінився. Відкрийте картку повторно.");
  if (Number(data?.act_id) !== actId || data?.entry?.id !== saved.id || typeof data?.revision !== "string") throw new Error("Некоректне підтвердження збереження картки. Оновіть її перед повтором.");
  window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId, revision: data.revision, affectedCarIds: data.cars_id ? [data.cars_id] : undefined } }));
  return data as { act_id: number; entry: Entry; revision: string; cars_id: number | null; date_off: string | null; pruimalnyk: string | null; frozen: boolean };
}

export interface RecommendationPage { items: WorkshopAct[]; has_more: boolean; next_cursor: number | null }
export async function loadPreviousRecommendations(act: WorkshopAct, before: number | null = null): Promise<RecommendationPage> {
  if (!act.cars_id || userAccessLevel === "Слюсар") return { items: [], has_more: false, next_cursor: null };
  const scope = typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
  const role=userAccessLevel,name=userName;
  const rows=await workshopReadCache.readWithRetry(JSON.stringify(['recommendations',scope,role,name,act.cars_id,act.act_id,before]),()=>fetchPreviousRecommendations(act,before));
  if(role!==userAccessLevel || name!==userName || (typeof localStorage!=="undefined" && (localStorage.getItem("userAuthData") || "")!==scope)) throw new Error("Користувач змінився. Відкрийте картку повторно.");
  return rows;
}

async function fetchPreviousRecommendations(act: WorkshopAct, before: number | null): Promise<RecommendationPage> {
    const { data: page, error } = await supabase.rpc("traffic_workshop_recommendations", {
      p_car_id: act.cars_id, p_exclude_act: act.act_id, p_before: before,
    });
    if (error) databaseError(error);
    if (!page || !Array.isArray(page.items)) throw new Error("Некоректна відповідь історії рекомендацій.");
    if (!page.has_more) return { ...page, items: page.items.map((row: any) => ({ ...row, data: readActJson(row.data) })) };
    if (page.next_cursor == null || page.next_cursor === before) throw new Error("Не вдалося отримати наступну сторінку рекомендацій.");
    return { ...page, items: page.items.map((row: any) => ({ ...row, data: readActJson(row.data) })) };
}
