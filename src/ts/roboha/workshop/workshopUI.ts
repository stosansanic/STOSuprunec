import { appConfirm } from "../../utils/appDialogs";
import { watchWorkshopResources, invalidateWorkshopResources, type WorkshopResourceWatcher } from "./resourceCache";
import { isActFrozen } from "../../utils/actFrozenState";
import { userName, userAccessLevel } from "../tablucya/users";
import { defectStates, recommendationStates, readWorkshop, safePhotoUrl, WORKSHOP_KEY, type Collection, type Defect, type Entry, type Recommendation } from "./model";
import { canEditWorkshopAct, loadPreviousRecommendations, loadWorkshopAct, saveWorkshopEntry, type WorkshopAct } from "./service";
import { errorText, workflowButton, workflowDialog } from "./dialog";

type AddWork = (name: string) => Promise<void>;
export async function openWorkshop(actId: number, tab: Collection = "defects", addWork?: AddWork): Promise<void> {
  const ui = workflowDialog(`🔧 Картка акта №${actId}`);
  ui.message.textContent = "Завантаження з бази…";
  let stopWatching: WorkshopResourceWatcher | null = null;
  ui.dialog.addEventListener("close",()=>stopWatching?.(),{once:true});
  let act: WorkshopAct;
  let dirty = false;
  let saving = false;
  let historyObserver: IntersectionObserver | null = null;
  ui.dialog.addEventListener("close", () => historyObserver?.disconnect(), { once: true });
  ui.setDirty(() => dirty);
  let confirmingLeave = false;
  const checkLeave = async () => {
    if (saving || confirmingLeave || !ui.dialog.isConnected) return false;
    confirmingLeave = true;
    try {
      const accepted = !dirty || await appConfirm("Залишити форму без збереження?");
      return accepted && !saving && ui.dialog.isConnected;
    } finally { confirmingLeave = false; }
  };
  const report = (error: unknown) => { ui.message.textContent = errorText(error); ui.message.scrollIntoView({ block: "nearest" }); };
  const p = (parent: HTMLElement, text: string) => { const el = document.createElement("p"); el.textContent = text; parent.append(el); };
  const reload = async () => {
    act = await loadWorkshopAct(actId);
    if (!ui.dialog.isConnected) return;
    stopWatching?.();
    const scope = { kind: "act" as const, actId, carId: userAccessLevel === "Слюсар" ? null : act.cars_id };
    invalidateWorkshopResources(scope);
    const watcher = watchWorkshopResources(scope);
    stopWatching = watcher;
    await watcher.ready;
    if (!ui.dialog.isConnected || watcher !== stopWatching) return;
    await render();
  };

  async function editor(collection: Collection, owner: WorkshopAct, expected: Entry | null, initial?: Partial<Entry>) {
    if (!await checkLeave()) return;
    ui.content.querySelector("form")?.remove();
    const form = document.createElement("form"); form.className = "workflow-form";
    const fields = collection === "defects"
      ? [["assembly", "Агрегат (блок, ГБЦ, колінвал…)"], ["component", "Вузол / точка вимірювання *"], ["before", "Вимірювання до ремонту (з одиницями)"], ["after", "Вимірювання після ремонту"], ["tolerance", "Допуск і джерело (ввести вручну)"], ["photoUrl", "Посилання https:// на фото в архіві"], ["finding", "Виявлені дефекти"], ["operation", "Рекомендована робота"]]
      : [["text", "Рекомендація *"]];
    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    for (const [key, title] of fields) {
      const label = document.createElement("label"); label.textContent = title;
      const input = document.createElement(["text", "finding", "operation"].includes(key) ? "textarea" : "input");
      input.value = String((expected || initial || {} as any)[key as keyof Entry] || "");
      input.maxLength = 12000;
      input.required = key === "text" || key === "component";
      if (key === "photoUrl") (input as HTMLInputElement).type = "url";
      label.append(input); form.append(label); controls.set(key, input);
    }
    const label = document.createElement("label"); label.textContent = "Стан";
    const select = document.createElement("select");
    const states = collection === "defects" ? defectStates : recommendationStates;
    for (const [value, text] of Object.entries(states)) select.add(new Option(text, value));
    select.value = expected?.state || initial?.state || (collection === "defects" ? "inspect" : "proposed");
    label.append(select); form.append(label); controls.set("state", select);
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "💾 Зберегти в базі";
    form.append(save);
    dirty = !!initial;
    form.oninput = () => { dirty = true; };
    const newId = crypto.randomUUID();
    let pendingSubmission: { fingerprint: string; entry: Entry } | null = null;
    form.onsubmit = async event => {
      event.preventDefault(); if (saving) return;
      saving = true; ui.setBusy(true); save.disabled = true;
      try {
        const values = Object.fromEntries([...controls].map(([key, input]) => [key, input.value.trim()]));
        let next = { ...expected, ...initial, ...values, id: expected?.id || newId, author: userName || "", updatedAt: "" } as Entry;
        if (collection === "defects") (next as Defect).photoUrl = safePhotoUrl((next as Defect).photoUrl);
        const fingerprint = JSON.stringify(next);
        if (pendingSubmission?.fingerprint === fingerprint) next = pendingSubmission.entry;
        else {
          next.updatedAt = new Date().toISOString();
          pendingSubmission = { fingerprint, entry: next };
        }
        const receipt = await saveWorkshopEntry(owner.act_id, collection, expected, next);
        const section = readWorkshop(owner.data);
        const rows = section[collection] as Entry[];
        const position = rows.findIndex(row => row.id === receipt.entry.id);
        if (position < 0) rows.push(receipt.entry); else rows[position] = receipt.entry;
        owner.data[WORKSHOP_KEY] = section;
        owner.data.__act_revision = receipt.revision;
        owner.data.Заморожений = receipt.frozen;
        owner.date_off = receipt.date_off; owner.pruimalnyk = receipt.pruimalnyk; owner.cars_id = receipt.cars_id;
        dirty = false; ui.message.textContent = "Збережено в спільній базі. Склад і зарплати не змінювалися.";
        form.remove();
        try { await render(); }
        catch { ui.message.textContent = "Запис ЗБЕРЕЖЕНО, але не вдалося оновити екран. Натисніть «Оновити картку». Не створюйте його повторно."; }
      } catch (error) { report(error); }
      finally { saving = false; ui.setBusy(false); save.disabled = false; }
    };
    ui.content.append(form);
    form.scrollIntoView({ block: "nearest" }); controls.values().next().value?.focus();
  }

  function recommendationCard(owner: WorkshopAct, rec: Recommendation, parent: HTMLElement) {
    const card = document.createElement("div"); card.className = "workflow-card";
    p(card, `Акт №${owner.act_id} · ${recommendationStates[rec.state] || "Невідомий стан"}`);
    p(card, rec.text); p(card, `${rec.author} · ${new Date(rec.updatedAt).toLocaleString("uk-UA")}`);
    const actions = document.createElement("div"); actions.className = "workflow-actions";
    if (canEditWorkshopAct(owner)) actions.append(workflowButton("Змінити стан / текст", () => editor("recommendations", owner, rec)));
    if (addWork && rec.state === "approved" && !act.date_off && !isActFrozen(act)) {
      const button = workflowButton("➕ Додати роботу в поточний акт", async () => {
        button.disabled = true;
        if (!await appConfirm("Додати як новий рядок? Перевірте ціну, кількість і виконавця, потім збережіть акт звичайною кнопкою.")) { button.disabled = false; return; }
        if (!ui.dialog.isConnected) return;
        addWork(rec.text).then(() => { ui.message.textContent = "Рядок додано у відкритий акт. Акт потрібно зберегти окремо. Рекомендацію НЕ позначено виконаною."; })
          .catch(error => { button.disabled = false; report(error); });
      }); actions.append(button);
    }
    card.append(actions); parent.append(card);
  }

  async function render() {
    historyObserver?.disconnect(); historyObserver = null;
    ui.content.replaceChildren();
    const tabs = document.createElement("div"); tabs.className = "workflow-actions";
    for (const [key, title] of [["defects", "🔧 Дефектування"], ["recommendations", "💡 Рекомендації та історія"]] as const) {
      tabs.append(workflowButton(title, async () => { if (await checkLeave()) { dirty = false; tab = key; void render().catch(report); } }));
    }
    ui.content.append(tabs);
    tabs.append(workflowButton("↻ Оновити картку", async () => {
      if (!await checkLeave()) return;
      dirty = false;
      try { await reload(); ui.message.textContent = "Дані оновлено з бази."; } catch (error) { report(error); }
    }));
    p(ui.content, "Ця картка зберігається окремо від позицій акта. Вимірювання й висновки вводить працівник; автоматичних нарахувань немає.");
    const section = readWorkshop(act.data);
    if (tab === "defects") {
      const editable = canEditWorkshopAct(act) && !act.date_off && !isActFrozen(act);
      if (editable) ui.content.append(workflowButton("➕ Додати вимірювання / дефект", () => editor("defects", act, null)));
      else p(ui.content, "Режим перегляду дефектування.");
      if (!section.defects.length) p(ui.content, "Картка ще не заповнена.");
      for (const d of section.defects) {
        const card = document.createElement("div"); card.className = "workflow-card";
        p(card, `${d.assembly} · ${d.component} — ${defectStates[d.state] || d.state}`);
        p(card, `До: ${d.before || "—"} / Після: ${d.after || "—"}`);
        p(card, `Допуск / джерело: ${d.tolerance || "не вказано"}`); p(card, d.finding);
        p(card, `Робота: ${d.operation || "—"}`);
        if (d.photoUrl) { try { const link = document.createElement("a"); link.href = safePhotoUrl(d.photoUrl); link.textContent = "📷 Фото"; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link); } catch { p(card, "Некоректне посилання на фото"); } }
        p(card, `${d.author} · ${new Date(d.updatedAt).toLocaleString("uk-UA")}`);
        if (editable) card.append(workflowButton("Редагувати", () => editor("defects", act, d)));
        if (canEditWorkshopAct(act) && d.operation) card.append(workflowButton("💡 Створити рекомендацію", () => {
          if (section.recommendations.some(r => r.sourceDefectId === d.id)) { ui.message.textContent = "Рекомендацію для цього дефекту вже створено. Відкрийте вкладку рекомендацій."; return; }
          editor("recommendations", act, null, { text: d.operation, sourceDefectId: d.id, state: "proposed" });
        }));
        ui.content.append(card);
      }
    } else {
      if (canEditWorkshopAct(act)) ui.content.append(workflowButton("➕ Додати рекомендацію", () => editor("recommendations", act, null)));
      const legacy = String(act.data.Рекомендації || "").trim();
      if (legacy && legacy !== "—") {
        p(ui.content, `Текст рекомендацій акта (без автоматичної зміни статусу):\n${legacy}`);
        if (canEditWorkshopAct(act)) ui.content.append(workflowButton("Взяти текст у нову рекомендацію", () => editor("recommendations", act, null, { text: legacy, state: "proposed" })));
      }
      section.recommendations.forEach(r => recommendationCard(act, r, ui.content));
      const previous = document.createElement("section"); ui.content.append(previous);
      p(previous, "Завантаження невиконаних рекомендацій інших візитів…");
      try {
        const firstPage = await loadPreviousRecommendations(act);
        if (!previous.isConnected) return;
        previous.replaceChildren(); p(previous, "Невиконані рекомендації інших візитів:");
        let count = 0;
        const appendOwners = (owners: WorkshopAct[]) => { for (const owner of owners) {
          const records = readWorkshop(owner.data).recommendations;
          for (const r of records.filter(r => r.state === "proposed" || r.state === "approved")) { recommendationCard(owner, r, previous); count++; }
          if (!records.length && owner.data.Рекомендації && owner.data.Рекомендації !== "—") {
            p(previous, `Акт №${owner.act_id} · старий текст, стан не визначено: ${owner.data.Рекомендації}`);
            if (canEditWorkshopAct(owner)) previous.append(workflowButton(`Упорядкувати рекомендацію №${owner.act_id}`, () => editor("recommendations", owner, null, { text: String(owner.data.Рекомендації), state: "proposed" })));
            count++;
          }
        } };
        appendOwners(firstPage.items);
        if (!count) p(previous, "Немає невиконаних записів, доступних для перегляду.");
        let cursor = firstPage.next_cursor;
        let hasMore = firstPage.has_more;
        let loading = false;
        const sentinel = document.createElement("div"); sentinel.className = "workflow-history-more";
        if (hasMore) previous.append(sentinel);
        const observer = new IntersectionObserver(async entries => {
          if (!entries.some(entry => entry.isIntersecting) || loading || !hasMore || !previous.isConnected) return;
          loading = true; sentinel.textContent = "Завантаження…";
          try {
            const page = await loadPreviousRecommendations(act, cursor);
            if (!previous.isConnected || historyObserver !== observer) return;
            sentinel.remove(); appendOwners(page.items);
            cursor = page.next_cursor; hasMore = page.has_more;
            if (hasMore) { sentinel.textContent = ""; previous.append(sentinel); observer.unobserve(sentinel); observer.observe(sentinel); }
            else observer.disconnect();
          } catch (error) {
            sentinel.replaceChildren(workflowButton("Повторити підвантаження", () => { observer.unobserve(sentinel); observer.observe(sentinel); }));
            report(error);
          } finally { loading = false; }
        }, { rootMargin: "100px" });
        historyObserver = observer;
        if (hasMore) observer.observe(sentinel);
      } catch (error) { previous.replaceChildren(); p(previous, errorText(error)); }
    }
  }
  try { await reload(); if (ui.dialog.isConnected) ui.message.textContent = "Дані завантажено з бази."; }
  catch (error) { report(error); }
}
