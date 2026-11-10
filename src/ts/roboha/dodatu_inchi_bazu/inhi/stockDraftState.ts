type StockRow = Record<string, any>;

const editableFields = [
  "date", "shop", "catno", "detail", "qty", "price", "clientPrice",
  "clientPriceManual", "warehouse", "invoice", "actNo", "unit",
  "orderStatus", "createdBy", "notes", "action",
] as const;

/** Keep drafts in memory across filter changes; never treat a validation flag as a user edit. */
export function collectStockDrafts<T extends StockRow>(
  rows: T[], originals: Map<string | number, StockRow>, emptyRows: WeakMap<object, StockRow>,
): T[] {
  return rows.filter(row => {
    // An act-link failure still needs an explicit retry even if the stock write succeeded.
    if (row.status === "⚠️ Збережено (акт не оновлено)") return true;
    const baseline = emptyRows.get(row) ?? (row._scladId
      ? originals.get(row._scladId) ?? originals.get(String(row._scladId))
      : undefined);
    if (!baseline) return true;
    return editableFields.some(field => field === "clientPriceManual"
      ? !!row[field] !== !!baseline[field]
      : String(row[field] ?? "") !== String(baseline[field] ?? ""));
  });
}

/** Drafts stay visible and replace their fetched counterpart without duplicating the same ID. */
export function mergeStockDrafts<T extends StockRow>(fresh: T[], drafts: T[]): T[] {
  const editedIds = new Set(drafts.filter(row => row._scladId != null).map(row => String(row._scladId)));
  return [...drafts, ...fresh.filter(row => !editedIds.has(String(row._scladId)))];
}
