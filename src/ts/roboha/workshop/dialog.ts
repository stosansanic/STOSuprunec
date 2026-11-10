export function workflowDialog(title: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "workflow-dialog";
  dialog.setAttribute("aria-label", title);
  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Закрити");
  header.append(heading, close);
  const content = document.createElement("div");
  content.className = "workflow-content";
  const message = document.createElement("p");
  message.className = "workflow-message";
  message.setAttribute("role", "status");
  dialog.append(header, message, content);
  let busy = false;
  let dirty = () => false;
  const leave = () => {
    if (busy) { message.textContent = "Зачекайте завершення операції."; return; }
    if (dirty()) {
      confirmDiscardChanges().then(confirmed => { if (confirmed && dialog.open) dialog.close(); });
      return;
    }
    dialog.close();
  };
  close.onclick = leave;
  dialog.addEventListener("cancel", event => { event.preventDefault(); leave(); });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!busy && !dirty()) return;
    event.preventDefault(); event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  dialog.addEventListener("close", () => {
    window.removeEventListener("beforeunload", beforeUnload);
    dialog.remove();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, content, message, setBusy: (value: boolean) => { busy = value; },
    setDirty: (check: () => boolean) => { dirty = check; } };
}

export interface DiscardChangesPrompt {
  icon: string;
  title: string;
  subtitle: string;
  cancelLabel: string;
  discardLabel: string;
}

let discardPromptPromise: Promise<boolean> | null = null;

export function confirmDiscardChanges(options: Partial<DiscardChangesPrompt> = {}): Promise<boolean> {
  if (discardPromptPromise) return discardPromptPromise;
  const prompt: DiscardChangesPrompt = {
    icon: options.icon || "⚠️",
    title: options.title || "Є незбережені дані",
    subtitle: options.subtitle || "Закрити без збереження?",
    cancelLabel: options.cancelLabel || "Скасувати",
    discardLabel: options.discardLabel || "Закрити",
  };

  discardPromptPromise = new Promise(resolve => {
    const modal = document.createElement("dialog");
    modal.className = "workflow-confirmation-dialog";
    const titleId = `workflow-confirmation-title-${crypto.randomUUID()}`;
    modal.setAttribute("aria-labelledby", titleId);

    const content = document.createElement("div"); content.className = "login-modal-content";
    const icon = document.createElement("span"); icon.className = "login-modal-icon"; icon.textContent = prompt.icon;
    const title = document.createElement("h3"); title.className = "login-modal-title"; title.id = titleId; title.textContent = prompt.title;
    const subtitle = document.createElement("p"); subtitle.className = "login-modal-subtitle"; subtitle.textContent = prompt.subtitle;
    const actions = document.createElement("div"); actions.className = "workflow-confirmation-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "login-button workflow-confirmation-cancel"; cancel.textContent = prompt.cancelLabel;
    const discard = document.createElement("button"); discard.type = "button"; discard.className = "login-button"; discard.textContent = prompt.discardLabel;
    actions.append(cancel, discard); content.append(icon, title, subtitle, actions); modal.append(content); document.body.append(modal);

    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (modal.open) modal.close();
      modal.remove();
      discardPromptPromise = null;
      resolve(confirmed);
    };
    cancel.onclick = () => finish(false);
    discard.onclick = () => finish(true);
    modal.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    modal.addEventListener("click", event => { if (event.target === modal) finish(false); });
    modal.addEventListener("close", () => { if (!settled) finish(false); }, { once: true });
    modal.showModal();
    cancel.focus();
  });
  return discardPromptPromise;
}

export function workflowButton(text: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = text; button.onclick = action;
  return button;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Операція не виконана. Перевірте з’єднання та повторіть.";
}
