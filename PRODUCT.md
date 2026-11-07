# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

static HTML/CSS/JS vanilla (décidé par l'utilisateur ; pas de framework). Déploiement GitHub Pages.

## Users

Utilisateur unique : un étudiant de l'Efrei (I3). Situation : en déplacement entre cours,
chez lui, sur plusieurs appareils (iPhone, PC portable, PC fixe). Job : savoir d'un coup d'œil
« qu'est-ce que j'ai maintenant / aujourd'hui » (prochain cours, salle) et « qu'est-ce que
j'ai à faire » (tâches), sans ressaisir quoi que ce soit.

## Product Purpose

Un « hub » perso pour organiser sa vie étudiante : emploi du temps (importé automatiquement
depuis le planning myefrei) + to-do list personnelle synchronisée entre tous ses appareils.
Succès = l'app répond en < 3 secondes à « j'ai quoi là, et où » et « qu'est-ce qui est à faire ».

## Positioning

Agrège en un seul écran, installable comme une app, deux choses aujourd'hui séparées :
le planning officiel (en lecture seule, toujours à jour via robot) et des tâches perso
(en écriture, synchronisées). Ni myefrei ni un agenda générique ne font les deux à la fois
pour cet usage.

## Operating Context

- Consultation très fréquente et brève, souvent sur téléphone, parfois en marchant.
- Le planning vient d'un flux ICS myefrei rafraîchi côté serveur toutes les ~3 h ; l'app lit
  un `planning.json` servi en same-origin (le flux n'autorise pas le CORS).
- Les tâches vivent dans Supabase (auth magic-link, table `todos`, RLS par utilisateur).
- Doit fonctionner hors-ligne pour la dernière vue chargée (PWA, service worker).

## Capabilities and Constraints

- Vues : **Aujourd'hui** (cours du jour + tâches du jour), **Semaine** (agenda),
  **À faire** (to-do complète).
- Champs d'un cours disponibles : horaire début/fin, titre, salle(s), enseignant, groupes,
  code module, activité, modalité (présentiel/distanciel).
- Tâche : titre, fait/pas fait, date d'échéance optionnelle.
- Contraintes : statique (pas de backend maison), gratuit, 1 seul utilisateur.
- Le token du flux myefrei reste privé (secret GitHub), jamais dans le code livré.

## Brand Commitments

- Nom de travail : **Hub** (renommable).
- Langage visuel **épinglé par l'utilisateur** : cohérence avec l'app sœur Lift —
  fond sombre (#0D1013 / #161B20), accent bleu (#4C86FF), polices IBM Plex Sans/Mono +
  Saira Condensed (titres condensés capitales), chiffres tabulaires. Référence :
  `C:\Users\Utilisateur\Desktop\Lift\maquette\lift.html`.

## Evidence on Hand

- Flux ICS myefrei réel et fonctionnel (45 cours testés le 2026-11-02).
- `planning.json` généré depuis les vraies données (script `scripts/fetch-planning.mjs`).
- Maquette de l'app sœur Lift (langage visuel de référence).
- Pas encore de projet Supabase créé (l'utilisateur doit le créer ; ne pas inventer d'URL/clé).

## Product Principles

- **Coup d'œil d'abord** : la réponse à « maintenant » doit être lisible en une seconde,
  gros chiffres, hiérarchie forte.
- **Jamais de ressaisie** : le planning s'importe seul ; seules les tâches se tapent.
- **Même état partout** : les tâches sont identiques sur les 3 appareils, en temps réel.
- **Robuste hors-ligne** : la dernière vue reste consultable sans réseau.
- **Lecture seule vs écriture clairement distinctes** : le planning ne se modifie pas,
  les tâches oui.

## Accessibility & Inclusion

Cibles de contraste AA en thème sombre ; zones tactiles ≥ 44px (usage mobile une main) ;
lisible en extérieur (contraste élevé).
