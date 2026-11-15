# Écarts alimentaires + glisser/redimensionner — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suivre les écarts (jours clean, record, écarts de l'année) et permettre de déplacer / redimensionner / modifier les événements perso dans la vue Semaine.

**Architecture:** La logique pure (calcul des séries, arithmétique du glisser) vit dans deux petits modules ES testables sous `lib/`, importés par `app.js` (déjà `type="module"`). L'interface reste dans `app.js` / `styles.css`, en réutilisant `openSheet`, `toast`, `deferDelete`, `refreshPersonal`, `subscribeRealtime`.

**Tech Stack:** HTML/CSS/JS vanilla, Supabase (supabase-js 2.47.10 via CDN), tests `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-cheat-meals-and-drag-design.md`

## Global Constraints

- Fuseau : toutes les dates de jour en `Europe/Paris`, clés `AAAA-MM-JJ` (helpers existants `dayKey`, `addDays`).
- Pas de dépendance nouvelle ; pas de build.
- Copie française, verbatim : « jours clean », « record », « J'ai craqué », « écarts en AAAA », « Déplacé », « Annuler », « Modifier ».
- Seuls les événements `source === "perso"` (table `custom_events`) bougent ; cours et imports → toast « Cours myefrei — non modifiable » / « Événement importé — modifie-le dans son agenda d'origine ».
- Aimantation au quart d'heure ; durée minimale 15 min ; appui long mobile ≈ 400 ms.
- Tout nouveau fichier servi doit être ajouté à `SHELL` dans `sw.js`.

## Review Focus

- Écart noté pour un jour **futur** ou deux écarts **le même jour** : jours clean jamais négatifs, record inchangé par les doublons → test dans Task 1.
- Aucun écart noté : pas de « 0 jour clean » trompeur, juste l'invitation → test Task 1 (`cheatStats([])`).
- Glisser au-delà de minuit ou avant le début de journée : l'événement reste dans [00:00, 24:00] sans changer de durée → test Task 3.
- Tap simple sur un bloc perso (pas de déplacement) : ouvre la fiche, n'écrit rien → vérif navigateur Task 5.
- Défilement vertical au doigt sur mobile par-dessus un bloc perso : ne déclenche pas de déplacement sans appui long → vérif navigateur Task 5.

---

### Task 1: Calcul des séries d'écarts (`lib/cheat-stats.js`)

**Files:**
- Create: `lib/cheat-stats.js`
- Test: `lib/cheat-stats.test.mjs`

**Interfaces:**
- Produces: `cheatStats(days: string[], todayKey: string) -> { clean: number|null, record: number|null, lastDay: string|null, yearCount: number }` — `days` = clés AAAA-MM-JJ (ordre quelconque, doublons possibles).

- [ ] **Step 1: Tests** — `lib/cheat-stats.test.mjs` :
  - `cheatStats([], "2026-11-15")` → `{ clean: null, record: null, lastDay: null, yearCount: 0 }`
  - `cheatStats(["2026-11-15"], "2026-11-15")` → `clean: 0`, `yearCount: 1`
  - `cheatStats(["2026-11-01","2026-11-11"], "2026-11-15")` → `clean: 4`, `record: 10`, `lastDay: "2026-11-11"`
  - série en cours plus longue que les écarts passés : `["2026-01-01","2026-01-03"]`, aujourd'hui `"2026-03-01"` → `clean: 57`, `record: 57`
  - doublons et futur ignorés pour clean : `["2026-11-10","2026-11-10","2026-12-01"]`, aujourd'hui `"2026-11-15"` → `clean: 5`, `yearCount: 1` (doublon compté une fois, futur ignoré)
  - année civile : `["2025-12-31","2026-01-02"]`, aujourd'hui `"2026-01-05"` → `yearCount: 1`
- [ ] **Step 2:** `node --test lib/cheat-stats.test.mjs` → FAIL (module absent).
- [ ] **Step 3:** Implémenter `export function cheatStats(days, todayKey)` : dédoublonner, ignorer `> todayKey`, trier ; écarts en jours via `Date.UTC` sur les clés ; `record = max(gaps entre consécutifs, clean)`.
- [ ] **Step 4:** `node --test lib/cheat-stats.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(ecarts): calcul des séries`.

### Task 2: Écarts dans le Hub (données + carte + fiche)

**Files:**
- Create: `supabase/cheat-meals.sql` (table `cheat_meals(id uuid pk default gen_random_uuid(), user_id uuid default auth.uid() references auth.users on delete cascade, day date not null, label text, created_at timestamptz default now())`, RLS « own », realtime idempotent — même modèle que `goals.sql`)
- Modify: `app.js` — `_store.cheats` (init, logout, `refreshPersonal`, realtime `onPerso`), `ctxCard`, nouvelle `openCheatSheet()`
- Modify: `styles.css`, `sw.js` (`lib/cheat-stats.js` dans `SHELL`)

**Interfaces:**
- Consumes: `cheatStats` (Task 1), `openSheet`, `deferDelete`, `toast`, `oops`.
- Produces: `openCheatSheet(): void`.

- [ ] **Step 1:** SQL file ; `refreshPersonal` charge `cheat_meals` (`select id,day,label order by day desc`), erreur → `[]`.
- [ ] **Step 2:** `ctxCard` : ligne bouton `.ctx-cheat` sous l'entraînement, connecté uniquement — « **N** jours clean · record M j » (`1 jour` au singulier) ; sans écart : « Aucun écart noté ». Clic → `openCheatSheet()`.
- [ ] **Step 3:** `openCheatSheet` : compteur en grand, record, « K écarts en AAAA », liste (date courte — label ou « — »), formulaire « J'ai craqué » (champ quoi, date `max=today` par défaut aujourd'hui) → insert, `sfx("add")`, refresh ; chaque ligne a une croix → `deferDelete` (« Écart supprimé »).
- [ ] **Step 4:** Vérif navigateur (déconnecté : la ligne n'apparaît pas ; `node --check app.js`).
- [ ] **Step 5:** Commit `feat(ecarts): suivi des écarts sur Aujourd'hui`.

### Task 3: Arithmétique du glisser (`lib/drag-math.js`)

**Files:**
- Create: `lib/drag-math.js`, Test: `lib/drag-math.test.mjs`

**Interfaces:**
- Produces:
  - `snap15(min: number) -> number` (arrondi au quart d'heure)
  - `moveRange(s: number, e: number, deltaMin: number) -> { s, e }` (durée conservée, borné à [0, 1440])
  - `resizeEnd(s: number, e: number, deltaMin: number) -> { s, e }` (fin aimantée, `e - s >= 15`, `e <= 1440`)

- [ ] **Step 1: Tests** — `snap15(67) === 60`, `snap15(68) === 75` ; `moveRange(600, 660, 37)` → `{ s: 630, e: 690 }` ; `moveRange(1400, 1430, 60)` → `{ s: 1410, e: 1440 }` ; `moveRange(30, 90, -100)` → `{ s: 0, e: 60 }` ; `resizeEnd(600, 660, -60)` → `{ s: 600, e: 615 }` ; `resizeEnd(600, 660, 1000)` → `{ s: 600, e: 1440 }`.
- [ ] **Step 2:** FAIL. **Step 3:** implémenter. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(semaine): arithmétique du glisser`.

### Task 4: Modifier un événement perso

**Files:** Modify `app.js` (`openEventForm` accepte un événement existant ; bouton « Modifier » dans la fiche perso), `sw.js`.

**Interfaces:**
- Produces: `updateCustomEvent(id: string, patch: {title?, start_at?, end_at?, location?}, { undoLabel?: string } = {}) -> Promise<boolean>` — mise à jour optimiste de `_store.custom`, écriture Supabase, toast `undoLabel` + « Annuler » qui réécrit l'ancien état ; erreur → restaure + `oops`.
- [ ] **Step 1:** `openEventForm(date, start, end, existing?)` : titre « Modifier », champs pré-remplis, submit → `updateCustomEvent(existing.cid, …)` au lieu d'insert.
- [ ] **Step 2:** Fiche perso : bouton « Modifier » → `openEventForm(…, ev)`.
- [ ] **Step 3:** `node --check app.js` ; commit `feat(événements): modifier un événement perso`.

### Task 5: Glisser / redimensionner dans la vue Semaine

**Files:** Modify `app.js` (`weekGrid` : poignée `.ev-rs` sur les blocs perso ; nouvelle `wireCalDrag(days)` appelée dans `renderWeek`), `styles.css`.

**Interfaces:**
- Consumes: `snap15`, `moveRange`, `resizeEnd` (Task 3), `updateCustomEvent` (Task 4), `data-top0` / `data-px` de `.cal`.
- [ ] **Step 1:** Pointer events sur `.ev.src-perso` : souris → démarre après 4 px ; tactile → après appui long 400 ms (annulé si le doigt bouge > 8 px avant). Pendant : `top`/`height` du bloc mis à jour, libellé horaire live, colonne cible via `elementFromPoint` sur `.cal-col` (ordinateur). Fin : `updateCustomEvent(…, { undoLabel: "Déplacé" })`. Aucun mouvement → laisser le clic ouvrir la fiche ; mouvement → supprimer le clic suivant.
- [ ] **Step 2:** Poignée `.ev-rs` (bas du bloc, 8 px, curseur `ns-resize`) → `resizeEnd`.
- [ ] **Step 3:** Blocs non perso : appui long/glisser → toast lecture seule (une fois par geste).
- [ ] **Step 4:** Vérif navigateur des 5 points de Review Focus applicables (créer un événement perso nécessite la connexion : sinon vérifier sur un bloc injecté et le dire).
- [ ] **Step 5:** Commit `feat(semaine): glisser et redimensionner les événements perso` ; push.
