-- Émargement SoWeSign : signé (present) / absent, par cours. Idempotent.
-- Rempli par scripts/import-sowesign.mjs (clé service_role) ; le Hub ne fait que lire.
create table if not exists public.attendance (
  user_id uuid not null references auth.users(id) on delete cascade,
  sws_id bigint not null,             -- id du cours côté SoWeSign
  start_at timestamptz not null,      -- sert à relier au cours du planning
  end_at timestamptz,
  name text,
  status text,                        -- 'present' | 'absent' | autre statut SoWeSign
  updated_at timestamptz default now(),
  primary key (user_id, sws_id)
);

alter table public.attendance enable row level security;

drop policy if exists "read own attendance" on public.attendance;
create policy "read own attendance" on public.attendance
  for select using (auth.uid() = user_id);
