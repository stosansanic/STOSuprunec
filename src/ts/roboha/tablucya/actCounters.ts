// Count the committed table, using the same status/date/search filters as its rows.
export function hideActCounters(): void {
  const table = document.getElementById("table-container-modal-sakaz_narad");
  if (table?.dataset) delete table.dataset.actTotal;
  const counters = document.getElementById("act-counters");
  if (counters) counters.hidden = true;
  document.getElementById("dateRangePicker")?.setAttribute("title", "Фільтр актів за датою та станом");
  updateActSearchSummary("", 0, 0);
}

export function refreshActCounters(): void {
  const container = document.getElementById("table-container-modal-sakaz_narad");
  const counters = document.getElementById("act-counters");
  const badge = document.getElementById("open-act-count");
  if (!container || !counters || !badge) return;
  const rows = container.querySelectorAll<HTMLTableRowElement>(
    ":scope > table > tbody > tr[data-act-id]",
  );
  const serverTotal = Number(container.dataset?.actTotal);
  const count = Number.isSafeInteger(serverTotal) && serverTotal >= 0
    ? serverTotal : new Set(Array.from(rows, (row) => row.dataset.actId)).size;
  badge.textContent = String(count);
  badge.title = `Актів у поточній таблиці: ${count}`;
  badge.setAttribute("aria-label", badge.title);
  // The badge passes pointer events through to the calendar.
  document.getElementById("dateRangePicker")?.setAttribute(
    "title", `Фільтр актів за датою та станом. ${badge.title}`,
  );
  counters.hidden = false;
}

export function updateActSearchSummary(search: string, found: number, total: number): void {
  const summary = document.getElementById("act-search-summary");
  if (!summary) return;
  summary.hidden = !search.trim();
  summary.textContent = search.trim() ? `Знайдено ${found} із ${total}` : "";
}
