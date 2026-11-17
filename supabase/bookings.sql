-- Demandes de créneau des invités (réservation sans compte). Idempotent.
-- Les invités n'ont AUCUN accès direct aux tables : tout passe par des
-- fonctions security definer (busy_slots, request_booking, my_bookings).

-- ── Propriétaire du Hub ────────────────────────────────────────────────
create table if not exists public.hub_owner (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.hub_owner enable row level security;
-- Aucune policy : table illisible via l'API, seules les fonctions
-- security definer la consultent.

-- ⚠ Remplacer <HUB_USER_ID> par l'UUID du compte avant d'exécuter ce script
-- (ne PAS committer l'UUID : dépôt public).
insert into public.hub_owner (user_id)
values ('<HUB_USER_ID>')
on conflict do nothing;

-- ── Demandes ───────────────────────────────────────────────────────────
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  name text not null,
  reason text not null,
  contact text,
  email text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  guest_token uuid not null,
  decided_at timestamptz,
  event_id uuid,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists booking_requests_owner_status_idx
  on public.booking_requests (owner_id, status);
create index if not exists booking_requests_token_idx
  on public.booking_requests (guest_token);

alter table public.booking_requests enable row level security;

-- Pas d'accès direct pour les invités (anon) ; le propriétaire lit et met à jour.
revoke all on public.booking_requests from anon;
revoke all on public.booking_requests from authenticated;
grant select, update on public.booking_requests to authenticated;

drop policy if exists "owner reads bookings" on public.booking_requests;
create policy "owner reads bookings" on public.booking_requests
  for select using (auth.uid() = owner_id);

drop policy if exists "owner updates bookings" on public.booking_requests;
create policy "owner updates bookings" on public.booking_requests
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
-- Pas de policy insert/delete : l'insertion passe uniquement par request_booking().

-- ── Créneaux occupés (uniquement start_at / end_at) ────────────────────
create or replace function public.busy_slots(p_from timestamptz, p_to timestamptz)
returns table (start_at timestamptz, end_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Période invalide';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception 'Période trop longue (31 jours maximum)';
  end if;

  select user_id into v_owner from hub_owner limit 1;
  if v_owner is null then
    return;
  end if;

  return query
    select s.s, s.e from (
      select c.start_at as s, coalesce(c.end_at, c.start_at) as e
        from calendar_events c
       where c.user_id = v_owner
      union all
      select x.start_at as s, coalesce(x.end_at, x.start_at) as e
        from custom_events x
       where x.user_id = v_owner
    ) s
    where s.s < p_to and s.e > p_from
    order by s.s;
end;
$$;

-- ── Création d'une demande ─────────────────────────────────────────────
create or replace function public.request_booking(
  p_start timestamptz,
  p_end timestamptz,
  p_name text,
  p_reason text,
  p_contact text,
  p_email text,
  p_token uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := nullif(btrim(p_name), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_contact text := nullif(btrim(p_contact), '');
  v_email text := nullif(btrim(p_email), '');
  v_id uuid;
begin
  select user_id into v_owner from hub_owner limit 1;
  if v_owner is null then
    raise exception 'Réservation indisponible';
  end if;

  if p_token is null then
    raise exception 'Jeton invalide';
  end if;
  if p_start is null or p_end is null or p_end <= p_start
     or p_end - p_start < interval '15 minutes'
     or p_end - p_start > interval '4 hours' then
    raise exception 'Durée invalide';
  end if;
  if p_start <= now() then
    raise exception 'Le créneau doit être dans le futur';
  end if;
  if p_start >= now() + interval '28 days' then
    raise exception 'Créneau trop éloigné (28 jours maximum)';
  end if;

  if v_name is null then raise exception 'Nom requis'; end if;
  if char_length(v_name) > 60 then raise exception 'Nom trop long (60 caractères maximum)'; end if;
  if v_reason is null then raise exception 'Motif requis'; end if;
  if char_length(v_reason) > 200 then raise exception 'Motif trop long (200 caractères maximum)'; end if;
  if v_contact is not null and char_length(v_contact) > 100 then
    raise exception 'Contact trop long (100 caractères maximum)';
  end if;
  if v_email is not null then
    if char_length(v_email) > 254 then raise exception 'Adresse e-mail trop longue'; end if;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'Adresse e-mail invalide';
    end if;
  end if;

  -- Sérialise les demandes pour que les limites et le chevauchement soient fiables.
  perform pg_advisory_xact_lock(hashtext('booking_requests'));

  if (select count(*) from booking_requests
       where guest_token = p_token and status = 'pending' and start_at > now()) >= 3 then
    raise exception 'Trop de demandes en attente';
  end if;
  if (select count(*) from booking_requests
       where owner_id = v_owner and status = 'pending' and start_at > now()) >= 30 then
    raise exception 'Trop de demandes en attente';
  end if;

  if exists (select 1 from busy_slots(p_start, p_end)) then
    raise exception 'Créneau déjà pris';
  end if;

  insert into booking_requests
    (owner_id, start_at, end_at, name, reason, contact, email, guest_token)
  values
    (v_owner, p_start, p_end, v_name, v_reason, v_contact, v_email, p_token)
  returning id into v_id;

  return v_id;
end;
$$;

-- ── Suivi des demandes d'un invité (par jeton) ─────────────────────────
create or replace function public.my_bookings(p_token uuid)
returns table (id uuid, start_at timestamptz, end_at timestamptz, status text)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.start_at, b.end_at, b.status
    from booking_requests b
   where p_token is not null and b.guest_token = p_token
   order by b.start_at;
$$;

-- ── Droits d'exécution ─────────────────────────────────────────────────
revoke all on function public.busy_slots(timestamptz, timestamptz) from public;
revoke all on function public.request_booking(timestamptz, timestamptz, text, text, text, text, uuid) from public;
revoke all on function public.my_bookings(uuid) from public;
grant execute on function public.busy_slots(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.request_booking(timestamptz, timestamptz, text, text, text, text, uuid) to anon, authenticated;
grant execute on function public.my_bookings(uuid) to anon, authenticated;

-- ── Realtime (gardé pour pouvoir relancer le script) ───────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'booking_requests'
  ) then
    alter publication supabase_realtime add table public.booking_requests;
  end if;
end $$;
