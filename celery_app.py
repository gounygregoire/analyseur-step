import os
from celery import Celery


def make_celery():
    broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    backend = os.getenv("CELERY_RESULT_BACKEND", broker)
    celery = Celery(
        __name__,
        broker=broker,
        backend=backend,
        include=["tasks.conversion", "tasks.dfm"],
    )
    celery.conf.task_default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")
    return celery


celery = make_celery()


def init_celery(app):
    celery.conf.update(app.config)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = ContextTask
    app.celery = celery
    return celery
