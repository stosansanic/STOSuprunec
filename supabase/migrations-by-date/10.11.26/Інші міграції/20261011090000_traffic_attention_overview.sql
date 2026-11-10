-- JavaScript display conversion used only by the existing attention rules.
create or replace function public.traffic_attention_text(v jsonb) returns text language plpgsql immutable as $$
declare result text;
begin
 if v is null or v='null'::jsonb then return ''; end if;
 if jsonb_typeof(v)='object' then return '[object Object]'; end if;
 if jsonb_typeof(v)='array' then
   select coalesce(string_agg(public.traffic_attention_text(value),',' order by ordinality),'') into result from jsonb_array_elements(v) with ordinality;
   return result;
 end if;
 return v#>>'{}';
end $$;
create or replace function public.traffic_attention_positive_price(v jsonb) returns boolean language plpgsql immutable as $$
declare s text; n double precision; digits text; base integer; total numeric:=0; digit integer; ch text;
begin
 s:=regexp_replace(public.traffic_attention_text(v),'[[:space:]'||chr(160)||chr(65279)||']','','g');
 s:=regexp_replace(s,',','.');
 if s ~ '^0[xX][0-9a-fA-F]+$' or s ~ '^0[bB][01]+$' or s ~ '^0[oO][0-7]+$' then
   base:=case lower(substr(s,2,1)) when 'x' then 16 when 'b' then 2 else 8 end;
   digits:=lower(substr(s,3));
   for i in 1..length(digits) loop ch:=substr(digits,i,1);digit:=strpos('0123456789abcdef',ch)-1;total:=total*base+digit;end loop;
   n:=total::double precision;
 elsif s ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then n:=s::double precision;
 else return false; end if;
 return n>0 and n<'Infinity'::double precision;
exception when others then return false;
end $$;

create or replace function public.traffic_attention_act_rules(a jsonb,p_role text,p_name text,p_prices boolean)
returns jsonb language plpgsql immutable as $$
declare d jsonb;works jsonb;details jsonb;section jsonb;rows jsonb;entry jsonb;items jsonb:='[]';keys text[];id text;amount integer;permitted boolean:=false;
begin
 if p_role='Приймальник' and a->>'pruimalnyk' is distinct from p_name then return jsonb_build_object('permitted',false,'items',items);end if;
 permitted:=p_role in ('Адміністратор','Приймальник','Запчастист','Складовщик');
 d:=a->'data';if jsonb_typeof(d)='string' then d:=(d#>>'{}')::jsonb;end if;
 if d is null or d='null'::jsonb then d:='{}';end if;
 if jsonb_typeof(d)<>'object' then raise exception 'Invalid act';end if;
 works:=case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]'::jsonb end;
 if p_role='Слюсар' then
   for entry in select value from jsonb_array_elements(works) loop
     if entry='null'::jsonb then raise exception 'Invalid work';end if;
     if entry->'Слюсар'=to_jsonb(p_name) then permitted:=true;exit;end if;
   end loop;
 else permitted:=p_role in ('Адміністратор','Приймальник','Запчастист','Складовщик');end if;
 if not permitted then return jsonb_build_object('permitted',false,'items',items);end if;
 select coalesce(jsonb_agg(w),'[]') into works from jsonb_array_elements(works) w
 where w->'Робота' not in ('null'::jsonb,'false'::jsonb,'0'::jsonb) and regexp_replace(public.traffic_attention_text(w->'Робота'),'^[[:space:]'||chr(160)||chr(65279)||']+|[[:space:]'||chr(160)||chr(65279)||']+$','','g')<>'';
 if p_role='Слюсар' and not exists(select 1 from jsonb_array_elements(works) w where w->'Слюсар'=to_jsonb(p_name)) then return jsonb_build_object('permitted',true,'items',items);end if;
 if d->'Заморожений'='true'::jsonb then return jsonb_build_object('permitted',true,'items',items);end if;
 section:=d->'__workshop_v1';
 if section is not null and section<>'null'::jsonb then
   if section->'version' is distinct from '1'::jsonb or jsonb_typeof(section->'defects') is distinct from 'array' or jsonb_typeof(section->'recommendations') is distinct from 'array' then raise exception 'Invalid workshop';end if;
   foreach id in array array['defects','recommendations'] loop
     keys:=array[]::text[];
     for entry in select value from jsonb_array_elements(section->id) loop
       if jsonb_typeof(entry->'id') is distinct from 'string' or (entry->>'id')=any(keys) then raise exception 'Invalid workshop record';end if;
       keys:=array_append(keys,entry->>'id');
     end loop;
   end loop;
   select count(*) into amount from jsonb_array_elements(section->'recommendations') r where r->>'state' in ('proposed','approved');
   if amount>0 then items:=items||jsonb_build_array(jsonb_build_object('actId',a->'act_id','category','Рекомендації','text','Незавершених рекомендацій: '||amount));end if;
 end if;
 if a->>'date_off' is null then
   if p_role='Слюсар' then select coalesce(jsonb_agg(w),'[]') into works from jsonb_array_elements(works) w where w->'Слюсар'=to_jsonb(p_name);end if;
   select count(*) into amount from jsonb_array_elements(works) w where w->'Слюсар' is null or w->'Слюсар' in ('null'::jsonb,'false'::jsonb,'0'::jsonb) or regexp_replace(public.traffic_attention_text(w->'Слюсар'),'^[[:space:]'||chr(160)||chr(65279)||']+|[[:space:]'||chr(160)||chr(65279)||']+$','','g')='';
   if amount>0 then items:=items||jsonb_build_array(jsonb_build_object('actId',a->'act_id','category','Виконавці','text','Робіт без призначеного виконавця: '||amount));end if;
   if p_prices and p_role<>'Слюсар' then
     details:=case when jsonb_typeof(d->'Деталі')='array' then d->'Деталі' else '[]'::jsonb end;
     select coalesce(jsonb_agg(r),'[]') into details from jsonb_array_elements(details) r where r->'Деталь' not in ('null'::jsonb,'false'::jsonb,'0'::jsonb) and regexp_replace(public.traffic_attention_text(r->'Деталь'),'^[[:space:]'||chr(160)||chr(65279)||']+|[[:space:]'||chr(160)||chr(65279)||']+$','','g')<>'';
     select count(*) into amount from jsonb_array_elements(works||details) r where not public.traffic_attention_positive_price(r->'Ціна');
     if amount>0 then items:=items||jsonb_build_array(jsonb_build_object('actId',a->'act_id','category','Ціни','text','Позицій без додатної ціни: '||amount||' — перевірте, чи це навмисно'));end if;
   end if;
   if a->'slusarsOn'='true'::jsonb and p_role in ('Адміністратор','Приймальник') then items:=items||jsonb_build_array(jsonb_build_object('actId',a->'act_id','category','Завершення робіт','text','Є позначка завершення робіт слюсарем. Перевірте готовність і зв’язок із клієнтом.'));end if;
   if d->'__payroll_pending'='true'::jsonb and p_role='Адміністратор' then items:=items||jsonb_build_array(jsonb_build_object('actId',a->'act_id','category','Збереження','text','В акті є позначка незавершеного оновлення нарахувань. Потрібна перевірка; огляд нічого не перераховує.'));end if;
 end if;
 return jsonb_build_object('permitted',permitted,'items',items);
exception when others then return jsonb_build_object('permitted',permitted,'items','[]'::jsonb,'warning','Не вдалося перевірити дані акта №'||(a->>'act_id')||'.');
end $$;

create or replace function public.traffic_attention_overview(p_role text,p_name text,p_prices boolean,p_acts boolean,p_stock boolean,p_planning boolean,p_start timestamptz,p_end timestamptz,p_category text default '',p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_role not in ('Адміністратор','Приймальник','Слюсар','Запчастист','Складовщик') or nullif(p_name,'') is null then raise exception 'Invalid attention scope';end if;
 if p_offset<0 or p_start is null or p_end is null or p_end<=p_start or p_end-p_start>interval '3 days' then raise exception 'Invalid attention range';end if;
 with acts as materialized (
   select a.act_id,public.traffic_attention_act_rules(jsonb_build_object('act_id',a.act_id,'pruimalnyk',a.pruimalnyk,'date_off',a.date_off,'slusarsOn',a."slusarsOn",'data',a.data),p_role,p_name,p_prices) r
   from public.acts a where p_acts and (p_role<>'Приймальник' or a.pruimalnyk=p_name)
 ), reasons as (
   select 1 source,a.act_id id,e.ordinality ordinal,e.value item from acts a cross join lateral jsonb_array_elements(a.r->'items') with ordinality e
   union all
   select 2,s.sclad_id,1,jsonb_strip_nulls(jsonb_build_object('actId',case when a.r->>'permitted'='true' then a.act_id else null end,'category','Деталі','text',s.statys||': '||coalesce(nullif(s.name,''),'Без назви')||case when s.akt>0 then ' · акт №'||s.akt else '' end))
   from public.sclad s left join acts a on a.act_id=s.akt
   where p_stock and s.statys in ('Замовити','Замовлено') and (p_role in ('Адміністратор','Запчастист','Складовщик') or a.r->>'permitted'='true')
   union all
   select 3,p.post_arxiv_id,1,jsonb_build_object('category','Планування','destination','planner','planningAt',p.data_on,'post',p.name_post,'status',p.status)
   from public.post_arxiv p where p_planning and p.data_on>=p_start and p.data_on<p_end and p.status in ('Запланований','В роботі') and (p_role='Адміністратор' or p.xto_zapusav=p_name)
 ), counts as (select item->>'category' category,count(*) amount from reasons group by 1), selected as (
   select * from reasons where p_category='' or item->>'category'=p_category order by source,id,ordinal limit 201 offset p_offset
 )
 select jsonb_build_object(
   'items',coalesce((select jsonb_agg(item order by source,id,ordinal) from (select * from selected order by source,id,ordinal limit 200) page),'[]'::jsonb),
   'counts',coalesce((select jsonb_object_agg(category,amount) from counts),'{}'::jsonb),
   'total',(select count(*) from reasons),'has_more',(select count(*)>200 from selected),
   'warnings',coalesce((select jsonb_agg(r->>'warning' order by act_id) from acts where r?'warning'),'[]'::jsonb)
 ) into result;
 return result;
end $$;
grant execute on function public.traffic_attention_overview(text,text,boolean,boolean,boolean,boolean,timestamptz,timestamptz,text,integer) to anon,authenticated;
