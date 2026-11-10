/** Універсальний автокомпліт для глобального поля пошуку у вкладках
 *   - Показує <div id="custom-dropdown-all_other_bases"> ПІД полем
 *   - Нічого не вставляє всередину інпута, працює поверх (absolute)
 */
export function wireGlobalAutocomplete(items: string[]) {
  const input = document.getElementById("search-input-all_other_bases") as HTMLInputElement | null;
  const dd = document.getElementById("custom-dropdown-all_other_bases") as HTMLDivElement | null;
  if (!input || !dd) return;

  const render = (q: string) => {
    const ql = (q ?? "").toLowerCase();
    const list = items.filter(x => x.toLowerCase().includes(ql)).slice(0, 200);
    if (!list.length) { dd.classList.add("hidden-all_other_bases"); dd.innerHTML = ""; return; }

    dd.innerHTML = "";
    for (const v of list) {
      const el = document.createElement("div");
      el.className = "custom-dropdown-item";
      el.textContent = v;
      const onSelect = (e?: Event) => {
        if (e && (e.type === "mousedown" || e.type === "pointerdown")) e.preventDefault();
        input.value = v;               // просто підставляємо значення
        dd.classList.add("hidden-all_other_bases");
        input.dispatchEvent(new Event("change"));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };

      el.addEventListener("mousedown", onSelect);
      el.addEventListener("pointerdown", onSelect);
      el.addEventListener("click", onSelect);
      dd.appendChild(el);
    }
    dd.classList.remove("hidden-all_other_bases");
  };

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("focus", () => render(input.value));
  document.addEventListener("click", (e) => {
    if (e.target !== input && !dd.contains(e.target as Node)) {
      dd.classList.add("hidden-all_other_bases");
    }
  });
}

/**
 * Adds keyboard navigation (ArrowUp, ArrowDown, Enter) to a custom dropdown.
 * Requires dropdown items to have class 'custom-dropdown-item'.
 * Selected item gets class 'selected'.
 */
export function setupDropdownKeyboard(
  input: HTMLInputElement | HTMLTextAreaElement,
  dropdown: HTMLElement
) {
  if (input.dataset.keyboardNavBound === "true") return;

  input.addEventListener("keydown", (evt: Event) => {
    const e = evt as KeyboardEvent;
    if (dropdown.classList.contains("hidden-all_other_bases")) return;

    const items = dropdown.querySelectorAll(".custom-dropdown-item");
    if (!items.length) return;

    let idx = -1;
    items.forEach((it, i) => {
      if (it.classList.contains("selected")) idx = i;
    });

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = idx < items.length - 1 ? idx + 1 : 0;
      highlightItem(items, nextIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIdx = idx > 0 ? idx - 1 : items.length - 1;
      highlightItem(items, prevIdx);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (idx >= 0) {
        // Не блокуємо Tab/Enter: значення вибирається, а фокус може піти далі.
        (items[idx] as HTMLElement).click();
      }
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden-all_other_bases");
    }
  });

  input.dataset.keyboardNavBound = "true";

  function highlightItem(items: NodeListOf<Element>, index: number) {
    items.forEach((item, i) => {
      const el = item as HTMLElement;
      if (i === index) {
        item.classList.add("selected");
        el.style.backgroundColor = "#e3f2fd";
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("selected");
        el.style.backgroundColor = "white"; // Reset background
      }
    });
  }
}
