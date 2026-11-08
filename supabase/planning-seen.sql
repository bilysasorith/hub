-- Horodatage « vu » des changements de planning (éteint le badge sur tous les appareils).
-- Une seule ligne par utilisateur. Idempotent : relançable sans risque.

create table if not exists public.planning_seen (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now()
);

alter table public.planning_seen enable row level security;

drop policy if exists "planning_seen_own" on public.planning_seen;
create policy "planning_seen_own" on public.planning_seen
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  alter publication supabase_realtime add table public.planning_seen;
exception when duplicate_object then null; end $$;
