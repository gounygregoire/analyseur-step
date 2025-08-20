#!/bin/bash
# Script de lancement du worker Celery pour Cadlytics
export CELERY_BROKER_URL="${CELERY_BROKER_URL:-redis://localhost:6379/0}"
exec celery -A worker.celery worker --loglevel=info
