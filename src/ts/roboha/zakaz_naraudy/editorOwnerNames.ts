import { supabase } from "../../vxid/supabaseClient";
import { readStockDirectory } from "../dodatu_inchi_bazu/inhi/referenceLookup";

type OwnerKind = "slyusars" | "shops";
type StaffNameRow = { data: { Name?: string; name?: string; "Ім'я"?: string; Доступ?: string; доступ?: string } };
type ShopNameRow = { name: string };

// Names are separate from payroll data: never populate or overwrite the financial cache.
const cache = new Map<OwnerKind, string[]>();
const pending = new Map<OwnerKind, Promise<string[]>>();
let generation = 0;
const actor = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let owner = actor();

function invalidateOwnerNames(): void {
  generation++;
  cache.clear();
  pending.clear();
}

/** One compact directory read per kind per open act; all filtering happens locally. */
export async function readEditorOwnerNames(kind: OwnerKind): Promise<string[]> {
  const currentActor = actor();
  if (currentActor !== owner) {
    invalidateOwnerNames();
    owner = currentActor;
  }
  const cached = cache.get(kind);
  if (cached) return [...cached];
  let request = pending.get(kind);
  if (!request) {
    const started = generation;
    request = (async () => {
      let names: string[];
      if (kind === "slyusars") {
        const rows = await readStockDirectory<StaffNameRow>("staff");
        if (!rows) throw new Error("Встановіть SQL-функцію traffic_stock_directory для списку імен.");
        names = rows.filter(row => (row.data?.Доступ ?? row.data?.доступ) === "Слюсар")
          .map(row => row.data.Name ?? row.data.name ?? row.data["Ім'я"] ?? "");
      } else {
        const rows = await readStockDirectory<ShopNameRow>("shops");
        if (!rows) throw new Error("Встановіть SQL-функцію traffic_stock_directory для списку магазинів.");
        names = rows.map(row => row.name);
      }
      if (started !== generation || currentActor !== actor()) {
        throw new Error("Контекст списку імен змінився. Повторіть відкриття.");
      }
      const result = [...new Set(names.filter(name => typeof name === "string" && name.trim()))]
        .sort((a, b) => a.localeCompare(b, "uk", { sensitivity: "base" }));
      cache.set(kind, result);
      return result;
    })();
    pending.set(kind, request);
  }
  try { return [...await request]; }
  finally { if (pending.get(kind) === request) pending.delete(kind); }
}

if (typeof window !== "undefined") {
  window.addEventListener("sto:editor-scope-reset", invalidateOwnerNames);
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "userAuthData") invalidateOwnerNames();
  });
  document.addEventListener("other-base-data-updated", invalidateOwnerNames);
  supabase.auth.onAuthStateChange(invalidateOwnerNames);
}
