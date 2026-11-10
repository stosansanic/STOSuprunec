import { SUPABASE_CONFIG } from "../../../config/project.config";

export class OfflineOwnerChanged extends Error {
  constructor() { super("Офлайн-сховище недоступне: користувач відсутній або змінився. Чернетки збережені."); }
}

/** Login timestamp/name changes do not orphan drafts. Permission changes isolate read caches. */
export function offlineScope(): string | null {
  try {
    const raw = localStorage.getItem("userAuthData");
    if (!raw) return null;
    const actor = JSON.parse(raw);
    if (!actor || !Number.isSafeInteger(Number(actor.slyusar_id)) || Number(actor.slyusar_id) <= 0 || !actor.Name || !actor.Доступ) return null;
    return JSON.stringify([SUPABASE_CONFIG.url, Number(actor.slyusar_id), actor.Доступ, actor.version || ""]);
  } catch { return null; }
}

export function assertOfflineScope(scope: string | null): asserts scope is string {
  if (!scope || offlineScope() !== scope) throw new OfflineOwnerChanged();
}

export async function offlineDatabaseName(scope: string): Promise<string> {
  assertOfflineScope(scope);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
  assertOfflineScope(scope);
  return "sto-offline-owner-v1-" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,"0")).join("");
}
