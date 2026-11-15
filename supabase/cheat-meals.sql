-- Écarts alimentaires (suivi des jours « clean »). Privé, synchronisé entre appareils.
-- Idempotent : relançable sans risque.

create table if not exists public.cheat_meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  label text,
  created_at timestamptz not null default now()
);

alter table public.cheat_meals enable row level security;

drop policy if exists "cheat_meals_own" on public.cheat_meals;
create policy "cheat_meals_own" on public.cheat_meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  alter publication supabase_realtime add table public.cheat_meals;
exception when duplicate_object then null; end $$;
