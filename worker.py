import os
from celery import Celery

from app import app
from observability.logging import get_logger
from celery import signals

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

logger = get_logger(__name__)


@signals.task_prerun.connect
def _task_start(sender=None, task_id=None, **kwargs):
    logger.info("task_start", extra={"task": sender.name, "task_id": task_id})


@signals.task_postrun.connect
def _task_end(sender=None, task_id=None, state=None, **kwargs):
    logger.info("task_end", extra={"task": sender.name, "task_id": task_id, "state": state})


if __name__ == "__main__":
    celery.start()
