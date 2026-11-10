-- Repairs missing consumption confirmed by act details. Creates no DB objects.
-- Existing nonzero consumption, supplier returns and overdrawn rows need
-- separate reconciliation; do not overwrite them with guessed quantities.
WITH act_json AS (
  SELECT act_id, CASE WHEN jsonb_typeof(data) = 'string'
    THEN (data #>> '{}')::jsonb ELSE data END AS body
  FROM public.acts
), used AS (
  SELECT (item->>'sclad_id')::integer AS sid,
         SUM(COALESCE(NULLIF(item->>'Кількість', '')::numeric, 0)) AS qty
  FROM act_json
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(body->'Деталі') = 'array'
      THEN body->'Деталі' ELSE '[]'::jsonb END) item
  WHERE NULLIF(item->>'sclad_id', '') ~ '^[0-9]+$'
    AND COALESCE(body->>'Заморожений', 'false') <> 'true'
  GROUP BY (item->>'sclad_id')::integer
)
UPDATE public.sclad AS s
SET kilkist_off = used.qty
FROM used
WHERE used.sid = s.sclad_id
  AND COALESCE(s.kilkist_off, 0) = 0
  AND used.qty > 0
  AND used.qty <= s.kilkist_on
  AND s.povernennya IS NULL
RETURNING s.sclad_id, s.name, s.kilkist_on, s.kilkist_off,
          s.kilkist_on - s.kilkist_off AS remaining;
