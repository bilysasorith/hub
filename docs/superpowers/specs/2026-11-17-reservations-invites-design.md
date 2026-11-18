# Réservations de créneaux par des invités — design

Date : 2026-11-17 · Statut : à valider

## Intention

Des amis et camarades de projet ouvrent le Hub (lien public, sans compte) et demandent un créneau
pour se voir ou bosser ensemble. Bily valide ou refuse depuis son compte. Aujourd'hui ça se fait
par messages ; le but est qu'ils voient directement quand il est libre et qu'une demande acceptée
atterrisse toute seule dans l'agenda.

## Objectifs

- Un invité voit la semaine avec les cours (déjà publics) et des blocs **« Occupé »** pour tout le
  reste (Teams, Google, événements perso), sans titre ni détail.
- Il demande un créneau : bouton « Demander un créneau » **ou** tap sur un endroit vide de la vue Semaine.
- Formulaire : prénom/nom (obligatoire), motif (obligatoire, court), contact libre (facultatif :
  numéro, Insta…), e-mail (facultatif : « pour recevoir la réponse »).
- Bily, connecté, voit les demandes en attente et choisit **Accepter** / **Refuser**.
  Accepter crée un événement perso (`custom_events`) « Nom — motif ».
- L'invité connaît la réponse :
  1. en revenant sur le Hub : son navigateur se souvient de ses demandes et affiche le statut ;
  2. par e-mail s'il en a laissé un (envoyé depuis le Gmail de Bily) ;
  3. Bily peut aussi le contacter lui-même via le contact laissé.

## Non-objectifs

- Pas de comptes invités, pas de modification/annulation par l'invité (il redemande ou écrit à Bily).
- Pas de créneaux récurrents, pas de durée imposée (l'invité choisit début/fin, 15 min à 4 h).
- Pas de Cal.com pour l'instant (envisagé plus tard, séparément).

## Anti-objectifs (échec même si « ça marche »)

- Un invité voit le titre, le lieu ou les participants d'un événement privé.
- Un invité peut lire les demandes des autres (noms, e-mails, contacts).
- Le formulaire public sert à inonder Bily de demandes ou à envoyer des e-mails à des inconnus
  (l'e-mail ne part qu'après une décision de Bily, jamais à la soumission).

## Contraintes

- Hub = site statique GitHub Pages + Supabase (auth, RLS, realtime). `planning.json` est public.
- Les tables privées (`calendar_events`, `custom_events`) ne sont lisibles que par leur propriétaire (RLS).
- Une seule personne reçoit des demandes : le propriétaire du Hub (`HUB_USER_ID` existant).
- iPhone : notifications web seulement en mode écran d'accueil (chantier notifications en cours, séparé).

## Approches envisagées

- **A. Tout dans le Hub avec Supabase** — choisie. Contrôle total, voit tous les agendas, validation par Bily.
- **B. Page de réservation Google Agenda** — confirme automatiquement (pas de validation), ne voit pas Teams, hors Hub.
- **C. Cal.com** — validation et e-mails inclus, mais autre site, ne voit pas Teams, demandes gérées ailleurs.
  Bily pourra y revenir plus tard.

## Conception (A)

### Données (Supabase)

`booking_requests` :
`id uuid`, `owner_id uuid` (= propriétaire), `start_at`, `end_at`, `name text` (≤ 60),
`reason text` (≤ 200), `contact text` (≤ 100, facultatif), `email text` (facultatif, format vérifié),
`status text` ('pending' | 'accepted' | 'declined'), `guest_token uuid` (généré côté invité),
`decided_at`, `event_id uuid` (événement créé à l'acceptation), `created_at`.

RLS : le propriétaire lit et met à jour ses demandes. **Aucun accès direct pour les invités** :
tout passe par trois fonctions SQL `security definer` appelables avec la clé publique :

- `busy_slots(from, to)` → liste `{start_at, end_at}` des `calendar_events` + `custom_events` du
  propriétaire, **sans aucune autre colonne**. Fenêtre max 31 jours.
- `request_booking(start_at, end_at, name, reason, contact, email, guest_token)` → valide
  (dans le futur et à moins de 4 semaines, durée 15 min–4 h, longueurs, ne chevauche pas un créneau
  occupé ; le chevauchement avec un cours n'est pas vérifiable en SQL → voir « laissé au builder »),
  applique les limites, insère en 'pending'.
- `my_bookings(guest_token)` → statut de ses propres demandes (date, heures, statut), rien d'autre.

Limites anti-abus : ≤ 3 demandes en attente par `guest_token`, ≤ 30 en attente au total ;
au-delà, refus avec un message clair. (Un invité peut changer de `guest_token` en vidant son
navigateur : la limite globale de 30 est le vrai garde-fou.)

L'adresse Gmail d'envoi et son mot de passe d'application sont des secrets de la fonction e-mail :
jamais dans le dépôt, qui est public.

### Vue invité (non connecté)

- Vue Semaine actuelle + blocs gris « Occupé » (données de `busy_slots`).
- Bouton « Demander un créneau » (barre du haut ou FAB) et tap sur un vide → formulaire pré-rempli
  avec l'heure tapée (même logique que `wireCalAdd`, arrondi au quart d'heure, durée 1 h).
- `guest_token` + liste des demandes stockés dans `localStorage` ; en haut de la vue :
  « Ta demande du jeu. 19 à 14:00 : en attente / acceptée ✓ / refusée ».
- Les demandes en attente de l'invité apparaissent en pointillés sur sa vue.

### Vue propriétaire (connecté)

- Bandeau « 2 demandes en attente » → feuille listant chaque demande (nom, motif, créneau, contact,
  e-mail, avertissement si elle chevauche désormais un événement) avec **Accepter** / **Refuser**.
- Les demandes en attente apparaissent en pointillés dans la vue Semaine ; tap → même feuille.
- Accepter : crée `custom_events` « Nom — motif », passe la demande à 'accepted'.
- Realtime sur `booking_requests` pour voir arriver une demande sans recharger.
- Si les notifications web sont activées : notif « Nouvelle demande de X pour jeu. 14:00 ».

### E-mail de réponse

- Fonction Supabase `booking-email`, appelée par le Hub du propriétaire après sa décision
  (avec son jeton de session ; la fonction vérifie que c'est bien le propriétaire et que la
  demande lui appartient).
- Envoi SMTP Gmail (compte de Bily, **mot de passe d'application** créé par Bily, stocké en secret
  de la fonction). Texte court : « Bily a accepté/refusé ta demande du … ».
- Pas d'e-mail si le champ est vide. Jamais d'e-mail à la soumission.

## Décidé par Bily

- Approche A ; invités = amis et camarades de projet.
- Occupé sans détails pour Teams / Google / perso ; cours visibles comme aujourd'hui.
- Accès via bouton **et** tap sur un vide.
- Réponse : retour sur le Hub + contact libre + e-mail facultatif automatique.

## Mes choix (à corriger si besoin)

- Cours marqués « je n'y vais pas » : restent affichés comme cours (le planning est public, la
  liste des cours sautés ne l'est pas).
- Durée 15 min–4 h ; demandes jusqu'à 4 semaines à l'avance.
- Limites anti-abus : 3 en attente par invité, 30 au total.
- Envoi e-mail via Gmail SMTP (port 465) ; si Supabase bloque la connexion, repli sur l'API HTTP
  de Brevo (gratuit, expéditeur = adresse Gmail de Bily vérifiée).
- Notification au propriétaire seulement si le chantier notifications est terminé ; sinon le bandeau suffit.

## Laissé au builder

- Le chevauchement avec un cours n'est pas vérifiable en SQL (planning.json hors base) : vérification
  côté client avant envoi + avertissement côté propriétaire. Acceptable : Bily valide de toute façon.
- Mise en page exacte du formulaire et de la feuille des demandes, dans le style existant (`openSheet`).
- Fuseau : tout en Europe/Paris comme le reste du Hub.
