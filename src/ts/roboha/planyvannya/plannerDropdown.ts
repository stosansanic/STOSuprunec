import type { ClientFormPage } from "../redahyvatu_klient_machuna/clientFormOptions";

interface PlannerDropdownOptions {
  input: HTMLInputElement;
  list: HTMLElement;
  loadPage: (query: string, after: number | null) => Promise<ClientFormPage>;
  label: (item: any) => string;
  subtitle?: (item: any) => string;
  onSelect: (item: any) => void | Promise<void>;
  onInput?: () => void;
  isCurrent?: () => boolean;
  minLength?: number;
  normalize?: (value: string) => string;
  onError?: (error: unknown) => void;
}

/** Owns only one menu and its listeners; the modal owns cached 20-item pages. */
export function mountPlannerDropdown(options: PlannerDropdownOptions) {
  const { input, list } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const normalize = options.normalize ?? ((value: string) => value.trim().toLocaleLowerCase());
  const previousAttributes = new Map(
    ["role", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"]
      .map(name => [name, input.getAttribute(name)] as const),
  );
  const previousListRole = list.getAttribute("role");
  const choices: HTMLElement[] = [];
  let generation = 0;
  let open = false;
  let loading = false;
  let failed = false;
  let query = "";
  let after: number | null = null;
  let hasMore = true;
  let activeIndex = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scrollIntent = false;
  let touchY: number | null = null;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");

  const available = () => !signal.aborted && input.isConnected && !input.disabled
    && !input.readOnly && (options.isCurrent?.() ?? true);
  const current = (token: number) => available() && open && generation === token
    && document.activeElement === input && normalize(input.value) === query;

  function clearStatus() {
    list.querySelectorAll("[data-planner-options-status]").forEach(node => node.remove());
  }

  function position() {
    if (!open) return;
    list.classList.remove("post-arxiv-autocomplete-dropdown-up");
    const rect = list.getBoundingClientRect();
    const field = input.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 10 && field.top > window.innerHeight - field.bottom) {
      list.classList.add("post-arxiv-autocomplete-dropdown-up");
    }
  }

  function showStatus(message: string, retry = false) {
    clearStatus();
    const status = document.createElement("div");
    status.className = "post-arxiv-autocomplete-option";
    status.dataset.plannerOptionsStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = message;
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.textContent = "Повторити";
      button.style.marginLeft = "8px";
      button.addEventListener("click", event => {
        event.stopPropagation();
        retryPage();
      }, { signal });
      status.append(button);
    }
    list.append(status);
    position();
  }

  function close() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    open = false;
    loading = false;
    failed = false;
    scrollIntent = false;
    touchY = null;
    activeIndex = -1;
    choices.length = 0;
    list.replaceChildren();
    list.style.display = "none";
    list.removeAttribute("aria-busy");
    list.classList.remove("post-arxiv-autocomplete-dropdown-up");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function appendItem(item: any) {
    const label = options.label(item);
    if (!label) return;
    const choice = document.createElement("div");
    choice.className = "post-arxiv-autocomplete-option";
    choice.id = `${list.id}-option-${generation}-${choices.length}`;
    choice.setAttribute("role", "option");
    choice.setAttribute("aria-selected", "false");
    const main = document.createElement("div");
    main.className = "post-arxiv-autocomplete-option-main";
    main.textContent = label;
    choice.append(main);
    const subtitle = options.subtitle?.(item);
    if (subtitle) {
      const sub = document.createElement("div");
      sub.className = "post-arxiv-autocomplete-option-sub";
      sub.textContent = subtitle;
      choice.append(sub);
    }
    choice.addEventListener("click", event => {
      event.stopPropagation();
      if (!current(generation)) return;
      input.value = label;
      close();
      try {
        Promise.resolve(options.onSelect(item)).catch(error => options.onError?.(error));
      } catch (error) {
        options.onError?.(error);
      }
    }, { signal });
    // Equal names can represent different clients: keep both choices.
    choices.push(choice);
    list.append(choice);
  }

  async function loadNext() {
    if (!current(generation) || loading || failed || !hasMore) return;
    const token = generation;
    const cursor = after;
    loading = true;
    scrollIntent = false;
    list.setAttribute("aria-busy", "true");
    showStatus("Завантаження…");
    try {
      const page = await options.loadPage(query, cursor);
      if (!current(token)) return;
      if (!Array.isArray(page.items) || typeof page.has_more !== "boolean"
        || (page.has_more && (page.next_cursor === null || page.next_cursor === cursor))) {
        throw new Error("Не вдалося прочитати підказки.");
      }
      clearStatus();
      page.items.forEach(appendItem);
      after = page.next_cursor;
      hasMore = page.has_more;
      if (!choices.length) showStatus(hasMore
        ? "Прокрутіть список, щоб завантажити наступні підказки."
        : "Збігів не знайдено. Можна ввести вручну.");
      position();
    } catch (error) {
      if (!current(token)) return;
      failed = true;
      showStatus(error instanceof Error ? error.message : "Не вдалося завантажити підказки.", true);
    } finally {
      if (current(token)) {
        loading = false;
        list.removeAttribute("aria-busy");
      }
      // Never automatically drain pages to fill the menu after a response.
    }
  }

  function retryPage() {
    if (!failed || !current(generation)) return;
    failed = false;
    void loadNext();
  }

  function begin() {
    clearTimeout(timer);
    timer = undefined;
    if (!available() || document.activeElement !== input) { close(); return; }
    const nextQuery = normalize(input.value);
    if (!nextQuery || nextQuery.length < (options.minLength ?? 3)) { close(); return; }
    if (open && nextQuery === query) {
      if (failed) retryPage();
      return;
    }
    close();
    query = nextQuery;
    after = null;
    hasMore = true;
    open = true;
    list.style.display = "block";
    list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
    void loadNext();
  }

  function maybeLoad() {
    if (scrollIntent && list.clientHeight > 0
      && list.scrollHeight - list.scrollTop - list.clientHeight <= 40) {
      scrollIntent = false;
      void loadNext();
    }
  }

  input.addEventListener("focus", begin, { signal });
  input.addEventListener("click", begin, { signal });
  input.addEventListener("input", () => {
    close();
    options.onInput?.();
    const nextQuery = normalize(input.value);
    if (nextQuery && nextQuery.length >= (options.minLength ?? 3)) {
      timer = setTimeout(begin, 300);
    }
  }, { signal });
  input.addEventListener("blur", close, { signal });
  list.addEventListener("mousedown", event => {
    // Preserve input focus for option selection, retry and scrollbar dragging.
    event.preventDefault();
    scrollIntent = true;
  }, { signal });
  list.addEventListener("wheel", event => {
    if (event.deltaY <= 0) return;
    scrollIntent = true;
    maybeLoad();
  }, { signal, passive: true });
  list.addEventListener("touchstart", event => {
    touchY = event.touches[0]?.clientY ?? null;
  }, { signal, passive: true });
  list.addEventListener("touchmove", event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y < touchY) {
      scrollIntent = true;
      maybeLoad();
    }
    touchY = y ?? null;
  }, { signal, passive: true });
  list.addEventListener("scroll", maybeLoad, { signal, passive: true });
  document.addEventListener("pointerdown", event => {
    if (event.target instanceof Node && event.target !== input && !list.contains(event.target)) close();
  }, { signal });
  window.addEventListener("resize", position, { signal });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); }
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) { begin(); return; }
      if (failed) { retryPage(); return; }
      if (!choices.length) { void loadNext(); return; }
      if (event.key === "ArrowDown" && activeIndex === choices.length - 1 && hasMore) {
        void loadNext();
        return;
      }
      activeIndex = event.key === "ArrowDown" ? Math.min(activeIndex + 1, choices.length - 1)
        : activeIndex < 0 ? choices.length - 1 : Math.max(0, activeIndex - 1);
      choices.forEach((choice, index) => {
        const active = index === activeIndex;
        choice.setAttribute("aria-selected", String(active));
        choice.style.backgroundColor = active ? "#e8f5e9" : "";
      });
      input.setAttribute("aria-activedescendant", choices[activeIndex].id);
      // Keyboard selection scrolls only loaded choices; another ArrowDown at
      // the last choice requests the next page.
      scrollIntent = false;
      choices[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open) {
      if (activeIndex >= 0 && choices[activeIndex]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        choices[activeIndex].click();
      } else if (failed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        retryPage();
      }
    }
  }, { signal, capture: true });

  return {
    close,
    dispose() {
      close();
      controller.abort();
      for (const [name, value] of previousAttributes) {
        if (value === null) input.removeAttribute(name);
        else input.setAttribute(name, value);
      }
      if (previousListRole === null) list.removeAttribute("role");
      else list.setAttribute("role", previousListRole);
    },
  };
}
