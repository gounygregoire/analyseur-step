from pathlib import Path
import subprocess
import os

import pytest
from flask import Flask

from app.api.contract_routes import api_contract_bp


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(api_contract_bp)
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


SAMPLE_STEP = Path("tests/sample.step")


def test_upload_convert_analyze_flow(client, monkeypatch):
    history_path = Path(os.environ.get("OUTPUT_FOLDER", "/tmp/converted")) / "history.json"
    if history_path.exists():
        history_path.unlink()

    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    assert resp.status_code == 200
    data = resp.get_json()
    file_id = data["file_id"]
    assert Path(data["step_path"]).exists()

    hist = client.get("/api/simple/history").get_json()
    entry = next(e for e in hist if e["file_id"] == file_id)
    assert entry["filename"].endswith(SAMPLE_STEP.name)
    assert "xkt_ready" not in entry

    def fake_run(cmd, capture_output, text, timeout):
        Path(cmd[2]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fake_run)

    resp = client.post("/api/simple/convert", json={"file_id": file_id})
    assert resp.status_code == 200
    conv = resp.get_json()
    assert conv["xkt_url"] == f"/models/{file_id}.xkt"
    xkt_path = Path(os.environ.get("OUTPUT_FOLDER", "/tmp/converted")) / f"{file_id}.xkt"
    assert xkt_path.exists()
    preview_real = Path(os.environ.get("OUTPUT_FOLDER", "/tmp/converted")) / f"{file_id}.png"
    assert preview_real.exists()
    # GET /models route
    r = client.get(conv["xkt_url"])
    assert r.status_code == 200

    hist = client.get("/api/simple/history").get_json()
    entry = next(e for e in hist if e["file_id"] == file_id)
    assert entry.get("xkt_ready") is True
    assert entry.get("convert_ms") >= 0

    resp = client.post(
        "/api/simple/analyze",
        json={"file_id": file_id, "axis": [0, 0, 1], "material": "ABS", "options": {}},
    )
    assert resp.status_code == 200
    rep = resp.get_json()
    assert rep["report_id"]
    assert rep["dfm_score"] == 0

    report_path = Path("static") / "dfm" / file_id / "report.json"
    assert report_path.exists()
    r = client.get(f"/api/simple/report/{file_id}")
    assert r.status_code == 200
    report = r.get_json()
    assert report["status"] == "done"
    assert report["score"] == 72
    assert isinstance(report.get("recommendations"), list)
    assert isinstance(report.get("metrics"), dict)

    hist = client.get("/api/simple/history").get_json()
    entry = next(e for e in hist if e["file_id"] == file_id)
    assert entry.get("dfm_score") == 0
    assert entry.get("report_id") == rep["report_id"]


def test_convert_missing_file_id(client):
    resp = client.post("/api/simple/convert", json={})
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "missing_file_id"


def test_convert_unknown_file_id(client):
    resp = client.post("/api/simple/convert", json={"file_id": "nope"})
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "missing_or_unknown_file_id"


def test_convert_idempotent(client, monkeypatch):
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    file_id = resp.get_json()["file_id"]

    def fake_run(cmd, capture_output, text, timeout):
        Path(cmd[2]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fake_run)
    client.post("/api/simple/convert", json={"file_id": file_id})

    def fail_run(*args, **kwargs):  # should not be called
        raise AssertionError("should not run")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fail_run)
    resp = client.post("/api/simple/convert", json={"file_id": file_id})
    assert resp.status_code == 200


def test_convert_failure_returns_500(client, monkeypatch):
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    file_id = resp.get_json()["file_id"]

    def fail_run(cmd, capture_output, text, timeout):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom error")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fail_run)

    resp = client.post("/api/simple/convert", json={"file_id": file_id})
    assert resp.status_code == 500
    body = resp.get_json()
    assert body["error"] == "convert_failed"
    assert "boom" in body["stderr"]


def test_models_route_serves_xkt(client):
    out = Path(os.environ.get("OUTPUT_FOLDER", "/tmp/converted"))
    out.mkdir(parents=True, exist_ok=True)
    p = out / "dummy.xkt"
    p.write_bytes(b"abc")
    resp = client.get("/models/dummy.xkt")
    assert resp.status_code == 200
    assert resp.data == b"abc"
    assert resp.mimetype == "model/xkt"
    resp = client.get("/models/missing.xkt")
    assert resp.status_code == 404
