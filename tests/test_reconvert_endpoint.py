"""Tests pour les endpoints /api/reconvert."""
from __future__ import annotations

import json
from types import SimpleNamespace

import rq.job

import web


class DummyJob:
    def __init__(self, job_id: str):
        self.id = job_id


def test_reconvert_accepts(monkeypatch):
    calls = {}

    def fake_enqueue(*args, **kwargs):
        calls["args"] = args
        calls["kwargs"] = kwargs
        return DummyJob("job-123")

    monkeypatch.setattr(web, "queue", SimpleNamespace(enqueue=fake_enqueue))
    with web.app.test_client() as client:
        resp = client.post("/api/reconvert", json={"file_id": "abc123"})
    assert resp.status_code == 202
    data = resp.get_json()
    assert data == {"accepted": True, "file_id": "abc123", "job_id": "job-123"}
    assert calls["args"][0] == "cadlytics.jobs.reconvert.reconvert"
    assert calls["args"][1] == "abc123"
    assert calls["kwargs"]["job_timeout"] == 1800


def test_reconvert_rejects_invalid_payload(monkeypatch):
    monkeypatch.setattr(web, "queue", None)
    with web.app.test_client() as client:
        resp = client.post("/api/reconvert", json={})
    assert resp.status_code == 400
    assert resp.get_json() == {"accepted": False, "error": "missing_file_id"}


def test_reconvert_status_finished(monkeypatch):
    connection_obj = object()
    monkeypatch.setattr(web, "redis_conn", connection_obj)

    class FinishedJob:
        def __init__(self) -> None:
            self.result = {"ok": True}

        def get_status(self):
            return "finished"

    def fake_fetch(job_id: str, connection=None):  # noqa: ARG001
        assert job_id == "job-123"
        assert connection is connection_obj
        return FinishedJob()

    monkeypatch.setattr(rq.job.Job, "fetch", classmethod(lambda cls, job_id, connection=None: fake_fetch(job_id, connection=connection)))

    with web.app.test_client() as client:
        resp = client.get("/api/reconvert/status/job-123")

    assert resp.status_code == 200
    assert resp.get_json() == {"status": "finished", "result": {"ok": True}}


def test_reconvert_status_not_found(monkeypatch):
    connection_obj = object()
    monkeypatch.setattr(web, "redis_conn", connection_obj)

    def fake_fetch(job_id: str, connection=None):  # noqa: ARG001
        raise RuntimeError("missing")

    monkeypatch.setattr(rq.job.Job, "fetch", classmethod(lambda cls, job_id, connection=None: fake_fetch(job_id, connection=connection)))

    with web.app.test_client() as client:
        resp = client.get("/api/reconvert/status/job-missing")

    assert resp.status_code == 200
    assert resp.get_json() == {"status": "failed", "result": {}}


def test_converter_health_npm_ok(monkeypatch):
    calls = []

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        calls.append(cmd[0])
        assert cmd[0] == "npx"
        return SimpleNamespace(returncode=0, stdout="1.3.1", stderr="")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.get("/api/converter/health")

    assert resp.status_code == 200
    assert resp.get_json() == {"npm": True, "docker": None}
    assert calls == ["npx"]


def test_converter_health_fallback_docker(monkeypatch):
    calls = []

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        calls.append(cmd[0])
        if cmd[0] == "npx":
            return SimpleNamespace(returncode=1, stdout="", stderr="boom")
        assert cmd[0] == "docker"
        return SimpleNamespace(returncode=0, stdout="Docker version", stderr="")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.get("/api/converter/health")

    assert resp.status_code == 200
    assert resp.get_json() == {"npm": False, "docker": True}
    assert calls == ["npx", "docker"]


def test_converter_health_missing_binaries(monkeypatch):
    calls = []

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        calls.append(cmd[0])
        if cmd[0] == "npx":
            raise FileNotFoundError("npx")
        assert cmd[0] == "docker"
        raise FileNotFoundError("docker")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.get("/api/converter/health")

    assert resp.status_code == 200
    assert resp.get_json() == {"npm": False, "docker": False}
    assert calls == ["npx", "docker"]


def _setup_sync_dirs(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "converted"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setattr(web, "UPLOAD_FOLDER", str(uploads))
    monkeypatch.setattr(web, "OUTPUT_FOLDER", str(outputs))
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    sync_dir = outputs / "xkt"
    sync_dir.mkdir()
    web.app.config["SYNC_XKT_DIR"] = str(sync_dir)
    return uploads, sync_dir


def test_reconvert_sync_missing_file_id(tmp_path, monkeypatch):
    _setup_sync_dirs(tmp_path, monkeypatch)

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={})

    assert resp.status_code == 400
    assert resp.get_json() == {"ok": False, "error": "missing_file_id"}


def test_reconvert_sync_source_not_found(tmp_path, monkeypatch):
    uploads, sync_dir = _setup_sync_dirs(tmp_path, monkeypatch)

    with web.app.test_client() as client:
        resp = client.post(
            "/api/reconvert/sync",
            json={"file_id": "123e4567-e89b-12d3-a456-426614174000"},
        )

    assert resp.status_code == 404
    assert resp.get_json() == {"ok": False, "error": "source_not_found"}


def test_reconvert_sync_too_large(tmp_path, monkeypatch):
    uploads, _ = _setup_sync_dirs(tmp_path, monkeypatch)
    file_id = "123e4567-e89b-12d3-a456-426614174000"
    src = uploads / f"{file_id}.step"
    src.write_bytes(b"0" * ((8 * 1024 * 1024) + 1))

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={"file_id": file_id})

    assert resp.status_code == 413
    body = resp.get_json()
    assert body["ok"] is False
    assert body["error"] == "too_large_for_sync"
    assert body["size_mb"] >= 8


def test_reconvert_sync_success(tmp_path, monkeypatch):
    uploads, sync_dir = _setup_sync_dirs(tmp_path, monkeypatch)
    file_id = "123e4567-e89b-12d3-a456-426614174000"
    src = uploads / f"{file_id}.step"
    src.write_text("step data")

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        assert "@xeokit/xeokit-convert" in cmd
        tmp_out = sync_dir / f"{file_id}.xkt.tmp"
        tmp_out.write_bytes(b"1234567890")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={"file_id": file_id})

    assert resp.status_code == 200
    data = resp.get_json()
    assert data == {"ok": True, "xkt_size": 10}

    final_path = sync_dir / f"{file_id}.xkt"
    manifest_path = sync_dir / f"{file_id}.manifest.json"
    assert final_path.exists()
    assert manifest_path.exists()
    with manifest_path.open() as fh:
        manifest = json.load(fh)
    assert manifest["ok"] is True
    assert manifest["xkt_size"] == 10


def test_reconvert_sync_converter_not_available(tmp_path, monkeypatch):
    uploads, _ = _setup_sync_dirs(tmp_path, monkeypatch)
    file_id = "123e4567-e89b-12d3-a456-426614174000"
    src = uploads / f"{file_id}.step"
    src.write_text("step data")

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        if cmd[0] == "npx":
            return SimpleNamespace(returncode=1, stdout="", stderr="boom")
        assert cmd[0] == "docker"
        return SimpleNamespace(returncode=1, stdout="", stderr="docker oops")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={"file_id": file_id})

    assert resp.status_code == 503
    data = resp.get_json()
    assert data == {
        "ok": False,
        "error": "converter_not_available",
        "stderr": "docker oops",
    }


def test_reconvert_sync_fallback_docker_success(tmp_path, monkeypatch):
    uploads, sync_dir = _setup_sync_dirs(tmp_path, monkeypatch)
    file_id = "123e4567-e89b-12d3-a456-426614174000"
    src = uploads / f"{file_id}.step"
    src.write_text("step data")

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        if cmd[0] == "npx":
            return SimpleNamespace(returncode=1, stdout="", stderr="boom")
        assert cmd[0] == "docker"
        tmp_out = sync_dir / f"{file_id}.xkt.tmp"
        tmp_out.write_bytes(b"abc")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={"file_id": file_id})

    assert resp.status_code == 200
    data = resp.get_json()
    assert data == {"ok": True, "xkt_size": 3}


def test_reconvert_sync_docker_missing(tmp_path, monkeypatch):
    uploads, _ = _setup_sync_dirs(tmp_path, monkeypatch)
    file_id = "123e4567-e89b-12d3-a456-426614174000"
    src = uploads / f"{file_id}.step"
    src.write_text("step data")

    def fake_run(cmd, capture_output=False, text=False, timeout=None):  # noqa: ARG001
        if cmd[0] == "npx":
            raise FileNotFoundError("npx")
        assert cmd[0] == "docker"
        raise FileNotFoundError("docker")

    monkeypatch.setattr(web.subprocess, "run", fake_run)

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert/sync", json={"file_id": file_id})

    assert resp.status_code == 503
    data = resp.get_json()
    assert data == {
        "ok": False,
        "error": "converter_not_available",
        "stderr": "docker",
    }
