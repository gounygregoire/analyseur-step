import os
from celery import Celery

from app import app

broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
backend = os.getenv("CELERY_BACKEND_URL", broker)

celery = Celery(
    "cadlytics", broker=broker, backend=backend, include=["tasks.conversion", "tasks.dfm"]
)

celery.conf.update(task_track_started=True, result_expires=3600)


class ContextTask(celery.Task):
    def __call__(self, *args, **kwargs):
        with app.app_context():
            return super().__call__(*args, **kwargs)


celery.Task = ContextTask

if __name__ == "__main__":
    celery.start()
