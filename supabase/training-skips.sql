-- Jours d'entraînement sautés (décalent la rotation du coach). Privé, synchronisé entre appareils.
-- Idempotent : relançable sans risque.

create table if not exists public.training_skips (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.training_skips enable row level security;

drop policy if exists "training_skips_own" on public.training_skips;
create policy "training_skips_own" on public.training_skips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime (ignore si déjà ajoutée)
do $$ begin
  alter publication supabase_realtime add table public.training_skips;
exception when duplicate_object then null; end $$;
