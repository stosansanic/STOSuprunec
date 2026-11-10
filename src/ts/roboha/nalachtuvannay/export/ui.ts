import { notify as showAppMessage } from "../../../utils/appDialogs";
import { supabase } from "../../../vxid/supabaseClient";
import { userAccessLevel, userName, verifyRoleIntegrity } from "../../tablucya/users";
import { workflowDialog, workflowButton, errorText } from "../../workshop/dialog";
import { exportDatabase, type ReadRequest, type ReadCanonicalPage, type ExportTarget } from "./core";
import { directoryTarget, memoryTarget, zipFiles, type ExportDirectory } from "./files";

let exportDialogOpen = false;
// Supabase JS exposes this transport at runtime but marks it protected in its
// TypeScript declarations. Keep that narrow cast isolated to this read-only
// exporter so raw JSON can be preserved without duplicating auth headers.
const supabaseRest = (supabase as unknown as { rest: { url: string; fetch?: typeof fetch } }).rest;
export function openDatabaseExport(): void {
  if (userAccessLevel !== "Адміністратор") { showAppMessage("Експорт усіх таблиць доступний лише адміністратору."); return; }
  if (exportDialogOpen) return;
  const ui = workflowDialog("💾 Експорт таблиць Supabase"); exportDialogOpen = true;
  let busy = false, controller: AbortController | null = null, downloadUrl: string | null = null;
  ui.dialog.addEventListener("close", () => { exportDialogOpen = false; if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
  const hint = document.createElement("p");
  hint.textContent = "Відомі таблиці програми public зберігаються окремими файлами .jsonb (звичайний JSON-масив рядків). Без видалення чи зміни Supabase. Файли містять конфіденційні дані, а налаштування можуть містити API-ключі: оберіть приватну папку. На час експорту попросіть працівників не редагувати базу. Це не технічний дамп: без Auth, файлів Storage, функцій і правил доступу; обмеження RLS залишаються чинними. Недоступні або відсутні таблиці буде показано як помилки.";
  const destination = document.createElement("p"), summary = document.createElement("div");
  const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string; id: string }) => Promise<ExportDirectory> }).showDirectoryPicker;
  const choose = workflowButton(picker ? "📁 Обрати папку та вивантажити" : "📦 Підготувати ZIP з окремими файлами", () => { void run(); });
  const cancel = workflowButton("Зупинити експорт", () => { controller?.abort(); }); cancel.disabled = true;
  const actions = document.createElement("div"); actions.className = "workflow-actions"; actions.append(choose, cancel);
  ui.content.append(hint, actions, destination, summary);
  if (!picker) {
    const fallback = document.createElement("p"); fallback.textContent = "Цей браузер не дозволяє вибирати папку. Буде створено ZIP; місце збереження визначає діалог/налаштування завантажень браузера. Для прямого запису великих таблиць у папку використайте Chrome або Edge на ПК."; ui.content.append(fallback);
  }
  async function run() {
    if (busy) return;
    if (userAccessLevel !== "Адміністратор") { ui.message.textContent = "Немає прав адміністратора."; return; }
    busy = true; choose.disabled = true; ui.setBusy(true); summary.replaceChildren();
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
    const owner = userName;
    controller = new AbortController();
    const signal = controller.signal;
    let target: ExportTarget;
    let memory: ReturnType<typeof memoryTarget> | undefined;
    const folderName = `Supabase-public-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      // Picker must run in this user-click stack, before authentication/network awaits.
      if (picker) {
        const parent = await picker.call(window, { mode: "readwrite", id: "sto-database-export" });
        const directory = await parent.getDirectoryHandle(folderName, { create: true });
        target = directoryTarget(directory); destination.textContent = `Папка: ${parent.name}/${folderName}`;
      } else { memory = memoryTarget(); target = memory.target; destination.textContent = `Архів: ${folderName}.zip`; }
      cancel.disabled = false;
      if (!await verifyRoleIntegrity() || userAccessLevel !== "Адміністратор" || userName !== owner) throw new Error("Права користувача змінилися. Експорт зупинено.");
      const read: ReadRequest = async (path, params, exportSignal) => {
        if (exportSignal.aborted) throw new DOMException("Експорт зупинено", "AbortError");
        if (userAccessLevel !== "Адміністратор" || userName !== owner) throw new Error("Користувач змінився. Повторіть вхід.");
        // Use the same Supabase client's fetch wrapper as normal table queries.
        // It injects the configured API key and current/refreshed auth token;
        // the app's own role session is not a Supabase access token.
        if (!supabaseRest.fetch) throw new Error("Supabase клієнт не має HTTP-транспорту для читання.");
        const timeout = new AbortController();
        const abort = () => timeout.abort(); exportSignal.addEventListener("abort", abort, { once: true });
        if (exportSignal.aborted) timeout.abort();
        const timer = window.setTimeout(abort, 60000);
        try {
          const url = new URL(`${supabaseRest.url.replace(/\/$/, "")}/${path ? encodeURIComponent(path) : ""}`);
          params.forEach((value, key) => url.searchParams.set(key, value));
          const response = await supabaseRest.fetch(url.toString(), { method: "GET", cache: "no-store", signal: timeout.signal,
            headers: { "Accept-Profile": "public", Accept: "application/json", Prefer: "count=exact" } });
          if (!response.ok) {
            const detail = (await response.text()).trim().slice(0, 240);
            throw new Error(`Читання ${path || "переліку таблиць"}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}. Дані не змінено.`);
          }
          // Consume body under the timeout as well. Never parse/stringify row values here.
          const text = await response.text();
          return new Response(text, { status: response.status, headers: response.headers });
        } catch (error) {
          if (exportSignal.aborted) throw new DOMException("Експорт зупинено", "AbortError");
          if (timeout.signal.aborted) throw new Error("Час читання таблиці вичерпано. Файл не підтверджено.");
          throw error;
        } finally { window.clearTimeout(timer); exportSignal.removeEventListener("abort", abort); }
      };
      let canonicalUnavailable = false;
      const canonicalRead: ReadCanonicalPage = async (table, offset, limit, hashOnly, exportSignal) => {
        if (exportSignal.aborted) throw new DOMException("Експорт зупинено", "AbortError");
        if (userAccessLevel !== "Адміністратор" || userName !== owner) throw new Error("Користувач змінився. Повторіть вхід.");
        if (canonicalUnavailable) return null;
        const timeout = new AbortController();
        const abort = () => timeout.abort();
        exportSignal.addEventListener("abort", abort, { once: true });
        const timer = window.setTimeout(abort, 60000);
        try {
          const response = await supabase.rpc("traffic_export_page", {
            p_table: table.name, p_keys: table.keys, p_offset: offset,
            p_limit: limit, p_hash_only: hashOnly,
          }).abortSignal(timeout.signal);
          if (response.error) {
            if (["PGRST202", "42883"].includes(response.error.code)) { canonicalUnavailable = true; return null; }
            throw new Error("Не вдалося отримати або перевірити сторінку експорту.");
          }
          if (!response.data) throw new Error("Порожня відповідь перевірки експорту.");
          return response.data;
        } finally { window.clearTimeout(timer); exportSignal.removeEventListener("abort", abort); }
      };
      ui.message.textContent = "Готую список таблиць програми…";
      const report = await exportDatabase(read, target, signal, p => {
        ui.message.textContent = `${p.verifying ? "Перевірка" : "Вивантаження"}: ${p.table} — ${p.rows} / ${p.total} рядків`;
      }, supabaseRest.url, canonicalRead);
      const success = report.tables.filter((t: any) => t.status === "exported");
      for (const table of report.tables) {
        const line = document.createElement("p");
        line.textContent = table.status === "exported" ? `✓ ${table.name}: ${table.rows} рядків` : `⚠ ${table.name}: ${table.error}`;
        summary.append(line);
      }
      if (memory) {
        const blob = await zipFiles(memory.files); downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = downloadUrl; link.download = `${folderName}.zip`;
        link.textContent = report.status === "exported_visible_tables" ? "💾 Зберегти ZIP" : "💾 Зберегти неповний ZIP і звіт"; summary.append(link);
      }
      ui.message.textContent = `${report.status === "exported_visible_tables" ? "Перевірено всі виявлені доступні таблиці." : report.status === "cancelled" ? "Експорт зупинено. Копія неповна." : "Увага: експорт неповний — дивіться звіт."} ${memory ? "Підготовлено" : "Збережено"} таблиць: ${success.length}. База Supabase не змінена.`;
    } catch (error) {
      ui.message.textContent = (error instanceof DOMException && error.name === "AbortError") ? "Експорт скасовано. Дані Supabase не змінені." : `Експорт не завершено: ${errorText(error)} Не вважайте папку повною копією.`;
    } finally { busy = false; choose.disabled = false; cancel.disabled = true; ui.setBusy(false); controller = null; }
  }
}
