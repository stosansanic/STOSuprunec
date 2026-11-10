import { supabase } from "../../../vxid/supabaseClient";
import { readStockDirectory } from "./referenceLookup";

interface EmployeeNameRow {
  slyusar_id: number;
  data: { Name: string; Доступ?: string };
}
interface CompactStaffRow {
  slyusar_id: number;
  data: { Name?: string; name?: string; "Ім'я"?: string; Доступ?: string; доступ?: string };
}

let names: EmployeeNameRow[] | null = null;
let pending: Promise<EmployeeNameRow[]> | null = null;
let revision = 0;
const scope = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let actor = scope();
const normalizeName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function clearEmployeeNameReads(): void {
  revision++;
  names = null;
  pending = null;
}

async function readEmployeeNames(): Promise<EmployeeNameRow[]> {
  const owner = scope();
  if (owner !== actor) {
    clearEmployeeNameReads();
    actor = owner;
  }
  if (names) return names;
  if (pending) return pending;
  const generation = revision;
  const job = (async () => {
    // This RPC projects only ID, name and role, including legacy JSON strings.
    // Never fall back to downloading complete employee documents.
    const rows = await readStockDirectory<CompactStaffRow>("staff");
    if (!rows) throw new Error("Встановіть SQL-функцію traffic_stock_directory для списку співробітників.");
    const result = rows.map(row => {
      const id = Number(row.slyusar_id);
      const name = row.data?.Name ?? row.data?.name ?? row.data?.["Ім'я"] ?? "";
      const role = row.data?.Доступ ?? row.data?.доступ;
      if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== "string" || (role !== undefined && typeof role !== "string")) {
        throw new Error("Некоректний список імен співробітників.");
      }
      return { slyusar_id: id, data: { Name: name, ...(role !== undefined ? { Доступ: role } : {}) } };
    }).sort((a, b) => a.data.Name.localeCompare(b.data.Name, "uk", { sensitivity: "base" }) || a.slyusar_id - b.slyusar_id);
    if (owner !== scope() || generation !== revision) throw new Error("Список співробітників змінився. Повторіть пошук.");
    names = result;
    return result;
  })();
  pending = job;
  try { return await job; }
  finally { if (pending === job) pending = null; }
}

/** Search and page through names locally for the lifetime of the open modal. */
export async function readEmployeeNamePage(query = "", offset = 0, exact = false): Promise<{ items: EmployeeNameRow[]; total: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Некоректна сторінка списку співробітників.");
  const rows = await readEmployeeNames();
  const needle = normalizeName(query);
  const matches = rows.filter(row => {
    const name = normalizeName(row.data.Name);
    return exact ? name === needle : name.includes(needle);
  });
  return { items: structuredClone(matches.slice(offset, offset + 50)), total: matches.length };
}

if (typeof window !== "undefined") {
  window.addEventListener("sto:employee-saved", clearEmployeeNameReads);
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "userAuthData") clearEmployeeNameReads();
  });
  document.addEventListener("sto:other-bases-closed", clearEmployeeNameReads);
  document.addEventListener("other-base-data-updated", clearEmployeeNameReads);
  supabase.auth.onAuthStateChange(clearEmployeeNameReads);
}
