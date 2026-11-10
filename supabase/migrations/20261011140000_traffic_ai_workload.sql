-- Complete workload statistics; only seven daily and 24 hourly buckets leave PostgreSQL.
create or replace function public.traffic_ai_workload(p_since timestamptz,p_timezone text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as (
  select act_id,date_on,
   extract(dow from case when pg_typeof(date_on)='timestamp without time zone'::regtype then date_on::timestamp else date_on::timestamptz at time zone p_timezone end)::integer dow,
   extract(hour from case when pg_typeof(date_on)='timestamp without time zone'::regtype then date_on::timestamp else date_on::timestamptz at time zone p_timezone end)::integer as "hour",
   (case when pg_typeof(date_on)='timestamp without time zone'::regtype then date_on::timestamp at time zone p_timezone else date_on::timestamptz end at time zone 'UTC')::date utc_day,
   public.traffic_ai_parse_float(case when jsonb_typeof(data::jsonb)='object' then data::jsonb->'Загальна сума' else null end) revenue
  from public.acts where case when pg_typeof(date_on)='timestamp without time zone'::regtype then date_on::timestamp>=p_since at time zone 'UTC' else date_on::timestamptz>=p_since end
 ), days as (
  select dow,count(*) count,count(distinct utc_day) dates,sum(revenue order by date_on,act_id) revenue from source group by dow
 ), hours as(select "hour",count(*) count from source group by "hour")
 select jsonb_build_object('complete',true,'total', (select count(*) from source),
  'days',coalesce((select jsonb_agg(to_jsonb(days) order by dow) from days),'[]'::jsonb),
  'hours',coalesce((select jsonb_agg(to_jsonb(hours) order by "hour") from hours),'[]'::jsonb));
$$;
revoke all on function public.traffic_ai_workload(timestamptz,text) from public;
grant execute on function public.traffic_ai_workload(timestamptz,text) to anon,authenticated;
