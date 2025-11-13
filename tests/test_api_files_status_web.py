"""Tests des routes /api/files/* servies par web.py."""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

if "boto3" not in sys.modules:
    boto3_stub = ModuleType("boto3")
    boto3_stub.client = lambda *args, **kwargs: SimpleNamespace()
    sys.modules["boto3"] = boto3_stub

if "botocore" not in sys.modules:
    sys.modules["botocore"] = ModuleType("botocore")
if "botocore.config" not in sys.modules:
    botocore_config = ModuleType("botocore.config")

    class _Config:
        def __init__(self, *args, **kwargs):
            pass

    botocore_config.Config = _Config
    sys.modules["botocore.config"] = botocore_config

import web


def _prepare_env(tmp_path, monkeypatch):
    base_dir = tmp_path / "converted"
    base_dir.mkdir()
    monkeypatch.setenv("OUTPUT_FOLDER", str(base_dir))
    monkeypatch.delenv("PUBLIC_XKT", raising=False)
    web.OUTPUT_FOLDER = str(base_dir)
    return base_dir


def test_api_file_status_ready(tmp_path, monkeypatch):
    base_dir = _prepare_env(tmp_path, monkeypatch)
    file_id = "11111111-aaaa-2222-bbbb-333333333333"
    target = base_dir / f"{file_id}.xkt"
    target.write_bytes(b"xkt-ready")

    with web.app.test_client() as client:
        resp = client.get(f"/api/files/{file_id}/status")

    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["fileId"] == file_id
    assert payload["status"] == "ready"
    assert payload["hasXKT"] is True
    assert payload["xkt_url"].endswith(f"/api/files/{file_id}/xkt")


def test_api_file_status_pending_returns_200(tmp_path, monkeypatch):
    _prepare_env(tmp_path, monkeypatch)
    file_id = "99999999-bbbb-cccc-dddd-eeeeeeeeeeee"

    with web.app.test_client() as client:
        resp = client.get(f"/api/files/{file_id}/status")

    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload == {
        "fileId": file_id,
        "file_id": file_id,
        "status": "pending",
        "hasXKT": False,
        "xkt_url": None,
    }


def test_api_file_xkt_serves_binary(tmp_path, monkeypatch):
    base_dir = _prepare_env(tmp_path, monkeypatch)
    file_id = "22222222-3333-4444-5555-666666666666"
    binary = b"cadlytics-xkt"
    (base_dir / f"{file_id}.xkt").write_bytes(binary)

    with web.app.test_client() as client:
        resp = client.get(f"/api/files/{file_id}/xkt")

    assert resp.status_code == 200
    assert resp.data == binary
    assert resp.headers.get("Content-Type") == "application/octet-stream"


def test_api_file_xkt_missing_returns_404(tmp_path, monkeypatch):
    _prepare_env(tmp_path, monkeypatch)
    file_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    with web.app.test_client() as client:
        resp = client.get(f"/api/files/{file_id}/xkt")

    assert resp.status_code == 404
    assert resp.get_json() == {"error": "xkt_not_found", "fileId": file_id}
