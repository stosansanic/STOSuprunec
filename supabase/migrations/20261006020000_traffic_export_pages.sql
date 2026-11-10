-- Verified export: first pass returns canonical text, second only its SHA-256.
-- SECURITY INVOKER retains the same table privileges and RLS as direct reads.
begin;
create or replace function public.traffic_export_page(
  p_table text, p_keys text[], p_offset integer default 0,
  p_limit integer default 250, p_hash_only boolean default false
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare ordering text; payload text; row_count integer; total bigint; k text;
begin
  if p_table is null or not (p_table = any(array[
    'acts','clients','cars','sclad','works','details','shops','slyusars','settings',
    'incomes','vutratu','faktura','post_arxiv','post_category','post_name','sms','whitelist',
    'act_changes_notifications','slusar_complete_notifications','audit_logs','ai_chats',
    'ai_messages','ai_skills','atlas_reminder_logs','atlas_reminders','atlas_telegram_users'
  ])) then raise exception 'Unsupported export table'; end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception 'Invalid export page';
  end if;
  if coalesce(cardinality(p_keys),0) = 0 then raise exception 'Export ordering is required'; end if;
  foreach k in array p_keys loop
    if k is null or not exists (select 1 from pg_attribute
      where attrelid = format('public.%I',p_table)::regclass and attname = k
        and attnum > 0 and not attisdropped) then raise exception 'Unknown export key'; end if;
  end loop;
  select string_agg(format('%I asc', key), ',') into ordering from unnest(p_keys) key;
  execute format(
    'with page as (select * from public.%I order by %s offset $1 limit $2)
     select coalesce(jsonb_agg(to_jsonb(page) order by %s),''[]''::jsonb)::text,
       count(*)::integer, (select count(*) from public.%I) from page',
    p_table, ordering, ordering, p_table
  ) into payload, row_count, total using p_offset, p_limit;
  return jsonb_build_object('format','sto-canonical-page-v1',
    'payload', case when p_hash_only then null else payload end,
    'count',row_count,'total',total,'hash',encode(sha256(convert_to(payload,'UTF8')),'hex'));
end;
$$;
revoke all on function public.traffic_export_page(text,text[],integer,integer,boolean) from public;
grant execute on function public.traffic_export_page(text,text[],integer,integer,boolean) to authenticated;
commit;
