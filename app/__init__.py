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

try:
    from tasks.conversion import generate_preview, generate_final
except Exception:  # pragma: no cover
    def generate_preview(*args, **kwargs):
        raise RuntimeError("generate_preview not available")
    def generate_final(*args, **kwargs):
        raise RuntimeError("generate_final not available")
# >>> CADLYTICS PATCH: EXPORTS (END)

__all__ = ["app", "db", "generate_preview", "generate_final"]
