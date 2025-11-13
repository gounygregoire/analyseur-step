"""Tests du endpoint /api/files/<file_id>/status."""

import os
from datetime import datetime, timezone
from pathlib import Path

from models import File, db


def _insert_file(**kwargs) -> File:
    file_row = File(**kwargs)
    db.session.add(file_row)
    db.session.commit()
    return file_row


def _xkt_path(app, file_id: str) -> Path:
    base = Path(app.config.get("OUTPUT_FOLDER") or os.environ["OUTPUT_FOLDER"])
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{file_id}.xkt"


def test_status_ready_reflects_disk(api_app, api_client):
    file_id = "file-ready"
    with api_app.app_context():
        xkt_path = _xkt_path(api_app, file_id)
        xkt_path.write_bytes(b"xkt")
        file_row = _insert_file(
            id=file_id,
            status="ready",
            xkt_url=f"/api/files/{file_id}/xkt",
            error_message=None,
            updated_at=datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        )
        expected_updated_at = file_row.updated_at.isoformat()

    resp = api_client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    assert resp.get_json() == {
        "fileId": file_id,
        "file_id": file_id,
        "status": "ready",
        "hasXKT": True,
        "xkt_url": f"/api/files/{file_id}/xkt",
        "xktUrl": f"/api/files/{file_id}/xkt",
        "glb_url": f"https://cadlytics.app/glb/{file_id}.glb",
        "message": None,
        "updated_at": expected_updated_at,
        "xktPath": str(_xkt_path(api_app, file_id)),
    }


def test_status_pending_when_file_missing(api_app, api_client):
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

    resp = api_client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload == {
        "fileId": file_id,
        "file_id": file_id,
        "status": "pending",
        "hasXKT": False,
        "xkt_url": None,
        "xktUrl": None,
        "glb_url": None,
        "message": None,
        "updated_at": expected_updated_at,
        "xktPath": payload["xktPath"],
    }


def test_status_unknown_file(api_client):
    resp = api_client.get("/api/files/does-not-exist/status")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "unknown file_id"}
