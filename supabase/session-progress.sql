-- Page « Cours » : séances que j'ai rattrapées / revues (« je suis à jour »). Idempotent.
-- Une ligne = une séance cochée (event_uid = identifiant stable de courses.json / planning.json).
create table if not exists public.session_progress (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_uid text not null,
  created_at timestamptz default now(),
  primary key (user_id, event_uid)
);

alter table public.session_progress enable row level security;

drop policy if exists "own session progress" on public.session_progress;
create policy "own session progress" on public.session_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime (synchro entre appareils)
do $$ begin
  alter publication supabase_realtime add table public.session_progress;
exception when duplicate_object then null; end $$;
