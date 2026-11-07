-- Hub — sous-tâches. À exécuter une fois dans Supabase → SQL Editor.
-- Les sous-tâches vivent dans une colonne jsonb de la table `todos` existante :
-- un tableau d'objets { "id": "...", "title": "...", "done": false }.
-- Pas de nouvelle table : la sécurité RLS de `todos` les protège déjà.

alter table public.todos
  add column if not exists subtasks jsonb not null default '[]'::jsonb;
