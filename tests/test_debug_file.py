import os
import pathlib
import sys
import importlib
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from api.dfm import debug_bp
import app.storage.storage as storage


def test_debug_file_endpoint(tmp_path, monkeypatch):
    db_path = tmp_path / "files.sqlite"
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "converted"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setenv("FILES_DB_PATH", str(db_path))
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(outputs))
    importlib.reload(storage)
    Storage = storage.Storage

    step = uploads / "f.step"
    step.write_text("STEP")
    xkt = outputs / "f.xkt"
    xkt.write_text("XKT")
    Storage.save_step_record("f", "f.step", str(step), step.stat().st_size)

    app = Flask(__name__)
    app.register_blueprint(debug_bp)
    client = app.test_client()

    resp = client.get("/api/debug/file/f")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["file_id"] == "f"
    assert data["step_path"] == str(step)
    assert data["xkt_path"] == str(xkt)
    assert data["exists_step"] is True

    resp2 = client.get("/api/debug/file/missing")
    assert resp2.status_code == 200
    data2 = resp2.get_json()
    assert data2["step_path"] is None
    assert data2["xkt_path"] is None
    assert data2["exists_step"] is False
