"""Tests du endpoint /api/files/<file_id>/status."""

from datetime import datetime, timezone
from models import File, db


def _insert_file(**kwargs) -> File:
    file_row = File(**kwargs)
    db.session.add(file_row)
    db.session.commit()
    return file_row


def test_status_ready_uses_http_head(api_app, api_client, monkeypatch):
    import backend.api.files as files_api

    file_id = "file-ready"
    with api_app.app_context():
        file_row = _insert_file(
            id=file_id,
            status="ready",
            xkt_url=f"https://cdn.example/xkt/{file_id}.xkt",
            error_message=None,
            updated_at=datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        )
        expected_updated_at = file_row.updated_at.isoformat()

    monkeypatch.setattr(files_api, "http_exists", lambda url: url.startswith("https://"))
    monkeypatch.setattr(files_api, "s3_object_exists", lambda *_, **__: False)

    resp = api_client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["status"] == "ready"
    assert payload["hasXKT"] is True
    assert payload["xkt_url"] == f"https://cdn.example/xkt/{file_id}.xkt"
    assert payload["glb_url"].endswith(f"{file_id}.glb")
    assert payload["updated_at"] == expected_updated_at
    assert payload["http_head_ok"] is True


def test_status_pending_when_artifact_missing(api_app, api_client, monkeypatch):
    import backend.api.files as files_api

    file_id = "file-processing"
    with api_app.app_context():
        file_row = _insert_file(
            id=file_id,
            status="processing",
            xkt_url=None,
            error_message=None,
            updated_at=datetime(2024, 2, 3, 4, 5, 6, tzinfo=timezone.utc),
        )
        expected_updated_at = file_row.updated_at.isoformat()

    monkeypatch.setattr(files_api, "http_exists", lambda *_: False)
    monkeypatch.setattr(files_api, "s3_object_exists", lambda *_, **__: False)

    resp = api_client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["status"] == "pending"
    assert payload["hasXKT"] is False
    assert payload["xkt_url"] is None
    assert payload["glb_url"] is None
    assert payload["updated_at"] == expected_updated_at


def test_status_failed_returns_error(api_app, api_client):
    file_id = "file-failed"
    with api_app.app_context():
        _insert_file(
            id=file_id,
            status="failed",
            xkt_url=None,
            error_message="Conversion échouée",
            updated_at=datetime(2024, 3, 4, 5, 6, 7, tzinfo=timezone.utc),
        )

    resp = api_client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["status"] == "error"
    assert payload["hasXKT"] is False
    assert payload["message"] == "Conversion échouée"


def test_status_unknown_file(api_client):
    resp = api_client.get("/api/files/does-not-exist/status")
    assert resp.status_code == 404
    data = resp.get_json()
    assert data["status"] == "error"
    assert data["message"] == "Fichier inconnu"
