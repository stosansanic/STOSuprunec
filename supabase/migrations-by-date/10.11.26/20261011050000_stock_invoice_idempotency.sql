-- MUTATION: invoice receipt idempotency using its existing prumitka marker.
-- No new tables; never merges independent non-invoice stock purchases.
create or replace function public.stock_invoice_origin(p_notes text)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare origins text[];
begin
 select array_agg(distinct m[1]) into origins from regexp_matches(coalesce(p_notes,''),'(\[atlas-invoice:[0-9a-f]{64}:[1-9][0-9]*\])','g') m;
 if coalesce(array_length(origins,1),0)>1 then raise exception 'Multiple invoice origins in one stock row';end if;
 return origins[1];
end $$;
create or replace function public.stock_guard_invoice_origin()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare origin text; old_origin text;
begin
 origin:=public.stock_invoice_origin(new.prumitka);
 if tg_op='UPDATE' then
  old_origin:=public.stock_invoice_origin(old.prumitka);
  if old_origin is not null and origin is distinct from old_origin then
   raise exception 'Invoice origin cannot be removed or replaced';
  end if;
 end if;
 if origin is null then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended(origin,1937010546));
 if exists(select 1 from public.sclad s where s.sclad_id is distinct from new.sclad_id and strpos(coalesce(s.prumitka,''),origin)>0) then
  raise exception 'Invoice row already received. Refresh stock before retrying.';
 end if;
 return new;
end $$;
drop trigger if exists stock_invoice_origin_guard on public.sclad;
create trigger stock_invoice_origin_guard before insert or update of prumitka on public.sclad for each row execute function public.stock_guard_invoice_origin();

create or replace function public.stock_insert_invoice(p_payload jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare origin text; prior public.sclad%rowtype; incoming public.sclad%rowtype; new_id bigint; matches integer; expected jsonb;
begin
 if jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('time_on','shops','part_number','name','kilkist_on','kilkist_off','price','rahunok','unit_measurement','akt','scladNomer','xto_zamovuv','statys','prumitka','client_price')) then raise exception 'Invalid invoice payload';end if;
 origin:=public.stock_invoice_origin(p_payload->>'prumitka');
 if origin is null then raise exception 'Missing invoice origin';end if;
 incoming:=jsonb_populate_record(null::public.sclad,p_payload);
 if incoming.time_on is null or incoming.kilkist_on is null or incoming.kilkist_on<=0 or incoming.price is null or incoming.price<=0 or nullif(btrim(incoming.part_number),'') is null or nullif(btrim(incoming.name),'') is null then raise exception 'Incomplete invoice row';end if;
 perform pg_advisory_xact_lock(hashtextextended(origin,1937010546));
 select count(*) into matches from public.sclad s where strpos(coalesce(s.prumitka,''),origin)>0;
 if matches>1 then raise exception 'Historical invoice duplicates require manual review';end if;
 if matches=1 then
  select * into prior from public.sclad s where strpos(coalesce(s.prumitka,''),origin)>0 for update;
  -- Consumption can change after the first save; never reset it on retry.
  select coalesce(jsonb_object_agg(k,to_jsonb(incoming)->k),'{}'::jsonb) into expected from jsonb_object_keys(p_payload) k where k<>'kilkist_off';
  if not (to_jsonb(prior) @> expected) then raise exception 'Invoice row exists with changed data. Refresh stock before retrying.';end if;
  return jsonb_build_object('sclad_id',prior.sclad_id,'status','existing');
 end if;
 insert into public.sclad(time_on,shops,part_number,name,kilkist_on,kilkist_off,price,rahunok,unit_measurement,akt,"scladNomer",xto_zamovuv,statys,prumitka,client_price)
 values(incoming.time_on,incoming.shops,incoming.part_number,incoming.name,incoming.kilkist_on,coalesce(incoming.kilkist_off,0),incoming.price,incoming.rahunok,incoming.unit_measurement,incoming.akt,incoming."scladNomer",incoming.xto_zamovuv,incoming.statys,incoming.prumitka,incoming.client_price)
 returning sclad_id into new_id;
 return jsonb_build_object('sclad_id',new_id,'status','created');
end $$;
revoke all on function public.stock_invoice_origin(text),public.stock_guard_invoice_origin(),public.stock_insert_invoice(jsonb) from public;
grant execute on function public.stock_invoice_origin(text),public.stock_guard_invoice_origin(),public.stock_insert_invoice(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
