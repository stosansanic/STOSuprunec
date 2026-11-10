-- Встановлюємо REPLICA IDENTITY FULL для ai_messages,
-- щоб Supabase Realtime відправляв old-рядок при DELETE
-- (потрібно для синхронізації видалення повідомлень між клієнтами)
ALTER TABLE public.ai_messages REPLICA IDENTITY FULL;
