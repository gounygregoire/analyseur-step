# Check-list de mise en production

## Variables d'environnement
- S3/CDN : clés d'accès, bucket et endpoints valides.
- Redis : URL et mot de passe configurés.
- Broker & Base de données : chaînes de connexion testées.

## Workers
- Gunicorn : nombre de workers et mode (sync/async) définis.
- Timeouts adaptés aux conversions STEP.
- Auto-scaling des workers (HPA Kubernetes ou autoscale Render).

## Proxy/Nginx
- En-têtes de cache configurés pour les assets.
- Limites de taille d'upload cohérentes.

## Logs et sauvegardes
- Rotation des logs et rétention appliquées.
- Backups de la base et policies des buckets vérifiés.

## Tests finaux
- Script `pytest tests/test_end_to_end.py` (avec `RUN_E2E=1`) vert pour petit, moyen et gros STEP.
- Ré-upload du même fichier = cache hit immédiat.
