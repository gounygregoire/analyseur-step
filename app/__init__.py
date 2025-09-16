from typing import Any, Tuple


try:
    from .app import app  # type: ignore
except Exception:  # pragma: no cover
    # >>> CADLYTICS PATCH: FALLBACK-APP (BEGIN)
    from flask import Flask, request
    from tus_upload import tus_bp
    app = Flask(__name__)
    app.register_blueprint(tus_bp, url_prefix="/tus")

    @app.post("/api/upload")
    def _upload_api():
        payload = request.get_json(silent=True) or {}
        if not payload.get("upload_id"):
            return {"error": "upload_id missing"}, 400
        return {}, 201
    # >>> CADLYTICS PATCH: FALLBACK-APP (END)

# >>> CADLYTICS PATCH: DB SHIM IMPORT (BEGIN)
from .db import db  # shim pour tests
# >>> CADLYTICS PATCH: DB SHIM IMPORT (END)
# >>> CADLYTICS PATCH: EXPORTS (BEGIN)
try:
    from models import db
    if app is not None:
        db.init_app(app)
except Exception:  # pragma: no cover
    try:
        from flask_sqlalchemy import SQLAlchemy
        db = SQLAlchemy()
        if app is not None:
            app.config.setdefault('SQLALCHEMY_DATABASE_URI', 'sqlite://')
            db.init_app(app)
    except Exception:  # pragma: no cover
        pass  # keep shim

def _send_task(task_name: str, args: Tuple[Any, ...] | list[Any], kwargs: dict, options: dict | None = None):
    """Envoie une tâche Celery sans importer les modules lourds."""
    from celery_app import celery

    options = options or {}
    if not isinstance(args, tuple):
        args = tuple(args)
    return celery.send_task(task_name, args=args, kwargs=kwargs, **options)


class _CeleryTaskProxy:
    """Proxy léger exposant les tâches Celery sans import CadQuery/Trimesh."""

    def __init__(self, task_name: str):
        self.task_name = task_name
        self.name = task_name

    def __call__(self, *args: Any, **kwargs: Any):
        return self.delay(*args, **kwargs)

    def delay(self, *args: Any, **kwargs: Any):
        return _send_task(self.task_name, args, kwargs)

    def apply_async(self, args: Tuple[Any, ...] | None = None, kwargs: dict | None = None, **options: Any):
        return _send_task(self.task_name, args or (), kwargs or {}, options)


generate_preview = _CeleryTaskProxy("tasks.generate_preview")
generate_final = _CeleryTaskProxy("tasks.generate_final")
# >>> CADLYTICS PATCH: EXPORTS (END)

__all__ = ["app", "db", "generate_preview", "generate_final"]
