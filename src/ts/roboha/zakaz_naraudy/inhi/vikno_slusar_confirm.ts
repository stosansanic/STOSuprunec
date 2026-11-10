/**
 * 🎨 Модальне вікно підтвердження для Слюсаря (замість window.confirm)
 */
export function showSlusarConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "slusar-confirm-overlay";
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleEscape);
      overlay.remove();
      resolve(confirmed);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      }
    };

    const modal = document.createElement("div");
    modal.className = "slusar-confirm-modal";

    const messageDiv = document.createElement("div");
    messageDiv.className = "slusar-confirm-message";
    messageDiv.textContent = message;

    const buttonsDiv = document.createElement("div");
    buttonsDiv.className = "slusar-confirm-buttons";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "slusar-confirm-btn slusar-confirm-ok";
    confirmBtn.textContent = "Підтвердити";
    confirmBtn.onclick = () => {
      finish(true);
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "slusar-confirm-btn slusar-confirm-cancel";
    cancelBtn.textContent = "Відмінити";
    cancelBtn.onclick = () => {
      finish(false);
    };

    buttonsDiv.appendChild(confirmBtn);
    buttonsDiv.appendChild(cancelBtn);
    modal.appendChild(messageDiv);
    modal.appendChild(buttonsDiv);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Фокус на кнопку "Підтвердити"
    focusTimer = setTimeout(() => confirmBtn.focus(), 100);

    // Escape закриває вікно
    document.addEventListener("keydown", handleEscape);
  });
}
