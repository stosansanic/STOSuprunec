-- Deletes only the legacy Nova Poshta tables and related functions.
-- No migration is run. The acts.novaposhta column and acts table are untouched.
begin;
-- Remove the old SQL functions before tables; no CASCADE outside this module.
drop function if exists public.np_search_acts(integer,text);
drop function if exists public.np_act_labels(integer,bigint[]);
drop function if exists public.np_mark_read(integer,bigint);
drop function if exists public.np_link(integer,uuid,bigint,integer,boolean,text,text);
drop function if exists public.np_can_act(integer,bigint,boolean);
drop function if exists public.np_apply_document_details(uuid,jsonb);
drop function if exists public.np_apply_tracking(uuid,uuid,jsonb);
drop function if exists public.np_claim_sync();
drop function if exists public.np_change_connection(integer,text,text,text,text);
drop function if exists public.np_secret(text);
drop function if exists public.np_rate(text,integer,integer);
drop table if exists public.np_act_links, public.np_events, public.np_reads,
  public.np_audit, public.np_sync_runs, public.np_sessions, public.np_rate_limits,
  public.np_access, public.np_revision, public.np_shipments, np_private.credentials,
  public.np_connections;
drop function if exists public.np_sync_connection_settings();
drop function if exists public.np_count_links();
drop function if exists public.np_touch();
drop schema if exists np_private;
notify pgrst,'reload schema';
commit;
