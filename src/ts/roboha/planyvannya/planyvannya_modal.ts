//src\ts\roboha\planyvannya\planyvannya_modal.ts

import "../../../scss/robocha/planyvannya/_planyvannya_modal.scss";
import { supabase } from "../../vxid/supabaseClient";
import {
  showModalCreateSakazNarad,
  fillSelectedClientCar,
  setTransferredActComment,
} from "../redahyvatu_klient_machuna/vikno_klient_machuna";
import { showSaveModalCreate } from "../redahyvatu_klient_machuna/pidtverdutu_sberihannya_zakaz_naryad";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import autoData from "../redahyvatu_klient_machuna/auto.json";
import { createClientFormOptions } from "../redahyvatu_klient_machuna/clientFormOptions";
import { mountPlannerDropdown } from "./plannerDropdown";
import { getPlannerRecord } from "./plannerRecordStore";

export interface ReservationData {
  date: string;
  startTime: string;
  endTime: string;
  clientId: number | null;
  clientName: string;
  clientPhone: string;
  carId: number | null;
  carModel: string;
  carNumber: string;
  comment: string;
  status: string;
  slyusarId?: number | null;
  namePost?: number | null;
  postArxivId?: number | null;
  actId?: number | null;
  baselineRecord?: Record<string, any>;
}

interface ClientData {
  client_id: number;
  name: string;
  phones: string[];
}

interface CarData {
  cars_id: number;
  client_id: number;
  model: string;
  number: string;
}

export class PlanyvannyaModal {
  private modalOverlay: HTMLElement | null = null;
  private onSubmitCallback: ((data: ReservationData) => boolean | Promise<boolean>) | null = null;
  private isSubmitting = false;
  private isCreatingAct = false;
  private baselineRecord: Record<string, any> | undefined;
  private validationVersion = 0;
  private validationPending = new Map<string, Promise<{ valid: boolean; message?: string }>>();
  private onValidateCallback:
    | ((
        date: string,
        start: string,
        end: string,
        excludeId?: number,
      ) => Promise<{ valid: boolean; message?: string }>)
    | null = null;

  private readonly clientOptions = createClientFormOptions(
    () => localStorage.getItem("userAuthData") || "",
    "traffic_planner_client_options",
  );
  private readonly carOptions = createClientFormOptions(
    () => localStorage.getItem("userAuthData") || "",
  );
  private lookupDropdowns: ReturnType<typeof mountPlannerDropdown>[] = [];
  private formEvents = new AbortController();
  private formGeneration = 0;
  private selectionGeneration = 0;
  private carsData: CarData[] = [];

  private selectedClientId: number | null = null;
  private selectedCarId: number | null = null;

  // Дані автомобілів з auto.json для пошуку коли клієнт не обраний з БД
  private autoJsonSuggestions: {
    mark_id: string;
    mark_cyrillic: string;
    name: string;
    model_cyrillic: string;
    display: string;
  }[] = [];

  // Internal State for Date/Time
  private currentDate: Date = new Date();
  private currentStartTime: string = "08:00";
  private currentEndTime: string = "09:00";

  // Дані для post_arxiv
  private slyusarId: number | null = null;
  private namePost: number | null = null;
  private postArxivId: number | null = null;
  private actId: number | null = null;

  private currentStatusIndex: number = 0;
  private readonly statuses = [
    {
      name: "Запланований",
      color: "#e6a700",
      headerBg: "linear-gradient(135deg, #e6a700 0%, #f0b800 100%)",
    },
    {
      name: "В роботі",
      color: "#2e7d32",
      headerBg: "linear-gradient(135deg, #2e7d32 0%, #388e3c 100%)",
    },
    {
      name: "Відремонтований",
      color: "#757575",
      headerBg: "linear-gradient(135deg, #616161 0%, #757575 100%)",
    },
    {
      name: "Не приїхав",
      color: "#e53935",
      headerBg: "linear-gradient(135deg, #c62828 0%, #e53935 100%)",
    },
  ];

  constructor() {
    this.injectStyles();
  }

  private injectStyles(): void {
    const styleId = "planyvannya-modal-interactive-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
            .post-arxiv-header-date-container {
                display: flex;
                align-items: center;
                gap: 5px;
                color: white;
                font-size: 14px;
                flex-wrap: wrap;
                margin-top: 5px;
            }
            .editable-date-part {
                position: relative;
                cursor: pointer;
                border-bottom: 1px dashed rgba(255,255,255,0.6);
                padding: 0 2px;
                transition: all 0.2s;
            }
            .editable-date-part:hover {
                background: rgba(255,255,255,0.1);
                border-bottom-color: white;
            }
            .editable-date-part.error {
                color: #ffcccc;
                border-bottom-color: #ffcccc;
            }
            .header-dropdown-menu {
                position: fixed; /* Fixed to avoid overflow issues */
                background: white;
                border-radius: 4px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                max-height: 250px;
                overflow-y: auto;
                z-index: 10000;
                min-width: 100px;
                display: none;
                color: #333;
                font-size: 13px;
            }
            .header-dropdown-item {
                padding: 8px 12px;
                cursor: pointer;
            }
            .header-dropdown-item:hover {
                background: #f5f5f5;
            }
            .header-dropdown-item.selected {
                background: #e3f2fd;
                color: #1976d2;
                font-weight: 500;
            }
            .header-dropdown-item.booked-time {
                background-color: #ededed;
                color: #777;
                padding-left: 15px; /* origin 12px + 3px */
            }
            .validation-error-message {
                background: #ffebee;
                color: #c62828;
                padding: 8px 12px;
                border-radius: 4px;
                margin: 10px 0 0 0; /* Changed margin to push down body */
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
                border: 1px solid #ffcdd2;
                width: 100%;
                box-sizing: border-box;
            }
            .post-arxiv-autocomplete-dropdown-up {
                top: auto !important;
                bottom: 100% !important;
                margin-bottom: 2px;
                box-shadow: 0 -4px 6px rgba(0,0,0,0.1);
            }
        `;
    document.head.appendChild(style);
  }

  private busyIntervals: { start: number; end: number }[] = [];

  public async open(
    date: string,
    startTime: string,
    endTime: string,
    comment: string = "",
    existingData?: Partial<ReservationData>,
    onSubmit?: (data: ReservationData) => boolean | Promise<boolean>,
    onValidate?: (
      date: string,
      start: string,
      end: string,
      excludeId?: number,
    ) => Promise<{ valid: boolean; message?: string }>,
    busyIntervals: { start: number; end: number }[] = [],
  ): Promise<void> {
    if (this.isSubmitting) return;
    this.resetLookups();
    this.selectedClientId = null;
    this.selectedCarId = null;
    this.carsData = [];
    this.onSubmitCallback = onSubmit || null;
    this.onValidateCallback = onValidate || null;
    this.busyIntervals = busyIntervals;

    // Initialize state
    this.currentDate = new Date(date);
    this.currentStartTime = startTime;
    this.currentEndTime = endTime;

    this.slyusarId = existingData?.slyusarId ?? null;
    this.namePost = existingData?.namePost ?? null;
    this.postArxivId = existingData?.postArxivId ?? null;
    this.actId = existingData?.actId ?? null;
    this.baselineRecord = this.postArxivId ? getPlannerRecord(this.postArxivId) : undefined;

    this.createModalHTML(comment);
    this.bindEvents();
    this.updateHeaderUI(); // Initial render of header parts
    this.validateCurrentState(); // Initial check

    if (existingData) {
      this.prefillData(existingData);
    }

    // Update Act Button State
    this.updateActButton();

    this.modalOverlay = document.getElementById("postArxivModalOverlay");
    if (this.modalOverlay) {
      this.modalOverlay.style.display = "flex";
      const nameInput = document.getElementById(
        "postArxivClientName",
      ) as HTMLInputElement;
      if (nameInput && !nameInput.value) {
        nameInput.focus();
      }
    }
  }

  private updateActButton(): void {
    const actBtn = document.getElementById("postArxivNewClientBtn");
    if (!actBtn) return;

    if (this.actId) {
      actBtn.innerHTML = `📋 ${this.actId}`;
      actBtn.title = `Відкрити акт №${this.actId}`;
      actBtn.classList.add("has-act");
      // Styling could be added via class
      actBtn.style.background = "#4CAF50";
      actBtn.style.color = "white";
    } else {
      actBtn.innerHTML = "Створити акт";
      actBtn.title = "Створити акт";
      actBtn.classList.remove("has-act");
      actBtn.style.background = "";
      actBtn.style.color = "";
    }
  }

  private prefillData(data: Partial<ReservationData>) {
    const nameInput = document.getElementById(
      "postArxivClientName",
    ) as HTMLInputElement;
    if (nameInput && data.clientName) nameInput.value = data.clientName;

    const phoneInput = document.getElementById(
      "postArxivPhone",
    ) as HTMLInputElement;
    if (phoneInput && data.clientPhone) phoneInput.value = data.clientPhone;

    const carInput = document.getElementById(
      "postArxivCar",
    ) as HTMLInputElement;
    if (carInput && data.carModel) carInput.value = data.carModel;

    const numberInput = document.getElementById(
      "postArxivCarNumber",
    ) as HTMLInputElement;
    if (numberInput && data.carNumber) numberInput.value = data.carNumber;

    if (data.status) {
      const idx = this.statuses.findIndex((s) => s.name === data.status);
      if (idx >= 0) {
        this.currentStatusIndex = idx;
        this.applyStatus();
      }
    }

    this.selectedClientId = data.clientId || null;
    this.selectedCarId = data.carId || null;

    if (this.selectedClientId) {
      this.loadCarsForClient(this.selectedClientId, true).catch(() => {});

      // Завантажуємо відкриті акти клієнта
      // Якщо акт вже вибраний (є actId) - показуємо на 3 секунди
      const autoHideTime = this.actId ? 3000 : undefined;
      this.showClientActs(autoHideTime).catch(() => {});
    }
  }

  private createModalHTML(comment: string): void {
    if (document.getElementById("postArxivModalOverlay")) return;

    const modalHTML = `
      <div class="post-arxiv-modal-overlay" id="postArxivModalOverlay">
        <div class="post-arxiv-modal animate-slide-up">
            <div class="post-arxiv-header" id="postArxivHeader">
                <div class="post-arxiv-header-row">
                    <h2>Запис</h2>
                    <button class="post-arxiv-status-btn" id="postArxivStatusBtn">
                        <span id="postArxivStatusText">Запланований</span>
                    </button>
                    <button class="post-arxiv-close" id="postArxivClose">×</button>
                </div>
                
                <div class="post-arxiv-header-date-container">
                    <span id="hDayName" class="editable-date-part" title="Змінити день тижня">---</span>,
                    <span id="hDay" class="editable-date-part" title="Змінити день">--</span>
                    <span id="hMonth" class="editable-date-part" title="Змінити місяць">---</span>
                    <span id="hYear" class="editable-date-part" title="Змінити рік">----</span>
                    з <span id="hStartTime" class="editable-date-part" title="Змінити час початку">--:--</span>
                    по <span id="hEndTime" class="editable-date-part" title="Змінити час завершення">--:--</span>
                </div>
                <div id="validationErrorMsg" class="validation-error-message" style="display:none;"></div>
            </div>
          
            <div class="post-arxiv-body">
            
            <!-- ПІБ Клієнта -->
            <div class="post-arxiv-form-group post-arxiv-autocomplete-wrapper">
              <div class="post-arxiv-label-row">
                <label>ПІБ <span class="required">*</span></label>
                <button class="post-arxiv-mini-btn" id="postArxivNewClientBtn" title="Створити акт">Створити акт</button>
              </div>
              <input type="text" id="postArxivClientName" placeholder="Введіть щонайменше 3 символи ПІБ..." autocomplete="off">
              <div class="post-arxiv-autocomplete-dropdown" id="postArxivClientDropdown"></div>
              <div class="post-arxiv-autocomplete-dropdown post-arxiv-acts-dropdown" id="postArxivActsDropdown"></div>
            </div>
            
            <!-- Телефон -->
            <div class="post-arxiv-form-group post-arxiv-autocomplete-wrapper">
              <label>Телефон <span class="required">*</span></label>
              <input type="text" id="postArxivPhone" placeholder="+380..." autocomplete="off">
              <div class="post-arxiv-autocomplete-dropdown" id="postArxivPhoneDropdown"></div>
            </div>
            
            <!-- Автомобіль + Номер авто -->
            <div class="post-arxiv-form-row">
              <div class="post-arxiv-form-group post-arxiv-autocomplete-wrapper post-arxiv-car-field">
                <label>Автомобіль <span class="required">*</span></label>
                <input type="text" id="postArxivCar" placeholder="Марка..." autocomplete="off">
                <div class="post-arxiv-autocomplete-dropdown" id="postArxivCarDropdown"></div>
              </div>
              <div class="post-arxiv-form-group post-arxiv-autocomplete-wrapper post-arxiv-number-field">
                <label>Номер авто</label>
                <input type="text" id="postArxivCarNumber" placeholder="АА1234ВВ" autocomplete="off">
                <div class="post-arxiv-autocomplete-dropdown" id="postArxivCarNumberDropdown"></div>
              </div>
            </div>
            
            <!-- Коментар -->
            <div class="post-arxiv-form-group">
              <label>Коментар <span class="optional">(необов'язково)</span></label>
              <textarea id="postArxivComment" placeholder="Введіть коментар..." rows="1" autocomplete="off">${comment}</textarea>
            </div>
          </div>
          <div class="post-arxiv-footer">
            <button class="post-btn post-btn-primary btn-wow-pulse" id="postArxivSubmit">ОК</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHTML);
  }

  public close(force = false): void {
    if (this.isSubmitting && !force) return;
    this.resetLookups();
    const dropdowns = document.querySelectorAll(".header-dropdown-menu");
    dropdowns.forEach((d) => d.remove());

    if (this.modalOverlay) {
      this.modalOverlay.remove();
      this.modalOverlay = null;
    }
    this.selectedClientId = null;
    this.selectedCarId = null;
    this.carsData = [];
    this.closeAllDropdowns();
    this.baselineRecord = undefined;

  }

  private resetLookups(): void {
    this.formGeneration++;
    this.validationVersion++;
    this.validationPending.clear();
    this.selectionGeneration++;
    this.lookupDropdowns.forEach(dropdown => dropdown.dispose());
    this.lookupDropdowns = [];
    this.formEvents.abort();
    this.formEvents = new AbortController();
    this.clientOptions.clear();
    this.carOptions.clear();
    this.clearAutoHideTimeout();
  }

  private updateHeaderUI(): void {
    const hDayName = document.getElementById("hDayName");
    const hDay = document.getElementById("hDay");
    const hMonth = document.getElementById("hMonth");
    const hYear = document.getElementById("hYear");
    const hStartTime = document.getElementById("hStartTime");
    const hEndTime = document.getElementById("hEndTime");

    if (!hDayName || !hDay || !hMonth || !hYear || !hStartTime || !hEndTime)
      return;

    const days = [
      "Неділя",
      "Понеділок",
      "Вівторок",
      "Середа",
      "Четвер",
      "П'ятниця",
      "Субота",
    ];
    const months = [
      "січня",
      "лютого",
      "березня",
      "квітня",
      "травня",
      "червня",
      "липня",
      "серпня",
      "вересня",
      "жовтня",
      "листопада",
      "грудня",
    ];

    hDayName.textContent = days[this.currentDate.getDay()];
    hDay.textContent = this.currentDate.getDate().toString();
    hMonth.textContent = months[this.currentDate.getMonth()];
    hYear.textContent = this.currentDate.getFullYear().toString();

    const formatTime = (t: string) => {
      const [h, m] = t.split(":");
      return `${parseInt(h)}:${m}`;
    };
    hStartTime.textContent = formatTime(this.currentStartTime);
    hEndTime.textContent = formatTime(this.currentEndTime);
  }

  private async validateCurrentState(forceFresh = false): Promise<boolean> {
    if (!this.onValidateCallback) return true;
    const generation = this.formGeneration;
    const version = ++this.validationVersion;

    const errorEl = document.getElementById("validationErrorMsg");
    const submitBtn = document.getElementById(
      "postArxivSubmit",
    ) as HTMLButtonElement;

    const y = this.currentDate.getFullYear();
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
    const d = this.currentDate.getDate().toString().padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;

    const key = JSON.stringify([dateStr, this.currentStartTime, this.currentEndTime, this.slyusarId, this.postArxivId]);
    let request = forceFresh ? undefined : this.validationPending.get(key);
    if (!request) {
      request = this.onValidateCallback(dateStr, this.currentStartTime, this.currentEndTime, this.postArxivId || undefined)
        .catch(() => ({ valid: false, message: "Не вдалося перевірити вільний час. Спробуйте ще раз." }));
      this.validationPending.set(key, request);
    }
    const result = await request;
    if (this.validationPending.get(key) === request) this.validationPending.delete(key);
    if (generation !== this.formGeneration || version !== this.validationVersion) return false;

    if (!result.valid && errorEl) {
      errorEl.style.display = "flex";
      errorEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> ${result.message}`;

      document
        .querySelectorAll(".editable-date-part")
        .forEach((el) => el.classList.add("error"));
      if (submitBtn) submitBtn.disabled = true;
    } else {
      if (errorEl) errorEl.style.display = "none";
      document
        .querySelectorAll(".editable-date-part")
        .forEach((el) => el.classList.remove("error"));
      if (submitBtn) submitBtn.disabled = this.isSubmitting;
    }
    return result.valid;
  }

  private bindEvents(): void {
    const closeBtn = document.getElementById("postArxivClose");
    const submitBtn = document.getElementById("postArxivSubmit");
    const createActBtn = document.getElementById("postArxivNewClientBtn");

    closeBtn?.addEventListener("click", () => this.close());
    this.setupStatusButton();
    this.applyStatus();
    this.setupCommentAutoResize();
    submitBtn?.addEventListener("click", () => this.handleSubmit());
    createActBtn?.addEventListener("click", () => this.handleCreateAct());

    this.setupClientAutocomplete();
    this.setupPhoneAutocomplete();
    this.setupCarAutocomplete();
    this.setupCarNumberAutocomplete();

    // Закриття dropdown актів при кліку поза ним
    document.addEventListener("click", (e) => {
      const dropdown = document.getElementById("postArxivActsDropdown");
      const target = e.target as HTMLElement;

      if (dropdown && dropdown.style.display === "block") {
        // Перевіряємо чи клік був поза dropdown
        if (!dropdown.contains(target)) {
          dropdown.style.display = "none";
          this.clearAutoHideTimeout();
        }
      }
    }, { signal: this.formEvents.signal });
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".post-arxiv-autocomplete-wrapper")) {
        this.closeAllDropdowns();
      }
      if (
        !target.closest(".header-dropdown-menu") &&
        !target.closest(".editable-date-part")
      ) {
        document
          .querySelectorAll(".header-dropdown-menu")
          .forEach((el) => el.remove());
      }
    }, { signal: this.formEvents.signal });

    this.setupHeaderInteractions();
  }

  private setupHeaderInteractions(): void {
    const bindDropdown = (
      id: string,
      generator: () => {
        text: string;
        value: any;
        sub?: string;
        isBooked?: boolean;
      }[],
      onSelect: (val: any) => void,
    ) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        document
          .querySelectorAll(".header-dropdown-menu")
          .forEach((d) => d.remove());

        const options = generator();
        const dropdown = document.createElement("div");
        dropdown.className = "header-dropdown-menu";

        options.forEach((opt) => {
          const item = document.createElement("div");
          item.className = "header-dropdown-item";
          item.textContent = opt.text;

          if (opt.isBooked) {
            item.classList.add("booked-time");
          }

          if (opt.sub) {
            const sub = document.createElement("span");
            sub.style.fontSize = "11px";
            sub.style.color = "#888";
            sub.style.marginLeft = "5px";
            sub.textContent = opt.sub;
            item.appendChild(sub);
          }
          if (String(opt.value) === String(el.textContent))
            item.classList.add("selected");

          item.addEventListener("click", () => {
            onSelect(opt.value);
            dropdown.remove();
            this.updateHeaderUI();
            this.validateCurrentState();
          });
          dropdown.appendChild(item);
        });

        document.body.appendChild(dropdown);

        const rect = el.getBoundingClientRect();
        dropdown.style.display = "block";
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 5}px`;

        const dropRect = dropdown.getBoundingClientRect();
        if (dropRect.right > window.innerWidth) {
          dropdown.style.left = `${window.innerWidth - dropRect.width - 10}px`;
        }
        if (dropRect.bottom > window.innerHeight) {
          dropdown.style.top = `${rect.top - dropRect.height - 5}px`;
        }
      });
    };

    bindDropdown(
      "hDayName",
      () => {
        const days = [
          "Понеділок",
          "Вівторок",
          "Середа",
          "Четвер",
          "П'ятниця",
          "Субота",
          "Неділя",
        ];
        const opts = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(this.currentDate);
          d.setDate(d.getDate() + i);
          const dayName = days[d.getDay() === 0 ? 6 : d.getDay() - 1];
          opts.push({
            text: dayName,
            value: d.getTime(),
            sub: `${d.getDate()}.${d.getMonth() + 1}`,
          });
        }
        return opts;
      },
      (ts) => {
        this.currentDate = new Date(ts);
      },
    );

    bindDropdown(
      "hDay",
      () => {
        const daysInMonth = new Date(
          this.currentDate.getFullYear(),
          this.currentDate.getMonth() + 1,
          0,
        ).getDate();
        const opts = [];
        for (let i = 1; i <= daysInMonth; i++)
          opts.push({ text: i.toString(), value: i });
        return opts;
      },
      (val) => {
        this.currentDate.setDate(val);
      },
    );

    bindDropdown(
      "hMonth",
      () => {
        const months = [
          "січня",
          "лютого",
          "березня",
          "квітня",
          "травня",
          "червня",
          "липня",
          "серпня",
          "вересня",
          "жовтня",
          "листопада",
          "грудня",
        ];
        return months.map((m, i) => ({ text: m, value: i }));
      },
      (val) => {
        this.currentDate.setMonth(val);
      },
    );

    bindDropdown(
      "hYear",
      () => {
        const current = new Date().getFullYear();
        const opts = [];
        for (let i = current; i <= current + 2; i++)
          opts.push({ text: i.toString(), value: i });
        return opts;
      },
      (val) => {
        this.currentDate.setFullYear(val);
      },
    );

    const generateTimes = () => {
      const times = [];
      for (let h = 8; h <= 20; h++) {
        const t1 = {
          text: `${h}:00`,
          value: `${h.toString().padStart(2, "0")}:00`,
        };
        const m1 = h * 60;
        const isBooked1 = this.busyIntervals.some(
          (i) => m1 >= i.start && m1 < i.end,
        );
        times.push({ ...t1, isBooked: isBooked1 });

        if (h !== 20) {
          const t2 = {
            text: `${h}:30`,
            value: `${h.toString().padStart(2, "0")}:30`,
          };
          const m2 = h * 60 + 30;
          const isBooked2 = this.busyIntervals.some(
            (i) => m2 >= i.start && m2 < i.end,
          );
          times.push({ ...t2, isBooked: isBooked2 });
        }
      }
      return times;
    };

    bindDropdown("hStartTime", generateTimes, (val) => {
      this.currentStartTime = val;
      const [sh, sm] = val.split(":").map(Number);
      const [eh, em] = this.currentEndTime.split(":").map(Number);
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      if (startMins >= endMins) {
        const newEndMins = startMins + 60;
        const neh = Math.floor(newEndMins / 60);
        const nem = newEndMins % 60;
        this.currentEndTime = `${neh.toString().padStart(2, "0")}:${nem
          .toString()
          .padStart(2, "0")}`;
      }
    });

    bindDropdown("hEndTime", generateTimes, (val) => {
      this.currentEndTime = val;
    });
  }

  private readClientCars(clientId: number): Promise<CarData[]> {
    return this.clientOptions.readEntity("cars", String(clientId), async () => {
      const { data, error } = await supabase.from("cars")
        .select('cars_id, client_id, model:data->>"Авто", number:data->>"Номер авто"')
        .eq("client_id", clientId)
        .not("is_deleted", "is", true);
      if (error) throw error;
      return (data || []).map(row => ({
        cars_id: row.cars_id, client_id: row.client_id,
        model: String(row.model || ""), number: String(row.number || ""),
      }));
    });
  }

  private clientFromOption(item: any): ClientData {
    return {
      client_id: Number(item.id), name: String(item.fullName || ""),
      phones: Array.isArray(item.phones) ? item.phones : (item.phone ? [item.phone] : []),
    };
  }

  private async loadCarsForClient(
    clientId: number,
    preserveSelection: boolean = false,
  ): Promise<void> {
    const generation = this.formGeneration;
    const selection = this.selectionGeneration;
    try {
      const cars = await this.readClientCars(clientId);
      if (generation !== this.formGeneration || selection !== this.selectionGeneration
        || this.selectedClientId !== clientId) return;
      this.carsData = cars;

      // If we are editing (preserveSelection is true) and we have a selected car that exists in the loaded list,
      // we should NOT clear the fields.
      if (preserveSelection && this.selectedCarId) {
        const carExists = this.carsData.find(
          (c) => c.cars_id === this.selectedCarId,
        );
        if (carExists) {
          return; // Exit here, keeping the current input values
        }
      }

      // Autocomplete logic after loading cars:
      if (this.carsData.length === 1) {
        // If client has only 1 car, auto-fill
        this.fillCarFields(this.carsData[0]);
      } else {
        // If multiple cars, clear fields and let user choose
        // But we want to show the dropdown immediately if they focus
        const carInput = document.getElementById(
          "postArxivCar",
        ) as HTMLInputElement;
        const numberInput = document.getElementById(
          "postArxivCarNumber",
        ) as HTMLInputElement;
        if (carInput) {
          carInput.value = "";
          carInput.placeholder = `Оберіть авто (${this.carsData.length} знайдено)...`;
          // Trigger dropdown logic?
          // Better to let the focus event handle it, or trigger it manually:
          // carInput.focus(); // Optional: might be annoying if they just finished phone number
        }
        if (numberInput) numberInput.value = "";
        this.selectedCarId = null;
      }
    } catch (err) {
      // console.error("Error loading cars:", err);
    }
  }

  private fillCarFields(car: CarData): void {
    const carInput = document.getElementById(
      "postArxivCar",
    ) as HTMLInputElement;
    const numberInput = document.getElementById(
      "postArxivCarNumber",
    ) as HTMLInputElement;

    if (carInput) carInput.value = car.model;
    if (numberInput) numberInput.value = car.number;
    this.selectedCarId = car.cars_id;
  }

  // --- Autocomplete Setup Methods ---

  private resetClientSelection(): void {
    this.selectionGeneration++;
    this.selectedClientId = null;
    this.selectedCarId = null;
    this.carsData = [];
    this.actId = null;
    this.clearAutoHideTimeout();
    this.closeAllDropdowns();
    this.updateActButton();
  }

  private setupClientAutocomplete(): void {
    const input = document.getElementById("postArxivClientName") as HTMLInputElement;
    const list = document.getElementById("postArxivClientDropdown");
    if (!input || !list) return;
    const generation = this.formGeneration;
    this.lookupDropdowns.push(mountPlannerDropdown({
      input, list, minLength: 3,
      loadPage: (query, after) => this.clientOptions.read("client", query, after, null),
      label: item => item.fullName,
      subtitle: item => item.phone || "Без телефону",
      onSelect: item => this.handleClientSelect(this.clientFromOption(item)),
      onInput: () => this.resetClientSelection(),
      isCurrent: () => generation === this.formGeneration,
      onError: () => showNotification("Не вдалося вибрати клієнта. Повторіть вибір.", "error"),
    }));
  }

  private setupPhoneAutocomplete(): void {
    const input = document.getElementById("postArxivPhone") as HTMLInputElement;
    const list = document.getElementById("postArxivPhoneDropdown");
    if (!input || !list) return;
    const generation = this.formGeneration;
    this.lookupDropdowns.push(mountPlannerDropdown({
      input, list, minLength: 3, normalize: value => value.replace(/\D/g, ""),
      loadPage: (query, after) => this.clientOptions.read("phone", query, after, null),
      label: item => item.phone,
      subtitle: item => item.fullName,
      onSelect: item => this.handleClientSelect(this.clientFromOption(item), true, item.phone),
      // Editing a contact number must not unlink an existing booking or act.
      onInput: () => { this.selectionGeneration++; this.closeAllDropdowns(); },
      isCurrent: () => generation === this.formGeneration,
      onError: () => showNotification("Не вдалося вибрати клієнта. Повторіть вибір.", "error"),
    }));
  }

  private buildAutoJsonSuggestions(): void {
    if (this.autoJsonSuggestions.length > 0) return; // Вже побудовано
    const formatDisplayText = (text: string): string => {
      if (!text) return "";
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    };
    this.autoJsonSuggestions = autoData.data.flatMap((mark) =>
      mark.models.map((model) => ({
        mark_id: formatDisplayText(mark.id),
        mark_cyrillic: mark.cyrillic_name || "",
        name: formatDisplayText(model.name),
        model_cyrillic: model.cyrillic_name || "",
        display: `${formatDisplayText(mark.id)} ${formatDisplayText(model.name)}`,
      })),
    );
  }

  private matchesCarSearch(
    item: {
      mark_id: string;
      mark_cyrillic: string;
      name: string;
      model_cyrillic: string;
      display: string;
    },
    searchValue: string,
  ): boolean {
    const search = searchValue.toLowerCase();
    const englishMatch =
      item.mark_id.toLowerCase().includes(search) ||
      item.name.toLowerCase().includes(search) ||
      item.display.toLowerCase().includes(search);
    const cyrillicMatch =
      item.mark_cyrillic.toLowerCase().includes(search) ||
      item.model_cyrillic.toLowerCase().includes(search);
    return englishMatch || cyrillicMatch;
  }

  private setupCarAutocomplete(): void {
    const input = document.getElementById("postArxivCar") as HTMLInputElement;
    const dropdown = document.getElementById("postArxivCarDropdown");
    if (!input || !dropdown) return;

    // Ініціалізуємо дані з auto.json
    this.buildAutoJsonSuggestions();

    const showClientCars = (filter: string = "") => {
      if (this.selectedClientId && this.carsData.length > 0) {
        const matches = this.carsData.filter((c) =>
          c.model.toLowerCase().includes(filter),
        );
        this.showDropdown(
          dropdown,
          matches.map((c) => ({
            text: c.model,
            subtext: c.number || "Без номера",
            onClick: () => this.fillCarFields(c),
          })),
        );
      }
    };

    const showAutoJsonCars = (filter: string) => {
      const matches = this.autoJsonSuggestions
        .filter((item) => this.matchesCarSearch(item, filter))
        .slice(0, 15);
      this.showDropdown(
        dropdown,
        matches.map((item) => ({
          text: item.display,
          subtext: item.mark_cyrillic
            ? `${item.mark_cyrillic}${item.model_cyrillic ? " " + item.model_cyrillic : ""}`
            : "",
          onClick: () => {
            input.value = item.display;
            this.closeAllDropdowns();
          },
        })),
      );
    };

    input.addEventListener("focus", () => {
      // Show all cars if client selected
      if (this.selectedClientId) {
        showClientCars();
      }
    });

    input.addEventListener("input", async () => {
      const val = input.value.toLowerCase().trim();
      this.selectedCarId = null;
      this.selectionGeneration++;

      if (this.selectedClientId) {
        // Filter loaded cars
        showClientCars(val);
      } else {
        // Клієнт не обраний з БД — показуємо автомобілі з auto.json
        // з підтримкою пошуку українськими та англійськими літерами
        if (val.length < 2) {
          this.closeAllDropdowns();
          return;
        }

        showAutoJsonCars(val);
      }
    });
  }

  private setupCarNumberAutocomplete(): void {
    const input = document.getElementById("postArxivCarNumber") as HTMLInputElement;
    const list = document.getElementById("postArxivCarNumberDropdown");
    if (!input || !list) return;
    const generation = this.formGeneration;
    this.lookupDropdowns.push(mountPlannerDropdown({
      input, list, minLength: 3,
      loadPage: async (query, after) => {
        const clientId = this.selectedClientId;
        if (clientId) {
          const cars = await this.readClientCars(clientId);
          const matches = cars.filter(car => (after === null || car.cars_id > after)
            && car.number.toLowerCase().includes(query)).sort((a, b) => a.cars_id - b.cars_id);
          const items = matches.slice(0, 20).map(car => ({
            id: String(car.cars_id), client_id: String(car.client_id),
            "Авто": car.model, "Номер авто": car.number,
          }));
          return { items, has_more: matches.length > 20,
            next_cursor: items.length ? Number(items[items.length - 1].id) : null };
        }
        return this.carOptions.read("carNumber", query, after, null);
      },
      label: item => item["Номер авто"], subtitle: item => item["Авто"],
      onInput: () => { this.selectedCarId = null; this.selectionGeneration++; },
      onSelect: async item => {
        const car: CarData = { cars_id: Number(item.id), client_id: Number(item.client_id),
          model: String(item["Авто"] || ""), number: String(item["Номер авто"] || "") };
        this.fillCarFields(car);
        if (this.selectedClientId === car.client_id) return;
        const selection = ++this.selectionGeneration;
        const page = await this.clientOptions.read("client", "", null, String(car.client_id));
        if (generation !== this.formGeneration || selection !== this.selectionGeneration) return;
        if (!page.items.length) throw new Error("Клієнта цього автомобіля не знайдено.");
        this.handleClientSelect(this.clientFromOption(page.items[0]), false);
      },
      isCurrent: () => generation === this.formGeneration,
      onError: error => showNotification(error instanceof Error ? error.message : "Не вдалося вибрати автомобіль.", "error"),
    }));
  }

  // --- Helpers ---

  private setupStatusButton(): void {
    const statusBtn = document.getElementById("postArxivStatusBtn");
    if (statusBtn) {
      statusBtn.addEventListener("click", () => {
        this.currentStatusIndex =
          (this.currentStatusIndex + 1) % this.statuses.length;
        this.applyStatus();
      });
    }
  }

  private applyStatus(): void {
    const status = this.statuses[this.currentStatusIndex];
    const header = document.getElementById("postArxivHeader");
    const statusText = document.getElementById("postArxivStatusText");

    if (header) {
      header.style.background = status.headerBg;
    }

    if (statusText) {
      statusText.textContent = status.name;
    }
  }

  private setupCommentAutoResize(): void {
    const textarea = document.getElementById(
      "postArxivComment",
    ) as HTMLTextAreaElement;
    if (!textarea) return;

    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    };

    textarea.addEventListener("input", resize);
    // Initial resize in case of pre-filled content
    resize();
  }

  private handleClientSelect(
    client: ClientData,
    loadCars: boolean = true,
    preferredPhone?: string,
  ): void {
    const nameInput = document.getElementById(
      "postArxivClientName",
    ) as HTMLInputElement;
    const phoneInput = document.getElementById(
      "postArxivPhone",
    ) as HTMLInputElement;

    const changedClient = this.selectedClientId !== client.client_id;
    this.selectionGeneration++;
    if (changedClient) {
      this.actId = null;
      this.updateActButton();
      this.carsData = [];
      if (loadCars) this.selectedCarId = null;
    }
    if (nameInput) nameInput.value = client.name;
    // Завжди заповнюємо телефон при виборі клієнта з випадаючого списку ПІБ
    if (phoneInput) {
      phoneInput.value = preferredPhone || client.phones[0] || "";
    }

    this.selectedClientId = client.client_id;

    if (loadCars) {
      void this.loadCarsForClient(client.client_id, !changedClient);
    } else {
      const generation = this.formGeneration;
      const selection = this.selectionGeneration;
      void this.readClientCars(client.client_id).then(cars => {
        if (generation === this.formGeneration && selection === this.selectionGeneration) this.carsData = cars;
      }).catch(() => undefined);
    }

    // Завантажуємо відкриті акти клієнта
    void this.showClientActs();

    this.closeAllDropdowns();
  }

  private showDropdown(
    container: HTMLElement,
    items: { text: string; subtext: string; onClick: () => void }[],
  ): void {
    container.innerHTML = "";
    if (items.length === 0) {
      container.style.display = "none";
      container.classList.remove("post-arxiv-autocomplete-dropdown-up");
      return;
    }

    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "post-arxiv-autocomplete-option";

      const main = document.createElement("div");
      main.className = "post-arxiv-autocomplete-option-main";
      main.textContent = item.text;

      const sub = document.createElement("div");
      sub.className = "post-arxiv-autocomplete-option-sub";
      sub.textContent = item.subtext;

      div.appendChild(main);
      div.appendChild(sub);

      div.addEventListener("click", (e) => {
        e.stopPropagation();
        item.onClick();
        this.closeAllDropdowns();
      });

      container.appendChild(div);
    });

    // Show temporarily to calculate size
    container.style.display = "block";
    container.classList.remove("post-arxiv-autocomplete-dropdown-up");

    // Check if it fits
    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    // Custom logic: Force UP if more than 1 item and it is the Car Dropdown
    const isCarDropdown = container.id === "postArxivCarDropdown";
    const shouldForceUp = isCarDropdown && items.length > 1;

    // If bottom of dropdown is below viewport OR should force up
    if (rect.bottom > viewportHeight - 10 || shouldForceUp) {
      container.classList.add("post-arxiv-autocomplete-dropdown-up");
    }
  }

  private closeAllDropdowns(): void {
    this.lookupDropdowns.forEach(dropdown => dropdown.close());
    const dropdowns = document.querySelectorAll(
      ".post-arxiv-autocomplete-dropdown",
    );
    dropdowns.forEach((d) => ((d as HTMLElement).style.display = "none"));
  }

  // --- Автоматичний показ актів клієнта ---
  private autoHideTimeout: any = null;
  private isDropdownHovered: boolean = false;

  private async showClientActs(autoHideAfterMs?: number): Promise<void> {
    const dropdown = document.getElementById("postArxivActsDropdown");
    if (!dropdown || !this.selectedClientId) {
      if (dropdown) dropdown.style.display = "none";
      return;
    }

    const clientId = this.selectedClientId;
    const generation = this.formGeneration;
    const selection = this.selectionGeneration;
    const current = () => generation === this.formGeneration
      && selection === this.selectionGeneration && this.selectedClientId === clientId
      && dropdown.isConnected;
    try {
      const [acts, clientCars] = await Promise.all([
        this.clientOptions.readEntity("openActs", String(clientId), async () => {
          const { data, error } = await supabase.from("acts")
            .select("act_id, cars_id")
            .eq("client_id", clientId)
            .is("date_off", null)
            .order("act_id", { ascending: false })
            .limit(20);
          if (error) throw error;
          return data || [];
        }),
        this.readClientCars(clientId),
      ]);
      if (!current()) return;
      if (!acts.length) { dropdown.style.display = "none"; return; }

      // Reuse the same cached car request used to fill the selected client.
      const carsMap = new Map(clientCars.map(car => [car.cars_id, car.model]));
      const missingIds = [...new Set(acts.map(act => Number(act.cars_id))
        .filter(id => id > 0 && !carsMap.has(id)))];
      if (missingIds.length) {
        const missingCars = await this.clientOptions.readEntity("actCarNames", missingIds.sort((a,b) => a-b).join(","), async () => {
          const { data, error } = await supabase.from("cars")
            .select('cars_id, model:data->>"Авто"').in("cars_id", missingIds);
          if (error) throw error;
          return data || [];
        });
        if (!current()) return;
        missingCars.forEach(car => carsMap.set(car.cars_id, String(car.model || "")));
      }

      dropdown.replaceChildren();
      acts.forEach(act => {
        const carModel = carsMap.get(Number(act.cars_id)) || "";
        const option = document.createElement("div");
        option.className = "post-arxiv-autocomplete-option";
        option.dataset.actId = String(act.act_id);
        const label = document.createElement("div");
        label.className = "post-arxiv-autocomplete-option-main";
        label.textContent = "Акт №" + act.act_id + (carModel ? " - " + carModel : "");
        option.append(label);
        dropdown.append(option);
      });

      dropdown.style.display = "block";

      // Додаємо обробники кліків
      dropdown
        .querySelectorAll(".post-arxiv-autocomplete-option")
        .forEach((option) => {
          option.addEventListener("click", () => {
            const actId = Number(option.getAttribute("data-act-id"));
            this.selectClientAct(actId);
            dropdown.style.display = "none";
            this.clearAutoHideTimeout();
          });
        });

      // Обробники для hover
      dropdown.onmouseenter = () => {
        this.isDropdownHovered = true;
        this.clearAutoHideTimeout();
      };

      dropdown.onmouseleave = () => {
        this.isDropdownHovered = false;
        // Якщо був таймер автоприховування - ховаємо відразу
        if (autoHideAfterMs && autoHideAfterMs > 0) {
          dropdown.style.display = "none";
        }
      };

      // Якщо вказано автоматичне приховання
      if (autoHideAfterMs && autoHideAfterMs > 0) {
        this.clearAutoHideTimeout();
        this.autoHideTimeout = setTimeout(() => {
          // Ховаємо тільки якщо немає ховера
          if (!this.isDropdownHovered) {
            dropdown.style.display = "none";
          }
        }, autoHideAfterMs);
      }
    } catch (err) {
      if (!current()) return;
      dropdown.style.display = "none";
      showNotification("Не вдалося завантажити відкриті акти клієнта. Повторіть вибір клієнта.", "error");
    }
  }

  private clearAutoHideTimeout(): void {
    if (this.autoHideTimeout) {
      clearTimeout(this.autoHideTimeout);
      this.autoHideTimeout = null;
    }
  }

  private selectClientAct(actId: number): void {
    // Зберігаємо вибраний акт
    this.actId = actId;

    // Оновлюємо кнопку
    const actBtn = document.getElementById(
      "postArxivNewClientBtn",
    ) as HTMLButtonElement;
    if (actBtn) {
      actBtn.innerHTML = `📋 ${actId}`;
      actBtn.title = `Відкрити акт №${actId}`;
      actBtn.style.background = "#4CAF50";
      actBtn.style.color = "white";
    }
  }

  private async handleCreateAct(): Promise<void> {
    if (this.isSubmitting || this.isCreatingAct) return;
    if (this.actId) {
      // Якщо акт вже вибраний - відкриваємо його
      if (typeof (window as any).openActModal === "function") {
        (window as any).openActModal(this.actId);
      } else {
        // console.warn("Global function openActModal not found");
      }
      return;
    }

    // Якщо акту немає - відкриваємо модалку створення акту з перенесенням даних
    this.isCreatingAct = true;
    try {
      await this.handleCreateNewAct();
    } finally {
      this.isCreatingAct = false;
    }
  }

  private async handleCreateNewAct(): Promise<void> {
    const nameInput = document.getElementById(
      "postArxivClientName",
    ) as HTMLInputElement;
    const phoneInput = document.getElementById(
      "postArxivPhone",
    ) as HTMLInputElement;
    const carInput = document.getElementById(
      "postArxivCar",
    ) as HTMLInputElement;
    const numberInput = document.getElementById(
      "postArxivCarNumber",
    ) as HTMLInputElement;
    const commentInput = document.getElementById(
      "postArxivComment",
    ) as HTMLTextAreaElement;

    const name = nameInput?.value || "";
    const phone = phoneInput?.value || "";
    const carModel = carInput?.value || "";
    const carNumber = numberInput?.value || "";
    const comment = commentInput?.value || "";

    await showModalCreateSakazNarad();
    setTransferredActComment(comment);

    if (this.selectedClientId) {
      try {
        if (!await fillSelectedClientCar(String(this.selectedClientId), this.selectedCarId ? String(this.selectedCarId) : null)) return;
      } catch (error) {
        showNotification(error instanceof Error ? error.message : "Не вдалося прочитати клієнта та автівку. Повторіть вибір.", "error");
        return;
      }
    } else {
      const clientInput = document.getElementById(
        "client-input-create-sakaz_narad",
      ) as HTMLTextAreaElement;
      if (clientInput) {
        clientInput.value = name;
        clientInput.dispatchEvent(new Event("input"));
      }
      const phoneInputElement = document.getElementById(
        "phone-create-sakaz_narad",
      ) as HTMLInputElement;
      if (phoneInputElement) phoneInputElement.value = phone;
    }

    const carModelInputElement = document.getElementById(
      "car-model-create-sakaz_narad",
    ) as HTMLInputElement;
    const carNumberInputElement = document.getElementById(
      "car-number-input-create-sakaz_narad",
    ) as HTMLInputElement;

    if (!this.selectedCarId && carModelInputElement && carModel) carModelInputElement.value = carModel;
    if (!this.selectedCarId && carNumberInputElement && carNumber)
      carNumberInputElement.value = carNumber;

    // Викликаємо модалку збереження і отримуємо act_id
    const newActId = await showSaveModalCreate(this.postArxivId || undefined);

    if (newActId) {
      // Оновлюємо локальне поле actId
      this.actId = newActId;

      // Оновлюємо текст кнопки
      const actBtn = document.getElementById(
        "postArxivNewClientBtn",
      ) as HTMLButtonElement;
      if (actBtn) {
        actBtn.innerHTML = `Акт ${newActId}`;
        actBtn.title = `Відкрити акт ${newActId}`;
      }

      showNotification("Акт успішно створено", "success");

      // Підтверджене прив'язування act_id оновлює лише відповідне бронювання.
    }

    this.close();
  }

  private async showSuccessAnimation(): Promise<void> {
    const modal = document.getElementById("postArxivModal");
    if (!modal) return;

    modal.innerHTML = `
      <div class="success-animation-container">
        <svg viewBox="0 0 52 52">
          <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
          <path class="checkmark" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
        </svg>
        <h3>Збережено!</h3>
      </div>
    `;

    return new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async handleSubmit(): Promise<void> {
    if (this.isSubmitting) return;
    const nameInput = document.getElementById(
      "postArxivClientName",
    ) as HTMLInputElement;
    const phoneInput = document.getElementById(
      "postArxivPhone",
    ) as HTMLInputElement;
    const carInput = document.getElementById(
      "postArxivCar",
    ) as HTMLInputElement;
    const numberInput = document.getElementById(
      "postArxivCarNumber",
    ) as HTMLInputElement;
    const commentInput = document.getElementById(
      "postArxivComment",
    ) as HTMLTextAreaElement;
    const statusText = document.getElementById("postArxivStatusText");

    if (!nameInput?.value || !phoneInput?.value || !carInput?.value) {
      showNotification("Будь ласка, заповніть всі обов'язкові поля", "error");
      return;
    }

    const status = statusText?.textContent || "Запланований";

    // Use internal state
    const y = this.currentDate.getFullYear();
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
    const d = this.currentDate.getDate().toString().padStart(2, "0");
    const dateValue = `${y}-${m}-${d}`;

    const data: ReservationData = {
      date: dateValue,
      startTime: this.currentStartTime,
      endTime: this.currentEndTime,
      clientId: this.selectedClientId,
      clientName: nameInput.value,
      clientPhone: phoneInput.value,
      carId: this.selectedCarId,
      carModel: carInput.value,
      carNumber: numberInput?.value || "",
      comment: commentInput?.value || "",
      status: status,
      postArxivId: this.postArxivId,
      slyusarId: this.slyusarId,
      namePost: this.namePost,
      actId: this.actId,
      baselineRecord: this.baselineRecord,
    };

    if (!this.onSubmitCallback) return;
    if (!Number.isFinite(this.currentDate.getTime()) || this.currentEndTime <= this.currentStartTime) {
      showNotification("Перевірте дату та час: закінчення має бути пізніше початку.", "error");
      return;
    }
    this.isSubmitting = true;
    this.validationVersion++;
    document.querySelectorAll(".header-dropdown-menu").forEach(menu => menu.remove());
    const generation = this.formGeneration;
    const submitButton = document.getElementById("postArxivSubmit") as HTMLButtonElement | null;
    const form = document.getElementById("postArxivModal");
    const controls = Array.from(form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>("input, textarea, button, select") || [])
      .map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    if (form) { form.style.pointerEvents = "none"; form.setAttribute("aria-busy", "true"); }
    if (submitButton) submitButton.disabled = true;
    try {
      // Callback перевіряє актуальну зайнятість безпосередньо перед записом.
      const saved = await this.onSubmitCallback(data);
      if (!saved || generation !== this.formGeneration) return;
      await this.showSuccessAnimation();
      this.close(true);
    } catch (error) {
      showNotification(error instanceof Error ? error.message : "Не вдалося зберегти запис. Спробуйте ще раз.", "error");
    } finally {
      this.isSubmitting = false;
      if (form?.isConnected) { form.style.pointerEvents = ""; form.removeAttribute("aria-busy"); }
      controls.forEach(({ control, disabled }) => { if (control.isConnected) control.disabled = disabled; });
      if (generation === this.formGeneration && submitButton?.isConnected) submitButton.disabled = false;
    }
  }
}
