import { notify, type MessageType } from "../../../utils/appDialogs";
export type NotificationType = MessageType;
export const showNotification = notify;

// Покращена функція для модального вікна збереження
export function showSavePromptModal(
  savePromptModalId: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById(savePromptModalId);
    if (!modal) return resolve(false);

    modal.style.display = "flex";

    const confirmBtn = document.getElementById("save-confirm")!;
    const cancelBtn = document.getElementById("save-cancel")!;

    const cleanup = () => {
      modal.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    };

    const onConfirm = () => {
      cleanup();
      showNotification("Дані успішно збережено", "success");
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      showNotification("Скасовано користувачем", "warning");
      resolve(false);
    };

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}
