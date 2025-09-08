import json
from pathlib import Path

import jsonschema
import pytest
from app.dfm import services
from app.dfm.dfm_analyzer import DFMReport, DimensionAnalysis


def _fake_report():
    return DFMReport(
        dimensions=DimensionAnalysis(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10.0),
        wall_thickness_issues=[],
        geometry_issues=[],
        overall_score="good",
        moldability_rating=8,
        recommendations=[],
    )


def test_result_schema(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report())
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    schema_path = Path(__file__).resolve().parents[1] / "schema" / "dfm_result.schema.json"
    schema = json.loads(schema_path.read_text())
    jsonschema.validate(result, schema)


def test_missing_summary_fails(client, sample_step_path, monkeypatch):
    monkeypatch.setattr(services, "analyze_dfm", lambda *a, **k: _fake_report())
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload", data={"file": (fh, "cube.step")}, content_type="multipart/form-data"
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    del result["summary"]
    schema_path = Path(__file__).resolve().parents[1] / "schema" / "dfm_result.schema.json"
    schema = json.loads(schema_path.read_text())
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(result, schema)


def test_missing_issue_type_fails():
    schema_path = Path(__file__).resolve().parents[1] / "schema" / "dfm_result.schema.json"
    schema = json.loads(schema_path.read_text())
    sample = {
        "job_id": "j1",
        "file_id": "f1",
        "summary": {
            "mass_g": 0,
            "bbox_mm": [1, 1, 1],
            "projected_area_mm2": 0,
            "avg_thickness_mm": 0,
            "min_thickness_mm": 0,
            "wall_thickness_histogram": [],
            "min_radius_mm": 0,
            "draft_ok_ratio": 0,
            "low_res": False
        },
        "issues": [{"description": "oops"}],
        "heatmap": {"metric": "t", "range": [0, 0], "per_face": []},
        "axis": {"x": 0, "y": 0, "z": 1},
        "material_profile": {"id": "ABS", "draft_min_deg": 1}
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(sample, schema)
