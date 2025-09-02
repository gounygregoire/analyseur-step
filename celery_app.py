"""Initialisation de Celery pour Cadlytics.

Variables d'environnement obligatoires :
    - ``REDIS_URL`` ou ``CELERY_BROKER_URL`` : URL du broker (ex. ``redis://:pass@host:6379/0``)
    - ``CELERY_RESULT_BACKEND`` : URL du backend (peut être identique au broker)

Commande worker :
    ``celery -A celery_app.celery worker -l info -P solo``

Le dyno web et le worker doivent partager **exactement** les mêmes variables
d'environnement. Sans URL fournie, l'application bascule en mode dégradé avec
un broker ``memory://`` et un backend ``rpc://``.
"""

import os
from celery import Celery
from flask import current_app
from kombu.exceptions import OperationalError as KombuOperationalError
from redis.exceptions import ConnectionError as RedisConnectionError

try:
    from observability.metrics import celery_ready as celery_ready_metric
except Exception:  # pragma: no cover - metrics optional
    celery_ready_metric = None

_last_ready = None

celery = Celery("cadlytics", include=["tasks.conversion", "tasks.dfm"])


def init_celery(app):
    broker = os.getenv("CELERY_BROKER_URL") or os.getenv("REDIS_URL")
    backend = os.getenv("CELERY_RESULT_BACKEND") or broker

    celery_enabled = bool(broker)
    if not celery_enabled:
        broker = "memory://"
        backend = "rpc://"

    app.config.update(
        CELERY_ENABLED=celery_enabled,
        CELERY_BROKER_URL=broker if celery_enabled else None,
        CELERY_RESULT_BACKEND=backend if celery_enabled else None,
    )

    celery.conf.update(broker_url=broker, result_backend=backend)
    celery.conf.update(app.config)
    celery.conf.update(
        broker_transport_options={"socket_timeout": 2},
        result_backend_transport_options={"socket_timeout": 2},
    )

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = ContextTask
    app.celery = celery
    return celery


def is_celery_ready() -> bool:
    app = current_app
    ready = False
    if app.config.get("CELERY_ENABLED"):
        celery_app = getattr(app, "celery", None)
        if celery_app:
            try:
                ready = bool(celery_app.control.ping(timeout=1))
            except (RedisConnectionError, KombuOperationalError):
                ready = False

    global _last_ready
    if _last_ready is not None and ready != _last_ready:
        if ready:
            app.logger.info("Celery broker reachable again")
        else:
            app.logger.warning("Celery broker became unreachable")
    _last_ready = ready

    if celery_ready_metric is not None:
        try:
            celery_ready_metric.set(1 if ready else 0)
        except Exception:
            pass

    return ready
