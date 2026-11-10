import { notify as showAppMessage } from "./appDialogs";
import { confirmDiscardChanges } from "../roboha/workshop/dialog";

let editor: { actId: number; body: HTMLElement; baseline: string } | null = null;
let pending = false;
let payrollPendingActId: number | null = null;
let payrollNotice: HTMLDivElement | null = null;
let payrollError = "";

function renderPayrollNotice() {
  payrollNotice?.remove();
  payrollNotice = null;
  if (!editor || editor.actId !== payrollPendingActId) return;
  const notice = document.createElement("div");
  notice.className = "act-payroll-pending-notice";
  notice.setAttribute("role", "status");
  notice.style.cssText = "margin:0 0 16px;padding:12px 16px;border:1px solid #e9cf8e;border-radius:12px;background:#fff6df;color:#694a13;line-height:1.5;";
  const message = document.createElement("div");
  message.textContent = payrollError
    ? "⚠️ Дані акта збережено, але зарплату ще не синхронізовано. Перевірте причину нижче перед повторним збереженням. Виплати за цим актом поки заблоковані."
    : "⚠️ Дані акта збережено, але зарплату ще не синхронізовано. Натисніть «Зберегти зміни», щоб завершити нарахування. Виплати за цим актом поки заблоковані.";
  notice.append(message);
  if (payrollError) {
    const reason = document.createElement("div");
    reason.textContent = payrollError;
    notice.append(reason);
  }
  editor.body.prepend(notice);
  payrollNotice = notice;
}

function hasPendingActPayroll() {
  return !!editor && editor.body.isConnected && editor.actId === payrollPendingActId;
}

// The saved-data marker is independent of unsaved DOM edits. Set it before
// tracking a newly opened act, and clear only after payroll finalization succeeds.
export function setActEditorPayrollPending(actId: number, value: boolean, reason = ""): void {
  if (editor && editor.actId !== actId) return;
  payrollPendingActId = value ? actId : null;
  payrollError = value ? reason : "";
  renderPayrollNotice();
}

export function actEditorSignature(body: HTMLElement): string {
  return JSON.stringify(Array.from(body.querySelectorAll<HTMLElement>(
    '[data-name], [contenteditable], input, textarea, select',
  )).map(el => [el.getAttribute("data-name") || el.id,
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? el.value : el.textContent]));
}

export function trackActEditor(actId: number, body: HTMLElement) {
  if (payrollPendingActId !== actId) { payrollPendingActId = null; payrollError = ""; }
  editor = { actId, body, baseline: actEditorSignature(body) };
  renderPayrollNotice();
}

export function setActWritePending(value: boolean) { pending = value; }
export function isActWritePending() { return pending; }
export function markActEditorSaved(actId: number, signature: string) {
  if (editor?.actId === actId) editor.baseline = signature;
}
export function forgetActEditor() {
  payrollNotice?.remove();
  payrollNotice = null;
  payrollPendingActId = null;
  payrollError = "";
  editor = null;
}
export function hasUnsavedActChanges() {
  return !!editor && editor.body.isConnected && actEditorSignature(editor.body) !== editor.baseline;
}
export async function confirmActNavigation(): Promise<boolean> {
  if (pending) {
    showAppMessage("Зачекайте завершення збереження акту.");
    return false;
  }
  const unsaved = hasUnsavedActChanges();
  if (hasPendingActPayroll()) {
    return confirmDiscardChanges({
      icon: "⚠️",
      title: "Зарплату ще не синхронізовано",
      subtitle: payrollError
        ? `Дані акта збережено, але нарахування потребує перевірки: ${payrollError} ${unsaved ? "Також є нові незбережені зміни. Якщо вийти, вони не збережуться. " : ""}Виплати за цим актом залишаться заблокованими до завершення синхронізації.`
        : unsaved
        ? "Попередні дані акта збережено, але зарплату ще не синхронізовано. Також є нові незбережені зміни. Залишіться в акті, щоб повторити збереження, або вийдіть без цих нових змін."
        : "Дані акта збережено, але зарплату ще не синхронізовано. Для відкритого акта повторіть «Зберегти зміни». Якщо вийти зараз, виплати за цим актом залишаться заблокованими.",
      cancelLabel: "Залишитися в акті",
      discardLabel: unsaved ? "Вийти без нових змін" : "Вийти з акта",
    });
  }
  return !unsaved || confirmDiscardChanges({
    icon: "📝",
    title: "Незбережені зміни в акті",
    subtitle: "Вийти з акту без збереження внесених змін?",
    cancelLabel: "Залишитися в акті",
    discardLabel: "Вийти без збереження",
  });
}

window.addEventListener("beforeunload", (event) => {
  if (!pending && !hasUnsavedActChanges() && !hasPendingActPayroll()) return;
  event.preventDefault();
  event.returnValue = "";
});
