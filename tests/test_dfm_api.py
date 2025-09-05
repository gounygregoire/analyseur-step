import os
import sys
import time
import pathlib
import pytest
from flask import Flask

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(root))
from api.dfm import dfm_bp
from app.storage import Storage


@pytest.fixture()
def client():
    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    return app.test_client()


def test_dfm_endpoints(tmp_path, monkeypatch, client):
    step_file = tmp_path / "piece.step"
    step_file.write_text("STEP DATA")
    bad_step = tmp_path / "bad.step"
    bad_step.write_text("not a step")

    def fake_get_step_path(file_id: str) -> str:
        return str(step_file if file_id == "foo" else bad_step)

    monkeypatch.setattr(Storage, "get_step_path", staticmethod(fake_get_step_path))

    resp = client.post(
        "/api/dfm/start",
        json={
            "file_id": "foo",
            "demold_axis": [0, 1, 0],
            "material_profile": {},
        },
    )
    assert resp.status_code == 202
    job_id = resp.get_json()["job_id"]

    for _ in range(20):
        st = client.get("/api/dfm/status", query_string={"job_id": job_id})
        data = st.get_json()
        if data["status"] == "done":
            assert data["progress"] == 100
            assert "result" in data
            result_json = pathlib.Path("static/dfm/foo/result.json")
            assert result_json.exists()
            cam_json = pathlib.Path("static/dfm/foo/camera_states.json")
            heat_json = pathlib.Path("static/dfm/foo/heatmap_faces.json")
            thumb_png = pathlib.Path("static/dfm/foo/thumb_iso.png")
            assert cam_json.exists()
            assert heat_json.exists()
            assert thumb_png.exists()
            break
        time.sleep(0.1)
    else:
        pytest.fail("job not finished")

    # error case
    resp_err = client.post(
        "/api/dfm/start",
        json={"file_id": "bad", "demold_axis": [0, 0, 1], "material_profile": {}},
    )
    assert resp_err.status_code == 202
    job_err = resp_err.get_json()["job_id"]
    for _ in range(20):
        st = client.get("/api/dfm/status", query_string={"job_id": job_err})
        data = st.get_json()
        if data["status"] == "error":
            assert data["error_code"] == "invalid_step"
            assert "Invalid" in data["message"]
            assert data["progress"] == 100
            break
        time.sleep(0.1)
    else:
        pytest.fail("job error not reported")


def test_dfm_fast_mode_api(tmp_path, monkeypatch, client):
    step_file = tmp_path / "heavy.step"
    step_file.write_text("ISO-10303 data")

    def fake_get_step_path(file_id: str) -> str:
        return str(step_file)

    monkeypatch.setattr(Storage, "get_step_path", staticmethod(fake_get_step_path))
    monkeypatch.setattr(os.path, "getsize", lambda p: 60 * 1024 * 1024)

    resp = client.post(
        "/api/dfm/start",
        json={"file_id": "big", "demold_axis": [0, 1, 0], "material_profile": {}},
    )
    assert resp.status_code == 202
    job_id = resp.get_json()["job_id"]

    for _ in range(20):
        st = client.get("/api/dfm/status", query_string={"job_id": job_id})
        data = st.get_json()
        if data["status"] == "done":
            assert data["result"]["flags"]["partial"] is True
            heat_json = pathlib.Path("static/dfm/big/heatmap_faces.json")
            assert not heat_json.exists()
            break
        time.sleep(0.1)
    else:
        pytest.fail("fast job not finished")
