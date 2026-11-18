-- Notifications « signe ton cours » (Web Push). Idempotent.
-- À lancer APRÈS le déploiement de la fonction notify-sign.

-- Appareils abonnés (un par navigateur / iPhone).
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own push subs" on public.push_subscriptions;
create policy "own push subs" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cours déjà notifiés (évite d'envoyer deux fois). Écrit par la fonction uniquement.
create table if not exists public.push_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_uid text not null,
  sent_at timestamptz default now(),
  primary key (user_id, event_uid)
);
alter table public.push_sent enable row level security;

-- Appel de la fonction chaque minute. Pas de secret ici : la fonction ne fait qu'envoyer
-- la notification d'un cours qui commence, une seule fois (push_sent).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('notify-sign') where exists (select 1 from cron.job where jobname = 'notify-sign');
select cron.schedule('notify-sign', '* * * * *', $$
  select net.http_post(
    url := 'https://dcauisdxvbmcnerjklxm.supabase.co/functions/v1/notify-sign',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
