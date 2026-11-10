import { supabase } from "../../../vxid/supabaseClient";
import { setupDropdownKeyboard } from "./sharedAutocomplete";

export type DirectoryKind = "slyusars" | "incomes" | "receivers" | "faktura" | "works" | "shops" | "details";
export const directoryId = (kind: DirectoryKind): string => ({ slyusars: "slyusar_id", incomes: "income_id", receivers: "receiver_id", faktura: "faktura_id", works: "work_id", shops: "shop_id", details: "detail_id" })[kind];
export interface DirectoryPage { items: any[]; total: number }
const label = (kind: DirectoryKind, row: any): string => kind === "faktura" ? row.oderjyvach ?? "" : kind === "works" || kind === "details" ? row.data ?? "" : row.data?.Name ?? "";
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
interface WorkSearchWord { word: string; stem: string }
// Keep tokenization and suffixes aligned with traffic_directory_page's work search.
function workSearchWords(value: string): WorkSearchWord[] {
  return normalize(value).split(/[^0-9a-zа-яёіїєґ]+/u).filter(Boolean).map(word => {
    if (!/^[а-яёіїєґ]+$/u.test(word)) return { word, stem: word };
    const trimmed = word.replace(/(ого|ому|ими|іми|ами|ями|ої|ій|ий|ім|их|іх|ою|ею|єю|ом|ем|ям|ах|ях|а|я|у|ю|і|и|е|о|є)$/u, "");
    return { word, stem: trimmed.length >= 3 ? trimmed : word };
  });
}
function matchesWorkSearch(name: string, query: string, words: WorkSearchWord[]): boolean {
  if (!query) return true;
  if (!words.length) return false;
  const candidates = workSearchWords(name);
  return words.every(search => candidates.some(candidate => candidate.word.startsWith(search.word) || candidate.stem === search.stem));
}
function canNarrowWorkSearch(query: string, words: WorkSearchWord[], previousQuery: string): boolean {
  if (!previousQuery) return true;
  if (!query || !words.length) return false;
  const previousWords = workSearchWords(previousQuery);
  // A matching new word must imply either the old raw prefix or the old stem.
  // Mere substring inclusion is unsafe once inflected word forms also match.
  return previousWords.length > 0 && previousWords.every(previous => words.some(current =>
    current.word.startsWith(previous.word) && (current.stem === previous.stem || current.stem.startsWith(previous.word))));
}
const cache = new Map<string, { kind: DirectoryKind; query: string; exact: boolean; offset: number; id: number | null; page: DirectoryPage }>();
const pending = new Map<string, Promise<DirectoryPage>>();
let revision = 0, actor = "";
const scope = () => localStorage.getItem("userAuthData") || "";
export function clearDirectoryReads(): void { revision++; cache.clear(); pending.clear(); }

/** Compact pages live until modal close or a mutation/auth invalidation. */
export async function readDirectory(kind: DirectoryKind, query = "", offset = 0, exact = false, id: number | null = null): Promise<DirectoryPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || (id !== null && (!Number.isSafeInteger(id) || id <= 0))) throw new Error("Некоректний ID або сторінка довідника.");
  const owner = scope();
  if (owner !== actor) { clearDirectoryReads(); actor = owner; }
  const cacheable = !(kind === "slyusars" && id !== null); // Never retain editable credential metadata.
  query = normalize(query);
  const key = JSON.stringify([kind, query, offset, exact, id]);
  const saved = cache.get(key);
  if (cacheable && saved) return structuredClone(saved.page);
  if (cacheable && id === null) {
    const workWords = kind === "works" ? workSearchWords(query) : [];
    for (const entry of cache.values()) {
      // Only a complete broader result proves that local narrowing cannot miss records.
      if (entry.kind !== kind || entry.id !== null || entry.offset !== 0 || entry.exact || entry.page.total !== entry.page.items.length) continue;
      if (kind === "works" ? !canNarrowWorkSearch(query, workWords, entry.query) : !query.includes(entry.query)) continue;
      const rows = entry.page.items.filter(row => exact ? normalize(label(kind, row)) === query : kind === "works" ? matchesWorkSearch(label(kind, row), query, workWords) : normalize(label(kind, row)).includes(query));
      return { items: structuredClone(rows.slice(offset, offset + 50)), total: rows.length };
    }
  }
  if (pending.has(key)) return structuredClone(await pending.get(key)!);
  const generation = revision;
  const job = (async () => {
    const { data, error } = await supabase.rpc("traffic_directory_page", { p_kind: kind, p_query: query, p_offset: offset, p_exact: exact, p_id: id });
    if (error) {
      // Older installations do not include shops/works/details in the RPC allowlist.
      if (error.message === "Invalid directory" && ["shops", "works", "details"].includes(kind)) {
        throw new Error("Довідник потребує оновлення на сервері. Зверніться до адміністратора.");
      }
      throw error;
    }
    if (scope() !== owner || generation !== revision) throw new Error("Довідник змінився. Повторіть пошук.");
    if (!data || !Array.isArray(data.items) || data.items.length > 50 || !Number.isSafeInteger(data.total) || data.total < data.items.length || data.items.some((row: any) => !Number.isSafeInteger(Number(row[directoryId(kind)])) || Number(row[directoryId(kind)]) <= 0 || typeof label(kind, row) !== "string") || (id !== null && (data.items.length > 1 || data.items.some((row: any) => Number(row[directoryId(kind)]) !== id))) || (!data.items.length && data.total > offset)) throw new Error("Некоректна сторінка довідника.");
    if (cacheable) {
      cache.set(key, { kind, query, offset, exact, id, page: data });
      while (cache.size > 80) cache.delete(cache.keys().next().value!);
    }
    return data as DirectoryPage;
  })();
  pending.set(key, job);
  try { return structuredClone(await job); }
  finally { if (pending.get(key) === job) pending.delete(key); }
}

function invalidateMutation(kind: DirectoryKind): void {
  clearDirectoryReads();
  if (kind === "slyusars" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:employee-saved"));
}
export async function writeDirectory(kind: DirectoryKind, id: number | null, patch: any, expected: any = null): Promise<{ status: string; row: any }> {
  if (kind === "faktura") throw new Error("Для контрагента використайте форму реквізитів.");
  if (id !== null && expected && patch && typeof patch === "object") {
    patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(expected[key]) !== JSON.stringify(value)));
    if (!Object.keys(patch).length) return { status: "unchanged", row: { [directoryId(kind)]: id, data: structuredClone(kind === "works" || kind === "details" ? expected.data : expected) } };
  }
  const owner = scope();
  const { data, error } = await supabase.rpc("traffic_directory_write", { p_kind: kind, p_id: id, p_patch: patch, p_expected: expected });
  if (error) { clearDirectoryReads(); throw error; }
  if (!data?.row || !["created", "updated", "existing", "unchanged"].includes(data.status) || !Number.isSafeInteger(Number(data.row[directoryId(kind)])) || Number(data.row[directoryId(kind)]) <= 0 || (id !== null && Number(data.row[directoryId(kind)]) !== id)) { clearDirectoryReads(); throw new Error("Не отримано підтвердження збереження запису."); }
  if (data.status === "created" || data.status === "updated") invalidateMutation(kind);
  if (scope() !== owner) throw new Error("Користувач змінився під час збереження. Оновіть довідник.");
  return data;
}
export async function deleteDirectory(kind: DirectoryKind, id: number, expected: any): Promise<{ status: "deleted"; id: number }> {
  if (!Number.isSafeInteger(id) || id <= 0 || !expected || typeof expected !== "object") throw new Error("Виберіть запис для видалення зі списку.");
  const owner = scope();
  const { data, error } = await supabase.rpc("traffic_directory_delete", { p_kind: kind, p_id: id, p_expected: expected });
  if (error) { clearDirectoryReads(); throw error; }
  if (data?.status !== "deleted" || Number(data.id) !== id) { clearDirectoryReads(); throw new Error("База не підтвердила видалення запису."); }
  invalidateMutation(kind);
  if (scope() !== owner) throw new Error("Користувач змінився під час видалення. Оновіть довідник.");
  return { status: "deleted", id };
}
if (typeof window !== "undefined") {
  window.addEventListener("online", clearDirectoryReads);
  window.addEventListener("storage", event => { if (!event.key || event.key === "userAuthData") clearDirectoryReads(); });
}
if (typeof document !== "undefined") {
  document.addEventListener("other-base-data-updated", clearDirectoryReads);
  document.addEventListener("sto:other-bases-closed", clearDirectoryReads);
}
supabase.auth?.onAuthStateChange(clearDirectoryReads);

/** One mounted dropdown; late responses cannot modify a replaced or closed form. */
export function mountDirectoryDropdown(kind: DirectoryKind, input: HTMLInputElement | HTMLTextAreaElement, dropdown: HTMLElement, onSelect: (row: any) => void | Promise<void>, onInput?: () => void): void {
  let request = 0, view = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let nextOffset: number | null = null, activeQuery = "", loadingMore = false;
  const controller = new AbortController();
  const previous = (input as any).__directoryController as AbortController | undefined;
  previous?.abort(); (input as any).__directoryController = controller;
  const close = () => {
    request++; view++; nextOffset = null; loadingMore = false; clearTimeout(timer);
    dropdown.replaceChildren(); dropdown.classList.add("hidden-all_other_bases");
  };
  // The same DOM nodes are reused by other directory sections.
  close();
  const observer = new MutationObserver(() => { if (!input.isConnected) controller.abort(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  controller.signal.addEventListener("abort", () => { close(); observer.disconnect(); }, { once: true });
  document.addEventListener("sto:other-bases-closed", () => controller.abort(), { signal: controller.signal });
  if (!previous) delete input.dataset.keyboardNavBound;
  setupDropdownKeyboard(input, dropdown);
  const render = async (query: string, offset = 0, append = false) => {
    if (controller.signal.aborted || !input.isConnected) return;
    const token = ++request;
    activeQuery = query;
    if (!append) { view++; nextOffset = null; loadingMore = false; dropdown.replaceChildren(); dropdown.classList.add("hidden-all_other_bases"); }
    const renderedView = view;
    if (kind === "works" && query.length < 3) { dropdown.replaceChildren(); dropdown.classList.add("hidden-all_other_bases"); return; }
    try {
      const page = await readDirectory(kind, query, offset);
      if (token !== request || !input.isConnected || controller.signal.aborted || (!input.readOnly && input.value.trim() !== query)) return;
      const renderedScope = scope(), renderedRevision = revision;
      if (!append) { dropdown.replaceChildren(); dropdown.scrollTop = 0; }
      dropdown.querySelector("[data-directory-more]")?.remove();
      for (const row of page.items) {
        const item = document.createElement("div"); item.className = "custom-dropdown-item";
        const name = label(kind, row);
        if (kind === "slyusars") {
          item.classList.add("custom-dropdown-item--employee");
          const employeeName = document.createElement("span");
          employeeName.className = "employee-dropdown-name";
          employeeName.textContent = name || "ПІБ не вказано";

          const access = String(row.data?.Доступ || "Рівень доступу не вказано").trim();
          const accessChip = document.createElement("span");
          const accessVariant: Record<string, string> = {
            Адміністратор: "admin",
            Приймальник: "receiver",
            Слюсар: "mechanic",
            Запчастист: "parts",
            Складовщик: "warehouse",
          };
          accessChip.className = `employee-dropdown-access employee-dropdown-access--${accessVariant[access] || "other"}`;
          accessChip.textContent = access;
          item.setAttribute("aria-label", `${name || "ПІБ не вказано"}, доступ: ${access}`);
          item.append(employeeName, accessChip);
        } else if (kind === "shops" || kind === "works") {
          item.textContent = name || "—";
        } else {
          if (kind === "faktura") item.classList.add("contragent-dropdown-item");
          item.textContent = `${name || "—"} · №${row[directoryId(kind)]}${row.data?.Доступ ? " · " + row.data.Доступ : ""}`;
        }
        item.addEventListener("mousedown", event => event.preventDefault());
        item.addEventListener("click", event => {
          event.stopPropagation();
          if (controller.signal.aborted || !input.isConnected || renderedView !== view || renderedScope !== scope() || renderedRevision !== revision) return;
          close(); input.value = name;
          const selection = view;
          Promise.resolve().then(() => {
            if (!controller.signal.aborted && input.isConnected && selection === view) return onSelect(row);
          }).catch(error => {
            if (selection === view && input.isConnected && !controller.signal.aborted) { dropdown.textContent = error?.message || "Не вдалося відкрити запис."; dropdown.classList.remove("hidden-all_other_bases"); }
          });
        });
        dropdown.append(item);
      }
      nextOffset = offset + page.items.length < page.total ? offset + page.items.length : null;
      if (nextOffset !== null) { const more = document.createElement("div"); more.dataset.directoryMore = ""; more.textContent = "Прокрутіть для наступних записів"; more.setAttribute("role", "status"); dropdown.append(more); }
      dropdown.classList.toggle("hidden-all_other_bases", page.total === 0);
    } catch (error: any) {
      if (token === request && input.isConnected && !controller.signal.aborted) { dropdown.textContent = error?.message || "Не вдалося завантажити довідник."; dropdown.classList.remove("hidden-all_other_bases"); }
    } finally { if (token === request) loadingMore = false; }
  };
  const open = () => { clearTimeout(timer); void render(input.readOnly ? "" : input.value.trim()); };
  input.addEventListener("input", () => { close(); onInput?.(); timer = setTimeout(open, 220); }, { signal: controller.signal });
  input.addEventListener("focus", open, { signal: controller.signal });
  input.addEventListener("click", open, { signal: controller.signal });
  input.addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Escape") close(); }, { signal: controller.signal });
  dropdown.addEventListener("scroll", () => {
    if (loadingMore || nextOffset === null || dropdown.classList.contains("hidden-all_other_bases") || dropdown.scrollTop + dropdown.clientHeight < dropdown.scrollHeight - 40) return;
    loadingMore = true; void render(activeQuery, nextOffset, true);
  }, { signal: controller.signal });
  document.addEventListener("click", event => { if (event.target !== input && !dropdown.contains(event.target as Node)) close(); }, { signal: controller.signal });
}
