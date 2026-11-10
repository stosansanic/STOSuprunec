export interface ReminderCallback { reminder_id: number; message_text: string; sent_at: string; log_id?: number }

/** One bounded latest row for an affected reminder; one aggregate for initial/batched synchronization. */
export function createLatestCallbackReader(db: any) {
  let aggregateAvailable = true;
  return async (reminderIds: number[]): Promise<ReminderCallback[]> => {
    const ids = [...new Set(reminderIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    if (ids.length > 1 && aggregateAvailable) {
      const rows: ReminderCallback[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const { data, error } = await db.rpc("traffic_reminder_latest_callbacks", { p_reminder_ids: ids.slice(offset, offset + 500) });
        if (!error) { rows.push(...(data || [])); continue; }
        if (!["PGRST202", "42883"].includes(error.code)) throw error;
        aggregateAvailable = false;
        break;
      }
      if (aggregateAvailable) return rows;
    }
    const rows: ReminderCallback[] = [];
    // Older projects may not have the aggregate RPC yet. A global history query
    // can hit PostgREST's row cap before reaching another reminder's latest log.
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        const { data, error } = await db.from("atlas_reminder_logs")
          .select("reminder_id,message_text,sent_at,log_id")
          .eq("delivery_status", "callback").eq("reminder_id", id)
          .order("sent_at", { ascending: false }).order("log_id", { ascending: false })
          .limit(1);
        if (error) throw error;
        return data?.[0] as ReminderCallback | undefined;
      }));
      for (const row of batch) if (row) rows.push(row);
    }
    return rows;
  };
}
