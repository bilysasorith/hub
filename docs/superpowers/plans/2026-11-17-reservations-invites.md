# Réservations de créneaux par des invités — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un invité (sans compte) voit les disponibilités de Bily et demande un créneau ; Bily accepte ou refuse ; l'invité l'apprend sur le Hub ou par e-mail.

**Architecture:** Table `booking_requests` sans accès direct pour les invités ; trois fonctions SQL `security definer` (`busy_slots`, `request_booking`, `my_bookings`) appelées avec la clé publique. Logique de validation pure dans `lib/booking.js` (testée, partagée par la vue invité et la vue propriétaire). E-mail de réponse via une Edge Function `booking-email` (SMTP Gmail).

**Tech Stack:** JS vanilla (modules ES), Supabase (Postgres + RLS + RPC + Realtime + Edge Functions Deno), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-reservations-invites-design.md`

## Global Constraints

- Durée d'une demande : 15 min à 4 h ; début dans le futur et à moins de 28 jours.
- Champs : `name` obligatoire ≤ 60 car. ; `reason` obligatoire ≤ 200 ; `contact` facultatif ≤ 100 ; `email` facultatif, format vérifié, ≤ 254.
- Limites : ≤ 3 demandes `pending` par `guest_token`, ≤ 30 `pending` au total.
- `busy_slots` ne renvoie que `start_at`, `end_at` ; fenêtre ≤ 31 jours.
- Aucun e-mail à la soumission ; seulement après décision de Bily.
- Adresse Gmail d'envoi et mot de passe d'application : secrets de la fonction, jamais dans le dépôt (public).
- Textes UI en français, tutoiement, style existant (`openSheet`, `.btn`, `.btn-ghost`, `.sheet-note`).
- Fuseau Europe/Paris partout (helpers existants `dayKey`, `parisMinutes`, `fmtTime`).
- Le propriétaire est l'utilisateur dont l'UUID est dans la table `hub_owner` (une ligne), pas déduit.

## Review Focus

- Deux demandes simultanées sur le même créneau : la 2ᵉ doit être refusée (« créneau plus libre ») si la 1ʳᵉ a été acceptée ; deux `pending` qui se chevauchent sont permises (Bily tranche) — test SQL Task 1.
- Créneau qui chevauche un événement devenu occupé après la demande : la feuille propriétaire affiche un avertissement — test `conflictsWith` Task 2.
- Invité qui vide son navigateur : il perd l'historique local ; `my_bookings` avec un jeton inconnu renvoie `[]` sans erreur — vérif Task 1.
- Demande à cheval sur minuit ou sur un changement d'heure : durée calculée en ms, pas en heures locales — test Task 2.
- Champs avec HTML (`<script>`) : affichés échappés via `esc()` côté propriétaire — vérif Task 4.

---

### Task 1: Schéma et fonctions SQL

**Files:**
- Create: `supabase/bookings.sql`

**Interfaces:**
- Produces:
  - table `public.hub_owner(user_id uuid primary key)` — une ligne, insérée par le SQL depuis l'UUID de Bily (remplacer le placeholder `<HUB_USER_ID>` au moment de l'exécution, ne pas committer l'UUID).
  - table `public.booking_requests(id uuid pk default gen_random_uuid(), owner_id uuid, start_at timestamptz, end_at timestamptz, name text, reason text, contact text, email text, status text default 'pending' check in ('pending','accepted','declined'), guest_token uuid not null, decided_at timestamptz, event_id uuid, emailed_at timestamptz, created_at timestamptz default now())`, RLS : `select`/`update` si `auth.uid() = owner_id` ; pas d'`insert` direct.
  - `public.busy_slots(p_from timestamptz, p_to timestamptz) returns table(start_at timestamptz, end_at timestamptz)` — union `calendar_events` + `custom_events` du propriétaire (une demande acceptée y figure via l'événement perso créé) ; exception si `p_to - p_from > 31 days`. `request_booking` refuse un créneau qui chevauche `busy_slots`.
  - `public.request_booking(p_start timestamptz, p_end timestamptz, p_name text, p_reason text, p_contact text, p_email text, p_token uuid) returns uuid` — lève une exception au message français lisible (`'Créneau déjà pris'`, `'Trop de demandes en attente'`, …) ; trim des champs ; `contact`/`email` vides → null.
  - `public.my_bookings(p_token uuid) returns table(id uuid, start_at timestamptz, end_at timestamptz, status text)`.
  - `grant execute` des trois fonctions à `anon, authenticated` ; `alter publication supabase_realtime add table public.booking_requests`.

- [ ] **Step 1:** Écrire `supabase/bookings.sql` (idempotent : `if not exists`, `create or replace`, `drop policy if exists`).
- [ ] **Step 2:** Bily lance le SQL dans l'éditeur Supabase (avec son UUID à la place du placeholder).
- [ ] **Step 3: Vérifier avec la clé publique** (config.js) :
  `curl -s "$URL/rest/v1/rpc/busy_slots" -H "apikey: $PUB" -H "Content-Type: application/json" -d '{"p_from":"2026-11-16T00:00:00Z","p_to":"2026-11-23T00:00:00Z"}'`
  Attendu : tableau d'objets avec **exactement** les clés `start_at`, `end_at`.
  `curl … /rest/v1/booking_requests -H "apikey: $PUB"` → `[]` (RLS).
  `request_booking` avec fin avant début → erreur `Durée invalide` ; `my_bookings` avec un UUID aléatoire → `[]`.
  Une demande valide puis une 4ᵉ avec le même jeton → `Trop de demandes en attente`. Supprimer les demandes de test ensuite (en SQL).
- [ ] **Step 4: Commit** `git add supabase/bookings.sql && git commit -m "feat(resa): schéma et fonctions SQL des demandes de créneau"`

### Task 2: Logique pure `lib/booking.js`

**Files:**
- Create: `lib/booking.js`, `lib/booking.test.mjs`

**Interfaces:**
- Produces:
  - `validateRequest({ start, end, name, reason, contact, email }, nowMs) -> { ok: true } | { ok: false, field: string, error: string }` (start/end = ISO). Mêmes règles que Global Constraints.
  - `conflictsWith(range: {start, end}, busy: Array<{start, end}>) -> boolean` (chevauchement strict : se toucher bord à bord n'est pas un conflit).
  - `loadGuest(storage) -> { token: string, ids: string[] }` (crée le jeton via `crypto.randomUUID()` s'il n'existe pas ; clé `hub.guest`) ; `rememberRequest(storage, id) -> void`.

- [ ] **Step 1: Tests** dans `lib/booking.test.mjs` :
  - `validateRequest` : nom vide → `{ok:false, field:"name"}` ; 14 min → `field:"end"` ; 4 h pile → ok ; 4 h 15 → erreur ; début passé → `field:"start"` ; début à J+29 → erreur ; e-mail `"a@b"` → `field:"email"` ; e-mail vide → ok ; motif de 201 car. → erreur.
  - Créneau `2027-03-28T00:30:00Z`→`02:30:00Z` (changement d'heure) : durée 2 h → ok.
  - `conflictsWith` : 14:00–15:00 vs 15:00–16:00 → false ; vs 14:30–15:30 → true ; liste vide → false.
  - `loadGuest` avec un faux storage vide → jeton UUID, `ids: []` ; deuxième appel → même jeton ; `rememberRequest` puis `loadGuest` → id présent.
- [ ] **Step 2:** `node --test lib/booking.test.mjs` → FAIL (module absent).
- [ ] **Step 3:** Implémenter `lib/booking.js`.
- [ ] **Step 4:** `node --test lib/` → PASS (y compris les tests existants).
- [ ] **Step 5: Commit** `feat(resa): validation et stockage invité des demandes`.

### Task 3: Vue invité

**Files:**
- Modify: `app.js` (vue Semaine `renderWeek`, `wireCalAdd`, rendu du haut de page), `styles.css`, `sw.js` (ajouter `lib/booking.js` à `SHELL`)

**Interfaces:**
- Consumes: RPC `busy_slots`, `request_booking`, `my_bookings` (Task 1) via le client Supabase (`getStore().sb.rpc(...)`, utilisable sans session) ; `validateRequest`, `conflictsWith`, `loadGuest`, `rememberRequest` (Task 2).
- Produces: `openBookingForm(dateKey?: string, start?: "HH:MM", end?: "HH:MM")` ; `_guest = { busy: [], mine: [] }`.

- [ ] **Step 1:** Hors session : charger `busy_slots` pour la semaine affichée (au rendu de la semaine et à `visibilitychange`), et `my_bookings(token)`.
- [ ] **Step 2:** Rendre les blocs occupés dans la vue Semaine (classe `ev src-busy`, texte « Occupé », non cliquables) et les demandes de l'invité en `pending` (classe `is-request`, pointillés, libellé « Ta demande »).
- [ ] **Step 3:** `wireCalAdd` : hors session, un tap sur un vide appelle `openBookingForm` au lieu de ne rien faire ; bouton « Demander un créneau » (FAB existant hors session ou barre du haut).
- [ ] **Step 4:** `openBookingForm` : champs date, début, fin, nom, motif, contact, e-mail (libellé « E-mail — pour recevoir la réponse »). Avant envoi : `validateRequest` (erreur sous le champ) puis `conflictsWith` avec `busy` + cours du jour → message « Ce créneau est déjà pris ». Envoi → `rememberRequest` → toast « Demande envoyée à Bily ».
- [ ] **Step 5:** Bandeau en haut (vues Aujourd'hui et Semaine) : une ligne par demande de `my_bookings` des 28 derniers jours : « Ta demande du jeu. 19 à 14:00 : en attente / acceptée ✓ / refusée ».
- [ ] **Step 6: Vérifier** en local (`preview_start hub`, navigateur non connecté) : blocs Occupé visibles sans titre, tap sur un vide → formulaire pré-rempli, envoi d'une demande de test → bandeau « en attente ». `node --check app.js`.
- [ ] **Step 7: Commit** `feat(resa): vue invité (occupé, formulaire, statut)`.

### Task 4: Vue propriétaire

**Files:**
- Modify: `app.js` (`refreshPersonal`, `subscribeRealtime`, `ctxCard`, vue Semaine), `styles.css`

**Interfaces:**
- Consumes: table `booking_requests` (RLS propriétaire), `conflictsWith` (Task 2).
- Produces: `_store.bookings: Array<row>` (pending + décidées des 28 derniers jours) ; `decideBooking(id: string, accept: boolean) -> Promise<boolean>` ; `openBookingsSheet(id?: string)`.

- [ ] **Step 1:** Charger `booking_requests` dans `refreshPersonal` (+ cache `savePersonal`, + Realtime sur la table).
- [ ] **Step 2:** Ligne `ctxCard` « N demandes en attente » (si N > 0) → `openBookingsSheet()`. Demandes `pending` en pointillés dans la vue Semaine ; tap → `openBookingsSheet(id)`.
- [ ] **Step 3:** Feuille : par demande, nom, motif, créneau, contact, e-mail (tous via `esc()`), avertissement « Chevauche maintenant : un autre événement » si `conflictsWith` avec les événements du jour ; boutons Accepter / Refuser.
- [ ] **Step 4:** `decideBooking` : si accepter, insert `custom_events { title: "<name> — <reason>", start_at, end_at }` puis update `booking_requests { status, decided_at: now, event_id }` ; si refuser, update seul. Erreur → `oops(...)`. Puis appel de la fonction e-mail (Task 5) si `email` non vide, sans bloquer l'UI.
- [ ] **Step 5: Vérifier** connecté (Bily, sur le Hub déployé ou en local) : la demande de test de Task 3 apparaît en pointillés et dans la feuille ; un nom contenant `<b>x</b>` s'affiche littéralement ; Accepter → événement perso créé, côté invité le bandeau passe à « acceptée ✓ ».
- [ ] **Step 6: Commit** `feat(resa): demandes en attente, accepter / refuser`.

### Task 5: E-mail de réponse

**Files:**
- Create: `supabase/functions/booking-email/index.ts`
- Modify: `supabase/config.toml` (section `[functions.booking-email]`, `verify_jwt = true`), `app.js` (appel depuis `decideBooking`)

**Interfaces:**
- Consumes: `booking_requests` (statut décidé), session du propriétaire.
- Produces: `POST /functions/v1/booking-email { id }` → `{ sent: boolean }`.

- [ ] **Step 1:** Fonction : vérifie le jeton (`supabase.auth.getUser`), que l'utilisateur est dans `hub_owner`, que la demande lui appartient, est décidée, a un `email`, et n'a pas déjà été notifiée (`emailed_at` nul). Envoi SMTP Gmail port 465 (`npm:nodemailer@6.9.16`), secrets `GMAIL_USER`, `GMAIL_APP_PASSWORD`. Sujet : « Ta demande de créneau du <jour> » ; corps : « Bily a accepté ✓ / n'est pas dispo pour ta demande du <jour> <début>–<fin>. » ; met `emailed_at`.
- [ ] **Step 2:** Bily crée un mot de passe d'application Google ; déploiement : `npx supabase@2.54.11 functions deploy booking-email` et `secrets set GMAIL_USER=… GMAIL_APP_PASSWORD=…` (valeurs saisies par Bily).
- [ ] **Step 3: Vérifier** : accepter une demande de test avec l'adresse de Bily comme e-mail invité → e-mail reçu ; rappeler la fonction → `{ sent: false }` (pas de doublon). Si SMTP bloqué (timeout), basculer sur l'API HTTP Brevo (même interface, secret `BREVO_API_KEY`) et le noter dans le spec.
- [ ] **Step 4: Commit** `feat(resa): e-mail de réponse à l'invité`, puis push et vérification sur le Hub déployé.

### Task 6 (si les notifications de signature sont en place): notifier Bily

**Files:**
- Modify: `supabase/bookings.sql` (trigger `after insert` → `net.http_post` vers `notify-sign` avec `{ "booking": id }`), `supabase/functions/notify-sign/index.ts`

- [ ] **Step 1:** `notify-sign` : si le corps contient `booking`, envoyer « Nouvelle demande de <name> · <jour> <début> » (url `./`) aux abonnements du propriétaire, puis sortir.
- [ ] **Step 2: Vérifier** : une demande invité → notification sur l'iPhone de Bily.
- [ ] **Step 3: Commit** `feat(resa): notification de nouvelle demande`.
