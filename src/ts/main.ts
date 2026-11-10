import { notify as showAppMessage } from "./utils/appDialogs";
import "./roboha/tablucya/tablucya";
import "./roboha/tablucya/perevirka_avtoruzacii";
import { isPlannerPage, startAuthenticationAndInit } from "./mainPageBootstrap";

// 📱 Реєстрація Service Worker для PWA
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => {
        // console.log('SW registered');
      })
      .catch(() => {
        // console.log('SW registration failed');
      });
  });
}
import "./roboha/redahyvatu_klient_machuna/vikno_klient_machuna";
import "./roboha/dodatu_inchi_bazu/dodatu_inchi_bazu_danux";
import "./roboha/nalachtuvannay/nalachtuvannay";
import "./roboha/bukhhalteriya/bukhhalteriya";
import "./roboha/dodatu_inchi_bazu/vikno_pidtverdchennay_inchi_bazu";
import "./roboha/dodatu_inchi_bazu/dodatu_inchi_bazu_danux";
import "./roboha/redahyvatu_klient_machuna/vikno_klient_machuna";
import "./roboha/redahyvatu_klient_machuna/pidtverdutu_sberihannya_zakaz_naryad";
import "./roboha/redahyvatu_klient_machuna/pidtverdutu_sberihannya_PIB_avto";
import "./roboha/zakaz_naraudy/inhi/vikno_vvody_parolu";
import "./roboha/bukhhalteriya/prubutok";
import "./roboha/zakaz_naraudy/inhi/fakturaRaxunok";
import "./roboha/zakaz_naraudy/inhi/fakturaAct";
import "./roboha/zakaz_naraudy/inhi/act_change_tracker";
import "./roboha/zakaz_naraudy/inhi/act_changes_highlighter";
import "./roboha/zakaz_naraudy/inhi/act_notifications";
import "./roboha/tablucya/povidomlennya_tablucya";
import "./roboha/zakaz_naraudy/inhi/act_realtime_subscription";
import "./roboha/zakaz_naraudy/inhi/settings_realtime_init";
import "./vxid/url_obfuscator";
import "./roboha/planyvannya/planyvannya";
import "./roboha/planyvannya/planyvannya_post";
import { initScrollToTopButton } from "./utils/scrollToTopButton";
import { initMenuTooltips } from "./utils/menuTooltips";

initScrollToTopButton();
initMenuTooltips();

// 📖 Service Book — Сервісна книжка авто
import { openServiceBook } from "./roboha/service_book/serviceBook";

// Глобальний обробник для кнопки Service Book в меню
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest('[data-action="openNovaPoshta"]')) {
    e.preventDefault();
    import("./roboha/novaPoshta/ui")
      .then(({ openNovaPoshta }) => openNovaPoshta())
      .catch(() => showAppMessage("Не вдалося відкрити Нову пошту. Оновіть сторінку й повторіть."));
  }
  if (target?.closest('[data-action="openServiceBook"]')) {
    e.preventDefault();
    openServiceBook();
  }
});

// 🤖 AI Chat — ініціалізація кнопки в меню (якщо aiChatEnabled = true)
import { initAIChatButton } from "./roboha/ai/aiChat";

// 💡 initAIChatButton() викликається в initializeActsSystem() після завантаження налаштувань.
// Додатковий fallback на випадок повільної мережі:
setTimeout(() => {
  initAIChatButton();
}, 5000);

// 🔔 Перевірка нагадувань Атласа (черга адресата + Realtime, без браузерного polling)
import {
  initReminderChecker,
  setOnRemindersTriggered,
} from "./roboha/ai/aiReminderChecker";
import { initPlannerTab } from "./roboha/ai/aiPlanner";

// Запускаємо після повної ініціалізації всіх модулів
setTimeout(() => {
  initReminderChecker();

  // Коли нагадування спрацювало — оновити UI планувальника (якщо відкритий)
  setOnRemindersTriggered(() => {
    const plannerPanel = document.querySelector(
      "#ai-panel-planner",
    ) as HTMLElement | null;
    if (plannerPanel && !plannerPanel.classList.contains("hidden")) {
      initPlannerTab(plannerPanel);
    }
  });
}, 4000);

// 📵 Offline-режим для слюсарів: IndexedDB + автосинхронізація
import { initOfflineSync } from "./roboha/offline/offlineSync";

setTimeout(() => {
  if (!document.querySelector(".Bukhhalter-container")) {
    // Pending edits still replay on the planner; its calendar does not need a
    // background download of the main page's six-table offline snapshot.
    initOfflineSync({ warmSnapshot: !isPlannerPage() });
  }
}, 3000);

startAuthenticationAndInit().catch((error) => {
  console.error("❌ Помилка старту головної сторінки:", error);
});
