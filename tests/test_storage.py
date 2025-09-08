from app.dfm import services
from app.dfm.dfm_analyzer import DFMReport, DimensionAnalysis
from app.storage import files


def _fake_report():
    return DFMReport(
        dimensions=DimensionAnalysis(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10.0),
        wall_thickness_issues=[],
        geometry_issues=[],
        overall_score="good",
        moldability_rating=8,
        recommendations=[],
    )


def test_storage_paths(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report())
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload",
            data={"file": (fh, "cube.step")},
            content_type="multipart/form-data",
        ).get_json()["file_id"]
    upload_path = files.UPLOAD_DIR / f"{file_id}.step"
    assert upload_path.exists()
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    result_path = services.RESULTS_DIR / f"{job_id}.json"
    assert result_path.exists()
