# Écarts alimentaires + glisser/redimensionner les événements perso

Date : 2026-11-15 · Statut : approuvé dans la conversation (« Oui les trois »).

## 1. Suivi des écarts (cheat meals)

**Pourquoi** : un écart est un faux pas à éviter, pas une récompense prévue. L'écran valorise
la série (jours clean), pas un quota.

**Objectifs**
- Voir d'un coup d'œil « X jours clean » depuis le dernier écart, et son record.
- Noter un écart en 2 gestes : « J'ai craqué », quoi (facultatif, ex. Burger King), date (aujourd'hui par défaut).
- Voir sur l'année combien d'écarts et la liste datée.

**Non-objectifs** : calories, photos, quota hebdomadaire, notifications.

**Règles**
- Comptage par jour calendaire (Europe/Paris) : un écart aujourd'hui → 0 jour clean.
- Jours clean = aujourd'hui − jour du dernier écart. Aucun écart noté → pas de compteur, juste l'invitation.
- Record = plus grand écart entre deux écarts consécutifs, et la série en cours si elle est plus longue.
- « Cette année » = écarts de l'année civile en cours.

**Interface**
- Aujourd'hui, carte contexte (à côté de l'entraînement) : ligne « N jours clean · record M j », tappable.
- Feuille : compteur en grand, record, « K écarts en AAAA » + liste (date — quoi), bouton « J'ai craqué ».
- Suppression d'une entrée : toast « Annuler » (même mécanique que les tâches).

**Données** : table Supabase `cheat_meals` (id uuid, user_id, day date, label text, created_at),
RLS par propriétaire, temps réel. Fichier `supabase/cheat-meals.sql` à lancer une fois.

**Approches écartées** : stockage navigateur seul (pas de synchro téléphone/PC) ; réutiliser les
tâches avec une étiquette (pollue la to-do).

## 2. Glisser / redimensionner les événements perso (vue Semaine)

**Pourquoi** : décaler ou rallonger un créneau sans ressaisir.

**Périmètre** : uniquement les événements créés dans le Hub (`custom_events`, source « perso »).
Cours myefrei et événements Google/Teams viennent de flux ICS en lecture seule : non déplaçables
(toast explicatif). Écriture vers Google/Outlook (OAuth) = hors périmètre.

**Comportement**
- Déplacer : maintenir le bloc et glisser ; aimanté au quart d'heure ; peut changer de jour (colonne) sur ordinateur.
- Durée : poignée en bas du bloc ; 15 min minimum.
- Pendant le geste : l'heure affichée suit (« 14:15–15:30 »).
- Au relâchement : mise à jour Supabase ; toast « Déplacé · Annuler » qui remet l'ancien horaire.
- Mobile : appui long (~0,4 s) avant de glisser pour ne pas gêner le défilement.
- Un tap simple ouvre toujours la fiche.
- Fiche perso : bouton « Modifier » (titre, jour, début, fin, lieu) pour un réglage précis.

**Choix laissés au constructeur** : seuil de déclenchement (quelques pixels), rendu du bloc pendant
le geste, gestion du défilement automatique en bord d'écran (non requis).
