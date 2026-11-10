import { supabase } from "../vxid/supabaseClient";

export interface DatabaseSubscription { unsubscribe(): void }
export interface DatabaseResource {
  table: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  schema?: string;
  filter?: string;
  /** Server-side column selection. Enabled only after the realtime SQL is installed. */
  select?: readonly string[];
}
type Listener = (payload: any) => unknown;

/** One transport per identical resource/access scope; every consumer still gets every event. */
export function createDatabaseSubscriptionRegistry(client: any) {
  const entries = new Map<string, { channel: any; listeners: Set<Listener>; statuses: Set<Listener>; active: boolean; generation: number; status?: string; statusRevision: number; connecting: boolean; legacy: boolean; cancelReadiness?: () => void }>();
  let serial = 0;
  let paused = false;
  const connectors = new Map<string, () => void>();
  let projectionCapability: Promise<boolean> | undefined;
  function supportsProjection(): Promise<boolean> {
    // One tiny request per page, shared across all consumers. Older installations
    // keep their working subscriptions until the migration is applied + page reloaded.
    return projectionCapability ||= Promise.resolve().then(async () => {
      if (typeof client.rpc !== 'function') return false;
      try {
        let request = client.rpc('traffic_realtime_capabilities');
        if (request?.abortSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          request = request.abortSignal(AbortSignal.timeout(3000));
        }
        const { data, error } = await request;
        return !error && data?.version === 1;
      } catch { return false; }
    });
  }
  function notify(listener: Listener, value: unknown): void {
    try { void Promise.resolve(listener(value)).catch(() => {}); } catch { /* isolate consumers */ }
  }
  return {
    subscribe(resource: DatabaseResource, listener: Listener, onStatus?: Listener, accessScope?: string): DatabaseSubscription {
      const scope = accessScope ?? (typeof localStorage === 'undefined' ? '' : localStorage.getItem('userAuthData') || '');
      const columns = resource.select?.length ? [...new Set(resource.select)].sort() : undefined;
      const filter = { event: resource.event || '*', schema: resource.schema || 'public', table: resource.table, ...(resource.filter ? { filter: resource.filter } : {}), ...(columns ? { select: columns } : {}) };
      const key = JSON.stringify([scope,filter]);
      let entry = entries.get(key);
      if (!entry) {
        entry = { channel: null, listeners: new Set(), statuses: new Set(), active: true, generation: 0, statusRevision: 0, connecting: false, legacy: false };
        entries.set(key,entry);
      }
      const current = entry;
      const existingStatus = current.status;
      const existingStatusRevision = current.statusRevision;
      // A distinct wrapper permits independent subscriptions with the same callback.
      const forward: Listener = payload => listener(payload);
      const statusForward: Listener = status => onStatus?.(status);
      current.listeners.add(forward);
      if(onStatus) current.statuses.add(statusForward);
      const connect = () => {
        if(current.channel || current.connecting || !current.active || paused) return;
        const generation = ++current.generation;
        current.connecting = true;
        const dispatch = (listeners: Set<Listener>, value: any) => {
          if(!current.active || generation !== current.generation) return;
          for(const callback of [...listeners]) notify(callback, value);
        };
        const open = (project: boolean) => {
          if(!current.active || generation !== current.generation || paused) return;
          const { select: _select, ...legacyFilter } = filter;
          current.connecting = false;
          const alive = () => current.active && generation === current.generation && !paused;
          let socketJoined = false;
          let postgresReady = false;
          let readyReported = false;
          let readinessTimedOut = false;
          let readinessTimer: ReturnType<typeof setTimeout> | undefined;
          const clearReadinessTimer = () => {
            if (readinessTimer !== undefined) clearTimeout(readinessTimer);
            readinessTimer = undefined;
          };
          current.cancelReadiness = clearReadinessTimer;
          const report = (status: string) => {
            if (!alive()) return;
            current.status = status;
            current.statusRevision++;
            dispatch(current.statuses, status);
          };
          const reportReady = () => {
            if (!alive() || !socketJoined || !postgresReady || readyReported) return;
            clearReadinessTimer();
            readyReported = true;
            report('SUBSCRIBED');
          };
          const reportError = (status: string) => {
            report(status);
            if (!alive()) return;
            if (status === 'CHANNEL_ERROR' && project && !current.legacy) {
              // Compatible fallback for servers that do not support projection.
              // Consumers accept complete legacy rows as well as projected rows.
              clearReadinessTimer();
              current.legacy = true;
              const rejected = current.channel;
              current.channel = null;
              current.generation++;
              if (rejected) void client.removeChannel(rejected);
              connect();
            }
          };
          const channel = client.channel(`shared-db-${resource.table}-${++serial}`)
            // The socket join acknowledgement can precede the replication listener.
            // Register this before joining; the installed SDK supports system events.
            .on('system', {}, (payload: any) => {
              if (!alive() || payload?.extension !== 'postgres_changes') return;
              if (payload.status === 'ok') {
                postgresReady = true;
                reportReady();
              } else if (payload.status === 'error') {
                postgresReady = false;
                readyReported = false;
                readinessTimedOut = true;
                clearReadinessTimer();
                // An extension failure does not close its socket. A later system
                // acknowledgement can recover without another phx_join response.
                reportError('CHANNEL_ERROR');
              }
            })
            // realtime-js 2.11 passes the filter object to phx_join unchanged.
            // See realtime-projection-protocol.test.cjs against the installed SDK.
            .on('postgres_changes', project ? filter : legacyFilter, (payload: any) => {
              if (!alive()) return;
              // Older servers may omit system readiness, but a delivered row is
              // positive evidence that this resource is already streaming.
              postgresReady = true;
              reportReady();
              dispatch(current.listeners, payload);
            });
          current.channel = channel;
          channel.subscribe((status: string) => {
            if (!alive()) return;
            if (status === 'SUBSCRIBED') {
              socketJoined = true;
              reportReady();
              if (!readyReported && !readinessTimedOut && readinessTimer === undefined) {
                readinessTimer = setTimeout(() => {
                  readinessTimer = undefined;
                  if (!alive() || postgresReady || !socketJoined) return;
                  readinessTimedOut = true;
                  // Release initial snapshot waits on legacy/misconfigured servers
                  // without claiming PostgreSQL readiness or closing a live socket.
                  report('TIMED_OUT');
                }, 3000);
              }
              return;
            }
            clearReadinessTimer();
            socketJoined = false;
            postgresReady = false;
            readyReported = false;
            readinessTimedOut = false;
            reportError(status);
          });
        };
        if(columns && !current.legacy) void supportsProjection().then(open);
        else open(false);
      };
      connectors.set(key,connect);
      connect();
      if (onStatus && existingStatus) {
        const generation = current.generation;
        void Promise.resolve().then(() => {
          if (current.active && current.generation === generation && current.statusRevision === existingStatusRevision && current.statuses.has(statusForward)) notify(statusForward, existingStatus);
        });
      }
      let released = false;
      return { unsubscribe() {
        if(released) return;
        released = true;
        current.listeners.delete(forward);
        current.statuses.delete(statusForward);
        if(!current.listeners.size) {
          current.active = false;
          current.generation++;
          current.cancelReadiness?.();
          current.cancelReadiness = undefined;
          if(entries.get(key)===current) { entries.delete(key); connectors.delete(key); }
          if(current.channel) void client.removeChannel(current.channel);
        }
      }};
    },
    pause() {
      if(paused) return;
      paused = true;
      for(const entry of entries.values()) {
        entry.generation++;
        entry.connecting = false;
        entry.cancelReadiness?.();
        entry.cancelReadiness = undefined;
        entry.status = 'CLOSED';
        entry.statusRevision++;
        if(entry.channel) void client.removeChannel(entry.channel);
        entry.channel = null;
        for(const callback of entry.statuses) notify(callback, 'CLOSED');
      }
    },
    resume() {
      paused = false;
      for(const connect of connectors.values()) connect();
    },
    size() { return entries.size; },
  };
}

export const databaseSubscriptions = createDatabaseSubscriptionRegistry(supabase);

if(typeof window !== "undefined") {
  window.addEventListener("pagehide",()=>databaseSubscriptions.pause());
  window.addEventListener("pageshow",event=>{if(event.persisted) databaseSubscriptions.resume();});
}
