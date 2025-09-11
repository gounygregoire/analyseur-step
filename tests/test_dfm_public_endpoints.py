import json
import json
import json
import pathlib
import types
import shutil

from flask import Flask

from api.dfm import dfm_public_bp
from app.storage.storage import Storage
import app.api.dfm_routes as routes


def _setup_storage(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))
    step_file = uploads / "f.step"
    step_file.write_text("ISO-10303-21;")
    Storage.save_step_record("f", "f.step", str(step_file), step_file.stat().st_size)


def test_public_start(tmp_path, monkeypatch):
    _setup_storage(tmp_path, monkeypatch)

    def fake_delay(**kwargs):
        return types.SimpleNamespace(id="job1")

    monkeypatch.setattr(routes.dfm_run, "delay", fake_delay)

    app = Flask(__name__)
    app.register_blueprint(dfm_public_bp)
    client = app.test_client()

    resp = client.post("/dfm/start", json={"file_id": "f", "material": "ABS", "axis": "Z"})
    assert resp.status_code == 202
    assert resp.get_json()["job_id"] == "job1"


def test_public_report(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(dfm_public_bp)
    client = app.test_client()

    report_dir = pathlib.Path("static/dfm/f")
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "report.json").write_text(json.dumps({"status": "done"}))

    resp = client.get("/dfm/report/f")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "done"

    missing = client.get("/dfm/report/unknown")
    assert missing.status_code == 404

    shutil.rmtree(report_dir.parent)
