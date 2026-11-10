// Read-only Data API export. Raw JSON is retained so bigint/numeric values are not rounded by JS.
export const APP_TABLES = [
  "acts", "clients", "cars", "sclad", "works", "details", "shops", "slyusars", "settings",
  "incomes", "vutratu", "faktura", "post_arxiv", "post_category", "post_name", "sms", "whitelist",
  "act_changes_notifications", "slusar_complete_notifications", "audit_logs", "ai_chats", "ai_messages",
  "ai_skills", "atlas_reminder_logs", "atlas_reminders", "atlas_telegram_users",
] as const;
// Known primary keys from the app's existing queries/schema descriptions.
// Tables without a confirmed key are safe only while they fit in one page;
// exportTable deliberately refuses unstable multi-page exports for them.
const APP_TABLE_KEYS: Record<(typeof APP_TABLES)[number], string[]> = {
  acts: ["act_id"], clients: ["client_id"], cars: ["cars_id"], sclad: ["sclad_id"],
  works: ["work_id"], details: ["detail_id"], shops: ["shop_id"], slyusars: ["slyusar_id"],
  settings: ["setting_id"], incomes: ["income_id"], vutratu: ["vutratu_id"], faktura: ["faktura_id"],
  post_arxiv: ["post_arxiv_id"], post_category: ["category_id"], post_name: ["post_id"], sms: ["sms_id"],
  whitelist: ["email"], act_changes_notifications: ["notification_id"],
  slusar_complete_notifications: ["notification_id"], audit_logs: ["id"], ai_chats: ["chat_id"],
  ai_messages: ["message_id"], ai_skills: ["skill_id"], atlas_reminder_logs: ["log_id"],
  atlas_reminders: ["reminder_id"], atlas_telegram_users: ["slyusar_id"],
};
export interface ExportTable { name: string; keys: string[] }
export interface ExportWriter { write(text: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface ExportTarget { open(name: string): Promise<ExportWriter> }
export interface ExportProgress { table: string; rows: number; total: number; verifying: boolean }
export type ReadRequest = (path: string, params: URLSearchParams, signal: AbortSignal) => Promise<Response>;
export interface CanonicalExportPage {
  format: "sto-canonical-page-v1"; payload: string | null;
  count: number; total: number; hash: string;
}
export type ReadCanonicalPage = (table: ExportTable, offset: number, limit: number, hashOnly: boolean, signal: AbortSignal) => Promise<CanonicalExportPage | null>;

export function discoverTables(spec: any): ExportTable[] {
  if (!spec?.paths || !spec?.definitions) throw new Error("Supabase не надав перелік таблиць. Експорт зупинено, щоб не пропустити дані.");
  const tables: ExportTable[] = [];
  for (const [path, route] of Object.entries<any>(spec.paths)) {
    if (!/^\/[^/]+$/.test(path) || !route?.get || path === "/") continue;
    const name = path.slice(1);
    // Names become local files: never accept paths or Windows reserved punctuation.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Непідтримувана назва таблиці: ${name}. Потрібен окремий експорт.`);
    const schema = spec.definitions[name];
    if (!schema?.properties) throw new Error(`Немає опису колонок ${name}. Експорт зупинено.`);
    const keys = Object.entries<any>(schema.properties).filter(([, column]) => String(column.description || "").includes("<pk/>")).map(([key]) => key);
    tables.push({ name, keys });
  }
  if (!tables.length) throw new Error("Немає доступних таблиць public для експорту.");
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

function check(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Експорт зупинено", "AbortError"); }
export function readPage(raw: string, range: string | null, offset: number) {
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw new Error("Отримано пошкоджену JSON-відповідь. Файл не завершено."); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Supabase повернув не список записів.");
  const match = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(range || "");
  if (!match) throw new Error("Supabase не надав точну кількість рядків (Content-Range).");
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || (rows.length && (Number(match[1]) !== offset || Number(match[2]) !== offset + rows.length - 1)) || offset + rows.length > total) throw new Error("Порушена послідовність сторінок експорту.");
  if (!rows.length && offset < total) throw new Error("Відповідь порожня, але в таблиці ще є записи. Експорт неповний.");
  return { count: rows.length, total, inner: raw.trim().slice(1, -1).trim() };
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function exportTable(table: ExportTable, read: ReadRequest, target: ExportTarget, signal: AbortSignal, progress: (p: ExportProgress) => void, canonicalRead?: ReadCanonicalPage) {
  // No guessed "id" ordering: unkeyed relations may only be exported in one page.
  if (table.keys.some(key => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))) throw new Error("Некоректне ім’я ключа таблиці для пагінації.");
  const order = table.keys.map(key => `${key}.asc`).join(",");
  const pages: { offset: number; count: number; hash: string }[] = [];
  const initialPages: { offset: number; count: number; total: number; hash: string }[] = [];
  const fileChunks: { bytes: number; hash: string }[] = [];
  const writer = await target.open(`public.${table.name}.jsonb`);
  let total = -1, offset = 0, bytes = 0;
  let canonical: boolean | undefined;
  const validateCanonical = (page: CanonicalExportPage) => {
    if (page.format !== "sto-canonical-page-v1" || !Number.isSafeInteger(page.count) || page.count < 0 ||
      !Number.isSafeInteger(page.total) || page.total < 0 || !/^[a-f0-9]{64}$/.test(page.hash)) {
      throw new Error("Некоректні контрольні дані експорту. Файл не підтверджено.");
    }
  };
  const append = async (text: string) => {
    check(signal);
    const length = new TextEncoder().encode(text).length;
    const digest = await hash(text);
    check(signal); await writer.write(text);
    bytes += length; fileChunks.push({ bytes: length, hash: digest });
  };
  try {
    if (canonicalRead && table.keys.length) {
      let start = 0;
      do {
        check(signal);
        const initial = await canonicalRead(table, start, 250, true, signal);
        if (!initial) {
          if (start) throw new Error("Початкова перевірка експорту стала недоступною.");
          canonical = false; break;
        }
        validateCanonical(initial);
        if (start + initial.count > initial.total || (!initial.count && start < initial.total) ||
            (initialPages.length && initial.total !== initialPages[0].total)) throw new Error("Дані змінилися під час підготовки експорту.");
        initialPages.push({ offset: start, count: initial.count, total: initial.total, hash: initial.hash });
        canonical = true; start += initial.count;
        if (start >= initial.total) break;
      } while (true);
    }
    await append("[\n");
    do {
      check(signal);
      let raw: string, range: string | null;
      const compact = canonicalRead && canonical !== false && table.keys.length
        ? await canonicalRead(table, offset, 250, false, signal) : null;
      if (canonical === true && compact === null) throw new Error("Перевірка експорту стала недоступною. Файл не підтверджено.");
      canonical = compact !== null;
      if (compact) {
        validateCanonical(compact);
        if (typeof compact.payload !== "string" || await hash(compact.payload) !== compact.hash) throw new Error("Контрольна сума сторінки не збігається. Файл не підтверджено.");
        const baseline = initialPages[pages.length];
        if (!baseline || baseline.offset !== offset || baseline.count !== compact.count || baseline.total !== compact.total || baseline.hash !== compact.hash) {
          throw new Error("Дані змінилися після початкової перевірки. Файл не підтверджено.");
        }
        raw = compact.payload;
        range = compact.count ? `${offset}-${offset + compact.count - 1}/${compact.total}` : `*/${compact.total}`;
      } else {
        const response = await read(table.name, new URLSearchParams({ select: "*", ...(order ? { order } : {}), offset: String(offset), limit: "250" }), signal);
        raw = await response.text(); range = response.headers.get("content-range");
      }
      const page = readPage(raw, range, offset);
      if (!table.keys.length && page.total > page.count) throw new Error("Не знайдено первинний ключ для стабільної пагінації великої таблиці. Файл не підтверджено.");
      if (total >= 0 && total !== page.total) throw new Error("Кількість записів змінилася під час експорту. Повторіть, коли працівники завершать редагування.");
      total = page.total;
      pages.push({ offset, count: page.count, hash: await hash(raw.trim()) });
      if (page.count) await append(`${offset ? ",\n" : ""}${page.inner}`);
      offset += page.count;
      progress({ table: table.name, rows: offset, total, verifying: false });
    } while (offset < total); // A server may cap pages below the requested 250 rows.

    // Re-read identical pages to detect edits/deletions/inserts (even if row count stays equal).
    // This detects changes, but does not replace a cross-table PostgreSQL snapshot.
    for (const saved of pages) {
      check(signal);
      let pageTotal: number, pageCount: number, pageHash: string;
      if (canonical && canonicalRead) {
        const page = await canonicalRead(table, saved.offset, saved.count || 1, true, signal);
        if (!page) throw new Error("Перевірка експорту стала недоступною. Файл не підтверджено.");
        validateCanonical(page);
        pageTotal = page.total; pageCount = page.count; pageHash = page.hash;
      } else {
        const response = await read(table.name, new URLSearchParams({ select: "*", ...(order ? { order } : {}), offset: String(saved.offset), limit: String(saved.count || 1) }), signal);
        const raw = await response.text(), page = readPage(raw, response.headers.get("content-range"), saved.offset);
        pageTotal = page.total; pageCount = page.count; pageHash = await hash(raw.trim());
      }
      if (pageTotal !== total || pageCount !== saved.count || pageHash !== saved.hash) throw new Error("Дані змінилися під час перевірки. Файл не підтверджено; повторіть експорт без паралельного редагування.");
      progress({ table: table.name, rows: saved.offset + saved.count, total, verifying: true });
    }
    await append("\n]\n");
    const fileIntegrity = { algorithm: "sha256-chunk-manifest-v1",
      hash: await hash(JSON.stringify(fileChunks)), chunks: fileChunks };
    check(signal); await writer.close();
    return { name: table.name, file: `public.${table.name}.jsonb`, rows: total, bytes, fileIntegrity, sourceManifest: canonical ? { format: "sto-source-manifest-v1", schema: "public", keys: table.keys, pages: initialPages } : null, verification: canonical ? "server-sha256" : "two-full-passes", status: "exported" as const };
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function exportDatabase(read: ReadRequest, target: ExportTarget, signal: AbortSignal, progress: (p: ExportProgress) => void, source = "", canonicalRead?: ReadCanonicalPage) {
  const startedAt = new Date().toISOString();
  // The PostgREST OpenAPI/schema endpoint is restricted to service_role on
  // this Supabase project. Never expose that privileged key in the browser;
  // export only the app's known public tables through its normal API access.
  const tables: ExportTable[] = APP_TABLES.map(name => ({ name, keys: APP_TABLE_KEYS[name] }));
  const report: any = {
    format: "sto-public-tables-json-v1", source, startedAt, finishedAt: null, status: "in_progress", schema: "public",
    knownApplicationTables: tables.map(table => table.name),
    scope: "Rows visible to the current authenticated Data API role; auth/storage/files/functions/RLS are not included.",
    consistency: "Per-page content verification (server SHA-256 when available, otherwise two full reads); not a single cross-table transactional snapshot. Export while other users are not editing.",
    tables: [],
    notice: "Keep this folder private: exported application data may contain personal information and API keys. Only files marked exported below are verified.",
  };
  const writeReport = async () => {
    const file = await target.open("export-report.json");
    try { await file.write(JSON.stringify(report, null, 2)); await file.close(); }
    catch (error) { await file.abort().catch(() => {}); throw error; }
  };
  await writeReport(); // An interrupted run must never resemble a complete backup.
  for (const table of tables) {
    if (signal.aborted) break;
    try {
      const exported = await exportTable(table, read, target, signal, progress, canonicalRead);
      report.tables.push(exported);
    } catch (error) {
      report.tables.push({ name: table.name, status: signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "Помилка читання або запису" });
    }
    await writeReport();
  }
  report.finishedAt = new Date().toISOString();
  report.status = signal.aborted ? "cancelled" : report.tables.some((t: any) => t.status !== "exported") ? "incomplete" : "exported_visible_tables";
  await writeReport();
  return report;
}
