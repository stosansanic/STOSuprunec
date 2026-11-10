import { supabase } from "../../vxid/supabaseClient";
import { SUPABASE_CONFIG } from "../../../config/project.config";
export { statusLabel, stateLabels, normalizeTTN, npTimestamp, partyLines } from "../../../../supabase/functions/_shared/nova-poshta-domain";
export type { Shipment, Direction, ShipmentState } from "../../../../supabase/functions/_shared/nova-poshta-domain";

export class NpError extends Error {
  code: string;
  constructor(message: string, code = "NETWORK") { super(message); this.code = code; }
}
let availableUntil = 0;
let availabilityRequest: Promise<void> | undefined;
export function ensureServiceAvailable(): Promise<void> {
  return availabilityRequest ??= checkServiceAvailable().finally(() => { availabilityRequest = undefined; });
}
async function checkServiceAvailable(): Promise<void> {
  if (Date.now() < availableUntil) return;
  let response: Response;
  try {
    // This GET only reports whether the function/schema are ready. Keep it a
    // simple request (no custom headers) to avoid a browser CORS preflight.
    // Gateway JWT verification is disabled for this function; POST actions
    // validate the caller's Supabase JWT inside the function.
    response = await fetch(`${SUPABASE_CONFIG.url.replace(/\/$/, "")}/functions/v1/nova-poshta`, {
      method: "GET",
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new NpError("Не вдалося з’єднатися із сервісом Нової пошти. Перевірте мережу та повторіть.", "UNAVAILABLE");
  }
  if (response.status === 404) throw new NpError("Серверну частину Нової пошти ще не встановлено в цьому проєкті. Потрібно завершити встановлення інтеграції; введення пароля поки недоступне.", "NOT_DEPLOYED");
  const payload = await response.json().catch(() => null);
  if (payload?.code === "BOOT_ERROR") {
    throw new NpError("Серверна функція Нової пошти не запускається (BOOT_ERROR). Потрібно оновити її код у Supabase → Edge Functions → nova-poshta; причина запуску є у вкладці Logs.", "BOOT_ERROR");
  }
  if (response.status === 401) {
    throw new NpError("Supabase блокує перевірку функції (401). Перевірте налаштування Verify JWT для nova-poshta згідно з інструкцією встановлення.", "GATEWAY_AUTH");
  }
  if (payload?.code === "SETUP" && payload?.error?.includes("налаштування бази")) {
    throw new NpError("Оновіть функцію nova-poshta в Supabase вмістом 03-index.ts і виконайте 01-database.sql із поточного комплекту. Онлайн-версія використовує settings.novaposhta та acts.novaposhta.", "ONLINE_SETUP");
  }
  if (!response.ok || !payload?.ok || payload.service !== "nova-poshta") {
    throw new NpError(payload?.error || "Сервіс Нової пошти ще не готовий до роботи. Адміністратору потрібно перевірити його встановлення.", "SETUP");
  }
  availableUntil = Date.now() + 30000;
}
function employeeId(): number | null {
  try { return JSON.parse(localStorage.getItem("userAuthData") || "null")?.slyusar_id || null; }
  catch { return null; }
}
async function sessionKey() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new NpError("Увійдіть у програму повторно.", "LOGIN");
  return `np-session:${session.user.id}:${employeeId()}`;
}
const pendingReads = new Map<string, Promise<unknown>>();
const readActions = new Set(["overview", "list", "detail", "act_list", "act_detail", "link_options"]);
let readGeneration = 0;
export async function request<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  if (!readActions.has(action)) {
    readGeneration++; pendingReads.clear();
    try { return await requestNow<T>(action, values); }
    finally { readGeneration++; pendingReads.clear(); }
  }
  const key = await sessionKey();
  const id = JSON.stringify([readGeneration, key, sessionStorage.getItem(key), action, values]);
  const existing = pendingReads.get(id);
  if (existing) return existing as Promise<T>;
  const work = requestNow<T>(action, values);
  pendingReads.set(id, work);
  try { return await work; }
  finally { if (pendingReads.get(id) === work) pendingReads.delete(id); }
}
async function requestNow<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  const key = await sessionKey();
  const session = sessionStorage.getItem(key);
  if (action !== "authenticate" && !session) throw new NpError("Підтвердіть вхід працівника.", "EMPLOYEE_LOGIN");
  const { data, error } = await supabase.functions.invoke("nova-poshta", { body: { ...values, action, session } });
  let payload = data;
  if (error) {
    try { payload = await (error as { context?: Response }).context?.json(); } catch { /* Function unavailable or gateway error. */ }
    if (!payload?.error) throw new NpError("Сервіс Нової пошти недоступний. Якщо це перший запуск, адміністратору потрібно активувати серверну частину інтеграції.", "UNAVAILABLE");
  }
  if (key !== await sessionKey()) throw new NpError("Працівник змінився. Відкрийте розділ повторно.", "EMPLOYEE_LOGIN");
  if (!payload?.ok) {
    if (payload?.code === "EMPLOYEE_LOGIN") sessionStorage.removeItem(key);
    throw new NpError(payload?.error || "Не вдалося виконати запит.", payload?.code);
  }
  if (action === "authenticate") {
    if (payload.actor?.id !== employeeId()) throw new NpError("Підтвердіть пароль саме поточного працівника.", "CREDENTIALS");
    sessionStorage.setItem(key, payload.token);
  }
  if (action === "logout") sessionStorage.removeItem(key);
  return payload as T;
}
export interface Actor { id: number; name: string; role: string }
export interface Overview {
  actor: Actor; ready: number;
  connection: { name: string; enabled: boolean; has_key?: boolean; needs_reconnect?: boolean; phone?: string; login?: string; has_password?: boolean; last_sync: string | null; last_error: string | null; incoming_capability: string } | null;
  events: { id: number; shipment_id: string; raw_status: string; observed_at: string; np_shipments: { ttn: string; direction: string } }[];
}
export interface Staff { id: number; name: string; role: string; allowed: boolean }
export interface ActOption { act_id: number; label: string; editable: boolean }
