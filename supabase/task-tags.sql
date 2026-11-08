-- Étiquette de tâche (EFREI / SG / Perso / Freelance). Idempotent.
alter table public.todos add column if not exists tag text;
