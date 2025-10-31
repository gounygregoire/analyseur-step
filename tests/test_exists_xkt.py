"""Tests pour l'endpoint /exists/xkt/<id>."""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

if "boto3" not in sys.modules:
    boto3_stub = ModuleType("boto3")
    boto3_stub.client = lambda *args, **kwargs: SimpleNamespace()
    sys.modules["boto3"] = boto3_stub

if "botocore" not in sys.modules:
    sys.modules["botocore"] = ModuleType("botocore")

import web


def test_exists_xkt_returns_done(tmp_path, monkeypatch):
    base_dir = tmp_path / "public_xkt"
    base_dir.mkdir()
    file_id = "abc123"
    target = base_dir / f"{file_id}.xkt"
    target.write_bytes(b"dummy")

    monkeypatch.setenv("PUBLIC_XKT", str(base_dir))

    with web.app.test_client() as client:
        resp = client.get(f"/exists/xkt/{file_id}")

    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload == {
        "file_id": file_id,
        "exists": True,
        "size": target.stat().st_size,
        "status": "done",
    }
    cache_control = resp.headers.get("Cache-Control", "")
    pragma = resp.headers.get("Pragma", "")
    combined_headers = f"{cache_control} {pragma}".lower()
    assert "no-cache" in combined_headers
