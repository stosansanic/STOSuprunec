import { supabase } from "../vxid/supabaseClient";

// Each role has its own settings column; these IDs follow its existing toggles.
const SETTINGS: Record<string, { id: number; column: string }> = {
  Адміністратор: { id: 11, column: "data" },
  Приймальник: { id: 25, column: "Приймальник" },
  Запчастист: { id: 27, column: "Запчастист" },
  Складовщик: { id: 24, column: "Складовщик" },
};

let currentRole: string | null = null;
let revision = 0;
let cacheScope = "";
let cacheGeneration = 0;
const visibilityCache = new Map<string, boolean>();
const visibilityReads = new Map<string, Promise<boolean>>();
const visibilityVersions = new Map<string, number>();

function employeeScope(): string {
  try { return localStorage.getItem("userAuthData") || ""; }
  catch { return ""; }
}

/** UI visibility only. Server authorization is still checked for every NP action. */
export function invalidateNovaPoshtaSettingCache(): void {
  cacheGeneration++;
  revision++;
  visibilityCache.clear();
  visibilityReads.clear();
  visibilityVersions.clear();
}

function ensureVisibilityScope(): string {
  const scope = employeeScope();
  if (scope !== cacheScope) {
    invalidateNovaPoshtaSettingCache();
    cacheScope = scope;
  }
  return scope;
}

function rememberVisibility(role: string, enabled: boolean): void {
  ensureVisibilityScope();
  visibilityVersions.set(role, (visibilityVersions.get(role) || 0) + 1);
  visibilityReads.delete(role);
  visibilityCache.set(role, enabled);
}

let authUser: string | null | undefined;
supabase.auth.onAuthStateChange((_event, session) => {
  const user = session?.user?.id ?? null;
  if (user !== authUser || _event === "SIGNED_OUT") {
    authUser = user;
    invalidateNovaPoshtaSettingCache();
  }
});
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "userAuthData") invalidateNovaPoshtaSettingCache();
  });
  window.addEventListener("online", invalidateNovaPoshtaSettingCache);
  window.addEventListener("pageshow", event => {
    if (event.persisted) invalidateNovaPoshtaSettingCache();
  });
}

export function hasNovaPoshtaSetting(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTINGS, role);
}

export function applyNovaPoshtaVisibility(role: string, enabled: boolean): void {
  if (role !== currentRole) return;
  revision++;
  const item = document.getElementById("menu-item-nova-poshta");
  if (!item) return;
  item.hidden = !hasNovaPoshtaSetting(role) || !enabled;
  // Recalculate the horizontal menu arrows after its width changes.
  window.dispatchEvent(new Event("resize"));
}

export async function readNovaPoshtaSetting(role: string): Promise<boolean> {
  if (!hasNovaPoshtaSetting(role)) return false;
  const scope = ensureVisibilityScope();
  if (visibilityCache.has(role)) return visibilityCache.get(role)!;
  const pending = visibilityReads.get(role);
  if (pending) return pending;
  const generation = cacheGeneration;
  const roleVersion = visibilityVersions.get(role) || 0;
  const { id, column } = SETTINGS[role];
  const work = (async () => {
    const { data, error } = await supabase
      .from("settings")
      .select(`"${column}"`)
      .eq("setting_id", id)
      .maybeSingle();
    if (error) throw error;
    if (scope !== employeeScope()) throw new Error("Користувач змінився під час запиту");
    if (generation !== cacheGeneration || roleVersion !== (visibilityVersions.get(role) || 0)) {
      // A newer Realtime value wins over an older in-flight HTTP response.
      if (visibilityCache.has(role)) return visibilityCache.get(role)!;
      throw new Error("Налаштування змінилися під час запиту");
    }
    const value = (data as Record<string, unknown> | null)?.[column];
    // Preserve the existing default until this role explicitly turns it off.
    const enabled = value == null ? true : value === true;
    visibilityCache.set(role, enabled);
    return enabled;
  })();
  visibilityReads.set(role, work);
  try { return await work; }
  finally { if (visibilityReads.get(role) === work) visibilityReads.delete(role); }
}

export async function saveNovaPoshtaSetting(role: string, enabled: boolean): Promise<void> {
  if (!hasNovaPoshtaSetting(role)) return;
  const scope = employeeScope();
  const { id, column } = SETTINGS[role];
  const { data: existing, error: readError } = await supabase
    .from("settings").select("setting_id").eq("setting_id", id).maybeSingle();
  if (readError) throw readError;
  if (!existing) {
    const { error } = await supabase.from("settings").insert({
      setting_id: id, data: false, [column]: enabled,
    });
    if (!error) {
      if (scope === employeeScope()) rememberVisibility(role, enabled);
      return;
    }
    // Another role may have created this shared row in the meantime.
    if (error.code !== "23505") throw error;
  }
  const { error } = await supabase.from("settings")
    .update({ [column]: enabled }).eq("setting_id", id);
  if (error) throw error;
  if (scope === employeeScope()) rememberVisibility(role, enabled);
}

export function syncNovaPoshtaSetting(record: Record<string, unknown>): void {
  for (const [role, { id, column }] of Object.entries(SETTINGS)) {
    if (record.setting_id !== id || !Object.prototype.hasOwnProperty.call(record, column)) continue;
    const value = record[column];
    const enabled = value == null ? true : value === true;
    rememberVisibility(role, enabled);
    if (role === currentRole) applyNovaPoshtaVisibility(role, enabled);
  }
}

export async function initNovaPoshtaMenu(role: string | null): Promise<void> {
  ensureVisibilityScope();
  currentRole = role;
  const requestRevision = ++revision;
  const item = document.getElementById("menu-item-nova-poshta");
  if (!item) return;
  item.hidden = true;
  if (!role) return;
  if (!hasNovaPoshtaSetting(role)) {
    try {
      const employeeId = JSON.parse(localStorage.getItem("userAuthData") || "null")?.slyusar_id;
      if (!employeeId) return;
      const { data, error } = await supabase.functions.invoke("nova-poshta", { body: { action: "discover", employee_id: employeeId } });
      if (!error && requestRevision === revision) {
        item.hidden = data?.visible !== true;
        window.dispatchEvent(new Event("resize"));
        if (!item.hidden) void import("../roboha/novaPoshta/badge").then(m => m.initNovaPoshtaBadge()).catch(() => {});
      }
    } catch { /* The optional module must never block login. */ }
    return;
  }
  try {
    const enabled = await readNovaPoshtaSetting(role);
    if (requestRevision === revision) applyNovaPoshtaVisibility(role, enabled);
    void import("../roboha/novaPoshta/badge").then(m => m.initNovaPoshtaBadge()).catch(() => {});
  } catch (error) {
    console.warn("Не вдалося завантажити видимість Нової пошти", error);
  }
}
