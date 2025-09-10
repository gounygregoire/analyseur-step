# worker.py — Celery worker entrypoint for Render
# Import the existing Celery app instance without going through web.py to avoid side effects.

import logging
import os

logging.basicConfig(level=logging.INFO)
logging.info("worker.py starting Celery worker")

UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

from celery_app import celery  # the project must already expose `celery` in celery_app.py

if __name__ == "__main__":
    # Start a standard Celery worker (Render uses the Start Command instead)
    celery.worker_main()
