import os
from celery import Celery


def make_celery():
    broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    backend = os.getenv("CELERY_RESULT_BACKEND", broker)

    app = Celery(__name__, broker=broker, backend=backend)
    app.conf.task_default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")
    app.conf.broker_connection_retry_on_startup = True

    # Redis Cloud via TLS (rediss://) → activer SSL côté Celery si nécessaire
    if broker.startswith("rediss://"):
        app.conf.broker_use_ssl = {"ssl_cert_reqs": "none"}
    if backend.startswith("rediss://"):
        app.conf.redis_backend_use_ssl = {"ssl_cert_reqs": "none"}

    return app


celery = make_celery()


def init_celery(flask_app):
    """
    Optionnel : lie Celery au contexte Flask pour que les tasks aient app_context.
    Laisse intact 'celery' pour compat avec l'ancien import 'from celery_app import celery, init_celery'.
    """
    celery.conf.update(flask_app.config)

    TaskBase = celery.Task

    class ContextTask(TaskBase):
        abstract = True

        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return TaskBase.__call__(self, *args, **kwargs)

    celery.Task = ContextTask
    return celery
