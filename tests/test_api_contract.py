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
        Path(cmd[3]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fake_run)

    resp = client.post(
        "/api/simple/convert", json={"file_id": file_id, "tolerance": 0.1}
    )
    assert resp.status_code == 200
    conv = resp.get_json()
    assert conv["xkt_url"] == f"/static/converted/{file_id}.xkt"
    xkt_path = Path(os.environ.get("OUTPUT_FOLDER", "/tmp/converted")) / f"{file_id}.xkt"
    assert xkt_path.exists()
    assert Path(conv["preview_png"]).exists()

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

    hist = client.get("/api/simple/history").get_json()
    entry = next(e for e in hist if e["file_id"] == file_id)
    assert entry.get("dfm_score") == 0
    assert entry.get("report_id") == rep["report_id"]


def test_convert_missing_file_id(client):
    resp = client.post("/api/simple/convert", json={})
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "missing_or_unknown_file_id"
    assert "message" in data


def test_convert_unknown_file_id(client):
    resp = client.post("/api/simple/convert", json={"file_id": "nope"})
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "missing_or_unknown_file_id"
    assert "message" in data


def test_convert_invalid_tolerance(client):
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    file_id = resp.get_json()["file_id"]
    resp = client.post(
        "/api/simple/convert", json={"file_id": file_id, "tolerance": "Standard (0.1mm)"}
    )
    assert resp.status_code == 422
    data = resp.get_json()
    assert data["error"] == "invalid_tolerance"
    assert "message" in data


def test_convert_failure_returns_502(client, monkeypatch):
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    file_id = resp.get_json()["file_id"]

    def fail_run(cmd, capture_output, text, timeout):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom error")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fail_run)

    resp = client.post(
        "/api/simple/convert", json={"file_id": file_id, "tolerance": 0.1}
    )
    assert resp.status_code == 502
    body = resp.get_json()
    assert body["error"] == "xkt_convert_failed"
    assert "boom" in body["message"]
