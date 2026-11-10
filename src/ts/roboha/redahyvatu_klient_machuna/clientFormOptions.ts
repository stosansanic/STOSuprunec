import { supabase } from "../../vxid/supabaseClient";

export interface ClientFormPage {
  items: any[];
  has_more: boolean;
  next_cursor: number | null;
}

const OPTION_PAGE_SIZE = 20;
// Keep a long-lived open modal bounded without time-based refetches.
const MAX_CACHED_VALUES = 128;
const MAX_CACHED_SEARCHES = 32;
const MAX_PAGES_PER_SEARCH = 16;

interface LoadedSearch {
  kind: string;
  query: string;
  client: string | null;
  pages: Map<number | null, ClientFormPage>;
  completeItems?: any[];
}

function normalizedQuery(kind: string, query: string): string {
  const text = query.trim().toLowerCase();
  if (kind === "carVinRestore") return text.replace(/\s/g, "");
  if (kind === "phone" || kind === "phoneEdit") {
    // The RPC also searches the digit-only phone representation. Formatting
    // the same number differently must not download another identical page.
    const digits = text.replace(/\D/g, "");
    if (digits) return digits;
  }
  return text;
}

function phoneMatches(phone: string, query: string): boolean {
  return phone.toLowerCase().includes(query)
    || (/^\d+$/.test(query) && phone.replace(/\D/g, "").includes(query));
}

function itemMatches(kind: string, item: any, query: string): boolean {
  if (!query) return true;
  if (kind === "carVinRestore") return normalizedQuery(kind, String(item.label || "")) === query;
  if (kind === "phone" || kind === "phoneEdit") {
    const phones = [String(item.phone || ""), ...(Array.isArray(item.phones)
      ? item.phones.filter((phone: unknown): phone is string => typeof phone === "string")
      : [])];
    return phones.some((phone: string) => phoneMatches(phone, query));
  }
  const label = kind === "client" ? item.fullName
    : kind === "carModel" ? item["Авто"]
    : kind === "carNumber" ? item["Номер авто"]
    : item.label;
  return String(label || "").toLowerCase().includes(query);
}

function validatedPage(value: any, after: number | null): ClientFormPage {
  if (!value || !Array.isArray(value.items) || value.items.length > OPTION_PAGE_SIZE
    || typeof value.has_more !== "boolean") {
    throw new Error("Не вдалося прочитати підказки.");
  }
  let previous = after ?? 0;
  for (const item of value.items) {
    const id = Number(item?.id);
    if (!Number.isSafeInteger(id) || id <= previous) {
      throw new Error("Некоректна сторінка підказок.");
    }
    previous = id;
  }
  if (value.items.length) {
    if (!Number.isSafeInteger(value.next_cursor) || value.next_cursor !== previous) {
      throw new Error("Некоректна сторінка підказок.");
    }
  } else if (value.has_more || value.next_cursor !== null) {
    throw new Error("Некоректна сторінка підказок.");
  }
  return value;
}

/** Modal-lifetime memory only; cached details are never a write baseline. */
export function createClientFormOptions(
  scope: () => string = () => "form",
  rpcName = "traffic_client_form_options",
) {
  const cache = new Map<string, any>();
  const pending = new Map<string, Promise<any>>();
  const searches = new Map<string, LoadedSearch>();
  let generation = 0;
  let owner = scope();
  const clear = () => {
    generation++;
    cache.clear();
    pending.clear();
    searches.clear();
  };
  async function readValue<T>(
    key: string,
    load: () => Promise<T>,
    remember?: (value: T) => void,
  ): Promise<T> {
    const current = scope();
    if (current !== owner) { clear(); owner = current; }
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const requestGeneration = generation;
    const request = (async () => {
      const value = await load();
      if (generation !== requestGeneration || scope() !== current) {
        throw new Error("Дані форми змінилися. Повторіть вибір запису.");
      }
      // Commit only after the scope/generation check, including derived search
      // indexes. A response to a closed modal must not repopulate its cache.
      remember?.(value);
      cache.set(key, value);
      while (cache.size > MAX_CACHED_VALUES) cache.delete(cache.keys().next().value!);
      return value;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { if (pending.get(key) === request) pending.delete(key); }
  }

  function rememberPage(
    kind: string, query: string, client: string | null,
    after: number | null, page: ClientFormPage,
  ) {
    const key = JSON.stringify([kind, query, client]);
    let search = searches.get(key);
    if (!search) {
      search = { kind, query, client, pages: new Map() };
    }
    searches.delete(key);
    searches.set(key, search);
    while (searches.size > MAX_CACHED_SEARCHES) searches.delete(searches.keys().next().value!);
    search.pages.set(after, page);
    while (search.pages.size > MAX_PAGES_PER_SEARCH) search.pages.delete(search.pages.keys().next().value!);
    if (search.completeItems) return;

    // Seeing the final page alone is insufficient. All pages must form a
    // contiguous chain beginning with the first page for this exact search.
    const rows: any[] = [];
    const visited = new Set<number | null>();
    let cursor: number | null = null;
    while (!visited.has(cursor)) {
      visited.add(cursor);
      const loaded = search.pages.get(cursor);
      if (!loaded) return;
      rows.push(...loaded.items);
      if (!loaded.has_more) {
        search.completeItems = rows;
        return;
      }
      cursor = loaded.next_cursor;
    }
  }

  function cachedSearchPage(
    kind: string, query: string, client: string | null, after: number | null,
  ): ClientFormPage | null {
    let source: LoadedSearch | undefined;
    for (const search of searches.values()) {
      if (search.kind !== kind || search.client !== client || !search.completeItems) continue;
      // Restoration searches are exact VIN matches. An empty prefix result
      // says nothing about a later complete VIN and must not hide that car.
      if (kind === "carVinRestore" && query !== search.query) continue;
      if (!query.startsWith(search.query)) continue;
      if (!source || search.query.length > source.query.length) source = search;
    }
    if (!source?.completeItems) return null;
    const matches: any[] = [];
    for (const item of source.completeItems) {
      if (after !== null && Number(item.id) <= after) continue;
      if (!itemMatches(kind, item, query)) continue;
      if (query && (kind === "phone" || kind === "phoneEdit") && Array.isArray(item.phones)) {
        // A cached broader query may have matched a different contact number.
        // Keep the displayed/selected phone aligned with this narrowed search.
        const phone = item.phones.find((value: unknown) => typeof value === "string"
          && phoneMatches(value, query));
        matches.push(phone === undefined ? item : { ...item, phone });
      } else {
        matches.push(item);
      }
      if (matches.length > OPTION_PAGE_SIZE) break;
    }
    const items = matches.slice(0, OPTION_PAGE_SIZE);
    return {
      items,
      has_more: matches.length > OPTION_PAGE_SIZE,
      next_cursor: items.length ? Number(items[items.length - 1].id) : null,
    };
  }

  return {
    clear,
    readEntity<T>(kind: string, id: string, load: () => Promise<T>): Promise<T> {
      return readValue(JSON.stringify(["entity", kind, id]), load);
    },
    async read(kind: string, query: string, after: number | null, client: string | null): Promise<ClientFormPage> {
      query = normalizedQuery(kind, query);
      client = kind === "carVinRestore" ? null : (client || null);
      if (after !== null && (!Number.isSafeInteger(after) || after <= 0)) {
        throw new Error("Некоректна сторінка підказок.");
      }
      return readValue(JSON.stringify(["options", kind, query, after, client]), async () => {
        if (kind === "carVinRestore" && !query) {
          return { items: [], has_more: false, next_cursor: null };
        }
        const local = cachedSearchPage(kind, query, client, after);
        if (local) return local;
        const { data, error } = kind === "carVinRestore"
          ? await supabase.rpc("traffic_client_car_vin_option", { p_query: query, p_after: after })
          : await supabase.rpc(rpcName, {
            p_kind: kind, p_query: query, p_after: after, p_client: client,
          });
        if (error) {
          if (error.code === "PGRST202" || error.code === "42883") {
            throw new Error("Для підказок установіть SQL-пакет оптимізації. Ручне введення доступне.");
          }
          throw error;
        }
        return validatedPage(data, after);
      }, page => rememberPage(kind, query, client, after, page));
    },
  };
}
