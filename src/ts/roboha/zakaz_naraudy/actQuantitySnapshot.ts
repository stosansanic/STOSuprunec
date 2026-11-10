/** A complete saved-act snapshot. Missing IDs are zero only within this coverage. */
export function createActQuantitySnapshot() {
  let epoch = 0;
  let saved: { actId: number; quantities: Map<number, number> } | null = null;
  return {
    revision: () => epoch,
    invalidate(actId?: number) { if (!actId || saved?.actId === actId) { epoch++; saved = null; } },
    seed(actId: number, quantities: ReadonlyMap<number, number>) {
      epoch++; saved = { actId, quantities: new Map(quantities) };
    },
    quantity(actId: number, stockId: number): number | undefined {
      return saved?.actId === actId ? saved.quantities.get(stockId) ?? 0 : undefined;
    },
  };
}
export const actQuantitySnapshot = createActQuantitySnapshot();
if (typeof window !== "undefined") {
  window.addEventListener("sto:editor-scope-reset", () => actQuantitySnapshot.invalidate());
  window.addEventListener("sto:act-saved", ((event: CustomEvent) => actQuantitySnapshot.invalidate(Number(event.detail?.actId) || undefined)) as EventListener);
  window.addEventListener("storage", event => { if (!event.key || event.key === "userAuthData") actQuantitySnapshot.invalidate(); });
}
