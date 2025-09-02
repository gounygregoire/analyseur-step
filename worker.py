# worker.py — Celery worker entrypoint for Render
# Import the existing Celery app instance without going through web.py to avoid side effects.

import logging

logging.basicConfig(level=logging.INFO)
logging.info("worker.py starting Celery worker")

from celery_app import celery  # the project must already expose `celery` in celery_app.py

if __name__ == "__main__":
    # Start a standard Celery worker (Render uses the Start Command instead)
    celery.worker_main()
