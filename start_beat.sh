#!/bin/bash
# Lancement du scheduler Celery beat pour Cadlytics
export CELERY_BROKER_URL="${CELERY_BROKER_URL:-redis://localhost:6379/0}"
exec celery -A app.celery beat --loglevel=info
