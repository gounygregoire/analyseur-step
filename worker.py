# worker.py — Celery worker entrypoint for Render
# Import the existing Celery app instance without going through web.py to avoid side effects.


# >>> CADLYTICS PATCH: BOOT LOG (BEGIN)
import os, logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("boot")
os.makedirs(os.environ.get("UPLOAD_FOLDER", "/tmp/uploads"), exist_ok=True)
os.makedirs(os.environ.get("OUTPUT_FOLDER", "/tmp/converted"), exist_ok=True)
os.environ.setdefault(
    "FILES_DB_PATH",
    os.path.join(os.path.dirname(__file__), "app/storage/files.sqlite"),
)
log.info(
    "[BOOT] UPLOAD_FOLDER=%s OUTPUT_FOLDER=%s FILES_DB_PATH=%s cwd=%s",
    os.environ.get("UPLOAD_FOLDER"),
    os.environ.get("OUTPUT_FOLDER"),
    os.environ.get("FILES_DB_PATH"),
    os.getcwd(),
)
# >>> CADLYTICS PATCH: BOOT LOG (END)
log.info("worker.py starting Celery worker")

from celery_app import celery  # the project must already expose `celery` in celery_app.py

if __name__ == "__main__":
    # Start a standard Celery worker (Render uses the Start Command instead)
    celery.worker_main()
