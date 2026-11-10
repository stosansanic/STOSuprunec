/** Small, payload-free operational events. Never pass provider bodies or credentials. */
type Counters = Partial<Record<"status" | "processed" | "sent" | "skipped" | "durationMs", number>>;
type Level = "debug" | "info" | "warn" | "error";

export function operationalLog(level: Level, event: string, counters: Counters = {}): void {
  // Diagnostics expire without a redeploy. Normal success events stay quiet.
  if (level === "debug") {
    const until = Date.parse(Deno.env.get("OPERATIONAL_DEBUG_UNTIL") || "");
    if (!Number.isFinite(until) || Date.now() >= until) return;
  }
  const numeric: Counters = {};
  for (const key of ["status", "processed", "sent", "skipped", "durationMs"] as const) {
    const value = counters[key];
    if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
  }
  const entry = JSON.stringify({ level, event: event.slice(0, 80), ...numeric });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}
