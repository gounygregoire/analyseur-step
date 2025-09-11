from pathlib import Path
import subprocess

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
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    assert resp.status_code == 200
    data = resp.get_json()
    file_id = data["file_id"]
    assert Path(data["step_path"]).exists()

    def fake_run(cmd, capture_output, text, timeout):
        Path(cmd[3]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fake_run)

    resp = client.post(
        "/api/simple/convert", json={"file_id": file_id, "tolerance": 0.1}
    )
    assert resp.status_code == 200
    conv = resp.get_json()
    assert Path(conv["xkt_path"]).exists()
    assert Path(conv["preview_png"]).exists()

    resp = client.post(
        "/api/simple/analyze",
        json={"file_id": file_id, "axis": [0, 0, 1], "material": "ABS", "options": {}},
    )
    assert resp.status_code == 200
    rep = resp.get_json()
    assert rep["report_id"]
    assert rep["dfm_score"] == 0


def test_convert_missing_file_id(client):
    resp = client.post("/api/simple/convert", json={})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "missing_or_unknown_file_id"


def test_convert_unknown_file_id(client):
    resp = client.post("/api/simple/convert", json={"file_id": "nope"})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "missing_or_unknown_file_id"


def test_convert_invalid_tolerance(client):
    with SAMPLE_STEP.open("rb") as fh:
        resp = client.post("/api/simple/upload", data={"file": fh})
    file_id = resp.get_json()["file_id"]
    resp = client.post(
        "/api/simple/convert", json={"file_id": file_id, "tolerance": "Standard (0.1mm)"}
    )
    assert resp.status_code == 422
    assert resp.get_json()["error"] == "invalid_tolerance"


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
    assert "boom" in body["details"]
