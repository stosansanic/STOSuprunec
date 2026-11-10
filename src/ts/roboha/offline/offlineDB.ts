import { offlineScope, assertOfflineScope, offlineDatabaseName, OfflineOwnerChanged } from "./offlineOwner";
import { readOfflineSnapshot, OFFLINE_RESOURCES } from "./offlineSnapshot";
// src/ts/roboha/offline/offlineDB.ts
// 📵 IndexedDB модуль для offline-кешування актів, клієнтів, машин, робіт
// Використовується слюсарями без Wi-Fi в ямі

const LEGACY_DB_NAME = "sto-offline";
const DB_VERSION = 1;

// Сховища (object stores)
const STORE_ACTS = "acts";
const STORE_CLIENTS = "clients";
const STORE_CARS = "cars";
const STORE_WORKS = "works";
const STORE_DETAILS = "details";
const STORE_SLYUSARS = "slyusars";
const STORE_QUEUE = "syncQueue";
const STORE_META = "meta";

const databases = new Map<string, IDBDatabase>();
const databaseScopes = new WeakMap<IDBDatabase, string>();
function assertDatabaseOwner(db: IDBDatabase): void { assertOfflineScope(databaseScopes.get(db) || null); }

// ===================== ВІДКРИТТЯ БД =====================

async function openDB(): Promise<IDBDatabase> {
  const scope = offlineScope();
  assertOfflineScope(scope);
  const name = await offlineDatabaseName(scope);
  const existing = databases.get(name);
  if (existing) return existing;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // acts — кеш актів (ключ = act_id)
      if (!db.objectStoreNames.contains(STORE_ACTS)) {
        db.createObjectStore(STORE_ACTS, { keyPath: "act_id" });
      }

      // clients — кеш клієнтів (ключ = client_id)
      if (!db.objectStoreNames.contains(STORE_CLIENTS)) {
        db.createObjectStore(STORE_CLIENTS, { keyPath: "client_id" });
      }

      // cars — кеш машин (ключ = cars_id)
      if (!db.objectStoreNames.contains(STORE_CARS)) {
        const carsStore = db.createObjectStore(STORE_CARS, {
          keyPath: "cars_id",
        });
        carsStore.createIndex("by_client", "client_id", { unique: false });
      }

      // works — довідник робіт (ключ = work_id)
      if (!db.objectStoreNames.contains(STORE_WORKS)) {
        db.createObjectStore(STORE_WORKS, { keyPath: "work_id" });
      }

      // details — довідник деталей (ключ = detail_id)
      if (!db.objectStoreNames.contains(STORE_DETAILS)) {
        db.createObjectStore(STORE_DETAILS, { keyPath: "detail_id" });
      }

      // slyusars — кеш слюсарів (ключ = slyusar_id)
      if (!db.objectStoreNames.contains(STORE_SLYUSARS)) {
        db.createObjectStore(STORE_SLYUSARS, { keyPath: "slyusar_id" });
      }

      // syncQueue — черга для відкладених змін (autoIncrement)
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const queueStore = db.createObjectStore(STORE_QUEUE, {
          keyPath: "id",
          autoIncrement: true,
        });
        queueStore.createIndex("by_timestamp", "timestamp", { unique: false });
      }

      // meta — метадані (час останньої синхронізації тощо)
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      try { assertOfflineScope(scope); } catch(error) { db.close(); reject(error); return; }
      databases.set(name, db); databaseScopes.set(db, scope);
      db.onversionchange = () => { db.close(); databases.delete(name); };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

// ===================== GENERIC CRUD =====================

async function putRecord(storeName: string, record: any): Promise<void> {
  const db = await openDB();
  assertDatabaseOwner(db);
  if (storeName === STORE_QUEUE && record.owner !== db.name) throw new OfflineOwnerChanged();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => { try { assertDatabaseOwner(db); resolve(); } catch(error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
  });
}

async function putRecords(storeName: string, records: any[]): Promise<void> {
  if (!records.length) return;
  const db = await openDB();
  assertDatabaseOwner(db);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const r of records) {
      store.put(r);
    }
    tx.oncomplete = () => { try { assertDatabaseOwner(db); resolve(); } catch(error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
  });
}

async function getRecord<T = any>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openDB();
  assertDatabaseOwner(db);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => { try { assertDatabaseOwner(db); resolve(req.result as T); } catch(error) { reject(error); } };
    req.onerror = () => reject(req.error);
  });
}

async function getAllRecords<T = any>(storeName: string): Promise<T[]> {
  const db = await openDB();
  assertDatabaseOwner(db);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => { try { assertDatabaseOwner(db); resolve(req.result as T[]); } catch(error) { reject(error); } };
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecord(
  storeName: string,
  key: IDBValidKey,
  owner?: string,
): Promise<void> {
  const db = await openDB();
  assertDatabaseOwner(db);
  if (storeName === STORE_QUEUE && owner !== db.name) throw new OfflineOwnerChanged();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => { try { assertDatabaseOwner(db); resolve(); } catch(error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStore(storeName: string): Promise<void> {
  const db = await openDB();
  assertDatabaseOwner(db);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    if (storeName === STORE_QUEUE) {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (entry.value.owner === db.name) entry.delete();
        entry.continue();
      };
    } else store.clear();
    tx.oncomplete = () => { try { assertDatabaseOwner(db); resolve(); } catch(error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
  });
}

// ===================== ACTS =====================

export async function cacheActs(acts: any[]): Promise<void> {
  // List read models are incomplete documents and must never replace an
  // editable offline snapshot, including through a new caller in the future.
  await putRecords(STORE_ACTS, acts.filter(act => !act.__sto_projection));
}

export async function getCachedAct(actId: number): Promise<any | undefined> {
  return getRecord(STORE_ACTS, actId);
}

export async function getCachedActs(): Promise<any[]> {
  return getAllRecords(STORE_ACTS);
}

export async function updateCachedAct(act: any): Promise<void> {
  if (act.__sto_projection) return;
  await putRecord(STORE_ACTS, act);
}

// ===================== CLIENTS =====================

export async function cacheClients(clients: any[]): Promise<void> {
  await putRecords(STORE_CLIENTS, clients);
}

export async function getCachedClients(): Promise<any[]> {
  return getAllRecords(STORE_CLIENTS);
}

// ===================== CARS =====================

export async function cacheCars(cars: any[]): Promise<void> {
  await putRecords(STORE_CARS, cars);
}

export async function getCachedCars(): Promise<any[]> {
  return getAllRecords(STORE_CARS);
}

// ===================== WORKS / DETAILS / SLYUSARS =====================

export async function cacheWorks(works: any[]): Promise<void> {
  await putRecords(STORE_WORKS, works);
}

export async function getCachedWorks(): Promise<any[]> {
  return getAllRecords(STORE_WORKS);
}

export async function cacheDetails(details: any[]): Promise<void> {
  await putRecords(STORE_DETAILS, details);
}

export async function getCachedDetails(): Promise<any[]> {
  return getAllRecords(STORE_DETAILS);
}

export async function cacheSlyusars(slyusars: any[]): Promise<void> {
  await putRecords(STORE_SLYUSARS, slyusars);
}

export async function getCachedSlyusars(): Promise<any[]> {
  return getAllRecords(STORE_SLYUSARS);
}

// ===================== SYNC QUEUE =====================

export interface SyncQueueItem {
  owner?: string; // Missing owner is quarantined and never replayed.
  blockedReason?: string;
  id?: number; // autoIncrement
  timestamp: number;
  operation: "update_act" | "update_act_field";
  table: string;
  recordId: number;
  payload: any;
  retries: number;
}

export async function addToSyncQueue(
  item: Omit<SyncQueueItem, "id">,
): Promise<void> {
  const db = await openDB();
  assertDatabaseOwner(db);
  if (item.owner && item.owner !== db.name) throw new OfflineOwnerChanged();
  await putRecord(STORE_QUEUE, { ...item, owner: db.name });
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  const db = await openDB();
  const rows = await getAllRecords<SyncQueueItem>(STORE_QUEUE);
  assertDatabaseOwner(db);
  return rows.filter(item => item.owner === db.name);
}

export async function removeSyncQueueItem(id: number, owner?: string): Promise<void> {
  const db = await openDB();
  assertDatabaseOwner(db);
  if (!owner || db.name !== owner) throw new OfflineOwnerChanged();
  await deleteRecord(STORE_QUEUE, id, owner);
}

export async function clearSyncQueue(): Promise<void> {
  await clearStore(STORE_QUEUE);
}

export async function getSyncQueueCount(): Promise<number> {
  const items = await getSyncQueue();
  return items.length;
}

// ===================== META =====================

export async function setMeta(key: string, value: any): Promise<void> {
  await putRecord(STORE_META, { key, value, updatedAt: Date.now() });
}

export async function getMeta(key: string): Promise<any> {
  const record = await getRecord<{ key: string; value: any }>(STORE_META, key);
  return record?.value;
}

// ===================== ПОВНА СИНХРОНІЗАЦІЯ КЕШУ =====================

/**
 * Зберігає всі дані з Supabase в IndexedDB для offline-доступу.
 * Викликається при вході + періодично (якщо онлайн).
 */
let refreshPending: { scope: string; promise: Promise<void> } | null = null;

export async function refreshOfflineCache(supabase: any): Promise<void> {
  const scope = offlineScope();
  if (!scope) return;
  if (refreshPending?.scope === scope) return refreshPending.promise;
  const requestedAt = Date.now();
  const refresh = async () => {
    if (offlineScope() !== scope) return;
    // Another tab may have published the same owner's complete snapshot while
    // this tab waited for the lock. Failed refreshes never advance lastSync.
    if ((await getMeta("lastSync")) >= requestedAt) return;
    await refreshOfflineCacheOnce(supabase);
  };
  const pending = typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(`sto-offline-refresh:${scope}`, refresh)
    : refresh();
  refreshPending = { scope, promise: pending };
  try { await pending; } finally {
    if (refreshPending?.promise === pending) refreshPending = null;
  }
}

async function refreshOfflineCacheOnce(supabase: any): Promise<void> {
  try {
    const scope = offlineScope();
    assertOfflineScope(scope);
    const snapshotKey = "offlineSnapshot:v1:" + String(supabase.supabaseUrl || "");
    const saved = await getMeta(snapshotKey);
    const snapshot = await readOfflineSnapshot(supabase, saved?.scope === scope ? saved.snapshot : undefined);
    if (offlineScope() !== scope) return;
    const [actsRes, clientsRes, carsRes, worksRes, detailsRes, slyusarsRes] = snapshot
      ? OFFLINE_RESOURCES.map(resource => ({data: snapshot.pages[resource].flatMap(page => page.items), error: null}))
      : await Promise.all([
        supabase
          .from("acts")
          .select("*")
          .is("date_off", null)
          .order("act_id", { ascending: false })
          .limit(200),
        supabase.from("clients").select("client_id, data"),
        supabase
          .from("cars")
          .select("cars_id, client_id, data, is_deleted")
          .not("is_deleted", "is", true),
        supabase.from("works").select("work_id, data"),
        supabase.from("details").select("detail_id, data"),
        supabase.from("slyusars").select("slyusar_id, data"),
      ]);

    const results = [actsRes, clientsRes, carsRes, worksRes, detailsRes, slyusarsRes];
    if (results.some(result => result.error || !Array.isArray(result.data))) return;
    if (offlineScope() !== scope) return;
    const db = await openDB();
  assertDatabaseOwner(db);
    // Publish one complete download atomically. Never overwrite local drafts.
    await new Promise<void>((resolve, reject) => {
      const stores = [STORE_ACTS, STORE_CLIENTS, STORE_CARS, STORE_WORKS, STORE_DETAILS, STORE_SLYUSARS];
      const tx = db.transaction([...stores, STORE_META, STORE_QUEUE], "readwrite");
      const queued = tx.objectStore(STORE_QUEUE).getAll();
      queued.onsuccess = () => {
        if (offlineScope() !== scope) { tx.abort(); return; }
        const dirty = new Set(queued.result.map((item: SyncQueueItem) => Number(item.recordId)));
        const rows = [actsRes.data.filter((act: any) => !isActFrozen(act) && !dirty.has(Number(act.act_id))), clientsRes.data, carsRes.data, worksRes.data, detailsRes.data, slyusarsRes.data];
        // Snapshot includes the full declared profile: remove stale cached rows,
        // keeping every pending local edit. Compatibility reads do not claim completeness.
        if (snapshot) {
          stores.filter(store => store !== STORE_ACTS &&
            // A queued act may still need a client/car deleted on the server.
            !(dirty.size && (store === STORE_CLIENTS || store === STORE_CARS)))
            .forEach(store => tx.objectStore(store).clear());
          const keep = new Set([...dirty, ...rows[0].map((row: any) => Number(row.act_id))]);
          const cursor = tx.objectStore(STORE_ACTS).openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            if (!keep.has(Number(entry.key))) entry.delete();
            entry.continue();
          };
          tx.objectStore(STORE_META).put({key:snapshotKey,value:{scope,snapshot},updatedAt:Date.now()});
        }
        stores.forEach((store, index) => rows[index].forEach((row: any) => tx.objectStore(store).put(row)));
        tx.objectStore(STORE_META).put({ key: "lastSync", value: Date.now(), updatedAt: Date.now() });
      };
      tx.oncomplete = () => { try { assertDatabaseOwner(db); resolve(); } catch(error) { reject(error); } };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Тихо ігноруємо — якщо ми вже offline, то кеш не оновлюється
  }
}

/**
 * Повертає час останньої синхронізації
 */
export async function getLastSyncTime(): Promise<number | null> {
  return (await getMeta("lastSync")) || null;
}
import { isActFrozen } from "../../utils/actFrozenState";


export function canExportOfflineRecovery(): boolean {
  try { const actor=JSON.parse(localStorage.getItem('userAuthData') || 'null'); return !!actor?.Name && actor?.Доступ === 'Адміністратор'; } catch { return false; }
}
function assertRecoveryAccess(actor: string | null): void {
  if (!canExportOfflineRecovery() || !actor || localStorage.getItem('userAuthData') !== actor) throw new OfflineOwnerChanged();
}

/** Explicit manual recovery only: never reassign or automatically replay archived drafts. */
export async function listOfflineRecoveryStores(): Promise<string[]> {
  const actor=localStorage.getItem("userAuthData"); assertRecoveryAccess(actor);
  const names = new Set<string>([...databases.keys()]);
  if (typeof indexedDB.databases === 'function') {
    for (const info of await indexedDB.databases()) {
      if (info.name === LEGACY_DB_NAME || info.name?.startsWith('sto-offline-owner-v1-')) names.add(info.name);
    }
  }
  assertRecoveryAccess(actor);
  return [...names];
}

/** Read-only archive export, including legacy/other permission profiles. Requires an explicit name. */
export async function exportOfflineRecoveryStore(name: string): Promise<{database: string; stores: Record<string, any[]>}> {
  const actor=localStorage.getItem("userAuthData"); assertRecoveryAccess(actor);
  if (name !== LEGACY_DB_NAME && !/^sto-offline-owner-v1-[0-9a-f]{64}$/.test(name)) throw new Error('Невідоме офлайн-сховище');
  const db = await new Promise<IDBDatabase>((resolve,reject) => {
    const request = indexedDB.open(name);
    // Never create an empty recovery database by accident.
    request.onupgradeneeded = () => { request.transaction?.abort(); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    const stores: Record<string, any[]> = {};
    await Promise.all(Array.from(db.objectStoreNames).filter(store => store === STORE_QUEUE || store === STORE_ACTS).map(store => new Promise<void>((resolve,reject) => {
      const tx = db.transaction(store,'readonly');
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => { stores[store]=request.result; resolve(); };
      request.onerror = () => reject(request.error);
    })));
    assertRecoveryAccess(actor);
    const drafts = new Set((stores[STORE_QUEUE] || []).map(row => Number(row.recordId)));
    stores[STORE_ACTS] = (stores[STORE_ACTS] || []).filter(row => drafts.has(Number(row.act_id)));
    return {database:name,stores};
  } finally { db.close(); }
}
