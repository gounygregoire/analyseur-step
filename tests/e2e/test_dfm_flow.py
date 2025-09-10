import os
import sys
import time
import json
import uuid
import pathlib
import pytest
from flask import Flask, request, jsonify

# Allow imports from repo root
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT))

from api.dfm import dfm_bp
import app.storage.storage as storage
import importlib
import generate_3d_view
import generate_thumbnails


@pytest.mark.e2e
@pytest.mark.skipif(os.getenv("RUN_E2E") != "1", reason="end-to-end test requires RUN_E2E=1")
def test_dfm_flow(tmp_path, monkeypatch):
    """End-to-end DFM analysis flow."""
    # Work inside temporary directory
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("UPLOAD_FOLDER", "uploads")
    monkeypatch.setenv("DFM_ROOT", os.path.join("static", "dfm"))
    importlib.reload(storage)
    os.makedirs(storage.UPLOAD_FOLDER, exist_ok=True)

    # Lightweight mocks to avoid heavy rendering
    def fake_generate_view_data(stl_path, file_id):
        out_dir = os.path.join("static", "dfm", file_id)
        os.makedirs(out_dir, exist_ok=True)
        cam_path = os.path.join(out_dir, "camera_states.json")
        with open(cam_path, "w", encoding="utf-8") as fh:
            json.dump({"iso": {"eye": [1, 1, 1], "look": [0, 0, 0], "up": [0, 0, 1]}}, fh)
        heat_path = os.path.join(out_dir, "heatmap_faces.json")
        with open(heat_path, "w", encoding="utf-8") as fh:
            json.dump({}, fh)
        return {"iso": {"eye": [1, 1, 1], "look": [0, 0, 0], "up": [0, 0, 1]}}, {}

    def fake_generate_thumbnails(step_path, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        thumb = os.path.join(out_dir, "thumb_iso.png")
        with open(thumb, "wb") as fh:
            fh.write(b"0")
        return {"iso": thumb}

    monkeypatch.setattr(generate_3d_view, "generate_view_data", fake_generate_view_data)
    monkeypatch.setattr(generate_thumbnails, "generate_thumbnails", fake_generate_thumbnails)

    app = Flask(__name__)
    app.register_blueprint(dfm_bp)

    @app.route("/api/upload", methods=["POST"])
    def upload():
        file = request.files["file"]
        file_id = uuid.uuid4().hex
        dest = os.path.join(storage.UPLOAD_FOLDER, f"{file_id}.step")
        file.save(dest)
        return jsonify({"file_id": file_id})

    client = app.test_client()

    sample = ROOT / "tests" / "sample.step"
    with open(sample, "rb") as fh:
        resp = client.post(
            "/api/upload",
            data={"file": (fh, "sample.step")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 200
    file_id = resp.get_json()["file_id"]

    start = client.post(
        "/api/dfm/start",
        json={"file_id": file_id, "demold_axis": [0, 1, 0], "material_profile": {}},
    )
    assert start.status_code == 202
    job_id = start.get_json()["job_id"]

    for _ in range(50):
        st = client.get("/api/dfm/status", query_string={"job_id": job_id})
        data = st.get_json()
        if data["status"] == "done":
            out = pathlib.Path("static/dfm") / file_id
            assert (out / "camera_states.json").exists()
            assert (out / "thumb_iso.png").exists()
            heatmap = out / "heatmap_faces.json"
            if heatmap.exists():
                assert json.loads(heatmap.read_text()) == {}
            break
        elif data["status"] == "error":
            pytest.fail(f"job failed: {data.get('error')}")
        time.sleep(0.1)
    else:
        pytest.fail("job not finished")
