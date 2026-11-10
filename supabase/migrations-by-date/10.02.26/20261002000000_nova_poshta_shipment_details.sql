begin;
alter table public.np_shipments add column if not exists provider_details jsonb not null default '{}'::jsonb;
create or replace function public.np_apply_document_details(p_token uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.np_connections where id=1 and lock_token=p_token and lock_until>now() and enabled for update;
  if not found then raise exception 'SYNC_EXPIRED'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows)>200 then raise exception 'INVALID_DETAILS'; end if;
  update public.np_shipments s set provider_details=r.details, updated_at=now(), version=s.version+1
  from (select distinct on (entry->>'ttn') entry->>'ttn' as ttn, entry->'details' as details
        from jsonb_array_elements(p_rows) with ordinality as entries(entry,position)
        where jsonb_typeof(entry->'details')='object' order by entry->>'ttn',position) r
  where s.connection_id=1 and s.ttn=r.ttn and s.provider_details is distinct from r.details;
end $$;
revoke all on function public.np_apply_document_details(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.np_apply_document_details(uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
