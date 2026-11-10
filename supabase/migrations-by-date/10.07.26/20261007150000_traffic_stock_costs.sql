begin;
create or replace function public.traffic_stock_costs(p_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if coalesce(cardinality(p_ids),0)>200 then raise exception 'At most 200 stock IDs'; end if;
 with source as (
   select n.sclad_id,to_jsonb(n) row_data,public.sto_read_object_v1(to_jsonb(n)->'data') legacy
   from public.sclad n where n.sclad_id=any(p_ids)
 ), projected as (
   select sclad_id,row_data,
     coalesce((select jsonb_object_agg(key,value) from jsonb_each(legacy)
       where key in ('sclad_id','price','scladNomer','xto_zamovuv')),'{}'::jsonb) data
   from source
 )
 select coalesce(jsonb_agg(jsonb_build_object('sclad_id',sclad_id,'price',row_data->'price',
   'scladNomer',row_data->'scladNomer','xto_zamovuv',row_data->'xto_zamovuv','data',
   case when jsonb_typeof(row_data->'data')='string' then
     case when legacy_valid is true then to_jsonb(data::text) else row_data->'data' end
     when jsonb_typeof(row_data->'data')='object' then data else row_data->'data' end)
   order by sclad_id),'[]'::jsonb) into result
 from (select *, public.sto_read_object_v1(row_data->'data')<>'{}'::jsonb as legacy_valid from projected) p;
 return result;
end;
$$;
revoke all on function public.traffic_stock_costs(bigint[]) from public;
grant execute on function public.traffic_stock_costs(bigint[]) to anon,authenticated;
commit;
