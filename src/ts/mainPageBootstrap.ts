import $ from "jquery";
import moment from "moment";
import { setupSearchWithTableFilter } from "./roboha/tablucya/pochuk";
import { initializeActsSystem, loadActsTable } from "./roboha/tablucya/tablucya";
import {
  logoutFromSystemAndRedirect,
  showLoginModalBeforeTable,
  updateUIBasedOnAccess,
} from "./roboha/tablucya/users";

type DateRangeFilter = "open" | "closed" | "frozen" | "date_range";
type BlockableEvent = {
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
};

const browserWindow = window as typeof window & {
  $?: typeof $;
  jQuery?: typeof $;
  moment?: typeof moment;
  searchHandler?: unknown;
  initializeSystem?: () => void;
  logoutFromSystemAndRedirect?: typeof logoutFromSystemAndRedirect;
};

let dateRangePluginReady: Promise<void> | null = null;
let authenticationReady: Promise<boolean> | null = null;

/** The planner keeps shared authentication/modals, but has its own data view. */
export function isPlannerPage(): boolean {
  return Boolean(document.getElementById("postSchedulerWrapper")) ||
    /\/planyvannya(?:\.html)?\/?$/i.test(window.location.pathname);
}

function ensureBrowserDateGlobals(): Promise<void> {
  browserWindow.$ = $;
  browserWindow.jQuery = $;
  browserWindow.moment = moment;

  if (!dateRangePluginReady) {
    dateRangePluginReady = import("daterangepicker").then(() => {});
  }

  return dateRangePluginReady;
}

function showAccessDeniedToast(): void {
  const existing = document.querySelector(".access-denied-toast");
  existing?.remove();

  const toast = document.createElement("div");
  toast.className = "access-denied-toast";
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "assertive");
  toast.textContent = "🔒 Будь ласка, увійдіть в систему";
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add("visible"), 10);
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function checkAuthLocal(): boolean {
  const storedData = localStorage.getItem("userAuthData");
  if (!storedData) return false;

  try {
    const parsed = JSON.parse(storedData);
    return !!(parsed.Name && parsed.Доступ);
  } catch {
    return false;
  }
}

function blockActionIfNoAuth(e: BlockableEvent): boolean {
  if (checkAuthLocal()) return false;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  showAccessDeniedToast();
  return true;
}

function updateMenuVisibility(isVisible: boolean): void {
  const menu = document.getElementById("menu-items-to-hide");
  if (menu) {
    menu.style.display = isVisible ? "flex" : "none";
  }
}

function updateUserInfoDisplay(): void {
  try {
    const storedData = localStorage.getItem("userAuthData");
    if (!storedData) return;

    const userData = JSON.parse(storedData);
    const userInfoDiv = document.getElementById("userInfoBlock");
    const userSurnameElement = document.querySelector(".user-surname");
    const userAccessElement = document.querySelector(".user-access");

    if (userSurnameElement) userSurnameElement.textContent = userData.Name;
    if (userAccessElement) userAccessElement.textContent = userData.Доступ;
    if (userInfoDiv) userInfoDiv.style.display = "flex";
  } catch (error) {
    console.error(error);
  }
}

function setupBlockers(): void {
  $("#searchInput").on("focus click keydown", function (e) {
    if (blockActionIfNoAuth(e)) {
      $(this).blur();
    }
  });

  $("#dateRangePicker").on("show.daterangepicker", function (e, picker) {
    if (!checkAuthLocal()) {
      picker?.hide?.();
      e.preventDefault();
      showAccessDeniedToast();
    }
  });

  $("#dateRangePicker").on("click focus", function (e) {
    if (blockActionIfNoAuth(e)) {
      $(this).blur();
    }
  });
}

export async function initializeSystem(): Promise<void> {
  // Accounting has its own authentication/bootstrap and no main act table.
  if (document.querySelector(".Bukhhalter-container")) return;
  await ensureBrowserDateGlobals();

  if (isPlannerPage()) {
    // Settings and planner subscriptions are initialized by the planner itself.
    // Keep shared controls without loading the hidden act list, its counters,
    // notifications or global act-presence subscriptions.
    updateMenuVisibility(true);
    return;
  }

  let currentFilterType: DateRangeFilter = "open";

  setupBlockers();

  $(document).on("click", function (e) {
    if (!$(e.target).closest(".search-container").length) {
      const input = $("#searchInput");
      if (input.hasClass("active") && input.val() === "") {
        input.removeClass("active");
      }
    }
  });

  $("#dateRangePicker").daterangepicker(
    {
      locale: {
        format: "DD.MM.YYYY",
        separator: " - ",
        applyLabel: "Прийняти",
        cancelLabel: "Відмінити",
        fromLabel: "Від",
        toLabel: "До",
        weekLabel: "Тиж",
        daysOfWeek: ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"],
        monthNames: [
          "Січень",
          "Лютий",
          "Березень",
          "Квітень",
          "Травень",
          "Червень",
          "Липень",
          "Серпень",
          "Вересень",
          "Жовтень",
          "Листопад",
          "Грудень",
        ],
        firstDay: 1,
      },
      opens: "center",
      alwaysShowCalendars: true,
      autoUpdateInput: false,
      startDate: moment().startOf("year"),
      endDate: moment(),
      ranges: {
        Відкриті: [moment().startOf("year"), moment()],
        Закриті: [moment("02.01.2025", "DD.MM.YYYY"), moment()],
        "Заморожені акти ❄️": [moment().startOf("year"), moment()],
        "Від початку": [moment("03.01.2025", "DD.MM.YYYY"), moment()],
        Сьогодні: [moment(), moment()],
        "Останні 7 днів": [moment().subtract(6, "days"), moment()],
        "Поточний місяць": [moment().startOf("month"), moment().endOf("month")],
        "Минулий місяць": [
          moment().subtract(1, "month").startOf("month"),
          moment().subtract(1, "month").endOf("month"),
        ],
      },
      showCustomRangeLabel: false,
    },
    function (start, end, label) {
      if (label === "Відкриті") {
        this.setStartDate(moment().startOf("year"));
        this.setEndDate(moment());
      } else if (label === "Закриті") {
        this.setStartDate(moment("02.01.2025", "DD.MM.YYYY"));
        this.setEndDate(moment());
      } else if (label === "Заморожені акти ❄️") {
        this.setStartDate(moment("02.01.2025", "DD.MM.YYYY"));
        this.setEndDate(moment());
      } else {
        const formatted = `${start.format("DD.MM.YYYY")} - ${end.format("DD.MM.YYYY")}`;
        $("#dateRangePicker").val(formatted);
        $("#dateRangePicker")
          .data("daterangepicker")
          ?.element?.addClass("active-range");
        currentFilterType = "date_range";
        loadActsTable(
          start.format("YYYY-MM-DD 00:00:00"),
          end.format("YYYY-MM-DD 23:59:59"),
          null,
        );
      }
    },
  );

  $(document).on("click", ".daterangepicker .ranges li", function () {
    const label = $(this).attr("data-range-key");
    const dp = $("#dateRangePicker").data("daterangepicker");
    if (!dp) return;

    $(this).siblings().removeClass("active");
    $(this).addClass("active");

    if (label === "Відкриті") {
      $("#dateRangePicker").val("Відкриті");
      dp.element.removeClass("active-range");
      currentFilterType = "open";
      loadActsTable(null, null, "open");
      dp.setStartDate(moment().startOf("year"));
      dp.setEndDate(moment());
      dp.hide();
    } else if (label === "Закриті") {
      $("#dateRangePicker").val("Закриті");
      dp.element.removeClass("active-range");
      currentFilterType = "closed";
      loadActsTable(null, null, "closed");
      dp.setStartDate(moment("02.01.2025", "DD.MM.YYYY"));
      dp.setEndDate(moment());
      dp.hide();
    } else if (label === "Заморожені акти ❄️") {
      $("#dateRangePicker").val("Заморожені ❄️");
      dp.element.removeClass("active-range");
      currentFilterType = "frozen";
      loadActsTable(null, null, "frozen");
      dp.setStartDate(moment().startOf("year"));
      dp.setEndDate(moment());
      dp.hide();
    }
  });

  $("#dateRangePicker").on("show.daterangepicker", function () {
    const labelMap: Record<DateRangeFilter, string | null> = {
      open: "Відкриті",
      closed: "Закриті",
      frozen: "Заморожені акти ❄️",
      date_range: null,
    };
    const activeLabel = labelMap[currentFilterType];
    if (!activeLabel) return;

    setTimeout(function () {
      const items = $(".daterangepicker .ranges li");
      items.removeClass("active");
      items.filter(`[data-range-key="${activeLabel}"]`).addClass("active");
    }, 0);
  });

  $("#dateRangePicker").val("Відкриті");
  currentFilterType = "open";
  const picker = $("#dateRangePicker").data("daterangepicker");
  if (picker) {
    picker.setStartDate(moment().startOf("year"));
    picker.setEndDate(moment());
  }

  const searchHandler = setupSearchWithTableFilter(
    loadActsTable,
    () => (currentFilterType === "date_range" ? null : currentFilterType),
    () => ({ dateFrom: null, dateTo: null }),
  );
  browserWindow.searchHandler = searchHandler;

  await initializeActsSystem();
  updateMenuVisibility(true);
}

browserWindow.logoutFromSystemAndRedirect = logoutFromSystemAndRedirect;
browserWindow.initializeSystem = () => {
  initializeSystem().catch((error) => {
    console.error("❌ Помилка ініціалізації системи:", error);
  });
};

document.getElementById("logout-link")?.addEventListener("click", function (e) {
  e.preventDefault();
  browserWindow.logoutFromSystemAndRedirect?.();
});

/**
 * Shared authentication boundary for page-specific bootstrap code. It resolves
 * before initializeSystem, so a planner waiting here cannot wait on itself.
 * Both callers reuse one login/role lookup, including an interactive login.
 */
export function waitForMainAuthentication(): Promise<boolean> {
  if (document.querySelector(".Bukhhalter-container")) return Promise.resolve(false);
  if (!authenticationReady) {
    authenticationReady = (async () => {
      await ensureBrowserDateGlobals();
      const accessLevel = await showLoginModalBeforeTable();
      if (!accessLevel) {
        console.error("❌ Вхід не вдалося здійснити.");
        return false;
      }
      await updateUIBasedOnAccess(accessLevel);
      updateUserInfoDisplay();
      return true;
    })().catch((error) => {
      console.error("❌ Помилка авторизації сторінки:", error);
      return false;
    });
  }
  return authenticationReady;
}

export async function startAuthenticationAndInit(): Promise<void> {
  if (await waitForMainAuthentication()) await initializeSystem();
}
