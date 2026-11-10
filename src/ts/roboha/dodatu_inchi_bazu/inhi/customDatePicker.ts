/**
 * Кастомний DatePicker для input[type="date"] з класом cell-input-Excel
 * Відображає календар при кліку на поле дати
 */

// Українські назви місяців і днів
const MONTHS_UA = [
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
];

const WEEKDAYS_UA = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

let currentDatePicker: HTMLElement | null = null;
let currentOverlay: HTMLElement | null = null;
let currentInput: HTMLInputElement | null = null;
let displayedMonth: number = 0;
let displayedYear: number = 0;

/**
 * Ініціалізує кастомний DatePicker для всіх input[type="date"] з класом cell-input-Excel
 */
export function initCustomDatePicker(container?: HTMLElement): void {
  const root = container || document;
  const dateInputs = root.querySelectorAll<HTMLInputElement>(
    'input.cell-input-Excel[type="date"]',
  );

  dateInputs.forEach((input) => {
    // Вимикаємо нативний календар повністю
    input.addEventListener("mousedown", handleDateInputMouseDown);
    input.addEventListener("click", handleDateInputClick);
    input.addEventListener("focus", handleDateInputFocus);
    input.addEventListener("keydown", handleDateInputKeydown);
    // Блокуємо відкриття нативного календаря
    input.setAttribute("readonly", "readonly");
  });
}

/**
 * Видаляє обробники DatePicker
 */
export function destroyCustomDatePicker(container?: HTMLElement): void {
  const root = container || document;
  const dateInputs = root.querySelectorAll<HTMLInputElement>(
    'input.cell-input-Excel[type="date"]',
  );

  dateInputs.forEach((input) => {
    input.removeEventListener("mousedown", handleDateInputMouseDown);
    input.removeEventListener("click", handleDateInputClick);
    input.removeEventListener("focus", handleDateInputFocus);
    input.removeEventListener("keydown", handleDateInputKeydown);
    input.removeAttribute("readonly");
  });

  closeDatePicker();
}

function handleDateInputMouseDown(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

function handleDateInputClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  const input = e.target as HTMLInputElement;
  openDatePicker(input);
}

function handleDateInputFocus(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  const input = e.target as HTMLInputElement;
  openDatePicker(input);
}

function handleDateInputKeydown(e: KeyboardEvent): void {
  // Дозволяємо відкриття календаря через Enter або Space
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const input = e.target as HTMLInputElement;
    openDatePicker(input);
  }
}

function openDatePicker(input: HTMLInputElement): void {
  // Закриваємо попередній, якщо є
  closeDatePicker();

  currentInput = input;

  // Парсимо поточне значення або беремо сьогоднішню дату
  const currentValue = input.value;
  let date: Date;

  if (currentValue) {
    date = new Date(currentValue);
  } else {
    date = new Date();
  }

  displayedMonth = date.getMonth();
  displayedYear = date.getFullYear();

  // Створюємо overlay для закриття при кліку поза календарем
  currentOverlay = document.createElement("div");
  currentOverlay.className = "custom-datepicker-overlay";
  currentOverlay.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDatePicker();
  });
  const popupHost = input.closest("dialog") || document.body;
  popupHost.appendChild(currentOverlay);

  // Створюємо календар
  currentDatePicker = createDatePickerElement();
  // Зупиняємо propagation кліків на календарі, щоб вони не закривали модалку
  currentDatePicker.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  popupHost.appendChild(currentDatePicker);

  // Додатковий обробник на document для закриття при кліку поза календарем
  setTimeout(() => {
    document.addEventListener("click", handleDocumentClick);
  }, 10);

  // Позиціонуємо відносно input
  positionDatePicker(input);

  // Рендеримо дні
  renderDays();
}

function handleDocumentClick(e: MouseEvent): void {
  // Якщо клік не на календарі і не на input - закриваємо
  const target = e.target as HTMLElement;
  if (
    currentDatePicker &&
    !currentDatePicker.contains(target) &&
    currentInput &&
    target !== currentInput
  ) {
    closeDatePicker();
  }
}

function closeDatePicker(): void {
  document.removeEventListener("click", handleDocumentClick);
  if (currentOverlay) {
    currentOverlay.remove();
    currentOverlay = null;
  }
  if (currentDatePicker) {
    currentDatePicker.remove();
    currentDatePicker = null;
  }
  currentInput = null;
}

function createDatePickerElement(): HTMLElement {
  const picker = document.createElement("div");
  picker.className = "custom-datepicker";

  picker.innerHTML = `
    <div class="custom-datepicker-header">
      <div class="custom-datepicker-nav">
        <button type="button" class="custom-datepicker-nav-btn" data-action="prev-year" title="Попередній рік">«</button>
        <button type="button" class="custom-datepicker-nav-btn" data-action="prev-month" title="Попередній місяць">‹</button>
      </div>
      <span class="custom-datepicker-title"></span>
      <div class="custom-datepicker-nav">
        <button type="button" class="custom-datepicker-nav-btn" data-action="next-month" title="Наступний місяць">›</button>
        <button type="button" class="custom-datepicker-nav-btn" data-action="next-year" title="Наступний рік">»</button>
      </div>
    </div>
    <div class="custom-datepicker-weekdays">
      ${WEEKDAYS_UA.map((d) => `<span class="custom-datepicker-weekday">${d}</span>`).join("")}
    </div>
    <div class="custom-datepicker-days"></div>
    <div class="custom-datepicker-footer">
      <button type="button" class="custom-datepicker-clear-btn">Очистити</button>
      <button type="button" class="custom-datepicker-today-btn">Сьогодні</button>
    </div>
  `;

  // Обробники навігації
  picker.querySelectorAll(".custom-datepicker-nav-btn").forEach((btn) => {
    btn.addEventListener("click", handleNavClick);
  });

  // Кнопка "Сьогодні"
  picker
    .querySelector(".custom-datepicker-today-btn")
    ?.addEventListener("click", () => {
      selectDate(new Date());
    });

  // Кнопка "Очистити"
  picker
    .querySelector(".custom-datepicker-clear-btn")
    ?.addEventListener("click", () => {
      if (currentInput) {
        currentInput.value = "";
        // Тригеримо input та change події
        currentInput.dispatchEvent(new Event("input", { bubbles: true }));
        currentInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeDatePicker();
    });

  return picker;
}

function handleNavClick(e: Event): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const action = btn.dataset.action;

  switch (action) {
    case "prev-year":
      displayedYear--;
      break;
    case "prev-month":
      displayedMonth--;
      if (displayedMonth < 0) {
        displayedMonth = 11;
        displayedYear--;
      }
      break;
    case "next-month":
      displayedMonth++;
      if (displayedMonth > 11) {
        displayedMonth = 0;
        displayedYear++;
      }
      break;
    case "next-year":
      displayedYear++;
      break;
  }

  renderDays();
}

function renderDays(): void {
  if (!currentDatePicker) return;

  const title = currentDatePicker.querySelector(".custom-datepicker-title");
  if (title) {
    title.textContent = `${MONTHS_UA[displayedMonth]} ${displayedYear}`;
  }

  const daysContainer = currentDatePicker.querySelector(
    ".custom-datepicker-days",
  );
  if (!daysContainer) return;

  daysContainer.innerHTML = "";

  const today = new Date();
  const selectedDate = currentInput?.value
    ? new Date(currentInput.value)
    : null;

  // Перший день місяця
  const firstDay = new Date(displayedYear, displayedMonth, 1);
  // Останній день місяця
  const lastDay = new Date(displayedYear, displayedMonth + 1, 0);

  // День тижня першого дня (0 = неділя, перетворюємо на 0 = понеділок)
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  // Додаємо порожні клітинки на початку
  for (let i = 0; i < startDay; i++) {
    const emptyBtn = document.createElement("button");
    emptyBtn.type = "button";
    emptyBtn.className = "custom-datepicker-day empty";
    daysContainer.appendChild(emptyBtn);
  }

  // Додаємо дні місяця
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "custom-datepicker-day";
    btn.textContent = day.toString();

    const thisDate = new Date(displayedYear, displayedMonth, day);

    // Перевіряємо чи сьогодні
    if (
      thisDate.getDate() === today.getDate() &&
      thisDate.getMonth() === today.getMonth() &&
      thisDate.getFullYear() === today.getFullYear()
    ) {
      btn.classList.add("today");
    }

    // Перевіряємо чи вибрано
    if (
      selectedDate &&
      thisDate.getDate() === selectedDate.getDate() &&
      thisDate.getMonth() === selectedDate.getMonth() &&
      thisDate.getFullYear() === selectedDate.getFullYear()
    ) {
      btn.classList.add("selected");
    }

    btn.addEventListener("click", () => {
      selectDate(thisDate);
    });

    daysContainer.appendChild(btn);
  }
}

function selectDate(date: Date): void {
  if (!currentInput) return;

  // Форматуємо дату як YYYY-MM-DD
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const formattedDate = `${year}-${month}-${day}`;

  currentInput.value = formattedDate;

  // Тригеримо input та change події
  currentInput.dispatchEvent(new Event("input", { bubbles: true }));
  currentInput.dispatchEvent(new Event("change", { bubbles: true }));

  closeDatePicker();
}

function positionDatePicker(input: HTMLInputElement): void {
  if (!currentDatePicker) return;

  const rect = input.getBoundingClientRect();
  const pickerHeight = 320; // Приблизна висота календаря
  const pickerWidth = 280;

  let top = rect.bottom + 5;
  let left = rect.left;

  // Перевіряємо чи вистачає місця знизу
  if (top + pickerHeight > window.innerHeight) {
    top = rect.top - pickerHeight - 5;
  }

  // Перевіряємо чи вистачає місця справа
  if (left + pickerWidth > window.innerWidth) {
    left = window.innerWidth - pickerWidth - 10;
  }

  // Не виходимо за ліву межу
  if (left < 10) {
    left = 10;
  }

  currentDatePicker.style.top = `${top}px`;
  currentDatePicker.style.left = `${left}px`;
}
