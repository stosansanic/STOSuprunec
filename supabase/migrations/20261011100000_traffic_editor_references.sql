begin;
-- Existing dictionaries only. Search results are candidates, never a complete dictionary.
create or replace function public.traffic_editor_references(p_query text default '',p_names text[] default '{}',p_work_ids text[] default '{}',p_detail_ids bigint[] default '{}',p_voice boolean default false)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if length(p_query)>2000 or cardinality(p_names)>200 or cardinality(p_work_ids)>200 or cardinality(p_detail_ids)>200 then raise exception 'Editor lookup too large';end if;
 with entries as (
   select 'work' kind,work_id::text id,public.traffic_reference_name(to_jsonb(data)) name,''::text catalog from public.works
   union all select 'detail',detail_id::text,public.traffic_reference_name(to_jsonb(data)),'' from public.details
   union all select 'shop',shop_id::text,coalesce(public.sto_read_object_v1(data::jsonb)->>'Name',case when jsonb_typeof(data::jsonb)='string' then data::jsonb#>>'{}' end,''),'' from public.shops
   union all select 'stock',sclad_id::text,name,coalesce(part_number,'') from public.sclad where p_voice
 ), matched as (
   select *,case when name=any(p_names) or (kind='work' and id=any(p_work_ids)) or (kind='detail' and id=any(select unnest(p_detail_ids)::text)) then 0
     when lower(name)=lower(btrim(p_query)) or lower(id)=lower(btrim(p_query)) or (p_voice and length(name)>=3 and strpos(lower(p_query),lower(name))>0) then 1 else 2 end rank,
     case when p_voice then (select coalesce(sum(length(token)),0) from regexp_split_to_table(lower(p_query),'[^[:alnum:]а-яіїєґ]+') token where length(token)>=3 and strpos(lower(name),left(token,greatest(3,length(token)-2)))>0) else 0 end voice_score
   from entries where name=any(p_names) or (kind='work' and id=any(p_work_ids)) or (kind='detail' and id=any(select unnest(p_detail_ids)::text))
    or (kind='shop' and btrim(p_query)='' and cardinality(p_names)=0 and cardinality(p_work_ids)=0 and cardinality(p_detail_ids)=0)
    or (btrim(p_query)<>'' and (strpos(lower(name),lower(btrim(p_query)))>0 or (kind='work' and strpos(lower(id),lower(btrim(p_query)))>0)
      or (p_voice and exists(select 1 from regexp_split_to_table(lower(p_query),'[^[:alnum:]а-яіїєґ]+') token where length(token)>=3 and strpos(lower(name),left(token,greatest(3,length(token)-2)))>0))))
 ), ranked as (select *,row_number() over(partition by kind order by rank,voice_score desc,id) rn from matched)
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'name',name,'catalog',catalog) order by kind,rank,voice_score desc,id),'[]') into result
 from ranked where rank=0 or rn<=case when p_voice then 80 else 50 end;
 return result;
end;$$;
revoke all on function public.traffic_editor_references(text,text[],text[],bigint[],boolean) from public;
grant execute on function public.traffic_editor_references(text,text[],text[],bigint[],boolean) to anon,authenticated;
create or replace function public.traffic_editor_act_quantities(p_act_id bigint)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare raw jsonb; doc jsonb; details jsonb; quantities jsonb;
begin
 select to_jsonb(a.data) into raw from public.acts a where a.act_id=p_act_id;
 if not found then return null;end if;
 if jsonb_typeof(raw)='string' then raw:=(raw#>>'{}')::jsonb;end if;
 if jsonb_typeof(raw) is distinct from 'object' then raise exception 'Некоректні дані акту для перевірки кількості';end if;
 doc:=raw;details:=coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb);
 if jsonb_typeof(details) is distinct from 'array' then raise exception 'Некоректний список деталей акту';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sclad_id',item->'sclad_id','Кількість',item->'Кількість')),'[]'::jsonb) into quantities from jsonb_array_elements(details)item;
 return jsonb_build_object('Деталі',quantities,'__act_revision',doc->'__act_revision');
end;
$$;
revoke all on function public.traffic_editor_act_quantities(bigint) from public;
grant execute on function public.traffic_editor_act_quantities(bigint) to anon,authenticated;
commit;
