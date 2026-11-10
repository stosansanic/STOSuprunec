-- Read-only smart-search helpers. They preserve JS truthiness and scalar conversion.
begin;
create or replace function public.traffic_search_truthy(v jsonb) returns boolean
language sql immutable security invoker set search_path=pg_catalog as $$
 select coalesce(v not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb),false);
$$;
create or replace function public.traffic_search_string(v jsonb) returns text
language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare result text;
begin
 if v is null then return 'undefined'; end if;
 if jsonb_typeof(v)='string' then return v#>>'{}'; end if;
 if jsonb_typeof(v)='object' then return '[object Object]'; end if;
 if jsonb_typeof(v)='array' then
   select coalesce(string_agg(case when x='null'::jsonb then '' else public.traffic_search_string(x) end,',' order by ord),'')
     into result from jsonb_array_elements(v) with ordinality a(x,ord);
   return result;
 end if;
 return v::text;
end;
$$;
create or replace function public.traffic_search_number(v jsonb) returns double precision
language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare t text; n double precision:=0; digit integer; radix integer; c text;
begin
 if v is null then return null; end if;
 if v='null'::jsonb or v='false'::jsonb then return 0; end if;
 if v='true'::jsonb then return 1; end if;
 t:=btrim(public.traffic_search_string(v), E' \t\r\n\v\f'||chr(160)||chr(65279));
 if t='' then return 0; end if;
 if t ~ '^0[xX][0-9a-fA-F]+$' or t ~ '^0[bB][01]+$' or t ~ '^0[oO][0-7]+$' then
   radix:=case lower(substr(t,2,1)) when 'x' then 16 when 'b' then 2 else 8 end;
   for i in 3..length(t) loop digit:=strpos('0123456789abcdef',lower(substr(t,i,1)))-1;n:=n*radix+digit;end loop;
   return n;
 end if;
 if t in ('Infinity','+Infinity','-Infinity') then return t::double precision; end if;
 if t !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null; end if;
 return t::double precision;
 exception when invalid_text_representation then return null;
 when numeric_value_out_of_range then
   begin if abs(t::numeric)<1 then return 0;end if;
   exception when numeric_value_out_of_range then if t ~ '[eE]-' then return 0;end if;end;
   return case when left(t,1)='-' then '-Infinity'::double precision else 'Infinity'::double precision end;
end;
$$;
create or replace function public.traffic_search_trim(v text) returns text
language sql immutable security invoker set search_path=pg_catalog as $$
 select regexp_replace(v,U&'^[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$','','g');
$$;
create or replace function public.traffic_search_strip_space(v text) returns text
language sql immutable security invoker set search_path=pg_catalog as $$
 select regexp_replace(v,U&'[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]','','g');
$$;
create or replace function public.traffic_search_text(d jsonb,keys text[]) returns text
language sql immutable security invoker set search_path=pg_catalog,public as $$
 select coalesce((select public.traffic_search_trim(public.traffic_search_string(d->k)) from unnest(keys) with ordinality a(k,ord)
 where d->k is not null and d->k<>'null'::jsonb and public.traffic_search_trim(public.traffic_search_string(d->k))<>'' order by ord limit 1),'');
$$;
create or replace function public.traffic_act_search_match(a jsonb,client_data jsonb,car_data jsonb,filters jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare d jsonb; cl jsonb; car jsonb; raw jsonb; f jsonb; val text; typ text; low text;
 pib text; phone text; carname text; plate text; works jsonb; parts jsonb; amount double precision; target double precision;
 hit boolean; code text; at_date timestamptz; formatted_date text; amount_text text;
begin
 if coalesce(jsonb_array_length(filters),0)=0 then return true;end if;
 d:=public.sto_read_object_v1(case when public.traffic_search_truthy(a->'info') then a->'info'
   when public.traffic_search_truthy(a->'data') then a->'data' else a->'details' end);
 cl:=public.sto_read_object_v1(client_data);car:=public.sto_read_object_v1(car_data);
 pib:=case when public.traffic_search_truthy(cl->'ПІБ') then public.traffic_search_string(cl->'ПІБ') else 'Невідомо' end;
 phone:=translate(public.traffic_search_strip_space(case when public.traffic_search_truthy(cl->'Телефон') then public.traffic_search_string(cl->'Телефон') else '' end),'()-','');
 plate:=coalesce(nullif(public.traffic_search_text(car,array['Номер авто','Держ. номер','plate','number']),''),public.traffic_search_text(d,array['Номер авто','Держ. номер']));
 carname:=public.traffic_search_text(car,array['Авто','Автомобіль','auto','car','name']);
 if carname='' then carname:=btrim(public.traffic_search_text(car,array['Марка','brand','make'])||' '||public.traffic_search_text(car,array['Модель','model'])); end if;
 if carname='' then carname:=public.traffic_search_text(d,array['Автомобіль','Авто','Марка']);end if;
 works:=case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]'::jsonb end;
 parts:=case when jsonb_typeof(d->'Деталі')='array' then d->'Деталі' else '[]'::jsonb end;
 raw:=coalesce((select x from unnest(array[d->'Загальна сума',d->'total',d->'amount',a->'total',a->'amount']) with ordinality t(x,ord) where public.traffic_search_truthy(x) order by ord limit 1),a->'amount');
 amount:=coalesce(public.traffic_search_number(raw),0);
 for f in select value from jsonb_array_elements(coalesce(filters,'[]'::jsonb)) loop
   typ:=f->>'type';val:=coalesce(f->>'value','');low:=lower(val);hit:=false;
   case typ
   when 'act' then hit:=strpos(coalesce(a->>'act_id',''),val)>0;
   when 'pib' then hit:=strpos(lower(pib),low)>0;
   when 'phone' then hit:=strpos(phone,val)>0;
   when 'car' then hit:=strpos(lower(carname),low)>0;
   when 'carNumber' then hit:=strpos(upper(public.traffic_search_strip_space(plate)),upper(val))>0;
   when 'date' then
     begin at_date:=(a->>'date_on')::timestamptz;hit:=at_date>=(f->>'dateFrom')::timestamptz and at_date<=(f->>'dateTo')::timestamptz;
     exception when invalid_datetime_format or datetime_field_overflow then hit:=false;end;
   when 'amount' then
     target:=public.traffic_search_number(f->'amountVal');
     hit:=case f->>'amountOp' when '>=' then amount>=target when '<=' then amount<=target when '>' then amount>target when '<' then amount<target when '=' then amount=target else false end;
   when 'status' then
     hit:=case val when 'open' then not public.traffic_search_truthy(a->'date_off') when 'closed' then public.traffic_search_truthy(a->'date_off')
       when 'paid' then public.traffic_search_truthy(a->'rosraxovano') when 'unpaid' then not public.traffic_search_truthy(a->'rosraxovano')
       when 'withAdvance' then public.traffic_search_number(a->'avans')>0
       when 'withDiscount' then public.traffic_search_number(d->'Знижка')>0 else true end;
   when 'raxunok' then hit:=strpos(case when public.traffic_search_truthy(a->'contrAgent_raxunok') then public.traffic_search_string(a->'contrAgent_raxunok') else '' end,val)>0;
   when 'actDoc' then hit:=strpos(case when public.traffic_search_truthy(a->'contrAgent_act') then public.traffic_search_string(a->'contrAgent_act') else '' end,val)>0;
   when 'pruimalnyk' then hit:=strpos(lower(coalesce(a->>'pruimalnyk','')),low)>0;
   when 'work','detail','slusar' then
     select exists(select 1 from jsonb_array_elements(case when typ='detail' then parts else works end) w
       where strpos(lower(case when typ='slusar' then coalesce(w->>'Слюсар','')
         else case when public.traffic_search_truthy(w->case when typ='work' then 'Робота' else 'Деталь' end)
           then w->>case when typ='work' then 'Робота' else 'Деталь' end else coalesce(w->>'Назва','') end end),low)>0) into hit;
   when 'text' then
     hit:=strpos(lower(pib),low)>0 or strpos(phone,val)>0 or strpos(lower(plate),low)>0 or strpos(lower(carname),low)>0 or strpos(coalesce(a->>'act_id',''),val)>0
       or strpos(lower(coalesce(a->>'pruimalnyk','')),low)>0 or strpos(lower(coalesce(d->>'Рекомендації','')),low)>0
       or strpos(lower(coalesce(d->>'Причина звернення','')),low)>0 or strpos(lower(coalesce(d->>'Примітки','')),low)>0
       or strpos(case when public.traffic_search_truthy(a->'contrAgent_raxunok') then public.traffic_search_string(a->'contrAgent_raxunok') else '' end,val)>0
       or strpos(case when public.traffic_search_truthy(a->'contrAgent_act') then public.traffic_search_string(a->'contrAgent_act') else '' end,val)>0;
     if not hit then select exists(select 1 from jsonb_array_elements(works) w where strpos(lower(case when public.traffic_search_truthy(w->'Робота') then w->>'Робота' else coalesce(w->>'Назва','') end),low)>0 or strpos(lower(coalesce(w->>'Слюсар','')),low)>0)
       or exists(select 1 from jsonb_array_elements(parts) w where strpos(lower(case when public.traffic_search_truthy(w->'Деталь') then w->>'Деталь' else coalesce(w->>'Назва','') end),low)>0) into hit;end if;
   when 'legacy' then
     code:=lower(coalesce(f->>'key',''));formatted_date:='';
     if a->>'date_on' is not null then formatted_date:=to_char((a->>'date_on')::timestamptz at time zone coalesce(f->>'timezone','UTC'),'DD.MM.YY');end if;
     amount_text:=amount::text;
     if abs(amount)>=0.000001 and abs(amount)<1e21 and amount_text ~ '[eE]' then amount_text:=(amount_text::numeric)::text;end if;
     amount_text:=regexp_replace(amount_text,'e([+-])0+','e\1');
     if upper(val) like 'СФ-%' or upper(val) like 'ОУ-%' then
       raw:=a->case when upper(val) like 'СФ-%' then 'contrAgent_raxunok' else 'contrAgent_act' end;
       val:=btrim(substr(upper(val),4));
       hit:=case when val='' then public.traffic_search_truthy(raw) else strpos(case when public.traffic_search_truthy(raw) then public.traffic_search_string(raw) else '' end,val)>0 end;
     else
       case code
       when 'акт' then hit:=strpos(coalesce(a->>'act_id',''),val)>0;
       when 'сума' then
         target:=public.traffic_search_number(to_jsonb(substring(btrim(val) from '^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')));
         hit:=amount>=target;
       when 'дата' then hit:=strpos(formatted_date,val)>0;
       when 'тел','телефон' then hit:=strpos(phone,val)>0;
       when 'піб' then hit:=strpos(lower(pib),low)>0;
       when 'машина' then hit:=strpos(lower(carname),low)>0;
       when 'номер' then hit:=strpos(plate,val)>0;
       else
         hit:=strpos(lower(pib),low)>0 or strpos(phone,val)>0 or strpos(plate,val)>0 or strpos(lower(carname),low)>0
           or strpos(coalesce(a->>'act_id',''),val)>0 or strpos(formatted_date,val)>0 or strpos(amount_text,val)>0
           or strpos(case when public.traffic_search_truthy(a->'contrAgent_raxunok') then public.traffic_search_string(a->'contrAgent_raxunok') else '' end,val)>0
           or strpos(case when public.traffic_search_truthy(a->'contrAgent_act') then public.traffic_search_string(a->'contrAgent_act') else '' end,val)>0
           or strpos(lower(coalesce(a->>'pruimalnyk','')),low)>0 or strpos(lower(coalesce(d->>'Рекомендації','')),low)>0
           or strpos(lower(coalesce(d->>'Причина звернення','')),low)>0 or strpos(lower(coalesce(d->>'Примітки','')),low)>0;
         if not hit then select exists(select 1 from jsonb_array_elements(works) w where strpos(lower(case when public.traffic_search_truthy(w->'Робота') then w->>'Робота' else coalesce(w->>'Назва','') end),low)>0 or strpos(lower(coalesce(w->>'Слюсар','')),low)>0)
           or exists(select 1 from jsonb_array_elements(parts) w where strpos(lower(case when public.traffic_search_truthy(w->'Деталь') then w->>'Деталь' else coalesce(w->>'Назва','') end),low)>0) into hit;end if;
       end case;
     end if;
   else raise exception 'Unsupported search filter: %',typ;
   end case;
   if not coalesce(hit,false) then return false;end if;
 end loop;
 return true;
end;
$$;
revoke all on function public.traffic_search_trim(text),public.traffic_search_strip_space(text),public.traffic_search_truthy(jsonb),public.traffic_search_string(jsonb),public.traffic_search_number(jsonb),public.traffic_search_text(jsonb,text[]),public.traffic_act_search_match(jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.traffic_search_trim(text),public.traffic_search_strip_space(text),public.traffic_search_truthy(jsonb),public.traffic_search_string(jsonb),public.traffic_search_number(jsonb),public.traffic_search_text(jsonb,text[]),public.traffic_act_search_match(jsonb,jsonb,jsonb,jsonb) to anon,authenticated;

create or replace function public.traffic_act_search_page(
 p_from timestamptz default null,p_to timestamptz default null,p_mode text default null,
 p_filters jsonb default '[]',p_offset integer default 0,p_sort text default 'id'
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if p_offset<0 or p_offset is null or p_sort not in ('id','open','created','closed') or p_sort is null then raise exception 'Invalid search page';end if;
 if jsonb_typeof(p_filters)<>'array' or jsonb_array_length(p_filters)>50 then raise exception 'Invalid search filters';end if;
 if p_mode is not null and p_mode not in ('open','closed','frozen') then raise exception 'Invalid search mode';end if;
 return (with candidates as materialized (
  select a.act_id,a.date_on,a.date_off,to_jsonb(a) a,cl.client_id,cl.data::jsonb client_data,c.cars_id,c.data::jsonb car_data
  from public.acts a left join public.clients cl on cl.client_id=a.client_id left join public.cars c on c.cars_id=a.cars_id
  where case p_mode when 'open' then a.date_off is null when 'closed' then a.date_off is not null when 'frozen' then true
    else p_from is not null and p_to is not null and a.date_on>=p_from and a.date_on<=p_to end
   and case when p_mode='frozen' then public.sto_read_object_v1(a.data::jsonb)->'Заморожений'='true'::jsonb
     when p_mode in ('open','closed') then coalesce(public.sto_read_object_v1(a.data::jsonb)->'Заморожений'<>'true'::jsonb,true) else true end
 ), matched as materialized (
  select * from candidates where public.traffic_act_search_match(a,client_data,car_data,p_filters)
 ), page as (
  select * from matched order by
    case when p_sort='open' then (date_off is null)::integer end desc nulls last,
    case when p_sort='closed' then (date_off is not null)::integer end desc nulls last,
    case when p_sort='closed' then coalesce(date_off,date_on,'epoch'::timestamptz) when p_sort='created' then coalesce(date_on,'epoch'::timestamptz) end desc nulls last,
    act_id desc offset p_offset limit 50
 ) select jsonb_build_object(
 'items',coalesce((select jsonb_agg(
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.a) where key=any(array[
     'act_id','date_on','date_off','cars_id','client_id','pruimalnyk','slusarsOn','sms','avans','rosraxovano',
     'contrAgent_act','contrAgent_act_data','contrAgent_raxunok','contrAgent_raxunok_data','total','amount']))
   || jsonb_build_object('__sto_projection','act-search-v1','data',
     case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'data'))='object' then public.sto_act_list_data_v1(p.a->'data')-'Роботи'-'Деталі' else p.a->'data' end)
   || case when p.a ? 'info' then jsonb_build_object('info',case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'info'))='object' then public.sto_act_list_data_v1(p.a->'info')-'Роботи'-'Деталі' else p.a->'info' end) else '{}'::jsonb end
   || case when p.a ? 'details' then jsonb_build_object('details',case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'details'))='object' then public.sto_act_list_data_v1(p.a->'details')-'Роботи'-'Деталі' else p.a->'details' end) else '{}'::jsonb end
 order by
    case when p_sort='open' then (p.date_off is null)::integer end desc nulls last,
    case when p_sort='closed' then (p.date_off is not null)::integer end desc nulls last,
    case when p_sort='closed' then coalesce(p.date_off,p.date_on,'epoch'::timestamptz) when p_sort='created' then coalesce(p.date_on,'epoch'::timestamptz) end desc nulls last,
    p.act_id desc
 ) from page p),'[]'::jsonb),
 'clients',coalesce((select jsonb_agg(distinct jsonb_build_object('client_id',client_id,'data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(client_data)) where key=any(array['ПІБ','Телефон'])))) from page where client_id is not null),'[]'::jsonb),
 'cars',coalesce((select jsonb_agg(distinct jsonb_build_object('cars_id',cars_id,'data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(car_data)) where key=any(array['Номер авто','Держ. номер','plate','number','Авто','Автомобіль','auto','car','name','Марка','brand','make','Модель','model'])))) from page where cars_id is not null),'[]'::jsonb),
 'total',(select count(*) from candidates),'matched',(select count(*) from matched),
 'has_more',p_offset+50<(select count(*) from matched),
 'next_offset',case when p_offset+50<(select count(*) from matched) then p_offset+50 else null end
 ));
end;
$$;
revoke all on function public.traffic_act_search_page(timestamptz,timestamptz,text,jsonb,integer,text) from public;
grant execute on function public.traffic_act_search_page(timestamptz,timestamptz,text,jsonb,integer,text) to anon,authenticated;

create or replace function public.traffic_act_notification_counts(p_ids bigint[],p_reception text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if cardinality(p_ids)>50 then raise exception 'At most 50 act IDs';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('act_id',act_id,'count',n)) from (
   select act_id,count(*) n from public.act_changes_notifications
   where act_id=any(p_ids) and delit=false and (p_reception is null or pruimalnyk=p_reception) group by act_id
 ) counts),'[]'::jsonb);
end;
$$;
revoke all on function public.traffic_act_notification_counts(bigint[],text) from public;
grant execute on function public.traffic_act_notification_counts(bigint[],text) to anon,authenticated;
commit;
