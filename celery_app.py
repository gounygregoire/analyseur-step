# celery_app.py
import os
import ssl
from celery import Celery

def make_celery():
    broker = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    backend = os.getenv("CELERY_RESULT_BACKEND", broker)

    app = Celery(__name__, broker=broker, backend=backend)

    # File d'attente par défaut
    app.conf.task_default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")

    # Démarrage robuste des connexions
    app.conf.broker_connection_retry_on_startup = True

    # Forçage SSL correct pour rediss://
    tls = {"ssl_cert_reqs": ssl.CERT_NONE}
    if broker.startswith("rediss://"):
        app.conf.broker_use_ssl = tls
    if backend.startswith("rediss://"):
        # Celery 5.x -> nom attendu pour le backend Redis
        app.conf.redis_backend_use_ssl = tls

    return app

celery = make_celery()

def init_celery(flask_app):
    """Attache le contexte Flask aux tasks (optionnel mais propre)."""
    celery.conf.update(flask_app.config)

    class ContextTask(celery.Task):
        abstract = True
        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = ContextTask
    return celery
