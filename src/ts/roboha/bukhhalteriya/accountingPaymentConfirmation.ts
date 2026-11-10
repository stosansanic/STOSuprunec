import { supabase } from "../../vxid/supabaseClient";
import { getSavedUserDataFromLocalStorage } from "../tablucya/users";

let operationPending = false;
let dialogPending = false;

/** One financial action across all accounting tabs, including its confirmation. */
export function isAccountingPaymentBusy(): boolean {
  return operationPending || dialogPending;
}

export async function withAccountingPaymentOperation(task: () => Promise<void>): Promise<void> {
  if (isAccountingPaymentBusy()) return;
  operationPending = true;
  try { await task(); }
  finally { operationPending = false; }
}

/** A password is verified once per confirmation, never cached or logged. */
export function confirmAccountingPayment(
  action: "pay" | "unpay",
  summary = "",
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (dialogPending) return Promise.resolve(false);
  const actor = getSavedUserDataFromLocalStorage();
  if (!actor?.slyusar_id) return Promise.resolve(false);
  const owner = localStorage.getItem("userAuthData");
  const current = () => {
    try {
      return owner === localStorage.getItem("userAuthData") &&
        actor.slyusar_id === getSavedUserDataFromLocalStorage()?.slyusar_id && isCurrent();
    } catch { return false; }
  };
  if (!current()) return Promise.resolve(false);
  dialogPending = true;

  return new Promise<boolean>((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = document.createElement("div");
    modal.id = "password-confirmation-modal";
    modal.className = "login-modal";
    const box = document.createElement("div");
    box.className = "login-modal-content";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "accounting-payment-title");
    box.setAttribute("aria-describedby", "accounting-payment-summary");
    const icon = document.createElement("span");
    icon.className = "login-modal-icon";
    icon.textContent = "🔐";
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("h3");
    title.id = "accounting-payment-title";
    title.className = "login-modal-title";
    title.textContent = action === "pay" ? "Підтвердження розрахунку" : "Підтвердження скасування";
    const description = document.createElement("p");
    description.id = "accounting-payment-summary";
    description.className = "login-modal-subtitle";
    description.textContent = `${summary ? `${summary}. ` : ""}Введіть пароль для підтвердження`;
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "••••••••";
    input.className = "login-input";
    input.autocomplete = "current-password";
    input.setAttribute("aria-label", "Пароль для підтвердження розрахунку");
    const error = document.createElement("div");
    error.className = "login-error-message";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:12px;justify-content:center;margin-top:16px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "login-button";
    cancel.textContent = "Скасувати";
    cancel.style.cssText = "flex:1;margin-top:0;background:linear-gradient(135deg,#94a3b8,#a1b0c4)";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "login-button";
    confirm.textContent = "Підтвердити";
    confirm.style.cssText = "flex:1;margin-top:0";
    let finished = false;
    let verifying = false;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = false;
      input.classList.add("input-error");
      input.focus();
    };
    const finish = (approved: boolean) => {
      if (finished) return;
      // A filter/user change must also invalidate an already verified response.
      const result = approved && current();
      finished = true;
      controller?.abort();
      clearTimeout(timeout);
      input.value = "";
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", onPageHide);
      modal.remove();
      dialogPending = false;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === "userAuthData") finish(false);
    };
    const onPageHide = () => finish(false);
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); finish(false);
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault(); event.stopPropagation(); void verify();
      } else if (event.key === "Tab") {
        const focusable = verifying ? [cancel] : [input, cancel, confirm];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const verify = async () => {
      if (finished || verifying) return;
      if (!current()) { finish(false); return; }
      const password = input.value.trim();
      if (!password) { showError("Введіть пароль"); return; }
      verifying = true;
      confirm.disabled = input.disabled = true;
      confirm.textContent = "Перевірка…";
      error.hidden = true;
      box.setAttribute("aria-busy", "true");
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 20_000);
      try {
        const request = supabase.rpc("verify_slyusar_password_by_id", {
          input_slyusar_id: actor.slyusar_id,
          input_password: password,
        });
        const result = await request.abortSignal(controller.signal);
        if (finished) return;
        if (!current()) { finish(false); return; }
        if (result.error) {
          showError("Не вдалося перевірити пароль. Спробуйте ще раз.");
        } else if (result.data !== true) {
          showError("Невірний пароль");
          input.select();
        } else { finish(true); }
      } catch {
        if (!finished) showError("Не вдалося перевірити пароль. Спробуйте ще раз.");
      } finally {
        clearTimeout(timeout);
        verifying = false;
        if (!finished) {
          confirm.disabled = input.disabled = false;
          confirm.textContent = "Підтвердити";
          box.setAttribute("aria-busy", "false");
          input.focus();
        }
      }
    };
    confirm.addEventListener("click", () => { void verify(); });
    cancel.addEventListener("click", () => finish(false));
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", onPageHide);
    buttons.append(cancel, confirm);
    box.append(icon, title, description, input, error, buttons);
    modal.append(box);
    document.body.append(modal);
    input.focus();
  });
}
