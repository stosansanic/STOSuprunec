import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";

export function createWorkshopResourceCache(now = () => Date.now()) {
  const values = new Map<string,{value:unknown;expires:number}>();
  const pending = new Map<string,Promise<unknown>>();
  const versions = new Map<string, number>();
  return {
    invalidate(matches: (key: string) => boolean = () => true) {
      for (const key of new Set([...values.keys(), ...pending.keys()])) if (matches(key)) {
        versions.set(key, (versions.get(key) || 0) + 1);
        values.delete(key); pending.delete(key);
      }
    },
    async read<T>(key:string,load:()=>Promise<T>): Promise<T> {
      const existing=values.get(key);if(existing && existing.expires>now()) return structuredClone(existing.value) as T;
      const active=pending.get(key);if(active) return structuredClone(await active) as T;
      const version=versions.get(key) || 0;
      const request=load().then(value=>{
        if(version!==(versions.get(key) || 0)) throw Object.assign(new Error('Дані змінилися під час читання. Оновіть картку.'), { code: "WORKSHOP_CACHE_INVALIDATED" });
        values.set(key,{value,expires:now()+15000});while(values.size>20)values.delete(values.keys().next().value!);
        return value;
      });
      pending.set(key,request);
      try{return structuredClone(await request)}finally{if(pending.get(key)===request)pending.delete(key)}
    },
    async readWithRetry<T>(key: string, load: () => Promise<T>): Promise<T> {
      try { return await this.read(key, load); }
      catch (error) {
        if ((error as { code?: string })?.code !== "WORKSHOP_CACHE_INVALIDATED") throw error;
        // A live update during a recommendation snapshot gets one fresh read,
        // never an unbounded retry loop or a successful stale result.
        return this.read(key, load);
      }
    },
  };
}
export const workshopReadCache=createWorkshopResourceCache();

type WorkshopWatchScope = { kind: "attention" } | { kind: "act"; actId: number; carId: number | null };
export type WorkshopResourceWatcher = (() => void) & { ready: Promise<void> };

export function invalidateWorkshopResources(scope: WorkshopWatchScope): void {
  workshopReadCache.invalidate(key => {
    try {
      const parts = JSON.parse(key);
      return scope.kind === "attention" ? parts[0] === "attention"
        : parts[0] === "recommendations" && Number(parts[4]) === scope.carId;
    } catch { return false; }
  });
}

/** A card needs only car recommendation invalidation, never warehouse/planner rows. */
export function watchWorkshopResources(scope: WorkshopWatchScope, onChange?: () => void): WorkshopResourceWatcher {
  const owner = localStorage.getItem("userAuthData") || "";
  let released = false;
  let subscriptions: DatabaseSubscription[] = [];
  let suspended = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const changed = () => {
    invalidateWorkshopResources(scope);
    if (!awaitingInitial.size && !released && !document.hidden && owner === (localStorage.getItem("userAuthData") || "")) onChange?.();
  };
  const relevant = (payload: any) => {
    if (scope.kind === "attention") return true;
    const next = payload.new || {}, old = payload.old || {};
    if (Number(next.act_id || old.act_id) === scope.actId) return true;
    if (!scope.carId) return false;
    const previous = next.traffic_state?.previous || old;
    if (Number(next.cars_id) === scope.carId || Number(previous.cars_id) === scope.carId) return true;
    // Legacy installations/PK-only deletes cannot prove the old membership.
    // Invalidate only this car's cache; this never automatically downloads history.
    return payload.eventType !== "INSERT" && !Object.prototype.hasOwnProperty.call(previous, "cars_id");
  };
  const resources = scope.kind === "act" ? (scope.carId ? [
    { table: "acts", select: ["act_id", "cars_id", "traffic_state"] },
  ] : []) : [
    { table: "acts", select: ["act_id", "cars_id", "pruimalnyk", "date_off", "slusarsOn", "traffic_state"] },
    { table: "sclad", select: ["sclad_id", "akt", "statys"] },
    { table: "post_arxiv", select: ["post_arxiv_id", "data_on", "status", "xto_zapusav", "traffic_previous"] },
  ];
  const awaitingInitial = new Set(resources.map((_, index) => index));
  if (!awaitingInitial.size) resolveReady();
  const settleInitial = (index: number) => {
    const initial = awaitingInitial.delete(index);
    if (!awaitingInitial.size) resolveReady();
    return initial;
  };
  const start = () => {
    if (released || document.hidden || subscriptions.length || owner !== (localStorage.getItem("userAuthData") || "")) return;
    const reconcile = suspended; suspended = false;
    subscriptions = resources.map((resource, index) => {
      let disconnected = reconcile;
      return databaseSubscriptions.subscribe(resource, payload => { if (relevant(payload)) changed(); }, status => {
        if (status === "SUBSCRIBED") {
          // The first snapshot waits for the join. Do not invalidate that read
          // again just because another initial resource has become ready.
          const initial = settleInitial(index);
          if (disconnected && !initial) changed();
          disconnected = false;
        } else if (["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {
          // A failed stream must not block ordinary reads indefinitely. If it
          // subsequently joins, disconnected forces a reconciliation.
          settleInitial(index); disconnected = true;
        }
      });
    });
  };
  const suspend = () => {
    suspended = true;
    subscriptions.forEach(subscription => subscription.unsubscribe()); subscriptions = [];
  };
  const visibility = () => { if (document.hidden) suspend(); else start(); };
  const pageShow = (event: PageTransitionEvent) => { if (event.persisted) start(); };
  const localAct = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (scope.kind === "attention" || !detail || Number(detail.actId) === scope.actId ||
      !Array.isArray(detail.affectedCarIds) || detail.affectedCarIds.includes(scope.carId)) changed();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === "userAuthData") { suspend(); resolveReady(); changed(); }
    else if (scope.kind === "attention" && event.key === "sto:accounting-revision") changed();
  };
  invalidateWorkshopResources(scope);
  start();
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", suspend);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("sto:act-saved", localAct);
  window.addEventListener("storage", storage);
  const stop = () => {
    if (released) return;
    released = true; suspend(); resolveReady();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", suspend);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("sto:act-saved", localAct);
    window.removeEventListener("storage", storage);
  };
  return Object.assign(stop, { ready });
}
