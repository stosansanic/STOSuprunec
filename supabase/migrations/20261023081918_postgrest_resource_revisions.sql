-- Transactional change markers. SQL Editor only; no business-history migration.
-- One append per resource/transaction avoids a shared revision-row lock in
-- concurrent act/payroll writes. COUNT + MAX detects out-of-order commits.
-- This ledger grows with write transactions; monitor its size and manifest
-- latency. It is an indexed aggregate, not an O(1) counter. Never prune/reset
-- markers without changing the epoch in the SAME transaction.
begin;
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
commit;
