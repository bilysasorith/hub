-- Tâches récurrentes (null = une seule fois). Idempotent.
--   monthly    = chaque mois
--   semiannual = tous les 6 mois
--   yearly     = chaque année
alter table public.todos add column if not exists repeat text;
alter table public.todos drop constraint if exists todos_repeat_check;
alter table public.todos add constraint todos_repeat_check check (repeat is null or repeat in ('monthly', 'semiannual', 'yearly'));
