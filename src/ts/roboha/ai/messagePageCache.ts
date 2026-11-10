/** Short-lived memory only. Never used as authority for writes or permissions. */
export function createMessagePageCache<T>(scope: () => string, now = Date.now) {
  const pages = new Map<string, { at: number; rows: T[] }>();
  const pending = new Map<string, Promise<T[]>>();
  let owner = scope();
  let generation = 0;
  const clear = () => { generation++; pages.clear(); pending.clear(); };
  const read = async (key: string, fetchPage: () => Promise<T[]>): Promise<T[]> => {
    const current = scope();
    if (current !== owner) { clear(); owner = current; }
    const cached = pages.get(key);
    if (current && cached && now() - cached.at < 15_000) return structuredClone(cached.rows);
    let request = pending.get(key);
    if (!request) {
      const started = generation;
      request = fetchPage().then(rows => {
        if (started !== generation || current !== scope()) throw new Error("Дані чату змінилися. Відкрийте чат повторно.");
        if (current) {
          pages.delete(key);
          pages.set(key, { at: now(), rows: structuredClone(rows) });
          while (pages.size > 20) pages.delete(pages.keys().next().value!);
        }
        return rows;
      });
      pending.set(key, request);
      const active = request;
      void request.finally(() => { if (pending.get(key) === active) pending.delete(key); }).catch(() => {});
    }
    return structuredClone(await request);
  };
  return { read, clear };
}
