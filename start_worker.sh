#!/bin/bash
# Script de lancement du worker Celery pour Cadlytics
exec celery -A celery_app.celery worker -l info -P solo
