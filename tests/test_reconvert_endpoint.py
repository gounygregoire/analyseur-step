"""Tests pour l'endpoint /api/reconvert."""
from __future__ import annotations

from types import SimpleNamespace

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

    monkeypatch.setattr(web, "get_queue", lambda: SimpleNamespace(enqueue=fake_enqueue))

    with web.app.test_client() as client:
        resp = client.post("/api/reconvert", json={"file_id": "abc123"})
    assert resp.status_code == 202
    data = resp.get_json()
    assert data == {"accepted": True, "file_id": "abc123", "job_id": "job-123"}
    assert calls["args"][0] == "cadlytics.jobs.reconvert.reconvert"
    assert calls["args"][1] == "abc123"
    assert calls["kwargs"]["job_timeout"] == 900


def test_reconvert_rejects_invalid_payload(monkeypatch):
    monkeypatch.setattr(web, "get_queue", lambda: None)
    with web.app.test_client() as client:
        resp = client.post("/api/reconvert", json={})
    assert resp.status_code == 400


def test_reconvert_status_finished(monkeypatch):
    queue = SimpleNamespace(connection=object())
    monkeypatch.setattr(web, "get_queue", lambda: queue)

    class FinishedJob:
        def __init__(self) -> None:
            self.result = {"ok": True}
            self.exc_info = None

        def get_status(self, refresh: bool = False) -> str:  # noqa: ARG002
            return "finished"

    def fake_fetch(cls, job_id: str, connection=None):  # noqa: ARG001
        assert job_id == "job-123"
        assert connection is queue.connection
        return FinishedJob()

    monkeypatch.setattr(web.Job, "fetch", classmethod(fake_fetch))

    with web.app.test_client() as client:
        resp = client.get("/api/reconvert/status/job-123")

    assert resp.status_code == 200
    assert resp.get_json() == {"status": "finished", "result": {"ok": True}}


def test_reconvert_status_failed(monkeypatch):
    queue = SimpleNamespace(connection=object())
    monkeypatch.setattr(web, "get_queue", lambda: queue)

    class FailedJob:
        def __init__(self) -> None:
            self.result = None
            self.exc_info = "Traceback...\nValueError: boom"

        def get_status(self, refresh: bool = False) -> str:  # noqa: ARG002
            return "failed"

    def fake_fetch(cls, job_id: str, connection=None):  # noqa: ARG001
        assert job_id == "job-404"
        assert connection is queue.connection
        return FailedJob()

    monkeypatch.setattr(web.Job, "fetch", classmethod(fake_fetch))

    with web.app.test_client() as client:
        resp = client.get("/api/reconvert/status/job-404")

    assert resp.status_code == 200
    assert resp.get_json() == {
        "status": "failed",
        "result": {"error": "ValueError: boom"},
    }


def test_reconvert_status_not_found(monkeypatch):
    queue = SimpleNamespace(connection=object())
    monkeypatch.setattr(web, "get_queue", lambda: queue)

    def fake_fetch(cls, job_id: str, connection=None):  # noqa: ARG001
        raise web.NoSuchJobError

    monkeypatch.setattr(web.Job, "fetch", classmethod(fake_fetch))

    with web.app.test_client() as client:
        resp = client.get("/api/reconvert/status/job-missing")

    assert resp.status_code == 404
    assert resp.get_json() == {"error": "Job introuvable"}
