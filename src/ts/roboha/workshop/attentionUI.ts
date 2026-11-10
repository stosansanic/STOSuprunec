import { watchWorkshopResources, workshopReadCache, invalidateWorkshopResources } from "./resourceCache";
import { supabase } from "../../vxid/supabaseClient";
import { canUserOpenActs, canUserSeePriceColumns, canUserSeeSkladButton, canUserViewActs, getCachedSettingForRole, userAccessLevel, userName } from "../tablucya/users";
import { errorText, workflowButton, workflowDialog } from "./dialog";
import type { AttentionItem } from "./attentionModel";

export async function openAttentionOverview(): Promise<void> {
  const role = userAccessLevel, name = userName;
  if (!role || !name) throw new Error("Потрібен вхід у програму.");
  const ui = workflowDialog("📌 Атлас · Що потребує уваги");
  const controller = new AbortController();
  ui.dialog.addEventListener("close", () => controller.abort(), { once: true });
  let items: AttentionItem[] = [];
  let warnings: string[] = [];
  let loading = false;
  let loadQueued = false;
  let pageOffset=0;
  let summaryUnavailable=false;
  let summaryHasMore=false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const watchScope = { kind: "attention" as const };
  const stopWatching=watchWorkshopResources(watchScope,()=>{
    if (summaryUnavailable || controller.signal.aborted || document.hidden) return;
    if(refreshTimer)clearTimeout(refreshTimer);
    refreshTimer=setTimeout(()=>{refreshTimer=null;if(!controller.signal.aborted && !document.hidden)void load();},500);
  });
  ui.dialog.addEventListener("close",()=>{stopWatching();if(refreshTimer)clearTimeout(refreshTimer);},{once:true});
  const refresh = workflowButton("↻ Оновити з бази", () => { summaryUnavailable=false; invalidateWorkshopResources(watchScope); pageOffset=0; void load(); });
  const filter = document.createElement("select"); filter.setAttribute("aria-label", "Категорія перевірки");
  const list = document.createElement("div");
  const hint = document.createElement("p");
  hint.textContent = "Огляд за правилами на основі записів у базі, без здогадок ШІ. Не зберігає й не змінює акти, склад або зарплати. Приймальник бачить свої акти, слюсар — призначені йому. У плануванні працівник бачить створені ним записи, адміністратор — усі. Локальні чернетки та черги інших пристроїв тут не перевіряються.";
  const previous=workflowButton("← Попередня сторінка",()=>{pageOffset=Math.max(0,pageOffset-200);void load();});
  const next=workflowButton("Наступна сторінка →",()=>{if(summaryHasMore){pageOffset+=200;void load();}});
  const pages=document.createElement("div");pages.className="workflow-actions";pages.hidden=true;pages.append(previous,next);
  ui.content.append(hint, refresh, filter, list,pages);
  filter.onchange=()=>{pageOffset=0;void load();};
  async function loadSummary(): Promise<void> {
    const prices=await canUserSeePriceColumns(),acts=await canUserViewActs(),stock=await canUserSeeSkladButton();
    const planningSetting=({Приймальник:21,Слюсар:6,Запчастист:23,Складовщик:20} as Record<string,number>)[role!];
    const planning=role==="Адміністратор" || Boolean(planningSetting && await getCachedSettingForRole(planningSetting,role!));
    const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+2);
    const local=(d:Date)=>String(d.getFullYear())+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+'T00:00:00';
    const args={p_role:role,p_name:name,p_prices:prices,p_acts:acts,p_stock:stock,p_planning:planning,p_start:local(start),p_end:local(end),p_category:filter.value,p_offset:pageOffset};
    const scope=localStorage.getItem('userAuthData') || '';
    let page:any;
    try {
      page=await workshopReadCache.read(JSON.stringify(['attention',scope,args]),async()=>{
        const response=await supabase.rpc('traffic_attention_overview',args);
        if(response.error)throw response.error;
        if(!response.data || !Array.isArray(response.data.items) || !response.data.counts || !Array.isArray(response.data.warnings))throw new Error('Некоректна відповідь огляду.');
        return response.data;
      });
    } catch(error:any) {
      if (['PGRST202','42883'].includes(error?.code)) {
        summaryUnavailable=true;
        throw new Error('Для огляду встановіть SQL-функцію traffic_attention_overview із файлу оптимізації №8. Після встановлення натисніть «Оновити з бази».');
      }
      throw error;
    }
    if(controller.signal.aborted || userAccessLevel!==role || userName!==name)return;
    summaryUnavailable=false;summaryHasMore=page.has_more;
    items=page.items.map((item:any)=>item.planningAt ? {category:item.category,destination:item.destination,text:new Date(item.planningAt).toLocaleString('uk-UA')+' · '+(item.post || 'Пост')+' · '+item.status} : item);
    warnings=[...page.warnings,...(acts?[]:['Розділ актів недоступний для вашої ролі.'])];
    const selected=filter.value;filter.replaceChildren(new Option('Усі підказки ('+page.total+')',''));
    for(const [category,count] of Object.entries(page.counts))filter.add(new Option(category+' ('+count+')',category));
    if([...filter.options].some(option=>option.value===selected))filter.value=selected;
    pages.hidden=false;previous.disabled=pageOffset===0;next.disabled=!summaryHasMore;
    render();ui.message.textContent='Підказок у базі: '+page.total+'. На сторінці: '+items.length+'.'+(warnings.length?' Є неперевірені дані.':'');
  }
  function render() {
    list.replaceChildren();
    for (const warning of warnings) { const p = document.createElement("p"); p.className = "workflow-warning"; p.textContent = warning; list.append(p); }
    const selected = items.filter(item => !filter.value || item.category === filter.value);
    for (const item of selected) {
      const card = document.createElement("div"); card.className = "workflow-card";
      const title = document.createElement("strong"); title.textContent = `${item.category}${item.actId ? ` · Акт №${item.actId}` : ""}`;
      const text = document.createElement("p"); text.textContent = item.text; card.append(title, text);
      if (item.actId) card.append(workflowButton("Відкрити акт", async () => {
        try {
          if (!await canUserOpenActs()) throw new Error("Немає права відкривати акти.");
          const { showModal } = await import("../zakaz_naraudy/modalMain");
          ui.dialog.close(); await showModal(item.actId!, "client");
        } catch (error) { if (ui.dialog.isConnected) ui.message.textContent = errorText(error); }
      }));
      if (item.destination === "planner") card.append(workflowButton("Відкрити планування", () => { window.open("planyvannya.html", "_blank", "noopener"); }));
      list.append(card);
    }
    if (!selected.length) { const p = document.createElement("p"); p.textContent = warnings.length ? "У завантажених розділах за вибраним фільтром немає підказок. Частину даних не перевірено — див. повідомлення вище." : "За перевіреними правилами та вибраним фільтром зауважень немає."; list.append(p); }
  }
  async function load() {
    if(controller.signal.aborted || document.hidden)return;
    if(loading){loadQueued=true;return;}
    loading = true; refresh.disabled = true; filter.disabled=true; previous.disabled=true; next.disabled=true;
    ui.message.textContent = "Перевірка записів у базі…";
    try {
      await stopWatching.ready;
      if (controller.signal.aborted || document.hidden) return;
      if (userAccessLevel !== role || userName !== name) throw new Error("Користувач змінився. Відкрийте огляд повторно.");
      await loadSummary();
    } catch (error) { ui.message.textContent = errorText(error); }
    finally { loading = false; refresh.disabled = false; filter.disabled=false; previous.disabled=pageOffset===0; next.disabled=!summaryHasMore; if(loadQueued){loadQueued=false;if(!summaryUnavailable && !document.hidden)void load();} }
  }
  await load();
}
