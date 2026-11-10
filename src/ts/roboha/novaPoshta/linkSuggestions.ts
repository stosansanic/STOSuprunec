import { request } from "./api";
import type { Direction } from "./api";
import { statusIcon } from "./statusIcons";

type Kind = "ttn" | "act";
interface LinkOptions {
  ttns: { ttn: string; direction: Direction; description: string }[];
  acts: { act_id: number; label: string }[];
  ttns_has_more: boolean;
  acts_has_more: boolean;
  page: number;
}
interface Suggestion { value: string; label?: string; description?: string; direction?: Direction }
interface Page { items: Suggestion[]; hasMore: boolean }
let nextId = 0;

/** Only compact archive rows are read; the full provider history is never downloaded here. */
export function linkSuggestions(dialog: HTMLDialogElement, act: HTMLInputElement, ttn: HTMLInputElement | null, chooseDirection: (direction: Direction) => void, autofocus = true) {
  let selectedAct: Suggestion | undefined;
  const pending = new Map<string, Promise<Page>>();
  const key = (kind: Kind, query: string, page: number) => JSON.stringify([kind, query, page]);
  const pageOf = (result: LinkOptions, kind: Kind): Page => kind === "ttn"
    ? { items: result.ttns.map(item => ({ value: item.ttn, description: item.description, direction: item.direction })), hasMore: result.ttns_has_more }
    : { items: result.acts.map(item => ({ value: String(item.act_id), label: item.label })), hasMore: result.acts_has_more };
  const remember = (id: string, work: Promise<Page>) => {
    pending.set(id, work);
    void work.catch(() => { if (pending.get(id) === work) pending.delete(id); });
    return work;
  };
  const initial = request<LinkOptions>("link_options", { kind: !ttn ? "act" : act.readOnly ? "ttn" : "all", page: 1 });
  if (ttn) remember(key("ttn", "", 1), initial.then(result => pageOf(result, "ttn")));
  if (!act.readOnly) remember(key("act", "", 1), initial.then(result => pageOf(result, "act")));
  const load = (kind: Kind, query: string, page: number) => {
    const id = key(kind, query, page);
    return pending.get(id) || remember(id, request<LinkOptions>("link_options", { kind, query, page }).then(result => pageOf(result, kind)));
  };
  const controls = ttn ? [combobox(ttn, dialog, (query, page) => load("ttn", query, page), value => value.replace(/\D/g, ""), item => {
    if (item.direction && item.direction !== "unknown") chooseDirection(item.direction);
  })] : [];
  if (!act.readOnly) controls.push(combobox(act, dialog, (query, page) => load("act", query, page), value => value.trim().slice(0, 120), item => { selectedAct = item; }));
  dialog.addEventListener("close", () => controls.forEach(control => control.dispose()), { once: true });
  if (autofocus) (act.readOnly && ttn ? ttn : act).focus();
  return {
    close: () => controls.forEach(control => control.close()),
    actId: () => selectedAct && act.value === (selectedAct.label || selectedAct.value)
      ? Number(selectedAct.value)
      : /^\d+$/.test(act.value.trim()) ? Number(act.value.trim()) : NaN,
  };
}

function combobox(input: HTMLInputElement, dialog: HTMLDialogElement, load: (query: string, page: number) => Promise<Page>, normalizeQuery: (value: string) => string, select?: (item: Suggestion) => void) {
  const label = input.parentElement!;
  const control = document.createElement("div"); control.className = "np-combo";
  label.replaceWith(control); control.append(label);
  const popup = document.createElement("div"); popup.className = "np-suggestions"; popup.hidden = true;
  const list = document.createElement("div"); list.id = `np-link-options-${++nextId}`;
  list.setAttribute("role", "listbox"); list.setAttribute("aria-label", `${input.getAttribute("aria-label")} — збережені записи`);
  const message = document.createElement("div"); message.className = "np-suggestion-message"; message.setAttribute("role", "status");
  const more = document.createElement("button"); more.type = "button"; more.className = "np-suggestion-more"; more.textContent = "Ще…";
  popup.append(list, message, more); control.append(popup);
  input.autocomplete = "off";
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", list.id); input.setAttribute("aria-expanded", "false");
  let items: Suggestion[] = [], options: HTMLButtonElement[] = [];
  let query = "", page = 0, active = -1, revision = 0, disposed = false, loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setActive = (index: number) => {
    active = index;
    options.forEach((option, at) => option.setAttribute("aria-selected", String(at === index)));
    if (options[index]) {
      input.setAttribute("aria-activedescendant", options[index].id);
      options[index].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const close = () => {
    if (timer) clearTimeout(timer);
    revision++; loading = false; popup.hidden = true;
    input.setAttribute("aria-expanded", "false"); setActive(-1);
  };
  const choose = (item: Suggestion) => {
    if (input.disabled) return;
    input.value = item.label || item.value; input.setCustomValidity(""); select?.(item);
    close(); input.focus(); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const render = () => {
    list.replaceChildren(); active = -1; input.removeAttribute("aria-activedescendant");
    options = items.map((item, index) => {
      const option = document.createElement("button"); option.type = "button"; option.tabIndex = -1;
      option.className = "np-suggestion-option"; option.id = `${list.id}-${index}`;
      option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false"); option.setAttribute("aria-label", item.label || item.value);
      if (item.direction && item.direction !== "unknown") {
        option.classList.add(`np-direction-${item.direction}`); option.append(statusIcon("transit", item.direction));
      }
      const text = document.createElement("span"), value = document.createElement("strong"); value.textContent = item.label || item.value; text.append(value);
      if (item.description) { const detail = document.createElement("small"); detail.textContent = item.description; text.append(detail); }
      option.append(text); option.onclick = () => choose(item); list.append(option); return option;
    });
  };
  const fetchPage = async (requestedPage: number) => {
    if (disposed || !dialog.open || input.disabled) return;
    const generation = ++revision; loading = true;
    more.hidden = true; message.hidden = false; message.textContent = "Завантаження…"; list.setAttribute("aria-busy", "true");
    try {
      const result = await load(query, requestedPage);
      if (disposed || !dialog.open || generation !== revision) return;
      items = requestedPage === 1 ? result.items : [...items, ...result.items.filter(item => !items.some(saved => saved.value === item.value))];
      page = requestedPage; render(); more.hidden = !result.hasMore; more.textContent = "Ще…";
      message.hidden = items.length > 0; message.textContent = "Збережених записів не знайдено. Номер можна ввести вручну.";
    } catch (error) {
      if (disposed || !dialog.open || generation !== revision) return;
      message.hidden = false;
      message.textContent = error instanceof Error ? error.message : "Не вдалося завантажити список. Номер можна ввести вручну.";
      more.hidden = false; more.textContent = "Повторити";
    } finally {
      if (generation === revision) { loading = false; list.setAttribute("aria-busy", "false"); }
    }
  };
  const open = () => {
    if (disposed || input.disabled || !popup.hidden) return;
    query = ""; page = 0; items = []; render(); popup.hidden = false; input.setAttribute("aria-expanded", "true");
    void fetchPage(1);
  };
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    revision++; query = normalizeQuery(input.value); page = 0; items = []; render(); loading = true;
    popup.hidden = false; more.hidden = true; message.hidden = false; message.textContent = "Пошук…";
    input.setAttribute("aria-expanded", "true"); input.setCustomValidity("");
    timer = setTimeout(() => void fetchPage(1), 250);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && !popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (popup.hidden) { open(); return; }
      if (options.length) setActive(event.key === "ArrowDown" ? Math.min(active + 1, options.length - 1) : active < 0 ? options.length - 1 : Math.max(active - 1, 0));
    } else if (event.key === "PageDown" && !popup.hidden && !more.hidden && !loading) {
      event.preventDefault(); void fetchPage(page + 1);
    } else if (event.key === "Enter" && !popup.hidden && items[active]) {
      event.preventDefault(); choose(items[active]);
    }
  });
  popup.addEventListener("mousedown", event => { event.preventDefault(); });
  more.onclick = () => { if (!loading) void fetchPage(page + 1); };
  control.addEventListener("focusout", event => { if (!control.contains(event.relatedTarget as Node | null)) close(); });
  const outside = (event: PointerEvent) => { if (!control.contains(event.target as Node)) close(); };
  dialog.addEventListener("pointerdown", outside);
  return { close, dispose: () => { disposed = true; close(); dialog.removeEventListener("pointerdown", outside); } };
}
