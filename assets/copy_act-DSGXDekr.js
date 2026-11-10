import{s as v}from"./supabaseClient-B1oar7xm.js";import{J as m,h as z,K as E,l as q,L as $,M as N,N as M}from"./main-D0G_tMFD.js";import"./supabase-5lnat4iA.js";import"./vendor-plPglgEH.js";import"./pdf-DIrKI35W.js";import"./date-vendor-BJ6pn1K1.js";import"./charts--JFhjWof.js";function T(){const t=new Date,n=o=>String(o).padStart(2,"0");return`${t.getFullYear()}-${n(t.getMonth()+1)}-${n(t.getDate())} ${n(t.getHours())}:${n(t.getMinutes())}:${n(t.getSeconds())}`}let u=null,b=null,k=[];async function A(){if(k.length>0)return k;const{data:t}=await v.from("clients").select("client_id, data").order("client_id",{ascending:!1});return k=t||[],k}async function H(t){const{data:n}=await v.from("cars").select("cars_id, data").eq("client_id",t).not("is_deleted","is",!0).order("cars_id",{ascending:!1});return n||[]}function h(t){const n=typeof t.data=="string"?JSON.parse(t.data):t.data;return((n==null?void 0:n.ПІБ)||`Клієнт #${t.client_id}`).trim()}function I(t){const n=typeof t.data=="string"?JSON.parse(t.data):t.data,o=(n==null?void 0:n.Авто)||"",r=(n==null?void 0:n["Номер авто"])||"",d=(n==null?void 0:n.Рік)||"";return[o,d,r].filter(Boolean).join(" · ")||`Авто #${t.cars_id}`}function j(){var o;(o=document.getElementById("copy-act-picker-modal"))==null||o.remove();const t=document.createElement("div");return t.id="copy-act-picker-modal",t.style.cssText=`
    position:fixed; inset:0; z-index:10200;
    background:rgba(0,0,0,0.55);
    display:flex; align-items:center; justify-content:center;
    animation:fadeIn .15s ease;
  `,t.innerHTML=`
    <div id="copy-picker-box" style="
      background:#fff; border-radius:16px;
      width:460px; max-width:95vw; max-height:85vh;
      display:flex; flex-direction:column;
      box-shadow:0 12px 50px rgba(0,0,0,0.3);
      overflow:hidden;
    ">
      <!-- Хедер -->
      <div style="
        background:linear-gradient(135deg,#177245,#0f5132);
        padding:18px 24px; color:#fff;
        display:flex; align-items:center; justify-content:space-between;
      ">
        <div>
          <div style="font-size:20px; font-weight:700;">📋 Схожий акт</div>
          <div style="font-size:12px; opacity:.8; margin-top:2px;">
            Роботи і деталі перенесуться до нового акту
          </div>
        </div>
        <button id="copy-picker-close" style="
          background:rgba(255,255,255,.15); border:none; color:#fff;
          width:32px; height:32px; border-radius:50%; font-size:18px;
          cursor:pointer; display:flex; align-items:center; justify-content:center;
        ">×</button>
      </div>

      <!-- Крок 1: пошук клієнта -->
      <div id="copy-step-client" style="padding:20px 24px; flex:1; overflow-y:auto;">
        <div style="font-size:13px; color:#555; margin-bottom:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;">
          Крок 1 — Оберіть клієнта
        </div>
        <div style="position:relative;">
          <input id="copy-client-search" type="text"
            placeholder="🔍 Пошук по ПІБ або телефону..."
            style="
              width:100%; box-sizing:border-box;
              padding:10px 14px; border-radius:10px;
              border:1.5px solid #ddd; font-size:14px;
              outline:none; transition:border .2s;
            "
          />
        </div>
        <div id="copy-client-list" style="
          margin-top:8px; max-height:320px; overflow-y:auto;
          border:1px solid #eee; border-radius:10px;
        "></div>
      </div>

      <!-- Крок 2: вибір авто (прихований спочатку) -->
      <div id="copy-step-car" style="padding:20px 24px; display:none; flex:1; overflow-y:auto;">
        <button id="copy-back-to-client" style="
          background:none; border:none; color:#177245;
          font-size:13px; cursor:pointer; margin-bottom:12px;
          display:flex; align-items:center; gap:4px; padding:0;
        ">← Назад до клієнтів</button>
        <div style="font-size:13px; color:#555; margin-bottom:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;">
          Крок 2 — Оберіть авто
        </div>
        <div id="copy-client-name-display" style="
          padding:10px 14px; background:#f0f9f4; border-radius:8px;
          color:#177245; font-weight:600; margin-bottom:12px; font-size:14px;
        "></div>
        <div id="copy-car-list" style="
          max-height:280px; overflow-y:auto;
          border:1px solid #eee; border-radius:10px;
        "></div>
        <div id="copy-no-cars" style="display:none; text-align:center; padding:20px; color:#888; font-size:14px;">
          😔 У цього клієнта немає авто.<br>
          <button id="copy-create-anyway" style="
            margin-top:12px; padding:8px 20px; border-radius:8px;
            background:#177245; color:#fff; border:none; cursor:pointer;
            font-size:14px; font-weight:600;
          ">Все одно створити акт</button>
        </div>
      </div>

      <!-- Кнопка підтвердження (показується після вибору авто) -->
      <div id="copy-footer" style="
        display:none; padding:14px 24px;
        border-top:1px solid #eee;
        display:none; flex-direction:column; gap:10px;
        background:#fafafa;
      ">
        <div id="copy-summary" style="font-size:13px; color:#555; line-height:1.5;"></div>
        <button id="copy-confirm-final" style="
          padding:12px; border-radius:10px; border:none;
          background:linear-gradient(135deg,#177245,#0f5132);
          color:#fff; font-size:15px; font-weight:700;
          cursor:pointer; transition:opacity .2s;
        ">✅ Створити схожий акт</button>
      </div>
    </div>
  `,document.body.appendChild(t),{el:t,destroy:()=>t.remove()}}function C(t,n){const o=document.getElementById("copy-client-list"),r=n.toLowerCase().trim(),d=t.filter(a=>{const i=h(a).toLowerCase(),s=typeof a.data=="string"?JSON.parse(a.data):a.data,p=((s==null?void 0:s.Телефон)||"").toLowerCase();return!r||i.includes(r)||p.includes(r)}).slice(0,50);if(d.length===0){o.innerHTML='<div style="padding:20px; text-align:center; color:#888; font-size:14px;">Нічого не знайдено</div>';return}o.innerHTML=d.map(a=>{const i=typeof a.data=="string"?JSON.parse(a.data):a.data,s=h(a),p=(i==null?void 0:i.Телефон)||"";return`
      <div class="copy-client-item" data-id="${a.client_id}" style="
        padding:12px 16px; cursor:pointer; border-bottom:1px solid #f0f0f0;
        transition:background .15s;
      ">
        <div style="font-weight:600; font-size:14px; color:#1a1a2e;">${s}</div>
        ${p?`<div style="font-size:12px; color:#177245; margin-top:2px;">${p}</div>`:""}
      </div>
    `}).join("")}function D(t){const n=document.getElementById("copy-car-list"),o=document.getElementById("copy-no-cars");if(t.length===0){n.style.display="none",o.style.display="block";return}o.style.display="none",n.style.display="block",n.innerHTML=t.map(r=>{const d=I(r);return`
      <div class="copy-car-item" data-id="${r.cars_id}" style="
        padding:12px 16px; cursor:pointer; border-bottom:1px solid #f0f0f0;
        transition:background .15s; display:flex; align-items:center; gap:10px;
      ">
        <span style="font-size:22px;">🚗</span>
        <span style="font-weight:600; font-size:14px; color:#1a1a2e;">${d}</span>
      </div>
    `}).join("")}async function Y(t){var y;u=null,b=null,m("⏳ Завантажую клієнтів...","info",1500);const n=await A(),{el:o,destroy:r}=j(),d=o.querySelector("#copy-step-client"),a=o.querySelector("#copy-step-car"),i=o.querySelector("#copy-footer"),s=o.querySelector("#copy-client-search"),p=o.querySelector("#copy-client-list"),x=o.querySelector("#copy-car-list"),w=o.querySelector("#copy-client-name-display"),g=o.querySelector("#copy-summary"),f=document.createElement("style");f.textContent=`
    .copy-client-item:hover { background:#f0f9f4 !important; }
    .copy-car-item:hover    { background:#f0f9f4 !important; }
    #copy-client-search:focus { border-color:#177245 !important; }
  `,document.head.appendChild(f),C(n,""),s.addEventListener("input",()=>{C(n,s.value)}),p.addEventListener("click",async l=>{const e=l.target.closest(".copy-client-item");if(!e)return;u=Number(e.dataset.id);const c=n.find(_=>_.client_id===u);if(!c)return;d.style.display="none",a.style.display="block",w.textContent=`👤 ${h(c)}`;const S=await H(u);D(S)}),o.querySelector("#copy-back-to-client").addEventListener("click",()=>{u=null,b=null,a.style.display="none",d.style.display="block",i.style.display="none"}),x.addEventListener("click",l=>{var _;const e=l.target.closest(".copy-car-item");if(!e)return;b=Number(e.dataset.id),x.querySelectorAll(".copy-car-item").forEach(L=>{L.style.background=""}),e.style.background="#e8f5e9";const c=n.find(L=>L.client_id===u),S=((_=e.querySelector("span:last-child"))==null?void 0:_.textContent)||"";g.innerHTML=`
      <b>Клієнт:</b> ${c?h(c):"—"}<br>
      <b>Авто:</b> ${S}
    `,i.style.display="flex"}),(y=o.querySelector("#copy-create-anyway"))==null||y.addEventListener("click",()=>{b=null;const l=n.find(e=>e.client_id===u);g.innerHTML=`<b>Клієнт:</b> ${l?h(l):"—"}<br><b>Авто:</b> не вказано`,i.style.display="flex"}),o.querySelector("#copy-confirm-final").addEventListener("click",async()=>{if(!u)return;const l=o.querySelector("#copy-confirm-final");l.disabled=!0,l.textContent="⏳ Створюємо...",await B(t,u,b),r(),f.remove()}),o.querySelector("#copy-picker-close").addEventListener("click",()=>{r(),f.remove()}),o.addEventListener("click",l=>{l.target===o&&(r(),f.remove())})}async function B(t,n,o){var r;try{m("⏳ Копіюємо акт...","info",2500);const{data:d,error:a}=await v.from("acts").select("data").eq("act_id",t).single();if(a||!d){m("❌ Помилка читання акту","error");return}const i=d.data,s=((i==null?void 0:i.Деталі)||[]).filter(e=>{var c;return(c=e.Деталь)==null?void 0:c.trim()}).map(e=>({Деталь:e.Деталь||"",Магазин:e.Магазин||"",Кількість:e.Кількість||0,Ціна:e.Ціна||0,Сума:e.Сума||0,Каталог:e.Каталог||"",sclad_id:e.sclad_id||null,detail_id:e.detail_id||null})),p=((i==null?void 0:i.Роботи)||[]).filter(e=>{var c;return(c=e.Робота)==null?void 0:c.trim()}).map(e=>({Робота:e.Робота||"",Слюсар:e.Слюсар||"",Кількість:e.Кількість||0,Ціна:e.Ціна||0,Сума:e.Сума||0,Каталог:e.Каталог||"",slyusar_id:e.slyusar_id||null,work_id:e.work_id||null}));s.length===0&&s.push({Деталь:"",Магазин:"",Кількість:0,Ціна:0,Сума:0,Каталог:"",sclad_id:null,detail_id:null}),p.length===0&&p.push({Робота:"",Слюсар:"",Кількість:0,Ціна:0,Сума:0,Каталог:"",slyusar_id:null,work_id:null});const x=s.reduce((e,c)=>e+(Number(c.Сума)||0),0),w=p.reduce((e,c)=>e+(Number(c.Сума)||0),0),g=x+w,f={Деталі:s,Роботи:p,Пробіг:0,"За деталі":x,"За роботу":w,Приймальник:"",Рекомендації:(i==null?void 0:i.Рекомендації)||"",Примітки:(i==null?void 0:i.Примітки)||"","Загальна сума":g,"Причина звернення":(i==null?void 0:i["Причина звернення"])||"","Прибуток за деталі":0,"Прибуток за роботу":0,copied_from_act_id:t},{data:y,error:l}=await v.from("acts").insert([{date_on:T(),client_id:n,cars_id:o,data:f,avans:0}]).select("act_id").single();if(l||!y){m("❌ Помилка створення акту","error");return}if(typeof window<"u"&&window.dispatchEvent(new CustomEvent("sto:act-saved",{detail:{actId:y.act_id,affectedCarIds:[Number(o)]}})),z!=="Слюсар"){const e=(r=E)==null?void 0:r();e!=null&&e.name&&await v.from("acts").update({pruimalnyk:e.name}).eq("act_id",y.act_id)}await q("act_copy",y.act_id,{source_act_id:t,totalSum:g},"act"),m(`✅ Акт №${y.act_id} створено!`,"success",4e3),await $(),await N(),await M(y.act_id,"client")}catch{m("❌ Внутрішня помилка","error")}}export{Y as openCopyActPicker};
