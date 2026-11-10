import { supabase } from '../../vxid/supabaseClient';
import { missingAccountingRpc } from './accountingRequests';
const cache = new Map<string, unknown>();
let pending: {key: string; controller: AbortController; promise: Promise<unknown>} | undefined;

export function cancelAnalyticsDashboardRead(): void {
  pending?.controller.abort();
  pending = undefined;
}

export function invalidateAnalyticsDashboard(): void {
  cache.clear();
  cancelAnalyticsDashboardRead();
}

export async function readAnalyticsDashboard<T>(from: Date | null, to: Date | null): Promise<T> {
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error('Оберіть коректні дати «Від» і «До» для пошуку аналітики');
  }
  if (from > to) throw new Error('Дата «Від» не може бути пізнішою за дату «До»');
  const actor = localStorage.getItem('userAuthData') || '';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = JSON.stringify([actor, from.toISOString(), to.toISOString(), timezone]);
  if (pending?.key === key) return structuredClone(await pending.promise) as T;
  cancelAnalyticsDashboardRead();
  if (cache.has(key)) return structuredClone(cache.get(key)) as T;
  const controller = new AbortController();
  const promise = (async () => {
    const {data, error} = await supabase.rpc('traffic_analytics_dashboard', {p_from: from.toISOString(), p_to: to.toISOString(), p_timezone: timezone}).abortSignal(controller.signal);
    controller.signal.throwIfAborted();
    if ((localStorage.getItem('userAuthData') || '') !== actor) throw new Error('Користувач змінився під час завантаження');
    if (error) throw missingAccountingRpc('traffic_analytics_dashboard', error);
    if (!data?.complete || data.formula_version !== 1 || !data.summary || !Array.isArray(data.monthly) || !Array.isArray(data.planning)) throw new Error('Некоректна відповідь аналітики');
    cache.set(key, data); while (cache.size > 20) cache.delete(cache.keys().next().value!);
    return data;
  })();
  pending = {key, controller, promise};
  try { return structuredClone(await promise) as T; } finally { if (pending?.promise === promise) pending = undefined; }
}

