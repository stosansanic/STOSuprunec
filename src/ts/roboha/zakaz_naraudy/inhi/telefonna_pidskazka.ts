import { appConfirm } from "../../../utils/appDialogs";
//telefonna_pidskazka.ts
import { showNotification } from "./vspluvauhe_povidomlenna";

/**
 * Ініціалізує обробник кліків для номеру телефону в модальному вікні,
 * намагаючись здійснити дзвінок для всіх пристроїв,
 * з поясненням для десктопних користувачів, якщо дзвінок неможливий без сторонніх програм.
 *
 * @param bodyElement Елемент, який містить номер телефону (зазвичай, тіло модального вікна).
 * @param phone Номер телефону, який потрібно використовувати для дзвінка.
 */
export function initPhoneClickHandler(
  bodyElement: HTMLElement,
  phone: string
): void {
  const phoneCell = bodyElement.querySelector<HTMLTableCellElement>(
    "table.left tr:nth-child(3) td:nth-child(2)"
  );

  if (!phoneCell || !phone || phone.trim() === "—") {
    return;
  }

  phoneCell.style.cursor = "pointer";
  phoneCell.title = "Натисніть, щоб зателефонувати";
  phoneCell.style.textDecoration = "none";
  phoneCell.style.color = "blue";

  phoneCell.addEventListener("click", async () => {
    const cleanPhone = phone.replace(/\D/g, "");
    const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|Windows Phone/i.test(
      navigator.userAgent
    );

    if (isMobile) {
      // На мобільних пристроях працює стандартний дзвінок
      const confirmCall = await appConfirm(
        `Ви бажаєте зателефонувати на номер ${phone}?`
      );
      if (confirmCall) {
        window.location.href = `tel:${cleanPhone}`;
        showNotification(`Виклик номера ${phone}...`, "info", 2000);
      } else {
        showNotification("Дзвінок скасовано.", "warning", 1500);
      }
    } else {
      // На десктопних пристроях спробуємо викликати tel:
      // Але попередимо користувача, що може знадобитися сторонній додаток.
      const confirmAttemptCall = await appConfirm(
        `Ви бажаєте спробувати зателефонувати на номер ${phone}?\n\n` +
          `На комп'ютері для цього потрібна встановлена програма (наприклад, Skype, Zoom), ` +
          `яка може обробляти телефонні посилання.`
      );

      if (confirmAttemptCall) {
        window.location.href = `tel:${cleanPhone}`;
        showNotification(`Спроба виклику номера ${phone}...`, "info", 3000);
        // Можна додати таймаут, щоб дати час браузеру відреагувати
        setTimeout(() => {}, 3500); // Даємо 3.5 секунди на реакцію браузера/системи
      } else {
        showNotification("Спроба дзвінка скасована.", "warning", 1500);
      }
    }
  });
}
