// ===== ФАЙЛ: src/ts/roboha/tablucya/act_notifications_ui.ts =====

interface ActNotificationPayload {
  act_id: number;
  changed_by_surname: string;
  item_name: string;
  dodav_vudaluv: boolean;
  created_at?: string;
  notification_count?: number;
  pruimalnyk?: string;
}

function isMainPage(): boolean {
  return window.location.pathname.endsWith("/main.html");
}

function getOrCreateContainer(): HTMLElement {
  if (!isMainPage()) {
    throw new Error("act-realtime-container is available only on main.html");
  }

  let container = document.getElementById("act-realtime-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "act-realtime-container";
    document.body.appendChild(container);
  }
  return container;
}

function formatTimeOnly(dateStr?: string): string {
  const date = dateStr ? new Date(dateStr) : new Date();
  return date.toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Перераховує (оновлює) цифри на всіх видимих картках
 * Щоб завжди було по порядку: 1, 2, 3...
 */
function reindexBadges() {
  const container = document.getElementById("act-realtime-container");
  if (!container) return;

  // Знаходимо всі картки, які ще не закриваються
  const toasts = container.querySelectorAll(
    ".act-notification-toast:not(.closing)",
  );

  toasts.forEach((toast, index) => {
    const badge = toast.querySelector(".notification-count-badge");
    if (badge) {
      // Перша картка = 1, друга = 2 і т.д.
      badge.textContent = (index + 1).toString();
    }
  });
}

export function showRealtimeActNotification(
  payload: ActNotificationPayload,
): void {
  if (!isMainPage()) return;

  const container = getOrCreateContainer();

  const isAdded = payload.dodav_vudaluv;
  const icon = isAdded ? "✅" : "❌";
  const actionText = isAdded ? "Додано" : "Видалено";
  const typeClass = isAdded ? "type-added" : "type-deleted";
  const timeString = formatTimeOnly(payload.created_at);

  const toast = document.createElement("div");
  toast.className = `act-notification-toast ${typeClass}`;

  toast.innerHTML = `
    <div class="toast-header-row">
       <div class="header-left">
         <span class="act-id">Акт №${payload.act_id}</span>
         <span class="status-text">${actionText}</span>
         ${payload.pruimalnyk ? `<span class="receiver-name">→ ${payload.pruimalnyk}</span>` : ""}
       </div>
       <div class="notification-count-badge">...</div>
    </div>

    <div class="toast-meta-row">
       <span class="meta-time-oval">${timeString}</span>
       <span class="user-surname">${payload.changed_by_surname || "Невідомо"}</span>
    </div>

    <div class="toast-body-row">
      <span class="item-icon">${icon}</span>
      <span class="item-name">${payload.item_name}</span>
    </div>
  `;

  // ВАЖЛИВО: appendChild() додає В КІНЕЦЬ (знизу через column-reverse)
  container.appendChild(toast);

  // Чекаємо, поки DOM оновиться
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("show");
      reindexBadges(); // Перераховуємо після додавання
    });
  });

  const closeToast = (e?: Event) => {
    if (e) e.stopPropagation();

    // Додаємо клас для анімації виходу
    toast.classList.add("closing");

    // Одразу перераховуємо решту (ігноруючи .closing)
    requestAnimationFrame(() => {
      reindexBadges();
    });

    // Чекаємо завершення анімації
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
        // Перераховуємо ще раз після видалення
        requestAnimationFrame(() => {
          reindexBadges();
        });
      }
    }, 450);
  };

  // Обробник кліку на номер акту для його відкриття
  const actIdElement = toast.querySelector(".act-id");
  if (actIdElement) {
    actIdElement.addEventListener("click", async (e) => {
      e.stopPropagation(); // Запобігаємо закриттю toast

      // Динамічний імпорт функції showModal
      const { showModal } = await import("../zakaz_naraudy/modalMain");

      // Відкриваємо акт
      await showModal(payload.act_id);
    });
  }

  toast.addEventListener("click", closeToast);
  playNotificationSound(isAdded);
}

let _notifAudioCtx: AudioContext | null = null;
let _notifUserGesture = false;
// AudioContext створюємо лише при потребі
document.addEventListener(
  "click",
  () => {
    _notifUserGesture = true;
    if (_notifAudioCtx && _notifAudioCtx.state === "suspended") {
      _notifAudioCtx.resume().catch(() => {});
    }
  },
  { once: true },
);

function playNotificationSound(isAdded: boolean) {
  try {
    if (!_notifUserGesture) return;
    // Ліниве створення AudioContext
    if (!_notifAudioCtx) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (Ctx) _notifAudioCtx = new Ctx();
    }
    if (!_notifAudioCtx) return;
    if (_notifAudioCtx.state === "suspended") {
      _notifAudioCtx.resume().catch(() => {
        /* silent */
      });
      return;
    }
    const audioCtx = _notifAudioCtx;
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      isAdded ? 880 : 440,
      audioCtx.currentTime,
    );
    gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.001,
      audioCtx.currentTime + 0.1,
    );
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.1);
  } catch (e) {}
}
