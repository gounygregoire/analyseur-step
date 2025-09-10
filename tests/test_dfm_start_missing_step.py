import sys
import pathlib
from flask import Flask

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from api.dfm import dfm_bp


def test_start_missing_step(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    app = Flask(__name__)
    app.register_blueprint(dfm_bp)
    client = app.test_client()
    resp = client.post(
        "/api/dfm/start",
        json={"file_id": "missing", "material_profile_id": "ABS", "axis": "AUTO"},
    )
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "step_not_found_for_file_id"
    assert "Upload must save" in data["hint"]
