-- Unique scalar editing suggestions; concrete car/client selections retain distinct IDs.
begin;
create or replace function public.traffic_client_form_options(
  p_kind text, p_query text default '', p_after bigint default null,
  p_client bigint default null
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare result jsonb; field_name text;
begin
  if p_kind in ('client','phone') then
    field_name := case when p_kind='client' then 'ПІБ' else 'Телефон' end;
    with candidates as (
      select client_id as id, public.sto_read_object_v1(data::jsonb) as d
      from public.clients
      where (p_after is null or client_id > p_after)
        and (p_client is null or client_id=p_client)
    ), page as (
      select * from candidates where coalesce(d->>'ПІБ','') <> ''
        and (strpos(lower(coalesce(d->>field_name,'')),lower(coalesce(p_query,'')))>0
          or (p_kind='phone' and regexp_replace(coalesce(p_query,''),'[^0-9]','','g')<>''
            and strpos(regexp_replace(coalesce(d->>field_name,''),'[^0-9]','','g'),
              regexp_replace(p_query,'[^0-9]','','g'))>0))
      order by id limit 21
    ), visible as (select * from page order by id limit 20)
    select jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
      'id',id::text,'fullName',coalesce(d->>'ПІБ',''),'phone',coalesce(d->>'Телефон',''),
      'data',jsonb_build_object('ПІБ',d->'ПІБ','Телефон',d->'Телефон')) order by id) from visible),'[]'::jsonb),
      'has_more',(select count(*)>20 from page),'next_cursor',(select max(id) from visible)) into result;
  else
    field_name := case p_kind when 'carModel' then 'Авто' when 'carNumber' then 'Номер авто'
      when 'carCodeEdit' then 'КодДВЗ' when 'carEngineEdit' then 'Обʼєм'
      when 'carVinEdit' then 'Vincode' when 'carModelEdit' then 'Авто'
      when 'carNumberEdit' then 'Номер авто' else null end;
    if field_name is null then raise exception 'Unsupported form field'; end if;
    with candidates as (
      select cars_id as id, client_id, public.sto_read_object_v1(data::jsonb) as d
      from public.cars where is_deleted is not true
        and (p_client is null or client_id=p_client)
    ), unique_candidates as (
      select distinct on (case when right(p_kind,4)='Edit' then d->>field_name else id::text end) *
      from candidates
      order by (case when right(p_kind,4)='Edit' then d->>field_name else id::text end), id
    ), page as (
      select * from unique_candidates where (p_after is null or id>p_after) and coalesce(d->>field_name,'') <> ''
        and strpos(lower(coalesce(d->>field_name,'')),lower(coalesce(p_query,'')))>0
      order by id limit 21
    ), visible as (select * from page order by id limit 20)
    select jsonb_build_object('items',coalesce((select jsonb_agg(
      jsonb_build_object('id',id::text,'client_id',client_id::text,'label',d->>field_name,
        'Авто',d->'Авто','Номер авто',d->'Номер авто') order by id) from visible),'[]'::jsonb),
      'has_more',(select count(*)>20 from page),'next_cursor',(select max(id) from visible)) into result;
  end if;
  return result;
end;
$$;
revoke all on function public.traffic_client_form_options(text,text,bigint,bigint) from public;
grant execute on function public.traffic_client_form_options(text,text,bigint,bigint) to anon, authenticated;
commit;
