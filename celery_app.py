# celery_app.py
import os, ssl
from celery import Celery

def make_celery():
    broker = os.getenv("CELERY_BROKER_URL")
    backend = os.getenv("CELERY_RESULT_BACKEND")

    app = Celery(__name__, broker=broker, backend=backend)
    app.conf.task_default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")
    app.conf.broker_connection_retry_on_startup = True

    ssl_opts = {"ssl_cert_reqs": ssl.CERT_NONE}
    if broker and broker.startswith("rediss://"):
        app.conf.broker_use_ssl = ssl_opts
    if backend and backend.startswith("rediss://"):
        app.conf.redis_backend_use_ssl = ssl_opts

    # 🔎 Ajoute ces prints pour vérifier en logs côté Web Service :
    print("[CELERY] broker:", broker)
    print("[CELERY] backend:", backend)
    print("[CELERY] broker_use_ssl:", app.conf.get("broker_use_ssl"))
    print("[CELERY] redis_backend_use_ssl:", app.conf.get("redis_backend_use_ssl"))

    return app

celery = make_celery()

def init_celery(flask_app):
    celery.conf.update(flask_app.config)
    class ContextTask(celery.Task):
        abstract = True
        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return super().__call__(*args, **kwargs)
    celery.Task = ContextTask
    return celery
