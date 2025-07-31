# Cadlytics

Ce dépôt contient le code du MVP de Cadlytics, SaaS d'analyse DFM et de visualisation 3D pour fichiers STEP.
Le viewer 3D repose désormais sur **Xeokit** et rend les modèles au format **XKT**
(conversion réalisée via `xkt_converter.py`).

La conversion STEP vers STL s'appuie sur la librairie **OCP** (`pythonocc-core`).

## Nettoyage automatique des fichiers

Les fichiers téléchargés (`uploads/`) et convertis (`converted/`) sont conservés pendant **7 jours** par défaut. La tâche Celery `cleanup_old_files` supprime quotidiennement les fichiers plus anciens.

- Modifier la durée via la variable d'environnement `FILE_RETENTION_DAYS`.
- Lancer le scheduler avec `./start_beat.sh` (ou planifier un cron équivalent).

## Lancer les services

```
redis-server --daemonize yes
CELERY_BROKER_URL=redis://localhost:6379/0 ./start_worker.sh
CELERY_BROKER_URL=redis://localhost:6379/0 ./start_beat.sh
CELERY_BROKER_URL=redis://localhost:6379/0 gunicorn app:app --timeout 600
```

## Variables d'environnement importantes

- `SESSION_SECRET` : clé secrète pour chiffrer les sessions Flask. Obligation
  de définir une valeur aléatoire en production.

## Construction du bundle JavaScript

Exécuter une seule fois :

```bash
npm install
```

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
