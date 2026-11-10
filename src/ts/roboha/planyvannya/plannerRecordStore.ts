import { supabase } from "../../vxid/supabaseClient";

export interface PlannerRecordChange {
  type: "INSERT" | "UPDATE" | "DELETE";
  record: any;
  previous?: any;
  reconcileOccupancy?: boolean;
}
interface PlannerRange { start: string; end: string; staff: number[] | null }
interface Entry { record: any; version: number; deleted: boolean }
const fields = ["post_arxiv_id", "slyusar_id", "name_post", "client_id", "cars_id", "status", "data_on", "data_off", "komentar", "act_id", "xto_zapusav"];
const records = new Map<number, Entry>();
const queued = new Map<number, PlannerRecordChange>();
const clientLabels = new Map<number, any>();
const carLabels = new Map<number, any>();
const MAX_RECORDS = 4000;
let owner = "";
let clock = 0;
let readEpoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let reconcile = false;

function scope(): string {
  return typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
}
function ensureScope(): string {
  const next = scope();
  if (next !== owner) {
    owner = next;
    clock++;
    readEpoch++;
    records.clear(); queued.clear(); clientLabels.clear(); carLabels.clear();
    reconcile = false;
    clearTimeout(timer); timer = undefined;
  }
  return next;
}
function idOf(value: any): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function boundedSet<T>(map: Map<number, T>, id: number, value: T) {
  map.delete(id); map.set(id, value);
  while (map.size > MAX_RECORDS) map.delete(map.keys().next().value!);
}
function compact(row: any): any {
  const result: any = {};
  for (const key of fields) if (row && Object.prototype.hasOwnProperty.call(row, key)) {
    const value = row[key];
    if ((key === "data_on" || key === "data_off") && value) {
      const time = timestamp(String(value));
      result[key] = Number.isFinite(time) ? new Date(time).toISOString() : value;
    } else result[key] = value;
  }
  if (row?.client_data) result.client_data = row.client_data;
  if (row?.car_data) result.car_data = row.car_data;
  return result;
}
function fingerprint(row: any): string {
  return JSON.stringify(fields.map(key => {
    const value = row?.[key];
    if (value === null || value === undefined) return "";
    if (key === "data_on" || key === "data_off") {
      const time = timestamp(String(value));
      return Number.isFinite(time) ? time : String(value);
    }
    return String(value);
  }));
}
function rememberLabels(row: any) {
  const client = idOf(row.client_id), car = idOf(row.cars_id);
  if (client && row.client_data) boundedSet(clientLabels, client, row.client_data);
  if (car && row.car_data) boundedSet(carLabels, car, row.car_data);
}
function timestamp(value: string): number {
  // Planner queries use an unzoned wall time; the database interprets it as UTC.
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}
function inRange(row: any, range: PlannerRange): boolean {
  const date = timestamp(String(row?.data_on || ""));
  return date >= timestamp(range.start) && date <= timestamp(range.end)
    && (!range.staff || range.staff.includes(Number(row.slyusar_id)));
}

export function capturePlannerReadVersion(): number { ensureScope(); return ++clock; }
export function getPlannerReadEpoch(): number { ensureScope(); return readEpoch; }
export function getPlannerRecord(id: number | string): any | undefined {
  ensureScope();
  const entry = records.get(Number(id));
  return entry && !entry.deleted ? { ...entry.record } : undefined;
}
/** An evicted or never loaded ID is unknown, not proof of a deletion. */
export function isPlannerRecordDeleted(id: number | string): boolean {
  ensureScope();
  return records.get(Number(id))?.deleted === true;
}

/** Overlay committed events received after the snapshot began, including deletes. */
export function rememberPlannerBookings(rows: any[], readVersion = capturePlannerReadVersion(), range?: PlannerRange): any[] {
  ensureScope();
  const result = new Map<number, any>();
  for (const original of rows) {
    const id = idOf(original.post_arxiv_id);
    if (!id) continue;
    const existing = records.get(id);
    if (existing && existing.version > readVersion) {
      // A newer status/time event must win, but a snapshot can still supply
      // labels for unchanged foreign IDs that were not loaded at event time.
      if (!existing.deleted) {
        if (!existing.record.client_data && String(existing.record.client_id) === String(original.client_id) && original.client_data) {
          existing.record = { ...existing.record, client_data: original.client_data };
        }
        if (!existing.record.car_data && String(existing.record.cars_id) === String(original.cars_id) && original.car_data) {
          existing.record = { ...existing.record, car_data: original.car_data };
        }
        rememberLabels(existing.record);
      }
      if (!existing.deleted && (!range || inRange(existing.record, range))) result.set(id, existing.record);
      continue;
    }
    const row = compact(original);
    rememberLabels(row);
    boundedSet(records, id, { record: row, version: readVersion, deleted: false });
    result.set(id, row);
  }
  if (range) {
    for (const [id, entry] of records) {
      if (result.has(id) || !inRange(entry.record, range)) continue;
      if (entry.version > readVersion) {
        if (!entry.deleted) result.set(id, entry.record);
      } else if (!entry.deleted) {
        records.set(id, { ...entry, version: readVersion, deleted: true });
      }
    }
  }
  return [...result.values()].sort((a, b) => Number(a.post_arxiv_id) - Number(b.post_arxiv_id));
}

/** Only label projections for IDs absent from already loaded compact snapshots. */
export async function hydratePlannerLabels(rows: any[], client = supabase): Promise<any[]> {
  const currentScope = ensureScope();
  const clients = [...new Set(rows.filter(row => !row.client_data).map(row => idOf(row.client_id)).filter((id): id is number => !!id && !clientLabels.has(id)))];
  const cars = [...new Set(rows.filter(row => !row.car_data).map(row => idOf(row.cars_id)).filter((id): id is number => !!id && !carLabels.has(id)))];
  const loadedClients = new Map<number, any>(), loadedCars = new Map<number, any>();
  const jobs: Promise<void>[] = [];
  for (let offset = 0; offset < clients.length; offset += 200) jobs.push((async () => {
    const result = await client.from("clients").select('client_id, name:data->>"ПІБ", phone:data->>"Телефон"').in("client_id", clients.slice(offset, offset + 200));
    if (result.error) throw result.error;
    for (const row of result.data || []) loadedClients.set(row.client_id, { "ПІБ": row.name || "", "Телефон": row.phone || "" });
    for (const id of clients.slice(offset, offset + 200)) if (!loadedClients.has(id)) loadedClients.set(id, {});
  })());
  for (let offset = 0; offset < cars.length; offset += 200) jobs.push((async () => {
    const result = await client.from("cars").select('cars_id, model:data->>"Авто", number:data->>"Номер авто"').in("cars_id", cars.slice(offset, offset + 200)).not("is_deleted", "is", true);
    if (result.error) throw result.error;
    for (const row of result.data || []) loadedCars.set(row.cars_id, { "Авто": row.model || "", "Номер авто": row.number || "" });
    for (const id of cars.slice(offset, offset + 200)) if (!loadedCars.has(id)) loadedCars.set(id, {});
  })());
  await Promise.all(jobs);
  if (ensureScope() !== currentScope) throw new Error("Контекст користувача змінився");
  for (const [id, value] of loadedClients) boundedSet(clientLabels, id, value);
  for (const [id, value] of loadedCars) boundedSet(carLabels, id, value);
  return rows.map(row => ({ ...row,
    client_data: row.client_data || clientLabels.get(Number(row.client_id)) || {},
    car_data: row.car_data || carLabels.get(Number(row.cars_id)) || {},
  }));
}

function schedule() {
  clearTimeout(timer);
  if (typeof document === "undefined" || document.hidden) return;
  timer = setTimeout(() => { timer = undefined; void flush(); }, 300);
}

function isVisibleBooking(row: any): boolean {
  const value = timestamp(String(row.data_on || ""));
  if (!Number.isFinite(value)) return false;
  const date = new Date(value).toISOString().slice(0, 10);
  const weekTracks = document.querySelectorAll<HTMLElement>(".post-week-day-track[data-date]");
  if (weekTracks.length) return [...weekTracks].some(track => track.dataset.date === date && track.dataset.slyusarId === String(row.slyusar_id));
  return (window as any).parseCurrentDate?.() === date;
}

export function requestPlannerReconciliation(): void {
  ensureScope();
  if (!reconcile) readEpoch++;
  reconcile = true;
  schedule();
}

/** Called after confirmed local writes and for every Realtime mutation. */
export function publishPlannerChange(type: PlannerRecordChange["type"], value: any, previous?: any): void {
  ensureScope();
  const id = idOf(value?.post_arxiv_id ?? previous?.post_arxiv_id);
  if (!id) { requestPlannerReconciliation(); return; }
  const existing = records.get(id);
  const old = previous?.data_on ? compact(previous) : existing && !existing.deleted ? existing.record : undefined;
  if (type === "DELETE" && existing?.deleted) return;
  if (type !== "DELETE" && existing?.deleted) {
    // A delayed pre-delete event must not resurrect a confirmed deletion.
    // A genuine reinsert with a reused ID is resolved by a fresh snapshot.
    requestPlannerReconciliation();
    return;
  }
  const record = type === "DELETE" ? { ...old, ...compact(value), post_arxiv_id: id }
    : { ...(existing && !existing.deleted ? existing.record : old), ...compact(value), post_arxiv_id: id };
  if (type !== "DELETE") {
    if (old && String(old.client_id) !== String(record.client_id) && !value.client_data) delete record.client_data;
    if (old && String(old.cars_id) !== String(record.cars_id) && !value.car_data) delete record.car_data;
    if (existing && !existing.deleted && fingerprint(existing.record) === fingerprint(record)) {
      // Own Realtime echoes do not trigger another render or occupancy query.
      rememberLabels(record);
      return;
    }
  }
  if (type !== "DELETE" && previous?.data_on && existing && !existing.deleted
    && fingerprint(previous) !== fingerprint(existing.record)) {
    // A later remote commit may arrive before the local HTTP response. Do not
    // repaint that newer state with an older local write acknowledgement.
    requestPlannerReconciliation();
    return;
  }
  rememberLabels(record);
  boundedSet(records, id, { record, version: ++clock, deleted: type === "DELETE" });
  const pending = queued.get(id);
  // An unseen/evicted row cannot tell us its previous day. Its new snapshot is
  // enough to update the booking itself; only the compact occupancy needs a
  // reconciliation. Never download all visible bookings for an unrelated edit.
  const unknownPrevious = type !== "INSERT" && !old?.data_on;
  queued.set(id, { type, record, previous: pending ? pending.previous : old,
    reconcileOccupancy: pending?.reconcileOccupancy || unknownPrevious });
  if (type !== "DELETE" && !record.data_on) requestPlannerReconciliation();
  if (queued.size > MAX_RECORDS) { queued.clear(); requestPlannerReconciliation(); }
  schedule();
}

async function flush(): Promise<void> {
  if (flushing || document.hidden) return;
  const currentScope = ensureScope();
  if (!queued.size && !reconcile) return;
  flushing = true;
  const changes = [...queued.values()]; queued.clear();
  const full = reconcile; reconcile = false;
  let failed = false;
  let reconciling = false;
  try {
    if (full || typeof (window as any).applyPlannerRecordChanges !== "function") {
      reconciling = true;
      await (window as any).refreshPlannerCalendar?.();
      return;
    }
    const hydrated = await hydratePlannerLabels(changes.filter(change => change.type !== "DELETE" && isVisibleBooking(change.record)).map(change => change.record));
    if (ensureScope() !== currentScope) return;
    if (document.hidden) {
      for (const change of changes) {
        const id = Number(change.record.post_arxiv_id);
        const pending = queued.get(id);
        if (pending) {
          pending.previous = change.previous || pending.previous;
          pending.reconcileOccupancy ||= change.reconcileOccupancy;
        }
        else queued.set(id, change);
      }
      return;
    }
    const byId = new Map(hydrated.map(row => [Number(row.post_arxiv_id), row]));
    const applicable: PlannerRecordChange[] = [];
    for (const change of changes) {
      const id = Number(change.record.post_arxiv_id);
      const latest = records.get(id);
      // Another mutation won while labels were loading. Its queued change will render.
      if (!latest || latest.deleted !== (change.type === "DELETE") || fingerprint(latest.record) !== fingerprint(change.record)) {
        const replacement = queued.get(id);
        if (replacement) {
          if (change.previous) replacement.previous = change.previous;
          replacement.reconcileOccupancy ||= change.reconcileOccupancy;
        }
        continue;
      }
      const record = byId.get(id) || change.record;
      latest.record = record;
      applicable.push({ ...change, record });
    }
    if (applicable.length) await (window as any).applyPlannerRecordChanges(applicable);
  } catch {
    if (ensureScope() === currentScope) {
      if (reconciling) { reconcile = true; failed = true; }
      else {
        try { await (window as any).refreshPlannerCalendar?.(); }
        catch { reconcile = true; failed = true; }
      }
    }
  } finally {
    flushing = false;
    // Retry a failed reconciliation on the next event/focus, never in a loop.
    if (!failed && (queued.size || reconcile)) schedule();
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); timer = undefined; }
    else if (queued.size || reconcile) schedule();
  });
  window.addEventListener("pagehide", () => { clearTimeout(timer); timer = undefined; });
}
