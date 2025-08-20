import os
from celery import Celery

celery = Celery("cadlytics", include=["tasks.conversion", "tasks.dfm"])


def init_celery(app):
    broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    backend = os.getenv("CELERY_BACKEND_URL", broker)
    celery.conf.update(broker_url=broker, result_backend=backend)
    celery.conf.update(app.config)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = ContextTask
    return celery
