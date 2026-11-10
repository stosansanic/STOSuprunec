/** Cursor reads are driven by login/reconnect/focus/INSERT, never a fixed poll. */
export function createReminderInbox<T>(options: {
  isActive(): boolean;
  read(after: number | null): Promise<{ items: T[]; has_more: boolean; next_cursor: number | null; retry_at?: string | null }>;
  deliver(item: T): Promise<void>;
  onError(error: unknown): void;
}) {
  let running = false;
  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 5_000;
  async function drain(): Promise<void> {
    if (running || disposed || !options.isActive()) return;
    running = true;
    dirty = false;
    let failed = false;
    try {
      let after: number | null = null;
      do {
        const page = await options.read(after);
        if (disposed || !options.isActive()) return;
        if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("Invalid reminder inbox page");
        const retryAt = Date.parse(page.retry_at || "");
        // A crashed tab may have claimed but not started a delivery. Wake once
        // at its known lease expiry; ambiguous started sends are never retried.
        if (Number.isFinite(retryAt)) schedule(Math.max(500, retryAt - Date.now() + 100));
        for (const item of page.items) {
          if (disposed || !options.isActive()) return;
          await options.deliver(item);
        }
        if (!page.has_more) break;
        const next = Number(page.next_cursor);
        if (!page.items.length || !Number.isSafeInteger(next) || next <= (after ?? 0)) throw new Error("Invalid reminder inbox cursor");
        after = next;
      } while (!disposed && options.isActive());
      retryMs = 5_000;
    } catch (error) {
      failed = true;
      options.onError(error);
      // Bounded backoff only after a failed requested read; hidden pages do no work.
      if (!disposed && options.isActive()) { dirty = true; schedule(retryMs); retryMs = Math.min(retryMs * 2, 60_000); }
    } finally {
      running = false;
      if (dirty && !failed && !disposed && options.isActive()) {
        if (timer) clearTimeout(timer);
        timer = null;
        schedule(150);
      }
    }
  }
  function schedule(delay: number): void {
    if (timer || disposed) return;
    timer = setTimeout(() => { timer = null; if (running) dirty = true; else void drain(); }, delay);
  }
  return {
    wake() {
      dirty = true;
      if (!running && !disposed && options.isActive()) {
        if (timer) clearTimeout(timer);
        timer = null;
        schedule(150);
      }
    },
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
