-- Correction manuelle du statut « examen » d'un cours myefrei. Idempotent.
-- is_exam = true  -> forcé examen  ; is_exam = false -> forcé « pas un examen ».
-- Absent -> on retombe sur la détection auto (code d'activité DE).
create table if not exists public.exam_flags (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_uid text not null,
  is_exam boolean not null default true,
  updated_at timestamptz default now(),
  primary key (user_id, event_uid)
);

alter table public.exam_flags enable row level security;

drop policy if exists "own exam flags" on public.exam_flags;
create policy "own exam flags" on public.exam_flags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime
alter publication supabase_realtime add table public.exam_flags;
