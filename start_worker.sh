#!/bin/bash
# Script de lancement du worker Celery pour Cadlytics
exec celery -A celery_app.celery worker -l INFO -Q dfm -c 2
