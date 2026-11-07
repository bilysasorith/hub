-- Hub — tables privées (v2). À exécuter dans Supabase → SQL Editor.
-- Tout est protégé par RLS : chaque ligne n'est visible/modifiable que par son propriétaire connecté.
-- Le robot d'import Teams écrit avec la clé service_role (qui contourne RLS) et renseigne user_id.

-- 1) Événements perso ajoutés depuis l'app
create table if not exists public.custom_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  location text,
  created_at timestamptz default now()
);

-- 2) Cours myefrei masqués ("je n'y vais pas")
create table if not exists public.event_overrides (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_uid text not null,
  hidden boolean not null default true,
  primary key (user_id, event_uid)
);

-- 3) Réunions Teams importées depuis les 2 calendriers Outlook
create table if not exists public.calendar_events (
  id text primary key,                 -- "freelance:<uid>" / "efrei:<uid>"
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,                -- 'freelance' | 'efrei'
  title text,
  start_at timestamptz,
  end_at timestamptz,
  location text,
  updated_at timestamptz default now()
);

-- RLS
alter table public.custom_events   enable row level security;
alter table public.event_overrides enable row level security;
alter table public.calendar_events enable row level security;

create policy "own custom"    on public.custom_events   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own overrides" on public.event_overrides for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own calendar"  on public.calendar_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Temps réel (synchro instantanée entre appareils)
alter publication supabase_realtime add table public.custom_events;
alter publication supabase_realtime add table public.event_overrides;
alter publication supabase_realtime add table public.calendar_events;
