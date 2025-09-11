import json
import time
import types
from pathlib import Path
import sys

from flask import Flask

from api.contract import api_contract_bp


def test_dfm_smoke(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "converted"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(outputs))
    monkeypatch.setenv("FILES_DB_PATH", str(tmp_path / "files.sqlite"))

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

    import app.api.dfm_routes as routes
    monkeypatch.setattr(routes.dfm_run, "delay", stub_delay)

    app = Flask(__name__)
    app.register_blueprint(api_contract_bp)
    app.register_blueprint(routes.dfm_public_bp)
    client = app.test_client()

    # stub converter
    def fake_run(cmd, capture_output, text, timeout):
        Path(cmd[3]).write_text("xkt")
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("app.api.contract_routes.subprocess.run", fake_run)
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
