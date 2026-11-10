/** One delivery is a recipient + channel + occurrence, never the whole reminder. */
export type DeliveryOutcome = "delivered" | "failed" | "unknown";
export interface ReminderDeliveryRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ReminderOccurrence {
  reminder_id: number;
  trigger_count: number;
  condition_query: string | null;
  schedule: unknown;
  recipients: unknown;
  channel: string;
}
export function occurrenceArgs(reminder: ReminderOccurrence, generation?: string) {
  return {
    p_reminder_id: reminder.reminder_id,
    p_generation: generation || `scheduled:${reminder.trigger_count || 0}`,
    p_expected_trigger: reminder.trigger_count || 0,
    p_rule: { condition_query: reminder.condition_query, schedule: reminder.schedule,
      recipients: reminder.recipients, channel: reminder.channel },
  };
}
/** Only the winner sends. Missing RPC/error fails closed; no legacy duplicate-send fallback.
 * A process lost before start can recover its lease. Once sending started, loss of a
 * response is unknown and must be reconciled by an operator, not blindly retried. */
export async function deliverReminderOnce(
  db: ReminderDeliveryRpc, reminder: ReminderOccurrence, recipientId: number,
  channel: "app" | "telegram", send: () => Promise<DeliveryOutcome>, generation?: string, messageText?: string,
): Promise<DeliveryOutcome | "skipped"> {
  const args = { ...occurrenceArgs(reminder, generation), p_recipient_id: recipientId, p_channel: channel };
  const claim = await db.rpc("claim_reminder_delivery", args);
  if (claim.error) throw claim.error;
  const ticket = claim.data as { token?: string } | null;
  if (!ticket?.token) return "skipped";
  const tokenArgs = { p_reminder_id: reminder.reminder_id, p_token: ticket.token };
  const start = await db.rpc("start_reminder_delivery", tokenArgs);
  if (start.error) throw start.error;
  if (start.data !== true) return "skipped";
  let outcome: DeliveryOutcome;
  try { outcome = await send(); } catch { outcome = "unknown"; }
  const finish = await db.rpc("finish_reminder_delivery", { ...tokenArgs, p_outcome: outcome, p_message: messageText ?? null });
  if (finish.error) throw finish.error;
  if (finish.data !== true) throw new Error("Reminder delivery completion was not acknowledged");
  return outcome;
}

export async function eventGeneration(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `event:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
