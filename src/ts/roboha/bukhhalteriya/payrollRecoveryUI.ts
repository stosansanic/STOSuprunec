import "../../../scss/robocha/bukhhalteriya/_payroll-recovery.scss";
import { supabase } from "../../vxid/supabaseClient";
import { readPendingPayrollActs, recoverSavedActPayroll } from "../../utils/payrollRecovery";
import { workflowButton, workflowDialog } from "../workshop/dialog";
import { announceAccountingChange } from "./accountingPeriod";

type PendingAct = Awaited<ReturnType<typeof readPendingPayrollActs>>["rows"][number];
type RecoveryResult = { status: "saving" | "recovered" | "error"; message: string };
type RecoveryOptions = { onRecovered?: () => Promise<void> };
const BATCH_LIMIT = 25;
let banner: HTMLElement | null = null;
let bannerScope = "";
let activeDialog: { dialog: HTMLDialogElement; scope: string } | null = null;
let authOwner: string | null | undefined;
let authRevision = 0;

function ownerScope(): string {
  return JSON.stringify([authRevision, localStorage.getItem("userAuthData") || ""]);
}

function discardPreviousOwnerUI(): void {
  const scope = ownerScope();
  if (bannerScope !== scope) { banner?.remove(); banner = null; }
  if (activeDialog && activeDialog.scope !== scope) activeDialog.dialog.close();
}

supabase.auth.onAuthStateChange((event, session) => {
  const owner = session?.user?.id || null;
  if ((authOwner !== undefined && owner !== authOwner) || event === "USER_UPDATED") authRevision++;
  authOwner = owner;
  discardPreviousOwnerUI();
});
window.addEventListener("storage", event => {
  if (event.key === null || event.key === "userAuthData") discardPreviousOwnerUI();
});

function recoveryError(error: unknown): string {
  const value = error as { code?: string; message?: string } | null;
  const message = value?.message || (typeof error === "string" ? error : "Не вдалося завершити операцію. Перевірте з’єднання та повторіть.");
  if (["PGRST202", "42883"].includes(value?.code || "") || message.includes("payroll_pending_recovery")) {
    return "Відновлення нарахувань ще не встановлено. Потрібно застосувати міграцію payroll_pending_recovery та повторити операцію.";
  }
  return message;
}

function displayDate(value: string | null): string {
  const day = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return day ? `${day[3]}.${day[2]}.${day[1]}` : "дата не вказана";
}

/** The first directory page includes a count and never fetches payroll histories. */
async function refreshPendingCount(scope: string, options: RecoveryOptions): Promise<void> {
  const { data, error } = await supabase.rpc("traffic_payroll_directory", { p_after: null });
  if (scope !== ownerScope()) return;
  if (error) throw error;
  const count = Number(data?.pending_count);
  if (data?.pending_count == null || !Number.isSafeInteger(count) || count < 0) throw new Error("Не вдалося підтвердити кількість незавершених нарахувань.");
  updatePayrollRecoveryBanner(count, options);
}

/** Updating this banner only displays the queue; it never starts recovery. */
export function updatePayrollRecoveryBanner(pendingCount: number, options: RecoveryOptions = {}): void {
  discardPreviousOwnerUI();
  banner?.remove();
  banner = null;
  if (!pendingCount) return;
  const container = document.getElementById("podlegle-table-container");
  if (!container) return;
  const scope = ownerScope();
  bannerScope = scope;
  banner = document.createElement("aside");
  banner.className = "payroll-recovery-banner";
  banner.setAttribute("aria-label", "Незавершені нарахування зарплати");
  const text = document.createElement("p");
  text.textContent = `Акти збережено, але нарахування зарплати ще не завершено: ${pendingCount}. Виплати за цими актами заблоковані.`;
  const button = workflowButton("Переглянути акти", () => {
    if (scope !== ownerScope()) { discardPreviousOwnerUI(); return; }
    openPayrollRecovery(options);
  });
  banner.append(text, button);
  container.prepend(banner);
}

function openPayrollRecovery(options: RecoveryOptions): void {
  discardPreviousOwnerUI();
  if (activeDialog?.dialog.open) { activeDialog.dialog.focus(); return; }
  const scope = ownerScope();
  const ui = workflowDialog("Незавершені нарахування");
  ui.dialog.classList.add("payroll-recovery-dialog");
  activeDialog = { dialog: ui.dialog, scope };
  let busy = false;
  let pageLoaded = false;
  let rows: PendingAct[] = [];
  let hasMore = false;
  let nextAfter: number | null = null;
  let pageAfter: number | undefined;
  const previousPages: Array<number | undefined> = [];
  const results = new Map<number, RecoveryResult>();
  const intro = document.createElement("p");
  intro.className = "payroll-recovery-intro";
  intro.textContent = "Відновлення використовує збережені позиції акта. Відкривати редактор не потрібно. За один запуск обробляється до 25 актів на поточній сторінці.";
  const actions = document.createElement("div"); actions.className = "payroll-recovery-actions";
  const list = document.createElement("div"); list.className = "payroll-recovery-list";
  const pager = document.createElement("div"); pager.className = "payroll-recovery-actions";
  const batchButton = workflowButton("Відновити до 25 актів", () => {
    const pending = rows.filter(row => !results.has(row.act_id));
    const failed = rows.filter(row => results.get(row.act_id)?.status === "error");
    void recoverRows([...pending, ...failed].slice(0, BATCH_LIMIT).map(row => row.act_id));
  });
  const reloadButton = workflowButton("Оновити список", () => { void loadPage(pageAfter); });
  const previousButton = workflowButton("Попередні", () => { void loadPage(previousPages[previousPages.length - 1], "previous"); });
  const nextButton = workflowButton("Наступні 50", () => { if (nextAfter !== null) void loadPage(nextAfter, "next"); });
  actions.append(batchButton, reloadButton);
  pager.append(previousButton, nextButton);
  ui.content.append(intro, actions, list, pager);
  ui.dialog.addEventListener("close", () => {
    if (activeDialog?.dialog === ui.dialog) activeDialog = null;
  }, { once: true });

  function current(): boolean {
    if (scope !== ownerScope()) { discardPreviousOwnerUI(); return false; }
    return ui.dialog.isConnected && ui.dialog.open;
  }

  function render(): void {
    list.replaceChildren();
    batchButton.disabled = busy || !rows.some(row => results.get(row.act_id)?.status !== "recovered");
    reloadButton.disabled = busy;
    previousButton.disabled = busy || previousPages.length === 0;
    nextButton.disabled = busy || !hasMore || nextAfter === null;
    ui.content.setAttribute("aria-busy", String(busy));
    if (!rows.length) {
      const empty = document.createElement("p"); empty.className = "payroll-recovery-empty";
      empty.textContent = busy ? "Завантаження актів…" : pageLoaded
        ? "На цій сторінці немає незавершених нарахувань." : "Список актів не завантажено. Повторіть спробу кнопкою «Оновити список».";
      list.append(empty);
    }
    for (const act of rows) {
      const result = results.get(act.act_id);
      const card = document.createElement("section"); card.className = "payroll-recovery-act";
      if (result) card.dataset.status = result.status;
      const description = document.createElement("div");
      const heading = document.createElement("h3"); heading.textContent = `Акт №${act.act_id}`;
      const status = document.createElement("p"); status.className = "payroll-recovery-act-meta";
      status.textContent = `${act.date_off ? `Закритий ${displayDate(act.date_off)}` : "Відкритий"} · Створено ${displayDate(act.date_on)}`;
      const receiver = document.createElement("p"); receiver.className = "payroll-recovery-act-meta";
      receiver.textContent = act.pruimalnyk ? `Приймальник: ${act.pruimalnyk}` : "Приймальника не вказано";
      description.append(heading, status, receiver);
      const button = workflowButton(result?.status === "recovered" ? "Нарахування відновлено" : "Відновити нарахування", () => { void recoverRows([act.act_id]); });
      button.disabled = busy || result?.status === "recovered";
      button.setAttribute("aria-label", `${button.textContent}, акт №${act.act_id}`);
      card.append(description, button);
      if (result) {
        const message = document.createElement("p"); message.className = "payroll-recovery-act-result";
        message.textContent = result.message;
        message.setAttribute("role", result.status === "error" ? "alert" : "status");
        card.append(message);
      }
      list.append(card);
    }
  }

  async function loadPage(after?: number, direction?: "previous" | "next"): Promise<void> {
    if (busy || !current()) return;
    busy = true; ui.setBusy(true); ui.message.textContent = "Завантаження актів…"; render();
    try {
      const page = await readPendingPayrollActs(after);
      if (!current()) return;
      // A later saved edit can put a successfully recovered act back in the queue.
      for (const row of page.rows) {
        if (results.get(row.act_id)?.status === "recovered") results.delete(row.act_id);
      }
      if (direction === "next") previousPages.push(pageAfter);
      if (direction === "previous") previousPages.pop();
      pageAfter = after; rows = page.rows; hasMore = page.hasMore; nextAfter = page.nextAfter; pageLoaded = true;
      ui.message.textContent = rows.length ? `Показано актів: ${rows.length}. Новіші — на початку списку.` : "На цій сторінці незавершених нарахувань немає.";
    } catch (error) {
      if (current()) ui.message.textContent = recoveryError(error);
    } finally {
      if (current()) { busy = false; ui.setBusy(false); render(); }
    }
  }

  async function recoverRows(actIds: number[]): Promise<void> {
    if (busy || !current() || !actIds.length) return;
    busy = true; ui.setBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const actId of actIds.slice(0, BATCH_LIMIT)) {
        if (!current()) return;
        results.set(actId, { status: "saving", message: "Відновлення нарахувань…" });
        ui.message.textContent = `Обробляємо акт №${actId}. Завершено: ${succeeded + failed} із ${actIds.length}.`; render();
        try {
          await recoverSavedActPayroll(actId);
          if (!current()) return;
          results.set(actId, { status: "recovered", message: "Нарахування підтверджено й збережено." });
          succeeded++;
          announceAccountingChange(["payroll", "profit"]);
        } catch (error) {
          if (!current()) return;
          results.set(actId, { status: "error", message: recoveryError(error) });
          failed++;
        }
        render();
      }
      if (!current()) return;
      ui.message.textContent = `Відновлено: ${succeeded}. Потребують перевірки або повторної спроби: ${failed}.`;
      if (succeeded) {
        try {
          await refreshPendingCount(scope, options);
          if (!current()) return;
        } catch (error) {
          if (!current()) return;
          ui.message.textContent += ` Лічильник не оновлено: ${recoveryError(error)}`;
        }
        try { await options.onRecovered?.(); }
        catch (error) { if (current()) ui.message.textContent += ` Звіт не оновлено: ${recoveryError(error)}`; }
      }
    } finally {
      if (current()) { busy = false; ui.setBusy(false); render(); }
    }
  }

  void loadPage();
}
