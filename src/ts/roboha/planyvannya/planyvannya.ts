//src\ts\roboha\planyvannya\planyvannya.ts

import { supabase } from "../../vxid/supabaseClient";
import { waitForMainAuthentication } from "../../mainPageBootstrap";
import { readPlannerBookings } from "./plannerBookingsRead";
import { readPlannerOccupancy } from "./plannerOccupancyRead";
import { capturePlannerReadVersion, rememberPlannerBookings, getPlannerRecord, isPlannerRecordDeleted, publishPlannerChange, type PlannerRecordChange } from "./plannerRecordStore";
import { PostModal, type PostData, type PostDirectoryReceipt } from "./planyvannya_post";
import { PostArxiv } from "./planyvannya_arxiv"; // Import new class
import { PlanyvannyaModal, type ReservationData } from "./planyvannya_modal";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { checkCurrentPageAccess } from "../zakaz_naraudy/inhi/page_access_guard";
import { redirectToIndex } from "../../utils/gitUtils";
import { initPostArxivRealtimeSubscription } from "./planyvannya_realtime";
import { logAction } from "../../utils/auditLogger";
import {
  globalCache,
  isGeneralSettingsLoadedThisSession,
  loadGeneralSettingsFromDB,
  loadGeneralSettingsFromLocalStorage,
  markGeneralSettingsAsLoaded,
} from "../zakaz_naraudy/globalCache";
import {
  loadAndApplyVoiceInputSetting,
  loadAndApplyPhoneIndicatorSetting,
  loadAndApplyAiProSetting,
  loadAndApplyFavicon,
  subscribeToSettingsRealtime,
} from "../nalachtuvannay/nalachtuvannay";
import {
  isSpeechRecognitionSupported,
  startChatVoiceInputRealtime,
  stopListening,
  showVoiceOverlay,
  hideVoiceOverlay,
} from "../ai/voiceInput";

interface Post {
  id: number;
  postId: number; // post_id з таблиці post_name
  title: string;
  subtitle: string;
  namber: number;
}

interface Section {
  id: number;
  realCategoryId: string;
  name: string;
  collapsed: boolean;
  posts: Post[];
}

interface Sluysar {
  slyusar_id: number;
  sluysar_name: string;
  namber: number;
  post_name: string;
  post_id: number; // post_id для збереження в post_sluysar
  category: string;
}

// Інтерфейс для відстеження позицій
interface PositionData {
  slyusar_id: number;
  post_id: number; // post_id для збереження в post_sluysar
  original_namber: number;
  current_namber: number;
  slyusar_name?: string; // Для пошуку при створенні нового
  post_title?: string; // Для пошуку post_id
}

interface DayOccupancyStats {
  date: string;
  postOccupancy: Map<number, number>; // post_id -> хвилини завантаження
  totalPosts: number; // Загальна кількість всіх постів
}

function plannerDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function plannerWritePatch(previous: any, payload: Record<string, any>): Record<string, any> {
  const comparable = (key: string, value: any) => key === "data_on" || key === "data_off"
    ? String(value || "").replace(" ", "T").slice(0, 19) : String(value ?? "");
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
    key !== "xto_zapusav" && (!previous || comparable(key, previous[key]) !== comparable(key, value))));
}

class SchedulerApp {
  private sections: Section[] = [];
  private editMode: boolean = false;
  private isWeekView: boolean = true;

  private today: Date;
  private selectedDate: Date;
  private viewYear: number;
  private viewMonth: number;

  private schedulerWrapper: HTMLElement | null;
  private calendarGrid: HTMLElement | null;
  private headerDateDisplay: HTMLElement | null;
  private timeHeader: HTMLElement | null;
  private calendarContainer: HTMLElement | null;
  private editModeBtn: HTMLElement | null;

  // Модалки
  private postModal: PostModal;

  // PostArxiv для управління блоками бронювання
  private postArxiv: PostArxiv | null = null;

  // Drag and Drop
  private draggedElement: HTMLElement | null = null;
  private draggedSectionId: number | null = null;
  private draggedPostId: number | null = null;
  private dragPlaceholder: HTMLElement | null = null;

  // Maps for lookup
  private postTitleToIdMap = new Map<string, number>();
  private slyusarNameToIdMap = new Map<string, number>();

  // Position Tracking - відстеження позицій
  private initialPositions: PositionData[] = [];
  private initialPostCategories = new Map<number, string>();
  private deletedSlyusarIds: number[] = [];
  private positionsSavePending = false;

  // Статистика зайнятості днів
  private monthOccupancyStats: Map<string, DayOccupancyStats> = new Map();
  private monthOccupancyPending = new Map<string, Promise<void>>();
  private loadedOccupancyMonths = new Set<string>();
  private occupancyVersions = new Map<string, number>();
  private occupancyVersion = 0;
  private occupancyCacheGeneration = 0;
  private staffNames = new Map<number, string>();
  private renderGeneration = 0;
  private weekReadGeneration = 0;
  private weekSavePending = false;
  private availabilityPending = new Map<string, Promise<{ valid: boolean; message?: string }>>();

  // Тижневий вид — модалка та drag-створення
  private weekModal: PlanyvannyaModal;
  private weekDragActive: boolean = false;
  private weekDragStartX: number = 0;
  private weekDragCurrentX: number = 0;
  private weekDragCell: HTMLElement | null = null;
  private weekSelectionEl: HTMLElement | null = null;

  // Тижневий вид — drag переміщення блоків
  private weekMovingBlock: HTMLElement | null = null;
  private weekMovingOriginalCell: HTMLElement | null = null;
  private weekMovingOriginalLeft: string = "";
  private weekMovingOriginalDataset: Record<string, string | undefined> = {};
  private weekMovingOriginalWidth: string = "";
  private weekMovingOriginalTimeText: string = "";
  private weekBlockDragStartX: number = 0;
  private weekBlockDragStartY: number = 0;
  private weekBlockDragOffsetX: number = 0;
  private weekIsBlockDragging: boolean = false;

  // Тижневий вид — resize блоків
  private weekIsResizing: boolean = false;
  private weekResizeHandleSide: "left" | "right" | null = null;
  private weekResizingBlock: HTMLElement | null = null;
  private weekResizeOrigStartMins: number = 0;
  private weekResizeOrigEndMins: number = 0;
  private weekResizeStartX: number = 0;
  private plannerVoiceListening: boolean = false;

  constructor() {
    this.today = new Date();
    this.today.setHours(0, 0, 0, 0);

    this.selectedDate = new Date(this.today);
    this.viewYear = this.today.getFullYear();
    this.viewMonth = this.today.getMonth();

    this.schedulerWrapper = document.getElementById("postSchedulerWrapper");
    this.calendarGrid = document.getElementById("postCalendarGrid");
    this.headerDateDisplay = document.getElementById("postHeaderDateDisplay");
    this.timeHeader = document.getElementById("postTimeHeader");
    this.calendarContainer = document.getElementById("postCalendarContainer");
    this.editModeBtn = document.getElementById("postEditModeBtn");

    // Ініціалізація модалок
    this.postModal = new PostModal();
    this.weekModal = new PlanyvannyaModal();

    // Initialize PostArxiv
    // We expect the container to exist because this runs on DOMContentLoaded
    try {
      this.postArxiv = new PostArxiv("postCalendarGrid");
    } catch (e) {
      // Fallback or handle error - though strictly TS requires init in constructor if not optional
      // To satisfy TS strict property init, we should probably assign it.
      // If it throws, the app might crash, which is acceptable if critical.
    }

    this.init();
  }

  private async init(): Promise<void> {
    // Завантажити дані з БД
    await this.loadDataFromDatabase();

    // Перевіряємо чи користувач адміністратор і створюємо кнопку редагування
    this.createEditButtonIfAdmin();

    // Навігація днями
    const headerPrev = document.getElementById("headerNavPrev");
    const headerNext = document.getElementById("headerNavNext");
    const todayBtn = document.getElementById("postTodayBtn");
    const weekBtn = document.getElementById("postWeekBtn");
    if (headerPrev)
      headerPrev.addEventListener("click", () => {
        if (this.isWeekView) {
          this.changeDate(-7);
        } else {
          this.changeDate(-1);
        }
      });
    if (headerNext)
      headerNext.addEventListener("click", () => {
        if (this.isWeekView) {
          this.changeDate(7);
        } else {
          this.changeDate(1);
        }
      });
    if (todayBtn) todayBtn.addEventListener("click", () => this.goToToday());
    if (weekBtn) weekBtn.addEventListener("click", () => this.toggleWeekView());

    const voiceBtn = document.getElementById(
      "postVoiceBtn",
    ) as HTMLButtonElement | null;
    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => this.handlePlannerVoiceClick());
    }

    // Навігація місяцями
    const monthPrev = document.getElementById("postYearPrev");
    const monthNext = document.getElementById("postYearNext");
    if (monthPrev)
      monthPrev.addEventListener("click", () => this.changeMonth(-1));
    if (monthNext)
      monthNext.addEventListener("click", () => this.changeMonth(1));

    // Edit Mode (тільки якщо кнопка була створена)
    if (this.editModeBtn) {
      this.editModeBtn.addEventListener("click", () => this.toggleEditMode());
    }

    // Активуємо кнопку тижневого виду
    if (weekBtn) {
      weekBtn.classList.add("active");
      weekBtn.textContent = "День";
    }

    this.initCalendarDrawer();

    this.render();
    this.updateTimeMarker();
    setInterval(() => this.updateTimeMarker(), 60000);

    // Закривати контекстне меню при кліку поза ним
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".post-context-menu")) {
        this.closeWeekContextMenu();
      }
    });

    // Завантажуємо дані: тижневий вид по дефолту
    if (this.isWeekView) {
      this.loadWeekArxivData();
    } else if (this.postArxiv) {
      this.postArxiv.loadArxivDataForCurrentDate();
    }

    // 📡 Підключаємо Realtime підписку для автоматичного оновлення
    try {
      initPostArxivRealtimeSubscription();
    } catch (e) {}
  }

  private initCalendarDrawer(): void {
    const container = document.getElementById("postPlanningContainer");
    const drawerBtn = document.getElementById(
      "postCalendarDrawerBtn",
    ) as HTMLButtonElement | null;
    const backdrop = document.getElementById(
      "postCalendarBackdrop",
    ) as HTMLButtonElement | null;
    const calendar = document.getElementById("postMiniCalendar");

    if (!container || !drawerBtn || !backdrop || !calendar) return;

    const setOpen = (isOpen: boolean) => {
      container.classList.toggle("post-calendar-open", isOpen);
      drawerBtn.setAttribute("aria-expanded", String(isOpen));
      calendar.setAttribute("aria-hidden", String(!isOpen));
    };

    drawerBtn.addEventListener("click", () => {
      setOpen(!container.classList.contains("post-calendar-open"));
    });

    backdrop.addEventListener("click", () => setOpen(false));

    calendar.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".day-container")) {
        setOpen(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        container.classList.contains("post-calendar-open")
      ) {
        setOpen(false);
      }
    });
  }

  private setPlannerVoiceButtonState(isListening: boolean): void {
    const voiceBtn = document.getElementById(
      "postVoiceBtn",
    ) as HTMLButtonElement | null;
    if (!voiceBtn) return;

    voiceBtn.classList.toggle("ai-chat-voice-btn--listening", isListening);
    voiceBtn.innerHTML = isListening
      ? `<span class="ai-voice-pulse">🔴</span>`
      : "🎙️";
  }

  private applyPlannerVoiceStatus(transcript: string): boolean {
    const text = transcript.toLowerCase();
    let targetStatus: string | null = null;

    if (/не\s*приїх/.test(text)) {
      targetStatus = "Не приїхав";
    } else if (/відремонт|готово|готовий|зроблено/.test(text)) {
      targetStatus = "Відремонтований";
    } else if (/в\s*роботі|у\s*роботі|в\s*процесі|ремонт/.test(text)) {
      targetStatus = "В роботі";
    } else if (/заплан|брон/.test(text)) {
      targetStatus = "Запланований";
    }

    if (!targetStatus) return false;

    const statusBtn = document.getElementById(
      "postArxivStatusBtn",
    ) as HTMLButtonElement | null;
    const statusText = document.getElementById("postArxivStatusText");
    if (!statusBtn || !statusText) return false;

    for (let i = 0; i < 6; i++) {
      if ((statusText.textContent || "").trim() === targetStatus) {
        return true;
      }
      statusBtn.click();
    }

    return (statusText.textContent || "").trim() === targetStatus;
  }

  private setPlannerComment(baseText: string, speechText: string): void {
    const textarea = document.getElementById(
      "postArxivComment",
    ) as HTMLTextAreaElement | null;
    if (!textarea) return;

    const cleanSpeech = speechText.trim();
    const prefix = baseText.trim();
    textarea.value = cleanSpeech
      ? prefix
        ? `${prefix} ${cleanSpeech}`
        : cleanSpeech
      : prefix;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private formatDateOnly(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  private normalizePlannerVoiceText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[’'`]/g, "")
      .replace(/[^a-zа-яіїєґ0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private stemPlannerWord(raw: string): string {
    const word = this.normalizePlannerVoiceText(raw);
    if (word.length <= 3) return word;

    const endings = [
      "ець",
      "ського",
      "ському",
      "ський",
      "ого",
      "ому",
      "ій",
      "ий",
      "ця",
      "цю",
      "цем",
      "ці",
      "а",
      "у",
      "ю",
      "ом",
      "ем",
      "і",
    ];

    for (const ending of endings) {
      if (word.endsWith(ending) && word.length - ending.length >= 3) {
        return word.slice(0, -ending.length);
      }
    }

    return word;
  }

  private parsePlannerVoiceDate(text: string): string {
    const base = new Date(this.selectedDate || new Date());
    base.setHours(0, 0, 0, 0);
    const normalized = this.normalizePlannerVoiceText(text);

    // Формати: 24.03, 24/03, 24-03, 24.03.2026
    const fullDateMatch = normalized.match(
      /\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/,
    );
    if (fullDateMatch) {
      const day = parseInt(fullDateMatch[1], 10);
      const month = parseInt(fullDateMatch[2], 10);
      let year = fullDateMatch[3]
        ? parseInt(fullDateMatch[3], 10)
        : base.getFullYear();

      if (fullDateMatch[3] && year < 100) year += 2000;

      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        let candidate = new Date(year, month - 1, day);
        candidate.setHours(0, 0, 0, 0);

        // Якщо рік не вказано і дата вже минула — переносимо на наступний рік
        if (!fullDateMatch[3] && candidate < base) {
          candidate = new Date(year + 1, month - 1, day);
          candidate.setHours(0, 0, 0, 0);
        }
        return this.formatDateOnly(candidate);
      }
    }

    // День тижня: "на вівторок", "на середу", "у п'ятницю" тощо
    const weekdayRules: Array<{ re: RegExp; day: number }> = [
      { re: /\bпонеділ(ок|ка|ку|ком)?\b/i, day: 1 },
      { re: /\bвівтор(ок|ка|ку|ком)?\b/i, day: 2 },
      { re: /\bсеред(а|у|ою|и)?\b/i, day: 3 },
      { re: /\bчетвер(г|га|гу|гом)?\b/i, day: 4 },
      { re: /\bп[’'`]?(я|ья)тниц(я|ю|і|ею)?\b/i, day: 5 },
      { re: /\bсубот(а|у|ою|і)?\b/i, day: 6 },
      { re: /\bнеділ(я|ю|і|ею)?\b/i, day: 0 },
    ];

    for (const rule of weekdayRules) {
      if (rule.re.test(normalized)) {
        const currentDay = base.getDay();
        let diff = (rule.day - currentDay + 7) % 7;
        if (diff === 0 && /на\s+/.test(normalized)) diff = 7;
        const candidate = new Date(base);
        candidate.setDate(base.getDate() + diff);
        return this.formatDateOnly(candidate);
      }
    }

    const dayOfMonthMatch = normalized.match(
      /(?:на\s+)?(\d{1,2})\s*(?:числа|го|число)?\b/i,
    );
    if (dayOfMonthMatch) {
      const day = parseInt(dayOfMonthMatch[1], 10);
      if (day >= 1 && day <= 31) {
        const y = base.getFullYear();
        const m = base.getMonth();
        let candidate = new Date(y, m, day);
        candidate.setHours(0, 0, 0, 0);

        if (candidate < base) {
          candidate = new Date(y, m + 1, day);
          candidate.setHours(0, 0, 0, 0);
        }
        return this.formatDateOnly(candidate);
      }
    }

    if (/післязавтра/.test(normalized)) {
      base.setDate(base.getDate() + 2);
      return this.formatDateOnly(base);
    }
    if (/завтра/.test(normalized)) {
      base.setDate(base.getDate() + 1);
      return this.formatDateOnly(base);
    }
    if (/сьогодні/.test(normalized)) {
      return this.formatDateOnly(base);
    }
    return this.formatDateOnly(base);
  }

  private parsePlannerVoiceTime(text: string): {
    startTime: string;
    endTime: string;
  } | null {
    const normalizedText = this.normalizePlannerVoiceText(text);

    const parseHourWord = (raw: string): number | null => {
      const w = this.normalizePlannerVoiceText(raw);
      if (!w) return null;
      if (/^\d{1,2}$/.test(w)) {
        const n = parseInt(w, 10);
        return n >= 0 && n <= 23 ? n : null;
      }

      const stems: Array<[string, number]> = [
        ["перш", 1],
        ["друг", 2],
        ["трет", 3],
        ["четверт", 4],
        ["пят", 5],
        ["шост", 6],
        ["сьом", 7],
        ["восьм", 8],
        ["девят", 9],
        ["десят", 10],
        ["одинадц", 11],
        ["дванадц", 12],
        ["тринадц", 13],
        ["чотирнадц", 14],
        ["пятнадц", 15],
        ["шістнадц", 16],
        ["шестнадц", 16],
        ["сімнадц", 17],
        ["вісімнадц", 18],
        ["девятнадц", 19],
        ["двадц", 20],
      ];

      for (const [stem, hour] of stems) {
        if (w.startsWith(stem)) return hour;
      }

      return null;
    };

    const normalizeToHalfHour = (
      h: number,
      m: number,
    ): { h: number; m: number } => {
      let hour = h;
      let minute = m;
      minute = minute < 15 ? 0 : minute < 45 ? 30 : 0;
      if (minute === 0 && m >= 45) {
        hour = Math.min(hour + 1, 23);
      }
      return { h: hour, m: minute };
    };

    const durationMatch = normalizedText.match(
      /(?:на\s*)?(\d{1,2})\s*(?:годин|години|год)\b/i,
    );
    const durationMin = durationMatch
      ? Math.max(30, parseInt(durationMatch[1], 10) * 60)
      : 60;

    // Фрази типу: "пів на десяту"
    const halfPastMatch = normalizedText.match(
      /(?:на\s+)?пів\s+(?:на|по)\s+([0-9]{1,2}|[а-яіїєґ]+)/i,
    );
    if (halfPastMatch) {
      const targetHour = parseHourWord(halfPastMatch[1]);
      if (targetHour !== null) {
        const startHour = targetHour <= 0 ? 0 : targetHour - 1;
        const startMins = startHour * 60 + 30;
        const endMins = Math.min(startMins + durationMin, 23 * 60 + 30);
        const endHour = Math.floor(endMins / 60);
        const endMinute = endMins % 60;
        return {
          startTime: `${String(startHour).padStart(2, "0")}:30`,
          endTime: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
        };
      }
    }

    // Фрази типу: "з дев'ятої до дванадцятої" / "з 9:00 по 12:00"
    const rangeMatch = normalizedText.match(
      /(?:з|c)\s*([0-9]{1,2}|[а-яіїєґ]+)(?::|\.|\s)?([0-9]{1,2})?\s*(?:до|по)\s*([0-9]{1,2}|[а-яіїєґ]+)(?::|\.|\s)?([0-9]{1,2})?/i,
    );
    if (rangeMatch) {
      const sh = parseHourWord(rangeMatch[1]);
      const sm = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : 0;
      const eh = parseHourWord(rangeMatch[3]);
      const em = rangeMatch[4] ? parseInt(rangeMatch[4], 10) : 0;

      if (
        sh !== null &&
        !isNaN(sm) &&
        eh !== null &&
        !isNaN(em) &&
        sh >= 0 &&
        sh <= 23 &&
        eh >= 0 &&
        eh <= 23 &&
        sm >= 0 &&
        sm <= 59 &&
        em >= 0 &&
        em <= 59
      ) {
        const startNorm = normalizeToHalfHour(sh, sm);
        const endNorm = normalizeToHalfHour(eh, em);
        const startHour = startNorm.h;
        const startMinute = startNorm.m;
        const endHour = endNorm.h;
        const endMinute = endNorm.m;

        const startTime = `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`;
        const endTime = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;
        if (endTime > startTime) return { startTime, endTime };
      }
    }

    // Фрази типу: "на дев'яту" / "о 9:30"
    const timeMatch = normalizedText.match(
      /(?:о|на|в)\s*([0-9]{1,2}|[а-яіїєґ]+)(?:[:.\s](\d{1,2}))?/i,
    );
    if (!timeMatch) return null;

    let hour = parseHourWord(timeMatch[1]);
    let minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

    if (hour === null || hour < 0 || hour > 23) return null;
    if (isNaN(minute) || minute < 0 || minute > 59) minute = 0;

    const singleNorm = normalizeToHalfHour(hour, minute);
    hour = singleNorm.h;
    minute = singleNorm.m;

    const startMins = hour * 60 + minute;
    const endMins = Math.min(startMins + durationMin, 23 * 60 + 30);
    const endHour = Math.floor(endMins / 60);
    const endMinute = endMins % 60;

    const startTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const endTime = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;

    return { startTime, endTime };
  }

  private detectPlannerVoiceStatus(text: string): string {
    const normalized = this.normalizePlannerVoiceText(text);
    if (/не\s*приїх/.test(normalized)) return "Не приїхав";
    if (/відремонт|готово|готовий|зроблено/.test(normalized))
      return "Відремонтований";
    if (/в\s*роботі|у\s*роботі|в\s*процесі|ремонт/.test(normalized))
      return "В роботі";
    if (/заплан|брон/.test(normalized)) return "Запланований";
    return "Запланований";
  }

  private parsePlannerVoiceClientAndCar(text: string): {
    clientName: string;
    clientPhone: string;
    carModel: string;
    carNumber: string;
  } {
    const raw = text;

    const digitWords: Record<string, string> = {
      нуль: "0",
      нол: "0",
      ноль: "0",
      ноля: "0",
      один: "1",
      одна: "1",
      одне: "1",
      два: "2",
      дві: "2",
      две: "2",
      три: "3",
      чотири: "4",
      чотирьох: "4",
      четыре: "4",
      пять: "5",
      пят: "5",
      пятьох: "5",
      пятьма: "5",
      пятью: "5",
      пяти: "5",
      "п'ять": "5",
      шість: "6",
      шесть: "6",
      сім: "7",
      семь: "7",
      вісім: "8",
      восемь: "8",
      девять: "9",
      "дев'ять": "9",
      девятью: "9",
      девяти: "9",
    };

    const spokenToDigits = (value: string): string => {
      const norm = this.normalizePlannerVoiceText(value)
        .replace(/\+/g, " + ")
        .replace(/\s+/g, " ")
        .trim();
      if (!norm) return "";

      const tokens = norm.split(" ");
      const out: string[] = [];
      for (const token of tokens) {
        if (!token) continue;
        const directDigits = token.replace(/\D/g, "");
        if (directDigits) {
          out.push(directDigits);
          continue;
        }

        if (digitWords[token]) {
          out.push(digitWords[token]);
          continue;
        }

        // Часті помилки розпізнавання на кшталт "девятой" / "шести"
        const stem = token
          .replace(/(ої|ой|ий|ій|ою|ую|ого|ому|и|і|а|у|ю|ь)$/g, "")
          .trim();
        if (digitWords[stem]) {
          out.push(digitWords[stem]);
        }
      }
      return out.join("");
    };

    const normalizeCarNumber = (value: string): string => {
      if (!value) return "";
      const withDigits = value
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .map((part) => {
          const d = spokenToDigits(part);
          return d || part;
        })
        .join("");

      return withDigits.replace(/[^0-9A-ZА-ЯІЇЄҐ]/gi, "").toUpperCase();
    };

    const cleanup = (value: string): string =>
      value
        .replace(/\s+/g, " ")
        .replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "")
        .trim();

    const clientMatch = raw.match(
      /клієнт\s+(.+?)(?=(?:\s+телефон|\s+авто|\s+машина|\s+автомобіль|\s+номер\s+авто|\s+коментар|\s+статус|$))/i,
    );
    const phoneMatch = raw.match(
      /(?:телефон|номер\s+телефону)\s+(.+?)(?=(?:\s+авто|\s+машина|\s+автомобіль|\s+номер\s+авто|\s+клієнт|\s+коментар|\s+статус|$))/i,
    );
    const carModelMatch = raw.match(
      /(?:авто|машина|автомобіль)\s+(.+?)(?=(?:\s+номер\s+авто|\s+номер|\s+клієнт|\s+телефон|\s+коментар|\s+статус|$))/i,
    );
    const carNumberMatch = raw.match(
      /(?:номер\s+авто|номер)\s+(.+?)(?=(?:\s+клієнт|\s+телефон|\s+авто|\s+машина|\s+автомобіль|\s+коментар|\s+статус|$))/i,
    );

    const clientName = cleanup(clientMatch?.[1] || "");
    const clientPhone = spokenToDigits(cleanup(phoneMatch?.[1] || ""));
    const carModel = cleanup(carModelMatch?.[1] || "");
    const carNumber = normalizeCarNumber(cleanup(carNumberMatch?.[1] || ""));

    return {
      clientName,
      clientPhone,
      carModel,
      carNumber,
    };
  }

  private buildPlannerVoiceComment(rawText: string): string {
    let text = rawText;

    text = text.replace(
      /(?:клієнт\s+.+?)(?=(?:\s+телефон|\s+авто|\s+машина|\s+автомобіль|\s+номер\s+авто|\s+коментар|\s+статус|$))/gi,
      " ",
    );
    text = text.replace(
      /(?:телефон|номер\s+телефону)\s+.+?(?=(?:\s+авто|\s+машина|\s+автомобіль|\s+номер\s+авто|\s+клієнт|\s+коментар|\s+статус|$))/gi,
      " ",
    );
    text = text.replace(
      /(?:авто|машина|автомобіль)\s+.+?(?=(?:\s+номер\s+авто|\s+номер|\s+клієнт|\s+телефон|\s+коментар|\s+статус|$))/gi,
      " ",
    );
    text = text.replace(
      /(?:номер\s+авто|номер)\s+.+?(?=(?:\s+клієнт|\s+телефон|\s+авто|\s+машина|\s+автомобіль|\s+коментар|\s+статус|$))/gi,
      " ",
    );

    text = text
      .replace(/\s+/g, " ")
      .replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "")
      .trim();

    if (!text) return "";

    const words = text.split(/\s+/);
    const compact: string[] = [];
    for (const w of words) {
      if (compact.length === 0 || compact[compact.length - 1] !== w) {
        compact.push(w);
      }
    }

    if (compact.length >= 6 && compact.length % 2 === 0) {
      const half = compact.length / 2;
      const first = compact.slice(0, half).join(" ");
      const second = compact.slice(half).join(" ");
      if (first === second) return first;
    }

    return compact.join(" ");
  }

  private findSlyusarByVoice(text: string): {
    slyusarId: number;
    namePost: number;
    slyusarName: string;
  } | null {
    const normalized = this.normalizePlannerVoiceText(text);
    const targetByNa = normalized.match(/(?:^|\s)на\s+([а-яіїєґa-z0-9]+)/i);
    const targetStem = targetByNa ? this.stemPlannerWord(targetByNa[1]) : "";
    const voiceWords = normalized
      .split(" ")
      .map((w) => this.stemPlannerWord(w))
      .filter((w) => w.length >= 3);

    let best: {
      slyusarId: number;
      namePost: number;
      slyusarName: string;
      score: number;
    } | null = null;

    for (const section of this.sections) {
      for (const post of section.posts) {
        const rawName = (post.subtitle || "").replace("👨‍🔧", "").trim();
        if (!rawName) continue;

        const lowName = this.normalizePlannerVoiceText(rawName);
        const nameWords = lowName
          .split(" ")
          .map((w) => this.stemPlannerWord(w))
          .filter((w) => w.length >= 2);
        const surnameStem = nameWords[0] || "";
        let score = 0;

        if (normalized.includes(lowName)) {
          score += 120;
        }

        if (surnameStem && normalized.includes(surnameStem)) {
          score += 100;
        }

        if (targetStem && surnameStem && targetStem === surnameStem) {
          score += 120;
        }

        if (
          surnameStem &&
          voiceWords.some(
            (w) =>
              w === surnameStem ||
              w.startsWith(surnameStem) ||
              surnameStem.startsWith(w),
          )
        ) {
          score += 90;
        }

        for (const nw of nameWords) {
          if (voiceWords.includes(nw)) score += 25;
        }

        if (!best || score > best.score) {
          best = {
            slyusarId: post.id,
            namePost: post.postId,
            slyusarName: rawName,
            score,
          };
        }
      }
    }

    if (!best || best.score < 50) return null;
    return {
      slyusarId: best.slyusarId,
      namePost: best.namePost,
      slyusarName: best.slyusarName,
    };
  }

  private async handlePlannerVoiceClick(): Promise<void> {
    if (!globalCache.generalSettings.voiceInputEnabled) {
      const voiceBtn = document.getElementById("postVoiceBtn");
      if (voiceBtn) voiceBtn.style.display = "none";
      return;
    }

    const modalOpen = !!document.getElementById("postArxivModalOverlay");

    if (this.plannerVoiceListening) {
      stopListening();
      this.plannerVoiceListening = false;
      this.setPlannerVoiceButtonState(false);
      hideVoiceOverlay();
      return;
    }

    if (!isSpeechRecognitionSupported()) {
      showNotification(
        "❌ Браузер не підтримує розпізнавання мови. Використовуйте Chrome.",
        "error",
        3000,
      );
      return;
    }

    const textarea = document.getElementById(
      "postArxivComment",
    ) as HTMLTextAreaElement | null;
    const baseText = (textarea?.value || "").trim();

    try {
      this.plannerVoiceListening = true;
      this.setPlannerVoiceButtonState(true);
      showVoiceOverlay(" Говоріть: кому і коли запланувати...");

      const transcript = await startChatVoiceInputRealtime((interim) => {
        showVoiceOverlay(`🎙️ ${interim}`);
      });

      const finalText = (transcript || "").trim();
      if (finalText) {
        if (modalOpen) {
          const statusApplied = this.applyPlannerVoiceStatus(finalText);
          this.setPlannerComment(baseText, finalText);

          if (statusApplied) {
            showNotification(
              "✅ Статус і коментар оновлено голосом",
              "success",
              2200,
            );
          } else {
            showNotification("✅ Коментар оновлено голосом", "success", 2200);
          }
        } else {
          const slyusar = this.findSlyusarByVoice(finalText);
          const time = this.parsePlannerVoiceTime(finalText) ?? {
            startTime: "08:00",
            endTime: "19:00",
          };
          const dateStr = this.parsePlannerVoiceDate(finalText);
          const parsed = this.parsePlannerVoiceClientAndCar(finalText);
          const status = this.detectPlannerVoiceStatus(finalText);
          const comment = this.buildPlannerVoiceComment(finalText);

          if (!slyusar) {
            showNotification(
              "⚠️ Не почув слюсаря. Приклад: 'на Шевченка на 24 число з 9:00 по 12:00 клієнт Іван'",
              "warning",
              3500,
            );
            return;
          }

          const reservation: ReservationData = {
            date: dateStr,
            startTime: time.startTime,
            endTime: time.endTime,
            clientId: null,
            clientName: parsed.clientName || "",
            clientPhone: parsed.clientPhone || "",
            carId: null,
            carModel: parsed.carModel || "",
            carNumber: parsed.carNumber || "",
            comment: comment || finalText,
            status,
            slyusarId: slyusar.slyusarId,
            namePost: slyusar.namePost,
            postArxivId: null,
            actId: null,
          };

          if (await this.handleWeekModalSubmit(reservation)) showNotification("Запис створено!", "success");
        }
      } else {
        showNotification(
          "⚠️ Мову не розпізнано. Спробуйте ще раз.",
          "warning",
          2200,
        );
      }
    } catch (err: any) {
      showNotification(
        err?.message || "❌ Помилка голосового вводу",
        "error",
        2200,
      );
    } finally {
      this.plannerVoiceListening = false;
      this.setPlannerVoiceButtonState(false);
      hideVoiceOverlay();
    }
  }

  private async loadDataFromDatabase(): Promise<void> {
    try {
      // 🔐 Перевіряємо доступ перед завантаженням даних
      const hasAccess = await checkCurrentPageAccess();

      if (!hasAccess) {
        redirectToIndex();
        return;
      }

      // Для планувальника потрібні лише ПІБ, ID та прив'язка до поста, без історії працівника.
      const { data: slyusarsData, error: slyusarsError } = await supabase
        .from("slyusars")
        .select("slyusar_id, namber, post_sluysar, name:data->>Name");

      if (slyusarsError) {
        throw slyusarsError;
      }

      // Запит 2: Отримуємо всі пости
      const { data: postsData, error: postsError } = await supabase
        .from("post_name")
        .select("post_id, name, category");

      if (postsError) {
        throw postsError;
      }

      // Запит 3: Отримуємо категорії
      const { data: categoriesData, error: categoriesError } = await supabase
        .from("post_category")
        .select("category_id, category");

      if (categoriesError) {
        throw categoriesError;
      }

      if (!slyusarsData || !postsData || !categoriesData) {
        throw new Error("Помилка завантаження даних");
      }

      this.staffNames = new Map(slyusarsData.map(row => [Number(row.slyusar_id), String(row.name || "")]));

      // Створюємо Map для швидкого пошуку постів
      const postsMap = new Map<number, any>(
        postsData.map((post: any) => [post.post_id, post]),
      );

      // Заповнюємо карти пошуку для нових створених елементів
      this.postTitleToIdMap.clear();
      postsData.forEach((post: any) => {
        this.postTitleToIdMap.set(post.name, post.post_id);
      });

      this.slyusarNameToIdMap.clear();
      slyusarsData.forEach((slyusar: any) => {
        if (slyusar.name) {
          // Зберігаємо з нормалізованим ключем (lowercase, trimmed)
          const normalizedName = slyusar.name.toLowerCase().trim();
          this.slyusarNameToIdMap.set(normalizedName, slyusar.slyusar_id);
        }
      });

      // Створюємо Map для перетворення category_id -> category name
      const categoryMap = new Map<string, string>(
        categoriesData.map((cat: any) => [
          String(cat.category_id),
          cat.category,
        ]),
      );

      // Трансформація даних - фільтруємо записи з пустим namber
      const slyusars: Sluysar[] = slyusarsData
        .filter(
          (item: any) => item.namber !== null && item.namber !== undefined,
        )
        .map((item: any) => {
          const post = postsMap.get(parseInt(item.post_sluysar));
          if (!post) return null;

          return {
            slyusar_id: item.slyusar_id,
            sluysar_name: `👨‍🔧 ${item.name || ""}`,
            namber: item.namber,
            post_name: post.name as string,
            post_id: post.post_id as number,
            category: String(post.category),
          };
        })
        .filter((item: Sluysar | null): item is Sluysar => item !== null);

      this.transformDataToSections(slyusars, categoryMap);
    } catch (error) {
      this.showError("Не вдалося завантажити дані. Спробуйте пізніше.");
    }
  }

  private transformDataToSections(
    data: Sluysar[],
    categoryMap: Map<string, string>,
  ): void {
    // Групування за category
    const grouped = data.reduce(
      (acc, item) => {
        if (!acc[item.category]) {
          acc[item.category] = [];
        }
        acc[item.category].push(item);
        return acc;
      },
      {} as Record<string, Sluysar[]>,
    );

    // Створення секцій
    this.sections = Object.entries(grouped).map(
      ([categoryId, items], index) => {
        // Сортування за namber всередині категорії
        items.sort((a, b) => a.namber - b.namber);

        // Отримуємо назву категорії з Map, якщо немає - використовуємо ID
        const categoryName = categoryMap.get(categoryId) || categoryId;

        return {
          id: index + 1,
          realCategoryId: categoryId,
          name: categoryName,
          collapsed: false,
          posts: items.map((item) => ({
            id: item.slyusar_id,
            postId: item.post_id,
            title: item.post_name,
            subtitle: item.sluysar_name,
            namber: item.namber,
          })),
        };
      },
    );

    // Сортування секцій за мінімальним namber у кожній секції
    this.sections.sort((a, b) => {
      const minA = Math.min(...a.posts.map((p) => p.namber));
      const minB = Math.min(...b.posts.map((p) => p.namber));
      return minA - minB;
    });
  }

  private showError(message: string): void {
    showNotification(message, "error", 5000);
  }

  private toggleEditMode(): void {
    if (this.editMode) {
      // Закриваємо режим редагування - перевіряємо чи є зміни
      this.handleEditModeClose();
    } else {
      // Відкриваємо режим редагування - зберігаємо початковий стан
      this.openEditMode();
    }
  }

  private openEditMode(): void {
    this.editMode = true;
    this.deletedSlyusarIds = [];

    // Зберігаємо початкові позиції
    this.saveInitialPositions();

    if (this.editModeBtn) {
      this.editModeBtn.classList.add("active");
    }

    if (this.schedulerWrapper) {
      this.schedulerWrapper.classList.add("edit-mode");
    }
  }

  private saveInitialPositions(): void {
    this.initialPositions = [];
    this.initialPostCategories.clear();

    this.sections.forEach((section, sectionIndex) => {
      section.posts.forEach((post, postIndex) => {
        if (post.postId > 0 && section.realCategoryId) {
          this.initialPostCategories.set(post.postId, String(section.realCategoryId));
        }
        const namber = sectionIndex + 1 + (postIndex + 1) / 10;
        this.initialPositions.push({
          slyusar_id: post.id,
          post_id: post.postId,
          original_namber: post.namber,
          current_namber: namber,
        });
      });
    });
  }

  private calculateCurrentPositions(): PositionData[] {
    const currentPositions: PositionData[] = [];
    const initialById = new Map(this.initialPositions.map(position => [position.slyusar_id, position]));

    this.sections.forEach((section, sectionIndex) => {
      section.posts.forEach((post, postIndex) => {
        const namber = sectionIndex + 1 + (postIndex + 1) / 10;
        const initial = initialById.get(post.id);
        currentPositions.push({
          slyusar_id: post.id,
          post_id: post.postId,
          original_namber: initial?.original_namber ?? post.namber,
          current_namber: namber,
          slyusar_name: post.subtitle,
          post_title: post.title,
        });
      });
    });

    return currentPositions;
  }

  private checkForChanges(): boolean {
    // Якщо є видалені елементи - є зміни
    if (this.deletedSlyusarIds.length > 0) {
      return true;
    }

    const currentPositions = this.calculateCurrentPositions();
    const initialById = new Map(this.initialPositions.map(position => [position.slyusar_id, position]));

    for (const current of currentPositions) {
      const initial = initialById.get(current.slyusar_id);
      if (!initial) return true;
      if (initial.post_id !== current.post_id) return true;
      if (Math.abs(initial.current_namber - current.current_namber) > 0.001) {
        return true;
      }
    }

    for (const section of this.sections) {
      for (const post of section.posts) {
        const previous = this.initialPostCategories.get(post.postId);
        if (previous !== undefined && previous !== String(section.realCategoryId)) return true;
      }
    }

    return false;
  }

  private handleEditModeClose(): void {
    const hasChanges = this.checkForChanges();

    if (hasChanges) {
      this.showConfirmationDialog();
    } else {
      this.closeEditMode();
    }
  }

  private showConfirmationDialog(): void {
    // Створюємо модальне вікно підтвердження
    const overlay = document.createElement("div");
    overlay.className = "post-confirm-overlay";
    overlay.innerHTML = `
      <div class="post-confirm-modal">
        <div class="post-confirm-title">Змінити дані налаштування?</div>
        <div class="post-confirm-buttons">
          <button class="post-confirm-btn post-confirm-yes">Так</button>
          <button class="post-confirm-btn post-confirm-no">Ні</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const yesBtn = overlay.querySelector<HTMLButtonElement>(".post-confirm-yes");
    const noBtn = overlay.querySelector<HTMLButtonElement>(".post-confirm-no");

    yesBtn?.addEventListener("click", async () => {
      if (this.positionsSavePending) return;
      yesBtn.disabled = true;
      if (noBtn) noBtn.disabled = true;
      yesBtn.textContent = "Збереження…";
      const saved = await this.savePositionsToDatabase();
      overlay.remove();
      if (saved) this.closeEditMode();
    });

    noBtn?.addEventListener("click", () => {
      overlay.remove();
      // Відновлюємо початковий стан - перезавантажуємо дані з БД
      showNotification("Зміни скасовано", "warning");
      this.restoreInitialState();
    });
  }

  private async savePositionsToDatabase(): Promise<boolean> {
    if (this.positionsSavePending) return false;
    this.positionsSavePending = true;
    const currentPositions = this.calculateCurrentPositions();

    try {
      let successCount = 0;
      const targetCategories = new Map<number, string>();
      for (const section of this.sections) {
        if (!section.realCategoryId) continue;
        for (const post of section.posts) {
          if (post.postId <= 0) continue;
          const category = String(section.realCategoryId);
          const alreadyAssigned = targetCategories.get(post.postId);
          if (alreadyAssigned !== undefined && alreadyAssigned !== category) {
            throw new Error(`Пост «${post.title}» опинився у різних цехах. Перемістіть усі його рядки в один цех.`);
          }
          targetCategories.set(post.postId, category);
        }
      }

      // Update only acknowledged baselines. A retry after a partial failure
      // sends the remaining changes and never creates an inserted worker twice.
      const rememberSavedPosition = (pos: PositionData, id: number, postId: number) => {
        const initial = this.initialPositions.find(item =>
          item.slyusar_id === pos.slyusar_id || item.slyusar_id === id);
        const snapshot: PositionData = {
          slyusar_id: id, post_id: postId,
          original_namber: pos.current_namber, current_namber: pos.current_namber,
        };
        if (initial) Object.assign(initial, snapshot);
        else this.initialPositions.push(snapshot);
        for (const section of this.sections) for (const post of section.posts) {
          if (post.id === pos.slyusar_id) {
            post.id = id;
            post.namber = pos.current_namber;
            if (postId > 0) post.postId = postId;
          }
        }
        pos.slyusar_id = id;
      };

      for (const pos of currentPositions) {
        let realSlyusarId = pos.slyusar_id;
        let realPostId = pos.post_id;
        let isNewSlyusar = false;

        // 1. Спробуємо знайти реальний post_id за назвою, якщо його немає
        if ((!realPostId || realPostId <= 0) && pos.post_title) {
          const foundPostId = this.postTitleToIdMap.get(pos.post_title);
          if (foundPostId) {
            realPostId = foundPostId;
            // console.log(`🔎 Знайдено post_id ${realPostId} для "${pos.post_title}"`);
          }
        }

        // 2. Якщо ID слюсаря тимчасовий (велике число), спробуємо знайти за ім'ям
        if (realSlyusarId > 100000) {
          // Очищаємо ім'я від емодзі якщо є
          const cleanName = pos.slyusar_name?.replace("👨‍🔧 ", "").trim();

          if (cleanName) {
            // Нормалізуємо для пошуку (lowercase)
            const normalizedName = cleanName.toLowerCase().trim();
            // console.log(`🔍 Шукаємо слюсаря: "${cleanName}" -> normalized: "${normalizedName}"`);
            // console.log(`📚 Доступні ключі в Map:`, Array.from(this.slyusarNameToIdMap.keys()));

            const foundSlyusarId = this.slyusarNameToIdMap.get(normalizedName);
            if (foundSlyusarId) {
              realSlyusarId = foundSlyusarId;
              // console.log(`✅ Знайдено існуючого слюсаря ID ${realSlyusarId} для "${cleanName}"`);
            } else {
              isNewSlyusar = true;
              // console.log(`🆕 Слюсаря "${cleanName}" не знайдено, буде створено нового`);
            }
          }
        }

        const initial = this.initialPositions.find(item => item.slyusar_id === realSlyusarId);
        const updateData: Record<string, number | string> = {};
        // Compare against the saved database order, not just the visual index:
        // existing gaps may need normalization to keep the new ordering valid.
        if (!initial || Math.abs(Number(initial.original_namber) - pos.current_namber) > 0.001) {
          updateData.namber = pos.current_namber;
        }
        if (realPostId > 0 && (!initial || initial.post_id !== realPostId)) {
          updateData.post_sluysar = String(realPostId);
        }

        // 4. Виконуємо запит (UPDATE або INSERT)
        if (isNewSlyusar) {
          // INSERT
          const cleanName = pos.slyusar_name?.replace("👨‍🔧 ", "").trim();
          if (cleanName) {
            const { data, error } = await supabase
              .from("slyusars")
              .insert({
                data: { Name: cleanName, Опис: {}, Доступ: "Слюсар" },
                namber: pos.current_namber,
                post_sluysar: realPostId > 0 ? String(realPostId) : null,
              })
              .select("slyusar_id");

            if (error) {
              throw error;
            }
            // console.log("✨ Створено нового слюсаря:", data);

            const insertedId = Number(data?.[0]?.slyusar_id);
            if (!Number.isSafeInteger(insertedId) || insertedId <= 0) throw new Error("База не підтвердила створення слюсаря.");
            this.slyusarNameToIdMap.set(cleanName.toLowerCase(), insertedId);
            rememberSavedPosition(pos, insertedId, realPostId);
            successCount++;
          } else {
            throw new Error("Не вказано ПІБ нового слюсаря.");
          }
        } else if (realSlyusarId > 0 && realSlyusarId < 100000) {
          if (!Object.keys(updateData).length) continue;
          // UPDATE (тільки для реальних ID)
          // console.log(`💾 Оновлюю slyusar_id ${realSlyusarId}:`, updateData);
          const { data, error } = await supabase
            .from("slyusars")
            .update(updateData)
            .eq("slyusar_id", realSlyusarId)
            .select("slyusar_id");

          if (error) {
            throw error;
          }
          if (!data?.some(row => Number(row.slyusar_id) === realSlyusarId)) {
            throw new Error("База не підтвердила зміну слюсаря. Перевірте доступ і повторіть збереження.");
          }
          rememberSavedPosition(pos, realSlyusarId, realPostId);
          successCount++;
        } else {
          throw new Error("Не вдалося визначити слюсаря для збереження поста.");
        }
      }

      // A post can be represented by several workers; save its category once.
      for (const [postId, category] of targetCategories) {
        if (this.initialPostCategories.get(postId) === category) continue;
        const { data, error } = await supabase.from("post_name")
          .update({ category }).eq("post_id", postId).select("post_id");
        if (error) throw error;
        if (!data?.some(row => Number(row.post_id) === postId)) {
          throw new Error("База не підтвердила зміну цеху. Перевірте доступ і повторіть збереження.");
        }
        this.initialPostCategories.set(postId, category);
        successCount++;
      }

      const currentIds = new Set(currentPositions.map(pos => pos.slyusar_id));
      const validDeletedIds = [...new Set(this.deletedSlyusarIds.filter(
        id => Number.isSafeInteger(id) && id > 0 && id < 100000 && !currentIds.has(id),
      ))];
      if (validDeletedIds.length) {
        const { data, error } = await supabase
          .from("slyusars")
          .update({ namber: null, post_sluysar: null })
          .in("slyusar_id", validDeletedIds).select("slyusar_id");
        if (error) throw error;
        const removed = new Set((data || []).map(row => Number(row.slyusar_id)));
        this.deletedSlyusarIds = this.deletedSlyusarIds.filter(id => !removed.has(id));
        this.initialPositions = this.initialPositions.filter(pos => !removed.has(pos.slyusar_id));
        if (validDeletedIds.some(id => !removed.has(id))) {
          throw new Error("База не підтвердила видалення всіх рядків. Перевірте доступ і повторіть збереження.");
        }
        successCount += removed.size;
      }

      if (successCount > 0) {
        showNotification("Налаштування успішно збережено!", "success");
        // Важливо: перезавантажуємо дані щоб отримати нові ID
        await this.restoreInitialState();
      }
      return true;
    } catch (error) {
      this.showError(error instanceof Error ? error.message : "Не вдалося зберегти налаштування. Спробуйте пізніше.");
      return false;
    } finally {
      this.positionsSavePending = false;
    }
  }

  private async restoreInitialState(): Promise<void> {
    // Перезавантажуємо дані з БД для відновлення початкового стану
    await this.loadDataFromDatabase();
    this.renderCurrentView();
    this.closeEditMode();
  }

  /**
   * Перемальовує поточний вид (денний або тижневий)
   */
  private renderCurrentView(): void {
    if (this.isWeekView) {
      this.renderWeekView();
      this.loadWeekArxivData();
    } else {
      this.renderSections();
      this.reloadArxivData();
    }
  }

  private closeEditMode(): void {
    this.editMode = false;
    this.initialPositions = [];
    this.deletedSlyusarIds = [];

    if (this.editModeBtn) {
      this.editModeBtn.classList.remove("active");
    }

    if (this.schedulerWrapper) {
      this.schedulerWrapper.classList.remove("edit-mode");
    }
  }

  private getUserAccessLevel(): { Name: string; Доступ: string } | null {
    try {
      const storedData = localStorage.getItem("userAuthData");
      if (!storedData) return null;
      return JSON.parse(storedData);
    } catch (error) {
      return null;
    }
  }

  private createEditButtonIfAdmin(): void {
    const userData = this.getUserAccessLevel();

    // Тільки для адміністратора створюємо кнопку
    if (userData && userData.Доступ === "Адміністратор") {
      const aside = document.getElementById("postMiniCalendar");
      if (!aside) return;

      const editButton = document.createElement("button");
      editButton.className = "post-edit-mode-btn";
      editButton.id = "postEditModeBtn";
      editButton.title = "Режим редагування";

      editButton.innerHTML = `
        <span class="icon-view">🔒</span>
        <span class="icon-edit">🔓</span>
      `;

      aside.appendChild(editButton);

      // Зберігаємо посилання на кнопку
      this.editModeBtn = editButton;
    }
  }

  private updateTimeMarker(): void {
    const now = new Date();

    // Оновлюємо today на випадок якщо сторінка відкрита після півночі
    const newToday = new Date();
    newToday.setHours(0, 0, 0, 0);
    this.today = newToday;

    const startOfToday = new Date(this.today);
    const selected = new Date(this.selectedDate);
    selected.setHours(0, 0, 0, 0);

    let decimal = 0;

    if (selected < startOfToday) {
      decimal = 1;
    } else if (selected.getTime() === startOfToday.getTime()) {
      const startHour = 8;
      const endHour = 20;
      const totalMinutes = (endHour - startHour) * 60;
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      let minutesPassed = (currentHour - startHour) * 60 + currentMin;
      if (minutesPassed < 0) minutesPassed = 0;
      if (minutesPassed > totalMinutes) minutesPassed = totalMinutes;
      decimal = minutesPassed / totalMinutes;
    } else {
      decimal = 0;
    }

    if (this.timeHeader) {
      (this.timeHeader as HTMLElement).style.setProperty(
        "--past-percentage",
        decimal.toString(),
      );
    }
    if (this.schedulerWrapper) {
      (this.schedulerWrapper as HTMLElement).style.setProperty(
        "--past-percentage",
        decimal.toString(),
      );
    }

    // === Оновлюємо тижневий вид в реальному часі ===
    if (this.isWeekView && this.calendarGrid) {
      this.updateWeekTimeElements(now);
    }
  }

  /**
   * Оновлює всі часові елементи тижневого виду:
   * червону лінію, минулий/майбутній overlay, годинні клітинки, overlay блоків
   */
  private updateWeekTimeElements(now: Date): void {
    if (!this.calendarGrid) return;

    const currentHour = now.getHours();
    const currentMins = (currentHour - 8) * 60 + now.getMinutes();
    const totalMins = 12 * 60;
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // 1. Оновлюємо годинні клітинки заголовка
    const dayColHeaders = this.calendarGrid.querySelectorAll(
      ".post-week-day-col-header",
    );
    dayColHeaders.forEach((col) => {
      const colEl = col as HTMLElement;
      const colDate = colEl.dataset.date;
      const isToday = colDate === todayStr;

      const hourCells = colEl.querySelectorAll(".post-week-hour-cell");
      hourCells.forEach((cell) => {
        const cellEl = cell as HTMLElement;
        const h = parseInt(cellEl.textContent || "0", 10);
        cellEl.classList.remove("hour-past", "hour-current", "hour-future");
        if (isToday) {
          if (h < currentHour) {
            cellEl.classList.add("hour-past");
          } else if (h === currentHour) {
            cellEl.classList.add("hour-current");
          } else {
            cellEl.classList.add("hour-future");
          }
        } else if (colDate && colDate < todayStr) {
          cellEl.classList.add("hour-past");
        }
      });
    });

    // 2. Оновлюємо доріжки днів: червону лінію, overlay минулого/майбутнього
    const dayTracks = this.calendarGrid.querySelectorAll(
      ".post-week-day-track",
    );
    dayTracks.forEach((track) => {
      const trackEl = track as HTMLElement;
      const trackDate = trackEl.dataset.date;
      const isToday = trackDate === todayStr;
      const isPast = trackDate ? trackDate < todayStr : false;

      // Видаляємо старі часові елементи (тільки track-рівень)
      trackEl
        .querySelectorAll(
          ".post-week-time-line, .post-week-past-overlay, .post-week-future-overlay",
        )
        .forEach((el) => {
          if (el.parentElement === trackEl) el.remove();
        });

      if (isToday && currentMins > 0) {
        const pastPercent = Math.min(currentMins / totalMins, 1) * 100;

        const pastOverlay = document.createElement("div");
        pastOverlay.className = "post-week-past-overlay";
        pastOverlay.style.width = `${pastPercent}%`;
        trackEl.appendChild(pastOverlay);

        const timeLine = document.createElement("div");
        timeLine.className = "post-week-time-line";
        timeLine.style.left = `${pastPercent}%`;
        trackEl.appendChild(timeLine);

        const futureOverlay = document.createElement("div");
        futureOverlay.className = "post-week-future-overlay";
        futureOverlay.style.left = `${pastPercent}%`;
        futureOverlay.style.right = "0";
        trackEl.appendChild(futureOverlay);
      } else if (isPast) {
        const pastOverlay = document.createElement("div");
        pastOverlay.className = "post-week-past-overlay";
        pastOverlay.style.width = "100%";
        trackEl.appendChild(pastOverlay);
      }
    });

    // 3. Оновлюємо overlay блоків бронювань
    const blocks = this.calendarGrid.querySelectorAll(".post-week-block");
    blocks.forEach((block) => {
      const blockEl = block as HTMLElement;
      const blockDate = blockEl.dataset.date;
      const startMins = parseInt(blockEl.dataset.start || "0", 10);
      const endMins = parseInt(blockEl.dataset.end || "0", 10);

      // Видаляємо старий overlay
      blockEl
        .querySelectorAll(".week-block-past-overlay")
        .forEach((el) => el.remove());
      blockEl.classList.remove("week-block-past");

      const isBlockPast = blockDate ? blockDate < todayStr : false;
      const isBlockToday = blockDate === todayStr;

      if (isBlockPast || (isBlockToday && endMins <= currentMins)) {
        // Повністю минулий блок
        blockEl.classList.add("week-block-past");
        const pastOverlay = document.createElement("div");
        pastOverlay.className = "week-block-past-overlay";
        pastOverlay.style.width = "100%";
        pastOverlay.style.borderRadius = "4px";
        blockEl.appendChild(pastOverlay);
      } else if (
        isBlockToday &&
        startMins < currentMins &&
        endMins > currentMins
      ) {
        // Частково минулий блок
        const pastFraction = Math.min(
          Math.max(
            ((currentMins - startMins) / (endMins - startMins)) * 100,
            0,
          ),
          100,
        );
        if (pastFraction > 0) {
          const pastOverlay = document.createElement("div");
          pastOverlay.className = "week-block-past-overlay";
          pastOverlay.style.width = `${pastFraction}%`;
          pastOverlay.style.borderRadius = "4px 0 0 4px";
          blockEl.appendChild(pastOverlay);
        }
      }
    });
  }

  private goToToday(): void {
    this.selectedDate = new Date(this.today);
    this.viewMonth = this.today.getMonth();
    this.viewYear = this.today.getFullYear();

    // Якщо тижневий вид — перемикаємось на денний вид сьогодні
    if (this.isWeekView) {
      this.isWeekView = false;
      const weekBtn = document.getElementById("postWeekBtn");
      if (weekBtn) {
        weekBtn.classList.remove("active");
        weekBtn.textContent = "Тиждень";
      }
      this.render();
      this.reloadArxivData();
      return;
    }

    // Якщо поточний місяць відображається - просто оновлюємо підсвічування
    if (this.isMonthVisible(this.viewMonth, this.viewYear)) {
      this.updateDateSelection();
      this.reloadArxivData();
    } else {
      // Якщо потрібно показати інший місяць - рендеримо повністю
      this.render();
      this.reloadArxivData();
    }
  }

  // ============== ТИЖНЕВИЙ ВИД ==============
  private toggleWeekView(): void {
    // Якщо є активний режим редагування — закриваємо його перед перемиканням виду
    if (this.editMode) {
      this.handleEditModeClose();
      return;
    }

    this.isWeekView = !this.isWeekView;
    const weekBtn = document.getElementById("postWeekBtn");
    if (weekBtn) {
      weekBtn.classList.toggle("active", this.isWeekView);
      weekBtn.textContent = this.isWeekView ? "День" : "Тиждень";
    }
    this.render();
    if (this.isWeekView) {
      this.loadWeekArxivData();
    } else {
      this.reloadArxivData();
    }
  }

  /**
   * Повертає початок тижня (понеділок) для заданої дати
   */
  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Понеділок = 1
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Повертає масив з 7 дат тижня (Пн-Нд)
   */
  private getWeekDays(date: Date): Date[] {
    const start = this.getWeekStart(date);
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }

  /**
   * Форматує дату для тижневого заголовка
   */
  private formatWeekRange(date: Date): string {
    const weekDays = this.getWeekDays(date);
    const first = weekDays[0];
    const last = weekDays[6];
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
    if (first.getMonth() === last.getMonth()) {
      return `${first.getDate()} – ${last.getDate()} ${months[first.getMonth()]} ${first.getFullYear()}`;
    } else {
      return `${first.getDate()} ${months[first.getMonth()]} – ${last.getDate()} ${months[last.getMonth()]} ${last.getFullYear()}`;
    }
  }

  /**
   * Рендерить тижневий вид планувальника (горизонтальний — дні зверху, години всередині кожного дня)
   */
  private renderWeekView(): void {
    const calendarGrid = this.calendarGrid;
    if (!calendarGrid) return;
    calendarGrid.innerHTML = "";

    const weekDays = this.getWeekDays(this.selectedDate);
    const shortDayNames = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "НД"];

    // Оновлюємо заголовок
    if (this.headerDateDisplay) {
      this.headerDateDisplay.textContent = this.formatWeekRange(
        this.selectedDate,
      );
    }

    // Ховаємо sticky-header денного виду
    const stickyHeader = document.querySelector(
      ".post-sticky-header",
    ) as HTMLElement;
    if (stickyHeader) stickyHeader.style.display = "none";

    // Додаємо клас тижневого виду
    if (this.schedulerWrapper) {
      this.schedulerWrapper.classList.add("week-view-mode");
    }

    const weekContainer = document.createElement("div");
    weekContainer.className = "post-week-container";

    // === Заголовок: кут + 7 колонок днів (кожна з годинами) ===
    const header = document.createElement("div");
    header.className = "post-week-header";

    const corner = document.createElement("div");
    corner.className = "post-week-corner";
    header.appendChild(corner);

    const daysHeader = document.createElement("div");
    daysHeader.className = "post-week-days-header";

    weekDays.forEach((day, idx) => {
      const isToday = day.toDateString() === this.today.toDateString();
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      const isPastDay = day < this.today && !isToday;

      const dayCol = document.createElement("div");
      dayCol.className = "post-week-day-col-header";
      const dayDateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      dayCol.dataset.date = dayDateStr;
      if (isToday) dayCol.classList.add("post-week-today");
      if (isWeekend) dayCol.classList.add("post-week-weekend");

      // Назва дня + дата (клікабельна — перехід у денний вид)
      const dayTitle = document.createElement("div");
      dayTitle.className = "post-week-day-title";
      dayTitle.textContent = `${shortDayNames[idx]} ${day.getDate()}`;
      dayTitle.addEventListener("click", () => {
        this.selectedDate = new Date(day);
        this.viewMonth = day.getMonth();
        this.viewYear = day.getFullYear();
        this.isWeekView = false;
        const weekBtn = document.getElementById("postWeekBtn");
        if (weekBtn) {
          weekBtn.classList.remove("active");
          weekBtn.textContent = "Тиждень";
        }
        this.render();
        this.reloadArxivData();
      });
      dayCol.appendChild(dayTitle);

      // Годинна шкала всередині дня (8–19, кожна година)
      const hoursRow = document.createElement("div");
      hoursRow.className = "post-week-hours-row";
      const nowForHeader = new Date();
      const currentHour = nowForHeader.getHours();
      for (let h = 8; h <= 19; h++) {
        const hourCell = document.createElement("div");
        hourCell.className = "post-week-hour-cell";
        if (h === 13) {
          hourCell.classList.add("hour-lunch"); // Обідня перерва
        }
        if (isToday) {
          if (h < currentHour) {
            hourCell.classList.add("hour-past");
          } else if (h === currentHour) {
            hourCell.classList.add("hour-current");
          } else {
            hourCell.classList.add("hour-future");
          }
        }
        if (isPastDay) {
          hourCell.classList.add("hour-past");
        }
        hourCell.textContent = h.toString();
        hoursRow.appendChild(hourCell);
      }
      dayCol.appendChild(hoursRow);
      daysHeader.appendChild(dayCol);
    });

    header.appendChild(daysHeader);
    weekContainer.appendChild(header);

    // === Тіло ===
    const weekBody = document.createElement("div");
    weekBody.className = "post-week-body";

    this.sections.forEach((section, sectionIndex) => {
      // Wrapper для секції (аналог post-section-group в денному виді)
      const sectionGroup = document.createElement("div");
      sectionGroup.className = "post-week-section-group";
      sectionGroup.dataset.sectionId = section.id.toString();
      sectionGroup.dataset.sectionIndex = sectionIndex.toString();

      // Хедер секції
      const sectionRow = document.createElement("div");
      sectionRow.className = "post-week-section-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "post-week-section-header-left";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = section.name;
      headerLeft.appendChild(nameSpan);
      sectionRow.appendChild(headerLeft);

      const headerRight = document.createElement("div");
      headerRight.className = "post-week-section-header-right";

      // Кнопка видалення секції (видима тільки в edit mode через CSS)
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "post-delete-btn";
      deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.deleteSection(section.id);
      };
      headerRight.appendChild(deleteBtn);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "post-toggle-btn";
      if (section.collapsed) toggleBtn.classList.add("collapsed");
      toggleBtn.textContent = "▼";
      headerRight.appendChild(toggleBtn);

      sectionRow.appendChild(headerRight);

      // Drag and drop для хедера секції - тільки в режимі редагування
      sectionRow.addEventListener("mousedown", (e) => {
        if (!this.editMode) return;
        const target = e.target as HTMLElement;
        if (
          target.closest(".post-delete-btn") ||
          target.closest(".post-toggle-btn")
        )
          return;
        e.preventDefault();
        this.startSectionDrag(e, sectionGroup, section.id);
      });

      // Click для toggle
      sectionRow.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".post-delete-btn")) return;
        if (this.editMode && !target.closest(".post-toggle-btn")) return;
        this.toggleSection(section.id);
        this.renderWeekView();
        this.loadWeekArxivData();
      });

      sectionGroup.appendChild(sectionRow);

      // Контент секції
      const sectionContent = document.createElement("div");
      sectionContent.className = "post-week-section-content";
      sectionContent.dataset.sectionId = section.id.toString();
      if (section.collapsed) sectionContent.classList.add("hidden");

      if (!section.collapsed) {
        section.posts.forEach((post) => {
          const row = document.createElement("div");
          row.className = "post-week-row";
          row.dataset.postId = post.id.toString();
          row.dataset.sectionId = section.id.toString();

          // Лейбл слюсаря (зліва)
          const label = document.createElement("div");
          label.className = "post-week-row-label";

          const deleteContainer = document.createElement("div");
          deleteContainer.className = "post-week-label-content";

          const labelContent = document.createElement("div");
          labelContent.className = "post-week-label-text";
          labelContent.innerHTML = `
            <div class="post-post-title">${post.title}</div>
            <div class="post-post-subtitle">${post.subtitle}</div>
          `;

          const postDeleteBtn = document.createElement("button");
          postDeleteBtn.className = "post-post-delete-btn";
          postDeleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>`;
          postDeleteBtn.onclick = (e) => {
            e.stopPropagation();
            this.deletePost(section.id, post.id);
          };

          deleteContainer.appendChild(labelContent);
          deleteContainer.appendChild(postDeleteBtn);
          label.appendChild(deleteContainer);

          // Drag and drop для лейбла - тільки в режимі редагування
          label.addEventListener("mousedown", (e) => {
            if (!this.editMode) return;
            const target = e.target as HTMLElement;
            if (target.closest(".post-post-delete-btn")) return;
            e.preventDefault();
            this.startPostDrag(e, row, section.id, post.id);
          });

          row.appendChild(label);

          // 7 треків днів поруч
          const tracksContainer = document.createElement("div");
          tracksContainer.className = "post-week-row-tracks";

          weekDays.forEach((day, idx) => {
            const isToday = day.toDateString() === this.today.toDateString();
            const isWeekend = day.getDay() === 0 || day.getDay() === 6;
            const isPast = day < this.today && !isToday;

            const dayTrack = document.createElement("div");
            dayTrack.className = "post-week-day-track";
            const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
            dayTrack.dataset.date = dateStr;
            dayTrack.dataset.slyusarId = post.id.toString();
            dayTrack.dataset.postId = post.postId.toString();

            if (isToday) dayTrack.classList.add("post-week-today");
            if (isWeekend) dayTrack.classList.add("post-week-weekend");
            if (idx < 6) dayTrack.classList.add("post-week-day-border");

            // Вертикальні лінії годин
            for (let h = 8; h <= 20; h++) {
              const timeMark = document.createElement("div");
              timeMark.className = "post-week-time-mark";
              timeMark.style.left = `${((h - 8) / 12) * 100}%`;
              dayTrack.appendChild(timeMark);
            }
            for (let h = 8; h < 20; h++) {
              const halfMark = document.createElement("div");
              halfMark.className = "post-week-time-mark half";
              halfMark.style.left = `${((h - 8 + 0.5) / 12) * 100}%`;
              dayTrack.appendChild(halfMark);
            }

            // Минулий час + червона лінія
            if (isToday) {
              const now = new Date();
              const currentMins = (now.getHours() - 8) * 60 + now.getMinutes();
              const totalMins = 12 * 60;
              if (currentMins > 0) {
                const pastPercent = Math.min(currentMins / totalMins, 1) * 100;
                const pastOverlay = document.createElement("div");
                pastOverlay.className = "post-week-past-overlay";
                pastOverlay.style.width = `${pastPercent}%`;
                dayTrack.appendChild(pastOverlay);

                const timeLine = document.createElement("div");
                timeLine.className = "post-week-time-line";
                timeLine.style.left = `${pastPercent}%`;
                dayTrack.appendChild(timeLine);
              }
              // Фон майбутнього часу
              const futureOverlay = document.createElement("div");
              futureOverlay.className = "post-week-future-overlay";
              const futureLeft = Math.min(
                (now.getHours() - 8) * 60 + now.getMinutes(),
                12 * 60,
              );
              futureOverlay.style.left = `${Math.max(0, (futureLeft / (12 * 60)) * 100)}%`;
              futureOverlay.style.right = "0";
              dayTrack.appendChild(futureOverlay);
            } else if (isPast) {
              const pastOverlay = document.createElement("div");
              pastOverlay.className = "post-week-past-overlay";
              pastOverlay.style.width = "100%";
              dayTrack.appendChild(pastOverlay);
            }

            // Обідня смуга 13:00–14:00 (аналог суботи)
            const lunchOverlay = document.createElement("div");
            lunchOverlay.className = "post-week-lunch-overlay";
            // 13:00 = 5 год від 8:00 = 5/12 * 100%, шириною 1/12 * 100%
            lunchOverlay.style.left = `${(5 / 12) * 100}%`;
            lunchOverlay.style.width = `${(1 / 12) * 100}%`;
            dayTrack.appendChild(lunchOverlay);

            // Drag-to-create
            this.attachWeekCellDragHandlers(dayTrack);

            tracksContainer.appendChild(dayTrack);
          });

          row.appendChild(tracksContainer);
          sectionContent.appendChild(row);
        });

        // Кнопка "Додати пост" (видима тільки в edit mode через CSS)
        const addPostBtn = document.createElement("button");
        addPostBtn.className = "post-add-post-btn";
        addPostBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Додати пост
        `;
        addPostBtn.onclick = () => this.openAddPostModal(section.name);
        sectionContent.appendChild(addPostBtn);
      }

      sectionGroup.appendChild(sectionContent);
      weekBody.appendChild(sectionGroup);
    });

    weekContainer.appendChild(weekBody);
    calendarGrid.appendChild(weekContainer);
  }

  /**
   * Завантажує дані бронювань за весь тиждень
   */
  private async loadWeekArxivData(strict = false): Promise<void> {
    const scope = localStorage.getItem("userAuthData") || "";
    const readVersion = capturePlannerReadVersion();
    const generation = ++this.weekReadGeneration;
    const weekDays = this.getWeekDays(this.selectedDate);
    const startDate = `${weekDays[0].getFullYear()}-${String(weekDays[0].getMonth() + 1).padStart(2, "0")}-${String(weekDays[0].getDate()).padStart(2, "0")}`;
    const lastDay = weekDays[6];
    const endDate = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;

    try {
      let arxivRecords = await readPlannerBookings(startDate + 'T00:00:00', endDate + 'T23:59:59');
      while (this.weekIsBlockDragging || this.weekIsResizing || this.weekDragActive) {
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      if (scope !== (localStorage.getItem("userAuthData") || "") || !this.isWeekView || generation !== this.weekReadGeneration || this.getWeekDays(this.selectedDate)[0].getTime() !== weekDays[0].getTime()) return;
      arxivRecords = rememberPlannerBookings(arxivRecords, readVersion, {
        start: startDate + 'T00:00:00', end: endDate + 'T23:59:59', staff: null,
      });
      this.calendarGrid?.querySelectorAll(".post-week-block").forEach(block => block.remove());
      const clientsMap = new Map<number, any>(), carsMap = new Map<number, any>();
      for (const record of arxivRecords) {
        clientsMap.set(Number(record.client_id), record.client_data);
        carsMap.set(Number(record.cars_id), record.car_data);
      }

      // Рендеримо блоки
      for (const record of arxivRecords) {
        this.renderWeekArxivRecord(record, clientsMap, carsMap);
      }
    } catch (err) {
      showNotification("Не вдалося завантажити записи планувальника", "error");
      if (strict) throw err;
    }
  }

  /**
   * Рендерить один запис бронювання у тижневому виді (горизонтально)
   */
  private renderWeekArxivRecord(
    record: any,
    clientsMap: Map<number, any>,
    carsMap: Map<number, any>,
  ): void {
    const dataOn = new Date(record.data_on);
    const dateStr = `${dataOn.getUTCFullYear()}-${String(dataOn.getUTCMonth() + 1).padStart(2, "0")}-${String(dataOn.getUTCDate()).padStart(2, "0")}`;

    // Шукаємо трек за датою та slyusar_id
    const dayTrack = this.calendarGrid?.querySelector(
      `.post-week-day-track[data-date="${dateStr}"][data-slyusar-id="${record.slyusar_id}"]`,
    ) as HTMLElement;

    if (!dayTrack) return;

    const dataOff = new Date(record.data_off);
    const startMins = (dataOn.getUTCHours() - 8) * 60 + dataOn.getUTCMinutes();
    const endMins = (dataOff.getUTCHours() - 8) * 60 + dataOff.getUTCMinutes();
    const totalMinutes = 12 * 60;

    if (startMins < 0 || endMins > totalMinutes) return;

    // Парсимо клієнта/авто
    let clientName = "";
    let clientPhone = "";
    let carModel = "";
    let carNumber = "";
    const clientIdStr = String(record.client_id || "");
    if (clientIdStr.includes("|||")) {
      const parts = clientIdStr.split("|||");
      clientName = parts[0] || "";
      clientPhone = parts[1] || "";
    } else if (!isNaN(Number(clientIdStr))) {
      const cd = clientsMap.get(Number(clientIdStr));
      if (cd) { clientName = cd["ПІБ"] || ""; clientPhone = cd["Телефон"] || ""; }
    }
    const carsIdStr = String(record.cars_id || "");
    if (carsIdStr.includes("|||")) {
      const parts = carsIdStr.split("|||");
      carModel = parts[0] || "";
      carNumber = parts[1] || "";
    } else if (!isNaN(Number(carsIdStr))) {
      const cd = carsMap.get(Number(carsIdStr));
      if (cd) {
        carModel = cd["Авто"] || "";
        carNumber = cd["Номер авто"] || "";
      }
    }

    // Кольори статусів
    const statusColors: Record<string, string> = {
      Запланований: "#e6a700",
      "В роботі": "#2e7d32",
      Відремонтований: "#757575",
      "Не приїхав": "#e53935",
    };

    // Горизонтальне позиціонування (left / width)
    const leftPercent = (startMins / totalMinutes) * 100;
    const widthPercent = ((endMins - startMins) / totalMinutes) * 100;
    const status = record.status || "Запланований";

    this.calendarGrid?.querySelectorAll<HTMLElement>('[data-post-arxiv-id]').forEach(existing => {
      if (existing.dataset.postArxivId === String(record.post_arxiv_id)) existing.remove();
    });
    const block = document.createElement("div");
    block.className = "post-week-block";
    block.style.left = `${leftPercent}%`;
    block.style.width = `${widthPercent}%`;
    block.style.backgroundColor =
      statusColors[status] || statusColors["Запланований"];

    // Обробляємо «минулий час» — клас для повністю минулих
    // Overlay додаємо ПІСЛЯ block.innerHTML (щоб не стерлося)
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const nowLocalMinsCheck = (now.getHours() - 8) * 60 + now.getMinutes();

    if (
      dateStr < nowStr ||
      (dateStr === nowStr && endMins <= nowLocalMinsCheck)
    ) {
      block.classList.add("week-block-past");
    }

    // Data-атрибути
    block.dataset.postArxivId = record.post_arxiv_id?.toString() || "";
    block.dataset.slyusarId = record.slyusar_id?.toString() || "";
    block.dataset.status = status;
    block.dataset.clientName = clientName;
    block.dataset.clientPhone = clientPhone;
    block.dataset.carModel = carModel;
    block.dataset.carNumber = carNumber;
    block.dataset.start = startMins.toString();
    block.dataset.end = endMins.toString();
    block.dataset.date = dateStr;
    block.dataset.xtoZapusav = record.xto_zapusav || "";
    block.dataset.comment = record.komentar || "";
    block.dataset.actId = record.act_id?.toString() || "";
    block.dataset.namePost = record.name_post?.toString() || "";

    // Час
    const startH = String(dataOn.getUTCHours()).padStart(2, "0");
    const startM = String(dataOn.getUTCMinutes()).padStart(2, "0");
    const endH = String(dataOff.getUTCHours()).padStart(2, "0");
    const endM = String(dataOff.getUTCMinutes()).padStart(2, "0");

    // Текст блоку — вертикально з емодзі
    const commentText = record.komentar || "";
    let blockHTML = `<div class="post-week-block-line">🕐 ${startH}:${startM}-${endH}:${endM}</div>`;
    if (clientName) {
      blockHTML += `<div class="post-week-block-line">👤 ${clientName}</div>`;
    }
    if (carModel || carNumber) {
      blockHTML += `<div class="post-week-block-line">🚗 ${carModel}${carNumber ? " " + carNumber : ""}</div>`;
    }
    if (commentText) {
      blockHTML += `<div class="post-week-block-line">💬 ${commentText}</div>`;
    }
    block.innerHTML = blockHTML;

    // ✅ Overlay додається ПІСЛЯ innerHTML (щоб не було стерто)
    // Використовуємо вже обчислені nowStr / nowLocalMinsCheck
    if (
      dateStr < nowStr ||
      (dateStr === nowStr && endMins <= nowLocalMinsCheck)
    ) {
      // ПОВНІСТЮ минулий — лавандовий overlay на 100%
      block.classList.add("week-block-past");
      const pastOverlay = document.createElement("div");
      pastOverlay.className = "week-block-past-overlay";
      pastOverlay.style.width = "100%";
      pastOverlay.style.borderRadius = "4px";
      block.appendChild(pastOverlay);
    } else if (
      dateStr === nowStr &&
      startMins < nowLocalMinsCheck &&
      endMins > nowLocalMinsCheck
    ) {
      // ЧАСТКОВО минулий — overlay до поточної хвилини (локальний час)
      const pastFraction = Math.min(
        Math.max(
          ((nowLocalMinsCheck - startMins) / (endMins - startMins)) * 100,
          0,
        ),
        100,
      );
      if (pastFraction > 0) {
        const pastOverlay = document.createElement("div");
        pastOverlay.className = "week-block-past-overlay";
        pastOverlay.style.width = `${pastFraction}%`;
        pastOverlay.style.borderRadius = "4px 0 0 4px";
        block.appendChild(pastOverlay);
      }
    }

    // Resize handles (лівий і правий)
    const leftHandle = document.createElement("div");
    leftHandle.className = "week-resize-handle left";
    block.appendChild(leftHandle);

    const rightHandle = document.createElement("div");
    rightHandle.className = "week-resize-handle right";
    block.appendChild(rightHandle);

    leftHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleWeekResizeMouseDown(e, block, "left");
    });
    rightHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleWeekResizeMouseDown(e, block, "right");
    });

    // Context menu (правий клік) — видалення
    block.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showWeekContextMenu(e, block);
    });

    // Drag-move при mousedown на блоці
    block.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".week-resize-handle")) return;
      e.preventDefault();
      e.stopPropagation();
      this.handleWeekBlockMouseDown(e, block);
    });

    // Тултіп
    const comment = record.komentar || "";
    const actId = record.act_id || "";
    const xtoZapusav = record.xto_zapusav || "";
    const statusEmoji: Record<string, string> = {
      Запланований: "📋",
      "В роботі": "🔧",
      Відремонтований: "✅",
      "Не приїхав": "❌",
    };
    const emoji = statusEmoji[status] || "📋";

    const tooltip = document.createElement("div");
    tooltip.className = "post-week-tooltip";
    // Порядок: ПІБ → Авто → Телефон → час/тривалість → статус → решта
    let tooltipHTML = `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">👤</span> <strong class="pw-tip-client">${clientName || "—"}</strong></div>`;
    tooltipHTML += `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">🚗</span> <span class="pw-tip-car">${carModel || "—"} <span class="pw-tip-number">${carNumber || ""}</span></span></div>`;
    if (clientPhone) {
      tooltipHTML += `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">📞</span> <span class="pw-tip-phone">${clientPhone}</span></div>`;
    }
    // Тривалість
    const durationMins = endMins - startMins;
    const durH = Math.floor(durationMins / 60);
    const durM = durationMins % 60;
    const durStr =
      durM > 0 ? `${durH}:${String(durM).padStart(2, "0")}` : `${durH}:00`;
    tooltipHTML += `<div class="post-week-tooltip-row pw-tip-duration"><span class="pw-tip-emoji">🕐</span> <span class="pw-tip-time-range">${startH}:${startM} — ${endH}:${endM} / ${durStr}</span></div>`;
    tooltipHTML += `<div class="post-week-tooltip-row pw-tip-status-row" data-status="${status}"><span class="pw-tip-emoji">${emoji}</span> <span class="pw-tip-status">${status}</span></div>`;
    if (comment) {
      tooltipHTML += `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">💬</span> <span class="pw-tip-comment">${comment}</span></div>`;
    }
    if (actId) {
      tooltipHTML += `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">📄</span> <span class="pw-tip-act">Акт №${actId}</span></div>`;
    }
    if (xtoZapusav) {
      tooltipHTML += `<div class="post-week-tooltip-row"><span class="pw-tip-emoji">✍️</span> <span class="pw-tip-author">${xtoZapusav}</span></div>`;
    }
    tooltip.innerHTML = tooltipHTML;
    block.appendChild(tooltip);

    // Позиціонування тултіпа: вниз, якщо не вміщується вверх
    block.addEventListener("mouseenter", () => {
      const blockRect = block.getBoundingClientRect();
      // Тултіп прихований (display:none), тому offsetHeight=0 — беремо запас 240px
      // (це більше за будь-який реальний тултіп з усіма рядками)
      const spaceAbove = blockRect.top;
      const neededSpace = 240;

      if (spaceAbove < neededSpace) {
        tooltip.classList.add("tooltip-below");
      } else {
        tooltip.classList.remove("tooltip-below");
      }
    });

    // Кружечок з номером акту
    if (actId) {
      const actBadge = document.createElement("div");
      actBadge.className = "post-week-act-badge";
      actBadge.textContent = String(actId);
      actBadge.dataset.actLabel = `Акт №${actId}`;
      actBadge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof (window as any).openActModal === "function") {
          (window as any).openActModal(actId);
        }
      });
      actBadge.addEventListener("mousedown", (e) => {
        e.stopPropagation();
      });
      block.appendChild(actBadge);
    }

    // Подвійний клік — редагування
    block.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const currentUser = this.getCurrentUserName();
      const currentAccess = this.getCurrentUserAccess();
      const creator = block.dataset.xtoZapusav || "";
      if (
        currentAccess !== "Адміністратор" &&
        creator &&
        creator !== currentUser
      ) {
        showNotification(
          `Ви не можете редагувати цей запис. Створив: ${creator}`,
          "error",
        );
        return;
      }

      const blockStartMins = parseInt(block.dataset.start || "0");
      const blockEndMins = parseInt(block.dataset.end || "0");
      const startTimeStr = this.weekMinsToTime(blockStartMins);
      const endTimeStr = this.weekMinsToTime(blockEndMins);

      const detailData: Partial<ReservationData> = {
        clientName: block.dataset.clientName || "",
        clientPhone: block.dataset.clientPhone || "",
        carModel: block.dataset.carModel || "",
        carNumber: block.dataset.carNumber || "",
        status: block.dataset.status || "Запланований",
        comment: block.dataset.comment || "",
        postArxivId: parseInt(block.dataset.postArxivId || "0") || null,
        slyusarId: parseInt(block.dataset.slyusarId || "0") || null,
        namePost: parseInt(block.dataset.namePost || "0") || null,
        actId: parseInt(block.dataset.actId || "0") || null,
      };

      const slyusarIdNum = detailData.slyusarId || null;
      const excludeId = detailData.postArxivId || undefined;

      this.weekModal.open(
        block.dataset.date || dateStr,
        startTimeStr,
        endTimeStr,
        detailData.comment || "",
        detailData,
        (resultData: ReservationData) => this.handleWeekModalSubmit(resultData),
        async (date, start, end, _exId) => {
          return this.checkWeekAvailability(
            date,
            start,
            end,
            slyusarIdNum,
            excludeId,
          );
        },
        [],
      );
    });

    dayTrack.appendChild(block);
  }

  // ============== ТИЖНЕВИЙ ВИД — СТВОРЕННЯ ЗАПИСУ ЧЕРЕЗ DRAG ==============

  /** Отримує ім'я поточного користувача з localStorage */
  private getCurrentUserName(): string {
    try {
      const stored = localStorage.getItem("userAuthData");
      if (stored) {
        const userData = JSON.parse(stored);
        return userData.Name || "";
      }
    } catch {}
    return "";
  }

  /** Отримує рівень доступу поточного користувача */
  private getCurrentUserAccess(): string {
    try {
      const stored = localStorage.getItem("userAuthData");
      if (stored) {
        const userData = JSON.parse(stored);
        return userData.access || "";
      }
    } catch {}
    return "";
  }

  /** Контекстне меню для видалення запису у тижневому виді */
  private showWeekContextMenu(e: MouseEvent, block: HTMLElement): void {
    this.closeWeekContextMenu();

    const menu = document.createElement("div");
    menu.className = "post-context-menu";

    const deleteItem = document.createElement("div");
    deleteItem.className = "post-context-menu-item delete";
    deleteItem.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
      Видалити запис
    `;

    deleteItem.addEventListener("click", async () => {
      const postArxivId = block.dataset.postArxivId;
      if (!postArxivId) {
        this.closeWeekContextMenu();
        return;
      }

      try {
        const { data: recordData, error: fetchError } = await supabase
          .from("post_arxiv")
          .select("xto_zapusav")
          .eq("post_arxiv_id", parseInt(postArxivId))
          .single();

        if (fetchError) {
          showNotification("Помилка перевірки прав доступу", "error");
          this.closeWeekContextMenu();
          return;
        }

        const currentUser = this.getCurrentUserName();
        const currentAccess = this.getCurrentUserAccess();
        const isAdmin = currentAccess === "Адміністратор";
        const recordCreator = recordData?.xto_zapusav;

        if (!isAdmin) {
          if (!recordCreator || recordCreator !== currentUser) {
            const msg = recordCreator
              ? `Ви не можете видалити цей запис. Зверніться до ${recordCreator}`
              : `Ви не можете видалити цей запис. Зверніться до адміністратора`;
            showNotification(msg, "error");
            this.closeWeekContextMenu();
            return;
          }
        }

        const previous = getPlannerRecord(postArxivId);
        const { data: removed, error } = await supabase
          .from("post_arxiv")
          .delete()
          .eq("post_arxiv_id", parseInt(postArxivId)).select("post_arxiv_id").maybeSingle();

        if (error || !removed) {
          showNotification("Помилка видалення запису", "error");
          this.closeWeekContextMenu();
          return;
        }

        publishPlannerChange("DELETE", { post_arxiv_id: Number(postArxivId) }, previous);

        await logAction(
          "planning_delete",
          null,
          {
            post_arxiv_id: postArxivId,
            client: block.dataset.clientName,
            car: block.dataset.carModel,
            status: block.dataset.status,
            time: `${block.dataset.start || ""}–${block.dataset.end || ""}`,
          },
          "planning",
        );
      } catch {
        showNotification("Виникла помилка при видаленні", "error");
        this.closeWeekContextMenu();
        return;
      }

      block.remove();
      this.closeWeekContextMenu();
      showNotification("Запис видалено", "success");


    });

    menu.appendChild(deleteItem);
    document.body.appendChild(menu);

    menu.style.top = `${e.pageY}px`;
    menu.style.left = `${e.pageX}px`;
  }

  private closeWeekContextMenu(): void {
    const existing = document.querySelector(".post-context-menu");
    if (existing) {
      existing.remove();
    }
  }

  /**
   * Конвертує хвилини від початку робочого дня в рядок "HH:MM"
   */
  private weekMinsToTime(mins: number): string {
    const h = 8 + Math.floor(mins / 60);
    const m = mins % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }

  /**
   * Прив'язує обробники drag-to-create до трека дня тижневого виду
   */
  private attachWeekCellDragHandlers(dayTrack: HTMLElement): void {
    dayTrack.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".post-week-block")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();

      this.weekDragActive = true;
      this.weekDragCell = dayTrack;
      const rect = dayTrack.getBoundingClientRect();
      this.weekDragStartX = e.clientX - rect.left;
      this.weekDragCurrentX = this.weekDragStartX;

      if (!this.weekSelectionEl) {
        this.weekSelectionEl = document.createElement("div");
        this.weekSelectionEl.className = "post-week-selection";
      }
      this.weekSelectionEl.style.left = `${this.weekDragStartX}px`;
      this.weekSelectionEl.style.width = "0px";
      this.weekSelectionEl.style.display = "block";
      dayTrack.appendChild(this.weekSelectionEl);

      document.addEventListener("pointermove", this.onWeekDragMove);
      document.addEventListener("pointerup", this.onWeekDragUp);
      document.addEventListener("pointercancel", this.onWeekDragCancel);
    });
  }

  private onWeekDragMove = (e: PointerEvent): void => {
    if (!this.weekDragActive || !this.weekDragCell || !this.weekSelectionEl)
      return;

    e.preventDefault();
    const rect = this.weekDragCell.getBoundingClientRect();
    let x = e.clientX - rect.left;
    if (x < 0) x = 0;
    if (x > rect.width) x = rect.width;
    this.weekDragCurrentX = x;

    const left = Math.min(this.weekDragStartX, this.weekDragCurrentX);
    const width = Math.abs(this.weekDragCurrentX - this.weekDragStartX);
    this.weekSelectionEl.style.left = `${left}px`;
    this.weekSelectionEl.style.width = `${width}px`;

    // ── Підсвічуємо комірки-години в заголовку ────────────────
    this.clearDragHourHighlight();
    if (width < 5) return;

    // Діапазон clientX перетягування
    const dragClientLeft = rect.left + left;
    const dragClientRight = dragClientLeft + width;

    // Знаходимо заголовок дня за датою треку
    const dateStr = this.weekDragCell.dataset.date || "";
    if (!dateStr || !this.calendarGrid) return;

    const weekDays = this.getWeekDays(this.selectedDate);
    const dayIndex = weekDays.findIndex((d) => {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return ds === dateStr;
    });
    if (dayIndex < 0) return;

    const dayColHeaders = this.calendarGrid.querySelectorAll(
      ".post-week-day-col-header",
    );
    const dayColHeader = dayColHeaders[dayIndex] as HTMLElement;
    if (!dayColHeader) return;

    const hourCells = Array.from(
      dayColHeader.querySelectorAll(".post-week-hour-cell"),
    ) as HTMLElement[];

    // Знаходимо cellIdx початку і кінця через порівняння BoundingRect
    let firstActive = -1;
    let lastActive = -1;

    hourCells.forEach((cell, i) => {
      const cr = cell.getBoundingClientRect();
      // Комірка активна якщо перетинається з drag-діапазоном (хоча б частково)
      if (cr.right > dragClientLeft && cr.left < dragClientRight) {
        if (firstActive < 0) firstActive = i;
        lastActive = i;
        cell.classList.add("hour-drag-active");
      }
    });

    // Час початку і кінця (кроки по 30 хв)
    const totalMinutes = 12 * 60;
    const cellWidth = rect.width;
    const p1 = Math.min(this.weekDragStartX, this.weekDragCurrentX);
    const p2 = Math.max(this.weekDragStartX, this.weekDragCurrentX);
    const startMins = Math.round(((p1 / cellWidth) * totalMinutes) / 30) * 30;
    const endMins = Math.round(((p2 / cellWidth) * totalMinutes) / 30) * 30;

    if (firstActive >= 0 && lastActive >= 0) {
      // Перша комірка — час початку
      const sH = 8 + Math.floor(startMins / 60);
      const sM = startMins % 60;
      hourCells[firstActive].textContent =
        sM > 0 ? `${sH}:${String(sM).padStart(2, "0")}` : `${sH}`;

      // Остання комірка — час кінця
      if (lastActive !== firstActive) {
        const eH = 8 + Math.floor(endMins / 60);
        const eM = endMins % 60;
        hourCells[lastActive].textContent =
          eM > 0 ? `${eH}:${String(eM).padStart(2, "0")}` : `${eH}`;
      }
    }
  };

  private removeWeekDragPointerListeners(): void {
    document.removeEventListener("pointermove", this.onWeekDragMove);
    document.removeEventListener("pointerup", this.onWeekDragUp);
    document.removeEventListener("pointercancel", this.onWeekDragCancel);
  }

  private onWeekDragUp = (_e: PointerEvent): void => {
    this.removeWeekDragPointerListeners();

    if (!this.weekDragActive || !this.weekDragCell) {
      this.resetWeekSelection();
      return;
    }

    this.weekDragActive = false;
    const cell = this.weekDragCell;
    const rect = cell.getBoundingClientRect();
    const cellWidth = rect.width;
    const totalMinutes = 12 * 60;

    if (Math.abs(this.weekDragCurrentX - this.weekDragStartX) < 5) {
      this.resetWeekSelection();
      return;
    }

    const p1 = Math.min(this.weekDragStartX, this.weekDragCurrentX);
    const p2 = Math.max(this.weekDragStartX, this.weekDragCurrentX);

    let startMins = Math.round(((p1 / cellWidth) * totalMinutes) / 30) * 30;
    let endMins = Math.round(((p2 / cellWidth) * totalMinutes) / 30) * 30;
    if (startMins < 0) startMins = 0;
    if (endMins > totalMinutes) endMins = totalMinutes;
    if (endMins <= startMins) endMins = startMins + 30;

    const startTime = this.weekMinsToTime(startMins);
    const endTime = this.weekMinsToTime(endMins);
    const dateStr = cell.dataset.date || "";
    const slyusarId = parseInt(cell.dataset.slyusarId || "0") || null;
    const namePost = parseInt(cell.dataset.postId || "0") || null;

    this.openWeekModal(dateStr, startTime, endTime, slyusarId, namePost);
    this.resetWeekSelection();
  };

  private onWeekDragCancel = (): void => {
    this.removeWeekDragPointerListeners();
    this.resetWeekSelection();
  };

  /** Знімає підсвічування drag-годин і відновлює числа у заголовку */
  private clearDragHourHighlight(): void {
    if (!this.calendarGrid) return;
    const cells = this.calendarGrid.querySelectorAll(
      ".post-week-hour-cell.hour-drag-active",
    ) as NodeListOf<HTMLElement>;
    cells.forEach((cell) => {
      cell.classList.remove("hour-drag-active");
      // Відновлюємо оригінальне число години
      const absH = 8 + Array.from(cell.parentElement!.children).indexOf(cell);
      cell.textContent = String(absH);
    });
  }

  private resetWeekSelection(): void {
    this.weekDragActive = false;
    this.weekDragCell = null;
    this.clearDragHourHighlight();
    if (this.weekSelectionEl) {
      this.weekSelectionEl.style.display = "none";
      this.weekSelectionEl.remove();
    }
  }

  // ============== ТИЖНЕВИЙ ВИД — ПЕРЕМІЩЕННЯ БЛОКІВ (DRAG) ==============

  private handleWeekBlockMouseDown(e: MouseEvent, block: HTMLElement): void {
    if (this.weekIsBlockDragging || this.weekIsResizing) return;
    // Перевірка прав
    const currentUser = this.getCurrentUserName();
    const currentAccess = this.getCurrentUserAccess();
    const creator = block.dataset.xtoZapusav || "";
    if (
      currentAccess !== "Адміністратор" &&
      creator &&
      creator !== currentUser
    ) {
      showNotification(
        `Ви не можете переміщати цей запис. Створив: ${creator}`,
        "error",
      );
      return;
    }

    this.weekMovingBlock = block;
    this.weekBlockDragStartX = e.clientX;
    this.weekBlockDragStartY = e.clientY;
    this.weekIsBlockDragging = false;

    document.addEventListener("mousemove", this.onWeekBlockMouseMove);
    document.addEventListener("mouseup", this.onWeekBlockMouseUp);
  }

  private startWeekBlockDrag(e: MouseEvent): void {
    if (!this.weekMovingBlock) return;

    const cell = this.weekMovingBlock.closest(
      ".post-week-day-track",
    ) as HTMLElement;
    this.weekMovingOriginalCell = cell;
    this.weekMovingOriginalDataset = { ...this.weekMovingBlock.dataset };
    this.weekMovingOriginalLeft = this.weekMovingBlock.style.left;
    this.weekMovingOriginalWidth = this.weekMovingBlock.style.width;
    // Зберігаємо оригінальний текст часу
    const origTimeEl = this.weekMovingBlock.querySelector(
      ".post-week-block-line",
    );
    this.weekMovingOriginalTimeText = origTimeEl
      ? origTimeEl.textContent || ""
      : "";

    const rect = this.weekMovingBlock.getBoundingClientRect();
    this.weekBlockDragOffsetX = e.clientX - rect.left;

    // Фіксуємо розміри і переносимо в body
    this.weekMovingBlock.style.width = `${rect.width}px`;
    this.weekMovingBlock.style.height = `${rect.height}px`;
    this.weekMovingBlock.style.left = `${rect.left}px`;
    this.weekMovingBlock.style.top = `${rect.top}px`;
    this.weekMovingBlock.classList.add("week-dragging-active");
    document.body.appendChild(this.weekMovingBlock);
  }

  private onWeekBlockMouseMove = (e: MouseEvent): void => {
    if (!this.weekMovingBlock) return;

    if (!this.weekIsBlockDragging) {
      const dx = Math.abs(e.clientX - this.weekBlockDragStartX);
      const dy = Math.abs(e.clientY - this.weekBlockDragStartY);
      if (dx < 5 && dy < 5) return;
      this.weekIsBlockDragging = true;
      this.startWeekBlockDrag(e);
    }

    // Рухаємо блок за курсором
    this.weekMovingBlock.style.left = `${e.clientX - this.weekBlockDragOffsetX}px`;
    this.weekMovingBlock.style.top = `${e.clientY - this.weekMovingBlock.offsetHeight / 2}px`;

    // Визначаємо target track
    this.weekMovingBlock.style.pointerEvents = "none";
    const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
    this.weekMovingBlock.style.pointerEvents = "";

    this.calendarGrid
      ?.querySelectorAll(".week-drop-target")
      .forEach((el) => el.classList.remove("week-drop-target"));

    const targetTrack = elemBelow?.closest(
      ".post-week-day-track",
    ) as HTMLElement;
    this.weekMovingBlock.classList.remove(
      "week-drag-valid",
      "week-drag-invalid",
    );

    if (targetTrack) {
      targetTrack.classList.add("week-drop-target");
      const trackRect = targetTrack.getBoundingClientRect();
      const relativeX = e.clientX - this.weekBlockDragOffsetX - trackRect.left;
      const totalMinutes = 12 * 60;
      let startMins =
        Math.round(((relativeX / trackRect.width) * totalMinutes) / 30) * 30;
      const duration =
        parseInt(this.weekMovingBlock.dataset.end || "0") -
        parseInt(this.weekMovingBlock.dataset.start || "0");
      const endMins = startMins + duration;

      if (startMins >= 0 && endMins <= totalMinutes) {
        const hasOverlap = this.checkWeekBlockOverlap(
          startMins,
          endMins,
          targetTrack,
          this.weekMovingBlock,
        );
        this.weekMovingBlock.classList.add(
          hasOverlap ? "week-drag-invalid" : "week-drag-valid",
        );

        // ── Оновлюємо час у блоці ───────────────────────────────
        const sH = String(8 + Math.floor(startMins / 60)).padStart(2, "0");
        const sM = String(startMins % 60).padStart(2, "0");
        const eH = String(8 + Math.floor(endMins / 60)).padStart(2, "0");
        const eM = String(endMins % 60).padStart(2, "0");
        const timeLine = this.weekMovingBlock.querySelector(
          ".post-week-block-line",
        );
        if (timeLine) {
          timeLine.textContent = `🕐 ${sH}:${sM}-${eH}:${eM}`;
        }

        // ── Підсвічуємо комірки заголовку для цього дня ─────────
        this.clearDragHourHighlight();
        const dateStr = targetTrack.dataset.date || "";
        if (dateStr && this.calendarGrid) {
          const weekDays = this.getWeekDays(this.selectedDate);
          const dayIndex = weekDays.findIndex((d) => {
            const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            return ds === dateStr;
          });
          if (dayIndex >= 0) {
            const dayColHeader = this.calendarGrid.querySelectorAll(
              ".post-week-day-col-header",
            )[dayIndex] as HTMLElement;
            if (dayColHeader) {
              // Межі блоку в clientX координатах
              const blockLeft = trackRect.left + Math.max(0, relativeX);
              const blockRight =
                blockLeft +
                ((endMins - startMins) / totalMinutes) * trackRect.width;
              (
                Array.from(
                  dayColHeader.querySelectorAll(".post-week-hour-cell"),
                ) as HTMLElement[]
              ).forEach((cell) => {
                const cr = cell.getBoundingClientRect();
                if (cr.right > blockLeft && cr.left < blockRight) {
                  cell.classList.add("hour-drag-active");
                }
              });
              // Час в першій та останній активній комірці
              const activeCells = Array.from(
                dayColHeader.querySelectorAll(
                  ".post-week-hour-cell.hour-drag-active",
                ),
              ) as HTMLElement[];
              if (activeCells.length > 0) {
                activeCells[0].textContent = `${sH}:${sM}`;
                if (activeCells.length > 1) {
                  activeCells[activeCells.length - 1].textContent =
                    `${eH}:${eM}`;
                }
              }
            }
          }
        }
      } else {
        this.weekMovingBlock.classList.add("week-drag-invalid");
        this.clearDragHourHighlight();
      }
    } else {
      this.weekMovingBlock.classList.add("week-drag-invalid");
      this.clearDragHourHighlight();
    }
  };

  private onWeekBlockMouseUp = async (e: MouseEvent): Promise<void> => {
    if (!this.weekMovingBlock) return;

    document.removeEventListener("mousemove", this.onWeekBlockMouseMove);
    document.removeEventListener("mouseup", this.onWeekBlockMouseUp);

    // Прибираємо підсвічування
    this.calendarGrid
      ?.querySelectorAll(".week-drop-target")
      .forEach((el) => el.classList.remove("week-drop-target"));
    this.clearDragHourHighlight();

    if (!this.weekIsBlockDragging) {
      // Не було drag, просто клік — нічого не робимо
      this.weekMovingBlock = null;
      this.weekIsBlockDragging = false;
      return;
    }

    const isValid = this.weekMovingBlock.classList.contains("week-drag-valid");

    this.weekMovingBlock.style.pointerEvents = "none";
    const targetTrack = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(".post-week-day-track") as HTMLElement;
    this.weekMovingBlock.style.pointerEvents = "";

    // Скидаємо drag-стилі
    this.weekMovingBlock.classList.remove(
      "week-dragging-active",
      "week-drag-valid",
      "week-drag-invalid",
    );
    this.weekMovingBlock.style.position = "absolute";
    this.weekMovingBlock.style.height = "";
    this.weekMovingBlock.style.top = "1px";
    this.weekMovingBlock.style.bottom = "1px";

    if (isValid && targetTrack) {
      // Commit — обчислюємо нову позицію
      const trackRect = targetTrack.getBoundingClientRect();
      const relativeX = e.clientX - this.weekBlockDragOffsetX - trackRect.left;
      const totalMinutes = 12 * 60;
      let startMins =
        Math.round(((relativeX / trackRect.width) * totalMinutes) / 30) * 30;
      const duration =
        parseInt(this.weekMovingBlock.dataset.end || "0") -
        parseInt(this.weekMovingBlock.dataset.start || "0");
      if (startMins < 0) startMins = 0;
      const endMins = startMins + duration;
      const leftPercent = (startMins / totalMinutes) * 100;
      const widthPercent = (duration / totalMinutes) * 100;

      this.weekMovingBlock.dataset.start = startMins.toString();
      this.weekMovingBlock.dataset.end = endMins.toString();
      this.weekMovingBlock.style.left = `${leftPercent}%`;
      this.weekMovingBlock.style.width = `${widthPercent}%`;

      // Оновлюємо дату та slyusar_id з нового треку
      const newDate = targetTrack.dataset.date || "";
      const newSlyusarId = targetTrack.dataset.slyusarId || "";
      this.weekMovingBlock.dataset.date = newDate;
      this.weekMovingBlock.dataset.slyusarId = newSlyusarId;
      this.weekMovingBlock.dataset.namePost = targetTrack.dataset.postId || "";

      // Оновлюємо текст часу
      const sH = this.weekMinsToTime(startMins);
      const eH = this.weekMinsToTime(endMins);
      const timeEl = this.weekMovingBlock.querySelector(
        ".post-week-block-line",
      );
      if (timeEl) timeEl.textContent = `🕐 ${sH}-${eH}`;

      targetTrack.appendChild(this.weekMovingBlock);

      // === ЗБЕРІГАЄМО В БД ===
      const postArxivId = this.weekMovingBlock.dataset.postArxivId;
      if (postArxivId) {
        try {
          const dataOn = `${newDate}T${sH}:00`;
          const dataOff = `${newDate}T${eH}:00`;

          const previous = getPlannerRecord(postArxivId);
          const payload = { slyusar_id: Number(newSlyusarId), name_post: Number(targetTrack.dataset.postId) || null,
            data_on: dataOn, data_off: dataOff };
          const patch = plannerWritePatch(previous, payload);
          if (!Object.keys(patch).length) {
            this.weekMovingBlock = null;
            this.weekMovingOriginalCell = null;
            this.weekIsBlockDragging = false;
            return;
          }
          const availability = await this.checkWeekAvailability(newDate, sH, eH, Number(newSlyusarId) || null, Number(postArxivId));
          if (!availability.valid) throw new Error(availability.message || "Цей час вже зайнятий");
          const { data: saved, error } = await supabase.from("post_arxiv").update(patch)
            .eq("post_arxiv_id", Number(postArxivId)).select("post_arxiv_id").maybeSingle();

          if (error || !saved) {
            showNotification("Помилка оновлення в БД", "error");
            this.revertWeekBlockDrag();
          } else {
            publishPlannerChange("UPDATE", { ...payload, post_arxiv_id: Number(postArxivId) }, previous);
            showNotification("Запис переміщено!", "success");

            await logAction(
              "planning_reschedule",
              null,
              {
                post_arxiv_id: postArxivId,
                client: this.weekMovingBlock!.dataset.clientName,
                car: this.weekMovingBlock!.dataset.carModel,
                date: newDate,
                time: `${sH}–${eH}`,
              },
              "planning",
            );
          }
        } catch {
          showNotification("Помилка при переміщенні", "error");
          this.revertWeekBlockDrag();
        }
      }
    } else {
      this.revertWeekBlockDrag();
    }

    this.weekMovingBlock = null;
    this.weekMovingOriginalCell = null;
    this.weekIsBlockDragging = false;
  };

  private revertWeekBlockDrag(): void {
    if (!this.weekMovingBlock || !this.weekMovingOriginalCell) return;
    this.weekMovingBlock.style.left = this.weekMovingOriginalLeft;
    this.weekMovingBlock.style.width = this.weekMovingOriginalWidth;
    this.weekMovingBlock.style.height = "";
    this.weekMovingBlock.style.top = "1px";
    this.weekMovingBlock.style.bottom = "1px";
    this.weekMovingBlock.style.position = "absolute";
    // Відновлюємо оригінальний текст часу
    if (this.weekMovingOriginalTimeText) {
      const timeEl = this.weekMovingBlock.querySelector(
        ".post-week-block-line",
      );
      if (timeEl) timeEl.textContent = this.weekMovingOriginalTimeText;
    }
    for (const key of Object.keys(this.weekMovingBlock.dataset)) delete this.weekMovingBlock.dataset[key];
    for (const [key, value] of Object.entries(this.weekMovingOriginalDataset)) {
      if (value !== undefined) this.weekMovingBlock.dataset[key] = value;
    }
    this.weekMovingOriginalCell.appendChild(this.weekMovingBlock);
  }

  /** Перевірка перетинів блоків в тижневій комірці */
  private checkWeekBlockOverlap(
    startMins: number,
    endMins: number,
    cell: HTMLElement,
    excludeBlock: HTMLElement,
  ): boolean {
    const blocks = Array.from(
      cell.querySelectorAll(".post-week-block"),
    ) as HTMLElement[];
    for (const block of blocks) {
      if (block === excludeBlock) continue;
      const bStart = parseInt(block.dataset.start || "0");
      const bEnd = parseInt(block.dataset.end || "0");
      if (startMins < bEnd && endMins > bStart) return true;
    }
    return false;
  }

  // ============== ТИЖНЕВИЙ ВИД — RESIZE БЛОКІВ ==============

  private handleWeekResizeMouseDown(
    e: MouseEvent,
    block: HTMLElement,
    side: "left" | "right",
  ): void {
    if (this.weekIsBlockDragging || this.weekIsResizing) return;
    const currentUser = this.getCurrentUserName();
    const currentAccess = this.getCurrentUserAccess();
    const creator = block.dataset.xtoZapusav || "";
    if (
      currentAccess !== "Адміністратор" &&
      creator &&
      creator !== currentUser
    ) {
      showNotification(
        `Ви не можете змінювати розмір запису. Створив: ${creator}`,
        "error",
      );
      return;
    }

    this.weekIsResizing = true;
    this.weekResizingBlock = block;
    this.weekResizeHandleSide = side;
    this.weekResizeStartX = e.clientX;
    this.weekResizeOrigStartMins = parseInt(block.dataset.start || "0");
    this.weekResizeOrigEndMins = parseInt(block.dataset.end || "0");
    block.style.transition = "none";

    document.addEventListener("mousemove", this.onWeekResizeMouseMove);
    document.addEventListener("mouseup", this.onWeekResizeMouseUp);
  }

  private onWeekResizeMouseMove = (e: MouseEvent): void => {
    if (
      !this.weekIsResizing ||
      !this.weekResizingBlock ||
      !this.weekResizeHandleSide
    )
      return;

    const track = this.weekResizingBlock.closest(
      ".post-week-day-track",
    ) as HTMLElement;
    if (!track) return;

    const trackWidth = track.getBoundingClientRect().width;
    const deltaX = e.clientX - this.weekResizeStartX;
    const totalMinutes = 12 * 60;
    const deltaMins = (deltaX / trackWidth) * totalMinutes;

    let newStart = this.weekResizeOrigStartMins;
    let newEnd = this.weekResizeOrigEndMins;

    if (this.weekResizeHandleSide === "left") {
      newStart =
        Math.round((this.weekResizeOrigStartMins + deltaMins) / 30) * 30;
      if (newStart < 0) newStart = 0;
      if (newStart >= newEnd - 30) newStart = newEnd - 30;
    } else {
      newEnd = Math.round((this.weekResizeOrigEndMins + deltaMins) / 30) * 30;
      if (newEnd > totalMinutes) newEnd = totalMinutes;
      if (newEnd <= newStart + 30) newEnd = newStart + 30;
    }

    const leftPercent = (newStart / totalMinutes) * 100;
    const widthPercent = ((newEnd - newStart) / totalMinutes) * 100;
    this.weekResizingBlock.style.left = `${leftPercent}%`;
    this.weekResizingBlock.style.width = `${widthPercent}%`;

    this.weekResizingBlock.dataset.tempStart = newStart.toString();
    this.weekResizingBlock.dataset.tempEnd = newEnd.toString();

    // Оновлюємо текст часу
    const sH = this.weekMinsToTime(newStart);
    const eH = this.weekMinsToTime(newEnd);
    const timeEl = this.weekResizingBlock.querySelector(
      ".post-week-block-line",
    );
    if (timeEl) timeEl.textContent = `🕐 ${sH}-${eH}`;

    // Перевірка перетину
    const hasOverlap = this.checkWeekBlockOverlap(
      newStart,
      newEnd,
      track,
      this.weekResizingBlock,
    );
    if (hasOverlap) {
      this.weekResizingBlock.classList.add("week-drag-invalid");
    } else {
      this.weekResizingBlock.classList.remove("week-drag-invalid");
    }
  };

  private onWeekResizeMouseUp = async (_e: MouseEvent): Promise<void> => {
    if (!this.weekIsResizing || !this.weekResizingBlock) return;
    document.removeEventListener("mousemove", this.onWeekResizeMouseMove);
    document.removeEventListener("mouseup", this.onWeekResizeMouseUp);
    const block = this.weekResizingBlock;
    const oldStart = this.weekResizeOrigStartMins, oldEnd = this.weekResizeOrigEndMins;
    const start = Number(block.dataset.tempStart ?? oldStart), end = Number(block.dataset.tempEnd ?? oldEnd);
    delete block.dataset.tempStart; delete block.dataset.tempEnd;
    block.style.transition = "";
    block.classList.remove("week-drag-invalid");
    const restore = () => {
      block.dataset.start = String(oldStart); block.dataset.end = String(oldEnd);
      block.style.left = oldStart / 720 * 100 + "%";
      block.style.width = (oldEnd - oldStart) / 720 * 100 + "%";
      const label = block.querySelector(".post-week-block-line");
      if (label) label.textContent = "🕐 " + this.weekMinsToTime(oldStart) + "-" + this.weekMinsToTime(oldEnd);
    };
    try {
      if (start === oldStart && end === oldEnd) return;
      const track = block.closest(".post-week-day-track") as HTMLElement | null;
      if (!track || this.checkWeekBlockOverlap(start, end, track, block)) throw new Error("Неможливо змінити час: перетин з іншим записом");
      const id = Number(block.dataset.postArxivId), date = block.dataset.date || "";
      if (!id || !date) throw new Error("Не вдалося визначити запис");
      const startTime = this.weekMinsToTime(start), endTime = this.weekMinsToTime(end);
      const previous = getPlannerRecord(id);
      const patch = plannerWritePatch(previous, { data_on: date + "T" + startTime + ":00", data_off: date + "T" + endTime + ":00" });
      if (!Object.keys(patch).length) return;
      const availability = await this.checkWeekAvailability(date, startTime, endTime, Number(block.dataset.slyusarId) || null, id);
      if (!availability.valid) throw new Error(availability.message || "Цей час вже зайнятий");
      const { data: saved, error } = await supabase.from("post_arxiv").update(patch)
        .eq("post_arxiv_id", id).select("post_arxiv_id").maybeSingle();
      if (error || !saved) throw error || new Error("Запис уже видалено або недоступний.");
      block.dataset.start = String(start); block.dataset.end = String(end);
      publishPlannerChange("UPDATE", { ...patch, post_arxiv_id: id }, previous);
      showNotification("Час оновлено!", "success");
      await logAction("planning_resize", null, { post_arxiv_id: id, client: block.dataset.clientName,
        car: block.dataset.carModel, date, time: startTime + "–" + endTime }, "planning");
    } catch (error) {
      restore();
      showNotification(error instanceof Error ? error.message : "Помилка оновлення часу", "error");
    } finally { this.resetWeekResizeState(); }
  };

  private resetWeekResizeState(): void {
    this.weekIsResizing = false;
    this.weekResizingBlock = null;
    this.weekResizeHandleSide = null;
  }

  /**
   * Відкриває модалку для створення запису у тижневому виді
   */
  private openWeekModal(
    dateStr: string,
    startTime: string,
    endTime: string,
    slyusarId: number | null,
    namePost: number | null,
  ): void {
    const data: Partial<ReservationData> = {
      slyusarId,
      namePost,
    };

    this.weekModal.open(
      dateStr,
      startTime,
      endTime,
      "",
      data,
      (resultData: ReservationData) => this.handleWeekModalSubmit(resultData),
      async (date, start, end, _excludeId) => {
        // Перевірка доступності через БД
        return this.checkWeekAvailability(date, start, end, slyusarId);
      },
      [], // busyIntervals — не обчислюємо тут, модалка сама перевірить
    );
  }

  /**
   * Перевірка доступності часу в БД для тижневого виду
   */
  private checkWeekAvailability(
    date: string,
    startTime: string,
    endTime: string,
    slyusarId: number | null,
    excludeId?: number,
  ): Promise<{ valid: boolean; message?: string }> {
    const key = JSON.stringify([date, startTime, endTime, slyusarId, excludeId]);
    const active = this.availabilityPending.get(key);
    if (active) return active;
    const request = (async () => {
    if (!slyusarId)
      return { valid: false, message: "Не обрано пост (слюсаря)" };

    const startIso = `${date}T${startTime}:00`;
    const endIso = `${date}T${endTime}:00`;

    let query = supabase
      .from("post_arxiv")
      .select("post_arxiv_id")
      .eq("slyusar_id", slyusarId)
      .lt("data_on", endIso)
      .gt("data_off", startIso);

    if (excludeId) {
      query = query.neq("post_arxiv_id", excludeId);
    }

    const { data, error } = await query.limit(1);

    if (error) return { valid: false, message: "Помилка перевірки" };
    if (data && data.length > 0)
      return { valid: false, message: "Цей час вже зайнятий" };
    return { valid: true };
    })();
    this.availabilityPending.set(key, request);
    void request.finally(() => { if (this.availabilityPending.get(key) === request) this.availabilityPending.delete(key); }).catch(() => undefined);
    return request;
  }

  /**
   * Обробка submit модалки тижневого виду — зберігаємо в БД та оновлюємо вид
   */
  private async handleWeekModalSubmit(data: ReservationData): Promise<boolean> {
    if (this.weekSavePending) return false;
    this.weekSavePending = true;
    try {
      const dataOn = data.date + "T" + data.startTime + ":00";
      const dataOff = data.date + "T" + data.endTime + ":00";
      const payload: any = {
        status: data.status || "Запланований",
        client_id: (data.clientName || "") + "|||" + (data.clientPhone || ""),
        cars_id: (data.carModel || "") + "|||" + (data.carNumber || ""),
        komentar: data.comment || "", data_on: dataOn, data_off: dataOff,
        slyusar_id: data.slyusarId, name_post: data.namePost, act_id: data.actId || null,
      };
      const previous = data.postArxivId ? getPlannerRecord(data.postArxivId) : undefined;
      const baseline = data.postArxivId && Number(data.baselineRecord?.post_arxiv_id) === data.postArxivId
        ? data.baselineRecord : previous;
      if (data.postArxivId && isPlannerRecordDeleted(data.postArxivId)) {
        showNotification("Запис уже видалено або недоступний. Відкрийте календар повторно.", "warning");
        return false;
      }
      // Keep legacy numeric references when their displayed values were unchanged.
      if (baseline && /^\d+$/.test(String(baseline.client_id)) && baseline.client_data
        && (baseline.client_data["ПІБ"] || "") === (data.clientName || "")
        && (baseline.client_data["Телефон"] || "") === (data.clientPhone || "")) payload.client_id = baseline.client_id;
      if (baseline && /^\d+$/.test(String(baseline.cars_id)) && baseline.car_data
        && (baseline.car_data["Авто"] || "") === (data.carModel || "")
        && (baseline.car_data["Номер авто"] || "") === (data.carNumber || "")) payload.cars_id = baseline.cars_id;
      const patch = plannerWritePatch(baseline, payload);
      if (data.postArxivId && previous && baseline) for (const [key, value] of Object.entries(patch)) {
        if (!Object.keys(plannerWritePatch(previous, { [key]: value })).length) delete patch[key];
        else if (Object.keys(plannerWritePatch(baseline, { [key]: previous[key] })).length) {
          showNotification("Це поле запису вже змінено. Відкрийте запис повторно, щоб побачити актуальні дані.", "warning");
          return false;
        }
      }
      if (data.postArxivId && !Object.keys(patch).length) return true;
      if (!data.postArxivId || ["data_on", "data_off", "slyusar_id"].some(key => key in patch)) {
        const target = data.postArxivId ? { ...previous, ...patch } : payload;
        const availability = await this.checkWeekAvailability(String(target.data_on).slice(0, 10),
          String(target.data_on).slice(11, 16), String(target.data_off).slice(11, 16),
          Number(target.slyusar_id) || null, data.postArxivId || undefined);
        if (!availability.valid) { showNotification(availability.message || "Цей час вже зайнятий", "error"); return false; }
      }
      const actor = this.getCurrentUserName() || "";
      let id = data.postArxivId || null;
      if (id) {
        const { data: saved, error } = await supabase.from("post_arxiv")
          .update({ ...patch, xto_zapusav: actor }).eq("post_arxiv_id", id)
          .select("post_arxiv_id").maybeSingle();
        if (error || !saved) throw error || new Error("Запис уже видалено або недоступний.");
      } else {
        const { data: saved, error } = await supabase.from("post_arxiv")
          .insert({ ...payload, xto_zapusav: actor }).select("post_arxiv_id").single();
        if (error || !saved) throw error || new Error("Не отримано підтвердження запису.");
        id = saved.post_arxiv_id;
      }
      publishPlannerChange(data.postArxivId ? "UPDATE" : "INSERT",
        { ...(data.postArxivId ? patch : payload), post_arxiv_id: id, xto_zapusav: actor }, previous);
      await logAction(data.postArxivId ? "planning_edit" : "planning_create", data.actId || null,
        { post_arxiv_id: id, client: data.clientName, car: data.carModel, status: data.status,
          date: data.date, time: data.startTime + "–" + data.endTime }, "planning");
      return true;
    } catch (error) {
      showNotification(error instanceof Error ? error.message : "Помилка збереження запису", "error");
      return false;
    } finally { this.weekSavePending = false; }
  }

  private changeDate(delta: number): void {
    const oldMonth = this.selectedDate.getMonth();
    const oldYear = this.selectedDate.getFullYear();

    this.selectedDate.setDate(this.selectedDate.getDate() + delta);
    this.viewMonth = this.selectedDate.getMonth();
    this.viewYear = this.selectedDate.getFullYear();

    if (this.isWeekView) {
      this.render();
      this.loadWeekArxivData();
      return;
    }

    // Якщо місяць змінився - потрібен повний рендеринг
    if (
      oldMonth !== this.selectedDate.getMonth() ||
      oldYear !== this.selectedDate.getFullYear()
    ) {
      this.render();
    } else {
      // Той самий місяць - просто оновлюємо підсвічування
      this.updateDateSelection();
    }

    this.reloadArxivData();
  }

  private changeMonth(delta: number): void {
    this.viewMonth += delta;
    if (this.viewMonth < 0) {
      this.viewMonth = 11;
      this.viewYear--;
    } else if (this.viewMonth > 11) {
      this.viewMonth = 0;
      this.viewYear++;
    }
    void this.renderMiniCalendar();
  }

  /**
   * Перевіряє чи відображається вказаний місяць у міні-календарі
   */
  private isMonthVisible(month: number, year: number): boolean {
    const currentMonth = this.viewMonth;
    const currentYear = this.viewYear;

    // Поточний місяць
    if (month === currentMonth && year === currentYear) return true;

    // Наступний місяць
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    if (month === nextMonth && year === nextYear) return true;

    return false;
  }

  /**
   * Оновлює підсвічування вибраної дати без повного рендерингу
   */
  private updateDateSelection(): void {
    // Оновлюємо текст дати в header
    if (this.headerDateDisplay) {
      this.headerDateDisplay.textContent = this.formatFullDate(
        this.selectedDate,
      );
    }

    // Оновлюємо візуалізацію минулого/майбутнього часу
    this.updateTimeMarker();

    // Видаляємо клас з усіх дат
    const allDates = document.querySelectorAll(".day-container span");
    allDates.forEach((span) => {
      span.classList.remove("post-selected-date");
      // Відновлюємо клас сьогоднішньої дати якщо потрібно
      const dayContainer = span.parentElement;
      if (dayContainer instanceof HTMLElement) {
        const monthElement = dayContainer.closest(".post-month-calendar");
        if (monthElement) {
          const h3 = monthElement.querySelector("h3");
          if (h3 && h3.textContent) {
            const monthName = h3.textContent;
            const monthIndex = this.getMonthIndexByName(monthName);
            if (monthIndex !== -1) {
              const dayNumber = parseInt(span.textContent || "0");
              if (!isNaN(dayNumber)) {
                const date = new Date(this.viewYear, monthIndex, dayNumber);
                if (date.toDateString() === this.today.toDateString()) {
                  span.classList.add("post-today");
                }
              }
            }
          }
        }
      }
    });

    // Додаємо клас до вибраної дати
    const selectedDay = this.selectedDate.getDate();
    const selectedMonth = this.selectedDate.getMonth();
    const selectedYear = this.selectedDate.getFullYear();

    allDates.forEach((span) => {
      if (!span.textContent) return;
      const dayNumber = parseInt(span.textContent);
      if (isNaN(dayNumber)) return;

      // Визначаємо до якого місяця належить цей день
      const dayContainer = span.parentElement;
      if (dayContainer instanceof HTMLElement) {
        const monthElement = dayContainer.closest(".post-month-calendar");
        if (monthElement) {
          const h3 = monthElement.querySelector("h3");
          if (h3 && h3.textContent) {
            const monthName = h3.textContent;
            const monthIndex = this.getMonthIndexByName(monthName);
            if (monthIndex !== -1) {
              // Визначаємо рік (поточний або наступний)
              let year = this.viewYear;
              if (this.viewMonth === 11 && monthIndex === 0) {
                year = this.viewYear + 1;
              }

              if (
                dayNumber === selectedDay &&
                monthIndex === selectedMonth &&
                year === selectedYear
              ) {
                span.classList.add("post-selected-date");
                span.classList.remove("post-today");
              }
            }
          }
        }
      }
    });
  }

  /**
   * Отримує індекс місяця за назвою
   */
  private getMonthIndexByName(monthName: string): number {
    const months = [
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
    return months.indexOf(monthName);
  }

  /**
   * Перезавантажує дані бронювань з БД для нової дати
   */
  private reloadArxivData(): void {
    if (this.postArxiv) {
      this.postArxiv.clearAllBlocks();
      this.postArxiv.loadArxivDataForCurrentDate();
    }
  }

  private toggleSection(sectionId: number): void {
    const section = this.sections.find((s) => s.id === sectionId);
    if (section) {
      section.collapsed = !section.collapsed;

      // Знаходимо елемент контенту секції в DOM
      const sectionContent = document.querySelector(
        `.post-section-content[data-section-id="${sectionId}"]`,
      ) as HTMLElement;

      if (sectionContent) {
        // Перемикаємо клас hidden
        sectionContent.classList.toggle("hidden", section.collapsed);

        // Оновлюємо іконку кнопки toggle
        const sectionGroup = sectionContent.closest(".post-section-group");
        const toggleBtn = sectionGroup?.querySelector(".post-toggle-btn");
        if (toggleBtn) {
          toggleBtn.textContent = section.collapsed ? "▶" : "▼";
        }

        // Якщо секція розгортається - завантажуємо блоки для постів цієї секції
        if (!section.collapsed && this.postArxiv) {
          const slyusarIds = section.posts.map((post) => post.id);
          this.postArxiv.loadArxivDataForSlyusars(slyusarIds);
        }
      }
    }
  }

  private deleteSection(sectionId: number): void {
    // Знаходимо секцію для отримання назви та всіх slyusar_id постів
    const section = this.sections.find((s) => s.id === sectionId);
    if (section) {
      const sectionName = section.name;

      // Додаємо всі slyusar_id постів до списку видалених
      section.posts.forEach((post) => {
        if (!this.deletedSlyusarIds.includes(post.id)) {
          this.deletedSlyusarIds.push(post.id);
        }
      });

      this.sections = this.sections.filter((s) => s.id !== sectionId);
      this.renderCurrentView();

      // Показуємо повідомлення
      showNotification(`Видалено цех: ${sectionName}`, "warning");
    }
  }

  private deletePost(sectionId: number, postId: number): void {
    const section = this.sections.find((s) => s.id === sectionId);
    if (section) {
      // Знаходимо пост для отримання назви
      const post = section.posts.find((p) => p.id === postId);
      if (post) {
        const postTitle = post.title;
        const postSubtitle = post.subtitle;

        // Додаємо slyusar_id до списку видалених
        if (!this.deletedSlyusarIds.includes(postId)) {
          this.deletedSlyusarIds.push(postId);
        }

        section.posts = section.posts.filter((p) => p.id !== postId);
        this.renderCurrentView();

        // Показуємо повідомлення
        showNotification(
          `Видалено пост: ${postTitle} - ${postSubtitle}`,
          "warning",
        );
      }
    }
  }

  /**
   * Відкриває модалку для додавання поста
   * @param sectionName Опціональна назва секції для попереднього заповнення
   */
  private openAddPostModal(sectionName?: string): void {
    const actor = localStorage.getItem("userAuthData") || "";
    this.postModal.open(
      async (data: PostData) => this.createAndPersistPlannerPost(data),
      sectionName,
      (receipt: PostDirectoryReceipt) => {
        if (actor === (localStorage.getItem("userAuthData") || "")) {
          this.applyPostDirectoryReceipt(receipt);
        }
      },
    );
  }

  /** Apply confirmed directory labels by IDs without re-reading bookings. */
  private applyPostDirectoryReceipt(receipt: PostDirectoryReceipt): void {
    if (receipt.category && !(receipt.status === "deleted" && !receipt.post)) {
      const category = receipt.category;
      for (const section of this.sections) {
        if (String(section.realCategoryId) !== String(category.category_id)) continue;
        section.name = category.category;
        const group = this.calendarGrid?.querySelector<HTMLElement>(
          `.post-section-group[data-section-id="${section.id}"], .post-week-section-group[data-section-id="${section.id}"]`,
        );
        const label = group?.querySelector<HTMLElement>(".post-section-header-left span, .post-week-section-header-left span");
        if (label) label.textContent = section.name;
      }
    }
    if (receipt.post) {
      const changed = receipt.post;
      // Titles may repeat across workshops. Never use them to identify a row.
      for (const [title, id] of this.postTitleToIdMap) {
        if (id === changed.post_id) this.postTitleToIdMap.delete(title);
      }
      if (receipt.status !== "deleted") {
        this.postTitleToIdMap.set(changed.name, changed.post_id);
        for (const section of this.sections) for (const post of section.posts) {
          if (post.postId !== changed.post_id) continue;
          post.title = changed.name;
          const row = this.calendarGrid?.querySelector<HTMLElement>(
            `.post-unified-row[data-post-id="${post.id}"], .post-week-row[data-post-id="${post.id}"]`,
          );
          const label = row?.querySelector<HTMLElement>(".post-post-title");
          if (label) label.textContent = post.title;
        }
      }
    }
    // SQL rejects deleting directories used by workers or booking history;
    // a successful deletion therefore has no calendar rows to remove.
  }

  /** Rebuild only the row structure, preserving live booking nodes/listeners. */
  private renderPostStructurePreservingBookings(): void {
    const blocks = Array.from(this.calendarGrid?.querySelectorAll<HTMLElement>(
      ".post-week-block, .post-reservation-block",
    ) || []);
    const saved = blocks.map(block => ({
      block,
      staff: Number(block.dataset.slyusarId || block.parentElement?.dataset.slyusarId),
      date: block.dataset.date || block.parentElement?.dataset.date || "",
    }));
    for (const { block } of saved) block.remove();
    if (this.isWeekView) this.renderWeekView();
    else this.renderSections();
    for (const { block, staff, date } of saved) {
      if (!Number.isSafeInteger(staff) || staff <= 0) continue;
      const target = this.isWeekView
        ? /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? this.calendarGrid?.querySelector<HTMLElement>(`.post-week-day-track[data-date="${date}"][data-slyusar-id="${staff}"]`)
          : null
        : this.calendarGrid?.querySelector<HTMLElement>(`.post-row-track[data-slyusar-id="${staff}"]`);
      target?.appendChild(block);
    }
  }

  /** Load only the newly visible worker's bookings, never the whole calendar. */
  private async loadAssignedStaffBookings(staffId: number, actor: string): Promise<void> {
    const week = this.isWeekView;
    const date = this.selectedDate.getTime();
    const days = week ? this.getWeekDays(this.selectedDate) : [this.selectedDate];
    const start = plannerDateKey(days[0]) + "T00:00:00";
    const end = plannerDateKey(days[days.length - 1]) + "T23:59:59";
    const current = () => actor === (localStorage.getItem("userAuthData") || "")
      && week === this.isWeekView && date === this.selectedDate.getTime();
    try {
      const records = await readPlannerBookings(start, end, [staffId]);
      if (!current()) return;
      for (const record of records) {
        if (week) this.renderWeekArxivRecord(record,
          new Map([[Number(record.client_id), record.client_data || {}]]),
          new Map([[Number(record.cars_id), record.car_data || {}]]));
        else this.postArxiv?.applyRecordChange({ type: "UPDATE", record });
      }
    } catch {
      // The assignment is already committed. Do not turn a display failure
      // into a failed save or repeat the write.
      if (current()) showNotification("Пост збережено. Не вдалося завантажити записи цього слюсаря; відкрийте день повторно.", "warning");
    }
  }

  private async createAndPersistPlannerPost(data: PostData): Promise<void> {
    const actor = data.actor ?? (localStorage.getItem("userAuthData") || "");
    if (actor !== (localStorage.getItem("userAuthData") || "")) {
      throw new Error("Користувач змінився. Відкрийте форму повторно.");
    }
    const cehTitle = data.cehTitle.trim();
    const postTitle = data.title.trim();
    const staffName = data.subtitle.replace(/^👨‍🔧\s*/, "").trim();
    if (!cehTitle || !postTitle || !staffName) throw new Error("Заповніть цех, пост і прізвище слюсаря");
    let section = this.sections.find(item => data.categoryId != null
      ? String(item.realCategoryId) === String(data.categoryId)
      : item.name.trim().toLowerCase() === cehTitle.toLowerCase());
    const sectionIndex = section ? this.sections.indexOf(section) : this.sections.length;
    const namber = sectionIndex + 1 + ((section?.posts.length || 0) + 1) / 10;
    const { data: receipt, error } = await supabase.rpc("traffic_planner_post_assign", {
      p_category: cehTitle, p_post: postTitle, p_staff_name: staffName,
      p_staff_id: data.staffId || null, p_namber: namber,
      p_category_id: data.categoryId ?? null, p_post_id: data.postId ?? null,
    });
    if (error) {
      if (["PGRST202", "42883"].includes(error.code)) {
        throw new Error("Встановіть SQL-пакет planner-post-modal-repair.sql для збереження постів.");
      }
      throw error;
    }
    if (!receipt || !["created", "updated", "unchanged"].includes(receipt.status)
      || !Number.isSafeInteger(Number(receipt.category?.category_id)) || Number(receipt.category.category_id) <= 0
      || !Number.isSafeInteger(Number(receipt.post?.post_id)) || Number(receipt.post.post_id) <= 0
      || !Number.isSafeInteger(Number(receipt.staff?.slyusar_id)) || Number(receipt.staff.slyusar_id) <= 0
      || String(receipt.post.category) !== String(receipt.category.category_id)
      || String(receipt.staff.post_sluysar) !== String(receipt.post.post_id)
      || (data.categoryId != null && Number(receipt.category.category_id) !== data.categoryId)
      || (data.postId != null && Number(receipt.post.post_id) !== data.postId)
      || (data.staffId != null && Number(receipt.staff.slyusar_id) !== data.staffId)
      || !Number.isFinite(Number(receipt.staff.namber))
      || typeof receipt.category.category !== "string" || typeof receipt.post.name !== "string"
      || typeof receipt.staff.name !== "string") {
      throw new Error("Не вдалося перевірити відповідь збереження поста. Відкрийте планувальник повторно.");
    }
    // A successful write belongs to the actor that started it, not to a newly
    // opened session. The modal closes without presenting a second save.
    if (actor !== (localStorage.getItem("userAuthData") || "")) return;
    const categoryId = Number(receipt.category.category_id);
    const postId = Number(receipt.post.post_id);
    const staffId = Number(receipt.staff.slyusar_id);
    const savedOrder = Number(receipt.staff.namber);
    try {
      this.applyPostDirectoryReceipt(receipt);
      section = this.sections.find(item => String(item.realCategoryId) === String(categoryId));
      if (!section) {
        section = {
          id: Math.max(0, ...this.sections.map(item => item.id)) + 1,
          realCategoryId: String(categoryId), name: receipt.category.category,
          collapsed: false, posts: [],
        };
        this.sections.push(section);
      }
      const existing = this.sections.flatMap(item => item.posts).find(post => post.id === staffId);
      const newlyVisible = !existing;
      if (existing) {
        // Idempotent retry: preserve local row order/draft position.
        existing.title = receipt.post.name;
        existing.subtitle = `👨‍🔧 ${receipt.staff.name}`;
      } else {
        section.posts.push({ id: staffId, postId, title: receipt.post.name,
          subtitle: `👨‍🔧 ${receipt.staff.name}`, namber: savedOrder });
      }
      this.postTitleToIdMap.set(receipt.post.name, postId);
      this.slyusarNameToIdMap.set(receipt.staff.name.trim().toLowerCase(), staffId);
      this.staffNames.set(staffId, receipt.staff.name);
      if (!this.initialPositions.some(item => item.slyusar_id === staffId)) {
        this.initialPositions.push({ slyusar_id: staffId, post_id: postId,
          original_namber: savedOrder, current_namber: savedOrder });
      }
      if (!this.initialPostCategories.has(postId)) this.initialPostCategories.set(postId, String(categoryId));
      this.deletedSlyusarIds = this.deletedSlyusarIds.filter(id => id !== staffId);
      if (newlyVisible) {
        this.renderPostStructurePreservingBookings();
        const totalPosts = this.sections.reduce((sum, item) => sum + item.posts.length, 0);
        for (const value of this.monthOccupancyStats.values()) value.totalPosts = totalPosts;
        // Existing occupancy minutes stay valid; the denominator changed locally.
        this.paintOccupancyIndicators();
      }
      showNotification(receipt.status === "unchanged" ? "Пост уже збережено" : "Цех, пост і слюсар збережені", "success");
      if (newlyVisible && !section.collapsed) await this.loadAssignedStaffBookings(staffId, actor);
    } catch {
      // The RPC has committed. A local rendering failure must not be reported
      // as a failed save or encourage a second database write.
      if (actor === (localStorage.getItem("userAuthData") || "")) {
        showNotification("Пост збережено. Не вдалося оновити відображення; оновіть планувальник.", "warning");
      }
    }
  }

  private renderSections(): void {
    const calendarGrid = this.calendarGrid;
    if (!calendarGrid) return;

    calendarGrid.innerHTML = "";

    // Створюємо фонову сітку для ідеального вирівнювання з хедером
    const bgGrid = document.createElement("div");
    bgGrid.className = "post-grid-background";
    for (let i = 0; i < 24; i++) {
      const cell = document.createElement("div");
      bgGrid.appendChild(cell);
    }
    calendarGrid.appendChild(bgGrid);

    this.sections.forEach((section, sectionIndex) => {
      const sectionGroup = document.createElement("div");
      sectionGroup.className = "post-section-group";
      sectionGroup.dataset.sectionId = section.id.toString();
      sectionGroup.dataset.sectionIndex = sectionIndex.toString();

      const sectionHeader = document.createElement("div");
      sectionHeader.className = "post-section-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "post-section-header-left";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = section.name;
      headerLeft.appendChild(nameSpan);

      const headerRight = document.createElement("div");
      headerRight.className = "post-section-header-right";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "post-delete-btn";
      deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>`;
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.deleteSection(section.id);
      };

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "post-toggle-btn";
      if (section.collapsed) toggleBtn.classList.add("collapsed");
      toggleBtn.textContent = "▼";

      headerRight.appendChild(deleteBtn);
      headerRight.appendChild(toggleBtn);

      sectionHeader.appendChild(headerLeft);
      sectionHeader.appendChild(headerRight);

      // Drag and drop для всього хедера секції - тільки в режимі редагування
      sectionHeader.addEventListener("mousedown", (e) => {
        if (!this.editMode) return;

        // Не починати drag якщо клікнуто на кнопках
        const target = e.target as HTMLElement;
        if (
          target.closest(".post-delete-btn") ||
          target.closest(".post-toggle-btn")
        )
          return;

        e.preventDefault();
        this.startSectionDrag(e, sectionGroup, section.id);
      });

      // Click для toggle - тільки якщо НЕ в режимі редагування
      sectionHeader.addEventListener("click", (e) => {
        if (this.editMode) return;
        const target = e.target as HTMLElement;
        if (target.closest(".post-delete-btn")) return;
        this.toggleSection(section.id);
      });

      const sectionContent = document.createElement("div");
      sectionContent.className = "post-section-content";
      sectionContent.dataset.sectionId = section.id.toString();
      if (section.collapsed) sectionContent.classList.add("hidden");

      section.posts.forEach((post, postIndex) => {
        const row = document.createElement("div");
        row.className = "post-unified-row";
        row.dataset.postId = post.id.toString();
        row.dataset.postIndex = postIndex.toString();
        row.dataset.sectionId = section.id.toString();

        const rowLabel = document.createElement("div");
        rowLabel.className = "post-row-label";

        const deleteContainer = document.createElement("div");
        deleteContainer.className = "post-post-delete-container";

        const labelContent = document.createElement("div");
        labelContent.className = "post-row-label-content";
        labelContent.innerHTML = `
                    <div class="post-post-title">${post.title}</div>
                    <div class="post-post-subtitle">${post.subtitle}</div>
                `;

        const postDeleteBtn = document.createElement("button");
        postDeleteBtn.className = "post-post-delete-btn";
        postDeleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>`;
        postDeleteBtn.onclick = (e) => {
          e.stopPropagation();
          this.deletePost(section.id, post.id);
        };

        deleteContainer.appendChild(labelContent);
        deleteContainer.appendChild(postDeleteBtn);
        rowLabel.appendChild(deleteContainer);

        // Drag and drop для всього rowLabel - тільки в режимі редагування
        rowLabel.addEventListener("mousedown", (e) => {
          if (!this.editMode) return;

          // Не починати drag якщо клікнуто на кнопці видалення
          const target = e.target as HTMLElement;
          if (target.closest(".post-post-delete-btn")) return;

          e.preventDefault();
          this.startPostDrag(e, row, section.id, post.id);
        });

        const rowTrack = document.createElement("div");
        rowTrack.className = "post-row-track";
        rowTrack.dataset.slyusarId = post.id.toString();
        rowTrack.dataset.postId = post.postId.toString();

        row.appendChild(rowLabel);
        row.appendChild(rowTrack);
        sectionContent.appendChild(row);
      });

      const addPostBtn = document.createElement("button");
      addPostBtn.className = "post-add-post-btn";
      addPostBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Додати пост
            `;
      addPostBtn.onclick = () => this.openAddPostModal(section.name);
      sectionContent.appendChild(addPostBtn);

      sectionGroup.appendChild(sectionHeader);
      sectionGroup.appendChild(sectionContent);

      calendarGrid.appendChild(sectionGroup);
    });

    // Кнопка "Додати цех" видалена - тепер цех створюється через модалку "Додати пост"
  }

  // ============== DRAG AND DROP ДЛЯ СЕКЦІЙ ==============
  private startSectionDrag(
    _e: MouseEvent,
    element: HTMLElement,
    sectionId: number,
  ): void {
    this.draggedElement = element;
    this.draggedSectionId = sectionId;

    // Створюємо плейсхолдер
    this.dragPlaceholder = document.createElement("div");
    this.dragPlaceholder.className =
      "post-drag-placeholder post-section-placeholder";
    this.dragPlaceholder.style.height = `${element.offsetHeight}px`;

    // Додаємо клас для перетягування
    element.classList.add("dragging");

    // Фіксуємо позицію елемента
    const rect = element.getBoundingClientRect();
    element.style.position = "fixed";
    element.style.width = `${rect.width}px`;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.zIndex = "1000";
    element.style.pointerEvents = "none";

    // Вставляємо плейсхолдер
    element.parentNode?.insertBefore(this.dragPlaceholder, element);

    const onMouseMove = (e: MouseEvent) => {
      if (!this.draggedElement) return;

      const newTop = e.clientY - rect.height / 2;
      this.draggedElement.style.top = `${newTop}px`;

      // Знаходимо елемент під курсором для визначення нової позиції
      this.updateSectionPlaceholder(e.clientY);
    };

    const onMouseUp = () => {
      this.finishSectionDrag();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  private updateSectionPlaceholder(mouseY: number): void {
    if (!this.dragPlaceholder || !this.calendarGrid) return;

    const sectionSelector = this.isWeekView
      ? ".post-week-section-group:not(.dragging)"
      : ".post-section-group:not(.dragging)";

    const sectionGroups = Array.from(
      this.calendarGrid.querySelectorAll(sectionSelector),
    );

    for (const group of sectionGroups) {
      const rect = group.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;

      if (mouseY < midpoint) {
        group.parentNode?.insertBefore(this.dragPlaceholder, group);
        return;
      }
    }

    // Якщо курсор нижче всіх секцій - ставимо в кінець
    if (this.isWeekView) {
      const weekBody = this.calendarGrid.querySelector(".post-week-body");
      if (weekBody) {
        weekBody.appendChild(this.dragPlaceholder);
      } else {
        this.calendarGrid.appendChild(this.dragPlaceholder);
      }
    } else {
      const addBtn = this.calendarGrid.querySelector(".post-add-section-btn");
      if (addBtn) {
        addBtn.parentNode?.insertBefore(this.dragPlaceholder, addBtn);
      } else {
        this.calendarGrid.appendChild(this.dragPlaceholder);
      }
    }
  }

  private finishSectionDrag(): void {
    if (!this.draggedElement || !this.dragPlaceholder || !this.calendarGrid)
      return;

    const sectionSelector = this.isWeekView
      ? ".post-week-section-group:not(.dragging), .post-drag-placeholder"
      : ".post-section-group:not(.dragging), .post-drag-placeholder";

    // Визначаємо нову позицію
    const sectionGroups = Array.from(
      this.calendarGrid.querySelectorAll(sectionSelector),
    );

    // Знаходимо реальний індекс
    let newIndex = 0;
    for (let i = 0; i < sectionGroups.length; i++) {
      if (sectionGroups[i] === this.dragPlaceholder) break;
      if (
        !sectionGroups[i].classList.contains("dragging") &&
        !sectionGroups[i].classList.contains("post-drag-placeholder")
      ) {
        newIndex++;
      }
    }

    // Переміщуємо секцію в масиві
    const oldIndex = this.sections.findIndex(
      (s) => s.id === this.draggedSectionId,
    );
    if (oldIndex !== -1 && newIndex !== oldIndex) {
      const [movedSection] = this.sections.splice(oldIndex, 1);
      // Коригуємо індекс, якщо переміщуємо вниз
      const adjustedIndex = newIndex > oldIndex ? newIndex : newIndex;
      this.sections.splice(adjustedIndex, 0, movedSection);
    }

    // Очищуємо
    this.draggedElement.classList.remove("dragging");
    this.draggedElement.style.position = "";
    this.draggedElement.style.width = "";
    this.draggedElement.style.left = "";
    this.draggedElement.style.top = "";
    this.draggedElement.style.zIndex = "";
    this.draggedElement.style.pointerEvents = "";

    this.dragPlaceholder.remove();
    this.dragPlaceholder = null;
    this.draggedElement = null;
    this.draggedSectionId = null;

    // Перемальовуємо
    this.renderCurrentView();
  }

  // ============== DRAG AND DROP ДЛЯ ПОСТІВ ==============
  private startPostDrag(
    _e: MouseEvent,
    element: HTMLElement,
    sectionId: number,
    postId: number,
  ): void {
    this.draggedElement = element;
    this.draggedSectionId = sectionId;
    this.draggedPostId = postId;

    // Створюємо плейсхолдер
    this.dragPlaceholder = document.createElement("div");
    this.dragPlaceholder.className =
      "post-drag-placeholder post-post-placeholder";
    this.dragPlaceholder.style.height = `${element.offsetHeight}px`;

    // Додаємо клас для перетягування
    element.classList.add("dragging");

    // Фіксуємо позицію елемента
    const rect = element.getBoundingClientRect();
    element.style.position = "fixed";
    element.style.width = `${rect.width}px`;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.zIndex = "1000";
    element.style.pointerEvents = "none";

    // Вставляємо плейсхолдер
    element.parentNode?.insertBefore(this.dragPlaceholder, element);

    const onMouseMove = (e: MouseEvent) => {
      if (!this.draggedElement) return;

      const newTop = e.clientY - rect.height / 2;
      this.draggedElement.style.top = `${newTop}px`;

      // Знаходимо елемент під курсором для визначення нової позиції
      this.updatePostPlaceholder(e.clientY);
    };

    const onMouseUp = () => {
      this.finishPostDrag();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  private updatePostPlaceholder(mouseY: number): void {
    if (!this.dragPlaceholder || !this.calendarGrid) return;

    const groupSelector = this.isWeekView
      ? ".post-week-section-group"
      : ".post-section-group";
    const contentSelector = this.isWeekView
      ? ".post-week-section-content"
      : ".post-section-content";
    const rowSelector = this.isWeekView
      ? ".post-week-row:not(.dragging)"
      : ".post-unified-row:not(.dragging)";

    // Знаходимо секцію над якою курсор
    const sectionGroups = Array.from(
      this.calendarGrid.querySelectorAll(groupSelector),
    );
    let targetSectionContent: Element | null = null;
    let fallbackAddBtn: Element | null = null;

    for (const group of sectionGroups) {
      const rect = group.getBoundingClientRect();
      // Розширюємо зону пошуку трохи вверх і вниз, щоб легше було потрапити
      if (mouseY >= rect.top - 20 && mouseY <= rect.bottom + 20) {
        // Якщо знайшли групу, дивимось чи вона не згорнута
        if (!group.querySelector(".post-toggle-btn.collapsed")) {
          targetSectionContent = group.querySelector(contentSelector);
          fallbackAddBtn = group.querySelector(".post-add-post-btn");
          break;
        }
      }
    }

    if (!targetSectionContent) return;

    const postRows = Array.from(
      targetSectionContent.querySelectorAll(rowSelector),
    );

    for (const row of postRows) {
      const rect = row.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;

      if (mouseY < midpoint) {
        row.parentNode?.insertBefore(this.dragPlaceholder, row);
        return;
      }
    }

    // Якщо курсор нижче всіх постів у цій секції
    if (fallbackAddBtn) {
      fallbackAddBtn.parentNode?.insertBefore(
        this.dragPlaceholder,
        fallbackAddBtn,
      );
    } else {
      targetSectionContent.appendChild(this.dragPlaceholder);
    }
  }

  private finishPostDrag(): void {
    if (
      !this.draggedElement ||
      !this.dragPlaceholder ||
      !this.calendarGrid ||
      !this.draggedSectionId
    )
      return;

    // Знаходимо стару секцію
    const oldSectionIndex = this.sections.findIndex(
      (s) => s.id === this.draggedSectionId,
    );
    if (oldSectionIndex === -1) return;
    const oldSection = this.sections[oldSectionIndex];

    // Знаходимо нову секцію по плейсхолдеру
    const contentSelector = this.isWeekView
      ? ".post-week-section-content"
      : ".post-section-content";
    const rowSelector = this.isWeekView
      ? ".post-week-row, .post-drag-placeholder"
      : ".post-unified-row, .post-drag-placeholder";

    const newSectionContent = this.dragPlaceholder.closest(
      contentSelector,
    ) as HTMLElement;
    if (!newSectionContent) return;

    const newSectionId = parseInt(newSectionContent.dataset.sectionId || "0");
    const newSectionIndex = this.sections.findIndex(
      (s) => s.id === newSectionId,
    );
    if (newSectionIndex === -1) return;
    const newSection = this.sections[newSectionIndex];

    // Визначаємо нову позицію всередині нової секції
    const allElements = Array.from(
      newSectionContent.querySelectorAll(rowSelector),
    );

    let newIndex = 0;
    for (let i = 0; i < allElements.length; i++) {
      if (allElements[i] === this.dragPlaceholder) break;
      if (
        !allElements[i].classList.contains("dragging") &&
        !allElements[i].classList.contains("post-drag-placeholder")
      ) {
        newIndex++;
      }
    }

    // Видаляємо зі старої секції
    const oldPostIndex = oldSection.posts.findIndex(
      (p) => p.id === this.draggedPostId,
    );
    if (oldPostIndex !== -1) {
      const [movedPost] = oldSection.posts.splice(oldPostIndex, 1);

      // Додаємо в нову секцію
      newSection.posts.splice(newIndex, 0, movedPost);
    }

    // Очищуємо
    this.draggedElement.classList.remove("dragging");
    this.draggedElement.style.position = "";
    this.draggedElement.style.width = "";
    this.draggedElement.style.left = "";
    this.draggedElement.style.top = "";
    this.draggedElement.style.zIndex = "";
    this.draggedElement.style.pointerEvents = "";

    this.dragPlaceholder.remove();
    this.dragPlaceholder = null;
    this.draggedElement = null;
    this.draggedSectionId = null;
    this.draggedPostId = null;

    // Перемальовуємо
    this.renderCurrentView();
  }

  private formatFullDate(date: Date): string {
    const days = [
      "Неділя",
      "Понеділок",
      "Вівторок",
      "Середа",
      "Четвер",
      "Пʼятниця",
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
    return `${days[date.getDay()]}, ${date.getDate()} ${
      months[date.getMonth()]
    } ${date.getFullYear()}`;
  }

  private getMonthName(monthIndex: number): string {
    const months = [
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
    return months[monthIndex];
  }

  public getStaffName(id: number): string | undefined { return this.staffNames.get(id); }

  public invalidateOccupancy(): void {
    this.occupancyCacheGeneration++;
    this.loadedOccupancyMonths.clear();
    this.monthOccupancyPending.clear();
    this.occupancyVersions.clear();
  }

  private async loadMonthOccupancyStats(year: number, month: number): Promise<void> {
    const normalized = new Date(year, month, 1);
    year = normalized.getFullYear();
    month = normalized.getMonth();
    const key = year + "-" + month;
    if (this.loadedOccupancyMonths.has(key)) return;
    const existing = this.monthOccupancyPending.get(key);
    if (existing) return existing;
    const generation = this.occupancyCacheGeneration;
    const pending = this.fetchOccupancyRange(new Date(year, month, 1), new Date(year, month + 1, 1))
      .then(() => { if (generation === this.occupancyCacheGeneration) this.loadedOccupancyMonths.add(key); });
    this.monthOccupancyPending.set(key, pending);
    try { await pending; } finally {
      if (this.monthOccupancyPending.get(key) === pending) this.monthOccupancyPending.delete(key);
    }
  }

  private async fetchOccupancyRange(start: Date, end: Date): Promise<void> {
    const scope = localStorage.getItem("userAuthData") || "";
    const generation = this.occupancyCacheGeneration;
    const version = ++this.occupancyVersion;
    const days: string[] = [];
    for (const date = new Date(start); date < end; date.setDate(date.getDate() + 1)) {
      const key = plannerDateKey(date);
      days.push(key);
      this.occupancyVersions.set(key, version);
    }
    const rows = await readPlannerOccupancy(start, end);
    if (scope !== (localStorage.getItem("userAuthData") || "")) throw new Error("Контекст користувача змінився");
    if (generation !== this.occupancyCacheGeneration) return;
    const grouped = new Map<string, Map<number, number>>();
    for (const row of rows) {
      if (!grouped.has(row.day)) grouped.set(row.day, new Map());
      grouped.get(row.day)!.set(Number(row.post), Number(row.minutes));
    }
    const totalPosts = this.sections.reduce((sum, section) => sum + section.posts.length, 0);
    for (const day of days) {
      if (this.occupancyVersions.get(day) !== version) continue;
      // Empty replies clear the old occupancy after a move or delete.
      this.monthOccupancyStats.delete(day);
      const postOccupancy = grouped.get(day);
      if (postOccupancy) this.monthOccupancyStats.set(day, { date: day, postOccupancy, totalPosts });
    }
  }

  public async applyRecordChanges(changes: PlannerRecordChange[]): Promise<void> {
    const scope = localStorage.getItem("userAuthData") || "";
    while (this.weekIsBlockDragging || this.weekIsResizing || this.weekDragActive || this.postArxiv?.isInteracting()) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    if (scope !== (localStorage.getItem("userAuthData") || "")) return;
    const dates = new Set<string>();
    const occupied = (record: any) => [record?.data_on, record?.data_off, record?.name_post]
      .map(value => String(value ?? "")).join("|");
    for (const change of changes) {
      const id = Number(change.record.post_arxiv_id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      // A newer event may arrive while a drag/resize is still in progress.
      const current = getPlannerRecord(id);
      const record = current || change.record;
      const latestChange: PlannerRecordChange = {
        ...change, record, type: current ? (change.type === "DELETE" ? "UPDATE" : change.type)
          : isPlannerRecordDeleted(id) ? "DELETE" : change.type,
      };
      this.calendarGrid?.querySelectorAll('.post-week-block[data-post-arxiv-id="' + id + '"]')
        .forEach(block => block.remove());
      if (this.isWeekView) {
        if (latestChange.type !== "DELETE") this.renderWeekArxivRecord(record,
          new Map([[Number(record.client_id), record.client_data || {}]]),
          new Map([[Number(record.cars_id), record.car_data || {}]]));
      } else {
        this.postArxiv?.applyRecordChange(latestChange);
      }
      if (change.type !== "UPDATE" || occupied(change.previous) !== occupied(record)) {
        for (const item of [change.previous, record]) {
          if (!item?.data_on) continue;
          const date = new Date(item.data_on);
          if (Number.isFinite(date.getTime())) dates.add(plannerDateKey(date));
        }
      }
    }
    if (changes.some(change => change.reconcileOccupancy)) {
      // Unknown old membership can affect either displayed calendar month.
      // The compact aggregate is sufficient; visible booking rows were applied above.
      this.invalidateOccupancy();
      await this.refreshOccupancyIndicators();
    } else if (dates.size) await this.refreshOccupancyIndicatorsForDates([...dates]);
  }

  public async refreshChangedPlannerDates(dates: string[]): Promise<void> {
    const key = (date: Date) => String(date.getFullYear()) + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
    const visibleDays = this.isWeekView ? this.getWeekDays(this.selectedDate).map(key) : [key(this.selectedDate)];
    if (dates.some(date => visibleDays.includes(date.slice(0,10)))) {
      if (this.isWeekView) {
        this.calendarGrid?.querySelectorAll('.post-week-block').forEach(block => block.remove());
        await this.loadWeekArxivData();
      } else {
        this.postArxiv?.clearAllBlocks();
        await this.postArxiv?.loadArxivDataForCurrentDate();
      }
    }
    // Both displayed calendar months; hidden months are loaded on navigation.
    const visibleMonths = new Set([key(new Date(this.viewYear,this.viewMonth,1)).slice(0,7),key(new Date(this.viewYear,this.viewMonth+1,1)).slice(0,7),key(new Date(this.selectedDate.getFullYear(),this.selectedDate.getMonth(),1)).slice(0,7),key(new Date(this.selectedDate.getFullYear(),this.selectedDate.getMonth()+1,1)).slice(0,7)]);
    const affected = dates.filter(date => visibleMonths.has(date.slice(0,7)));
    if (affected.length) await this.refreshOccupancyIndicatorsForDates(affected);
  }

  // A normal mutation reads only affected days. Full months are for initial load/reconnect.
  public async refreshOccupancyIndicatorsForDates(dates: string[]): Promise<void> {
    const visibleMonths = new Set([
      plannerDateKey(new Date(this.viewYear, this.viewMonth, 1)).slice(0, 7),
      plannerDateKey(new Date(this.viewYear, this.viewMonth + 1, 1)).slice(0, 7),
    ]);
    const days = [...new Set(dates.map(value => value.slice(0, 10)))]
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
    const visible: Date[] = [];
    for (const key of days) {
      const [year, month, day] = key.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      if (plannerDateKey(date) !== key) continue;
      if (!visibleMonths.has(key.slice(0, 7))) {
        this.loadedOccupancyMonths.delete(year + "-" + (month - 1));
        continue;
      }
      visible.push(date);
    }
    const ranges: { start: Date; end: Date; count: number }[] = [];
    for (const date of visible) {
      const end = new Date(date); end.setDate(end.getDate() + 1);
      const previous = ranges[ranges.length - 1];
      if (previous && previous.end.getTime() === date.getTime() && previous.count < 31) {
        previous.end = end; previous.count++;
      } else ranges.push({ start: date, end, count: 1 });
    }
    await Promise.all(ranges.map(range => this.fetchOccupancyRange(range.start, range.end)));
    this.paintOccupancyIndicators();
  }

  private paintOccupancyIndicators(): void {
    const totalPosts = this.sections.reduce((sum, section) => sum + section.posts.length, 0);
    document.querySelectorAll<HTMLElement>(".day-container[data-date]").forEach(container => {
      container.querySelector(".day-occupancy-indicator")?.remove();
      const stats = this.monthOccupancyStats.get(container.dataset.date!);
      const span = container.querySelector("span");
      if (!stats || !span || !totalPosts) return;
      let minutes = 0, fullPosts = 0;
      for (const value of stats.postOccupancy.values()) { minutes += value; if (value >= 720) fullPosts++; }
      if (minutes > 0) container.insertBefore(this.createOccupancyIndicator(
        minutes / (totalPosts * 720) * 100, fullPosts === totalPosts), span);
    });
  }

  public async refreshOccupancyIndicators(monthsAlreadyLoaded = false): Promise<void> {
    if (!monthsAlreadyLoaded) await Promise.all([
      this.loadMonthOccupancyStats(this.viewYear, this.viewMonth),
      this.loadMonthOccupancyStats(this.viewYear, this.viewMonth + 1),
    ]);
    this.paintOccupancyIndicators();
  }

  private createOccupancyIndicator(
    occupancyPercent: number,
    isFullyOccupied: boolean,
  ): SVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "day-occupancy-indicator");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");

    const centerX = 12;
    const centerY = 12;
    const radius = 10;

    // Фоновий круг
    const bgCircle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    bgCircle.setAttribute("cx", centerX.toString());
    bgCircle.setAttribute("cy", centerY.toString());
    bgCircle.setAttribute("r", radius.toString());
    bgCircle.setAttribute("fill", "#e0e0e0");
    bgCircle.setAttribute("opacity", "0.2");
    svg.appendChild(bgCircle);

    if (occupancyPercent > 0) {
      // Кольорова схема
      let fillColor = "#4caf50"; // Зелений
      if (isFullyOccupied || occupancyPercent >= 99.9) {
        fillColor = "#f44336"; // Червоний - всі пости завантажені
      } else if (occupancyPercent > 66) {
        fillColor = "#ff9800"; // Помаранчевий
      }

      // Якщо 100% (або майже), малюємо повне коло замість шляху, бо path зникає при 360 градусах
      if (occupancyPercent >= 99.9) {
        const fullCircle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        fullCircle.setAttribute("cx", centerX.toString());
        fullCircle.setAttribute("cy", centerY.toString());
        fullCircle.setAttribute("r", radius.toString());
        fullCircle.setAttribute("fill", fillColor);
        fullCircle.setAttribute("opacity", "0.8");
        svg.appendChild(fullCircle);
      } else {
        // Розраховуємо кут для заливки (0% = 0°, 100% = 360°)
        // Мінімальний кут 20° (5.5%) щоб індикатор був видимий при низькій завантаженості
        const rawAngle = (occupancyPercent / 100) * 360;
        const angle = Math.max(rawAngle, 20);
        const angleRad = (angle * Math.PI) / 180;

        // Координати кінцевої точки дуги (починаємо зверху, тобто -90°)
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + angleRad;

        const x1 = centerX + radius * Math.cos(startAngle);
        const y1 = centerY + radius * Math.sin(startAngle);
        const x2 = centerX + radius * Math.cos(endAngle);
        const y2 = centerY + radius * Math.sin(endAngle);

        // Визначаємо чи дуга більша за 180°
        const largeArcFlag = angle > 180 ? 1 : 0;

        // Створюємо path для плавної заливки
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        const pathData = [
          `M ${centerX} ${centerY}`,
          `L ${x1} ${y1}`,
          `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
          "Z",
        ].join(" ");

        path.setAttribute("d", pathData);
        path.setAttribute("fill", fillColor);
        path.setAttribute("opacity", "0.8");

        svg.appendChild(path);
      }
    }

    return svg;
  }

  private async renderMonth(year: number, month: number): Promise<HTMLElement> {
    // Завантажуємо статистику для місяця
    try { await this.loadMonthOccupancyStats(year, month); }
    catch { showNotification("Не вдалося оновити зайнятість календаря. Повторіть відкриття місяця.", "error"); }

    const monthDiv = document.createElement("div");
    monthDiv.className = "post-month-calendar";

    const h3 = document.createElement("h3");
    h3.textContent = this.getMonthName(month);
    monthDiv.appendChild(h3);

    const weekdaysDiv = document.createElement("div");
    weekdaysDiv.className = "post-weekdays";
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].forEach((d) => {
      const span = document.createElement("span");
      span.textContent = d;
      weekdaysDiv.appendChild(span);
    });
    monthDiv.appendChild(weekdaysDiv);

    const daysDiv = document.createElement("div");
    daysDiv.className = "post-days";

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const totalPosts = this.sections.reduce((sum, section) => sum + section.posts.length, 0);
    let startDay = firstDay.getDay();
    if (startDay === 0) startDay = 7;

    for (let i = 1; i < startDay; i++) {
      daysDiv.appendChild(document.createElement("span"));
    }

    for (let day = 1; day <= lastDay.getDate(); day++) {
      const dayContainer = document.createElement("div");
      dayContainer.className = "day-container";

      const span = document.createElement("span");
      span.textContent = day.toString();
      const current = new Date(year, month, day);
      dayContainer.dataset.date = plannerDateKey(current);
      const dayOfWeek = current.getDay();

      if (current.toDateString() === this.selectedDate.toDateString()) {
        span.className = "post-selected-date";
      } else if (current.toDateString() === this.today.toDateString()) {
        span.className = "post-today";
      }

      // Додаємо клас для вихідних днів (субота = 6, неділя = 0)
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        dayContainer.classList.add("post-weekend");
      }

      dayContainer.addEventListener("click", () => {
        const oldMonth = this.selectedDate.getMonth();
        const oldYear = this.selectedDate.getFullYear();
        this.selectedDate = new Date(year, month, day);
        this.viewMonth = this.selectedDate.getMonth();
        this.viewYear = this.selectedDate.getFullYear();

        if (this.isWeekView) {
          // Тижневий вид — показуємо тиждень (Пн-Нд) що містить обраний день
          this.render();
          this.loadWeekArxivData();
        } else {
          // Денний вид — показуємо саме той день
          const monthChanged =
            oldMonth !== this.viewMonth || oldYear !== this.viewYear;
          if (monthChanged) {
            this.render();
          } else {
            this.updateDateSelection();
          }
          this.reloadArxivData();
        }
      });

      // Додаємо індикатор зайнятості
      // Використовуємо локальну дату замість ISO для уникнення зміщення часового поясу
      const yearStr = current.getFullYear();
      const monthStr = String(current.getMonth() + 1).padStart(2, "0");
      const dayStr = String(current.getDate()).padStart(2, "0");
      const dateKey = `${yearStr}-${monthStr}-${dayStr}`;
      const stats = this.monthOccupancyStats.get(dateKey);

      if (stats && totalPosts > 0) {
        // Рахуємо загальну зайнятість (робочий день = 12 годин = 720 хв)
        const workDayMinutes = 720;
        let totalMinutes = 0;
        let fullyOccupiedPosts = 0;

        for (const [, minutes] of stats.postOccupancy) {
          totalMinutes += minutes;
          if (minutes >= workDayMinutes) {
            fullyOccupiedPosts++;
          }
        }

        // Загальна зайнятість = сума хвилин всіх постів / (кількість постів * робочий день) * 100
        const maxMinutes = totalPosts * workDayMinutes;
        const occupancyPercent = (totalMinutes / maxMinutes) * 100;
        const isFullyOccupied = fullyOccupiedPosts === totalPosts;

        if (occupancyPercent > 0) {
          const indicator = this.createOccupancyIndicator(
            occupancyPercent,
            isFullyOccupied,
          );
          dayContainer.appendChild(indicator);
        }
      }

      dayContainer.appendChild(span);
      daysDiv.appendChild(dayContainer);
    }

    monthDiv.appendChild(daysDiv);
    return monthDiv;
  }

  private async renderMiniCalendar(): Promise<void> {
    const generation = ++this.renderGeneration;
    const year = this.viewYear, month = this.viewMonth;
    const yearDisplay = document.getElementById("postYearDisplay");
    if (yearDisplay) yearDisplay.textContent = year.toString();
    if (!this.calendarContainer) return;
    const next = new Date(year, month + 1, 1);
    const [currentMonth, nextMonth] = await Promise.all([
      this.renderMonth(year, month), this.renderMonth(next.getFullYear(), next.getMonth()),
    ]);
    if (generation !== this.renderGeneration) return;
    this.calendarContainer.replaceChildren(currentMonth, nextMonth);
  }

  private async render(): Promise<void> {
    if (this.isWeekView) {
      this.renderWeekView();
    } else {
      const stickyHeader = document.querySelector(".post-sticky-header") as HTMLElement | null;
      if (stickyHeader) stickyHeader.style.display = "";
      this.schedulerWrapper?.classList.remove("week-view-mode");
      if (this.headerDateDisplay) this.headerDateDisplay.textContent = this.formatFullDate(this.selectedDate);
      this.updateTimeMarker();
      this.renderSections();
    }
    await this.renderMiniCalendar();
  }

}

let schedulerAppInstance: SchedulerApp | null = null;

document.addEventListener("DOMContentLoaded", async () => {
  // Check if we are on the planner page
  if (document.getElementById("postSchedulerWrapper")) {
    if (!(await waitForMainAuthentication())) return;
    if (isGeneralSettingsLoadedThisSession()) {
      loadGeneralSettingsFromLocalStorage();
    } else {
      await loadGeneralSettingsFromDB();
      markGeneralSettingsAsLoaded();
    }

    await Promise.all([
      loadAndApplyVoiceInputSetting(), loadAndApplyPhoneIndicatorSetting(),
      loadAndApplyAiProSetting(), loadAndApplyFavicon(),
    ]);
    subscribeToSettingsRealtime();

    schedulerAppInstance = new SchedulerApp();
  }
});

// Глобальна функція для оновлення календаря після створення акту
async function refreshPlannerCalendarOnce(dates: string[] | null): Promise<void> {
  if (!schedulerAppInstance) return;
  if (dates) { await schedulerAppInstance.refreshChangedPlannerDates(dates); return; }
  schedulerAppInstance.invalidateOccupancy();
  if (schedulerAppInstance["isWeekView"]) await schedulerAppInstance["loadWeekArxivData"](true);
  else await schedulerAppInstance["postArxiv"]?.loadArxivDataForCurrentDate(true);
  await schedulerAppInstance.refreshOccupancyIndicators();
}

(window as any).applyPlannerRecordChanges = async (changes: PlannerRecordChange[]) => {
  if (schedulerAppInstance) await schedulerAppInstance.applyRecordChanges(changes);
};
(window as any).getPlannerStaffName = (id: number) => schedulerAppInstance?.getStaffName(Number(id));

let plannerRefreshPending: Promise<void> | null = null;
let plannerRefreshQueued = false;
let plannerNeedsFullRefresh = false;
const plannerChangedDates = new Set<string>();
(window as any).refreshPlannerCalendar = async (dates?: string[]) => {
  if (!dates) plannerNeedsFullRefresh = true;
  else dates.forEach(date => plannerChangedDates.add(date));
  if (plannerRefreshPending) {
    plannerRefreshQueued = true;
    return plannerRefreshPending;
  }
  const pending = (async () => {
    do {
      plannerRefreshQueued = false;
      const changed = plannerNeedsFullRefresh ? null : [...plannerChangedDates];
      plannerNeedsFullRefresh = false;
      plannerChangedDates.clear();
      await refreshPlannerCalendarOnce(changed);
    } while (plannerRefreshQueued);
  })();
  plannerRefreshPending = pending;
  try { await pending; } finally { plannerRefreshPending = null; }
};

// Глобальна функція для швидкого оновлення тільки індикаторів
(window as any).refreshOccupancyIndicators = async () => {
  if (schedulerAppInstance) {
    await schedulerAppInstance.refreshOccupancyIndicators();
  }
};

// Глобальна функція для оновлення індикаторів конкретних дат
(window as any).refreshOccupancyIndicatorsForDates = async (
  dates: string[],
) => {
  if (schedulerAppInstance) {
    await schedulerAppInstance.refreshOccupancyIndicatorsForDates(dates);
  }
};

// Допоміжна функція для парсингу дати з DOM елементів
(window as any).parseCurrentDate = (): string | null => {
  // Спробуємо з postHeaderDateDisplay
  const headerDate = document.getElementById("postHeaderDateDisplay");
  if (headerDate && headerDate.textContent) {
    const match = headerDate.textContent.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
    if (match) {
      const day = match[1].padStart(2, "0");
      const monthName = match[2];
      const year = match[3];

      const months: Record<string, string> = {
        січня: "01",
        лютого: "02",
        березня: "03",
        квітня: "04",
        травня: "05",
        червня: "06",
        липня: "07",
        серпня: "08",
        вересня: "09",
        жовтня: "10",
        листопада: "11",
        грудня: "12",
      };

      const month = months[monthName.toLowerCase()];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }
  }

  // Спробуємо з модального вікна
  const hDay = document.getElementById("hDay");
  const hMonth = document.getElementById("hMonth");
  const hYear = document.getElementById("hYear");

  if (hDay && hMonth && hYear) {
    const day = hDay.textContent?.trim().padStart(2, "0");
    const monthName = hMonth.textContent?.trim();
    const year = hYear.textContent?.trim();

    const months: Record<string, string> = {
      січня: "01",
      лютого: "02",
      березня: "03",
      квітня: "04",
      травня: "05",
      червня: "06",
      липня: "07",
      серпня: "08",
      вересня: "09",
      жовтня: "10",
      листопада: "11",
      грудня: "12",
    };

    const month = monthName ? months[monthName.toLowerCase()] : null;
    if (day && month && year) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
};
