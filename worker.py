from celery_app import celery
from observability.logging import get_logger
from celery import signals

logger = get_logger(__name__)


@signals.task_prerun.connect
def _task_start(sender=None, task_id=None, **kwargs):
    logger.info("task_start", extra={"task": sender.name, "task_id": task_id})


@signals.task_postrun.connect
def _task_end(sender=None, task_id=None, state=None, **kwargs):
    logger.info("task_end", extra={"task": sender.name, "task_id": task_id, "state": state})


if __name__ == "__main__":
    celery.start()
