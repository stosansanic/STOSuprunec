-- MUTATION: install separately from the read-only traffic package.
-- Existing RLS/privileges apply. No tables, unique indexes, or historical rewrites.
create or replace function public.stock_resolve_references(p_items jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; kind text; nm text; selected bigint; found_id bigint; canonical text; matches integer;
 result jsonb:='[]'; state text; payload jsonb; shop public.shops%rowtype; detail public.details%rowtype;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then raise exception 'Expected at most 100 names';end if;
 if exists(select 1 from jsonb_array_elements(p_items)x where coalesce(x->>'kind','') not in ('shops','details') or nullif(btrim(x->>'name'),'') is null or nullif(x->>'key','') is null)
 or (select count(*)<>count(distinct x->>'key') from jsonb_array_elements(p_items)x) then raise exception 'Invalid reference input';end if;
 -- All application creation paths share this single lock; serializes max-ID allocation
 -- as well as normalized-name recheck without imposing uniqueness on historical data.
 perform pg_advisory_xact_lock(1937010546,1);
 for item in select value from jsonb_array_elements(p_items) loop
  kind:=item->>'kind';nm:=btrim(item->>'name');selected:=nullif(item->>'id','')::bigint;
  if selected is not null and selected<=0 then raise exception 'Invalid selected reference';end if;
  if kind='shops' then
   select count(*) into matches from public.shops s where
    regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(s.data)))),'[[:space:]]+',' ','g')=regexp_replace(lower(nm),'[[:space:]]+',' ','g');
   select s.shop_id,public.traffic_reference_name(to_jsonb(s.data)) into found_id,canonical from public.shops s where
    (selected is null or s.shop_id=selected) and
    regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(s.data)))),'[[:space:]]+',' ','g')=regexp_replace(lower(nm),'[[:space:]]+',' ','g')
    order by (public.traffic_reference_name(to_jsonb(s.data))=nm) desc,s.shop_id limit 1 for key share;
  else
   select count(*) into matches from public.details d where
    regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(d.data)))),'[[:space:]]+',' ','g')=regexp_replace(lower(nm),'[[:space:]]+',' ','g');
   select d.detail_id,public.traffic_reference_name(to_jsonb(d.data)) into found_id,canonical from public.details d where
    (selected is null or d.detail_id=selected) and
    regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(d.data)))),'[[:space:]]+',' ','g')=regexp_replace(lower(nm),'[[:space:]]+',' ','g')
    order by (public.traffic_reference_name(to_jsonb(d.data))=nm) desc,d.detail_id limit 1 for key share;
  end if;
  if selected is not null and found_id is null then raise exception 'Selected reference missing, inaccessible, or renamed';end if;
  state:=case when matches>1 and selected is null then 'ambiguous' else 'existing' end;
  if found_id is null then
   if kind='shops' then
    select coalesce(max(shop_id),0)+1 into found_id from public.shops;
    payload:=jsonb_build_object('Name',nm,'Склад','{}'::jsonb,'Історія',jsonb_build_object(to_char(current_timestamp at time zone 'Europe/Kyiv','YYYY-MM-DD'),'[]'::jsonb),'Про магазин','');
    shop:=jsonb_populate_record(null::public.shops,jsonb_build_object('data',payload));
    insert into public.shops(shop_id,data) overriding system value values(found_id,shop.data);
   else
    select coalesce(max(detail_id),0)+1 into found_id from public.details;
    detail:=jsonb_populate_record(null::public.details,jsonb_build_object('data',nm));
    insert into public.details(detail_id,data) overriding system value values(found_id,detail.data);
   end if;
   canonical:=nm;state:='created';
  end if;
  result:=result||jsonb_build_array(jsonb_build_object('key',item->>'key','kind',kind,'name',nm,'id',found_id,'canonical',canonical,'status',state));
 end loop;
 return result;
end $$;
revoke all on function public.stock_resolve_references(jsonb) from public;
grant execute on function public.stock_resolve_references(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
