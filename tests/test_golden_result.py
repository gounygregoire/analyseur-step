import json
import math
import sys
import types
from pathlib import Path

import pytest
import trimesh


def _setup_fake_loader(monkeypatch):
    fake_cq = types.SimpleNamespace(
        importers=types.SimpleNamespace(importStep=lambda path: None),
        exporters=types.SimpleNamespace(export=lambda wp, path: open(path, "wb").write(b"")),
    )
    monkeypatch.setitem(sys.modules, "cadquery", fake_cq)
    import app.dfm.adapters.step_loader as step_loader

    cube = trimesh.creation.box((1, 1, 1))
    monkeypatch.setattr(step_loader, "load_mesh", lambda *a, **k: (cube, False))
    monkeypatch.setattr(step_loader, "compute_thickness", lambda *a, **k: (1.0, 1.0, [], []))
    monkeypatch.setattr(step_loader, "find_small_radii", lambda *a, **k: (1.0, []))
    monkeypatch.setattr(step_loader, "detect_undercuts", lambda *a, **k: [])


def test_golden_result(client, sample_step_path, request, monkeypatch):
    _setup_fake_loader(monkeypatch)
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        file_id = client.post(
            "/api/upload",
            data={"file": (fh, "cube.step")},
            content_type="multipart/form-data",
        ).get_json()["file_id"]
    job_id = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "material_profile": "ABS", "axis": {"x": 0, "y": 0, "z": 1}},
    ).get_json()["job_id"]
    result = client.get("/api/dfm/result", query_string={"job_id": job_id}).get_json()
    summary = {
        "bbox_mm": result["summary"]["bbox_mm"],
        "projected_area_mm2": result["summary"]["projected_area_mm2"],
        "draft_ok_ratio": result["summary"]["draft_ok_ratio"],
    }
    golden_path = Path(__file__).parent / "data" / "golden_cube.json"
    if request.config.getoption("--update-goldens"):
        golden_path.write_text(json.dumps(summary, indent=2))
        pytest.skip("golden updated")
    golden = json.loads(golden_path.read_text())
    assert all(
        math.isclose(summary["bbox_mm"][i], golden["bbox_mm"][i], rel_tol=0.1)
        for i in range(3)
    )
    assert math.isclose(
        summary["projected_area_mm2"], golden["projected_area_mm2"], rel_tol=0.1
    )
    assert math.isclose(
        summary["draft_ok_ratio"], golden["draft_ok_ratio"], rel_tol=0.1
    )

