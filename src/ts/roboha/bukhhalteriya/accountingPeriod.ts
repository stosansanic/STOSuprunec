import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

export type AccountingPeriod = { from: string; to: string };
export function accountingToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function accountingIso(value: unknown): string {
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!dmy) return "";
  const year = dmy[3].length === 2 ? `${Number(dmy[3]) >= 70 ? "19" : "20"}${dmy[3]}` : dmy[3];
  return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
}
export function nextAccountingDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function requireAccountingPeriod(from: string, to = ""): AccountingPeriod {
  from = accountingIso(from); to = to ? accountingIso(to) : accountingToday();
  if (!from) throw new Error("Встановіть дату «Від», з якої потрібно завантажити дані для пошуку.");
  if (!to || from > to) throw new Error("Дата «До» має бути не раніше дати «Від».");
  return { from, to };
}
export function readAccountingPeriod(tab: string): AccountingPeriod | null {
  const prefix = `Bukhhalter-${tab}-`;
  const from = document.getElementById(prefix + (tab === "vutratu" ? "date-from" : "date-open")) as HTMLInputElement | null;
  const to = document.getElementById(prefix + (tab === "vutratu" ? "date-to" : "date-close")) as HTMLInputElement | null;
  try { return requireAccountingPeriod(from?.value || "", to?.value || ""); }
  catch (error) { showNotification((error as Error).message, "warning"); from?.focus(); return null; }
}
export function periodContains(outer: AccountingPeriod, inner: AccountingPeriod): boolean {
  return outer.from <= inner.from && outer.to >= inner.to;
}
export type AccountingResource = 'stock' | 'profit' | 'payroll' | 'shops';
const revisions: Record<AccountingResource, number> = {stock: 0, profit: 0, payroll: 0, shops: 0};
const allResources = Object.keys(revisions) as AccountingResource[];
export function invalidateAccountingSearch(resources: AccountingResource[] = allResources): void {
  for (const resource of resources) revisions[resource]++;
}
export function accountingSearchScope(resource?: AccountingResource): string {
  return JSON.stringify([resource ? revisions[resource] : revisions, typeof localStorage === 'undefined' ? '' : localStorage.getItem('userAuthData')]);
}
/** Small cross-tab invalidation; no report or customer data is stored here. */
export function announceAccountingChange(resources: AccountingResource[], preserveLocal: AccountingResource[] = []): void {
  invalidateAccountingSearch(resources.filter(resource => !preserveLocal.includes(resource)));
  window.dispatchEvent(new CustomEvent('sto:accounting-changed', {detail: {resources}}));
  try { localStorage.setItem('sto:accounting-revision', JSON.stringify({resources, nonce: crypto.randomUUID()})); } catch { /* optional cross-tab signal */ }
}
if (typeof window !== 'undefined') {
  const events: Record<string, AccountingResource[]> = {
    'sto:act-saved': allResources, 'sto:stock-saved': ['stock','shops','profit'],
    'sto:stock-updated': ['stock','shops','profit'], 'sto:shop-saved': ['shops'],
    'sto:employee-saved': ['stock','payroll','profit'], 'sto:client-saved': ['profit'],
  };
  for (const [event, resources] of Object.entries(events)) window.addEventListener(event, () => invalidateAccountingSearch(resources));
  window.addEventListener('online', () => invalidateAccountingSearch());
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === 'userAuthData') invalidateAccountingSearch();
    if (event.key === 'sto:accounting-revision') {
      try {
        const resources = JSON.parse(event.newValue || '{}').resources;
        if (Array.isArray(resources)) invalidateAccountingSearch(resources.filter((r): r is AccountingResource => allResources.includes(r)));
      } catch { /* Ignore malformed browser events. */ }
    }
  });
}
if (typeof document !== 'undefined') document.addEventListener('other-base-data-updated', () => invalidateAccountingSearch());
let sessionOwner: string | null | undefined;
supabase.auth?.onAuthStateChange((event, session) => {
  const owner = session?.user?.id || null;
  if (owner !== sessionOwner || event === 'USER_UPDATED') invalidateAccountingSearch();
  sessionOwner = owner;
});
