import { notify as showAppMessage } from "../../utils/appDialogs";
// src\ts\roboha\dodatu_inchi_bazu\dodatu_inchi_bazu_danux.ts

import { supabase } from "../../vxid/supabaseClient";
import { canUserSeeEmployeeButton } from "../tablucya/users";
import {
  showSavePromptModal,
  createSavePromptModal,
  savePromptModalId,
  isOtherBasesSavePending,
} from "./vikno_pidtverdchennay_inchi_bazu";
import {
  initScladMagasunDetal,
  handleScladClick,
  resetScladFormSession,
} from "./inhi/scladMagasunDetal";
import { initRobota, handleRobotaClick } from "./inhi/robota";
import { initSlusar, handleSlusarClick } from "./inhi/slusar";
import { initPruimalnik, handlePruimalnikClick } from "./inhi/pruimalnuk";
import { initDherelo, handleDhereloClick } from "./inhi/djerelo";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

// Змінні для експорту
export let all_bd: string | null = null;
export let CRUD: string = "";

// Функція для оновлення all_bd
export const updateAllBd = (newValue: string | null) => {
  all_bd = newValue;
};

// Функція для оновлення CRUD режиму
export const updateCRUD = (newMode: string) => {
  CRUD = newMode;
  const mode = document.getElementById("modeToggleLabel");
  if (mode) {
    mode.textContent = newMode;
    mode.style.color = ({ Додати: "green", Редагувати: "orange", Видалити: "crimson" } as Record<string, string>)[newMode] || "";
  }
};

// Функція для оновлення відображення назви таблиці в інтерфейсі
export const updateTableNameDisplay = (
  buttonText: string,
  tableName: string
) => {
  const tableNameElement = document.getElementById("current-table-name");
  if (tableNameElement) {
    tableNameElement.textContent = `Поточна таблиця: ${buttonText} (${tableName})`;
  }
};

// Функція для очищення всіх даних
// Функція для очищення всіх даних
export const clearAllData = () => {
  resetScladFormSession();
  let searchInput = document.getElementById(
    "search-input-all_other_bases"
  ) as HTMLInputElement;

  if (searchInput) {
    // 🔥 РЕШЕТО: Клонуємо елемент, щоб видалити ВСІ старі event listeners
    const newSearchInput = searchInput.cloneNode(true) as HTMLInputElement;
    delete newSearchInput.dataset.keyboardNavBound;
    searchInput.parentNode?.replaceChild(newSearchInput, searchInput);
    searchInput = newSearchInput;
    searchInput.value = "";
    searchInput.disabled = false;
    searchInput.readOnly = false;
    searchInput.title = "";
    searchInput.style.backgroundColor = "";
    searchInput.style.cursor = "";
  }

  const dropdown = document.getElementById(
    "custom-dropdown-all_other_bases"
  ) as HTMLDivElement;
  if (dropdown) {
    dropdown.innerHTML = "";
    dropdown.classList.add("hidden-all_other_bases");
  }
  document.getElementById("sclad-form")?.replaceChildren();

  // Очищуємо додаткові інпути підлеглі при зміні таблиці
  const slusarInputs = document.getElementById("slusar-additional-inputs");
  if (slusarInputs) {
    slusarInputs.remove();
  }

  // Очищуємо форму контрагентів
  const contragentForm = document.getElementById("contragent-form");
  if (contragentForm) {
    contragentForm.remove();
  }

  // Видаляємо всі календарі контрагентів
  document.querySelectorAll(".contragent-calendar").forEach((cal) => {
    cal.remove();
  });

  // Видаляємо всі dropdown-и контрагентів
  document.querySelectorAll(".contragent-dropdown").forEach((dropdown) => {
    dropdown.remove();
  });

  all_bd = null;
};

document.addEventListener("DOMContentLoaded", () => {
  const existing = document.getElementById(savePromptModalId);
  if (!existing) {
    const modal = createSavePromptModal();
    document.body.appendChild(modal);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  let modalRevision = 0;
  let sectionRequest = 0;
  document.addEventListener("sto:other-bases-closed", () => {
    modalRevision++;
    sectionRequest++;
    readySection = null;
    pendingSection = null;
    clearAllData();
    setSectionLoading(false);
  });
  const closeAllModals = () => {
    if (isOtherBasesSavePending()) return;
    document
      .querySelectorAll(".modal-overlay-all_other_bases")
      .forEach((modal) => modal.classList.add("hidden-all_other_bases"));
    document.dispatchEvent(new CustomEvent("sto:other-bases-closed"));
  };
  /*<button class="toggle-button-all_other_bases">Приймальник</button>*/
  const modal_all_other_bases = document.createElement("div");
  modal_all_other_bases.className =
    "modal-overlay-all_other_bases hidden-all_other_bases";
  modal_all_other_bases.innerHTML = `
    <div class="modal-all_other_bases">
      <button class="modal-close-all_other_bases">×</button>
      <div class="modal-content-all_other_bases">
        <div class="modal-left-all_other_bases">
          <button class="toggle-button-all_other_bases">Склад</button>
          <button class="toggle-button-all_other_bases">Робота</button>
          <button class="toggle-button-all_other_bases">Співробітники</button>
          <div class="directory-navigation-divider" aria-hidden="true"></div>
          <button class="toggle-button-all_other_bases">Контрагент</button>
          <button class="toggle-button-all_other_bases">Джерело</button>
        </div>
        <div class="modal-right-all_other_bases">
          <div class="right-header">
            <label for="search-input-all_other_bases" class="label-all_other_bases">Введіть дані для пошуку</label>
            <button id="modeToggleLabel" class="mode-toggle-btn mode--edit" style="cursor: pointer;" type="button">Додати</button>
          </div>
          <div id="global-search-wrap" style="position: relative; width: 100%;">
            <input type="text" id="search-input-all_other_bases" class="input-all_other_bases" autocomplete="off" />
            <div id="custom-dropdown-all_other_bases" class="custom-dropdown hidden-all_other_bases"></div>
          </div>
          <div id="sclad-form" class="hidden-all_other_bases"></div>
          <div class="yes-no-buttons-all_other_bases">
            <button id="import-excel-btn" class="batch-btn-Excel import-Excel hidden-all_other_bases" style="margin-right: 10px;">💾 Записати деталі</button>
            <button id="export-works-excel-btn" class="batch-btn-Excel export-Excel hidden-all_other_bases" style="margin-right: 10px;">📤 Вивантажити роботи</button>
            <button class="yes-button-all_other_bases">Ок</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal_all_other_bases);

  let readySection: HTMLButtonElement | null = null;
  let pendingSection: HTMLButtonElement | null = null;
  const rightPanel = modal_all_other_bases.querySelector<HTMLElement>(".modal-right-all_other_bases");
  const actorScope = () => localStorage.getItem("userAuthData") || "";
  const setSectionLoading = (loading: boolean) => {
    modal_all_other_bases.dataset.otherBasesLoading = String(loading);
    modal_all_other_bases.dataset.otherBasesReady = String(!loading && !!readySection);
    if (rightPanel) rightPanel.inert = loading;
    const submit = modal_all_other_bases.querySelector<HTMLButtonElement>(".yes-button-all_other_bases");
    if (submit) submit.disabled = loading || !readySection;
  };

  const yesButton = modal_all_other_bases.querySelector(
    ".yes-button-all_other_bases"
  ) as HTMLButtonElement;

  if (yesButton) {
    yesButton.addEventListener("click", async () => {
      if (modal_all_other_bases.dataset.otherBasesReady !== "true") return;
      try {
        // ✅ ЗАХИСТ: Перевірка перед відкриттям модального вікна
        if (CRUD === "Видалити" && all_bd) {
          try {
            const data = JSON.parse(all_bd);
            if (data.table === "slyusars" && data.slyusar_id === 1) {
              showNotification(
                "Видалення адміністраторського акаунту заборонено!",
                "error"
              );
              return; // Не відкриваємо модальне вікно
            }
          } catch (e) {
            // console.error("Помилка при перевірці all_bd:", e);
          }
        }

        const confirmed = await showSavePromptModal();
        if (confirmed) {
          // Логіка при підтвердженні
        }
      } catch (error) {
        showNotification(error instanceof Error ? error.message : "Не вдалося відкрити підтвердження. Повторіть дію.", "error");
      }
    });
  }

  const closeModalBtn = modal_all_other_bases.querySelector(
    ".modal-close-all_other_bases"
  ) as HTMLButtonElement;
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      if (isOtherBasesSavePending()) return;
      closeAllModals();
      
      // ✅ ЗАХИСТ: Перевіряємо, що таблиця актів залишилася після закриття модалки
      setTimeout(() => {
        const tableContainer = document.getElementById("table-container-modal-sakaz_narad");
        if (tableContainer && !tableContainer.querySelector("table")) {
          // console.error("❌ Таблиця актів зникла після закриття модалки!");
          // Можна додати логіку відновлення таблиці, якщо потрібно
        }
      }, 100);
    });
  }

  // ВИПРАВЛЕННЯ: Додаємо обробник закриття модального вікна при кліку поза ним
  /*   modal_all_other_bases.addEventListener("click", (e) => {
    if (e.target === modal_all_other_bases) {
      closeAllModals();
    }
  }); */
  
  // ✅ ЗАХИСТ: Спостерігаємо за змінами стану модалки через MutationObserver
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const isHidden = modal_all_other_bases.classList.contains('hidden-all_other_bases');
        if (isHidden) {
          // Модалка закрита - перевіряємо, що таблиця видима
          setTimeout(() => {
            const tableContainer = document.getElementById("table-container-modal-sakaz_narad");
            if (tableContainer) {
              const table = tableContainer.querySelector("table");
              if (!table) {
                // console.warn("⚠️ Таблиця актів зникла після закриття модалки!");
              } else {
                // Переконуємося, що таблиця видима
                tableContainer.style.display = '';
                tableContainer.style.visibility = '';
                tableContainer.style.opacity = '';
              }
            }
          }, 50);
        }
      }
    });
  });
  
  observer.observe(modal_all_other_bases, {
    attributes: true,
    attributeFilter: ['class']
  });

  // Ініціалізуємо всі модулі
  initScladMagasunDetal();
  initRobota();
  initSlusar();
  initPruimalnik();
  initDherelo();

  const toggleButtons = modal_all_other_bases.querySelectorAll(
    ".toggle-button-all_other_bases"
  );

  // Функція для показу/приховування кнопки імпорту
  const toggleImportButton = (show: boolean) => {
    const importExcelBtn = document.getElementById("import-excel-btn");
    if (importExcelBtn) {
      importExcelBtn.style.display = "";
      if (show) {
        importExcelBtn.classList.remove("hidden-all_other_bases");
      } else {
        importExcelBtn.classList.add("hidden-all_other_bases");
      }
    }
  };

  // Функція для показу/приховування кнопки експорту робіт
  const toggleExportWorksButton = (show: boolean) => {
    const exportBtn = document.getElementById("export-works-excel-btn");
    if (exportBtn) {
      exportBtn.style.display = "";
      if (show) {
        exportBtn.classList.remove("hidden-all_other_bases");
      } else {
        exportBtn.classList.add("hidden-all_other_bases");
      }
    }
  };

  // Обробник експорту робіт
  const exportWorksBtnRef = modal_all_other_bases.querySelector(
    "#export-works-excel-btn"
  );
  if (exportWorksBtnRef) {
    let exporting = false;
    exportWorksBtnRef.addEventListener("click", async () => {
      if (exporting || isOtherBasesSavePending() || modal_all_other_bases.dataset.otherBasesReady !== "true") return;
      const exportActor = actorScope(), exportRevision = modalRevision;
      const exportCurrent = () => exportActor === actorScope() && exportRevision === modalRevision &&
        !modal_all_other_bases.classList.contains("hidden-all_other_bases");
      exporting = true;
      (exportWorksBtnRef as HTMLButtonElement).disabled = true;
      try {
        let allData: any[] = [];
        let from = 0;
        const step = 1000;
        let keepFetching = true;

        // 1. Fetch ALL data using pagination
        while (keepFetching) {
          const { data, error } = await supabase
            .from("works")
            .select("work_id, data")
            .order("work_id", { ascending: true })
            .range(from, from + step - 1);

          if (!exportCurrent()) return;
          if (error) throw error;

          if (data && data.length > 0) {
            allData = [...allData, ...data];
            if (data.length < step) {
              keepFetching = false;
            } else {
              from += step;
            }
          } else {
            keepFetching = false;
          }
        }

        if (allData.length === 0) {
          showAppMessage("Немає даних для експорту");
          return;
        }

        // 2. Generate HTML-based Excel (.xls)
        let tableRows = "";
        allData.forEach((row) => {
          const id = row.work_id || "";
          // Escape HTML special chars in data to prevent broken layout
          const rawData = String(row.data || "");
          const desc = rawData
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

          tableRows += `<tr><td>${id}</td><td>${desc}</td></tr>`;
        });

        const excelTemplate = `
          <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
          <head>
            <meta charset="UTF-8">
            <!--[if gte mso 9]>
            <xml>
              <x:ExcelWorkbook>
                <x:ExcelWorksheets>
                  <x:ExcelWorksheet>
                    <x:Name>Works</x:Name>
                    <x:WorksheetOptions>
                      <x:DisplayGridlines/>
                    </x:WorksheetOptions>
                  </x:ExcelWorksheet>
                </x:ExcelWorksheets>
              </x:ExcelWorkbook>
            </xml>
            <![endif]-->
            <style>
              table { border-collapse: collapse; width: 100%; }
              th, td { border: 1px solid #000000; padding: 5px; text-align: left; vertical-align: top; }
            </style>
          </head>
          <body>
            <table>
              <thead>
                <tr>
                  <th style="background-color: #f0f0f0; font-weight: bold;">№</th>
                  <th style="background-color: #f0f0f0; font-weight: bold;">Опис</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
          </body>
          </html>
        `;

        const blob = new Blob([excelTemplate], {
          type: "application/vnd.ms-excel",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", "robots_base.xls"); // Saving as .xls
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (error: any) {
        // console.error("Помилка експорту:", error);
        showAppMessage("Помилка при експорті: " + error.message);
      } finally {
        exporting = false;
        (exportWorksBtnRef as HTMLButtonElement).disabled = false;
      }
    });
  }

  const selectSection = async (button: HTMLButtonElement, force = false) => {
    if (isOtherBasesSavePending() || button.style.display === "none" ||
        modal_all_other_bases.classList.contains("hidden-all_other_bases")) return;
    if (!force && actorScope() === modal_all_other_bases.dataset.otherBasesActor &&
        (pendingSection === button || readySection === button)) return;
    const request = ++sectionRequest;
    const revision = modalRevision;
    const actor = actorScope();
    const current = () => request === sectionRequest && revision === modalRevision && actor === actorScope() &&
      !modal_all_other_bases.classList.contains("hidden-all_other_bases");
    pendingSection = button;
    readySection = null;
    modal_all_other_bases.dataset.otherBasesActor = actor;
    setSectionLoading(true);
    // Invalidate the previous form before awaiting auth/module setup. Its late
    // lookups cannot replace the new section's draft or open confirmation.
    clearAllData();
    toggleButtons.forEach(btn => btn.classList.remove("active-all_other_bases"));
    button.classList.add("active-all_other_bases");
    const buttonText = button.textContent?.trim() || "";
    toggleImportButton(buttonText === "Склад");
    toggleExportWorksButton(buttonText === "Робота");
    const modeButton = document.getElementById("modeToggleLabel") as HTMLButtonElement | null;
    if (modeButton) { modeButton.disabled = false; modeButton.style.cursor = "pointer"; }
    updateCRUD(CRUD);
    const scladForm = document.getElementById("sclad-form");
    const globalSearchWrap = document.getElementById("global-search-wrap");
    scladForm?.classList.add("hidden-all_other_bases");
    globalSearchWrap?.classList.remove("hidden-all_other_bases");
    const tableMap: Record<string, string> = {
      Склад: "sclad", Робота: "works", Співробітники: "slyusars",
      Приймальник: "receivers", Джерело: "incomes", Контрагент: "faktura",
    };
    document.dispatchEvent(new CustomEvent("table-changed", { detail: { table: tableMap[buttonText] || buttonText } }));
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!current()) return;
      if (!session) {
        showAppMessage("⛔ Доступ заблоковано , Ви не авторизовані");
        return;
      }
      switch (buttonText) {
        case "Склад": {
          if (globalSearchWrap)
            globalSearchWrap.classList.add("hidden-all_other_bases");
          await handleScladClick();
          break;
        }
        case "Робота": {
          await handleRobotaClick();
          break;
        }
        case "Співробітники": {
          await handleSlusarClick();
          break;
        }
        case "Приймальник": {
          await handlePruimalnikClick();
          break;
        }
        case "Джерело": {
          await handleDhereloClick();
          break;
        }
        case "Контрагент": {
          const { handleDhereloContragent } = await import("./inhi/contragent");
          if (!current()) return;
          await handleDhereloContragent();
          break;
        }
      }
      if (current()) readySection = button;
    } catch (error) {
      if (current()) showNotification(error instanceof Error ? error.message : "Не вдалося відкрити розділ. Натисніть його ще раз.", "error");
    } finally {
      if (request === sectionRequest && revision === modalRevision) {
        pendingSection = null;
        setSectionLoading(false);
      }
    }
  };
  toggleButtons.forEach((button) => {
    button.classList.add("inactive-all_other_bases");
    button.addEventListener("click", () => { void selectSection(button as HTMLButtonElement); });
  });

  document.addEventListener("reload-active-other-base-section", () => {
    const activeButton = modal_all_other_bases.querySelector(
      ".toggle-button-all_other_bases.active-all_other_bases",
    ) as HTMLButtonElement | null;

    if (activeButton) {
      void selectSection(activeButton, true);
    }
  });

  // Both the menu and the act's shortcut can reopen the retained modal.
  document.addEventListener("sto:other-bases-opened", async () => {
    const revision = ++modalRevision;
    const request = ++sectionRequest;
    const actor = actorScope();
    readySection = null;
    pendingSection = null;
    modal_all_other_bases.dataset.otherBasesActor = actor;
    setSectionLoading(true);
    clearAllData();
    const employeeButton = Array.from(
      modal_all_other_bases.querySelectorAll<HTMLButtonElement>(".toggle-button-all_other_bases"),
    ).find(button => button.textContent?.trim() === "Співробітники");
    if (employeeButton) employeeButton.style.display = "none";
    try {
      const canSeeEmployeeButton = await canUserSeeEmployeeButton();
      if (revision !== modalRevision || actor !== actorScope() || modal_all_other_bases.classList.contains("hidden-all_other_bases")) return;
      if (employeeButton) employeeButton.style.display = canSeeEmployeeButton ? "" : "none";
      if (request !== sectionRequest) return;
      const active = modal_all_other_bases.querySelector<HTMLButtonElement>(".toggle-button-all_other_bases.active-all_other_bases");
      if (active) {
        const target = active.style.display === "none"
          ? Array.from(toggleButtons).find(button => button.textContent?.trim() === "Склад") as HTMLButtonElement | undefined
          : active;
        if (target) await selectSection(target, true);
      }
    } catch (error) {
      if (revision === modalRevision && actor === actorScope()) showNotification(error instanceof Error ? error.message : "Не вдалося перевірити доступ до співробітників. Повторно відкрийте вікно.", "error");
    } finally {
      if (request === sectionRequest && revision === modalRevision) setSectionLoading(false);
    }
  });

  // ВИПРАВЛЕННЯ: Модальне вікно відкривається тільки при кліку на меню, а не автоматично
  document
    .querySelectorAll('.menu-link.all_other_bases[data-action="openClient"]')
    .forEach((link) => {
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (isOtherBasesSavePending()) return;

        if (!modal_all_other_bases.classList.contains("hidden-all_other_bases") &&
            modal_all_other_bases.dataset.otherBasesActor === actorScope()) return;

        // 1. ДОДАНО ПЕРЕВІРКУ АВТОРИЗАЦІЇ
        const revision = modalRevision;
        const actor = actorScope();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (revision !== modalRevision || actor !== actorScope()) return;

        if (!session) {
          // console.warn(
            // "⛔ Користувач не авторизований. Модальне вікно 'Додати' не відкривається."
          // );
          return; // Зупиняємо виконання, модалка не відкриється
        }

        closeAllModals();
        
        // ✅ ЗАХИСТ: Перевіряємо, що таблиця актів не зникла
        const tableContainer = document.getElementById("table-container-modal-sakaz_narad");
        if (tableContainer && !tableContainer.querySelector("table")) {
          // console.warn("⚠️ Таблиця актів зникла! Спробуємо відновити...");
          // Можна додати логіку відновлення таблиці, якщо потрібно
        }
        
        showModalAllOtherBases();
      });
    });

  // Режими роботи
  const modeLabel = document.getElementById("modeToggleLabel") as HTMLElement;
  const modes = ["Додати", "Редагувати", "Видалити"] as const;

  // Перевірка чи користувач адміністратор
  const userDataString = localStorage.getItem("userAuthData");
  let isUserAdmin = false;
  if (userDataString) {
    try {
      const userData = JSON.parse(userDataString);
      isUserAdmin = userData.Доступ === "Адміністратор";
    } catch (e) {
      // console.error("Помилка парсингу userAuthData:", e);
    }
  }

  // Якщо не адмін - автоматично встановлюємо режим "Редагувати"
  updateCRUD(isUserAdmin ? "Додати" : "Редагувати");

  const handleModeSwitch = () => {
    if (isOtherBasesSavePending() || modal_all_other_bases.dataset.otherBasesLoading === "true" ||
        (modeLabel as HTMLButtonElement)?.disabled) return;
    const modeIndex = modes.indexOf(CRUD as typeof modes[number]);
    updateCRUD(modes[(modeIndex + 1) % modes.length]);
  };

  if (modeLabel) {
    modeLabel.addEventListener("click", handleModeSwitch);
  }
});

export function showModalAllOtherBases() {
  if (isOtherBasesSavePending()) return;
  const modal = document.querySelector(
    ".modal-overlay-all_other_bases"
  ) as HTMLElement;
  if (modal) {
    const wasHidden = modal.classList.contains("hidden-all_other_bases");
    modal.classList.remove("hidden-all_other_bases");
    if (wasHidden || modal.dataset.otherBasesActor !== (localStorage.getItem("userAuthData") || "")) {
      document.dispatchEvent(new CustomEvent("sto:other-bases-opened"));
    }
  }
}
