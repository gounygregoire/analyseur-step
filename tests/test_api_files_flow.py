"""Tests d'intégration rapides pour /api/files* (blueprint backend)."""

import io
import os
from pathlib import Path

from models import File, db


def _post_file(api_client, filename: str = "piece.step"):
    data = {"file": (io.BytesIO(b"cadlytics"), filename)}
    return api_client.post("/api/files", data=data)


def test_post_files_enqueues_job(monkeypatch, api_app, api_client):
    import backend.api.files as files_api

    monkeypatch.setattr(files_api, "_should_force_sample_mode", lambda: False)

    captured: dict[str, str] = {}

    def _fake_enqueue(file_id: str) -> str:
        captured["file_id"] = file_id
        return "job-123"

    monkeypatch.setattr(files_api, "_enqueue_conversion_job", _fake_enqueue)

    resp = _post_file(api_client)
    assert resp.status_code == 202
    payload = resp.get_json()
    assert payload == {
        "fileId": captured["file_id"],
        "file_id": captured["file_id"],
        "jobId": "job-123",
        "status": "enqueued",
        "hasXKT": False,
        "xkt_url": None,
        "xktUrl": None,
        "glb_url": None,
        "message": None,
    }

    with api_app.app_context():
        file_row = db.session.get(File, captured["file_id"])
        assert file_row is not None
        assert file_row.status == "enqueued"
        assert file_row.xkt_url is None


def test_post_files_fallback_sample_when_forced(api_app, api_client, monkeypatch):
    import backend.api.files as files_api

    monkeypatch.setattr(files_api, "_should_force_sample_mode", lambda: True)

    resp = _post_file(api_client)
    assert resp.status_code == 201
    payload = resp.get_json()
    file_id = payload["file_id"]

    assert payload["status"] == "ready"
    assert payload["hasXKT"] is True
    assert payload["xkt_url"].endswith(f"{file_id}.xkt")

    xkt_path = Path(api_app.config.get("OUTPUT_FOLDER") or os.environ["OUTPUT_FOLDER"]) / f"{file_id}.xkt"
    assert xkt_path.exists()
    assert xkt_path.read_bytes() == b"XKT-FAKE"

    xkt_resp = api_client.get(f"/api/files/{file_id}/xkt")
    assert xkt_resp.status_code == 200
    assert xkt_resp.data == b"XKT-FAKE"


def test_post_files_reports_conversion_error(api_app, api_client, monkeypatch):
    import backend.api.files as files_api

    def _raise(*_args, **_kwargs):  # pragma: no cover - intentionally raised
        raise RuntimeError("boom")

    monkeypatch.setattr(files_api, "_should_force_sample_mode", lambda: True)
    monkeypatch.setattr(files_api, "generate_xkt_for_file", _raise)

    resp = _post_file(api_client)
    assert resp.status_code == 500
    payload = resp.get_json()
    assert payload["error"] == "conversion_failed"
    assert payload["detail"]

    file_id = payload["file_id"]
    with api_app.app_context():
        file_row = db.session.get(File, file_id)
        assert file_row is not None
        assert file_row.status == "failed"
        assert file_row.error_message


def test_get_xkt_missing_returns_404(api_client):
    resp = api_client.get("/api/files/ffffffff-ffff-ffff-ffff-ffffffffffff/xkt")
    assert resp.status_code == 404
    assert resp.get_json()["error"] in {"file_not_found", "xkt_not_found"}
