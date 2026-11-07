# Hub

PWA perso : emploi du temps (importé de myefrei) + to-do synchronisée. Site statique,
hébergé sur GitHub Pages. Installable sur téléphone et navigateur.

## Comment ça marche

- **Emploi du temps** : un robot GitHub Actions (`.github/workflows/planning.yml`) récupère le
  flux ICS myefrei toutes les ~3 h via `scripts/fetch-planning.mjs`, le transforme en
  `planning.json` et le commit. L'app lit ce fichier (même origine, pas de problème de CORS).
  Le flux n'autorise pas le CORS, d'où la récupération côté serveur.
- **To-do** : synchronisée entre appareils via Supabase (auth lien magique + table `todos` + RLS).
- **PWA** : `manifest.json` + `sw.js` (hors-ligne pour la dernière vue, installable).

## Mise en place

### 1. Planning (robot)
Dans le dépôt GitHub : **Settings → Secrets and variables → Actions → New secret**
- Nom : `MYEFREI_ICS_URL`
- Valeur : l'URL `https://www.myefrei.fr/api/public/student/planning/…` (version `https`, pas `webcal`)

Puis **Actions → Mise à jour du planning → Run workflow** pour un premier remplissage.

Test local :
```bash
MYEFREI_ICS_URL="https://www.myefrei.fr/api/public/student/planning/…" node scripts/fetch-planning.mjs
```

### 2. To-do (Supabase)
1. Crée un projet gratuit sur supabase.com.
2. Crée la table et la sécurité (SQL fourni séparément).
3. Renseigne `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans `config.js` (valeurs publiques, sans risque).

### 3. Hébergement
Dépôt public → **Settings → Pages → Branch: main / root**. Site : `https://<user>.github.io/hub/`.

## Dév local
```bash
python -m http.server 8080
```
Puis ouvrir http://localhost:8080
