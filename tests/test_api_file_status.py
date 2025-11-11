"""Tests du endpoint /api/files/<file_id>/status."""

from datetime import datetime, timezone

from models import File, db


def _insert_file(**kwargs) -> File:
    file_row = File(**kwargs)
    db.session.add(file_row)
    db.session.commit()
    return file_row


def test_status_ready_returns_payload(api_app, api_client):
    with api_app.app_context():
        file_row = _insert_file(
            id="file-ready",
            status="ready",
            xkt_url="https://cdn.local/xkt/file-ready.xkt",
            error_message="converted",
            updated_at=datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        )
        expected_updated_at = file_row.updated_at.isoformat()

    resp = api_client.get("/api/files/file-ready/status")
    assert resp.status_code == 200
    assert resp.get_json() == {
        "status": "ready",
        "xkt_url": "https://cdn.local/xkt/file-ready.xkt",
        "message": "converted",
        "updated_at": expected_updated_at,
    }


def test_status_processing_does_not_404(api_app, api_client):
    with api_app.app_context():
        file_row = _insert_file(
            id="file-processing",
            status="processing",
            xkt_url=None,
            error_message=None,
            updated_at=datetime(2024, 2, 3, 4, 5, 6, tzinfo=timezone.utc),
        )
        expected_updated_at = file_row.updated_at.isoformat()

    resp = api_client.get("/api/files/file-processing/status")
    assert resp.status_code == 200
    assert resp.get_json() == {
        "status": "processing",
        "xkt_url": None,
        "message": "",
        "updated_at": expected_updated_at,
    }


def test_status_unknown_file(api_client):
    resp = api_client.get("/api/files/does-not-exist/status")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "unknown file_id"}
