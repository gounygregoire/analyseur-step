import sys
import pathlib
import time
import threading
import types
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from api.dfm import dfm_bp
from app.storage.storage import Storage
import app.api.dfm_routes as routes


def test_dfm_start_and_status_transition(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))
    step_file = uploads / "f.step"
    step_file.write_text("ISO-10303-21;")
    Storage.save_step_record("f", "f.step", str(step_file), step_file.stat().st_size)

    job_state = {"state": "PENDING"}

    def fake_delay(**kwargs):
        job_id = "job1"
        def _worker():
            time.sleep(0.1)
            job_state["state"] = "SUCCESS"
        threading.Thread(target=_worker).start()
        return types.SimpleNamespace(id=job_id)

    monkeypatch.setattr(routes.dfm_run, "delay", fake_delay)

    class DummyResult:
        def __init__(self, state):
            self.state = state
            self.info = None

    monkeypatch.setattr(routes, "AsyncResult", lambda job_id: DummyResult(job_state["state"]))

    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    client = app.test_client()

    resp = client.post(
        "/api/dfm/start",
        json={"file_id": "f", "material_profile_id": "ABS", "axis": "AUTO", "invert": False},
    )
    assert resp.status_code == 202
    job_id = resp.get_json()["job_id"]
    time.sleep(0.2)
    final = client.get("/api/dfm/status", query_string={"job_id": job_id})
    assert final.get_json()["status"] == "done"


def test_dfm_status_error_for_invalid_step(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))
    step_file = uploads / "g.step"
    step_file.write_text("BROKEN")
    Storage.save_step_record("g", "g.step", str(step_file), step_file.stat().st_size)

    job_state = {"state": "PENDING", "info": None}

    def fake_delay(**kwargs):
        job_id = "job-error"

        def _worker():
            time.sleep(0.05)
            job_state["state"] = "FAILURE"
            job_state["info"] = {"status": "error", "message": "invalid_step"}

        threading.Thread(target=_worker).start()
        return types.SimpleNamespace(id=job_id)

    monkeypatch.setattr(routes.dfm_run, "delay", fake_delay)

    class DummyResult:
        def __init__(self, state, info=None):
            self.state = state
            self.info = info

    monkeypatch.setattr(
        routes,
        "AsyncResult",
        lambda job_id: DummyResult(job_state["state"], job_state.get("info")),
    )

    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    client = app.test_client()

    resp = client.post(
        "/api/dfm/start",
        json={"file_id": "g", "material_profile_id": "ABS", "axis": "AUTO", "invert": False},
    )
    assert resp.status_code == 202
    job_id = resp.get_json()["job_id"]
    time.sleep(0.1)
    final = client.get("/api/dfm/status", query_string={"job_id": job_id})
    data = final.get_json()
    assert data["status"] == "error"
    assert data["error"] == "invalid_step"
