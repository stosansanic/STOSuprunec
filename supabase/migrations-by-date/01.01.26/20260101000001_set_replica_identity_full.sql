-- Встановлюємо REPLICA IDENTITY FULL для таблиць,
-- щоб Supabase Realtime відправляв ПОВНИЙ old-рядок при UPDATE/DELETE.
-- Це потрібно для коректної роботи CHANGED/OPENED/CLOSED перевірок у нагадуваннях.

ALTER TABLE public.acts REPLICA IDENTITY FULL;
ALTER TABLE public.slyusars REPLICA IDENTITY FULL;
ALTER TABLE public.clients REPLICA IDENTITY FULL;
ALTER TABLE public.cars REPLICA IDENTITY FULL;
ALTER TABLE public.sclad REPLICA IDENTITY FULL;
ALTER TABLE public.settings REPLICA IDENTITY FULL;
