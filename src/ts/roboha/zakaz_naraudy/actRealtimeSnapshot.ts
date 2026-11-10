/** One open act only. Keep full snapshots out of the main list's status cache. */
export function createActRealtimeSnapshot() {
  let currentAct = 0;
  let latest: any = null;
  const applied = new Set<string>();
  const dataRevision = (row: any): string => {
    try {
      const data = typeof row?.data === "string" ? JSON.parse(row.data) : row?.data;
      return typeof data?.__act_revision === "string" ? data.__act_revision : "";
    } catch { return ""; }
  };
  return {
    reset(actId = 0) { currentAct = actId; latest = null; applied.clear(); },
    remember(row: any) {
      if (Number(row?.act_id) !== currentAct || !Object.prototype.hasOwnProperty.call(row, "data")) return;
      // Older writers can change content without rotating __act_revision.
      // A known revision is not proof that this different snapshot was rendered.
      if (latest && dataRevision(latest) === dataRevision(row) && JSON.stringify(latest.data) !== JSON.stringify(row.data)) {
        applied.delete(dataRevision(row));
      }
      latest = structuredClone(row);
    },
    get(actId: number, revision?: string) {
      return actId === currentAct && revision && dataRevision(latest) === revision ? structuredClone(latest) : null;
    },
    latest(actId: number) { return actId === currentAct && latest ? structuredClone(latest) : null; },
    wasApplied(actId: number, revision?: string) { return actId === currentAct && !!revision && applied.has(revision); },
    markApplied(row: any) {
      if (Number(row?.act_id) !== currentAct) return;
      const revision = dataRevision(row);
      if (revision) applied.add(revision);
      while (applied.size > 100) applied.delete(applied.values().next().value!);
    },
  };
}

export function actStaffSnapshotChanged(before: any, after: any): boolean {
  if (!before) return true;
  if (before.traffic_state?.staff_revision && after?.traffic_state?.staff_revision) {
    return before.traffic_state.staff_revision !== after.traffic_state.staff_revision;
  }
  const fields = (row: any) => {
    let doc = row?.data;
    try { if (typeof doc === "string") doc = JSON.parse(doc); } catch { return null; }
    return [doc?.Роботи || [], doc?.Деталі || [], row?.pruimalnyk || null, doc?.__payroll_pending === true];
  };
  return JSON.stringify(fields(before)) !== JSON.stringify(fields(after));
}
