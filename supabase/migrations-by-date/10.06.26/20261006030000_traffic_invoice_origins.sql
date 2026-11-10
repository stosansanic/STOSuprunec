create or replace function public.traffic_invoice_origins(p_origins text[])
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
begin
  if coalesce(cardinality(p_origins),0) > 100 then raise exception 'Too many invoice origins'; end if;
  return coalesce((select jsonb_agg(origin) from (
    select distinct origin from unnest(p_origins) origin
    where nullif(origin,'') is not null and exists (
      select 1 from public.sclad s where strpos(coalesce(s.prumitka,''), origin) > 0
    )
  ) found), '[]'::jsonb);
end;
$$;
revoke all on function public.traffic_invoice_origins(text[]) from public;
grant execute on function public.traffic_invoice_origins(text[]) to authenticated;
