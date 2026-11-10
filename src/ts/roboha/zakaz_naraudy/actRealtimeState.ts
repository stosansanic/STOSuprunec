/** Normalize projected status events while supporting pre-migration full rows. */
export function normalizeActRealtimeChange(payload: any): { current: any; previous: any } {
  const decode = (value: any) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  const row = payload.new || {}, state = decode(row.traffic_state);
  if (!state || typeof state.frozen !== "boolean") return { current: row, previous: payload.old };
  const current = { ...row, frozen: state.frozen,
    data: { ...(decode(row.data) || {}), ...(state.summary || {}), Заморожений: state.frozen } };
  const oldState = decode(payload.old?.traffic_state);
  // Never fabricate OLD values from NEW: completion flags must retain their
  // actual previous value (or remain unknown for a PK-only legacy payload).
  const previous = state.previous ? { ...(payload.old || {}), ...state.previous,
    act_id: payload.old?.act_id ?? row.act_id,
    data: { ...(oldState?.summary || {}), Заморожений: state.previous.frozen === true } } : payload.old;
  return { current, previous };
}
