export type Direction = "incoming" | "outgoing" | "unknown";
export type ShipmentState = "created" | "transit" | "arrived" | "received" | "attention" | "cancelled" | "unknown";
export const stateLabels: Record<ShipmentState, string> = {
  created: "Очікує відправлення", transit: "У дорозі", arrived: "Прибула",
  received: "Отримана", attention: "Потребує уваги", cancelled: "Скасована", unknown: "Очікує перевірки",
};
export function statusLabel(state: ShipmentState, direction: Direction): string {
  if (state === "arrived") return direction === "incoming" ? "Потрібно забрати" : direction === "outgoing" ? "Очікує отримувача" : "Прибула";
  if (state === "received") return direction === "incoming" ? "Ми отримали" : direction === "outgoing" ? "Отримувач забрав" : "Отримана";
  return stateLabels[state] || "Невідомий статус";
}
export function normalizeTTN(value: unknown): string {
  const number = String(value ?? "").replace(/[\s-]/g, "");
  if (!/^\d{14}$/.test(number)) throw new Error("ТТН має містити 14 цифр.");
  return number;
}
export function normalizePhone(value: unknown): string {
  let phone = String(value ?? "").replace(/\D/g, "");
  if (/^0\d{9}$/.test(phone)) phone = `38${phone}`;
  if (phone && !/^380\d{9}$/.test(phone)) throw new Error("Телефон: +380 та 9 цифр.");
  return phone;
}
export function mapStatus(code: unknown): ShipmentState {
  const value = String(code ?? "");
  if (["1", "12"].includes(value)) return "created";
  if (value === "2") return "cancelled";
  if (["4", "5", "6", "101"].includes(value)) return "transit";
  if (["7", "8"].includes(value)) return "arrived";
  if (["9", "10", "11"].includes(value)) return "received";
  if (["102", "103", "104", "105", "106", "111", "112"].includes(value)) return "attention";
  return "unknown";
}
// Date-only values deliberately avoid UTC conversion (Kyiv dates must not shift).
export function npDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const local = /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})/.exec(text);
  const result = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : local ? `${local[3]}-${local[2]}-${local[1]}` : "";
  if (!result || Number(result.slice(0, 4)) < 1900) return null;
  const date = new Date(`${result}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : null;
}
// Provider placeholders such as 01.01.0001 must never win over a valid fallback.
export function npTimestamp(value: unknown): string | null {
  const day = npDate(value);
  if (!day) return null;
  const clock = String(value).trim().match(/[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59) return day;
  return `${day} ${clock[1]}:${clock[2]}${clock[3] ? `:${clock[3]}` : ""}`;
}
export function plannedDelivery(row: Record<string, unknown>): string | null {
  return npTimestamp(row.ScheduledDeliveryDate) || npTimestamp(row.ArrivalDateTime);
}
export function trackingPatch(row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { state: mapStatus(row.StatusCode), raw_code: String(row.StatusCode ?? ""), raw_status: String(row.Status ?? "Невідомий статус").slice(0, 1000) };
  for (const [field, key] of Object.entries({ origin: "CitySender", destination: "CityRecipient", warehouse: "WarehouseRecipient", provider_description: "CargoDescription" })) {
    if (typeof row[key] === "string" && row[key]) patch[field] = row[key].slice(0, 1500);
  }
  for (const [field, key] of Object.entries({ estimated_date: "ScheduledDeliveryDate", document_date: "DateCreated", arrived_date: "ActualDeliveryDate", received_date: "RecipientDateTime" })) {
    const date = npDate(row[key]);
    if (date) patch[field] = date;
  }
  return patch;
}

export interface ProviderDetails {
  created?: string; delivery?: string; value?: number | null; delivery_cost?: number | null;
  weight?: number | null; seats?: number | null; light_return?: string;
  recipient?: string; phone?: string; city?: string; address?: string;
  sender?: string; sender_phone?: string; sender_city?: string; sender_address?: string;
  sender_contact?: string; sender_company?: string; recipient_contact?: string; recipient_company?: string;
}
const privateParty = /^(?:приватна\s+особа|фізична\s+особа|частное\s+лицо|private\s+(?:person|individual))$/iu;
const businessParty = /(?:^|[\s"«])(?:ТОВ|ФОП|ФЛП|ПП|ПАТ|ПрАТ|АТ|ТД|LLC|LTD)(?=$|[\s"»])/iu;
export function partyLines(contact = "", company = "", legacy = ""): string[] {
  const visible = (value: string) => value.trim() && !privateParty.test(value.trim());
  const person = visible(contact) ? contact.trim() : visible(legacy) && !businessParty.test(legacy) ? legacy.trim() : "";
  const organization = visible(company) ? company.trim() : visible(legacy) && businessParty.test(legacy) ? legacy.trim() : "";
  return [...new Set([person, organization].filter(Boolean))];
}
export function documentDetails(row: Record<string, unknown>): ProviderDetails {
  const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 1500) : "";
  const firstText = (...values: unknown[]) => values.map(text).find(Boolean) || "";
  const party = (side: "Sender" | "Recipient") => {
    const contact = [row[`${side}ContactPersonDescription`], row[`${side}ContactPersonName`], row[`${side}ContactPerson`], row[`Contact${side}Description`], row[`Contact${side}Name`], row[`${side}ContactName`], row[`Contact${side}`], row[`${side}FullName`], row[`${side}Name`]]
      .map(text).find(value => value && !privateParty.test(value) && !businessParty.test(value) && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) || "";
    const company = [row[`Counterparty${side}Description`], businessParty.test(text(row[`${side}Name`])) ? row[`${side}Name`] : ""]
      .map(text).find(value => value && !privateParty.test(value) && value !== contact) || "";
    return { contact, company };
  };
  const sender = party("Sender"); const recipient = party("Recipient");
  const number = (value: unknown) => {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    created: npTimestamp(row.DateTime) || npTimestamp(row.DateCreated) || "", delivery: plannedDelivery(row) || "",
    value: number(row.Cost), delivery_cost: number(row.DocumentCost),
    weight: number(row.DocumentWeight ?? row.FactualWeight), seats: number(row.SeatsAmount),
    light_return: text(row.LightReturnNumber) || (row.LightReturn === true || row.LightReturn === 1 || row.LightReturn === "1" ? "Так" : ""),
    recipient: firstText(row.RecipientFullName, row.RecipientName, row.CounterpartyRecipientDescription), phone: text(row.PhoneRecipient),
    city: text(row.CityRecipientDescription), address: text(row.RecipientAddressDescription),
    sender: firstText(row.SenderName, row.CounterpartySenderDescription), sender_phone: text(row.PhoneSender),
    sender_contact: sender.contact, sender_company: sender.company,
    recipient_contact: recipient.contact, recipient_company: recipient.company,
    sender_city: text(row.CitySenderDescription), sender_address: text(row.SenderAddressDescription),
  };
}
export interface Shipment {
  act_ids?: number[];
  provider_details?: ProviderDetails;
  id: string; ttn: string; direction: Direction; state: ShipmentState;
  description: string; provider_description: string; origin: string; destination: string; warehouse: string;
  raw_status: string; raw_code: string; estimated_date: string | null; document_date: string | null; sent_date: string | null;
  arrived_date: string | null; received_date: string | null; created_at: string; updated_at: string;
  checked_at: string | null; sync_error: string | null; version: number; responsible_id: number | null;
  links?: { act_id: number; note: string; purpose: string; version: number; label?: string }[];
}
