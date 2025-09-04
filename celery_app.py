import os
from celery import Celery

def make_celery():
    broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    backend = os.getenv("CELERY_RESULT_BACKEND", broker)

    app = Celery(__name__, broker=broker, backend=backend)

    # Queue par défaut
    app.conf.task_default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")

    # Redis Cloud => TLS (rediss://). Active SSL côté Celery si nécessaire.
    if broker.startswith("rediss://"):
        app.conf.broker_use_ssl = {"ssl_cert_reqs": "none"}
    if backend.startswith("rediss://"):
        app.conf.redis_backend_use_ssl = {"ssl_cert_reqs": "none"}

    # Optionnel mais utile en prod
    app.conf.broker_connection_retry_on_startup = True

    return app

celery = make_celery()
