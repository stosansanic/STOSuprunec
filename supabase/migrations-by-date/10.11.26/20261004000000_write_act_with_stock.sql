-- Import commits the act and its stock consumption together under a row lock.
CREATE OR REPLACE FUNCTION public.write_act_with_stock(
  p_act_id integer, p_expected jsonb, p_next jsonb, p_avans numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  current_data jsonb;
  closed_at public.acts.date_off%TYPE;
  change_record record;
BEGIN
  SELECT data, date_off INTO current_data, closed_at
  FROM public.acts WHERE act_id = p_act_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Акт не знайдено'; END IF;
  IF jsonb_typeof(current_data) = 'string' THEN
    current_data := (current_data #>> '{}')::jsonb;
  END IF;
  IF current_data IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Акт змінився. Відкрийте його повторно.' USING ERRCODE = '40001';
  END IF;
  IF closed_at IS NOT NULL OR current_data->>'Заморожений' = 'true' THEN
    RAISE EXCEPTION 'Акт закритий або заморожений' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_next) IS DISTINCT FROM 'object'
     OR jsonb_typeof(COALESCE(p_next->'Деталі', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Некоректні дані акту';
  END IF;

  FOR change_record IN
    WITH quantities AS (
      SELECT (item->>'sclad_id')::integer AS sid,
             COALESCE(NULLIF(item->>'Кількість', '')::numeric, 0) AS qty
      FROM jsonb_array_elements(COALESCE(p_next->'Деталі', '[]'::jsonb)) item
      WHERE NULLIF(item->>'sclad_id', '') IS NOT NULL
      UNION ALL
      SELECT (item->>'sclad_id')::integer,
             -COALESCE(NULLIF(item->>'Кількість', '')::numeric, 0)
      FROM jsonb_array_elements(COALESCE(current_data->'Деталі', '[]'::jsonb)) item
      WHERE NULLIF(item->>'sclad_id', '') IS NOT NULL
    )
    SELECT sid, SUM(qty) AS delta FROM quantities
    GROUP BY sid HAVING SUM(qty) <> 0 ORDER BY sid
  LOOP
    UPDATE public.sclad
    SET kilkist_off = GREATEST(COALESCE(kilkist_off, 0) + change_record.delta, 0)
    WHERE sclad_id = change_record.sid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Деталь складу % не знайдена', change_record.sid;
    END IF;
  END LOOP;

  UPDATE public.acts SET data = p_next, avans = COALESCE(p_avans, avans)
  WHERE act_id = p_act_id;
  RETURN p_next;
END;
$$;
GRANT EXECUTE ON FUNCTION public.write_act_with_stock(integer, jsonb, jsonb, numeric)
TO anon, authenticated, service_role;
