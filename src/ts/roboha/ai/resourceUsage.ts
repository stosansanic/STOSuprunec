import { SUPABASE_CONFIG } from "../../../config/project.config";
import { supabase } from "../../vxid/supabaseClient";
import { readStorageMetadata } from "./storageMetadata";

export interface DatabaseStats {
  sizeMb: number;
  sizeBytes: number;
  // The existing RPC reports usage, not the organization's plan quota.
  limitBytes: null;
  updatedAt: string;
}

export interface StorageStats {
  totalFiles: number;
  totalSizeMb: number;
  totalBytes: number;
  limitBytes: null;
  updatedAt: string;
  stale: boolean;
}

const DATABASE_TTL = 5 * 60_000;
const REFRESH_COOLDOWN = 60_000;
const FAILURE_COOLDOWN = 30_000;
const REQUEST_TIMEOUT = 20_000;
const STORAGE_SCAN_TIMEOUT = 60_000;
const FILE_REVISION = "sto:chat-files-revision";
// Reuse the existing read-only condition RPC; this constant never includes user input.
const STORAGE_TOTALS_QUERY = "select count(*) as total_files, count(*) filter (where metadata->>'size' ~ '^[0-9]+$') as known_sizes, coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0) as total_bytes from storage.objects where bucket_id = 'ai-photos'";
type ReadOptions = { force?: boolean };
type Failure = { at: number; error: Error };

let authUserId = "";
let finishAuthReady!: () => void;
const authReady = new Promise<void>(resolve => { finishAuthReady = resolve; });
function currentScope(): string {
  let employee = "";
  try { employee = localStorage.getItem("userAuthData") || ""; } catch { /* Memory only. */ }
  return JSON.stringify([SUPABASE_CONFIG.url, authUserId, employee]);
}
let owner = currentScope();
let databaseGeneration = 0;
let storageGeneration = 0;
let databaseSnapshot: DatabaseStats | null = null;
let storageSnapshot: StorageStats | null = null;
let databasePending: Promise<DatabaseStats> | null = null;
let storagePending: Promise<StorageStats> | null = null;
let databaseController: AbortController | null = null;
let storageController: AbortController | null = null;
let databaseFailure: Failure | null = null;
let storageFailure: Failure | null = null;
let storageAggregateUnavailable = false;

/** Discard private memory when the project, Supabase user or employee changes. */
export function clearResourceUsage(): void {
  databaseGeneration++;
  storageGeneration++;
  databaseController?.abort();
  storageController?.abort();
  databaseController = null;
  storageController = null;
  databaseSnapshot = null;
  storageSnapshot = null;
  databasePending = null;
  storagePending = null;
  databaseFailure = null;
  storageFailure = null;
  storageAggregateUnavailable = false;
  owner = currentScope();
}

function ensureScope(): string {
  const scope = currentScope();
  if (scope !== owner) clearResourceUsage();
  return scope;
}

function assertCurrent(scope: string, generation: number, type: "database" | "storage"): void {
  ensureScope();
  if (scope !== owner || generation !== (type === "database" ? databaseGeneration : storageGeneration)) {
    throw new Error("Дані статистики змінилися. Оновіть показники повторно.");
  }
}

function readError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallback);
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Bound each raw network await, not the whole scan. Once rejected, its caller
 * cannot continue pagination or publish a late result, even if fetch ignores abort.
 */
function boundedRead<T>(
  start: () => PromiseLike<T>,
  timeoutMs: number,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiresAt = Date.now() + timeoutMs;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      controller?.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new Error("Оновлення статистики скасовано."));
    const onTimeout = () => {
      fail(new Error("Час очікування статистики вичерпано. Спробуйте оновити пізніше."));
      controller?.abort();
    };
    if (controller?.signal.aborted) { onAbort(); return; }
    if (timeoutMs <= 0) { onTimeout(); return; }
    controller?.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onTimeout, timeoutMs);
    try {
      Promise.resolve(start()).then(value => {
        if (settled) return;
        if (Date.now() >= expiresAt) { onTimeout(); return; }
        settled = true;
        cleanup();
        resolve(value);
      }, fail);
    } catch (error) { fail(error); }
  });
}

/** A small scalar RPC cached for Atlas. No table downloads. */
export async function getDatabaseStats(options: ReadOptions = {}): Promise<DatabaseStats> {
  await boundedRead(() => authReady, REQUEST_TIMEOUT);
  const scope = ensureScope();
  const now = Date.now();
  if (databaseSnapshot && now - Date.parse(databaseSnapshot.updatedAt) <
      (options.force ? REFRESH_COOLDOWN : DATABASE_TTL)) return { ...databaseSnapshot };
  if (databasePending) return { ...await databasePending };
  if (databaseFailure && now - databaseFailure.at < FAILURE_COOLDOWN) throw databaseFailure.error;
  const generation = databaseGeneration;
  const controller = new AbortController();
  databaseController = controller;
  const request = (async (): Promise<DatabaseStats> => {
    try {
      const { data, error } = await boundedRead(
        () => supabase.rpc("get_db_size").abortSignal(controller.signal),
        REQUEST_TIMEOUT, controller,
      );
      assertCurrent(scope, generation, "database");
      if (error) throw new Error("Не вдалося отримати розмір бази даних через наявну функцію get_db_size.");
      const sizeBytes = nonnegativeInteger(data);
      if (sizeBytes === null) throw new Error("Некоректний розмір бази даних у відповіді get_db_size.");
      const snapshot: DatabaseStats = {
        sizeBytes,
        sizeMb: Math.round(sizeBytes / 1024 / 1024 * 100) / 100,
        limitBytes: null,
        updatedAt: new Date().toISOString(),
      };
      databaseSnapshot = snapshot;
      databaseFailure = null;
      return snapshot;
    } catch (error) {
      assertCurrent(scope, generation, "database");
      const failure = readError(error, "Не вдалося отримати розмір бази даних.");
      databaseFailure = { at: Date.now(), error: failure };
      throw failure;
    }
  })();
  databasePending = request;
  try { return { ...await request }; }
  finally {
    if (databasePending === request) databasePending = null;
    if (databaseController === controller) databaseController = null;
  }
}

/** Reading a card never initiates a database request. */
export function peekDatabaseStats(): DatabaseStats | null {
  ensureScope();
  return databaseSnapshot ? { ...databaseSnapshot } : null;
}

/** Reading a badge never initiates a Storage listing. */
export function peekStorageStats(): StorageStats | null {
  ensureScope();
  return storageSnapshot ? { ...storageSnapshot } : null;
}

/** Keep the last measurement visible; a later explicit refresh can rescan metadata. */
export function invalidateResourceFiles(): void {
  ensureScope();
  storageGeneration++;
  storageController?.abort();
  if (storageSnapshot) storageSnapshot = { ...storageSnapshot, stale: true };
  storageFailure = null;
  // Keep an active promise until it stops, so another click cannot duplicate its scan.
}

/** Measures ai-photos using one aggregate when supported. Never downloads file contents. */
export async function getStorageStats(options: ReadOptions = {}): Promise<StorageStats> {
  await boundedRead(() => authReady, REQUEST_TIMEOUT);
  const scope = ensureScope();
  const now = Date.now();
  if (storageSnapshot && (!options.force || now - Date.parse(storageSnapshot.updatedAt) < REFRESH_COOLDOWN)) {
    return { ...storageSnapshot };
  }
  if (storagePending) return { ...await storagePending };
  if (storageFailure && now - storageFailure.at < FAILURE_COOLDOWN) throw storageFailure.error;
  const generation = storageGeneration;
  const controller = new AbortController();
  storageController = controller;
  const deadline = Date.now() + STORAGE_SCAN_TIMEOUT;
  const remainingTime = () => Math.min(REQUEST_TIMEOUT, deadline - Date.now());
  const request = (async (): Promise<StorageStats> => {
    try {
      let totals: { totalFiles: number; totalBytes: number; totalSizeMb: number } | null = null;
      if (!storageAggregateUnavailable) {
        assertCurrent(scope, generation, "storage");
        const { data, error } = await boundedRead(
          () => supabase.rpc("execute_condition_query", { query_text: STORAGE_TOTALS_QUERY }).abortSignal(controller.signal),
          remainingTime(), controller,
        );
        assertCurrent(scope, generation, "storage");
        if (error) {
          // Only a missing/unsupported capability enables the metadata fallback.
          // A timeout or network failure must not multiply traffic into a full listing.
          if (["PGRST202", "42883", "42501", "0A000", "42P01", "42703"].includes(error.code)) {
            storageAggregateUnavailable = true;
          } else throw new Error("Не вдалося отримати підсумок розмірів файлів Атласу.");
        } else {
          const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
          const totalFiles = nonnegativeInteger(row?.total_files);
          const totalBytes = nonnegativeInteger(row?.total_bytes);
          const knownSizes = nonnegativeInteger(row?.known_sizes);
          if (totalFiles === null || totalBytes === null || knownSizes !== totalFiles) {
            throw new Error("Supabase не повернув повні дані про розміри файлів Атласу.");
          }
          totals = { totalFiles, totalBytes, totalSizeMb: Math.round(totalBytes / 1024 / 1024 * 100) / 100 };
        }
      }
      if (!totals) totals = await readStorageMetadata(async (folder, offset, limit) => {
        assertCurrent(scope, generation, "storage");
        const { data, error } = await boundedRead(
          () => supabase.storage.from("ai-photos").list(folder, {
            offset, limit, sortBy: { column: "name", order: "asc" },
          }),
          remainingTime(), controller,
        );
        assertCurrent(scope, generation, "storage");
        if (error) throw new Error("Не вдалося прочитати розміри файлів Атласу.");
        return data || [];
      });
      assertCurrent(scope, generation, "storage");
      if (Date.now() >= deadline) throw new Error("Підрахунок файлів перевищив час очікування. Спробуйте оновити пізніше.");
      const snapshot: StorageStats = {
        ...totals, limitBytes: null, updatedAt: new Date().toISOString(), stale: false,
      };
      storageSnapshot = snapshot;
      storageFailure = null;
      return snapshot;
    } catch (error) {
      assertCurrent(scope, generation, "storage");
      const failure = readError(error, "Не вдалося прочитати розміри файлів Атласу.");
      storageFailure = { at: Date.now(), error: failure };
      throw failure;
    }
  })();
  storagePending = request;
  try { return { ...await request }; }
  finally {
    if (storagePending === request) storagePending = null;
    if (storageController === controller) storageController = null;
  }
}

window.addEventListener("storage", event => {
  if (!event.key || event.key === "userAuthData") ensureScope();
  if (!event.key || event.key === FILE_REVISION) invalidateResourceFiles();
});
supabase.auth.onAuthStateChange((_event, session) => {
  // A token refresh for the same user must not trigger another expensive file scan.
  authUserId = session?.user.id || "";
  ensureScope();
  finishAuthReady();
});
