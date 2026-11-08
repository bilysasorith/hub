-- Objectifs (buts vagues, non datés) + cadrage SMART. Privé, synchronisé entre appareils.
-- Idempotent : relançable sans risque.

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  why text,                                   -- le plan / pourquoi (facultatif)
  deadline date,                              -- échéance (facultative mais encouragée)
  actions jsonb not null default '[]'::jsonb, -- [{ id, title, done }]
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.goals enable row level security;

drop policy if exists "goals_own" on public.goals;
create policy "goals_own" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  alter publication supabase_realtime add table public.goals;
exception when duplicate_object then null; end $$;
