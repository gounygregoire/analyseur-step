import time
import json
import sys
import pathlib
import logging
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from app.api.dfm_routes import dfm_bp
from app.dfm.interfaces import DFMResult
from app.storage import files
from app.dfm import services


def create_client(tmp_path):
    files.UPLOAD_DIR = tmp_path
    files.DB_PATH = tmp_path / "files.sqlite"
    services.RESULTS_DIR = tmp_path
    services.LOG_PATH = tmp_path / "dfm.log"
    for h in list(services._logger.handlers):
        services._logger.removeHandler(h)
    handler = logging.FileHandler(services.LOG_PATH)
    handler.setFormatter(logging.Formatter("%(message)s"))
    services._logger.addHandler(handler)
    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    return app.test_client()


def test_upload_and_analysis(tmp_path, monkeypatch):
    client = create_client(tmp_path)

    from app.dfm.dfm_analyzer import DFMReport, DimensionAnalysis

    def fake_analyze(step_path: str, axis, material):
        return DFMReport(
            dimensions=DimensionAnalysis(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10.0),
            wall_thickness_issues=[],
            geometry_issues=[],
            overall_score="good",
            moldability_rating=8,
            recommendations=[],
        )

    monkeypatch.setattr(services, "analyze_dfm", fake_analyze)

    step_path = tmp_path / "sample.step"
    step_path.write_text("ISO-10303-21;")
    with open(step_path, "rb") as fh:
        resp = client.post(
            "/api/upload",
            data={"file": (fh, "sample.step")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 200
    file_id = resp.get_json()["file_id"]
    saved = tmp_path / f"{file_id}.step"
    assert saved.exists()
    assert saved.read_text() == "ISO-10303-21;"
    assert files.get(file_id).path == saved

    start = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    )
    assert start.status_code == 202
    job_id = start.get_json()["job_id"]

    for _ in range(20):
        status = client.get("/api/dfm/status", query_string={"job_id": job_id})
        data = status.get_json()
        if data["status"] == "done":
            assert data["progress"] == 100
            break
        time.sleep(0.05)
    else:
        assert False, "job not finished"

    result = client.get("/api/dfm/result", query_string={"job_id": job_id})
    assert result.status_code == 200
    data = result.get_json()
    parsed = DFMResult(**data)
    assert parsed.job_id == job_id
    assert parsed.file_id == file_id
    assert parsed.summary.bbox_mm == (1, 1, 1)
    assert parsed.axis.z == 1
    assert parsed.summary.low_res is False

    result_file = services.RESULTS_DIR / f"{job_id}.json"
    assert result_file.exists()
    saved = json.loads(result_file.read_text())
    assert saved["job_id"] == job_id
    assert saved["axis"]["z"] == 1

    log = services.LOG_PATH.read_text()
    assert job_id in log and file_id in log


def test_start_invalid_file_id(tmp_path):
    client = create_client(tmp_path)
    resp = client.post("/api/dfm/start", json={"file_id": "unknown"})
    assert resp.status_code == 404


def test_analysis_error(tmp_path, monkeypatch):
    client = create_client(tmp_path)

    def boom(*args, **kwargs):
        raise RuntimeError("fail")

    monkeypatch.setattr(services, "analyze_dfm", boom)

    step_path = tmp_path / "sample.step"
    step_path.write_text("ISO-10303-21;")
    with open(step_path, "rb") as fh:
        resp = client.post(
            "/api/upload",
            data={"file": (fh, "sample.step")},
            content_type="multipart/form-data",
        )
    file_id = resp.get_json()["file_id"]

    start = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    )
    job_id = start.get_json()["job_id"]

    for _ in range(20):
        status = client.get("/api/dfm/status", query_string={"job_id": job_id})
        if status.get_json()["status"] == "error":
            break
        time.sleep(0.05)
    else:
        assert False, "job not failed"

    res = client.get("/api/dfm/result", query_string={"job_id": job_id})
    assert res.status_code == 200
    assert res.get_json()["error"] == "fail"


def test_health_endpoint(tmp_path):
    client = create_client(tmp_path)
    resp = client.get("/api/dfm/health")
    data = resp.get_json()
    assert resp.status_code == 200
    assert data["ok"] is True
    assert "queue_depth" in data and "workers" in data
