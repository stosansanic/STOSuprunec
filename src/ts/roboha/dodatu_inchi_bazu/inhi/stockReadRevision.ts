import { supabase } from "../../../vxid/supabaseClient";

let revision = 0;
let suggestionRevision = 0;
/** Shared invalidation for stock pages and detail suggestions, without extra DB reads. */
export function invalidateStockReads(): void { revision++; suggestionRevision++; }
export function stockSuggestionRevision(): number { return suggestionRevision; }
export function stockReadRevision(): number { return revision; }
if (typeof window !== "undefined") {
  for (const event of ["focus", "online"]) window.addEventListener(event, () => { revision++; });
  for (const event of ["storage", "sto:act-saved", "sto:stock-updated"]) {
    window.addEventListener(event, invalidateStockReads);
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("other-base-data-updated", invalidateStockReads);
}
supabase.auth?.onAuthStateChange(() => invalidateStockReads());
