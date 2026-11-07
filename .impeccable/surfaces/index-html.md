---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: []
---

## Direction contract

THESIS: Un tableau de bord personnel qui répond « quoi maintenant, où, et quoi à faire » en un coup d'œil. Refuse l'agenda-grille générique en vue par défaut : la vue d'entrée est une pile verticale priorisée (le prochain cours en grand), pas une semaine en colonnes.

OWN-WORLD: Langage visuel épinglé de Lift. Fond #0D1013, surfaces #161B20/#212830, lignes #2B333C, texte #E9EDF0, muted #8B96A1, accent bleu #4C86FF, vert #3DBE7E (fait), ambre #E8AA3A (urgent). Titres Saira Condensed capitales ; corps IBM Plex Sans ; horaires/chiffres IBM Plex Mono tabulaire. Cartes à coins arrondis 14px, barre d'onglets fixe en bas, pastille de statut pulsée.

STORY: L'étudiant ouvre l'app, voit immédiatement son prochain cours (heure, salle, prof) et ce qui est à faire aujourd'hui ; bascule vers la semaine ou la to-do complète ; coche une tâche et la retrouve cochée sur ses autres appareils.

FIRST VIEWPORT: En-tête (jour + date, pastille « live »), puis carte « MAINTENANT / PROCHAIN » pleine largeur avec horaire géant mono + salle + prof, puis le reste des cours du jour en liste compacte, puis un bandeau « À faire aujourd'hui » (3 tâches max + compteur). Onglets fixes en bas : Aujourd'hui · Semaine · À faire.

FORM: Pile de cartes priorisée (dashboard mobile-first), position 1 de ma liste de structures. Direction épinglée par l'utilisateur (cohérence Lift) — pas de tirage concept-seed. seed: none (pinned direction, no roll).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
