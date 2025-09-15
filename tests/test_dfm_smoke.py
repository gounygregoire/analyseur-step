import json
import time
import types
from pathlib import Path
import sys

from flask import Flask


def test_dfm_smoke(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "converted"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(outputs))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))

    fake_module = types.SimpleNamespace(convert_step_to_xkt=lambda *a, **k: None)
    monkeypatch.setitem(sys.modules, "xkt_converter", fake_module)
    from api.contract import api_contract_bp

    # Stub Celery task module before importing routes
    report_template = {
        "status": "done",
        "score": 72,
        "recommendations": [
            {
                "id": "thickness_uniformity",
                "level": "warning",
                "message": "Épaisseur non uniforme.",
            }
        ],
        "metrics": {
            "min_thickness_mm": 1.2,
            "max_thickness_mm": 3.8,
            "avg_thickness_mm": 2.4,
            "undercuts_count": 2,
        },
    }

    def stub_delay(file_id, **kwargs):
        out_dir = Path("static/dfm") / file_id
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(json.dumps(report_template))
        return types.SimpleNamespace(id="job1")

    fake_tasks = types.ModuleType("tasks.dfm")
    fake_tasks.dfm_run = types.SimpleNamespace(delay=stub_delay)
    monkeypatch.setitem(sys.modules, "tasks.dfm", fake_tasks)
    fake_mat = types.ModuleType("app.material_profiles")
    fake_mat.get_profile = lambda name: {"id": name}
    monkeypatch.setitem(sys.modules, "app.material_profiles", fake_mat)

    import app.api.dfm_routes as routes

    app = Flask(__name__)
    app.register_blueprint(api_contract_bp)
    app.register_blueprint(routes.dfm_public_bp)
    client = app.test_client()

    # stub converter
    def fake_convert(inp, out, stl_tolerance):
        Path(out).write_text("xkt")

    monkeypatch.setattr(
        "app.api.contract_routes.xkt_converter.convert_step_to_xkt",
        fake_convert,
    )
    gen_mod = types.ModuleType("generate_thumbnails")
    gen_mod.generate_thumbnails = lambda step_path, out_dir: {"iso": str(Path(out_dir) / "preview.png")}
    sys.modules["generate_thumbnails"] = gen_mod

    sample = Path("tests/sample.step")
    with sample.open("rb") as fh:
        up = client.post("/api/simple/upload", data={"file": (fh, "sample.step")})
    assert up.status_code == 200
    file_id = up.get_json()["file_id"]

    conv = client.post("/api/simple/convert", json={"file_id": file_id})
    xkt_url = conv.get_json()["xkt_url"]
    print("XKT viewer URL:", xkt_url)

    start = client.post(
        "/dfm/start",
        json={"file_id": file_id, "material": "ABS", "axis": "Z"},
    )
    assert start.status_code == 202

    for _ in range(60):
        rep = client.get(f"/dfm/report/{file_id}")
        if rep.status_code == 200:
            data = rep.get_json()
            break
        time.sleep(0.5)
    else:
        raise AssertionError("report timeout")

    assert data["status"] == "done"
    assert data["score"] == 72
    assert data["recommendations"]
    assert data["metrics"]
