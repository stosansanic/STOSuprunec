import type { ClientFormPage } from "./clientFormOptions";

interface ClientFormDropdownOptions {
  input: HTMLInputElement | HTMLTextAreaElement;
  list: HTMLUListElement;
  items: any[];
  label: (item: any) => string;
  onSelect: (item: any) => void | Promise<void>;
  showOnFocus?: boolean;
  minLength?: number;
  customFilter?: (item: any, query: string) => boolean;
  loadPage?: (query: string, after: number | null) => Promise<ClientFormPage>;
  deduplicate?: boolean;
  onError?: (error: unknown) => void;
  onInput?: () => void;
  isCurrent?: () => boolean;
}

/** One dropdown instance owns its listeners. Data caching belongs to the modal. */
export function mountClientFormDropdown(options: ClientFormDropdownOptions) {
  const { input, list, label } = options;
  const controller = new AbortController();
  const signal = controller.signal;
  const previousAutocomplete = input.getAttribute("aria-autocomplete");
  const previousControls = input.getAttribute("aria-controls");
  let generation = 0;
  let query: string | null = null;
  let open = false;
  let loading = false;
  let failed = false;
  let after: number | null = null;
  let remoteMore = false;
  let localItems: any[] = [];
  let localOffset = 0;
  let activeIndex = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  const seen = new Set<string>();
  const choices: HTMLLIElement[] = [];

  list.setAttribute("role", "listbox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");

  const clearStatus = () => list.querySelectorAll("[data-form-options-status]").forEach(node => node.remove());
  const status = (message: string) => {
    clearStatus();
    const item = document.createElement("li");
    item.dataset.formOptionsStatus = "";
    item.setAttribute("role", "status");
    item.textContent = message;
    list.append(item);
  };
  const current = (token: number) => !signal.aborted && open && generation === token
    && input.isConnected && !input.disabled && !input.readOnly && (options.isCurrent?.() ?? true);
  const more = () => localOffset < localItems.length || remoteMore;

  function close() {
    generation++;
    open = false;
    loading = false;
    query = null;
    clearTimeout(timer);
    clearTimeout(blurTimer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    list.replaceChildren();
    list.removeAttribute("aria-busy");
    choices.length = 0;
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function appendItem(item: any) {
    const token = generation;
    const text = label(item);
    if (!text) return;
    const identity = text.trim().toLocaleLowerCase();
    if (options.deduplicate && seen.has(identity)) return;
    seen.add(identity);
    const li = document.createElement("li");
    li.textContent = text;
    li.id = `${list.id}-option-${choices.length}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.addEventListener("click", () => {
      if (!current(token) || li.parentElement !== list) return;
      input.value = text;
      close();
      let selectedGeneration = generation;
      const reportSelectionError = (error: unknown) => {
        if (!signal.aborted && generation === selectedGeneration && input.isConnected
          && (options.isCurrent?.() ?? true)) options.onError?.(error);
      };
      // Selecting one option does not restart a search for its new input value.
      try {
        const selected = options.onSelect(item);
        // A selection may synchronously close all sibling dropdowns (including
        // this one) before awaiting its record. That is still the same choice.
        selectedGeneration = generation;
        Promise.resolve(selected).catch(reportSelectionError);
      } catch (error) { selectedGeneration = generation; reportSelectionError(error); }
      if (input instanceof HTMLTextAreaElement) {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight}px`;
      }
    });
    choices.push(li);
    list.append(li);
  }

  function appendLocal() {
    const until = Math.min(localOffset + 20, localItems.length);
    while (localOffset < until) appendItem(localItems[localOffset++]);
  }

  async function loadNext(initial = false) {
    if (!open || loading || failed || (!initial && !more())) return;
    if (!(options.isCurrent?.() ?? true)) { close(); return; }
    const token = generation;
    const before = choices.length;
    const search = query!;
    loading = true;
    list.setAttribute("aria-busy", "true");
    clearStatus();
    const hadLocal = localOffset < localItems.length;
    appendLocal();
    try {
      // Show a compact remote page alongside the first local page. Further
      // local suggestions cost no network; fetch the next remote page on demand.
      if (options.loadPage && remoteMore && (initial || !hadLocal)) {
        status("Завантаження…");
        const page = await options.loadPage(search, after);
        if (!current(token)) return;
        if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean"
          || (page.has_more && (!page.items.length || !Number.isSafeInteger(page.next_cursor)
            || page.next_cursor! <= (after ?? 0)))) {
          throw new Error("Некоректна сторінка підказок.");
        }
        clearStatus();
        for (const item of page.items) appendItem(item);
        after = page.next_cursor;
        remoteMore = page.has_more;
      }
      if (!current(token)) return;
      if (!choices.length && !more()) status("Збігів не знайдено. Можна ввести вручну.");
    } catch (error) {
      if (!current(token)) return;
      failed = true;
      const message = error instanceof Error ? error.message : "Не вдалося завантажити підказки.";
      status(`${message} Натисніть поле, щоб повторити.`);
    } finally {
      if (current(token)) {
        loading = false;
        list.removeAttribute("aria-busy");
        // Fill the visible list, but a duplicate-only page must not trigger an
        // automatic scan through the entire remote catalogue.
        if (!failed && more() && choices.length > before && list.scrollHeight <= list.clientHeight) {
          frame = requestAnimationFrame(() => { frame = undefined; maybeLoad(); });
        }
      }
    }
  }

  function maybeLoad() {
    if (open && !loading && !failed && !input.readOnly && !input.disabled && document.activeElement === input
      && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight <= 48) {
      void loadNext();
    }
  }

  function begin(showAll: boolean) {
    if (signal.aborted || input.readOnly || input.disabled || !input.isConnected) return;
    if (!(options.isCurrent?.() ?? true)) { close(); return; }
    const nextQuery = showAll ? "" : input.value.trim().toLocaleLowerCase();
    if (open && query === nextQuery) {
      if (failed) { failed = false; void loadNext(true); }
      return;
    }
    close();
    if (!showAll && nextQuery.length < (options.minLength || 0)) return;
    open = true;
    query = nextQuery;
    failed = false;
    after = null;
    remoteMore = !!options.loadPage;
    localItems = options.items.filter(item => options.customFilter
      ? options.customFilter(item, nextQuery) : label(item).toLocaleLowerCase().includes(nextQuery));
    localOffset = 0;
    seen.clear();
    list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
    void loadNext(true);
  }

  const onFocus = () => { clearTimeout(blurTimer); clearTimeout(timer); begin(!!options.showOnFocus); };
  input.addEventListener("focus", onFocus, { signal });
  input.addEventListener("click", () => {
    // A click follows focus; keep the already opened page instead of reading it twice.
    if (!open) onFocus();
    else if (failed) { failed = false; void loadNext(true); }
  }, { signal });
  input.addEventListener("input", () => {
    close();
    options.onInput?.();
    timer = setTimeout(() => {
      if (document.activeElement === input) begin(false);
    }, 300);
    if (input instanceof HTMLTextAreaElement) {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    }
  }, { signal });
  input.addEventListener("blur", () => {
    clearTimeout(timer);
    blurTimer = setTimeout(close, 150);
  }, { signal });
  // Keep focus during option clicks and scrollbar dragging.
  list.addEventListener("mousedown", event => event.preventDefault(), { signal });
  list.addEventListener("scroll", maybeLoad, { signal, passive: true });
  input.addEventListener("keydown", (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) { event.preventDefault(); onFocus(); return; }
      if (!choices.length) return;
      event.preventDefault();
      if (event.key === "ArrowDown" && activeIndex === choices.length - 1 && more()) {
        void loadNext();
        return;
      }
      activeIndex = event.key === "ArrowDown" ? (activeIndex + 1) % choices.length
        : (activeIndex < 0 ? choices.length - 1 : (activeIndex - 1 + choices.length) % choices.length);
      choices.forEach((node, index) => node.setAttribute("aria-selected", String(index === activeIndex)));
      input.setAttribute("aria-activedescendant", choices[activeIndex].id);
      choices[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open && activeIndex >= 0 && choices[activeIndex]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choices[activeIndex].click();
    }
  }, { signal, capture: true });

  return {
    close,
    dispose() {
      close();
      controller.abort();
      if (previousAutocomplete === null) input.removeAttribute("aria-autocomplete");
      else input.setAttribute("aria-autocomplete", previousAutocomplete);
      if (previousControls === null) input.removeAttribute("aria-controls");
      else input.setAttribute("aria-controls", previousControls);
      input.removeAttribute("aria-expanded");
    },
  };
}
