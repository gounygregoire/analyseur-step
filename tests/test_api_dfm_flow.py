import time

import pytest
from tests.conftest import REAL_THREAD

from app.dfm import services
from app.dfm.dfm_analyzer import DFMReport, DimensionAnalysis

# Seuils de performance (±20 % tolérance)
MAX_JOB_DURATION = 5.0  # secondes
MAX_STATUS_POLLS = 20   # appels
TOLERANCE = 0.2


def _fake_report():
    return DFMReport(
        dimensions=DimensionAnalysis(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10.0),
        wall_thickness_issues=[],
        geometry_issues=[],
        overall_score="good",
        moldability_rating=8,
        recommendations=[],
    )


def _fake_report_low_res():
    rep = _fake_report()
    rep.dimensions.low_res = True
    return rep


def test_full_flow(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report())
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    status = client.get("/api/dfm/status", query_string={"job_id": job_id}).get_json()
    assert status["status"] == "done"
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    for key in ["summary", "issues", "heatmap", "axis", "material_profile"]:
        assert key in result
    assert result["job_id"] == job_id
    assert result["axis"]["z"] == 1


def test_start_invalid_file_id(client):
    resp = client.post("/api/dfm/start", json={"file_id": "unknown", "material_profile": "ABS"})
    assert resp.status_code == 400


def test_start_missing_file_id(client):
    resp = client.post("/api/dfm/start", json={"material_profile": "ABS", "axis": {"x":0,"y":0,"z":1}})
    assert resp.status_code == 400


def test_start_missing_material(client, sample_step_path):
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    resp = client.post("/api/dfm/start", json={"file_id": file_id})
    assert resp.status_code == 400


def test_start_auto_axis(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report())
    monkeypatch.setattr(services, "_auto_axis", lambda p: {"x": 1.0, "y": 0.0, "z": 0.0})
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start", json={"file_id": file_id, "material_profile": "ABS"}
    ).get_json()["job_id"]
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    assert result["axis"] == {"x": 1.0, "y": 0.0, "z": 0.0}


def test_status_unknown_job(client):
    resp = client.get("/api/dfm/status", query_string={"job_id": "missing"})
    assert resp.status_code == 404
    data = resp.get_json()
    assert data["status"] == "error"
    assert data["error"] == "job_not_found"


def test_analysis_error(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(
        services,
        "analyze_dfm",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("failed step")),
    )
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    status = client.get("/api/dfm/status", query_string={"job_id": job_id}).get_json()
    assert status["status"] == "error"
    res = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    assert res["error"] == "failed step"


def test_low_res_flag_propagated(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report_low_res())
    with open(sample_step_path("huge_dummy.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "big.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    assert result["summary"]["low_res"] is True


def test_result_not_ready(client, sample_step_path, monkeypatch):
    import threading

    monkeypatch.setattr(threading, "Thread", REAL_THREAD)

    def slow(*a, **k):
        time.sleep(0.2)
        return _fake_report()

    monkeypatch.setattr(services, "analyze_dfm", slow)
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    res = client.get("/api/dfm/result", query_string={"job_id": job_id})
    assert res.status_code == 404
    for _ in range(20):
        time.sleep(0.05)
        res2 = client.get("/api/dfm/result", query_string={"job_id": job_id})
        if res2.status_code == 200:
            break
    assert res2.status_code == 200


def test_job_logging_and_perf(client, sample_step_path, monkeypatch):
    import threading

    monkeypatch.setattr(threading, "Thread", REAL_THREAD)

    def slow(*a, **k):
        time.sleep(0.2)
        return _fake_report()

    monkeypatch.setattr(services, "analyze_dfm", slow)
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    start = time.perf_counter()
    calls = 0
    max_polls = int(MAX_STATUS_POLLS * (1 + TOLERANCE))
    while calls <= max_polls:
        calls += 1
        status = client.get("/api/dfm/status", query_string={"job_id": job_id}).get_json()
        if status["status"] == "done":
            break
        time.sleep(0.05)
    else:  # pragma: no cover - fail safe
        pytest.fail("status polling exceeded max limit")
    duration = time.perf_counter() - start
    assert duration <= MAX_JOB_DURATION * (1 + TOLERANCE)
    assert calls <= max_polls
    client.get("/api/dfm/result", query_string={"job_id": job_id})
    log_content = services.LOG_PATH.read_text()
    assert f"job={job_id}" in log_content
    assert f"file={file_id}" in log_content
    assert "dt=" in log_content
