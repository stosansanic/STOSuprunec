export const OFFLINE_RESOURCES = ["acts", "clients", "cars", "works", "details", "slyusars"] as const;
interface SnapshotPage { hash: string; items: any[]; next: number | null }
export interface OfflineSnapshot { version: 1; pages: Record<string, SnapshotPage[]>; revisions?: Record<string, string> }

/** Full local snapshot stays in IndexedDB. Unchanged server pages return only a hash.
 * No local mutation is used as a server baseline or as proof of write permissions.
 */
export async function readOfflineSnapshot(client: any, previous?: OfflineSnapshot): Promise<OfflineSnapshot | undefined> {
  if (typeof client.rpc !== "function") return undefined; // compatibility with old clients
  const manifest = async (): Promise<Record<string, string> | undefined> => {
    const { data, error } = await client.rpc("traffic_resource_manifest", { p_resources: [...OFFLINE_RESOURCES] });
    if (error) {
      // An older installation keeps the existing per-page hash protocol.
      if (error.code === "PGRST202" || error.code === "42883") return undefined;
      throw error;
    }
    if (!data || OFFLINE_RESOURCES.some(resource => typeof data[resource] !== "string" || !data[resource])) throw new Error("Invalid offline manifest");
    return data;
  };
  let revisions = await manifest();
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await readPages(client, previous, revisions);
    if (!snapshot || !revisions) return snapshot;
    const changed = OFFLINE_RESOURCES.some(resource => previous?.revisions?.[resource] !== revisions![resource] || !previous.pages[resource]?.length);
    if (!changed) return snapshot; // One small manifest, zero page requests.
    const after = await manifest();
    if (!after) throw new Error("Offline revision protocol changed during refresh");
    if (OFFLINE_RESOURCES.every(resource => after[resource] === revisions![resource])) return snapshot;
    // A concurrent write crossed the multi-page read. Retry only affected
    // resources; never publish a mixed snapshot or overwrite queued drafts.
    previous = snapshot;
    revisions = after;
  }
  throw new Error("Offline data changed during refresh; the prior cache is retained");
}

async function readPages(client: any, previous?: OfflineSnapshot, revisions?: Record<string, string>): Promise<OfflineSnapshot | undefined> {
  const pages: Record<string, SnapshotPage[]> = {};
  // Detect optional RPC once, before starting the other five resources.
  let firstMissing = false;
  async function readResource(resource: string) {
    if (revisions && previous?.version === 1 && previous.revisions?.[resource] === revisions[resource] && previous.pages[resource]?.length) {
      pages[resource] = previous.pages[resource];
      return;
    }
    let after: number | null = null;
    pages[resource] = [];
    for (let index = 0; ; index++) {
      const old: SnapshotPage | undefined = previous?.version === 1 ? previous.pages[resource]?.[index] : undefined;
      const oldBefore: number | null | undefined = index === 0 ? null : previous?.pages[resource]?.[index - 1]?.next;
      const matching: SnapshotPage | undefined = oldBefore === after ? old : undefined;
      const response: any = await client.rpc("traffic_offline_page", {
        p_resource: resource, p_after: after, p_hash: matching?.hash || null,
      });
      const data: any = response.data;
      const error: any = response.error;
      if (error) {
        if (resource === "acts" && index === 0 && (error.code === "PGRST202" || error.code === "42883")) {
          firstMissing = true; return;
        }
        throw error;
      }
      if (!data || typeof data.hash !== "string" || typeof data.has_more !== "boolean") throw new Error("Invalid offline page");
      const items = data.items === null && matching && matching.hash === data.hash ? matching.items : data.items;
      if (!Array.isArray(items) || items.length !== data.count) throw new Error("Incomplete offline snapshot");
      pages[resource].push({ hash: data.hash, items, next: data.next_cursor });
      if (!data.has_more) break;
      if (!Number.isFinite(data.next_cursor) || (after !== null && data.next_cursor <= after)) throw new Error("Invalid offline cursor");
      after = data.next_cursor;
    }
  }
  await readResource("acts");
  if (firstMissing) return undefined;
  await Promise.all(OFFLINE_RESOURCES.filter(resource => resource !== "acts").map(readResource));
  return { version: 1, pages, ...(revisions ? { revisions } : {}) };
}
