import { supabase } from '../../vxid/supabaseClient';
import { missingAccountingRpc } from './accountingRequests';

export interface ProfitAccountingFilter {
  from: string; to: string; mode: 'open' | 'close' | 'paid';
  category: string; paymentMethod: string;
  payment: string; type: string; status: string; discount: string;
  include_client: boolean; include_car: boolean;
  exclude_ids: number[];
}
export interface ProfitAccountingSummary {
  count: number; amount: number; negative: number; advances: number;
  detailsProfit: number; workProfit: number; cashDetails: number; cashWork: number; discount: number;
  eligibleCount: number; eligibleAmount: number; eligibleBaseline: string;
}
export interface ProfitAccountingCursor { date: string; id: number; stamp: string }
export interface ProfitAccountingSnapshot {
  filter: ProfitAccountingFilter; revision: string; rows: any[];
  summary: ProfitAccountingSummary; more: boolean; cursor: ProfitAccountingCursor | null;
}

export function isProfitAccountingStale(error: unknown): boolean {
  return String((error as any)?.message || error || '').includes('ACCOUNTING_REPORT_STALE');
}

/** Cache complete pages, never claim a partial page is the complete report. */
export function createProfitAccountingRead() {
  const saved = new Map<string, ProfitAccountingSnapshot>();
  let scope = '', generation = 0;
  let active: {key: string; controller: AbortController; promise: Promise<ProfitAccountingSnapshot>} | null = null;
  const cancel = () => { generation++; active?.controller.abort(); active = null; };
  const clear = () => { cancel(); saved.clear(); };
  return {
    clear, cancel,
    async read(filter: ProfitAccountingFilter, actor: string, more: boolean, isCurrent: () => boolean): Promise<ProfitAccountingSnapshot> {
      if (scope !== actor) { clear(); scope = actor; }
      const key = JSON.stringify(filter);
      const cached = saved.get(key);
      if (!isCurrent()) throw new DOMException('Пошук змінився', 'AbortError');
      if (cached && (!more || !cached.more)) { if (active) cancel(); return structuredClone(cached); }
      const cursor = more ? cached?.cursor ?? null : null;
      const requestKey = JSON.stringify([key, cursor]);
      if (active?.key === requestKey) return structuredClone(await active.promise);
      cancel();
      const current = generation;
      const controller = new AbortController();
      const promise = (async (): Promise<ProfitAccountingSnapshot> => {
        const { data, error } = await supabase.rpc('traffic_profit_accounting_page', {
          p_filter: filter, p_cursor: cursor, p_limit: 30, p_summary: !cached,
          p_expected_revision: cached?.revision ?? null,
        }).abortSignal(controller.signal);
        controller.signal.throwIfAborted();
        if (current !== generation || actor !== scope || !isCurrent()) throw new DOMException('Пошук змінився', 'AbortError');
        if (error) throw missingAccountingRpc('traffic_profit_accounting_page', error);
        if (data?.formula_version !== 1 || typeof data.revision !== 'string' || !Array.isArray(data.rows) || data.rows.length > 30 ||
            typeof data.has_more !== 'boolean' || (data.has_more && !data.rows.length)) throw new Error('Некоректна сторінка звіту прибутку');
        if (cached && cached.revision !== data.revision) throw new Error('ACCOUNTING_REPORT_STALE');
        const summary = cached?.summary ?? data.summary;
        if (!summary || !Number.isSafeInteger(summary.count) || summary.count < 0 || !Number.isSafeInteger(summary.eligibleCount) ||
            typeof summary.eligibleBaseline !== 'string' || !['amount','negative','advances','detailsProfit','workProfit','cashDetails','cashWork','discount','eligibleAmount']
              .every(field => Number.isFinite(summary[field]))) throw new Error('Некоректні підсумки звіту прибутку');
        const ids = new Set<number>(cached?.rows.map(row => row.id) || []);
        for (const row of data.rows) {
          if (!Number.isSafeInteger(row.id) || row.id === 0 || ids.has(row.id) || typeof row.date !== 'string' || typeof row.sortStamp !== 'string' || !Number.isFinite(row.amount))
            throw new Error('Некоректні рядки звіту прибутку');
          ids.add(row.id);
        }
        const next = data.next_cursor;
        const orderKey = (value: ProfitAccountingCursor) => [value.date, value.id > 0 ? '1' : '0', value.stamp, String(Math.abs(value.id)).padStart(16, '0')].join('|');
        if (data.has_more && (!next || !Number.isSafeInteger(next.id) || typeof next.date !== 'string' || typeof next.stamp !== 'string' ||
            (cursor && orderKey(next) >= orderKey(cursor))))
          throw new Error('Некоректний курсор звіту прибутку');
        const last = data.rows.at(-1);
        if (last && (!next || next.id !== last.id || next.date !== last.date || next.stamp !== last.sortStamp)) throw new Error('Некоректний курсор звіту прибутку');
        const result: ProfitAccountingSnapshot = {filter: structuredClone(filter), revision: data.revision,
          rows: [...(cached?.rows || []), ...data.rows], summary, more: data.has_more, cursor: next || null};
        if (result.rows.length > summary.count || (!result.more && result.rows.length !== summary.count)) throw new Error('ACCOUNTING_REPORT_STALE');
        saved.set(key, result);
        while (saved.size > 8) saved.delete(saved.keys().next().value!);
        return result;
      })();
      active = {key: requestKey, controller, promise};
      try { return structuredClone(await promise); }
      finally { if (active?.promise === promise) active = null; }
    },
  };
}
