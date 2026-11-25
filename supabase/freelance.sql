-- Heures freelance : jours validés « 0h » (pas travaillé). Les heures elles-mêmes vivent
-- dans data.js du dépôt suivi-heures. Idempotent : relançable sans risque.
-- À lancer APRÈS le déploiement de la fonction freelance.

create table if not exists public.freelance_days (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.freelance_days enable row level security;
drop policy if exists "freelance_days_own" on public.freelance_days;
create policy "freelance_days_own" on public.freelance_days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  alter publication supabase_realtime add table public.freelance_days;
exception when duplicate_object then null; end $$;

-- Rappel chaque soir à 19 h UTC (20 h l'hiver, 21 h l'été) si au moins 3 jours non validés.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('freelance-remind') where exists (select 1 from cron.job where jobname = 'freelance-remind');
select cron.schedule('freelance-remind', '0 19 * * *', $$
  select net.http_post(
    url := 'https://dcauisdxvbmcnerjklxm.supabase.co/functions/v1/freelance',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "remind"}'::jsonb
  );
$$);
