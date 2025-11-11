"""Fixtures communes pour les tests API."""

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:  # pragma: no cover - dépendance optionnelle
    import cadquery

    _orig_export = cadquery.exporters.export

    def _export(workplane, filename, *args, **kwargs):
        if not isinstance(filename, str):
            filename = str(filename)
        return _orig_export(workplane, filename, *args, **kwargs)

    cadquery.exporters.export = _export
except Exception:  # pragma: no cover
    pass

from models import db

APP_MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"


def _load_create_app():
    spec = importlib.util.spec_from_file_location("cadlytics_app_module_tests", APP_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    loader = spec.loader
    assert loader is not None
    loader.exec_module(module)
    sys.modules.setdefault("cadlytics_app_module_tests", module)
    return module.create_app


@pytest.fixture
def api_app(tmp_path, monkeypatch):
    upload_dir = tmp_path / "uploads"
    output_dir = tmp_path / "converted"
    monkeypatch.setenv("UPLOAD_FOLDER", str(upload_dir))
    monkeypatch.setenv("OUTPUT_FOLDER", str(output_dir))
    monkeypatch.setenv("XKT_LOCAL_DIR", str(output_dir))
    monkeypatch.setenv("SRC_DIR", str(upload_dir))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))
    db_path = tmp_path / "cadlytics.sqlite"
    monkeypatch.setenv("SQLALCHEMY_DATABASE_URI", f"sqlite:///{db_path}")

    create_app = _load_create_app()
    app = create_app()
    app.config["TESTING"] = True

    with app.app_context():
        db.drop_all()
        db.create_all()

    return app


@pytest.fixture
def api_client(api_app):
    return api_app.test_client()
