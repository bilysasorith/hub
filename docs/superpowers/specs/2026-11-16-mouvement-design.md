# Mouvement : transitions entre vues + écran d'entrée

Date : 2026-11-16 · Statut : approuvé dans la conversation (« A + B en sombre » → « Oui »).

## Pourquoi

Le Hub doit donner envie d'être montré (capture d'écran filmée, façon reel) sans devenir plus
lent à l'usage : il reste un outil ouvert dix fois par jour.

## Constat

Le thème sombre est déjà le thème par défaut, et les retours de base existent (case cochée,
confettis, feuille qui monte). Ce qui manque, c'est la **continuité** entre les états et un
**moment d'ouverture**.

## Approches

- **A. Mouvement dans l'app** — retenu.
- **B. Écran d'entrée** — retenu.
- **C. « Wrapped » annuel** — écarté pour l'instant : pas assez de données.
- Effets de site vitrine (3D, animation pilotée par le défilement) — écartés : pénibles au quotidien.

## Ce qui est construit

**A. Continuité (API View Transitions, repli sur les animations actuelles)**
- Onglets : l'ancienne vue sort d'un côté, la nouvelle entre de l'autre (sens = sens de l'onglet).
- Semaine précédente / suivante : la grille glisse dans le sens de la navigation.
- Fiches : le bloc tapé (événement, objectif, ligne des écarts, bouton +) s'agrandit pour devenir
  la fiche ; à la fermeture simple, elle se replie dans son bloc.
- Thème clair/sombre : révélation circulaire depuis le bouton.
- Compteurs (jours clean, cours, heures) : défilent jusqu'à leur valeur à l'arrivée sur une vue.
- Cascade des cartes : une seule fois, au lever de l'écran d'entrée.

**B. Écran d'entrée**
- Plein écran : le jour en très grandes capitales (lettres qui montent une à une), le numéro du
  jour en accent, le mois, une barre qui se trace ; puis un rideau se lève sur l'app.
- Durée ≈ 1,3 s + 0,6 s de lever. Un tap le passe.
- Rejoué au plus une fois toutes les 30 minutes (pas à chaque retour sur l'onglet).
- CSS + un petit script en ligne dans `index.html` : il se retire tout seul même si `app.js` échoue.

## Contraintes

- `prefers-reduced-motion` : pas d'écran d'entrée, pas de transitions de vue ; les états restent lisibles.
- Aucune dépendance ; rien n'attend la fin d'une animation pour être utilisable, sauf l'écran d'entrée.
- Navigateur sans View Transitions : comportement actuel conservé.
