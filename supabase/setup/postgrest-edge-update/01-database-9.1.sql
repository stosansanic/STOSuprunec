-- 23.10.2026. Оновлення чинного проєкту. Вставити ВЕСЬ файл у Supabase SQL Editor.
-- Це SQL, не код Edge Function. Спочатку SQL, потім оновлення сайту та Edge Functions.
-- Потрібна чинна схема СТО й попередній повний файл 8 (від 21.10.2026 або новіший).
-- Включено необхідні залежності оптимізації Realtime. Повторне виконання дозволено.
-- Для нового проєкту основні зміни вже включено у файл 8.
-- Якщо пізніше встановлено старий файл 9 Нової пошти, виконайте цей пакет останнім.
-- Одна транзакція: помилка скасовує весь цей пакет. Історії виплат не видаляються.
-- Реєстр версій росте з кількістю транзакцій; контролюйте його розмір і час читання.

begin;
-- BEGIN POSTGREST OPTIMIZATION 2026-10-23
-- SOURCE: 20261023063556_realtime_traffic_optimization.sql
-- SQL Editor, not Edge Functions. Safe to reapply; preserves source-table RLS.
-- Compact columns are maintained in the same transaction as the business row.

create or replace function public.traffic_realtime_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
  if jsonb_typeof(p_value)='string' then
    begin p_value:=(p_value#>>'{}')::jsonb; exception when invalid_text_representation then return '{}'::jsonb; end;
  end if;
  return case when jsonb_typeof(p_value)='object' then p_value else '{}'::jsonb end;
end $$;
revoke all on function public.traffic_realtime_object(jsonb) from public;
grant execute on function public.traffic_realtime_object(jsonb) to anon,authenticated,service_role;

alter table public.acts add column if not exists traffic_state jsonb;
alter table public.post_arxiv add column if not exists traffic_previous jsonb;

create or replace function public.traffic_realtime_act_state(p_row jsonb, p_previous jsonb default null)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
  with doc as (select public.traffic_realtime_object(p_row->'data') d),
  prior as (select public.traffic_realtime_object(p_previous->'data') d)
  select jsonb_build_object(
    'frozen',coalesce(doc.d->'Заморожений'='true'::jsonb,false),
    'revision',md5((p_row-'traffic_state')::text),
    'act_revision',doc.d->>'__act_revision',
    'staff_revision',md5(jsonb_build_array(doc.d->'Роботи',doc.d->'Деталі',p_row->'pruimalnyk',doc.d->'__payroll_pending')::text),
    'summary',coalesce((select jsonb_object_agg(key,value) from jsonb_each(doc.d)
      where key=any(array['Номер авто','Держ. номер','Автомобіль','Авто','Марка',
        'Загальна сума','total','amount','Знижка','За деталі','За роботу','Дзвінок',
        'Примітки','Рекомендації','Причина звернення','Заморожений','Пробіг','__act_revision'])),'{}'::jsonb),
    'previous',case when p_previous is null then null else jsonb_build_object(
      'date_on',p_previous->'date_on','date_off',p_previous->'date_off',
      'slusarsOn',p_previous->'slusarsOn',
      'pruimalnyk',p_previous->'pruimalnyk','cars_id',p_previous->'cars_id','client_id',p_previous->'client_id',
      'frozen',coalesce(prior.d->'Заморожений'='true'::jsonb,false)) end
  ) from doc,prior;
$$;
revoke all on function public.traffic_realtime_act_state(jsonb,jsonb) from public;
grant execute on function public.traffic_realtime_act_state(jsonb,jsonb) to anon,authenticated,service_role;

create or replace function public.traffic_realtime_maintain_act_state()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' then new.traffic_state:=public.traffic_realtime_act_state(to_jsonb(new));
  elsif (to_jsonb(new)-'traffic_state') is not distinct from (to_jsonb(old)-'traffic_state') and old.traffic_state is not null then
    new.traffic_state:=old.traffic_state;
  else new.traffic_state:=public.traffic_realtime_act_state(to_jsonb(new),to_jsonb(old)); end if;
  return new;
end $$;
revoke all on function public.traffic_realtime_maintain_act_state() from public,anon,authenticated;
drop trigger if exists zz_traffic_realtime_act_state on public.acts;
create trigger zz_traffic_realtime_act_state before insert or update on public.acts
for each row execute function public.traffic_realtime_maintain_act_state();
-- No mass UPDATE/backfill: the next real change populates this column before
-- Realtime publishes the row. Installing the migration does not emit every act.

create or replace function public.traffic_realtime_maintain_booking_previous()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_op='INSERT' then new.traffic_previous:=null;
  elsif (to_jsonb(new)-'traffic_previous') is not distinct from (to_jsonb(old)-'traffic_previous') then
    new.traffic_previous:=old.traffic_previous;
  else new.traffic_previous:=jsonb_build_object(
    'data_on',to_jsonb(old)->'data_on','data_off',to_jsonb(old)->'data_off',
    'name_post',to_jsonb(old)->'name_post','slyusar_id',to_jsonb(old)->'slyusar_id'); end if;
  return new;
end $$;
revoke all on function public.traffic_realtime_maintain_booking_previous() from public,anon,authenticated;
drop trigger if exists zz_traffic_realtime_booking_previous on public.post_arxiv;
create trigger zz_traffic_realtime_booking_previous before insert or update on public.post_arxiv
for each row execute function public.traffic_realtime_maintain_booking_previous();

create index if not exists atlas_reminder_latest_callback_idx
on public.atlas_reminder_logs(reminder_id,sent_at desc,log_id desc) where delivery_status='callback';
create or replace function public.traffic_reminder_latest_callbacks(p_reminder_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
  if coalesce(cardinality(p_reminder_ids),0)>500 then raise exception 'Too many reminder IDs' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from (
    select distinct on (reminder_id) reminder_id,message_text,sent_at,log_id
    from public.atlas_reminder_logs where reminder_id=any(p_reminder_ids) and delivery_status='callback'
    order by reminder_id,sent_at desc,log_id desc
  ) r),'[]'::jsonb);
end $$;
revoke all on function public.traffic_reminder_latest_callbacks(bigint[]) from public;
grant execute on function public.traffic_reminder_latest_callbacks(bigint[]) to authenticated,service_role;

-- BEGIN REALTIME NP RATE
-- Server-only counters must not UPDATE the settings row watched by every client.
lock table public.settings in share row exclusive mode;
create schema if not exists sto_realtime_private;
revoke all on schema sto_realtime_private from public,anon,authenticated;
create table if not exists sto_realtime_private.np_rate_buckets(
  bucket text primary key, attempts integer not null check(attempts>=0), expires_at timestamptz not null
);
alter table sto_realtime_private.np_rate_buckets enable row level security;
revoke all on sto_realtime_private.np_rate_buckets from public,anon,authenticated;
create index if not exists np_rate_bucket_expiry_idx on sto_realtime_private.np_rate_buckets(expires_at);
-- Preserve live limits on migration/reapply. Expired entries need not be imported.
insert into sto_realtime_private.np_rate_buckets(bucket,attempts,expires_at)
select e.key,(e.value->>'attempts')::integer,to_timestamp((e.value->>'expires')::double precision)
from public.settings s cross join lateral jsonb_each(
  case when jsonb_typeof(to_jsonb(s)#>'{novaposhta,_rate}')='object'
    then to_jsonb(s)#>'{novaposhta,_rate}' else '{}'::jsonb end) e
where s.setting_id=10 and e.value->>'attempts' ~ '^[0-9]{1,9}$'
  and e.value->>'expires' ~ '^[0-9]{1,12}$'
  and to_timestamp((e.value->>'expires')::double precision)>now()
on conflict(bucket) do update set attempts=greatest(np_rate_buckets.attempts,excluded.attempts),
  expires_at=greatest(np_rate_buckets.expires_at,excluded.expires_at);

create or replace function public.np_online_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare admitted boolean:=false; t timestamptz:=clock_timestamp();
begin
  if p_limit is null or p_limit<1 or p_seconds is null or p_seconds<1 or p_seconds>3600
    or p_bucket is null or length(p_bucket)=0 or length(p_bucket)>200 then raise exception 'INVALID_RATE'; end if;
  if not exists(select 1 from public.settings where setting_id=10) then raise exception 'NP_SETTINGS_MISSING'; end if;
  -- Expiry is indexed; only expired buckets are removed. Live requests contend
  -- on their own bucket instead of locking the single shared settings record.
  delete from sto_realtime_private.np_rate_buckets where expires_at<=t;
  insert into sto_realtime_private.np_rate_buckets as b(bucket,attempts,expires_at)
  values(p_bucket,1,t+make_interval(secs=>p_seconds))
  on conflict(bucket) do update set attempts=b.attempts+1 where b.attempts<p_limit
  returning true into admitted;
  return coalesce(admitted,false);
end $$;
revoke all on function public.np_online_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.np_online_rate(text,integer,integer) to service_role;
-- Repeated saves of an identical NP configuration must not publish settings.
create or replace function public.np_online_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID_CONFIG'; end if;
  insert into public.settings(setting_id,data,novaposhta) values(10,false,p_patch)
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta
  where settings.novaposhta is distinct from coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
end $$;
revoke all on function public.np_online_settings(jsonb) from public,anon,authenticated;
grant execute on function public.np_online_settings(jsonb) to service_role;
do $$ begin
  if exists(select 1 from pg_attribute where attrelid='public.settings'::regclass and attname='novaposhta' and not attisdropped) then
    execute 'update public.settings set novaposhta=novaposhta-''_rate'' where novaposhta ? ''_rate''';
  end if;
end $$;
-- END REALTIME NP RATE

-- A small capability handshake prevents projected subscribers from selecting
-- missing columns on projects which have not installed this migration yet.
create or replace function public.traffic_realtime_capabilities()
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('version',1);
$$;
revoke all on function public.traffic_realtime_capabilities() from public;
grant execute on function public.traffic_realtime_capabilities() to anon,authenticated,service_role;
notify pgrst,'reload schema';

-- SOURCE: 20261023080955_act_editor_scoped_traffic.sql
-- Act editor traffic: scoped shop fragments, compact list refresh and atomic status/stock transitions.
-- Requires the existing act delta, shop payment-scope, search and payroll migrations.

create or replace function public.traffic_act_shop_context(p_act_id integer,p_revision text,p_names text[] default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; client_doc jsonb; car_doc jsonb; shops_json jsonb; stock_json jsonb;
begin
 if cardinality(p_names)>1000 then raise exception 'Забагато магазинів у одному акті';end if;
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if doc->>'__act_revision' is distinct from p_revision then raise exception 'Акт змінився під час синхронізації магазинів' using errcode='40001';end if;
 select public.sto_read_object_v1(to_jsonb(c.data)) into client_doc from public.clients c where c.client_id=a.client_id;
 select public.sto_read_object_v1(to_jsonb(c.data)) into car_doc from public.cars c where c.cars_id=a.cars_id;
 with source as (
  select s.shop_id,public.sto_read_object_v1(to_jsonb(s.data)) body from public.shops s
 ), scoped as (
  select s.shop_id,s.body->>'Name' name,coalesce((
   select jsonb_agg(jsonb_build_object('date',d.key,'entry',e.value) order by d.key,e.ordinality)
   from jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) d
   cross join lateral jsonb_array_elements(case when jsonb_typeof(d.value)='array' then d.value else '[]'::jsonb end) with ordinality e(value,ordinality)
   where e.value->>'Акт'=p_act_id::text
  ),'[]'::jsonb) entries from source s
 ) select coalesce(jsonb_agg(to_jsonb(s) order by s.shop_id),'[]'::jsonb) into shops_json from scoped s
 where s.name=any(p_names) or jsonb_array_length(s.entries)>0;
 select coalesce(jsonb_agg(jsonb_build_object('sclad_id',s.sclad_id,'rahunok',s.rahunok,'time_off',s.time_off) order by s.sclad_id),'[]'::jsonb)
 into stock_json from public.sclad s where s.sclad_id in (
  select distinct (d->>'sclad_id')::bigint from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d
  where d->>'sclad_id' ~ '^[1-9][0-9]*$'
 );
 return jsonb_build_object('act_id',a.act_id,'revision',p_revision,'date_on',a.date_on,'date_off',a.date_off,
  'context_checksum',md5(jsonb_build_array(a.date_on,a.date_off,a.client_id,a.cars_id,a.pruimalnyk)::text),
  'clientInfo',coalesce(nullif(client_doc->>'ПІБ',''),nullif(client_doc->>'fio',''),'—'),
  'carInfo',coalesce(nullif(btrim(concat_ws(' ',car_doc->>'Авто',car_doc->>'Рік',car_doc->>'Номер авто')),''),'—'),
  'shops',shops_json,'stock',stock_json);
end $$;

create or replace function public.guarded_write_act_shop_fragments(p_act_id integer,p_revision text,p_context_checksum text,p_lock_owner text,p_shops jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; item jsonb; change jsonb; result jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if doc->>'__act_revision' is distinct from p_revision or
  md5(jsonb_build_array(a.date_on,a.date_off,a.client_id,a.cars_id,a.pruimalnyk)::text) is distinct from p_context_checksum then
  raise exception 'Акт змінився під час синхронізації магазинів' using errcode='40001';end if;
 if jsonb_typeof(p_shops) is distinct from 'array' or jsonb_array_length(p_shops)>1000 then raise exception 'Некоректний пакет магазинів';end if;
 if exists(select 1 from jsonb_array_elements(p_shops) s group by s->>'shop_id' having count(*)>1) then raise exception 'Магазин дублюється у пакеті';end if;
 for item in select value from jsonb_array_elements(p_shops) order by (value->>'shop_id')::bigint loop
  if jsonb_typeof(item->'changes') is distinct from 'array' then raise exception 'Некоректні зміни магазину';end if;
  for change in select value from jsonb_array_elements(item->'changes') loop
   if change->>'act' is distinct from p_act_id::text or
    (nullif(change->'expected','null'::jsonb) is not null and change#>>'{expected,Акт}' is distinct from p_act_id::text) or
    (nullif(change->'desired','null'::jsonb) is not null and change#>>'{desired,Акт}' is distinct from p_act_id::text) then
    raise exception 'Пакет містить історію іншого акта';end if;
  end loop;
  result:=public.write_shop_history_fragments((item->>'shop_id')::bigint,item->'changes');
  if result->>'status' is distinct from 'saved' then raise exception 'Не підтверджено запис історії магазину';end if;
 end loop;
 return jsonb_build_object('act_id',p_act_id,'revision',p_revision,'status','saved');
end $$;

-- Evaluate search predicates on the server, while returning only the list projection.
create or replace function public.traffic_act_row(p_act_id bigint,p_filters jsonb default '[]')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare raw jsonb; client_row jsonb; car_row jsonb; projected jsonb;
begin
 if jsonb_typeof(p_filters) is distinct from 'array' or jsonb_array_length(p_filters)>50 then raise exception 'Некоректний пошук';end if;
 select to_jsonb(a),to_jsonb(cl),to_jsonb(c) into raw,client_row,car_row from public.acts a
 left join public.clients cl on cl.client_id=a.client_id left join public.cars c on c.cars_id=a.cars_id where a.act_id=p_act_id;
 if raw is null then return null;end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into projected from jsonb_each(raw) where key=any(array[
  'act_id','date_on','date_off','cars_id','client_id','pruimalnyk','slusarsOn','sms','avans','rosraxovano',
  'contrAgent_act','contrAgent_act_data','contrAgent_raxunok','contrAgent_raxunok_data','total','amount']);
 projected:=projected||jsonb_build_object('__sto_projection','act-search-v1','data',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'data'))='object' then public.sto_act_list_data_v1(raw->'data')-'Роботи'-'Деталі' else raw->'data' end);
 if raw ? 'info' then projected:=projected||jsonb_build_object('info',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'info'))='object' then public.sto_act_list_data_v1(raw->'info')-'Роботи'-'Деталі' else raw->'info' end);end if;
 if raw ? 'details' then projected:=projected||jsonb_build_object('details',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'details'))='object' then public.sto_act_list_data_v1(raw->'details')-'Роботи'-'Деталі' else raw->'details' end);end if;
 return jsonb_build_object('act',projected,
  'matches',public.traffic_act_search_match(raw,client_row->'data',car_row->'data',p_filters),
  'clients',case when client_row->>'client_id' is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('client_id',client_row->'client_id','data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(client_row->'data')) where key=any(array['ПІБ','Телефон'])))) end,
  'cars',case when car_row->>'cars_id' is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('cars_id',car_row->'cars_id','data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(car_row->'data')) where key=any(array['Номер авто','Держ. номер','plate','number','Авто','Автомобіль','auto','car','name','Марка','brand','make','Модель','model'])))) end);
end $$;

-- Keep the existing editor checksum/delta contract; link mutations share its transaction.
create or replace function public.guarded_patch_act_with_stock(
 p_act_id integer,p_checksum text,p_changes jsonb,p_revision text,p_lock_owner text,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; next_doc jsonb; op jsonb; path text[]; parent jsonb;
 receipt jsonb; before_ids bigint[]; after_ids bigint[]; conflicts jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if a.date_off is not null or doc->>'Заморожений'='true' then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 if md5(jsonb_build_array(doc,a.avans,a.pruimalnyk,a.date_off)::text) is distinct from p_checksum then
  raise exception 'Акт змінився. Відкрийте його повторно.' using errcode='40001';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or nullif(p_revision,'') is null then raise exception 'Некоректний пакет змін';end if;
 next_doc:=doc;
 for op in select value from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(op->'path') is distinct from 'array' then raise exception 'Некоректний шлях зміни';end if;
  if exists(select 1 from jsonb_array_elements(op->'path') p where jsonb_typeof(p)<>'string') then raise exception 'Некоректний шлях зміни';end if;
  select array_agg(value order by ordinality) into path from jsonb_array_elements_text(op->'path') with ordinality;
  if coalesce(cardinality(path),0)=0 or path[1]='__act_revision' then raise exception 'Недозволений шлях зміни';end if;
  parent:=case when cardinality(path)=1 then next_doc else next_doc#>path[1:cardinality(path)-1] end;
  if parent is null or jsonb_typeof(parent) not in ('object','array') then raise exception 'Батьківське поле не існує';end if;
  if jsonb_typeof(parent)='array' and (path[cardinality(path)]!~'^(0|[1-9][0-9]*)$') then raise exception 'Некоректний індекс';end if;
  if op->'remove'='true'::jsonb then
   if jsonb_typeof(parent)='array' then raise exception 'Видалення позиції потребує нового масиву';end if;
   next_doc:=next_doc#-path;
  elsif op?'value' then next_doc:=jsonb_set(next_doc,path,op->'value',true);
  else raise exception 'Відсутнє значення зміни';end if;
 end loop;
 if next_doc=doc and (p_avans is null or a.avans is not distinct from p_avans) then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',coalesce(doc->>'__act_revision',''),'checksum',md5(doc::text),'cars_id',a.cars_id);
 end if;
 select coalesce(array_agg(distinct (d->>'sclad_id')::bigint),'{}'::bigint[]) into before_ids
 from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d where d->>'sclad_id' ~ '^[1-9][0-9]*$';
 select coalesce(array_agg(distinct (d->>'sclad_id')::bigint),'{}'::bigint[]) into after_ids
 from jsonb_array_elements(coalesce(next_doc->'Деталі','[]')) d where d->>'sclad_id' ~ '^[1-9][0-9]*$';
 -- Lock inventory in the same stable order as the quantity writer.
 perform 1 from public.sclad where sclad_id=any(before_ids||after_ids) order by sclad_id for update;
 next_doc:=next_doc||jsonb_build_object('__act_revision',p_revision);
 receipt:=public.guarded_write_act_with_stock_receipt(p_act_id,doc,next_doc,p_lock_owner,p_avans);
 -- Existing scalar foreign links may represent shared stock. Never steal or clear them.
 select coalesce(jsonb_agg(s.sclad_id order by s.sclad_id),'[]'::jsonb) into conflicts from public.sclad s
 where s.sclad_id=any(after_ids) and not(s.sclad_id=any(before_ids)) and nullif(btrim(s.akt::text),'') is not null and s.akt::text<>p_act_id::text;
 update public.sclad set akt=p_act_id where sclad_id=any(after_ids) and not(sclad_id=any(before_ids)) and nullif(btrim(akt::text),'') is null;
 update public.sclad set akt=null where sclad_id=any(before_ids) and not(sclad_id=any(after_ids)) and akt::text=p_act_id::text;
 return receipt||jsonb_build_object('stock_link_conflicts',conflicts);
end $$;

create or replace function public.traffic_act_transition_state(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb;
begin
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,'total',doc->'Загальна сума',
  'frozen',coalesce(doc->'Заморожений'='true'::jsonb,false),'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision',
  'checksum',md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text));
end $$;

create or replace function public.guarded_set_act_frozen(p_act_id integer,p_frozen boolean,p_checksum text,p_revision text,p_lock_owner text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; allocation record; stock_ids jsonb:='[]'::jsonb; frozen boolean; changed boolean;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if p_frozen is null or nullif(p_revision,'') is null then raise exception 'Некоректний стан акту';end if;
 if a.date_off is not null then raise exception 'Закритий акт не можна заморожувати або розморожувати' using errcode='55000';end if;
 if md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text) is distinct from p_checksum then raise exception 'Акт змінився. Повторіть операцію.' using errcode='40001';end if;
 frozen:=coalesce(doc->'Заморожений'='true'::jsonb,false);changed:=frozen is distinct from p_frozen;
 if changed then
  for allocation in
   select (d->>'sclad_id')::bigint sid,sum((d->>'Кількість')::numeric) qty
   from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d
   where d->>'sclad_id' ~ '^[1-9][0-9]*$' and coalesce(nullif(d->>'Кількість','')::numeric,0)>0
   group by (d->>'sclad_id')::bigint order by (d->>'sclad_id')::bigint
  loop
   update public.sclad set kilkist_off=greatest(coalesce(kilkist_off,0)+case when p_frozen then -allocation.qty else allocation.qty end,0)
   where sclad_id=allocation.sid;
   if not found then raise exception 'Складська позиція % недоступна',allocation.sid using errcode='40001';end if;
   stock_ids:=stock_ids||jsonb_build_array(allocation.sid);
  end loop;
  doc:=doc||jsonb_build_object('Заморожений',p_frozen,'__payroll_pending',true,'__act_revision',p_revision);
  update public.acts set data=doc where act_id=p_act_id;
  if doc is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then
   raise exception 'Акт змінений сервером під час зміни стану' using errcode='40001';end if;
 end if;
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,
  'frozen',p_frozen,'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision','status',case when changed then 'updated' else 'unchanged' end,'stock_ids',stock_ids);
end $$;

revoke all on function public.traffic_act_shop_context(integer,text,text[]),public.guarded_write_act_shop_fragments(integer,text,text,text,jsonb),public.traffic_act_row(bigint,jsonb) from public,anon;
grant execute on function public.traffic_act_shop_context(integer,text,text[]),public.guarded_write_act_shop_fragments(integer,text,text,text,jsonb) to authenticated,service_role;
grant execute on function public.traffic_act_row(bigint,jsonb) to authenticated,anon;
revoke all on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) from public,anon;
grant execute on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) to authenticated,service_role;

notify pgrst,'reload schema';

-- SOURCE: 20261023081041_atlas_postgrest_efficiency.sql
-- All browser reads keep the caller's existing table privileges/RLS. No row
-- retention, business-history deletion or delivery-claim reset is performed.
create or replace function public.traffic_atlas_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare parsed jsonb;
begin
 if jsonb_typeof(p_value)='object' then return p_value;end if;
 if jsonb_typeof(p_value)='string' then
  begin parsed:=(p_value#>>'{}')::jsonb;
   if jsonb_typeof(parsed)='object' then return parsed;end if;
  exception when invalid_text_representation then return '{}'::jsonb;end;
 end if;
 return '{}'::jsonb;
end $$;

-- Number(value || fallback), for the existing historical price calculation.
-- Invalid numeric strings remain NULL rather than becoming a false sample.
create or replace function public.traffic_atlas_number(p_value jsonb,p_fallback double precision)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare value text;
begin
 if p_value is null or p_value in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) then return p_fallback;end if;
 if p_value='true'::jsonb then return 1;end if;
 value:=btrim(p_value#>>'{}',E' \t\n\r');
 if value='' then return 0;end if;
 if value !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null;end if;
 begin return value::double precision;exception when numeric_value_out_of_range then return null;end;
end $$;

create or replace function public.traffic_ai_price_summary(p_name text,p_type text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_type not in ('work','detail') or p_type is null then raise exception 'Unknown price suggestion type';end if;
 with recent as materialized (
  select act_id,public.traffic_atlas_object(to_jsonb(data)) body from public.acts
  where data is not null order by act_id desc limit 50
 ), entries as (
  select r.act_id,e.ord,e.item from recent r cross join lateral
   jsonb_array_elements(case when jsonb_typeof(r.body->case when p_type='work' then 'Роботи' else 'Деталі' end)='array'
    then r.body->case when p_type='work' then 'Роботи' else 'Деталі' end else '[]'::jsonb end) with ordinality e(item,ord)
 ), parsed as (
  select act_id,ord,item->case when p_type='work' then 'Робота' else 'Найменування' end name,
   public.traffic_atlas_number(item->'Ціна',0) price,public.traffic_atlas_number(item->'Кількість',1) quantity,
   case when p_type='work' then public.traffic_atlas_number(item->'Зар-та',0) else 0 end salary,
   case when p_type='work' then btrim(coalesce(item->>'ПІБ _ Магазин','')) else '' end mechanic from entries
 ), matches as materialized (
  select *,row_number() over(order by act_id desc,ord) sequence from parsed
  where price>0 and jsonb_typeof(name)='string' and name#>>'{}'<>'' and
   (strpos(lower(name#>>'{}'),lower(coalesce(p_name,'')))>0 or strpos(lower(coalesce(p_name,'')),lower(name#>>'{}'))>0)
 ), mechanics as (
  select mechanic,count(*) occurrences,min(sequence) first_seen from matches where mechanic<>'' group by mechanic
 ) select case when count(*)=0 then null else jsonb_build_object(
  'minPrice',min(price),'maxPrice',max(price),'count',count(*),
  'avgQuantity',case when count(quantity)=count(*) then floor(sum(quantity order by sequence)/count(*)+0.5) else null end,
  'avgSalary',floor((sum(salary order by sequence) filter(where salary>0))/nullif(count(*) filter(where salary>0),0)+0.5),
  'mostFrequentSlyusar',(select mechanic from mechanics order by occurrences desc,first_seen limit 1),
  'sourceWindow','latest_50_nonnull_acts','as_of',statement_timestamp()) end into result from matches;
 return result;
end $$;

-- One service-only candidate stream. Existing atomic evaluation and recipient
-- claim/start/finish functions remain the final authority before sending.
create or replace function public.traffic_reminder_candidates(p_after bigint default null,p_at timestamptz default now())
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.recipients,r.channel,r.priority,r.condition_query,
   r.schedule,r.trigger_count,r.created_by,coalesce(s.data->>'Name','—') creator_name,r.meta,r.next_trigger_at
  from public.atlas_reminders r left join public.slyusars s on s.slyusar_id=r.created_by
  where r.status='active' and r.channel in ('telegram','both') and (p_after is null or r.reminder_id>p_after)
   and (r.evaluation_lease_until is null or r.evaluation_lease_until<=p_at)
   and ((r.next_trigger_at is not null and r.next_trigger_at<=p_at) or
    (r.reminder_type='conditional' and r.condition_query is not null and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'))
  order by r.reminder_id limit 201
 ), page as(select * from candidates order by reminder_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(reminder_id) from page));
$$;

-- The legacy validator/authorization remains in execute_condition_query.
-- Only a bounded page crosses HTTP; count covers the complete SQL result.
create or replace function public.traffic_ai_condition_page(p_query text,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source jsonb;items jsonb;total integer;page_size integer:=least(greatest(coalesce(p_limit,50),1),100);
 skip integer:=greatest(coalesce(p_offset,0),0);
begin
 source:=public.execute_condition_query(p_query);
 if jsonb_typeof(source)<>'array' then raise exception 'Expected SQL row array';end if;
 total:=jsonb_array_length(source);
 select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into items
 from jsonb_array_elements(source) with ordinality e(value,ord) where ord>skip and ord<=skip+page_size;
 if octet_length(items::text)>262144 then raise exception 'SQL page exceeds 256 KiB: select fewer fields or request a smaller page';end if;
 return jsonb_build_object('items',items,'total',total,'has_more',skip+jsonb_array_length(items)<total,
  'next_offset',skip+jsonb_array_length(items),'as_of',statement_timestamp());
end $$;

-- Keep employee visibility in the existing function. A POST wrapper accepts
-- both its table-row and scalar JSON-array forms without relying on volatility.
create or replace function public.traffic_my_reminder_counts(p_slyusar_id integer)
returns jsonb language sql security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select to_jsonb(r) body from public.get_my_reminders(p_slyusar_id) r
 ), rows as (
  select item from source cross join lateral jsonb_array_elements(
   case when jsonb_typeof(body)='array' then body when jsonb_typeof(body)='object' then jsonb_build_array(body) else '[]'::jsonb end
  ) item
 ) select jsonb_build_object('total',count(*),'active',count(*) filter(where item->>'status'='active')) from rows;
$$;

-- Atomic append + sidebar timestamp; record conversion supports the existing
-- images column type (JSON/JSONB or a text array) without changing the schema.
create or replace function public.traffic_chat_append(p_chat_id bigint,p_role text,p_text text,p_images jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare created_id bigint;message_record public.ai_messages%rowtype;
begin
 if p_role not in ('user','assistant') or p_role is null or jsonb_typeof(p_images) is distinct from 'array' then raise exception 'Invalid chat message';end if;
 -- UPDATE/INSERT are both checked with the caller's existing policies.
 update public.ai_chats set updated_at=clock_timestamp() where chat_id=p_chat_id;
 if not found then raise exception 'Chat unavailable';end if;
 message_record:=jsonb_populate_record(null::public.ai_messages,jsonb_build_object('role',p_role,'text',p_text,'images',p_images));
 insert into public.ai_messages(chat_id,role,text,images) values(p_chat_id,message_record.role,message_record.text,message_record.images) returning message_id into created_id;
 return jsonb_build_object('message_id',created_id);
end $$;

create or replace function public.traffic_atlas_integer(p_value jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare matched text;
begin
 matched:=substring(ltrim(coalesce(p_value#>>'{}',''),E' \t\n\r') from '^[+-]?[0-9]+');
 if matched is null then return 0;end if;
 begin return matched::double precision;exception when numeric_value_out_of_range then raise exception 'Nonfinite mileage';end;
end $$;

create or replace function public.traffic_ai_maintenance_summary(
 p_checks jsonb,p_limit integer default 30,p_now timestamptz default now(),p_timezone text default 'Europe/Kyiv'
) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select act_id,cars_id,date_on,date_off,
   case when jsonb_typeof(to_jsonb(data))='object' then to_jsonb(data) else '{}'::jsonb end body,
   case when pg_typeof(date_on)='timestamp without time zone'::regtype
    then coalesce(date_off,date_on)::timestamp at time zone p_timezone else coalesce(date_off,date_on)::timestamptz end visit_at,
   row_number() over(order by date_on desc nulls first,act_id desc) sequence
  from public.acts where date_off is not null and cars_id is not null and cars_id<>0
 ), car_rows as (
  select *,public.traffic_atlas_integer(body->'Пробіг') mileage,
   max(public.traffic_atlas_integer(body->'Пробіг')) over(partition by cars_id) max_mileage from source
 ), cars as materialized (
  select distinct on(cars_id) cars_id,body,coalesce(date_off,date_on) last_visit,max_mileage,sequence
  from car_rows order by cars_id,sequence
 ), checks as (
  select value rule,ordinality idx from jsonb_array_elements(p_checks) with ordinality
 ), latest as (
  select c.cars_id,c.sequence,c.max_mileage,k.rule,k.idx,a.visit_at,a.mileage
  from cars c cross join checks k cross join lateral (
   select s.visit_at,s.mileage from car_rows s where s.cars_id=c.cars_id and exists(
    select 1 from jsonb_array_elements(case when jsonb_typeof(s.body->'Роботи')='array' then s.body->'Роботи' else '[]'::jsonb end) w,
     jsonb_array_elements_text(k.rule->'keywords') word where strpos(lower(coalesce(w->>'Робота','')),word)>0
   ) order by s.sequence limit 1
  )a
 ), distances as (
  select *,floor(extract(epoch from p_now-visit_at)/86400) days_since,max_mileage-mileage km_since from latest
 ), remaining as (
  select *, (rule->>'interval_days')::integer-days_since days_left,(rule->>'interval_km')::integer-km_since km_left from distances
 ), evaluated as (
  select *,case when km_left<0 or days_left<0 then 0 when km_left<2000 or days_left<30 then 1 when km_left<5000 or days_left<90 then 2 end urgency from remaining
 ), candidates as materialized (
  select c.cars_id,c.sequence,count(*) filter(where e.urgency=0) critical_count,
   jsonb_build_object('car_id',c.cars_id,'client_name',coalesce(nullif(c.body->>'ПІБ',''),'—'),
    'car_name',coalesce(nullif(btrim(coalesce(c.body->>'Марка','')||' '||coalesce(c.body->>'Модель','')),''),nullif(c.body->>'Авто',''),'—'),
    'plate',coalesce(nullif(c.body->>'Держ. номер',''),'—'),'phone',coalesce(nullif(c.body->>'Телефон',''),'—'),
    'last_visit_date',c.last_visit,'last_mileage',c.max_mileage,'alerts',jsonb_agg(jsonb_build_object(
     'work_name',e.rule->>'name','urgency',case e.urgency when 0 then 'critical' when 1 then 'high' else 'medium' end,
     'days_since',e.days_since,'km_since',e.km_since,'km_left',e.km_left,'days_left',e.days_left) order by e.urgency,e.idx)) row
  from cars c join evaluated e on e.cars_id=c.cars_id and e.urgency is not null
  group by c.cars_id,c.sequence,c.body,c.last_visit,c.max_mileage
 ), page as (
  select * from candidates order by critical_count desc,sequence limit least(greatest(coalesce(p_limit,30),1),500)
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(row order by critical_count desc,sequence) from page),'[]'::jsonb),
  'scanned',(select count(*) from cars),'total',(select count(*) from candidates),
  'critical',(select count(*) from candidates where critical_count>0),
  'has_more',(select count(*) from candidates)>(select count(*) from page),'as_of',p_now);
$$;

create or replace function public.traffic_ai_retention_summary(
 p_days integer default 180,p_limit integer default 30,p_now timestamptz default now(),p_timezone text default 'Europe/Kyiv'
) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select act_id,client_id,case when jsonb_typeof(to_jsonb(data))='object' then to_jsonb(data) else '{}'::jsonb end body,
   case when pg_typeof(date_on)='timestamp without time zone'::regtype
    then coalesce(date_off,date_on)::timestamp at time zone p_timezone else coalesce(date_off,date_on)::timestamptz end visit_at,
   row_number() over(order by date_on desc nulls first,act_id desc) sequence
  from public.acts where date_off is not null and client_id is not null and client_id<>0
 ), traversed as (
  select *,max(visit_at) over(partition by client_id order by sequence rows between unbounded preceding and 1 preceding) previous_latest from source
 ), contact_updates as materialized (
  -- Match the original descending-created traversal: contact fields change
  -- only when an act advances the maximum visit date seen so far.
  select *,coalesce(nullif(btrim(coalesce(body->>'Марка','')||' '||coalesce(body->>'Модель','')),''),nullif(body->>'Авто','')) car
  from traversed where previous_latest is null or visit_at>previous_latest
 ), totals as (
  select client_id,min(sequence) sequence,max(visit_at) last_visit,count(*) total_acts,
   floor(sum(public.traffic_ai_parse_float(body->'Загальна сума') order by sequence)+0.5) total_spent from source group by client_id
 ), clients as (
  select t.*,floor(extract(epoch from p_now-t.last_visit)/86400) days_since,
   coalesce((select nullif(body->>'ПІБ','') from contact_updates u where u.client_id=t.client_id and coalesce(body->>'ПІБ','')<>'' order by sequence desc limit 1),'—') name,
   coalesce((select nullif(body->>'Телефон','') from contact_updates u where u.client_id=t.client_id and coalesce(body->>'Телефон','')<>'' order by sequence desc limit 1),'—') phone,
   coalesce((select car from contact_updates u where u.client_id=t.client_id and car is not null order by sequence desc limit 1),'—') last_car
  from totals t
 ), matches as materialized (
  select *,floor(days_since/30) months_since from clients where days_since>=p_days and phone<>'—' and length(phone)>=10
 ), page as (
  select * from matches order by (total_acts>=5) desc,total_spent desc,sequence limit least(greatest(coalesce(p_limit,30),1),500)
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'client_id',client_id,'name',name,'phone',phone,'last_visit',to_char(last_visit at time zone 'UTC','YYYY-MM-DD'),
  'months_since',months_since,'total_spent',total_spent,'total_acts',total_acts,'last_car',last_car,
  'loyalty',case when total_acts>=5 then '🌟 постійний' when total_acts>=2 then '🔄 повторний' else '🆕 разовий' end)
  order by (total_acts>=5) desc,total_spent desc,sequence) from page),'[]'::jsonb),
  'total',(select count(*) from matches),'has_more',(select count(*) from matches)>(select count(*) from page),'as_of',p_now);
$$;

revoke all on function public.traffic_atlas_object(jsonb),public.traffic_atlas_number(jsonb,double precision),
 public.traffic_atlas_integer(jsonb),public.traffic_ai_maintenance_summary(jsonb,integer,timestamptz,text),
 public.traffic_ai_retention_summary(integer,integer,timestamptz,text),
 public.traffic_my_reminder_counts(integer),
 public.traffic_ai_price_summary(text,text),public.traffic_reminder_candidates(bigint,timestamptz),
 public.traffic_ai_condition_page(text,integer,integer),public.traffic_chat_append(bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.traffic_atlas_object(jsonb) to anon,authenticated,service_role;
grant execute on function public.traffic_atlas_number(jsonb,double precision),public.traffic_ai_price_summary(text,text),
 public.traffic_atlas_integer(jsonb),public.traffic_ai_maintenance_summary(jsonb,integer,timestamptz,text),
 public.traffic_ai_retention_summary(integer,integer,timestamptz,text),
 public.traffic_my_reminder_counts(integer),
 public.traffic_chat_append(bigint,text,text,jsonb) to anon,authenticated;
grant execute on function public.traffic_ai_condition_page(text,integer,integer) to authenticated,service_role;
grant execute on function public.traffic_reminder_candidates(bigint,timestamptz) to service_role;

notify pgrst,'reload schema';

-- SOURCE: 20261023081212_workshop_postgrest_efficiency.sql
-- SQL Editor. Requires the base STO schema and payroll_json_object.

create or replace function public.traffic_workshop_projection(p_data jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('__workshop_v1',d->'__workshop_v1','Рекомендації',d->'Рекомендації',
  'Заморожений',d->'Заморожений','__act_revision',d->'__act_revision',
  'Роботи',coalesce((select jsonb_agg(jsonb_build_object('Слюсар',w->'Слюсар'))
    from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]'::jsonb end) w),'[]'::jsonb))
 from (select public.payroll_json_object(p_data) d) s;
$$;

create or replace function public.traffic_workshop_act(p_act_id integer)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('act_id',a.act_id,'cars_id',a.cars_id,'date_off',a.date_off,
  'pruimalnyk',a.pruimalnyk,'data',public.traffic_workshop_projection(to_jsonb(a.data)))
 from public.acts a where a.act_id=p_act_id;
$$;

create or replace function public.traffic_workshop_entry_write(
 p_act_id integer,p_collection text,p_expected jsonb,p_next jsonb,p_employee_id bigint)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; section jsonb; rows jsonb; current_entry jsonb;
 employee jsonb; employee_name text; employee_role text; position integer; saved jsonb; rev text;
begin
 if auth.uid() is null then raise exception 'Потрібен вхід до програми' using errcode='42501';end if;
 select public.payroll_json_object(to_jsonb(s.data)) into employee from public.slyusars s where s.slyusar_id=p_employee_id;
 employee_name:=employee->>'Name'; employee_role:=employee->>'Доступ';
 if nullif(employee_name,'') is null then raise exception 'Працівника не знайдено' using errcode='42501';end if;
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if not (coalesce(employee_role='Адміністратор',false)
  or coalesce(employee_role='Приймальник' and a.pruimalnyk=employee_name,false)
  or coalesce(employee_role='Слюсар' and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(doc->'Роботи')='array' then doc->'Роботи' else '[]'::jsonb end) w where w->>'Слюсар'=employee_name),false)) then
  raise exception 'Працівник більше не має права редагувати цей акт' using errcode='42501';
 end if;
 if p_collection is null or p_collection not in ('defects','recommendations') then raise exception 'Невідомий розділ картки';end if;
 if p_collection='defects' and (a.date_off is not null or doc->>'Заморожений'='true') then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 if jsonb_typeof(p_next) is distinct from 'object' or nullif(p_next->>'id','') is null
   or nullif(p_next->>'updatedAt','') is null or p_next->>'author' is distinct from employee_name then raise exception 'Некоректний автор або запис картки';end if;
 if exists(select 1 from jsonb_each(p_next) e where jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}')>12000) then raise exception 'Некоректні поля картки';end if;
 if p_collection='recommendations' and (nullif(btrim(p_next->>'text'),'') is null or coalesce(p_next->>'state','') not in ('proposed','approved','completed','declined')) then raise exception 'Вкажіть рекомендацію та стан';end if;
 if p_collection='defects' and (nullif(btrim(p_next->>'component'),'') is null or coalesce(p_next->>'state','') not in ('inspect','good','repair','replace')) then raise exception 'Вкажіть вузол і стан';end if;
 section:=doc->'__workshop_v1';
 if section is null or section='null'::jsonb then section:='{"version":1,"defects":[],"recommendations":[]}'::jsonb;end if;
 if section->>'version' is distinct from '1' or jsonb_typeof(section->'defects') is distinct from 'array' or jsonb_typeof(section->'recommendations') is distinct from 'array' then raise exception 'Невідомий формат картки';end if;
 if exists(select 1 from jsonb_array_elements(section->'defects') e group by e->>'id' having count(*)>1 or e->>'id' is null)
   or exists(select 1 from jsonb_array_elements(section->'recommendations') e group by e->>'id' having count(*)>1 or e->>'id' is null) then raise exception 'Пошкоджені записи картки';end if;
 rows:=section->p_collection;
 select e.value,(e.ordinality-1)::integer into current_entry,position from jsonb_array_elements(rows) with ordinality e where e.value->>'id'=p_next->>'id';
 -- Identical retries neither duplicate the entry nor emit another update.
 if current_entry is distinct from p_next and current_entry is distinct from nullif(p_expected,'null'::jsonb) then raise exception 'Цей запис уже змінив інший працівник. Ваш текст залишено у формі.' using errcode='40001';end if;
 if current_entry is null and p_collection='recommendations' and nullif(p_next->>'sourceDefectId','') is not null and exists(select 1 from jsonb_array_elements(rows) e where e->>'sourceDefectId'=p_next->>'sourceDefectId') then raise exception 'Рекомендацію для цього дефекту вже створено' using errcode='40001';end if;
 if current_entry is distinct from p_next then
  rows:=case when position is null then rows||jsonb_build_array(p_next) else jsonb_set(rows,array[position::text],p_next,false) end;
  section:=jsonb_set(section,array[p_collection],rows,false);
  rev:=gen_random_uuid()::text;
  saved:=doc||jsonb_build_object('__workshop_v1',section,'__act_revision',rev);
  update public.acts set data=saved where act_id=p_act_id;
 else rev:=coalesce(doc->>'__act_revision','');end if;
 return jsonb_build_object('act_id',p_act_id,'entry',p_next,'revision',rev,'cars_id',a.cars_id,'date_off',a.date_off,'pruimalnyk',a.pruimalnyk,'frozen',coalesce(doc->>'Заморожений'='true',false));
end $$;

create or replace function public.traffic_workshop_recommendations(p_car_id integer,p_exclude_act integer,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (
  select a.act_id,a.cars_id,a.date_off,a.pruimalnyk,public.payroll_json_object(to_jsonb(a.data)) d
  from public.acts a where a.cars_id=p_car_id and a.act_id<>p_exclude_act and (p_before is null or a.act_id<p_before)
 ), matching as (
  select *,coalesce((select jsonb_agg(r order by ord) from jsonb_array_elements(case when jsonb_typeof(d#>'{__workshop_v1,recommendations}')='array' then d#>'{__workshop_v1,recommendations}' else '[]'::jsonb end) with ordinality e(r,ord) where r->>'state' in ('proposed','approved')),'[]'::jsonb) recommendations
  from candidates
 ), page as (
  select * from matching where recommendations<>'[]'::jsonb or (coalesce(d->>'Рекомендації','') not in ('','—') and coalesce(d#>'{__workshop_v1,recommendations}','[]'::jsonb)='[]'::jsonb) order by act_id desc limit 31
 ), visible as (select * from page order by act_id desc limit 30)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('act_id',act_id,'cars_id',cars_id,'date_off',date_off,'pruimalnyk',pruimalnyk,
  'data',jsonb_build_object('Рекомендації',d->'Рекомендації','Заморожений',d->'Заморожений','__workshop_v1',jsonb_build_object('version',1,'defects','[]'::jsonb,'recommendations',recommendations))) order by act_id desc) from visible),'[]'::jsonb),
  'has_more',(select count(*)>30 from page),'next_cursor',(select min(act_id) from visible));
$$;
revoke all on function public.traffic_workshop_projection(jsonb),public.traffic_workshop_act(integer),public.traffic_workshop_recommendations(integer,integer,bigint),public.traffic_workshop_entry_write(integer,text,jsonb,jsonb,bigint) from public,anon;
grant execute on function public.traffic_workshop_projection(jsonb),public.traffic_workshop_act(integer),public.traffic_workshop_recommendations(integer,integer,bigint),public.traffic_workshop_entry_write(integer,text,jsonb,jsonb,bigint) to authenticated,service_role;
notify pgrst,'reload schema';

-- SOURCE: 20261023081314_accounting_bounded_reports.sql
-- Bounded accounting report payloads. Existing financial formulas, tables and RLS remain authoritative.
-- Requires payroll payments/ledger and accounting payment scope migrations from 2026-10-20/21.

-- Canonical text equality matches the old numeric_id::text join, including
-- rejection of padded, signed-plus, decimal and out-of-bigint legacy values.
create or replace function public.traffic_accounting_canonical_id(p_value text)
returns bigint language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if p_value !~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$' then return null;end if;
 if p_value::numeric not between -9223372036854775808 and 9223372036854775807 then return null;end if;
 return p_value::bigint;
end $$;

-- Validate complete affected histories under the same act -> employee lock order.
-- The existing writer remains authoritative for exact target CAS and ledger rules.
create or replace function public.write_payroll_report_payment_batch(p_employees jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; change jsonb; actual jsonb; employee_id bigint; act_number bigint; body jsonb; receipts jsonb; fragments jsonb;
 part jsonb; source_entry jsonb; current_target jsonb; replacement jsonb; record_key text; record_index integer; match_count integer;
begin
 if jsonb_typeof(p_employees) is distinct from 'array' or jsonb_array_length(p_employees)<1
  or jsonb_array_length(p_employees)>50 then raise exception 'Некоректний пакет зарплати';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e where coalesce(e->>'id','')!~'^[1-9][0-9]*$'
  or jsonb_typeof(e->'changes') is distinct from 'array' or jsonb_array_length(e->'changes')<1
  or jsonb_array_length(e->'changes')>2000) then raise exception 'Некоректний працівник';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e group by e->>'id' having count(*)>1) then raise exception 'Повторний працівник';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e cross join lateral jsonb_array_elements(e->'changes') c
  where coalesce(c->>'act_id','')!~'^[1-9][0-9]*$' or coalesce(c->>'entry_revision','')!~'^[a-f0-9]{32}$') then raise exception 'Некоректна версія нарахування';end if;
 for act_number in select distinct (c->>'act_id')::bigint from jsonb_array_elements(p_employees) e
  cross join lateral jsonb_array_elements(e->'changes') c order by 1 loop
  perform 1 from public.acts where act_id=act_number for update;
  if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_employees) order by (value->>'id')::bigint loop
  employee_id:=(item->>'id')::bigint;
  select public.payroll_json_object(to_jsonb(s.data)) into body from public.slyusars s where slyusar_id=employee_id for update;
  if not found then raise exception 'Працівник відсутній або недоступний' using errcode='40001';end if;
  perform public.traffic_payroll_validate(body);
  -- A new receipt must not mark stale, already loaded sibling works as current.
  -- Check the entire act entry before any target changes, while its employee is locked.
  for change in select distinct jsonb_build_object('act',value->>'act_id','revision',value->>'entry_revision','day',value->>'date')
   from jsonb_array_elements(item->'changes') loop
   actual:=public.payroll_act_entries(body->'Історія',change->>'act');
   if jsonb_array_length(actual)<>1 or actual#>>'{0,date}' is distinct from change->>'day' then
    raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';
   end if;
   source_entry:=actual#>'{0,value}';
   if md5(source_entry::text) is distinct from change->>'revision' then
    -- Preserve an exact retry after a lost response: reverting only these same
    -- desired target states must reconstruct the originally acknowledged entry.
    for part in select value from jsonb_array_elements(item->'changes') where value->>'act_id'=change->>'act' loop
     replacement:=((part->'expected')-array['Розраховано','__payroll_payments'])||(part->'desired');
     if part->>'target'='act' then current_target:=source_entry-'Записи';
     elsif part->>'target'='record' then
      record_key:=part->>'record_id';
      if record_key is not null then
       select count(*),min(ordinality::integer-1) into match_count,record_index
        from jsonb_array_elements(source_entry->'Записи') with ordinality where value->>'recordId'=record_key;
       if match_count<>1 then raise exception 'Роботу змінено' using errcode='40001';end if;
      else
       if coalesce(part->>'index','')!~'^[0-9]+$' then raise exception 'Немає індексу роботи';end if;
       record_index:=(part->>'index')::integer;
      end if;
      current_target:=source_entry#>array['Записи',record_index::text];
     else raise exception 'Невідома ціль виплати';end if;
     if current_target is not distinct from part->'expected' then continue;end if;
     if current_target is distinct from replacement then raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';end if;
     if part->>'target'='act' then source_entry:=(part->'expected')||(case when source_entry?'Записи' then jsonb_build_object('Записи',source_entry->'Записи') else '{}'::jsonb end);
     else source_entry:=jsonb_set(source_entry,array['Записи',record_index::text],part->'expected');end if;
    end loop;
    if md5(source_entry::text) is distinct from change->>'revision' then
     raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';
    end if;
   end if;
  end loop;
 end loop;
 receipts:=public.write_payroll_payment_batch(p_employees);
 with requested as (
  select distinct (e->>'id')::bigint id,c->>'act_id' act from jsonb_array_elements(p_employees) e
   cross join lateral jsonb_array_elements(e->'changes') c
 ), employees as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) body from public.slyusars s
   where s.slyusar_id in (select id from requested)
 ), entries as (
  select r.id,r.act,x.value fragment from requested r join employees e on e.id=r.id
   cross join lateral jsonb_array_elements(public.payroll_act_entries(e.body->'Історія',r.act)) x
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'act',act,'date',fragment->>'date',
  'revision',md5((fragment->'value')::text)) order by id,act),'[]'::jsonb) into fragments from entries;
 return jsonb_build_object('receipts',receipts,'fragments',fragments);
end $$;

create or replace function public.traffic_shop_report_v3(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if nullif(p_filter->>'from','') is null or nullif(p_filter->>'to','') is null then raise exception 'Встановіть період звіту';end if;
 if p_offset<0 or p_limit<1 or p_limit>200 then raise exception 'Invalid report page'; end if;
 with shops as materialized (
  select shop_id,public.sto_read_object_v1(to_jsonb(data)) body from public.shops
 ), history_days as materialized (
  select s.shop_id,s.body->>'Name' shop,h.key date_open,h.value bucket
  from shops s cross join lateral jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) h
  where public.traffic_search_truthy(s.body->'Name') and
   (coalesce(p_filter->>'dateMode','open')<>'open' or
    (public.traffic_shop_date(h.key)<>'' and public.traffic_shop_date(h.key)>=p_filter->>'from'
     and public.traffic_shop_date(h.key)<=p_filter->>'to'))
 ), history as materialized (
  select h.shop_id,h.shop,h.date_open,e.entry,e.ord entry_ord
  from history_days h cross join lateral jsonb_array_elements(case when jsonb_typeof(h.bucket)='array' then h.bucket else '[]'::jsonb end) with ordinality e(entry,ord)
 ), raw as (
  select h.shop_id,h.shop,h.date_open,h.entry_ord,h.entry-'Деталі' entry,d.detail,d.detail_ord,a.act_id,a.date_off,
   public.sto_read_object_v1(to_jsonb(a.data)) act_body,
   n.sclad_id stock_id,to_jsonb(n) stock_row,public.sto_read_object_v1(to_jsonb(n)->'data') stock_body
  from history h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.entry->'Деталі')='array' then h.entry->'Деталі' else '[]'::jsonb end) with ordinality d(detail,detail_ord)
  left join public.acts a on a.act_id=public.traffic_accounting_canonical_id(h.entry->>'Акт')
  left join public.sclad n on n.sclad_id=public.traffic_accounting_canonical_id(d.detail->>'sclad_id')
 ), values_normalized as (
  select *,coalesce(public.traffic_search_number(detail->'Кількість'),0) quantity,
   coalesce(public.traffic_search_number(detail->'Ціна'),0) price,
   case when stock_id is not null then coalesce(public.traffic_search_number(
    case when stock_body ? 'price' then stock_body->'price'
     when jsonb_typeof(stock_row->'data')='string' and stock_body<>'{}'::jsonb then '0'::jsonb
     else stock_row->'price' end),0) end purchase_price,
   public.traffic_search_number(coalesce(stock_body->'scladNomer',stock_row->'scladNomer')) warehouse,
   greatest(coalesce(public.traffic_search_number(act_body->'Знижка'),0),0) discount,
   case when act_id is not null then coalesce(date_off::text,'') else coalesce(entry->>'ДатаЗакриття','') end date_close,
   public.traffic_search_truthy(case when detail ? 'Розраховано' then detail->'Розраховано' else entry->'Розрахунок' end) is_paid,
   coalesce(case when detail ? 'Розраховано' then detail->>'Розраховано' else entry->>'Розрахунок' end,'') payment_date,
   coalesce(detail->>'Найменування','') item,coalesce(detail->>'Каталог','') catalog
  from raw
 ), calculated as (
  select *,quantity*price total,
   case when purchase_price is not null then price*(case when discount>0 then 1-discount/100 else 1 end)*quantity-purchase_price*quantity end margin,
   case coalesce(p_filter->>'dateMode','open') when 'close' then date_close when 'paid' then payment_date else date_open end target_date
  from values_normalized
 ), matches as materialized (
  select *,public.traffic_shop_date(target_date) sort_date from calculated
  where (coalesce(p_filter->>'dateMode','open')='open' or target_date<>'')
   and (coalesce(p_filter->>'from','')='' and coalesce(p_filter->>'to','')='' or
    public.traffic_shop_date(target_date)<>'' and
    (coalesce(p_filter->>'from','')='' or public.traffic_shop_date(target_date)>=p_filter->>'from') and
    (coalesce(p_filter->>'to','')='' or public.traffic_shop_date(target_date)<=p_filter->>'to'))
   and (coalesce(p_filter->>'item','')='' or strpos(lower(item),lower(p_filter->>'item'))>0)
   and (coalesce(p_filter->>'catalog','')='' or strpos(lower(catalog),lower(p_filter->>'catalog'))>0 or
    regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(catalog,NFKC)),'[^[:alnum:]]','','g'),regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g'))>0)
   and (coalesce(p_filter->>'status','all')='all' or (p_filter->>'status'='closed')=(date_close<>''))
   and (coalesce(p_filter->>'payment','all')='all' or (p_filter->>'payment'='paid')=is_paid)
 ), filtered as materialized (
  select * from matches where p_filter->>'warehouse' is null or warehouse=public.traffic_search_number(p_filter->'warehouse')
 ), page as materialized (
  select * from filtered order by sort_date desc,shop_id,date_open,entry_ord,detail_ord offset p_offset limit p_limit

 )
 select jsonb_build_object(
  'items',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'rowId',concat(shop_id,':',date_open,':',entry_ord,':',detail_ord),'shopId',shop_id,
   'entryOrdinal',entry_ord,'detailOrdinal',detail_ord,'recordId',detail->>'recordId',
   'paymentFingerprint',encode(sha256(convert_to((detail-'Розраховано')::text,'UTF8')),'hex'),
   'dateOpen',date_open,'dateClose',date_close,'act',entry->>'Акт','automobile',coalesce(entry->>'Автомобіль',''),
   'shop',shop,'item',item,'catalog',catalog,'quantity',quantity,'price',price,'purchasePrice',purchase_price,
   'total',total,'margin',margin,'discountPercent',discount,'isPaid',is_paid,'paymentDate',payment_date,
   'sclad_id',stock_id,'scladNomer',warehouse,'isClosed',date_close<>'',
   'zapchastystName',(select public.sto_read_object_v1(to_jsonb(s.data))->>'Name' from public.slyusars s
    where s.slyusar_id=public.traffic_accounting_canonical_id(coalesce(stock_body->>'xto_zamovuv',stock_row->>'xto_zamovuv')))
  )) order by sort_date desc,shop_id,date_open,entry_ord,detail_ord) from page),'[]'::jsonb),
  'shops','[]'::jsonb,
  'totalCount',(select count(*) from filtered),
  'totals',(select jsonb_build_object('sale',coalesce(sum(total),0),'purchase',coalesce(sum(coalesce(purchase_price,0)*quantity),0),'margin',coalesce(sum(margin),0)) from filtered),
  'warehouses',coalesce((select jsonb_agg(w order by w) from (select distinct warehouse w from matches where warehouse<>0) x),'[]'::jsonb)
 ) into result;
 return result;
end $$;


create or replace function public.traffic_payroll_report_v3(
 p_filters jsonb,p_offset integer default 0,p_options boolean default true)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
 result jsonb;
 page_size integer:=greatest(1,least(200,case when coalesce(p_filters->>'page_size','')~'^[0-9]{1,3}$' then (p_filters->>'page_size')::integer else 50 end));
 selected_name text:=coalesce(p_filters->>'name','');
 mode text:=coalesce(p_filters->>'mode','open');
 from_day text:=public.traffic_payroll_iso(p_filters->>'from');
 to_day text:=public.traffic_payroll_iso(p_filters->>'to');
begin
 if mode not in ('open','close','paid') then raise exception 'Невідомий режим дат';end if;
 if to_day='' then raise exception 'Потрібна кінцева дата звіту';end if;
 -- Keep validation global: a duplicate outside the date window must still block payment.
 perform public.traffic_payroll_validate(public.payroll_json_object(to_jsonb(s.data)))
 from public.slyusars s
 where selected_name='' or public.payroll_json_object(to_jsonb(s.data))->>'Name'=selected_name;

 with employee_docs as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) doc from public.slyusars s
 ), employees as materialized (
  select * from employee_docs where selected_name='' or doc->>'Name'=selected_name
 ), history_days as materialized (
  select e.id,e.doc->>'Name' name,e.doc->'ПроцентРоботи' percent,
   h.key history_day,h.value bucket,public.traffic_payroll_iso(h.key) history_iso
  from employees e cross join lateral jsonb_each(coalesce(nullif(e.doc->'Історія','null'::jsonb),'{}'::jsonb)) h
 ), selected_days as materialized (
  -- Opening dates belong to history buckets. Filter them before expanding acts or works.
  select * from history_days where mode<>'open' or
   (history_iso<>'' and (from_day='' or history_iso>=from_day) and history_iso<=to_day)
 ), raw_entries as materialized (
  select d.id,d.name,d.percent,d.history_day,d.history_iso,x.value entry,x.ordinality entry_order,
   x.value->>'Акт' act,
   -- Cast the history value, never the indexed acts.act_id. Canonical text matching
   -- retains the old behavior for malformed, padded or out-of-range legacy IDs.
   case when x.value->>'Акт' ~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$' then
    case when (x.value->>'Акт')::numeric between -9223372036854775808 and 9223372036854775807
     then (x.value->>'Акт')::bigint end end act_number
  from selected_days d cross join lateral jsonb_array_elements(d.bucket) with ordinality x
 ), act_ids as materialized (
  select distinct act_number from raw_entries where act_number is not null
 ), act_docs as materialized (
  -- Parse each referenced act once, even if several employees worked on it.
  select a.act_id,a.date_off,parsed.doc->'Заморожений'='true'::jsonb frozen,
   parsed.doc->'__payroll_pending'='true'::jsonb pending
  from act_ids i join public.acts a on a.act_id=i.act_number
  -- Keep one evaluation of the parser, but materialize only two flags, not act JSON.
  cross join lateral (select public.payroll_json_object(to_jsonb(a.data)) doc offset 0) parsed
 ), entries as materialized (
  select r.*,a.act_id existing_act_id,a.date_off,
   a.frozen,a.pending,
   case when a.act_id is not null then coalesce(a.date_off::text,'') else coalesce(r.entry->>'ДатаЗакриття','') end close_day,
   case when a.act_id is not null then a.date_off is not null else coalesce(r.entry->>'ДатаЗакриття','')<>'' end closed
  from raw_entries r left join act_docs a on a.act_id=r.act_number
 ), scoped_entries as materialized (
  -- Closing dates cannot be inferred from opening dates. Filter their effective
  -- act/legacy date after the join, but still before expanding works.
  select * from entries where not coalesce(frozen,false) and
   (mode<>'close' or (public.traffic_payroll_iso(close_day)<>''
    and (from_day='' or public.traffic_payroll_iso(close_day)>=from_day)
    and public.traffic_payroll_iso(close_day)<=to_day))
 ), expanded as (
  select e.*,case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0 then 'work'
   when entry?'СуммаРоботи' then 'receiver' when entry?'СуммаЗапчастин' then 'parts' else 'unknown' end kind,
   r.value row_data,r.ordinality::integer-1 work_index
  from scoped_entries e cross join lateral jsonb_array_elements(
   case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0
    then entry->'Записи' else '[null]'::jsonb end) with ordinality r
 ), dated_rows as (
  select e.*,d.paid_day,d.payment_summary,
   case when kind='work' then coalesce(row_data->>'Робота','') when kind='receiver' then '-' else 'Запчастини' end work,
   case when mode='paid' then d.payment_summary->>'paidIso'
    when mode='close' then public.traffic_payroll_iso(close_day) else history_iso end filter_day
  from expanded e cross join lateral (
   select payment_summary,payment_summary->>'paidDate' paid_day from (
    select public.traffic_payroll_payment_summary(
     case when kind='work' then row_data else entry end,
     case when kind='work' then entry else null end,from_day,to_day) payment_summary offset 0
   ) calculated
  ) d
  where kind<>'unknown' and not(kind='work' and coalesce(row_data->'Кількість'='0'::jsonb,false)
   and not public.traffic_search_truthy(row_data->'Зарплата')
   and not coalesce((d.payment_summary->>'hasPayment')::boolean,false))
 ), value_rows as materialized (
  -- Store scalar report values only. Do not copy the complete act/work JSON into
  -- every expanded row of the materialized totals/sort pipeline.
  select id,name,percent,history_day,history_iso,entry_order,act,existing_act_id,date_off,closed,pending,
   kind,work_index,paid_day,work,
   (payment_summary->>'earned')::double precision earned,
   (payment_summary->>'paidAmount')::double precision paid_amount,
   (payment_summary->>'due')::double precision due,
   (payment_summary->>'overpaid')::double precision overpaid,
   (payment_summary->>'paidInPeriod')::double precision paid_period,
   (payment_summary->>'hasPayment')::boolean has_payment,
   coalesce(public.traffic_search_number(row_data->'Ціна'),0)*coalesce(public.traffic_search_number(row_data->'Кількість'),0) work_total,
   coalesce(public.traffic_search_number(row_data->'Зарплата'),0) work_salary,
   coalesce(public.traffic_search_number(entry->'СуммаРоботи'),0) work_sum,
   coalesce(public.traffic_search_number(entry->'СуммаЗапчастин'),0) parts_sum,
   coalesce(public.traffic_search_number(entry->'ЗарплатаРоботи'),0) receiver_work_salary,
   coalesce(public.traffic_search_number(entry->'ЗарплатаЗапчастин'),0) parts_salary
  from dated_rows where filter_day<>'' and (from_day='' or filter_day>=from_day) and filter_day<=to_day
 ), date_matches as materialized (
  select *,case when kind='work' then work_total when kind='receiver' then work_sum+parts_sum else parts_sum end revenue,
   earned salary
  from value_rows
 ), matches as materialized (
  select * from date_matches where
   (coalesce(p_filters->>'act','')='' or act=p_filters->>'act')
   and (coalesce(p_filters->>'work','')='' or strpos(lower(work),lower(p_filters->>'work'))>0)
   and (coalesce(p_filters->>'payment','all')='all'
    or (p_filters->>'payment'='paid' and has_payment and due=0)
    or (p_filters->>'payment'='unpaid' and due>0))
   and (coalesce(p_filters->>'status','all')='all' or (p_filters->>'status'='closed' and closed) or (p_filters->>'status'='open' and not closed))
   and (coalesce(p_filters->>'percentage','all')='all' or (kind='work' and salary<>0 and coalesce(public.traffic_search_number(percent),0)<>0 and
    case when p_filters->>'percentage'='higher' then (case when revenue>0 then salary/revenue*100 else 0 end)>public.traffic_search_number(percent)
     else (case when revenue>0 then salary/revenue*100 else 0 end)<public.traffic_search_number(percent) end))
 ), page as materialized (
  select *,coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) sort_act,
   case when mode='paid' then public.traffic_payroll_iso(paid_day) else history_iso end sort_day
  from matches order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index
  offset greatest(coalesce(p_offset,0),0) limit page_size
 ), page_entries as (
  -- Preserve exact selected targets for payment CAS; omit all sibling works.
  -- Original array indices are explicit, so old records without IDs remain guarded.
  select p.id,p.name,p.percent,p.history_day,p.entry_order,
   (r.entry-'Записи') || case when bool_or(p.kind='work') then jsonb_build_object(
    'Записи',jsonb_agg(r.entry->'Записи'->p.work_index order by p.work_index),
    '__report_work_indexes',jsonb_agg(p.work_index order by p.work_index))
   else case when r.entry?'Записи' then jsonb_build_object('Записи',r.entry->'Записи') else '{}'::jsonb end end
   ||jsonb_build_object('__report_entry_revision',md5(r.entry::text)) entry
  from page p join raw_entries r on r.id=p.id and r.history_day=p.history_day and r.entry_order=p.entry_order
  group by p.id,p.name,p.percent,p.history_day,p.entry_order,r.entry
 ), histories as (
  select id,name,percent,history_day,jsonb_agg(entry order by entry_order) entries
  from page_entries group by id,name,percent,history_day
 ), rows as (
  select id,jsonb_build_object('slyusar_id',id,'data',jsonb_build_object('Name',name,'ПроцентРоботи',percent,'Історія',jsonb_object_agg(history_day,entries))) row
  from histories group by id,name,percent
 ), totals as (
  select count(*) total,coalesce(sum(revenue),0) revenue,coalesce(sum(salary),0) salary,
   coalesce(sum(paid_amount),0) paid_amount,coalesce(sum(due),0) due,
   coalesce(sum(overpaid),0) overpaid,coalesce(sum(paid_period),0) paid_period from matches
 )
 select jsonb_build_object(
  'format_version',3,'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
  'keys',coalesce((select jsonb_agg(jsonb_build_array(id,history_day,act,case when kind='work' then work_index else null end)
   order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index) from page),'[]'::jsonb),
  'statuses',coalesce((select jsonb_agg(jsonb_build_object('actId',id,'dateOff',date_off,'isClosed',closed,'isFrozen',false,'payrollPending',pending))
   from (select distinct existing_act_id::text id,date_off,closed,pending from page where existing_act_id is not null)s),'[]'::jsonb),
  'page_size',page_size,'total',t.total,'revenue',t.revenue,'salary',t.salary,
  'paidAmount',t.paid_amount,'due',t.due,'overpaid',t.overpaid,'paidInPeriod',t.paid_period,
  'has_more',t.total>greatest(coalesce(p_offset,0),0)+page_size,
  'acts',case when coalesce(p_options,true) then coalesce((select jsonb_agg(act order by coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) desc)
   from(select distinct act from date_matches)a),'[]'::jsonb) else '[]'::jsonb end,
  'works',case when coalesce(p_options,true) then coalesce((select jsonb_agg(work order by work)
   from(select distinct work from date_matches order by work limit 150)w),'[]'::jsonb) else '[]'::jsonb end
 ) into result from totals t;
 return result;
end $$;


-- Facets intentionally use the complete period/exclusion scope, independent
-- of shop/payment/warehouse filters, but do not construct report rows or totals.
create or replace function public.traffic_stock_accounting_facets(p_filter jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f text:=p_filter->>'from'; t text:=p_filter->>'to'; mode text:=coalesce(p_filter->>'dateMode','open');
 date_column text; date_type text; result jsonb;
begin
 if f is null or t is null or f!~'^\d{4}-\d{2}-\d{2}$' or t!~'^\d{4}-\d{2}-\d{2}$'
  or f::date>t::date or mode not in ('open','paid') then raise exception 'Invalid stock facet period';end if;
 if p_filter?'exclude' and (jsonb_typeof(p_filter->'exclude') is distinct from 'array'
  or jsonb_array_length(p_filter->'exclude')>2000) then raise exception 'Invalid excluded stock rows';end if;
 date_column:=case mode when 'paid' then 'rosraxovano' else 'time_on' end;
 select case a.atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz'
  when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into date_type
 from pg_attribute a where a.attrelid='public.sclad'::regclass and a.attname=date_column and a.attnum>0 and not a.attisdropped;
 if date_type is null then raise exception 'Unsupported stock date column';end if;
 execute format($query$
 with base as materialized (
  select s."scladNomer"::text warehouse,s.xto_zamovuv::text requester from public.sclad s
  where s.%1$I >= $2::%2$s and s.%1$I < $3::%2$s
   and public.traffic_shop_date(s.%1$I::text)>=$2 and public.traffic_shop_date(s.%1$I::text)<$3
   and not exists(select 1 from jsonb_array_elements_text(coalesce($1->'exclude','[]')) x where x=s.sclad_id::text)
 ), ids as (select distinct requester::bigint id from base where coalesce(requester,'')~'^[1-9][0-9]*$')
 select jsonb_build_object('warehouses',coalesce((select jsonb_agg(id order by id) from
  (select distinct warehouse::integer id from base where coalesce(warehouse,'')~'^[1-9][0-9]*$') w),'[]'),
 'requesters',coalesce((select jsonb_agg(jsonb_build_object('id',ids.id,
  'name',coalesce(public.traffic_json_object(s.data::jsonb)->>'Name','ID: '||ids.id)) order by ids.id)
  from ids left join public.slyusars s on s.slyusar_id=ids.id),'[]'))
 $query$,date_column,date_type) into result using p_filter,f,(t::date+1)::text;
 return result;
end $$;

create or replace function public.traffic_stock_accounting_page(
 p_filter jsonb,p_cursor jsonb default null,p_limit integer default 40,
 p_include_summary boolean default true,p_expected_revision text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; facets jsonb; filter_hash text:=md5(p_filter::text);
begin
 if p_limit is null or p_limit<1 or p_limit>200 or p_include_summary is null then raise exception 'Invalid stock accounting page';end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor->>'filter' is distinct from filter_hash
   or coalesce(p_cursor->>'id','')!~'^[1-9][0-9]*$' or coalesce(p_cursor->>'day','')!~'^\d{4}-\d{2}-\d{2}$'
   or p_expected_revision is null) then raise exception 'Invalid stock accounting cursor';end if;
 with filtered as materialized (select * from public.traffic_stock_accounting_rows(p_filter)),
 stamp as (select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) version from filtered),
 candidates as (
  select * from filtered where p_cursor is null or (sort_day,(row_data->>'sclad_id')::bigint)<(p_cursor->>'day',(p_cursor->>'id')::bigint)
  order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit+1
 ), page as (select * from candidates order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(row_data||jsonb_build_object('paymentFingerprint',public.traffic_stock_payment_fingerprint(row_data))
   order by sort_day desc,(row_data->>'sclad_id')::bigint desc) from page),'[]'),
  'has_more',(select count(*)>p_limit from candidates),
  'next_cursor',(select jsonb_build_object('day',sort_day,'id',row_data->'sclad_id','filter',filter_hash)
   from page order by sort_day,(row_data->>'sclad_id')::bigint limit 1),'revision',(select version from stamp))
  ||case when p_include_summary then jsonb_build_object('summary',
   (select jsonb_build_object('totalCount',count(*),'totalAmount',coalesce(sum(amount),0),
    'remainingAmount',coalesce(sum(remaining_amount),0),'payableCount',count(*) filter(where eligible),
    'payableAmount',coalesce(sum(amount) filter(where eligible),0),
    'payableBaseline',md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint) filter(where eligible),''))) from filtered)) else '{}'::jsonb end
 into result;
 if p_expected_revision is not null and result->>'revision' is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 if p_include_summary then
  facets:=public.traffic_stock_accounting_facets(p_filter);
  result:=result||jsonb_build_object('facets',facets);
 end if;
 return result;
end $$;


create or replace function public.traffic_profit_accounting_rows(p_filter jsonb,p_cursor jsonb default null)
returns setof jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare mode text:=coalesce(p_filter->>'mode','open'); from_day date; to_day date;
 act_column text; expense_column text; act_type text; expense_type text; act_predicate text; expense_predicate text;
begin
 if jsonb_typeof(p_filter) is distinct from 'object' or mode not in ('open','close','paid') then raise exception 'Invalid profit filter'; end if;
 if coalesce(p_filter->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_filter->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Select a valid profit date range'; end if;
 from_day:=(p_filter->>'from')::date; to_day:=(p_filter->>'to')::date;
 if from_day>to_day then raise exception 'Invalid profit date range'; end if;
 if coalesce(p_filter->>'payment','2') not in ('0','1','2') or coalesce(p_filter->>'type','2') not in ('0','1','2')
  or coalesce(p_filter->>'status','2') not in ('0','1','2') or coalesce(p_filter->>'discount','2') not in ('0','1','2') then raise exception 'Invalid profit switches'; end if;
 if jsonb_typeof(coalesce(p_filter->'exclude_ids','[]'::jsonb))<>'array' then raise exception 'Invalid hidden profit IDs'; end if;
 if exists(select 1 from jsonb_array_elements_text(coalesce(p_filter->'exclude_ids','[]'::jsonb)) id where id !~ '^-?[0-9]+$') then raise exception 'Invalid hidden profit IDs'; end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$') then raise exception 'Invalid profit cursor'; end if;
 act_column:=case mode when 'open' then 'date_on' when 'close' then 'date_off' else 'rosraxovano' end;
 expense_column:=case mode when 'paid' then 'dataOff' else 'dataOnn' end;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into act_type
  from pg_attribute where attrelid='public.acts'::regclass and attname=act_column and attnum>0 and not attisdropped;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into expense_type
  from pg_attribute where attrelid='public.vutratu'::regclass and attname=expense_column and attnum>0 and not attisdropped;
 if act_type is null or expense_type is null then raise exception 'Unsupported accounting date column'; end if;
 act_predicate:=case when act_type='timestamptz' then format('a.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and a.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',act_column,act_column)
  else format('a.%I >= $1::%s and a.%I < $2::%s',act_column,act_type,act_column,act_type) end;
 expense_predicate:=case when expense_type='timestamptz' then format('v.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and v.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',expense_column,expense_column)
  else format('v.%I >= $1::%s and v.%I < $2::%s',expense_column,expense_type,expense_column,expense_type) end;
 return query execute format($query$
 with acts as materialized (
  select a.act_id,a.client_id,a.cars_id,a.date_on,a.date_off,a.rosraxovano,a.xto_rozraxuvav,a.avans,a."tupOplatu",
   public.sto_read_object_v1(to_jsonb(a.data)) d,public.traffic_profit_accounting_day(a.date_on::text) AS day
  from public.acts a where %s
   and ($3->'payment_ids' is null or a.act_id in (select -(x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint<0))
 ), visible_acts as materialized (
  select * from acts where d->'Заморожений' is distinct from 'true'::jsonb
   and ($4 is null or (day,-act_id)<($4->>'date',($4->>'id')::bigint))
 ), staff as materialized (
  -- Parse each employee once; materialize histories only for receivers.
  select s.slyusar_id,parsed.d from public.slyusars s
  cross join lateral (select public.sto_read_object_v1(to_jsonb(s.data)) d offset 0) parsed
  where exists(select 1 from visible_acts) and parsed.d->>'Доступ'='Приймальник'
 ), salary_records as (
  select s.slyusar_id,h.key day_key,e.ord,public.traffic_profit_accounting_number(e.r->'Акт')::double precision act_id,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастин')::double precision parts,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаРоботи')::double precision work,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастистів')::double precision buyer
  from staff s cross join lateral jsonb_each(case when jsonb_typeof(s.d->'Історія')='object' then s.d->'Історія' else '{}'::jsonb end) h
   cross join lateral jsonb_array_elements(case when jsonb_typeof(h.value)='array' then h.value else '[]'::jsonb end) with ordinality e(r,ord)
  where s.d->>'Доступ'='Приймальник'
 ), salaries as (
  select s.act_id,sum(s.parts order by s.slyusar_id,s.day_key,s.ord) parts,sum(s.work order by s.slyusar_id,s.day_key,s.ord) work,sum(s.buyer order by s.slyusar_id,s.day_key,s.ord) buyer from salary_records s
   join visible_acts a on a.act_id=s.act_id where s.parts>0 or s.work>0 or s.buyer>0 group by s.act_id
 ), operands as (
  select a.*,public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за деталі')::double precision-coalesce(s.parts,0)-coalesce(s.buyer,0)) parts_profit,
   public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за роботу')::double precision-coalesce(s.work,0)) work_profit,
   public.traffic_profit_accounting_number(d->'За деталі')::double precision full_parts,public.traffic_profit_accounting_number(d->'За роботу')::double precision full_work,
   public.traffic_profit_accounting_number(d->'Знижка')::double precision discount_percent
  from visible_acts a left join salaries s on s.act_id=a.act_id
 ), act_rows as (
  select jsonb_build_object('id',-act_id,'date',day,'sortStamp',public.traffic_profit_accounting_stamp(date_on::text),'paymentDate',public.traffic_profit_accounting_day(date_off::text),'rosraxovanoDate',rosraxovano,
   'category','Прибуток','actNumber',act_id,'description','-','notes','-','amount',parts_profit::double precision+work_profit::double precision,'detailsAmount',parts_profit,'workAmount',work_profit,
   'paymentMethod',coalesce(to_jsonb(avans),'0'::jsonb),'isPaid',nullif(rosraxovano::text,'') is not null,'createdBy','Система',
   'clientId',client_id,'carId',cars_id,'xto_rozraxuvav',xto_rozraxuvav,'fullDetailsAmount',full_parts,'fullWorkAmount',full_work,'fullAmount',full_parts+full_work,
   'tupOplatu',"tupOplatu",'discount',discount_percent,'discountAmount',case when discount_percent>0 then public.traffic_profit_accounting_round((full_parts+full_work)*discount_percent/100,0,true) else 0 end) r
  from operands
 ), expenses as (
  select jsonb_build_object('id',v.vutratu_id,'date',public.traffic_profit_accounting_day(v."dataOnn"::text),'sortStamp',public.traffic_profit_accounting_stamp(v."dataOnn"::text),'paymentDate',public.traffic_profit_accounting_day(v."dataOff"::text),
   'rosraxovanoDate',v."dataOff",'category',coalesce(v.kategoria,''),'description',v.opys_vytraty,'amount',v.suma,
   'paymentMethod',coalesce(v.sposob_oplaty,''),'notes',coalesce(v.prymitky,''),'isPaid',nullif(v."dataOff"::text,'') is not null,'createdBy',v.xto_zapusav,'xto_rozraxuvav',v.xto_zapusav) r
  from public.vutratu v where v.suma<0 and v.act is null and %s
   and ($3->'payment_ids' is null or v.vutratu_id in (select (x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint>0))
   and ($4 is null or (public.traffic_profit_accounting_day(v."dataOnn"::text),v.vutratu_id)<($4->>'date',($4->>'id')::bigint))
 ), combined as (select r from act_rows union all select r from expenses)
 select r from combined where
  not exists(select 1 from jsonb_array_elements_text(coalesce($3->'exclude_ids','[]'::jsonb)) hidden where hidden::bigint=(r->>'id')::bigint)
  and
  (nullif($3->>'category','') is null or r->>'category'=$3->>'category')
  and (nullif($3->>'paymentMethod','') is null or case when r->>'category'='Прибуток' then position($3->>'paymentMethod' in coalesce(r->>'tupOplatu',''))>0 else r->>'paymentMethod'=$3->>'paymentMethod' end)
  and (coalesce($3->>'payment','2')='2' or (r->>'isPaid')::boolean=(($3->>'payment')='0'))
  and (coalesce($3->>'type','2')='2' or ((r->>'amount')::numeric>=0)=(($3->>'type')='0'))
  and (r->>'category'<>'Прибуток' or coalesce($3->>'status','2')='2' or (nullif(r->>'paymentDate','') is not null)=(($3->>'status')='0'))
  and (coalesce($3->>'discount','2')='2' or (($3->>'discount')='1' and coalesce((r->>'discountAmount')::numeric,0)>0)
   or (($3->>'discount')='0' and ((r->>'amount')::numeric<0 or coalesce((r->>'discountAmount')::numeric,0)<=0)))
 $query$,act_predicate,expense_predicate) using from_day::text,(to_day+1)::text,p_filter,p_cursor;
end $$;

revoke all on function public.traffic_accounting_canonical_id(text),
 public.traffic_shop_report_v3(jsonb,integer,integer),public.traffic_payroll_report_v3(jsonb,integer,boolean),
 public.write_payroll_report_payment_batch(jsonb),public.traffic_stock_accounting_facets(jsonb) from public;
grant execute on function public.traffic_accounting_canonical_id(text),
 public.traffic_shop_report_v3(jsonb,integer,integer),public.traffic_payroll_report_v3(jsonb,integer,boolean),
 public.write_payroll_report_payment_batch(jsonb),public.traffic_stock_accounting_facets(jsonb) to anon,authenticated;
notify pgrst,'reload schema';

-- SOURCE: 20261023081918_postgrest_resource_revisions.sql
-- Transactional change markers. SQL Editor only; no business-history migration.
-- One append per resource/transaction avoids a shared revision-row lock in
-- concurrent act/payroll writes. COUNT + MAX detects out-of-order commits.
-- This ledger grows with write transactions; monitor its size and manifest
-- latency. It is an indexed aggregate, not an O(1) counter. Never prune/reset
-- markers without changing the epoch in the SAME transaction.

create schema if not exists sto_traffic_private;
revoke all on schema sto_traffic_private from public;
grant usage on schema sto_traffic_private to anon,authenticated,service_role;

create table if not exists sto_traffic_private.resource_epochs (
 resource text primary key,
 epoch uuid not null default gen_random_uuid()
);
create table if not exists sto_traffic_private.resource_changes (
 resource text not null references sto_traffic_private.resource_epochs(resource),
 transaction_id bigint not null,
 sequence_id bigint generated always as identity,
 primary key(resource,transaction_id)
);
create index if not exists resource_changes_manifest_idx
 on sto_traffic_private.resource_changes(resource,sequence_id);
alter table sto_traffic_private.resource_epochs enable row level security;
alter table sto_traffic_private.resource_changes enable row level security;
revoke all on sto_traffic_private.resource_epochs,sto_traffic_private.resource_changes from public,anon,authenticated;
grant select on sto_traffic_private.resource_epochs,sto_traffic_private.resource_changes to anon,authenticated,service_role;
drop policy if exists resource_epochs_read on sto_traffic_private.resource_epochs;
create policy resource_epochs_read on sto_traffic_private.resource_epochs for select to anon,authenticated using(true);
drop policy if exists resource_changes_read on sto_traffic_private.resource_changes;
create policy resource_changes_read on sto_traffic_private.resource_changes for select to anon,authenticated using(true);

insert into sto_traffic_private.resource_epochs(resource)
select unnest(array['acts','clients','cars','works','details','slyusars','shops','sclad','vutratu','settings','whitelist','post_arxiv','post_name','post_category'])
on conflict(resource) do nothing;

create or replace function sto_traffic_private.touch_resource_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,sto_traffic_private as $$
begin
 insert into sto_traffic_private.resource_changes(resource,transaction_id)
 values(tg_table_name,txid_current()) on conflict(resource,transaction_id) do nothing;
 return null;
end $$;
revoke all on function sto_traffic_private.touch_resource_revision() from public,anon,authenticated,service_role;
do $$ declare resource_name text; begin
 for resource_name in select resource from sto_traffic_private.resource_epochs order by resource loop
  if to_regclass(format('public.%I',resource_name)) is not null then
   execute format('drop trigger if exists sto_traffic_resource_changed on public.%I',resource_name);
   execute format('create trigger sto_traffic_resource_changed after insert or update or delete or truncate on public.%I for each statement execute function sto_traffic_private.touch_resource_revision()',resource_name);
  end if;
 end loop;
end $$;

create or replace function public.traffic_resource_manifest(p_resources text[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_resources is null or cardinality(p_resources)>32 or exists(
  select 1 from unnest(p_resources) r where r is null or not exists(select 1 from sto_traffic_private.resource_epochs e where e.resource=r)
 ) then raise exception 'Unknown revision resource';end if;
 with requested as(select distinct unnest(p_resources) resource),
 dependencies as(select resource from requested union select 'settings' union select 'whitelist'),
 tokens as materialized (
  select e.resource,md5(e.epoch::text||':'||count(c.sequence_id)::text||':'||coalesce(max(c.sequence_id),0)::text) token
  from sto_traffic_private.resource_epochs e join dependencies d using(resource)
  left join sto_traffic_private.resource_changes c using(resource) group by e.resource,e.epoch
 ), scope as (
  select md5(jsonb_build_array(current_user,current_setting('request.jwt.claims',true),
   (select token from tokens where resource='settings'),(select token from tokens where resource='whitelist'))::text) token
 )
 select coalesce(jsonb_object_agg(t.resource,md5('resource-v1:'||t.token||':'||s.token)),'{}'::jsonb)
 into result from tokens t join requested r using(resource) cross join scope s;
 return result;
end $$;
create or replace function public.traffic_resource_revision(p_resources text[])
returns text language sql stable security invoker set search_path=pg_catalog,public as $$
 select md5(public.traffic_resource_manifest(p_resources)::text);
$$;
revoke all on function public.traffic_resource_manifest(text[]),public.traffic_resource_revision(text[]) from public;
grant execute on function public.traffic_resource_manifest(text[]),public.traffic_resource_revision(text[]) to anon,authenticated,service_role;
notify pgrst,'reload schema';

-- SOURCE: 20261023082222_service_history_compact_summaries.sql
-- Preserve legacy JS operands for unusual values; compress ordinary numeric histories.

create or replace function public.traffic_service_chart_data(p_data jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare original jsonb:=public.traffic_service_history_data(p_data,true); result jsonb:=original;
 k text; total_key text; operand jsonb; item jsonb; quantity double precision; price double precision; total double precision;
begin
 foreach k in array array['Роботи','Деталі'] loop
  total_key:=case when k='Роботи' then 'За роботу' else 'За деталі' end;
  operand:=original->total_key;
  -- Existing browser code chooses a truthy stored total before calculating rows.
  if operand is not null and operand<>'null'::jsonb and operand<>'false'::jsonb and operand<>'0'::jsonb and operand<>'""'::jsonb then
   result:=jsonb_set(result,array[k],'[]'::jsonb,true);
   continue;
  end if;
  total:=0;
  for item in select value from jsonb_array_elements(original->k) loop
   if (item->'Кількість' is not null and jsonb_typeof(item->'Кількість') not in ('number','null'))
     or (item->'Ціна' is not null and jsonb_typeof(item->'Ціна') not in ('number','null')) then
    -- String/boolean legacy coercion stays exactly in the existing browser path.
    return original;
   end if;
   quantity:=coalesce(nullif((item->>'Кількість')::double precision,0),1);
   price:=coalesce((item->>'Ціна')::double precision,0);
   total:=total+price*quantity;
  end loop;
  result:=jsonb_set(jsonb_set(result,array[total_key],to_jsonb(total),true),array[k],'[]'::jsonb,true);
 end loop;
 return result;
exception when numeric_value_out_of_range then return original;
end $$;
create or replace function public.traffic_service_history(
 p_car bigint,p_before jsonb default null,p_summary boolean default false)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
  select act_id,date_on,date_off,client_id,cars_id,
   case when p_summary then public.traffic_service_chart_data(data::jsonb) else public.traffic_service_history_data(data::jsonb,false) end data
  from public.acts where cars_id=p_car and (p_before is null
   or (p_before->>'date_on' is null and date_on is not null)
   or (date_on is null and p_before->>'date_on' is null and act_id<(p_before->>'act_id')::bigint)
   or date_on<(p_before->>'date_on')::timestamptz
   or (date_on=(p_before->>'date_on')::timestamptz and act_id<(p_before->>'act_id')::bigint))
  order by date_on desc nulls first,act_id desc limit case when p_summary then 201 else 51 end
 ), visible as (select * from page order by date_on desc nulls first,act_id desc limit case when p_summary then 200 else 50 end)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by date_on desc nulls first,act_id desc) from visible v),'[]'::jsonb),
  'has_more',(select count(*)>case when p_summary then 200 else 50 end from page),
  'next_cursor',(select jsonb_build_object('date_on',date_on,'act_id',act_id) from visible order by date_on asc nulls last,act_id asc limit 1));
$$;
revoke all on function public.traffic_service_chart_data(jsonb) from public;
grant execute on function public.traffic_service_chart_data(jsonb) to anon,authenticated;
notify pgrst,'reload schema';

-- SOURCE: 20261023082800_compact_settings_sms_np_context.sql
-- Edge request context only. No table, trigger, policy, or client-role grant changes.

-- Auth.getUser remains in the Edge handler on every request. Only service_role
-- may call this function with that verified Supabase identity.
create or replace function public.traffic_np_request_context(
 p_uid uuid,p_email text,p_mode text,p_employee bigint default null,p_name text default '',p_password text default '')
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare cfg jsonb; employee jsonb; verified record; employee_id bigint:=p_employee; role_name text; allowed boolean;
begin
 if p_uid is null or p_mode is null or p_mode not in ('discover','authenticate','session') then raise exception 'INVALID_CONTEXT';end if;
 if not exists(select 1 from public.whitelist where email=lower(coalesce(p_email,''))) then
  return jsonb_build_object('error','FORBIDDEN');end if;
 -- Denials are returned, so admitted password attempts retain their rate counter.
 if p_mode='authenticate' then
  if not public.np_online_rate('login:'||p_uid::text,5,300) then return jsonb_build_object('error','RATE_LIMIT');end if;
  select * into verified from public.verify_slyusar_password(p_name,p_password) limit 1;
  if not found or verified.is_valid is distinct from true then return jsonb_build_object('error','CREDENTIALS');end if;
  employee_id:=verified.slyusar_id;
 elsif p_mode='session' then
  if not public.np_online_rate('requests:'||p_uid::text,180,60) then return jsonb_build_object('error','RATE_LIMIT');end if;
 end if;
 select coalesce(novaposhta,'{}'::jsonb)-'_rate' into cfg from public.settings where setting_id=10;
 cfg:=coalesce(cfg,'{}'::jsonb);
 if p_mode='discover' then return jsonb_build_object('visible',coalesce(cfg#>array['access',coalesce(employee_id::text,'')]='true'::jsonb,false));end if;
 employee:=public.traffic_np_employee(employee_id);
 role_name:=coalesce(employee->>'role','');
 allowed:=case when cfg#>array['access',employee_id::text] is not null and cfg#>array['access',employee_id::text]<>'null'::jsonb
  then public.traffic_search_truthy(cfg#>array['access',employee_id::text]) else role_name in ('Адміністратор','Приймальник','Запчастист','Складовщик') end;
 if employee is null or (role_name<>'Адміністратор' and not coalesce(allowed,false)) then return jsonb_build_object('error','EMPLOYEE_FORBIDDEN');end if;
 return jsonb_build_object('actor',jsonb_build_object('id',employee_id,'name',coalesce(employee->>'name',''),'role',role_name),'config',cfg);
end $$;
revoke all on function public.traffic_np_request_context(uuid,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.traffic_np_request_context(uuid,text,text,bigint,text,text) to service_role;
notify pgrst,'reload schema';

-- SOURCE: 20261023083234_batch_import_scoped_traffic.sql
-- Excel import keeps its existing formulas and per-cell CAS, with bounded transport.

create or replace function public.traffic_batch_act_details(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare doc jsonb; projection jsonb;
begin
 select public.payroll_json_object(to_jsonb(data)) into doc from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into projection from jsonb_each(doc) where key=any(array['Деталі','За деталі','Загальна сума']);
 return jsonb_build_object('act_id',p_act_id,'data',projection,'checksum',md5(doc::text));
end $$;

create or replace function public.write_batch_act_details(p_act_id integer,p_checksum text,p_projection jsonb,p_revision text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; next_doc jsonb; saved jsonb;
begin
 if jsonb_typeof(p_projection) is distinct from 'object' or jsonb_typeof(p_projection->'Деталі') is distinct from 'array' or nullif(p_revision,'') is null then raise exception 'Некоректний пакет деталей';end if;
 if exists(select 1 from jsonb_object_keys(p_projection) k where k<>all(array['Деталі','За деталі','Загальна сума'])) then raise exception 'Недозволене поле акту';end if;
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if md5(doc::text) is distinct from p_checksum then raise exception 'Акт змінено. Повторіть синхронізацію деталей.' using errcode='40001';end if;
 next_doc:=doc||p_projection||jsonb_build_object('__act_revision',p_revision);
 -- This existing writer enforces closed/frozen guards and applies stock deltas atomically.
 saved:=public.write_act_with_stock(p_act_id,doc,next_doc,null);
 if saved is distinct from next_doc or saved is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then raise exception 'Не підтверджено запис деталей' using errcode='40001';end if;
 return jsonb_build_object('act_id',p_act_id,'revision',p_revision,'cars_id',a.cars_id,'status','updated');
end $$;

create or replace function public.write_batch_stock_cells(p_items jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; changes jsonb; expected jsonb; field text; assignments text; guards text; changed_count integer; receipts jsonb:='[]'::jsonb;
 allowed constant text[]:=array['time_on','shops','part_number','name','kilkist_on','price','client_price','rahunok','unit_measurement','akt','scladNomer','statys','prumitka','xto_zamovuv'];
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>100 then raise exception 'Некоректний пакет комірок';end if;
 if exists(select 1 from jsonb_array_elements(p_items) i group by i->>'key' having count(*)>1) or
    exists(select 1 from jsonb_array_elements(p_items) i group by i->>'id' having count(*)>1) then raise exception 'Повторна складська позиція у пакеті';end if;
 -- A per-row subtransaction retains the current partial-success behavior.
 for item in select value from jsonb_array_elements(p_items) order by (value->>'id')::bigint loop
  begin
   changes:=item->'changes';expected:=item->'expected';assignments:='';guards:='';
   if nullif(item->>'key','') is null or jsonb_typeof(changes) is distinct from 'object' or changes='{}'::jsonb or jsonb_typeof(expected) is distinct from 'object' then raise exception 'Некоректні комірки';end if;
   for field in select jsonb_object_keys(changes) order by 1 loop
    if not(field=any(allowed)) or not(expected ? field) then raise exception 'Неповний або недозволений знімок комірок';end if;
    assignments:=assignments||case when assignments='' then '' else ',' end||format('%I=(jsonb_populate_record(null::public.sclad,$1)).%I',field,field);
    guards:=guards||format(' and s.%I is not distinct from (jsonb_populate_record(null::public.sclad,$2)).%I',field,field);
   end loop;
   execute 'update public.sclad s set '||assignments||' where s.sclad_id=$3'||guards using changes,expected,(item->>'id')::bigint;
   get diagnostics changed_count=row_count;
   if changed_count<>1 then raise exception 'Комірки вже змінено іншим користувачем. Оновіть склад і повторіть редагування.' using errcode='40001';end if;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('key',item->>'key','id',item->'id','status','updated'));
  exception when others then
   receipts:=receipts||jsonb_build_array(jsonb_build_object('key',item->>'key','id',item->'id','status','error','message',sqlerrm));
  end;
 end loop;
 return receipts;
end $$;
revoke all on function public.traffic_batch_act_details(integer),public.write_batch_act_details(integer,text,jsonb,text),public.write_batch_stock_cells(jsonb) from public,anon;
grant execute on function public.traffic_batch_act_details(integer),public.write_batch_act_details(integer,text,jsonb,text),public.write_batch_stock_cells(jsonb) to authenticated,service_role;
notify pgrst,'reload schema';

-- SOURCE: 20261023083651_accounting_resource_revisions.sql
-- Report revisions use transactional resource markers; target payment baselines remain exact.
-- Requires 20261023081314 and 20261023081918. No financial formulas or RLS policies change.

create or replace function public.traffic_stock_accounting_page_rows(p_filter jsonb,p_cursor jsonb,p_limit integer)
returns table(row_data jsonb,sort_day text,amount numeric,remaining_amount numeric,eligible boolean)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f text:=p_filter->>'from'; t text:=p_filter->>'to'; mode text:=coalesce(p_filter->>'dateMode','open');
 date_column text; date_type text;
begin
 if p_limit is not null and (p_limit<1 or p_limit>201) then raise exception 'Invalid stock candidate limit';end if;
 if jsonb_typeof(p_filter) is distinct from 'object' or f is null or t is null
  or f!~'^\d{4}-\d{2}-\d{2}$' or t!~'^\d{4}-\d{2}-\d{2}$' or f::date>t::date
  or mode not in ('open','paid') or coalesce(p_filter->>'payment','2') not in ('0','1','2')
  or coalesce(p_filter->>'availability','4') not in ('0','1','2','3','4') then
  raise exception 'Invalid stock accounting filter';
 end if;
 if p_filter ? 'exclude' and (jsonb_typeof(p_filter->'exclude') is distinct from 'array' or jsonb_array_length(p_filter->'exclude')>2000) then
  raise exception 'Invalid excluded stock rows';
 end if;
 date_column:=case mode when 'paid' then 'rosraxovano' else 'time_on' end;
 select case a.atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz'
  when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into date_type
 from pg_attribute a where a.attrelid='public.sclad'::regclass and a.attname=date_column and a.attnum>0 and not a.attisdropped;
 if date_type is null then raise exception 'Unsupported stock date column';end if;
 -- Cast bounds to the actual column type, never the indexed date column.
 return query execute format($query$
 with base as (
  select to_jsonb(s) d,public.traffic_shop_date(case $4 when 'paid' then s.rosraxovano::text else s.time_on::text end) AS day
  from public.sclad s where s.%1$I >= $2::%2$s and s.%1$I < $3::%2$s
 ), prepared as (
  select d,day,coalesce(nullif(d->>'kilkist_on',''),'0')::numeric quantity,
   coalesce(nullif(d->>'kilkist_off',''),'0')::numeric used,coalesce(nullif(d->>'price',''),'0')::numeric price,
   nullif(d->>'rosraxovano','') is not null paid,nullif(d->>'povernennya','') is not null returned
  from base where day>=$2 and day<$3
   and ($5 is null or (day,(d->>'sclad_id')::bigint)<($5->>'day',($5->>'id')::bigint))
 ), selected as (
 select * from prepared
 where (nullif($1->>'shop','') is null or lower(btrim(coalesce(d->>'shops','')))=lower(btrim($1->>'shop')))
  and (nullif($1->>'bill','') is null or strpos(lower(coalesce(d->>'rahunok','')),lower($1->>'bill'))>0)
  and (nullif($1->>'item','') is null or strpos(lower(coalesce(d->>'name','')),lower($1->>'item'))>0)
  and (nullif($1->>'catalog','') is null or strpos(lower(coalesce(d->>'part_number','')),lower($1->>'catalog'))>0
   or (regexp_replace(lower(normalize($1->>'catalog',NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(coalesce(d->>'part_number',''),NFKC)),'[^[:alnum:]]','','g'),
     regexp_replace(lower(normalize($1->>'catalog',NFKC)),'[^[:alnum:]]','','g'))>0))
  and (coalesce($1->>'payment','2')='2' or paid=($1->>'payment'='0'))
  and (coalesce($1->>'availability','4')='4'
    or $1->>'availability'='0' and quantity-used>0
    or $1->>'availability'='1' and quantity-used=0
    or $1->>'availability'='2' and quantity-used<0
    or $1->>'availability'='3' and returned)
  and (nullif($1->>'warehouse','') is null or d->>'scladNomer'=$1->>'warehouse')
  and (nullif($1->>'requester','') is null or d->>'xto_zamovuv'=$1->>'requester')
  and not exists(select 1 from jsonb_array_elements_text(coalesce($1->'exclude','[]')) x where x=d->>'sclad_id')
 order by day desc,(d->>'sclad_id')::bigint desc limit $6
 )
 select (select jsonb_object_agg(key,value) from jsonb_each(d) where key=any(array[
   'sclad_id','time_on','shops','rahunok','akt','name','part_number','kilkist_on','kilkist_off','price',
   'rosraxovano','povernennya','xto_povernyv','scladNomer','xto_zamovuv']))||jsonb_build_object('requester_name',public.traffic_json_object(st.data::jsonb)->>'Name'),day,
   quantity*price,greatest(quantity-used,0)*price,not paid and not returned
 from selected left join public.slyusars st on st.slyusar_id=case when coalesce(d->>'xto_zamovuv','')~'^[1-9][0-9]*$' then (d->>'xto_zamovuv')::bigint end
 $query$,date_column,date_type) using p_filter,f,(t::date+1)::text,mode,p_cursor,p_limit;
end $$;

create or replace function public.traffic_stock_accounting_page(
 p_filter jsonb,p_cursor jsonb default null,p_limit integer default 40,
 p_include_summary boolean default true,p_expected_revision text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; facets jsonb; filter_hash text:=md5(p_filter::text); revision text;
begin
 if p_limit is null or p_limit<1 or p_limit>200 or p_include_summary is null then raise exception 'Invalid stock accounting page';end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor->>'filter' is distinct from filter_hash
   or coalesce(p_cursor->>'id','')!~'^[1-9][0-9]*$' or coalesce(p_cursor->>'day','')!~'^\d{4}-\d{2}-\d{2}$'
   or p_expected_revision is null) then raise exception 'Invalid stock accounting cursor';end if;
 revision:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 with filtered as materialized (select * from public.traffic_stock_accounting_page_rows(p_filter,
  case when p_include_summary then null else p_cursor end,case when p_include_summary then null else p_limit+1 end)),
 candidates as (
  select * from filtered where p_cursor is null or (sort_day,(row_data->>'sclad_id')::bigint)<(p_cursor->>'day',(p_cursor->>'id')::bigint)
  order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit+1
 ), page as (select * from candidates order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(row_data||jsonb_build_object('paymentFingerprint',public.traffic_stock_payment_fingerprint(row_data))
   order by sort_day desc,(row_data->>'sclad_id')::bigint desc) from page),'[]'),
  'has_more',(select count(*)>p_limit from candidates),
  'next_cursor',(select jsonb_build_object('day',sort_day,'id',row_data->'sclad_id','filter',filter_hash)
   from page order by sort_day,(row_data->>'sclad_id')::bigint limit 1),'revision',revision)
  ||case when p_include_summary then jsonb_build_object('summary',
   (select jsonb_build_object('totalCount',count(*),'totalAmount',coalesce(sum(amount),0),
    'remainingAmount',coalesce(sum(remaining_amount),0),'payableCount',count(*) filter(where eligible),
    'payableAmount',coalesce(sum(amount) filter(where eligible),0),
    'payableBaseline',md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint) filter(where eligible),''))) from filtered)) else '{}'::jsonb end
 into result;
 if p_expected_revision is not null and result->>'revision' is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 if p_include_summary then
  facets:=public.traffic_stock_accounting_facets(p_filter);
  result:=result||jsonb_build_object('facets',facets);
 end if;
 return result;
end $$;

create or replace function public.traffic_profit_accounting_rows(p_filter jsonb,p_cursor jsonb default null)
returns setof jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare mode text:=coalesce(p_filter->>'mode','open'); from_day date; to_day date;
 act_column text; expense_column text; act_type text; expense_type text; act_predicate text; expense_predicate text;
begin
 if jsonb_typeof(p_filter) is distinct from 'object' or mode not in ('open','close','paid') then raise exception 'Invalid profit filter'; end if;
 if coalesce(p_filter->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_filter->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Select a valid profit date range'; end if;
 from_day:=(p_filter->>'from')::date; to_day:=(p_filter->>'to')::date;
 if from_day>to_day then raise exception 'Invalid profit date range'; end if;
 if coalesce(p_filter->>'payment','2') not in ('0','1','2') or coalesce(p_filter->>'type','2') not in ('0','1','2')
  or coalesce(p_filter->>'status','2') not in ('0','1','2') or coalesce(p_filter->>'discount','2') not in ('0','1','2') then raise exception 'Invalid profit switches'; end if;
 if jsonb_typeof(coalesce(p_filter->'exclude_ids','[]'::jsonb))<>'array' then raise exception 'Invalid hidden profit IDs'; end if;
 if exists(select 1 from jsonb_array_elements_text(coalesce(p_filter->'exclude_ids','[]'::jsonb)) id where id !~ '^-?[0-9]+$') then raise exception 'Invalid hidden profit IDs'; end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$' or nullif(p_cursor->>'stamp','') is null) then raise exception 'Invalid profit cursor'; end if;
 act_column:=case mode when 'open' then 'date_on' when 'close' then 'date_off' else 'rosraxovano' end;
 expense_column:=case mode when 'paid' then 'dataOff' else 'dataOnn' end;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into act_type
  from pg_attribute where attrelid='public.acts'::regclass and attname=act_column and attnum>0 and not attisdropped;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into expense_type
  from pg_attribute where attrelid='public.vutratu'::regclass and attname=expense_column and attnum>0 and not attisdropped;
 if act_type is null or expense_type is null then raise exception 'Unsupported accounting date column'; end if;
 act_predicate:=case when act_type='timestamptz' then format('a.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and a.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',act_column,act_column)
  else format('a.%I >= $1::%s and a.%I < $2::%s',act_column,act_type,act_column,act_type) end;
 expense_predicate:=case when expense_type='timestamptz' then format('v.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and v.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',expense_column,expense_column)
  else format('v.%I >= $1::%s and v.%I < $2::%s',expense_column,expense_type,expense_column,expense_type) end;
 return query execute format($query$
 with acts as materialized (
  select a.act_id,a.client_id,a.cars_id,a.date_on,a.date_off,a.rosraxovano,a.xto_rozraxuvav,a.avans,a."tupOplatu",
   public.sto_read_object_v1(to_jsonb(a.data)) d,public.traffic_profit_accounting_day(a.date_on::text) AS day
  from public.acts a where %s
   and ($3->'payment_ids' is null or a.act_id in (select -(x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint<0))
 ), visible_acts as materialized (
  select * from acts where d->'Заморожений' is distinct from 'true'::jsonb
   and ($4 is null or (day,false,public.traffic_profit_accounting_stamp(date_on::text),act_id)<($4->>'date',($4->>'id')::bigint>0,$4->>'stamp',abs(($4->>'id')::bigint)))
 ), staff as materialized (
  -- Parse each employee once; materialize histories only for receivers.
  select s.slyusar_id,parsed.d from public.slyusars s
  cross join lateral (select public.sto_read_object_v1(to_jsonb(s.data)) d offset 0) parsed
  where exists(select 1 from visible_acts) and parsed.d->>'Доступ'='Приймальник'
 ), salary_records as (
  select s.slyusar_id,h.key day_key,e.ord,public.traffic_profit_accounting_number(e.r->'Акт')::double precision act_id,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастин')::double precision parts,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаРоботи')::double precision work,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастистів')::double precision buyer
  from staff s cross join lateral jsonb_each(case when jsonb_typeof(s.d->'Історія')='object' then s.d->'Історія' else '{}'::jsonb end) h
   cross join lateral jsonb_array_elements(case when jsonb_typeof(h.value)='array' then h.value else '[]'::jsonb end) with ordinality e(r,ord)
  where s.d->>'Доступ'='Приймальник'
 ), salaries as (
  select s.act_id,sum(s.parts order by s.slyusar_id,s.day_key,s.ord) parts,sum(s.work order by s.slyusar_id,s.day_key,s.ord) work,sum(s.buyer order by s.slyusar_id,s.day_key,s.ord) buyer from salary_records s
   join visible_acts a on a.act_id=s.act_id where s.parts>0 or s.work>0 or s.buyer>0 group by s.act_id
 ), operands as (
  select a.*,public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за деталі')::double precision-coalesce(s.parts,0)-coalesce(s.buyer,0)) parts_profit,
   public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за роботу')::double precision-coalesce(s.work,0)) work_profit,
   public.traffic_profit_accounting_number(d->'За деталі')::double precision full_parts,public.traffic_profit_accounting_number(d->'За роботу')::double precision full_work,
   public.traffic_profit_accounting_number(d->'Знижка')::double precision discount_percent
  from visible_acts a left join salaries s on s.act_id=a.act_id
 ), act_rows as (
  select jsonb_build_object('id',-act_id,'date',day,'sortStamp',public.traffic_profit_accounting_stamp(date_on::text),'paymentDate',public.traffic_profit_accounting_day(date_off::text),'rosraxovanoDate',rosraxovano,
   'category','Прибуток','actNumber',act_id,'description','-','notes','-','amount',parts_profit::double precision+work_profit::double precision,'detailsAmount',parts_profit,'workAmount',work_profit,
   'paymentMethod',coalesce(to_jsonb(avans),'0'::jsonb),'isPaid',nullif(rosraxovano::text,'') is not null,'createdBy','Система',
   'clientId',client_id,'carId',cars_id,'xto_rozraxuvav',xto_rozraxuvav,'fullDetailsAmount',full_parts,'fullWorkAmount',full_work,'fullAmount',full_parts+full_work,
   'tupOplatu',"tupOplatu",'discount',discount_percent,'discountAmount',case when discount_percent>0 then public.traffic_profit_accounting_round((full_parts+full_work)*discount_percent/100,0,true) else 0 end) r
  from operands
 ), expenses as (
  select jsonb_build_object('id',v.vutratu_id,'date',public.traffic_profit_accounting_day(v."dataOnn"::text),'sortStamp',public.traffic_profit_accounting_stamp(v."dataOnn"::text),'paymentDate',public.traffic_profit_accounting_day(v."dataOff"::text),
   'rosraxovanoDate',v."dataOff",'category',coalesce(v.kategoria,''),'description',v.opys_vytraty,'amount',v.suma,
   'paymentMethod',coalesce(v.sposob_oplaty,''),'notes',coalesce(v.prymitky,''),'isPaid',nullif(v."dataOff"::text,'') is not null,'createdBy',v.xto_zapusav,'xto_rozraxuvav',v.xto_zapusav) r
  from public.vutratu v where v.suma<0 and v.act is null and %s
   and ($3->'payment_ids' is null or v.vutratu_id in (select (x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint>0))
   and ($4 is null or (public.traffic_profit_accounting_day(v."dataOnn"::text),true,public.traffic_profit_accounting_stamp(v."dataOnn"::text),v.vutratu_id)<($4->>'date',($4->>'id')::bigint>0,$4->>'stamp',abs(($4->>'id')::bigint)))
 ), combined as (select r from act_rows union all select r from expenses)
 select r from combined where
  not exists(select 1 from jsonb_array_elements_text(coalesce($3->'exclude_ids','[]'::jsonb)) hidden where hidden::bigint=(r->>'id')::bigint)
  and
  (nullif($3->>'category','') is null or r->>'category'=$3->>'category')
  and (nullif($3->>'paymentMethod','') is null or case when r->>'category'='Прибуток' then position($3->>'paymentMethod' in coalesce(r->>'tupOplatu',''))>0 else r->>'paymentMethod'=$3->>'paymentMethod' end)
  and (coalesce($3->>'payment','2')='2' or (r->>'isPaid')::boolean=(($3->>'payment')='0'))
  and (coalesce($3->>'type','2')='2' or ((r->>'amount')::numeric>=0)=(($3->>'type')='0'))
  and (r->>'category'<>'Прибуток' or coalesce($3->>'status','2')='2' or (nullif(r->>'paymentDate','') is not null)=(($3->>'status')='0'))
  and (coalesce($3->>'discount','2')='2' or (($3->>'discount')='1' and coalesce((r->>'discountAmount')::numeric,0)>0)
   or (($3->>'discount')='0' and ((r->>'amount')::numeric<0 or coalesce((r->>'discountAmount')::numeric,0)<=0)))
 $query$,act_predicate,expense_predicate) using from_day::text,(to_day+1)::text,p_filter,p_cursor;
end $$;

create or replace function public.traffic_profit_accounting_page(p_filter jsonb,p_cursor jsonb default null,p_limit integer default 30,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare revision text; result jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'Invalid profit page size'; end if;
 if p_cursor is not null and (coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$' or nullif(p_cursor->>'stamp','') is null) then raise exception 'Invalid profit cursor'; end if;
 if p_cursor is not null and p_expected_revision is null then raise exception 'A profit cursor requires its revision'; end if;
 if p_summary and p_cursor is not null then raise exception 'Summary is only available on the first page'; end if;
 revision:=md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text);
 if p_expected_revision is not null and p_expected_revision is distinct from revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 with report as materialized (select r from public.traffic_profit_accounting_rows(p_filter,case when p_summary then null else p_cursor end) r),
 candidates as (select r from report where p_cursor is null or (r->>'date',(r->>'id')::bigint>0,r->>'sortStamp',abs((r->>'id')::bigint))<(p_cursor->>'date',(p_cursor->>'id')::bigint>0,p_cursor->>'stamp',abs((p_cursor->>'id')::bigint))
  order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit+1),
 page as (select r from candidates order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit),
 labelled as (
  select p.r || jsonb_build_object('paymentBaseline',public.traffic_profit_payment_baseline(p.r)) || case when coalesce((p_filter->>'include_client')::boolean,false) and p.r->>'category'='Прибуток' and c.d is not null then
   jsonb_build_object('clientLabel',jsonb_build_object('ПІБ',c.d->'ПІБ','Телефон',c.d->'Телефон','Джерело',c.d->'Джерело','Додаткові',c.d->'Додаткові')) else '{}'::jsonb end
   || case when coalesce((p_filter->>'include_car')::boolean,false) and p.r->>'category'='Прибуток' and a.d is not null then
   jsonb_build_object('carLabel',jsonb_build_object('Авто',a.d->'Авто','Номер авто',a.d->'Номер авто','Обʼєм',a.d->'Обʼєм','КодДВЗ',a.d->'КодДВЗ','Пальне',a.d->'Пальне')) else '{}'::jsonb end r
  from page p left join lateral (select public.sto_read_object_v1(to_jsonb(data)) d from public.clients where client_id=(p.r->>'clientId')::bigint and coalesce((p_filter->>'include_client')::boolean,false)) c on true
   left join lateral (select public.sto_read_object_v1(to_jsonb(data)) d from public.cars where cars_id=(p.r->>'carId')::bigint and coalesce((p_filter->>'include_car')::boolean,false)) a on true
 ), totals as (
  select count(*) count,coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc),0) amount,
   coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'<>'Прибуток'),0) negative,
   coalesce(sum(greatest(public.traffic_profit_accounting_number(r->'paymentMethod')::double precision,0) order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is null),0) advances,
   coalesce(sum((r->>'detailsAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "detailsProfit",
   coalesce(sum((r->>'workAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "workProfit",
   coalesce(sum((r->>'fullDetailsAmount')::double precision-case when (r->>'discountAmount')::double precision>0 and (r->>'fullAmount')::double precision>0 then (r->>'fullDetailsAmount')::double precision*((r->>'discountAmount')::double precision/(r->>'fullAmount')::double precision) else 0::double precision end order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "cashDetails",
   coalesce(sum((r->>'fullWorkAmount')::double precision-case when (r->>'discountAmount')::double precision>0 and (r->>'fullAmount')::double precision>0 then (r->>'fullWorkAmount')::double precision*((r->>'discountAmount')::double precision/(r->>'fullAmount')::double precision) else 0::double precision end order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "cashWork",
   coalesce(sum((r->>'discountAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) discount,
   count(*) filter(where not (r->>'isPaid')::boolean) "eligibleCount",
   coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where not (r->>'isPaid')::boolean),0) "eligibleAmount",
   md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) "eligibleBaseline"
  from report where p_summary
 )
 select jsonb_build_object('formula_version',1,'revision',revision,'rows',coalesce((select jsonb_agg(r order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) from labelled),'[]'::jsonb),
  'has_more',(select count(*)>p_limit from candidates),'next_cursor',(select jsonb_build_object('date',r->>'date','id',(r->>'id')::bigint,'stamp',r->>'sortStamp') from page order by r->>'date',((r->>'id')::bigint>0),r->>'sortStamp',abs((r->>'id')::bigint) limit 1))
  ||case when p_summary then jsonb_build_object('summary',(select to_jsonb(t) from totals t)) else '{}'::jsonb end into result;
 revision:=result->>'revision';
 if p_expected_revision is not null and p_expected_revision is distinct from revision then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 return result;
end $$;

create or replace function public.traffic_stock_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_paid_at text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare ids bigint[]; locked_ids bigint[]; baseline text; version text; n integer; converted public.sclad%rowtype;
begin
 if nullif(p_expected_revision,'') is null or coalesce(p_baseline,'')!~'^[0-9a-f]{32}$'
  or coalesce(p_paid_at,'')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid stock settlement';end if;
 version:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if version is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 select array_agg((row_data->>'sclad_id')::bigint order by (row_data->>'sclad_id')::bigint) into ids
  from public.traffic_stock_accounting_rows(p_filter) where eligible;
 if coalesce(cardinality(ids),0)=0 then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 select array_agg(sclad_id order by sclad_id) into locked_ids from
  (select sclad_id from public.sclad where sclad_id=any(ids) order by sclad_id for update) locked;
 if locked_ids is distinct from ids then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 -- Re-read after acquiring the locks: concurrent edits/deletions/settlements fail.
 select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) into baseline
  from public.traffic_stock_accounting_rows(p_filter) where eligible;
 version:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if baseline is distinct from p_baseline or version is distinct from p_expected_revision then
  raise exception 'ACCOUNTING_REPORT_STALE';end if;
 converted:=jsonb_populate_record(null::public.sclad,jsonb_build_object('rosraxovano',p_paid_at));
 update public.sclad set rosraxovano=converted.rosraxovano where sclad_id=any(ids) and rosraxovano is null and povernennya is null;
 get diagnostics n=row_count;
 if n<>cardinality(ids) then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 return jsonb_build_object('updatedCount',n);
end $$;

create or replace function public.traffic_profit_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_actor text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare captured bigint[]; baseline text; current_revision text; updated_count bigint:=0; changed bigint; stamp timestamp:=clock_timestamp() at time zone 'Europe/Kyiv';
begin
 if p_expected_revision is null or p_baseline is null or nullif(btrim(p_actor),'') is null then raise exception 'Missing payment baseline'; end if;
 select md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text),
  coalesce(array_agg((r->>'id')::bigint order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'{}'::bigint[]),
  md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) into current_revision,captured,baseline
  from public.traffic_profit_accounting_rows(p_filter) r;
 if current_revision is distinct from p_expected_revision or baseline is distinct from p_baseline then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 perform act_id from public.acts where -act_id=any(captured) order by act_id for update;
 perform vutratu_id from public.vutratu where vutratu_id=any(captured) order by vutratu_id for update;
 -- The second snapshot validates the confirmed financial inputs after row locks.
 -- Only captured IDs are paid; unrelated/new rows are never added by UPDATE.
 select md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text),
  md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) into current_revision,baseline
  from public.traffic_profit_accounting_rows(p_filter) r;
 if current_revision is distinct from p_expected_revision or baseline is distinct from p_baseline then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 update public.acts set rosraxovano=stamp,xto_rozraxuvav=p_actor where -act_id=any(captured) and nullif(rosraxovano::text,'') is null;
 get diagnostics changed=row_count; updated_count:=updated_count+changed;
 update public.vutratu set "dataOff"=stamp where vutratu_id=any(captured) and nullif("dataOff"::text,'') is null;
 get diagnostics changed=row_count; updated_count:=updated_count+changed;
 if updated_count<>cardinality(captured) then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 return jsonb_build_object('updated_count',updated_count);
end $$;

revoke all on function public.traffic_stock_accounting_page_rows(jsonb,jsonb,integer) from public;
grant execute on function public.traffic_stock_accounting_page_rows(jsonb,jsonb,integer) to anon,authenticated;

create or replace function public.traffic_payroll_report_v4(
 p_filters jsonb,p_offset integer default 0,p_options boolean default true,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
 result jsonb; revision text;
 page_size integer:=greatest(1,least(200,case when coalesce(p_filters->>'page_size','')~'^[0-9]{1,3}$' then (p_filters->>'page_size')::integer else 50 end));
 selected_name text:=coalesce(p_filters->>'name','');
 mode text:=coalesce(p_filters->>'mode','open');
 from_day text:=public.traffic_payroll_iso(p_filters->>'from');
 to_day text:=public.traffic_payroll_iso(p_filters->>'to');
begin
 if p_summary is null or (not p_summary and p_expected_revision is null) then raise exception 'Missing payroll report revision';end if;
 revision:=md5(public.traffic_resource_revision(array['slyusars','acts'])||':'||(p_filters-'page_size')::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 if mode not in ('open','close','paid') then raise exception 'Невідомий режим дат';end if;
 if to_day='' then raise exception 'Потрібна кінцева дата звіту';end if;
 -- Keep validation global: a duplicate outside the date window must still block payment.
 perform public.traffic_payroll_validate(public.payroll_json_object(to_jsonb(s.data)))
 from public.slyusars s
 where selected_name='' or public.payroll_json_object(to_jsonb(s.data))->>'Name'=selected_name;

 with employee_docs as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) doc from public.slyusars s
 ), employees as materialized (
  select * from employee_docs where selected_name='' or doc->>'Name'=selected_name
 ), history_days as materialized (
  select e.id,e.doc->>'Name' name,e.doc->'ПроцентРоботи' percent,
   h.key history_day,h.value bucket,public.traffic_payroll_iso(h.key) history_iso
  from employees e cross join lateral jsonb_each(coalesce(nullif(e.doc->'Історія','null'::jsonb),'{}'::jsonb)) h
 ), selected_days as materialized (
  -- Opening dates belong to history buckets. Filter them before expanding acts or works.
  select * from history_days where mode<>'open' or
   (history_iso<>'' and (from_day='' or history_iso>=from_day) and history_iso<=to_day)
 ), raw_entries as materialized (
  select d.id,d.name,d.percent,d.history_day,d.history_iso,x.value entry,x.ordinality entry_order,
   x.value->>'Акт' act,
   -- Cast the history value, never the indexed acts.act_id. Canonical text matching
   -- retains the old behavior for malformed, padded or out-of-range legacy IDs.
   case when x.value->>'Акт' ~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$' then
    case when (x.value->>'Акт')::numeric between -9223372036854775808 and 9223372036854775807
     then (x.value->>'Акт')::bigint end end act_number
  from selected_days d cross join lateral jsonb_array_elements(d.bucket) with ordinality x
 ), act_ids as materialized (
  select distinct act_number from raw_entries where act_number is not null
 ), act_docs as materialized (
  -- Parse each referenced act once, even if several employees worked on it.
  select a.act_id,a.date_off,parsed.doc->'Заморожений'='true'::jsonb frozen,
   parsed.doc->'__payroll_pending'='true'::jsonb pending
  from act_ids i join public.acts a on a.act_id=i.act_number
  -- Keep one evaluation of the parser, but materialize only two flags, not act JSON.
  cross join lateral (select public.payroll_json_object(to_jsonb(a.data)) doc offset 0) parsed
 ), entries as materialized (
  select r.*,a.act_id existing_act_id,a.date_off,
   a.frozen,a.pending,
   case when a.act_id is not null then coalesce(a.date_off::text,'') else coalesce(r.entry->>'ДатаЗакриття','') end close_day,
   case when a.act_id is not null then a.date_off is not null else coalesce(r.entry->>'ДатаЗакриття','')<>'' end closed
  from raw_entries r left join act_docs a on a.act_id=r.act_number
 ), scoped_entries as materialized (
  -- Closing dates cannot be inferred from opening dates. Filter their effective
  -- act/legacy date after the join, but still before expanding works.
  select * from entries where not coalesce(frozen,false) and
   (mode<>'close' or (public.traffic_payroll_iso(close_day)<>''
    and (from_day='' or public.traffic_payroll_iso(close_day)>=from_day)
    and public.traffic_payroll_iso(close_day)<=to_day))
 ), expanded as (
  select e.*,case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0 then 'work'
   when entry?'СуммаРоботи' then 'receiver' when entry?'СуммаЗапчастин' then 'parts' else 'unknown' end kind,
   r.value row_data,r.ordinality::integer-1 work_index
  from scoped_entries e cross join lateral jsonb_array_elements(
   case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0
    then entry->'Записи' else '[null]'::jsonb end) with ordinality r
 ), dated_rows as (
  select e.*,d.paid_day,d.payment_summary,
   case when kind='work' then coalesce(row_data->>'Робота','') when kind='receiver' then '-' else 'Запчастини' end work,
   case when mode='paid' then d.payment_summary->>'paidIso'
    when mode='close' then public.traffic_payroll_iso(close_day) else history_iso end filter_day
  from expanded e cross join lateral (
   select payment_summary,payment_summary->>'paidDate' paid_day from (
    select public.traffic_payroll_payment_summary(
     case when kind='work' then row_data else entry end,
     case when kind='work' then entry else null end,from_day,to_day) payment_summary offset 0
   ) calculated
  ) d
  where kind<>'unknown' and not(kind='work' and coalesce(row_data->'Кількість'='0'::jsonb,false)
   and not public.traffic_search_truthy(row_data->'Зарплата')
   and not coalesce((d.payment_summary->>'hasPayment')::boolean,false))
 ), value_rows as materialized (
  -- Store scalar report values only. Do not copy the complete act/work JSON into
  -- every expanded row of the materialized totals/sort pipeline.
  select id,name,percent,history_day,history_iso,entry_order,act,existing_act_id,date_off,closed,pending,
   kind,work_index,paid_day,work,
   (payment_summary->>'earned')::double precision earned,
   (payment_summary->>'paidAmount')::double precision paid_amount,
   (payment_summary->>'due')::double precision due,
   (payment_summary->>'overpaid')::double precision overpaid,
   (payment_summary->>'paidInPeriod')::double precision paid_period,
   (payment_summary->>'hasPayment')::boolean has_payment,
   coalesce(public.traffic_search_number(row_data->'Ціна'),0)*coalesce(public.traffic_search_number(row_data->'Кількість'),0) work_total,
   coalesce(public.traffic_search_number(row_data->'Зарплата'),0) work_salary,
   coalesce(public.traffic_search_number(entry->'СуммаРоботи'),0) work_sum,
   coalesce(public.traffic_search_number(entry->'СуммаЗапчастин'),0) parts_sum,
   coalesce(public.traffic_search_number(entry->'ЗарплатаРоботи'),0) receiver_work_salary,
   coalesce(public.traffic_search_number(entry->'ЗарплатаЗапчастин'),0) parts_salary
  from dated_rows where filter_day<>'' and (from_day='' or filter_day>=from_day) and filter_day<=to_day
 ), date_matches as materialized (
  select *,case when kind='work' then work_total when kind='receiver' then work_sum+parts_sum else parts_sum end revenue,
   earned salary
  from value_rows
 ), matches as materialized (
  select * from date_matches where
   (coalesce(p_filters->>'act','')='' or act=p_filters->>'act')
   and (coalesce(p_filters->>'work','')='' or strpos(lower(work),lower(p_filters->>'work'))>0)
   and (coalesce(p_filters->>'payment','all')='all'
    or (p_filters->>'payment'='paid' and has_payment and due=0)
    or (p_filters->>'payment'='unpaid' and due>0))
   and (coalesce(p_filters->>'status','all')='all' or (p_filters->>'status'='closed' and closed) or (p_filters->>'status'='open' and not closed))
   and (coalesce(p_filters->>'percentage','all')='all' or (kind='work' and salary<>0 and coalesce(public.traffic_search_number(percent),0)<>0 and
    case when p_filters->>'percentage'='higher' then (case when revenue>0 then salary/revenue*100 else 0 end)>public.traffic_search_number(percent)
     else (case when revenue>0 then salary/revenue*100 else 0 end)<public.traffic_search_number(percent) end))
 ), candidates as materialized (
  select *,coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) sort_act,
   case when mode='paid' then public.traffic_payroll_iso(paid_day) else history_iso end sort_day
  from matches order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index
  offset greatest(coalesce(p_offset,0),0) limit page_size+1
 ), page as materialized (
  select * from candidates order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index limit page_size
 ), page_entries as (
  -- Preserve exact selected targets for payment CAS; omit all sibling works.
  -- Original array indices are explicit, so old records without IDs remain guarded.
  select p.id,p.name,p.percent,p.history_day,p.entry_order,
   (r.entry-'Записи') || case when bool_or(p.kind='work') then jsonb_build_object(
    'Записи',jsonb_agg(r.entry->'Записи'->p.work_index order by p.work_index),
    '__report_work_indexes',jsonb_agg(p.work_index order by p.work_index))
   else case when r.entry?'Записи' then jsonb_build_object('Записи',r.entry->'Записи') else '{}'::jsonb end end
   ||jsonb_build_object('__report_entry_revision',md5(r.entry::text)) entry
  from page p join raw_entries r on r.id=p.id and r.history_day=p.history_day and r.entry_order=p.entry_order
  group by p.id,p.name,p.percent,p.history_day,p.entry_order,r.entry
 ), histories as (
  select id,name,percent,history_day,jsonb_agg(entry order by entry_order) entries
  from page_entries group by id,name,percent,history_day
 ), rows as (
  select id,jsonb_build_object('slyusar_id',id,'data',jsonb_build_object('Name',name,'ПроцентРоботи',percent,'Історія',jsonb_object_agg(history_day,entries))) row
  from histories group by id,name,percent
 ), totals as (
  select count(*) total,coalesce(sum(revenue),0) revenue,coalesce(sum(salary),0) salary,
   coalesce(sum(paid_amount),0) paid_amount,coalesce(sum(due),0) due,
   coalesce(sum(overpaid),0) overpaid,coalesce(sum(paid_period),0) paid_period from matches where p_summary
 )
 select jsonb_build_object(
  'format_version',4,'revision',revision,'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
  'keys',coalesce((select jsonb_agg(jsonb_build_array(id,history_day,act,case when kind='work' then work_index else null end)
   order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index) from page),'[]'::jsonb),
  'statuses',coalesce((select jsonb_agg(jsonb_build_object('actId',id,'dateOff',date_off,'isClosed',closed,'isFrozen',false,'payrollPending',pending))
   from (select distinct existing_act_id::text id,date_off,closed,pending from page where existing_act_id is not null)s),'[]'::jsonb),
  'page_size',page_size,'total',t.total,'revenue',t.revenue,'salary',t.salary,
  'paidAmount',t.paid_amount,'due',t.due,'overpaid',t.overpaid,'paidInPeriod',t.paid_period,
  'has_more',(select count(*)>page_size from candidates),
  'acts',case when coalesce(p_options,true) then coalesce((select jsonb_agg(act order by coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) desc)
   from(select distinct act from date_matches)a),'[]'::jsonb) else '[]'::jsonb end,
  'works',case when coalesce(p_options,true) then coalesce((select jsonb_agg(work order by work)
   from(select distinct work from date_matches order by work limit 150)w),'[]'::jsonb) else '[]'::jsonb end
 ) into result from totals t;
 if not p_summary then result:=result-array['total','revenue','salary','paidAmount','due','overpaid','paidInPeriod'];end if;
 return result;
end $$;

create or replace function public.traffic_shop_report_v4(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; revision text;
begin
 if p_summary is null or (not p_summary and p_expected_revision is null) then raise exception 'Missing shop report revision';end if;
 revision:=md5(public.traffic_resource_revision(array['shops','acts','sclad','slyusars'])||':'||p_filter::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 if nullif(p_filter->>'from','') is null or nullif(p_filter->>'to','') is null then raise exception 'Встановіть період звіту';end if;
 if p_offset<0 or p_limit<1 or p_limit>200 then raise exception 'Invalid report page'; end if;
 with shops as materialized (
  select shop_id,public.sto_read_object_v1(to_jsonb(data)) body from public.shops
 ), history_days as materialized (
  select s.shop_id,s.body->>'Name' shop,h.key date_open,h.value bucket
  from shops s cross join lateral jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) h
  where public.traffic_search_truthy(s.body->'Name') and
   (coalesce(p_filter->>'dateMode','open')<>'open' or
    (public.traffic_shop_date(h.key)<>'' and public.traffic_shop_date(h.key)>=p_filter->>'from'
     and public.traffic_shop_date(h.key)<=p_filter->>'to'))
 ), history as materialized (
  select h.shop_id,h.shop,h.date_open,e.entry,e.ord entry_ord
  from history_days h cross join lateral jsonb_array_elements(case when jsonb_typeof(h.bucket)='array' then h.bucket else '[]'::jsonb end) with ordinality e(entry,ord)
 ), raw as (
  select h.shop_id,h.shop,h.date_open,h.entry_ord,h.entry-'Деталі' entry,d.detail,d.detail_ord,a.act_id,a.date_off,
   public.sto_read_object_v1(to_jsonb(a.data)) act_body,
   n.sclad_id stock_id,to_jsonb(n) stock_row,public.sto_read_object_v1(to_jsonb(n)->'data') stock_body
  from history h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.entry->'Деталі')='array' then h.entry->'Деталі' else '[]'::jsonb end) with ordinality d(detail,detail_ord)
  left join public.acts a on a.act_id=public.traffic_accounting_canonical_id(h.entry->>'Акт')
  left join public.sclad n on n.sclad_id=public.traffic_accounting_canonical_id(d.detail->>'sclad_id')
 ), values_normalized as (
  select *,coalesce(public.traffic_search_number(detail->'Кількість'),0) quantity,
   coalesce(public.traffic_search_number(detail->'Ціна'),0) price,
   case when stock_id is not null then coalesce(public.traffic_search_number(
    case when stock_body ? 'price' then stock_body->'price'
     when jsonb_typeof(stock_row->'data')='string' and stock_body<>'{}'::jsonb then '0'::jsonb
     else stock_row->'price' end),0) end purchase_price,
   public.traffic_search_number(coalesce(stock_body->'scladNomer',stock_row->'scladNomer')) warehouse,
   greatest(coalesce(public.traffic_search_number(act_body->'Знижка'),0),0) discount,
   case when act_id is not null then coalesce(date_off::text,'') else coalesce(entry->>'ДатаЗакриття','') end date_close,
   public.traffic_search_truthy(case when detail ? 'Розраховано' then detail->'Розраховано' else entry->'Розрахунок' end) is_paid,
   coalesce(case when detail ? 'Розраховано' then detail->>'Розраховано' else entry->>'Розрахунок' end,'') payment_date,
   coalesce(detail->>'Найменування','') item,coalesce(detail->>'Каталог','') catalog
  from raw
 ), calculated as (
  select *,quantity*price total,
   case when purchase_price is not null then price*(case when discount>0 then 1-discount/100 else 1 end)*quantity-purchase_price*quantity end margin,
   case coalesce(p_filter->>'dateMode','open') when 'close' then date_close when 'paid' then payment_date else date_open end target_date
  from values_normalized
 ), matches as materialized (
  select *,public.traffic_shop_date(target_date) sort_date from calculated
  where (coalesce(p_filter->>'dateMode','open')='open' or target_date<>'')
   and (coalesce(p_filter->>'from','')='' and coalesce(p_filter->>'to','')='' or
    public.traffic_shop_date(target_date)<>'' and
    (coalesce(p_filter->>'from','')='' or public.traffic_shop_date(target_date)>=p_filter->>'from') and
    (coalesce(p_filter->>'to','')='' or public.traffic_shop_date(target_date)<=p_filter->>'to'))
   and (coalesce(p_filter->>'item','')='' or strpos(lower(item),lower(p_filter->>'item'))>0)
   and (coalesce(p_filter->>'catalog','')='' or strpos(lower(catalog),lower(p_filter->>'catalog'))>0 or
    regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(catalog,NFKC)),'[^[:alnum:]]','','g'),regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g'))>0)
   and (coalesce(p_filter->>'status','all')='all' or (p_filter->>'status'='closed')=(date_close<>''))
   and (coalesce(p_filter->>'payment','all')='all' or (p_filter->>'payment'='paid')=is_paid)
 ), filtered as materialized (
  select * from matches where p_filter->>'warehouse' is null or warehouse=public.traffic_search_number(p_filter->'warehouse')
 ), candidates as materialized (
  select * from filtered order by sort_date desc,shop_id,date_open,entry_ord,detail_ord offset p_offset limit p_limit+1
 ), page as materialized (
  select * from candidates order by sort_date desc,shop_id,date_open,entry_ord,detail_ord limit p_limit
 )
 select jsonb_build_object(
  'revision',revision,'has_more',(select count(*)>p_limit from candidates),
  'items',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'rowId',concat(shop_id,':',date_open,':',entry_ord,':',detail_ord),'shopId',shop_id,
   'entryOrdinal',entry_ord,'detailOrdinal',detail_ord,'recordId',detail->>'recordId',
   'paymentFingerprint',encode(sha256(convert_to((detail-'Розраховано')::text,'UTF8')),'hex'),
   'dateOpen',date_open,'dateClose',date_close,'act',entry->>'Акт','automobile',coalesce(entry->>'Автомобіль',''),
   'shop',shop,'item',item,'catalog',catalog,'quantity',quantity,'price',price,'purchasePrice',purchase_price,
   'total',total,'margin',margin,'discountPercent',discount,'isPaid',is_paid,'paymentDate',payment_date,
   'sclad_id',stock_id,'scladNomer',warehouse,'isClosed',date_close<>'',
   'zapchastystName',(select public.sto_read_object_v1(to_jsonb(s.data))->>'Name' from public.slyusars s
    where s.slyusar_id=public.traffic_accounting_canonical_id(coalesce(stock_body->>'xto_zamovuv',stock_row->>'xto_zamovuv')))
  )) order by sort_date desc,shop_id,date_open,entry_ord,detail_ord) from page),'[]'::jsonb),
  'shops','[]'::jsonb,
  'totalCount',(select count(*) from filtered where p_summary),
  'totals',(select jsonb_build_object('sale',coalesce(sum(total),0),'purchase',coalesce(sum(coalesce(purchase_price,0)*quantity),0),'margin',coalesce(sum(margin),0)) from filtered where p_summary),
  'warehouses',coalesce((select jsonb_agg(w order by w) from (select distinct warehouse w from matches where p_summary and warehouse<>0) x),'[]'::jsonb)
 ) into result;
 if not p_summary then result:=result-array['totalCount','totals','warehouses'];end if;
 return result;
end $$;

revoke all on function public.traffic_payroll_report_v4(jsonb,integer,boolean,boolean,text),public.traffic_shop_report_v4(jsonb,integer,integer,boolean,text) from public;
grant execute on function public.traffic_payroll_report_v4(jsonb,integer,boolean,boolean,text),public.traffic_shop_report_v4(jsonb,integer,integer,boolean,text) to anon,authenticated;
notify pgrst,'reload schema';
-- END POSTGREST OPTIMIZATION 2026-10-23

notify pgrst, 'reload schema';
commit;

-- Atlas: local Cron gate, private evaluation leases, compact SQL comparisons,
-- durable per-recipient app delivery. Install SQL before the matching Edge code.
begin;

create schema if not exists sto_atlas_private;
revoke all on schema sto_atlas_private from public,anon,authenticated;
create table if not exists sto_atlas_private.evaluations (
 reminder_id bigint primary key references public.atlas_reminders(reminder_id) on delete cascade,
 token text, generation integer, lease_until timestamptz
);
revoke all on sto_atlas_private.evaluations from public,anon,authenticated;
-- Preserve leases that were already running during installation.
insert into sto_atlas_private.evaluations
 select reminder_id,evaluation_token,evaluation_generation,evaluation_lease_until
 from public.atlas_reminders where evaluation_token is not null
 on conflict(reminder_id) do nothing;

create or replace function public.claim_reminder_evaluation(p_reminder_id bigint,p_expected_trigger integer)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;t text;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or coalesce(r.trigger_count,0)<>p_expected_trigger then return null;end if;
 if exists(select 1 from sto_atlas_private.evaluations where reminder_id=p_reminder_id and lease_until>clock_timestamp()) then return null;end if;
 t:=gen_random_uuid()::text;
 insert into sto_atlas_private.evaluations values(p_reminder_id,t,p_expected_trigger,clock_timestamp()+interval '90 seconds')
 on conflict(reminder_id) do update set token=excluded.token,generation=excluded.generation,lease_until=excluded.lease_until;
 return t;
end $$;
create or replace function public.finish_reminder_evaluation(p_reminder_id bigint,p_token text,p_success boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update sto_atlas_private.evaluations set lease_until=clock_timestamp()+case when p_success then interval '55 seconds' else interval '0 seconds' end
 where reminder_id=p_reminder_id and token=p_token;
 return found;
end $$;
revoke all on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) to service_role;

-- SQL results are compared in Postgres; unchanged results never cross HTTP.
-- Keep the existing SELECT validator, including its authorization and errors.
create or replace function public.traffic_reminder_condition(p_query text,p_previous_hash text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb; fingerprint text;
begin
 result:=public.execute_condition_query(p_query);
 fingerprint:='pg-md5:'||md5(coalesce(result::text,'null'));
 if fingerprint=p_previous_hash then return jsonb_build_object('unchanged',true,'hash',fingerprint);end if;
 return jsonb_build_object('unchanged',false,'hash',fingerprint,'rows',result);
end $$;
revoke all on function public.traffic_reminder_condition(text,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_condition(text,text) to service_role;

-- Metadata patches cannot overwrite a rule edited while a condition was running.
create or replace function public.traffic_reminder_checkpoint(p_reminder_id bigint,p_token text,p_rule jsonb,p_patch jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if jsonb_typeof(p_patch)<>'object' then raise exception 'Invalid reminder patch';end if;
 update public.atlas_reminders r set meta=coalesce(r.meta,'{}'::jsonb)||p_patch
 where r.reminder_id=p_reminder_id and r.status not in ('paused','cancelled')
 and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=p_rule
 and exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=r.reminder_id and e.token=p_token and e.lease_until>clock_timestamp())
 and (coalesce(r.meta,'{}'::jsonb)||p_patch) is distinct from r.meta;
 return found;
end $$;
revoke all on function public.traffic_reminder_checkpoint(bigint,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.traffic_reminder_checkpoint(bigint,text,jsonb,jsonb) to service_role;

-- A stale worker must never advance a rule that was edited while it ran.
-- Schedule advancement and the result baseline commit in one transaction/RPC.
create or replace function public.traffic_reminder_complete(p_reminder_id bigint,p_token text,p_expected_trigger integer,p_rule jsonb,p_patch jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' then return false;end if;
 if not exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=p_reminder_id and e.token=p_token and e.lease_until>clock_timestamp()) then return false;end if;
 if jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel) is distinct from p_rule then return false;end if;
 if public.traffic_atlas_object(to_jsonb(r.schedule))->>'type' is distinct from 'realtime' then
  if coalesce(r.trigger_count,0)<>p_expected_trigger then return false;end if;
  perform public.trigger_reminder(p_reminder_id);
 end if;
 if p_patch<>'{}'::jsonb then perform public.traffic_reminder_checkpoint(p_reminder_id,p_token,p_rule,p_patch);end if;
 return true;
end $$;
create or replace function public.traffic_reminder_convert_rule(p_reminder_id bigint,p_token text,p_rule jsonb,p_query text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.atlas_reminders r set condition_query=p_query,schedule='{"type":"realtime"}',next_trigger_at=null,
  meta=coalesce(r.meta,'{}'::jsonb)||jsonb_build_object('condition_mode','server_realtime_sql','converted_from_json_realtime',true,'original_realtime_rule',r.condition_query)
 where r.reminder_id=p_reminder_id and r.status='active'
 and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=p_rule
 and exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=r.reminder_id and e.token=p_token and e.lease_until>clock_timestamp());
 return found;
end $$;
revoke all on function public.traffic_reminder_complete(bigint,text,integer,jsonb,jsonb),public.traffic_reminder_convert_rule(bigint,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_complete(bigint,text,integer,jsonb,jsonb),public.traffic_reminder_convert_rule(bigint,text,jsonb,text) to service_role;

create or replace function public.traffic_reminder_candidates(p_after bigint default null,p_at timestamptz default now())
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 with candidates as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.recipients,r.channel,r.priority,r.condition_query,
   r.schedule,r.trigger_count,r.created_by,coalesce(s.data->>'Name','—') creator_name,
   jsonb_strip_nulls(jsonb_build_object('condition_mode',r.meta->'condition_mode','last_result_hash',r.meta->'last_result_hash','last_delivery_generation',r.meta->'last_delivery_generation')) meta,r.next_trigger_at
  from public.atlas_reminders r left join public.slyusars s on s.slyusar_id=r.created_by
  left join sto_atlas_private.evaluations e on e.reminder_id=r.reminder_id
  where r.status='active' and (p_after is null or r.reminder_id>p_after)
   and (e.lease_until is null or e.lease_until<=p_at)
   and ((r.next_trigger_at is not null and r.next_trigger_at<=p_at) or
    (r.reminder_type='conditional' and r.condition_query is not null and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
     and (r.channel<>'app' or left(ltrim(r.condition_query),1)<>'{')))
  order by r.reminder_id limit 201
 ), page as(select * from candidates order by reminder_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(reminder_id) from page));
$$;
revoke all on function public.traffic_reminder_candidates(bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.traffic_reminder_candidates(bigint,timestamptz) to service_role;

-- Payload is sent only for actual occurrences, not on every background check.
alter table public.atlas_reminder_logs add column if not exists app_payload jsonb;
create index if not exists atlas_app_inbox_pending on public.atlas_reminder_logs(recipient_id,log_id)
 where channel='app' and delivery_phase in ('queued','claimed');
create or replace function public.traffic_reminder_queue_app(p_reminder_id bigint,p_token text,p_generation text,p_expected_trigger integer,p_rule jsonb,p_result_text text default null)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;body jsonb;n integer;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or r.channel not in ('app','both') then return 0;end if;
 if not exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=p_reminder_id and e.token=p_token and e.lease_until>clock_timestamp()) then raise exception 'Evaluation lease expired';end if;
 if jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel) is distinct from p_rule then raise exception 'Reminder rule changed';end if;
 if p_generation is null or p_generation !~ '^(scheduled:[0-9]+|event:[a-f0-9]{64})$' then raise exception 'Invalid app generation';end if;
 if p_generation like 'scheduled:%' and (p_generation<>'scheduled:'||p_expected_trigger::text or coalesce(r.trigger_count,0)<>p_expected_trigger) then raise exception 'Reminder occurrence changed';end if;
 if p_generation like 'event:%' and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type' is distinct from 'realtime' then raise exception 'Not a realtime reminder';end if;
 body:=jsonb_build_object('reminder_id',r.reminder_id,'title',r.title,'description',r.description,'priority',r.priority,
  'reminder_type',r.reminder_type,'created_by',r.created_by,'creator_name',coalesce((select data->>'Name' from public.slyusars where slyusar_id=r.created_by),'—'),
  'trigger_count',p_expected_trigger,'condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel,
  'meta',jsonb_build_object('condition_result_text',p_result_text));
 insert into public.atlas_reminder_logs(reminder_id,recipient_id,channel,message_text,delivery_status,delivery_key,delivery_generation,delivery_phase,app_payload)
 select r.reminder_id,s.slyusar_id,'app',r.title,'sent',md5(jsonb_build_array(p_generation,s.slyusar_id,'app')::text),p_generation,'queued',body
 from public.slyusars s where public.reminder_recipient_matches(r.recipients,r.created_by,s.slyusar_id)
 on conflict(reminder_id,delivery_key) where delivery_key is not null do nothing;
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function public.traffic_reminder_queue_app(bigint,text,text,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_queue_app(bigint,text,text,integer,jsonb,text) to service_role;

-- The caller's existing RLS still applies to both tables. Cursor pages are small.
create or replace function public.traffic_reminder_app_inbox(p_recipient_id bigint,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with pending as materialized (
  select l.log_id,l.delivery_generation,l.app_payload from public.atlas_reminder_logs l
  join public.atlas_reminders r on r.reminder_id=l.reminder_id
  where l.recipient_id=p_recipient_id and l.channel='app' and l.app_payload is not null
  and (p_after is null or l.log_id>p_after)
  and (l.delivery_phase='queued' or (l.delivery_phase='claimed' and l.delivery_lease_until<=now()))
  and r.status not in ('paused','cancelled') and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id)
  and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=
      jsonb_build_object('condition_query',l.app_payload->'condition_query','schedule',l.app_payload->'schedule','recipients',l.app_payload->'recipients','channel',l.app_payload->'channel')
  order by l.log_id limit 21
 ), page as(select * from pending order by log_id limit 20)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by log_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>20 from pending),'next_cursor',(select max(log_id) from page),
  'retry_at',(select min(l.delivery_lease_until) from public.atlas_reminder_logs l
    join public.atlas_reminders r on r.reminder_id=l.reminder_id
    where l.recipient_id=p_recipient_id and l.channel='app' and l.app_payload is not null
    and l.delivery_phase='claimed' and l.delivery_lease_until>now() and r.status not in ('paused','cancelled')
    and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id)));
$$;
create or replace function public.traffic_reminder_watch_page(p_recipient_id bigint,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with matches as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.schedule,r.condition_query,r.recipients,r.channel,r.priority,r.status,
   r.created_by,r.next_trigger_at,r.trigger_count,'{}'::jsonb meta
  from public.atlas_reminders r where r.status='active' and (p_after is null or r.reminder_id>p_after)
  and r.reminder_type='conditional' and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
  and left(ltrim(r.condition_query),1)='{'
  and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id) order by r.reminder_id limit 101
 ), page as(select * from matches order by reminder_id limit 100)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>100 from matches),'next_cursor',(select max(reminder_id) from page));
$$;
revoke all on function public.traffic_reminder_app_inbox(bigint,bigint),public.traffic_reminder_watch_page(bigint,bigint) from public,anon;
grant execute on function public.traffic_reminder_app_inbox(bigint,bigint),public.traffic_reminder_watch_page(bigint,bigint) to authenticated,service_role;

-- Keep the configured project's HTTP command (including any existing auth).
-- The private table is neither an exposed API table nor a Realtime publication.
create table if not exists sto_atlas_private.cron_transport(singleton boolean primary key default true check(singleton),command text not null);
revoke all on sto_atlas_private.cron_transport from public,anon,authenticated;
do $$ declare cmd text;definition text;url text;
begin
 if to_regclass('cron.job') is null then raise exception 'Enable Supabase Cron before installing Atlas background optimization';end if;
 select command into cmd from cron.job where jobname='atlas_check_reminders_every_minute';
 if cmd is not null and cmd not like '%traffic_dispatch_reminders%' then
  insert into sto_atlas_private.cron_transport values(true,cmd) on conflict(singleton) do update set command=excluded.command;
 end if;
 if not exists(select 1 from sto_atlas_private.cron_transport) then
  select nullif("Загальні",'') into url from public.settings where setting_id=18;
  if url is not null then url:=rtrim(url,'/')||'/functions/v1/check-reminders';end if;
  if url is null and to_regprocedure('public.sync_atlas_reminder_cron_now()') is not null then
   select pg_get_functiondef('public.sync_atlas_reminder_cron_now()'::regprocedure) into definition;
   url:=substring(definition from 'https://[a-z0-9]+\.supabase\.co/functions/v1/check-reminders');
  end if;
  if url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/check-reminders$' then
   cmd:=format('select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-atlas-cron'',''check-reminders''),body:='' {"source":"pg_cron"}''::jsonb,timeout_milliseconds:=5000);',url);
   insert into sto_atlas_private.cron_transport values(true,cmd);
  end if;
 end if;
end $$;

create or replace function public.traffic_dispatch_reminders()
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare cmd text;
begin
 if not pg_try_advisory_xact_lock(710231,1) then return false;end if;
 if not exists(select 1 from public.atlas_reminders r left join sto_atlas_private.evaluations e using(reminder_id)
  where r.status='active' and (e.lease_until is null or e.lease_until<=now())
  and (r.next_trigger_at<=now() or (r.reminder_type='conditional' and r.condition_query is not null
   and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
   and (r.channel<>'app' or left(ltrim(r.condition_query),1)<>'{')))) then return false;end if;
 select command into cmd from sto_atlas_private.cron_transport where singleton;
 if cmd is null then raise exception 'Atlas Cron transport is not configured: check Supabase URL in settings 18';end if;
 execute cmd;
 return true;
end $$;
revoke all on function public.traffic_dispatch_reminders() from public,anon,authenticated;
grant execute on function public.traffic_dispatch_reminders() to service_role;

create or replace function public.sync_atlas_reminder_cron_now()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare needs_job boolean;job bigint;cmd text;url text;
begin
 perform pg_advisory_xact_lock(710231,2);
 select exists(select 1 from public.atlas_reminders r where status='active' and
  (next_trigger_at is not null or (reminder_type='conditional' and condition_query is not null and public.traffic_atlas_object(to_jsonb(schedule))->>'type'='realtime'
   and (channel<>'app' or left(ltrim(condition_query),1)<>'{')))) into needs_job;
 select jobid,command into job,cmd from cron.job where jobname='atlas_check_reminders_every_minute';
 if needs_job then
  if not exists(select 1 from sto_atlas_private.cron_transport) then
   select nullif("Загальні",'') into url from public.settings where setting_id=18;
   if url ~ '^https://[a-z0-9]+\.supabase\.co/?$' then
    insert into sto_atlas_private.cron_transport values(true,format('select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-atlas-cron'',''check-reminders''),body:='' {"source":"pg_cron"}''::jsonb,timeout_milliseconds:=5000);',rtrim(url,'/')||'/functions/v1/check-reminders'));
   end if;
  end if;
  if job is null or cmd<>'select public.traffic_dispatch_reminders();' then
   perform cron.schedule('atlas_check_reminders_every_minute','* * * * *','select public.traffic_dispatch_reminders();');
  end if;
 elsif job is not null then perform cron.unschedule(job);end if;
end $$;
revoke all on function public.sync_atlas_reminder_cron_now() from public,anon;
grant execute on function public.sync_atlas_reminder_cron_now() to authenticated,service_role;
-- No cron bookkeeping for token/count/meta/updated_at-only updates.
drop trigger if exists trg_sync_atlas_reminder_cron on public.atlas_reminders;
drop trigger if exists trg_sync_atlas_reminder_cron_config on public.atlas_reminders;
create trigger trg_sync_atlas_reminder_cron after insert or delete on public.atlas_reminders for each statement execute function public.sync_atlas_reminder_cron_trigger();
create trigger trg_sync_atlas_reminder_cron_config after update of status,channel,next_trigger_at,schedule,condition_query on public.atlas_reminders for each statement execute function public.sync_atlas_reminder_cron_trigger();
select public.sync_atlas_reminder_cron_now();

-- Existing logs are also used by the planner. Add only when not already published.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='atlas_reminder_logs') then
  alter publication supabase_realtime add table public.atlas_reminder_logs;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
