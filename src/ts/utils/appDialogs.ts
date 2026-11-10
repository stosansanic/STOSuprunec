import "../../scss/robocha/_app-dialogs.scss";

export type MessageType = "success" | "error" | "warning" | "info";
const icons = { success: "✓", error: "!", warning: "!", info: "i" };
const titles = { success: "Готово", error: "Помилка", warning: "Зверніть увагу", info: "Повідомлення" };
interface Toast {
  card: HTMLDivElement;
  update(message: string, type: MessageType, duration: number): void;
  dismiss(): void;
}
let activeToast: Toast | null = null;

function createToast(): Toast {
  const card = document.createElement("div");
  card.setAttribute("aria-atomic", "true");
  const icon = document.createElement("span"); icon.className = "sto-message-icon"; icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("div");
  const title = document.createElement("strong");
  const body = document.createElement("p");
  text.append(title, body);
  const close = document.createElement("button"); close.type = "button"; close.className = "sto-toast-close"; close.textContent = "×"; close.setAttribute("aria-label", "Закрити повідомлення");
  card.append(icon, text, close);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime = 4500;
  let hovered = false;
  let stage = 0;
  const pause = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    pause();
    if (activeToast !== toast || !card.isConnected) return;
    if (hovered || card.contains(document.activeElement)) return;
    const expectedStage = stage;
    timer = setTimeout(() => {
      if (activeToast === toast && expectedStage === stage) toast.dismiss();
    }, lifetime);
  };
  const toast: Toast = {
    card,
    dismiss() {
      pause();
      card.remove();
      if (activeToast === toast) activeToast = null;
    },
    update(message, type, duration) {
      pause();
      stage++;
      lifetime = Math.max(2000, duration);
      card.className = `sto-toast sto-message-${type}`;
      card.setAttribute("role", type === "error" ? "alert" : "status");
      card.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
      icon.textContent = icons[type];
      title.textContent = titles[type];
      body.textContent = message;
      // Reuse this live region for the next process state instead of stacking
      // progress and completion. No focus is moved away from the act editor.
      const openDialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      const host = openDialogs.item(openDialogs.length - 1) ?? document.body;
      if (card.parentElement !== host) host.append(card);
      if (typeof card.showPopover === "function" && !card.matches(":popover-open")) card.showPopover();
      schedule();
    },
  };
  close.onclick = toast.dismiss;
  card.onmouseenter = () => { hovered = true; pause(); };
  card.onmouseleave = () => { hovered = false; schedule(); };
  card.addEventListener("focusin", pause);
  card.addEventListener("focusout", () => queueMicrotask(schedule));
  // A manual popover stays above native dialogs without blocking the page.
  card.setAttribute("popover", "manual");
  return toast;
}

export function notify(message: string, type: MessageType = "info", duration = 4500): void {
  if (!activeToast?.card.isConnected) {
    activeToast?.dismiss();
    activeToast = createToast();
  }
  activeToast.update(message, type, duration);
}

let tail: Promise<unknown> = Promise.resolve();
function ask(message: string, confirmation: boolean): Promise<boolean> {
  const run = () => new Promise<boolean>(resolve => {
    const previousFocus = document.activeElement;
    const modal = document.createElement("dialog"); modal.className = "sto-message-dialog";
    const id = `sto-message-${crypto.randomUUID()}`;
    modal.setAttribute("aria-labelledby", id); modal.setAttribute("aria-describedby", id + "-body");
    const icon = document.createElement("span"); icon.className = "sto-message-icon"; icon.textContent = confirmation ? "?" : "i"; icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("h3"); title.id = id; title.textContent = confirmation ? "Підтвердження дії" : "Повідомлення";
    const body = document.createElement("p"); body.id = id + "-body"; body.textContent = message;
    const actions = document.createElement("div"); actions.className = "sto-message-actions";
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return; settled = true;
      modal.close(); modal.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(accepted);
    };
    const accept = document.createElement("button"); accept.type = "button"; accept.textContent = confirmation ? "Підтвердити" : "Зрозуміло"; accept.onclick = () => finish(true);
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "sto-message-cancel"; cancel.textContent = "Скасувати"; cancel.onclick = () => finish(false);
    if (confirmation) actions.append(cancel);
    actions.append(accept); modal.append(icon, title, body, actions);
    modal.addEventListener("cancel", e => { e.preventDefault(); finish(false); });
    modal.addEventListener("close", () => finish(false));
    document.body.append(modal); modal.showModal();
    (confirmation ? cancel : accept).focus();
  });
  const result = tail.then(run, run); tail = result.catch(() => undefined); return result;
}
export const appConfirm = (message: string): Promise<boolean> => ask(message, true);
export const appAlert = async (message: string): Promise<void> => { await ask(message, false); };
