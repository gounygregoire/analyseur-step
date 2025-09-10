# Cadlytics

Ce dépôt contient le code du MVP de Cadlytics, SaaS d'analyse DFM et de visualisation 3D pour fichiers STEP.
Le viewer 3D fonctionne avec **Xeokit** et attend des modèles au format **XKT**.
La conversion des fichiers STEP s'appuie sur l'outil `xeokit-convert` via le script `xkt_converter.py`.

DFM lit les fichiers STEP tandis que le viewer charge les XKT. Le module `app.storage` centralise ces chemins. Les schémas JSON des endpoints DFM sont décrits dans `docs/api_dfm.md`.

## Nettoyage automatique des fichiers

Les fichiers téléchargés (`uploads/`) et convertis (`converted/`) sont conservés pendant **7 jours** par défaut. La tâche Celery `cleanup_old_files` supprime quotidiennement les fichiers plus anciens.

- Modifier la durée via la variable d'environnement `FILE_RETENTION_DAYS`.
- Lancer le scheduler avec `./start_beat.sh` (ou planifier un cron équivalent).

## Lancer les services

Définir les variables d'environnement suivantes **à l'identique** pour le web
et pour le worker :

```
export REDIS_URL="redis://:PASSWORD@HOST:PORT/0"  # ou CELERY_BROKER_URL
export CELERY_RESULT_BACKEND="$REDIS_URL"
```

Lancer l'application Flask :

```
gunicorn web:app --timeout 600
```

Lancer le worker Celery :

```
celery -A celery_app.celery worker -l INFO -Q dfm -c 2
```

Sans URLs fournies, l'application bascule en mode dégradé (`memory://` +
`rpc://`).

## Variables d'environnement importantes

- `SESSION_SECRET` : clé secrète pour chiffrer les sessions Flask. Obligation
  de définir une valeur aléatoire en production.

## Stockage objet S3

Cadlytics stocke les assets convertis dans un bucket S3 compatible (MinIO, Wasabi...).

Variables d'environnement :

- `S3_ENDPOINT`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_REGION`
- `S3_BUCKET` (défaut : `cadlytics-assets`)
- `CDN_BASE_URL` *(optionnel)*

### Test manuel

```bash
python - <<'PY'
from storage.s3 import put_asset, get_signed_url
open('demo.txt','w').write('ok')
put_asset('demo.txt','test/demo.txt','text/plain')
print(get_signed_url('test/demo.txt'))
PY
# puis ouvrir l'URL retournée ou via curl
```

## Construction du bundle JavaScript

Exécuter une seule fois :

```bash
npm install
```
Cette commande installe notamment `@xeokit/xeokit-convert` pour la conversion des modèles au format XKT.

Pour générer le bundle dans `static/dist/` :

```bash
npm run build
```
Ce script régénère `static/dist/main.js`.
Pendant le développement il suffit de lancer

```bash
npm run dev
```
pour reconstruire automatiquement ce fichier à chaque modification.

## Conversion STEP → XKT

### Prérequis

- Node.js ≥ 14
- `npm install -g @xeokit/xeokit-convert`

### Variable d'environnement

- `OUTPUT_FOLDER` : chemin de sortie des fichiers XKT.

### Test de l'endpoint `/convert`

```bash
curl -F "file=@tests/cubes.step" http://localhost:5000/convert
```

Le fichier converti est accessible via :

```
http://localhost:5000/uploads/<uuid>.xkt
```

## QA rapide

1. **Upload STEP** : noter `file_id` dans la console et vérifier `GET /api/debug/file/<file_id>` → `step_path` existant.
2. **Analyser sans matière** : clique sur *Analyser* ouvre la modale matière, aucune requête POST.
3. **Matière validée** : le panneau d’axe apparaît sous le viewer.
4. **Axe validé** : POST `/api/dfm/start` (JSON) avec `file_id`, `material_profile_id`, `axis`, `invert`; attendre `202` + `{job_id}` puis poller.
5. **Serveur** : `tasks.dfm.dfm_run` utilise `Storage.get_step_path(file_id)` puis `dfm_analyzer.run_dfm(step_path=…)`.
6. **XKT** : uniquement pour le viewer et les vues 3D, jamais pour les métriques.
7. **Erreurs** : `file_id` inconnu, `material_profile_id` absent ou `axis` manquant → message d’erreur clair.

