export interface InvoiceDropdownPage {
  values: string[];
  hasMore: boolean;
  nextOffset: number;
}

export type InvoiceDropdownResult = string[] | InvoiceDropdownPage;
export type InvoiceDropdownReader = (
  query?: string,
  offset?: number,
) => InvoiceDropdownResult | Promise<InvoiceDropdownResult>;

/** A modal-owned dropdown: fetch the next page only when the user reaches it. */
export function attachInvoiceDropdown(
  input: HTMLInputElement | HTMLTextAreaElement,
  dialog: HTMLDialogElement,
  getOptions: InvoiceDropdownReader,
  onSelect: (value: string) => void,
  filterLocally = true,
): () => void {
  const lifetime = new AbortController();
  let list: HTMLUListElement | null = null;
  let generation = 0;
  let opening = false;
  let restoringFocus = false;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let outsideHandler: ((event: MouseEvent) => void) | null = null;
  let repositionHandler: (() => void) | null = null;

  const close = () => {
    generation++;
    opening = false;
    clearTimeout(inputTimer);
    list?.remove();
    list = null;
    if (outsideHandler) document.removeEventListener("mousedown", outsideHandler, true);
    if (repositionHandler) {
      window.removeEventListener("resize", repositionHandler);
      dialog.removeEventListener("scroll", repositionHandler);
    }
    outsideHandler = null;
    repositionHandler = null;
  };

  const focusInput = () => {
    // Escape/selection must not immediately reopen the dropdown through focus.
    restoringFocus = true;
    input.focus();
    restoringFocus = false;
  };

  const position = () => {
    if (!list) return;
    const rect = input.getBoundingClientRect();
    const viewportWidth = Math.max(200, window.innerWidth - 16);
    const context = document.createElement("canvas").getContext("2d");
    let width = rect.width;
    if (context) {
      context.font = "14px Arial";
      for (const item of list.children) {
        width = Math.max(width, context.measureText(item.textContent || "").width + 58);
      }
    }
    width = Math.min(500, viewportWidth, Math.max(200, width));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const roomBelow = Math.max(0, window.innerHeight - rect.bottom - 8);
    const roomAbove = Math.max(0, rect.top - 8);
    const maxHeight = Math.max(1, Math.min(320, Math.max(roomBelow, roomAbove)));
    list.style.position = "fixed";
    list.style.width = `${width}px`;
    list.style.maxHeight = `${maxHeight}px`;
    list.style.left = `${left}px`;
    const menuHeight = Math.min(list.scrollHeight, maxHeight);
    const placeAbove = roomBelow < menuHeight && roomAbove > roomBelow;
    list.style.top = `${placeAbove ? Math.max(8, rect.top - menuHeight - 4) : Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8)}px`;
  };

  const open = async (filterByInput = false, refresh = false) => {
    if (lifetime.signal.aborted || !dialog.open || !input.isConnected) return;
    if ((list || opening) && !refresh) return;
    close();
    const token = ++generation;
    const original = input.value;
    const requestQuery = filterByInput ? original : undefined;
    const localQuery = filterByInput ? original.trim().toLocaleLowerCase() : "";
    const isCurrent = () => token === generation && !lifetime.signal.aborted
      && dialog.open && input.isConnected && original === input.value;
    opening = true;
    let first: InvoiceDropdownResult;
    try {
      first = await getOptions(requestQuery, 0);
    } catch {
      if (token === generation) opening = false;
      return;
    }
    if (token === generation) opening = false;
    if (!isCurrent()) return;

    const menu = document.createElement("ul");
    menu.className = "excel-dropdown-list";
    menu.setAttribute("role", "listbox");
    const seen = new Set<string>();
    let nextOffset = 0;
    let hasMore = false;
    let pending: Promise<void> | null = null;
    const items = () => [...menu.querySelectorAll<HTMLElement>(".excel-dropdown-item")];

    const select = (option: string, fromKeyboard = false) => {
      if (!isCurrent()) return;
      input.value = option;
      close();
      if (fromKeyboard) focusInput();
      onSelect(option);
    };

    const append = (result: InvoiceDropdownResult, offset: number) => {
      const values = Array.isArray(result) ? result : result.values;
      hasMore = !Array.isArray(result) && result.hasMore
        && Number.isFinite(result.nextOffset) && result.nextOffset > offset;
      if (!Array.isArray(result)) nextOffset = result.nextOffset;
      for (const value of values) {
        const option = value.trim();
        if (!option || seen.has(option)
          || (filterLocally && localQuery && !option.toLocaleLowerCase().includes(localQuery))) continue;
        seen.add(option);
        const item = document.createElement("li");
        item.className = "excel-dropdown-item";
        item.textContent = option;
        item.title = option;
        item.tabIndex = 0;
        item.setAttribute("role", "option");
        item.addEventListener("mousedown", event => event.preventDefault());
        item.addEventListener("click", () => select(option));
        item.addEventListener("keydown", event => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            focusInput();
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(option, true);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const options = items();
            const index = options.indexOf(item);
            if (event.key === "ArrowDown" && index === options.length - 1 && hasMore) {
              void loadMore().then(() => {
                if (isCurrent() && document.activeElement === item) items()[index + 1]?.focus();
              });
            } else {
              options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length]?.focus();
            }
          }
        });
        menu.append(item);
      }
    };

    const loadMore = (): Promise<void> => {
      if (pending) return pending;
      if (!hasMore || !isCurrent() || list !== menu) return Promise.resolve();
      const offset = nextOffset;
      menu.setAttribute("aria-busy", "true");
      pending = Promise.resolve().then(async () => {
        try {
          const result = await getOptions(requestQuery, offset);
          if (!isCurrent() || list !== menu) return;
          append(result, offset);
          position();
        } catch {
          // Keep already loaded options and the offset; a later scroll can retry.
        } finally {
          pending = null;
          menu.removeAttribute("aria-busy");
        }
      });
      return pending;
    };

    append(first, 0);
    if (!menu.childElementCount) return;
    list = menu;
    menu.addEventListener("scroll", () => {
      if (menu.scrollHeight - menu.clientHeight - menu.scrollTop <= 64) void loadMore();
    });
    menu.addEventListener("wheel", event => {
      // A page can contain duplicate catalog numbers, leaving no scrollbar.
      // At the bottom there is also no scroll event after a failed page request.
      if (event.deltaY > 0 && menu.scrollHeight - menu.clientHeight - menu.scrollTop <= 1) {
        void loadMore();
      }
    }, { passive: true });
    let shortListTouchY: number | null = null;
    menu.addEventListener("touchstart", event => {
      shortListTouchY = event.touches.length === 1 && menu.scrollHeight <= menu.clientHeight + 1
        ? event.touches[0].clientY : null;
    }, { passive: true });
    menu.addEventListener("touchend", event => {
      const startY = shortListTouchY;
      shortListTouchY = null;
      // A short, deduplicated page cannot scroll. One completed upward swipe
      // requests one page; appending results never starts another request.
      if (startY !== null && event.changedTouches.length === 1
        && startY - event.changedTouches[0].clientY >= 24) void loadMore();
    }, { passive: true });
    menu.addEventListener("touchcancel", () => { shortListTouchY = null; }, { passive: true });
    dialog.append(menu);
    position();
    outsideHandler = event => {
      if (event.target !== input && !menu.contains(event.target as Node)) close();
    };
    repositionHandler = position;
    document.addEventListener("mousedown", outsideHandler, true);
    window.addEventListener("resize", repositionHandler);
    dialog.addEventListener("scroll", repositionHandler);
  };

  input.addEventListener("focus", () => { if (!restoringFocus) void open(); }, { signal: lifetime.signal });
  input.addEventListener("click", () => { void open(); }, { signal: lifetime.signal });
  input.addEventListener("input", () => {
    close();
    inputTimer = setTimeout(() => {
      if (document.activeElement === input) void open(true, true);
    }, 300);
  }, { signal: lifetime.signal });
  input.addEventListener("blur", () => {
    clearTimeout(inputTimer);
    if (opening) close();
  }, { signal: lifetime.signal });
  input.addEventListener("keydown", event => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "ArrowDown") {
      event.preventDefault();
      if (!list) void open().then(() => list?.querySelector<HTMLElement>(".excel-dropdown-item")?.focus());
      else list.querySelector<HTMLElement>(".excel-dropdown-item")?.focus();
    } else if (keyboardEvent.key === "Escape") close();
  }, { signal: lifetime.signal });
  dialog.addEventListener("close", close, { signal: lifetime.signal });
  return () => { lifetime.abort(); close(); };
}
