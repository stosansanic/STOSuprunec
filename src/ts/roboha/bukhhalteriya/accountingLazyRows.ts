/** Shared scroll loading for nested desktop tables and mobile document scrolling. */
const loaders = new Set<() => void>();
let renderingExport = false;
// UI increments are independent of network batches: up to three reveals per RPC.
export const ACCOUNTING_VISIBLE_STEP = 10;
export const ACCOUNTING_FETCH_BATCH = 30;
export function accountingVisibleRows<T>(rows: T[], count: number): T[] {
  return renderingExport ? rows : rows.slice(0, count);
}
let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; loaders.forEach(check => check()); });
}
document.addEventListener('scroll', schedule, {capture: true, passive: true});
window.addEventListener('resize', schedule, {passive: true});
document.addEventListener('visibilitychange', schedule);

function viewport(element: HTMLElement): {top: number; bottom: number} {
  let top = 0, bottom = window.innerHeight;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
    const rect = parent.getBoundingClientRect();
    top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
  }
  return {top, bottom};
}

export function accountingInitialRows(containerId: string): number {
  const container = document.getElementById(containerId);
  if (!container) return 10;
  const {top, bottom} = viewport(container);
  const body = container.matches('tbody') ? container : container.querySelector('tbody');
  const sample = body?.querySelector('tr:not(:has(.Bukhhalter-no-data))')?.getBoundingClientRect();
  const height = sample && sample.height > 0 ? sample.height : window.innerWidth <= 768 ? 180 : 56;
  const start = Math.max(top, body?.getBoundingClientRect().top || container.getBoundingClientRect().top);
  return Math.max(1, Math.min(100, Math.ceil(Math.max(0, bottom - start) / height) || 10));
}

export function createAccountingScroll(containerId: string, loadMore: () => Promise<void> | void) {
  let more = false, busy = false, running = false, failed = false;
  let shown = 0, total: number | undefined, epoch = 0;
  let observed: HTMLElement | null = null;
  const resize = new ResizeObserver(schedule);
  const statusId = `${containerId}-scroll-status`;
  function status(): void {
    const container = document.getElementById(containerId);
    if (!container) return;
    const table = container.matches('tbody') ? container.closest('table') : container.querySelector('table');
    if (!table) return;
    let label = document.getElementById(statusId);
    if (!label) { label = document.createElement('div'); label.id = statusId; label.className = 'Bukhhalter-scroll-status'; table.after(label); }
    label.setAttribute('role', 'status');
    const text = busy || running ? 'Завантаження…' : shown ? `Показано ${shown}${total === undefined ? '' : ` із ${total}`}` : '';
    if (!failed) { label.textContent = text; label.hidden = !text; }
    else {
      label.hidden = false; label.replaceChildren();
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторити завантаження';
      retry.onclick = () => { failed = false; void request(); };
      label.append(retry);
    }
    container.setAttribute('aria-busy', String(busy || running));
    if (observed !== table.parentElement) {
      resize.disconnect(); observed = table.parentElement;
      if (observed) resize.observe(observed);
    }
  }
  async function request(): Promise<void> {
    if (busy || running || !more) return;
    const version = epoch, previousCount = shown; running = true; status();
    try { await loadMore(); } catch { if (version === epoch) failed = true; }
    finally { running = false; status(); if (!failed && shown > previousCount) schedule(); }
  }
  function check(): void {
    if (!more || busy || running || failed || document.hidden) return;
    const container = document.getElementById(containerId);
    if (!container?.getClientRects().length) return;
    const rows = container.matches('tbody') ? (container as HTMLTableSectionElement).rows : container.querySelector('tbody')?.rows;
    if (!rows?.length) return;
    const {top, bottom} = viewport(container);
    const threshold = rows[Math.max(0, rows.length - 10)].getBoundingClientRect();
    // A ten-row reserve. Each successful append moves this threshold down.
    if (bottom > top && threshold.top <= bottom && container.getBoundingClientRect().bottom >= top) void request();
  }
  loaders.add(check);
  return {
    update(state: {more: boolean; busy?: boolean; shown: number; total?: number}): void {
      more = state.more; busy = !!state.busy; shown = state.shown; total = state.total; status(); schedule();
    },
    reset(): void { epoch++; more = false; busy = false; failed = false; shown = 0; total = undefined; status(); },
    pause(): void { more = false; epoch++; },
    refresh: schedule,
  };
}

/** Retain existing rows (and focus) when a scroll request adds more data. */
export function setAccountingRows(body: HTMLTableSectionElement, html: string): void {
  const staging = document.createElement('tbody'); staging.innerHTML = html;
  const rows = Array.from(staging.rows);
  rows.forEach((row, index) => {
    const current = body.rows[index];
    if (!current) body.append(row);
    else if (current.outerHTML !== row.outerHTML) current.replaceWith(row);
  });
  while (body.rows.length > rows.length) body.deleteRow(body.rows.length - 1);
}

/** Synchronous export: temporarily render every row, then restore the original DOM before paint. */
export function withAccountingExportRows(tableId: string, render: () => void, download: () => void): void {
  const table = document.getElementById(tableId) as HTMLTableElement | null;
  const body = table?.tBodies[0];
  if (!body) { download(); return; }
  const staging = document.createElement('tbody'); staging.id = body.id;
  body.replaceWith(staging); renderingExport = true;
  try { render(); download(); }
  finally { staging.replaceWith(body); renderingExport = false; }
}

/** Reports whose complete period is already cached keep totals/export independent of visible rows. */
export function createAccountingCachedRows(containerId: string, render: () => void) {
  let limit = 0, identity = '';
  const scroll = createAccountingScroll(containerId, () => { limit += 10; render(); });
  return {
    select<T>(rows: T[], key: (row: T) => string | number): T[] {
      if (renderingExport) return rows;
      const next = JSON.stringify(rows.map(key));
      if (next !== identity || !limit) { identity = next; limit = accountingInitialRows(containerId); scroll.reset(); }
      const visible = rows.slice(0, limit);
      scroll.update({more: visible.length < rows.length, shown: visible.length, total: rows.length});
      scroll.refresh();
      return visible;
    },
  };
}
