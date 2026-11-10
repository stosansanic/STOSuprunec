import "../../../scss/robocha/_nova-poshta.scss";
import { workflowDialog } from "../workshop/dialog";
import { request, ensureServiceAvailable, NpError, stateLabels, statusLabel, normalizeTTN, npTimestamp, partyLines } from "./api";
import type { Overview, Shipment } from "./api";
import { statusIcon } from "./statusIcons";
import { linkSuggestions } from "./linkSuggestions";
import { initCustomDatePicker, destroyCustomDatePicker } from "../dodatu_inchi_bazu/inhi/customDatePicker";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => {
  const el = document.createElement(tag); el.textContent = text; el.className = cls; return el;
};
function button(label: string, action: () => void) {
  const b = node("button", label); b.type = "button"; b.onclick = action; return b;
}
function field(parent: HTMLElement, label: string, value = "", type = "text") {
  const wrap = node("label", label); const input = node("input"); input.type = type; input.value = value;
  input.setAttribute("aria-label", label);
  wrap.append(input); parent.append(wrap); return input;
}
function select(parent: HTMLElement, label: string, options: Record<string, string>, value = "") {
  const wrap = node("label", label); const input = node("select");
  input.setAttribute("aria-label", label);
  for (const [key, text] of Object.entries(options)) input.add(new Option(text, key));
  input.value = value; wrap.append(input); parent.append(wrap); return input;
}
const directions = { "": "Усі", incoming: "До нас", outgoing: "Від нас", unknown: "Уточнити напрямок" };
function directionPicker(parent: HTMLElement) {
  const label = node("label", "Напрямок", "np-direction-picker");
  const selectInput = node("select", "", "np-direction-value");
  selectInput.setAttribute("aria-label", "Напрямок");
  selectInput.setAttribute("aria-hidden", "true");
  selectInput.tabIndex = -1;
  for (const [value, text] of Object.entries({ "": "Усі", incoming: "До нас", outgoing: "Від нас" })) selectInput.add(new Option(text, value));

  const control = node("div", "", "np-direction-control");
  const trigger = node("button", "", "np-direction-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-label", "Напрямок");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = node("div", "", "np-direction-menu");
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Напрямок");
  menu.hidden = true;

  const options = [
    { value: "", text: "Усі" },
    { value: "incoming", text: "До нас" },
    { value: "outgoing", text: "Від нас" },
  ];
  const optionButtons = options.map(option => {
    const item = node("button", "", `np-direction-option${option.value ? ` np-direction-${option.value}` : ""}`);
    item.type = "button";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    if (option.value) item.append(statusIcon("transit", option.value as "incoming" | "outgoing"));
    else item.append(node("span", "↔", "np-direction-all-icon"));
    item.append(node("span", option.text));
    item.onclick = () => {
      selectInput.value = option.value;
      selectInput.dispatchEvent(new Event("change", { bubbles: true }));
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
      updateTrigger();
    };
    menu.append(item);
    return item;
  });
  function updateTrigger() {
    const option = options.find(item => item.value === selectInput.value) || options[0];
    const directionClass = selectInput.value ? ` np-direction-${selectInput.value}` : "";
    trigger.className = `np-direction-trigger${directionClass}`;
    trigger.replaceChildren();
    if (selectInput.value) trigger.append(statusIcon("transit", selectInput.value as "incoming" | "outgoing"));
    else trigger.append(node("span", "↔", "np-direction-all-icon"));
    trigger.append(node("span", option.text), node("span", "", "np-direction-chevron"));
    optionButtons.forEach((item, index) => item.setAttribute("aria-selected", String(options[index].value === selectInput.value)));
  }
  trigger.onclick = () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) optionButtons[0].focus();
  };
  trigger.onkeydown = event => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault(); menu.hidden = false; trigger.setAttribute("aria-expanded", "true"); optionButtons[0].focus();
    }
  };
  menu.onkeydown = event => {
    if (event.key === "Escape") { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); }
  };
  control.addEventListener("focusout", (event: FocusEvent) => {
    if (!control.contains(event.relatedTarget as Node | null)) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
  });
  control.append(trigger, menu);
  label.append(selectInput, control);
  parent.append(label);
  updateTrigger();
  return selectInput;
}
function documentTimestamp(cell: HTMLElement, raw: string | undefined, fallback: string | null) {
  const timestamp = npTimestamp(raw) || npTimestamp(fallback);
  if (!timestamp) { cell.textContent = "Не вказано"; return; }
  const [day, clock] = timestamp.split(" ");
  const [dayOfMonth, month, year] = date(day).split(".");
  cell.append(node("span", `${dayOfMonth}.${month}.${year?.slice(-2) || ""}`, "np-date-value"));
  if (clock) cell.append(node("small", clock));
}
const quantity = (value: number | null | undefined, unit = "") => value == null ? "—" : `${value.toLocaleString("uk-UA")} ${unit}`.trim();
const date = (value: string | null) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }) : "Не вказано";
const time = (value: string | null) => value ? new Date(value).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }) : "Ще не оновлювалося";
function dialog(title: string, wide = false) {
  const ui = workflowDialog(title); ui.dialog.classList.add("np-dialog");
  if (wide) ui.dialog.classList.add("np-wide-dialog");
  return ui;
}
type Dialog = ReturnType<typeof dialog>;
function report(ui: Dialog, error: unknown) { ui.message.textContent = error instanceof Error ? error.message : "Не вдалося виконати операцію."; ui.message.classList.add("np-error"); }
async function run(ui: Dialog, action: () => Promise<void>) {
  ui.setBusy(true); ui.message.classList.remove("np-error");
  const buttons = [...ui.content.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; buttons.forEach(b => { b.disabled = true; });
  try { await action(); } catch (error) { report(ui, error); }
  finally { ui.setBusy(false); buttons.forEach(b => { b.disabled = false; }); }
}
function status(s: Shipment) {
  const badge = node("span", "", `np-state np-${s.state} np-direction-${s.direction}`);
  badge.append(statusIcon(s.state, s.direction), node("span", statusLabel(s.state, s.direction), "np-state-label"));
  return badge;
}
let root: Dialog | null = null;
function login(ui: Dialog, done: () => Promise<void>) {
  ui.content.replaceChildren();
  ui.message.textContent = "Підтвердіть пароль працівника СТО.";
  const form = node("form", "", "np-form");
  let name = ""; try { name = JSON.parse(localStorage.getItem("userAuthData") || "null")?.Name || ""; } catch { /* empty */ }
  field(form, "Працівник", name).readOnly = true;
  const password = field(form, "Пароль працівника", "", "password"); password.required = true; password.autocomplete = "current-password";
  const submit = node("button", "Увійти"); submit.type = "submit"; form.append(submit); ui.content.append(form);
  form.onsubmit = event => { event.preventDefault(); void run(ui, async () => {
    const secret = password.value; password.value = "";
    await request("authenticate", { name, password: secret }); await done();
  }); };
}
export async function openNovaPoshta(actId?: number): Promise<void> {
  if (root?.dialog.open) { root.dialog.focus(); return; }
  const ui = dialog(actId ? `Нова пошта · Акт №${actId}` : "Нова пошта", true); root = ui;
  ui.dialog.addEventListener("close", () => { root = null; }, { once: true });
  const start = async () => {
    if (actId) { await renderAct(ui, actId); return; }
    const overview = await request<Overview>("overview");
    if (ui.dialog.open) {
      renderList(ui, overview, () => login(ui, start));
    }
  };
  try { await ensureServiceAvailable(); await start(); }
  catch (error) {
    if (error instanceof NpError && error.code === "EMPLOYEE_LOGIN") login(ui, start);
    else { report(ui, error); ui.content.append(button("Повторити", () => { ui.dialog.close(); void openNovaPoshta(actId); })); }
  }
}
function defaultPeriod() {
  const to = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(to + "T00:00:00Z"); start.setUTCDate(start.getUTCDate() - 13);
  return { from: start.toISOString().slice(0, 10), to };
}
function renderList(ui: Dialog, overview: Overview, reauthenticate: () => void) {
  ui.content.replaceChildren(); ui.message.textContent = "";
  const toolbar = node("div", "", "np-toolbar");
  const filters = node("form", "", "np-filters");
  const direction = directionPicker(filters);
  const defaults = defaultPeriod();
  const from = field(filters, "Створено від", defaults.from, "date");
  const to = field(filters, "Створено до", defaults.to, "date");
  from.classList.add("cell-input-Excel", "np-date-input");
  to.classList.add("cell-input-Excel", "np-date-input");
  initCustomDatePicker(filters);
  ui.dialog.addEventListener("close", () => destroyCustomDatePicker(filters), { once: true });

  const search = field(filters, "Пошук ТТН");
  search.placeholder = "ТТН, акт, опис або місто";
  const actSearch = field(filters, "Акт", "", "number"); actSearch.min = "1"; actSearch.step = "1"; actSearch.placeholder = "Номер акта";
  actSearch.title = "Пошук ТТН акта за всі дати, включно з доданими вручну";
  const state = select(filters, "Статус", { "": "Усі", ...stateLabels });
  const summary = node("p", "", "np-summary");
  const list = node("div", "", "np-table-wrap");
  const pagination = node("div", "", "np-toolbar");
  let offset = 0; let revision = 0; let shipments: Shipment[] = [];
  let busy = false; let hasMore = false;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void load(true);
  }, { root: ui.dialog });
  const observeThreshold = () => {
    observer.disconnect();
    if (!hasMore || busy || !ui.dialog.open) return;
    const rows = list.querySelectorAll("tbody > tr");
    if (rows.length) observer.observe(rows[Math.max(0, rows.length - 6)]);
    else observer.observe(pagination);
  };
  const reloadFiltered = () => {
    revision++; observer.disconnect();
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { void load(); }, 120);
  };
  const draw = () => {
    list.replaceChildren();
    if (shipments.length) renderRows(list, shipments);
    else list.append(node("p", "Посилок за цими умовами немає.", "np-empty"));
  };
  async function load(append = false) {
    if (append && (busy || !hasMore)) return;
    if (!from.value && !to.value) { const dates = defaultPeriod(); from.value = dates.from; to.value = dates.to; }
    if (!append) { revision++; offset = 0; hasMore = false; }
    const generation = revision;
    const limit = append ? 10 : 50;
    // The default period is the initial archive window. Explicit date filters stay bounded.
    const expandHistory = from.value === defaults.from && to.value === defaults.to && !actSearch.value;
    const parameters = {
      direction: direction.value, from: append && expandHistory ? null : from.value,
      to: to.value, act_id: actSearch.value || null,
      query: search.value.trim(), state: state.value,
    };
    busy = true; observer.disconnect();
    ui.message.textContent = "Завантажуємо збережену історію…";
    pagination.replaceChildren();
    list.setAttribute("aria-busy", "true");
    try {
      const result = { shipments: [] as Shipment[], has_more: false, checked_at: "" };
      let nextOffset = offset;
      do {
        const page = await request<{ shipments: Shipment[]; has_more: boolean; checked_at: string }>("list", {
          ...parameters, offset: nextOffset, limit,
        });
        if (!ui.dialog.open || generation !== revision) return;
        if (!Array.isArray(page.shipments) || page.shipments.length > limit || typeof page.has_more !== "boolean" ||
            (page.has_more && page.shipments.length !== limit)) throw new Error("Оновіть SQL та серверну функцію Нової пошти для підвантаження ТТН.");
        result.shipments.push(...page.shipments);
        result.has_more = page.has_more;
        if (page.checked_at > result.checked_at) result.checked_at = page.checked_at;
        nextOffset += page.shipments.length;
        // Read the entire initial fortnight in bounded requests; scrolling reads only ten.
      } while (!append && expandHistory && result.has_more);
      offset = nextOffset;
      hasMore = !append && expandHistory ? true : result.has_more;
      if (append) {
        const known = new Set(shipments.map(s => s.ttn));
        const fresh = result.shipments.filter(s => !known.has(s.ttn));
        shipments.push(...fresh);
        const body = list.querySelector("tbody");
        if (body && fresh.length) {
          const fragment = node("div"); renderRows(fragment, fresh);
          body.append(...Array.from(fragment.querySelector("tbody")!.children));
        } else if (!body && fresh.length) draw();
      } else { shipments = result.shipments; draw(); }
      summary.textContent = `Збережені дані · Оновлено: ${time(result.checked_at)} · Завантажено: ${shipments.length}`;
      ui.message.textContent = "";
      pagination.append(node("span", hasMore
        ? expandHistory ? "Прокрутіть вниз для підвантаження старіших ТТН по 10" : "Прокрутіть вниз для підвантаження"
        : "Усі ТТН за цими умовами завантажено"));
    } catch (error) {
      if (generation !== revision || !ui.dialog.open) return;
      if (!append) { shipments = []; list.replaceChildren(); summary.textContent = ""; }
      if (error instanceof NpError && error.code === "EMPLOYEE_LOGIN") reauthenticate();
      else {
        report(ui, error);
        pagination.replaceChildren(button("Повторити", () => void load(append)));
      }
      // Retry only on user action, avoiding a loop at the bottom after a failure.
      return;
    } finally { if (generation === revision) { busy = false; list.removeAttribute("aria-busy"); } }
    observeThreshold();
  }
  toolbar.append(button("Перевірити ТТН", () => {
    const lookup = dialog("Знайти ТТН у збереженій історії"); const form = node("form", "", "np-form");
    const ttn = field(form, "Номер ТТН"); ttn.required = true; ttn.inputMode = "numeric";
    const submit = node("button", "Перевірити"); submit.type = "submit"; form.append(submit); lookup.content.append(form);
    form.onsubmit = event => { event.preventDefault(); void run(lookup, async () => { const number = normalizeTTN(ttn.value); await openDetail(number); }); };
  }), button("Оновити з Нової пошти", () => void run(ui, async () => {
    if (!from.value && !to.value) { const dates = defaultPeriod(); from.value = dates.from; to.value = dates.to; }
    const syncFrom = from.value; const syncTo = to.value;
    if (!syncFrom || !syncTo) throw new Error("Оберіть «Створено від» і «Створено до» для оновлення з Нової пошти.");
    if (syncFrom > syncTo) throw new Error("Дата «Створено від» має бути не пізнішою за «Створено до».");
    let syncPage = 1; let more = true; let syncDirections = ["incoming", "outgoing"];
    while (more && ui.dialog.open) {
      ui.message.textContent = `Отримуємо посилки з НП: сторінка ${syncPage}…`;
      const result = await request<{ has_more: boolean; next_directions: string[] }>("sync_page", { page: syncPage++, from: syncFrom, to: syncTo, directions: syncDirections });
      more = result.has_more; syncDirections = result.next_directions;
    }
    if (ui.dialog.open) { await load(); ui.message.textContent = `Оновлено дані НП за ${syncFrom} — ${syncTo}. Старі ТТН збережені.`; }
  })));
  if (overview.actor.role === "Адміністратор") toolbar.append(button("⚙ Налаштування Нової пошти", () => openConnection(overview, () => void load())));
  toolbar.append(button("Вийти з розділу", () => void run(ui, async () => { await request("logout"); ui.dialog.close(); })));
  filters.onsubmit = event => { event.preventDefault(); };
  from.addEventListener("input", reloadFiltered); from.addEventListener("change", reloadFiltered);
  to.addEventListener("input", reloadFiltered); to.addEventListener("change", reloadFiltered);
  direction.addEventListener("change", reloadFiltered); actSearch.addEventListener("input", reloadFiltered);
  search.oninput = reloadFiltered; state.onchange = reloadFiltered;
  ui.content.append(toolbar, filters, summary, list, pagination);
  ui.dialog.addEventListener("close", () => { revision++; observer.disconnect(); shipments = []; if (filterTimer) clearTimeout(filterTimer); }, { once: true });
  void load();
}
function shipmentCard(host: HTMLElement, shipment: Shipment) {
  const data = shipment.provider_details || {};
  const top = node("div", "", "np-detail-overview");
  const heading = node("div", "", "np-detail-heading");
  const direction = node("span", "", `np-shipment-direction np-direction-${shipment.direction}`);
  direction.append(statusIcon("transit", shipment.direction), node("span", directions[shipment.direction]));
  heading.append(direction, status(shipment));
  const info = (label: string, value: string, cls = "") => {
    const item = node("div", "", `np-detail-info ${cls}`.trim());
    item.append(node("span", label, "np-detail-label"), node("strong", value || "—")); return item;
  };
  top.append(heading, info("Опис відправлення", shipment.description || shipment.provider_description), info("Оголошена цінність", quantity(data.value, "грн")));
  const body = node("div", "", "np-detail-body");
  const route = node("div", "", "np-detail-route");
  const stop = (label: string, timestamp: string | undefined, fallback: string | null, address: string) => {
    const item = node("section", "", "np-detail-stop");
    const dateValue = node("div", "", "np-detail-date"); documentTimestamp(dateValue, timestamp, fallback);
    item.append(node("h3", label), dateValue, node("p", address || "Адресу не вказано")); return item;
  };
  route.append(stop("Створення ТТН", data.created, shipment.document_date, data.sender_address || ""),
    stop("Час доставки", data.delivery, shipment.estimated_date, data.address || shipment.warehouse));
  const parties = node("div", "", "np-detail-parties");
  const party = (title: string, contact?: string, company?: string, legacy?: string, phone?: string) => {
    const section = node("section", "", "np-detail-party"); section.append(node("h3", title));
    const lines = partyLines(contact, company, legacy);
    (lines.length ? lines : ["Не вказано"]).forEach((line, index) => section.append(node(index ? "span" : "strong", line)));
    if (phone) { const link = node("a", phone); link.href = `tel:${phone.replace(/[^+\d]/g, "")}`; section.append(link); }
    return section;
  };
  parties.append(party("Отримувач", data.recipient_contact, data.recipient_company, data.recipient, data.phone),
    party("Відправник", data.sender_contact, data.sender_company, data.sender, data.sender_phone));
  body.append(route, parties);
  const metrics = node("div", "", "np-detail-metrics");
  metrics.append(info("Вартість доставки", quantity(data.delivery_cost, "грн")), info("Вага", quantity(data.weight, "кг")), info("К-ть місць", quantity(data.seats)));
  if (shipment.raw_status) metrics.append(info("Статус Нової пошти", shipment.raw_status));
  host.replaceChildren(top, body, metrics);
}
async function openDetail(ttn: string, snapshot?: Shipment, actId?: number) {
  const ui = dialog(`ТТН ${ttn}`); ui.dialog.classList.add("np-detail-dialog");
  const details = node("div", "", "np-detail-card");
  const full = node("details", "", "np-detail-history");
  full.append(node("summary", "Повні дані та історія Нової пошти"));
  const payload = node("pre"); full.append(payload);
  let loaded = false; let loading = false; let generation = 0;
  let current = snapshot;
  const load = async () => {
    const result = snapshot ? { shipment: snapshot } : await request<{ shipment: Shipment }>(actId ? "act_detail" : "detail", { id: ttn, ...(actId ? { act_id: actId } : {}) });
    if (!ui.dialog.open) return;
    current = result.shipment; shipmentCard(details, current);
  };
  full.ontoggle = () => {
    if (!full.open || loaded || loading) return;
    const revision = generation; loading = true; payload.textContent = "Завантаження історії…";
    void request<{ shipment: Shipment }>(actId ? "act_detail" : "detail", { id: ttn, full: true, ...(actId ? { act_id: actId } : {}) })
      .then(data => { if (full.isConnected && revision === generation) { payload.textContent = JSON.stringify(data.shipment, null, 2); loaded = true; } })
      .catch(error => { if (revision === generation) payload.textContent = error instanceof Error ? error.message : "Не вдалося завантажити історію."; })
      .finally(() => { if (revision === generation) loading = false; });
  };
  const form = node("form", "", "np-detail-link-form");
  const act = field(form, "Номер акта", actId ? String(actId) : ""); act.required = true;
  act.placeholder = "№ акта, ПІБ або автомобіль";
  const save = node("button", "Зберегти", "np-detail-save"); save.type = "submit";
  form.append(save);
  const actions = node("div", "", "np-detail-actions");
  const refresh = button("Оновити з Нової пошти", () => void run(ui, async () => {
    const result = await request<{message:string}>("sync_ttn", { id: ttn });
    snapshot = undefined; generation++; loaded = loading = false; full.open = false; payload.textContent = "";
    await load(); ui.message.textContent = result.message; refreshActs();
  }));
  actions.append(refresh);
  const note = node("p", "Додати ТТН до акта: відкритого, закритого або замороженого.", "np-detail-link-note");
  ui.content.append(details, note, form, actions, full);
  const suggestions = linkSuggestions(ui.dialog, act, null, () => {}, false);
  let saving = false;
  form.onsubmit = event => {
    event.preventDefault(); if (saving) return;
    const selected = suggestions.actId();
    if (!Number.isSafeInteger(selected) || selected < 1) {
      act.setCustomValidity("Оберіть акт зі списку або введіть його номер."); act.reportValidity(); return;
    }
    suggestions.close(); saving = true; act.disabled = true;
    void run(ui, async () => {
      await request("act_link", { act_id: selected, ttn, direction: current?.direction || "unknown" });
      refreshActs(selected); ui.message.textContent = `ТТН ${ttn} збережено в акті №${selected}.`;
    }).finally(() => { saving = false; act.disabled = false; });
  };
  await run(ui, load);
}
function openConnection(initial: Overview, changed: () => void) {
  const ui = dialog("Налаштування Нової пошти"); const form = node("form", "", "np-form");
  let overview = initial;
  const name = field(form, "Назва", overview.connection?.name || "Нова пошта СТО");
  const phone = field(form, "Телефон акаунта НП", overview.connection?.phone || "", "tel"); phone.required = true;
  const accountLogin = field(form, "Логін Нової пошти", overview.connection?.login || ""); accountLogin.autocomplete = "off";
  const password = field(form, "Пароль Нової пошти", "", "password"); password.autocomplete = "new-password";
  const key = field(form, "API-ключ", "", "password"); key.autocomplete = "new-password";
  const link = node("a", "Створити API-ключ у Новій пошті", "np-api-key-link"); link.href = "https://new.novaposhta.ua/dashboard/settings/developers"; link.target = "_blank"; link.rel = "noopener noreferrer";
  form.append(link, node("p", "Для отримання посилок використовується API-ключ. Порожні поля пароля й ключа залишають збережені значення."));
  let dirty = false; form.oninput = () => { dirty = true; }; ui.setDirty(() => dirty);
  const save = node("button", "Зберегти"); save.type = "submit"; form.append(save); ui.content.append(form);
  const reload = async () => { overview = await request<Overview>("overview"); render(); changed(); };
  form.onsubmit = event => { event.preventDefault(); void run(ui, async () => {
    const values = { name: name.value, phone: phone.value, login: accountLogin.value, account_password: password.value, key: key.value };
    const result = await request<{ message: string }>(key.value ? "connect" : "save_settings", values);
    password.value = ""; key.value = ""; dirty = false; ui.message.textContent = result.message; await reload();
  }); };
  const toggle = button("", () => void run(ui, async () => { await request(overview.connection?.enabled ? "disconnect" : "resume"); await reload(); }));
  const forget = button("Видалити API-ключ", () => {
    const confirmation = dialog("Видалити API-ключ?");
    confirmation.content.append(node("p", "Оновлення з НП буде вимкнено. Збережена історія залишиться доступною."), button("Скасувати", () => confirmation.dialog.close()), button("Видалити", () => void run(confirmation, async () => { await request("forget_key"); confirmation.dialog.close(); await reload(); })));
  });
  const clearPassword = button("Видалити збережений пароль", () => void run(ui, async () => {
    await request("save_settings", { name: name.value, phone: phone.value, login: accountLogin.value, clear_password: true }); password.value = ""; await reload();
  }));
  ui.content.append(toggle, forget, clearPassword);
  function render() {
    const c = overview.connection;
    key.required = !c?.has_key; key.placeholder = c?.has_key ? "Ключ збережено" : "Введіть API-ключ";
    password.placeholder = c?.has_password ? "Пароль збережено" : "За потреби";
    toggle.textContent = c?.enabled ? "Призупинити підключення" : "Відновити підключення";
    toggle.hidden = forget.hidden = !c?.has_key; clearPassword.hidden = !c?.has_password;
  }
  render();
}
export function mountActShipments(host: HTMLElement, actId: number): void {
  host.classList.add("np-act-section");
  host.dataset.actId = String(actId);
  const trigger = button("", () => void openNovaPoshta(actId));
  trigger.className = "np-act-trigger";
  trigger.title = "Нова пошта — ТТН цього акта";
  trigger.setAttribute("aria-label", "Відкрити ТТН цього акта в Новій пошті");
  trigger.setAttribute("aria-haspopup", "dialog");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.innerHTML = '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 10v8M3 8l9 5 9-5M7.5 5.5l9 5v4"/>';
  trigger.append(icon, node("span", "ТТН акта"));
  host.append(trigger);
  const rows = node("div", "", "np-act-rows"); host.append(rows);
  // Mounting the optional control must not authenticate, read the NP archive or
  // update its server request counter. The explicit button opens the current
  // list through the existing employee authentication flow.
}

interface ActTTN { ttn: string; note?: string; direction?: string; shipment?: Shipment }
interface ActTTNs { items: ActTTN[]; editable: boolean }
function renderActSummary(host: HTMLElement, actId: number, items: ActTTN[]) {
  if (!host.isConnected || Number(host.dataset.actId) !== actId) return;
  host.dataset.npSummaryLoaded = "true";
  const rows = host.querySelector(".np-act-rows");
  rows?.replaceChildren(...items.map(item => button(`${item.ttn}${item.note ? ` · ${item.note}` : ""}`, () => void openDetail(item.ttn, item.shipment, actId))));
}
async function loadActSummary(host: HTMLElement, actId: number) {
  try {
    const result = await request<ActTTNs>("act_list", { act_id: actId });
    renderActSummary(host, actId, result.items);
  } catch { /* The act remains usable; its button opens employee authentication. */ }
}
function refreshActs(actId?: number) {
  document.querySelectorAll<HTMLElement>(".np-act-section").forEach(host => {
    const hostActId = Number(host.dataset.actId);
    // Hidden/unopened summaries have nothing to refresh. A link changes only
    // its selected act, while a shipment sync may affect several open acts.
    if (host.dataset.npSummaryLoaded !== "true" || (actId != null && hostActId !== actId)) return;
    void loadActSummary(host, hostActId);
  });
}
function openActLink(ttn = "", actId?: number, done?: () => void) {
  const ui = dialog("Записати ТТН в акт");
  const form = node("form", "", "np-form");
  const act = field(form, "Номер акта", actId ? String(actId) : ""); act.required = true; act.readOnly = !!actId;
  act.placeholder = "Номер акта, ПІБ клієнта або авто";
  const number = field(form, "ТТН", ttn); number.required = true; number.inputMode = "numeric";
  const direction = select(form, "Напрямок", { incoming: "До нас", outgoing: "Від нас", unknown: "Уточнити напрямок" }, "incoming");
  const save = node("button", "Записати в акт"); save.type = "submit"; form.append(save); ui.content.append(form);
  const suggestions = linkSuggestions(ui.dialog, act, number, value => { direction.value = value; });
  let saving = false;
  form.onsubmit = event => {
    event.preventDefault(); if (saving) return;
    const selectedActId = suggestions.actId();
    if (!Number.isSafeInteger(selectedActId) || selectedActId < 1) {
      act.setCustomValidity("Оберіть акт зі списку або введіть його цілий номер, більший за нуль."); act.reportValidity(); return;
    }
    suggestions.close(); saving = true; act.disabled = number.disabled = direction.disabled = true;
    void run(ui, async () => {
      await request("act_link", { act_id: selectedActId, ttn: normalizeTTN(number.value), direction: direction.value });
      ui.dialog.close();
      if (done) done(); // The parent list refresh also paints its inline summary.
      else refreshActs(selectedActId);
    }).finally(() => { saving = false; act.disabled = number.disabled = direction.disabled = false; });
  };
}
async function renderAct(ui: Dialog, actId: number) {
  ui.content.replaceChildren(); ui.message.textContent = "Завантаження ТТН акта…";
  const saved = await request<ActTTNs>("act_list", { act_id: actId });
  if (!ui.dialog.open) return;
  // Reuse the authoritative response already requested by the user for the
  // inline summary; do not issue a second act_list just to paint these buttons.
  document.querySelectorAll<HTMLElement>(".np-act-section").forEach(host => renderActSummary(host, actId, saved.items));
  ui.message.textContent = "";
  const toolbar = node("div", "", "np-toolbar");
  if (saved.editable) toolbar.append(button("＋ Додати ТТН", () => openActLink("", actId, () => void run(ui, () => renderAct(ui, actId)))));
  toolbar.append(button("Оновити", () => void run(ui, () => renderAct(ui, actId))), button("Усі посилки НП", () => { ui.dialog.close(); void openNovaPoshta(); }));
  ui.content.append(toolbar);
  if (!saved.items.length) ui.content.append(node("p", "До акта ще не записано ТТН."));
  for (const item of saved.items) {
    const row = node("div", "", "np-toolbar");
    row.append(button(item.ttn, () => void openDetail(item.ttn, item.shipment, actId)), node("span", item.note || ""));
    const state = node("span", item.shipment?.raw_status || "Немає збереженого статусу"); row.append(state);
    if (saved.editable) row.append(button("Прибрати з акта", () => {
      const confirmation = dialog("Прибрати ТТН з акта?");
      confirmation.content.append(node("p", item.ttn), button("Скасувати", () => confirmation.dialog.close()), button("Прибрати", () => void run(confirmation, async () => {
        await request("act_link", { act_id: actId, ttn: item.ttn, remove: true }); confirmation.dialog.close(); await renderAct(ui, actId);
      })));
    }));
    ui.content.append(row);

  }
}

function renderRows(list: HTMLElement, shipments: Shipment[]) {
        const table = node("table"); const head = node("thead"); const tr = node("tr");
        const columns = ["ТТН / напрямок", "Статус", "Створення ТТН", "Час доставки", "Оголошена цінність", "Вартість доставки", "Вага", "К-ть", "Опис відправлення", "Отримувач", "Відправник", "Акт"];
        columns.forEach(t => tr.append(node("th", t))); head.append(tr); table.append(head);
        const body = node("tbody");
        for (const s of shipments) {
          const row = node("tr");
          const cells = columns.map(label => { const td = node("td"); td.dataset.label = label; row.append(td); return td; });
          const ttnButton = button(s.ttn, () => void openDetail(s.ttn));
          ttnButton.classList.add("np-ttn", `np-direction-${s.direction}`);
          ttnButton.setAttribute("aria-label", `ТТН ${s.ttn}`);
          ttnButton.replaceChildren(document.createTextNode(s.ttn.slice(0, -4)), node("span", s.ttn.slice(-4), "np-ttn-ending"));
          const direction = node("small", "", `np-shipment-direction np-direction-${s.direction}`);
          direction.append(statusIcon("transit", s.direction), node("span", directions[s.direction]));
          cells[0].append(ttnButton, direction);
          const details = s.provider_details || {};
          cells[1].append(status(s)); if (s.sync_error) cells[1].append(node("small", s.sync_error, "np-error"));
          documentTimestamp(cells[2], details.created, s.document_date);
          documentTimestamp(cells[3], details.delivery, s.estimated_date);
          cells[4].textContent = quantity(details.value, "грн");
          cells[5].textContent = quantity(details.delivery_cost, "грн");
          cells[6].classList.add("np-weight");
          if (details.weight == null) cells[6].textContent = "—";
          else cells[6].append(node("span", quantity(details.weight), "np-weight-value"), document.createTextNode(" "), node("span", "кг", "np-weight-unit"));
          cells[7].textContent = quantity(details.seats);
          cells[8].textContent = s.description || s.provider_description || "—";
          cells[9].classList.add("np-recipient");
          partyLines(details.recipient_contact, details.recipient_company, details.recipient).forEach((line, index) => cells[9].append(node(index ? "small" : "strong", line)));
          if (details.phone) {
            const phone = node("a", details.phone); phone.href = `tel:${details.phone.replace(/[^+\d]/g, "")}`; cells[9].append(phone);
          }
          cells[9].append(node("small", details.address || s.warehouse || "Адресу не вказано"));
          cells[10].classList.add("np-recipient");
          partyLines(details.sender_contact, details.sender_company, details.sender).forEach((line, index) => cells[10].append(node(index ? "small" : "strong", line)));
          if (details.sender_phone) {
            const phone = node("a", details.sender_phone); phone.href = `tel:${details.sender_phone.replace(/[^+\d]/g, "")}`; cells[10].append(phone);
          }
          cells[10].append(node("small", details.sender_address || "Адресу не вказано"));
          cells[11].textContent = s.act_ids?.length ? s.act_ids.map(id => `№${id}`).join(", ") : "—";
          body.append(row);
        }
        table.append(body); list.append(table);

}
