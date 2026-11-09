-- Événements marqués « ne pas oublier » (rappel). Idempotent.
create table if not exists public.event_reminders (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_key text not null,
  created_at timestamptz default now(),
  primary key (user_id, event_key)
);

alter table public.event_reminders enable row level security;

drop policy if exists "own reminders" on public.event_reminders;
create policy "own reminders" on public.event_reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime
alter publication supabase_realtime add table public.event_reminders;
