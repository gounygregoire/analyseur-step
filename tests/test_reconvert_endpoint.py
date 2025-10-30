"""Tests pour l'endpoint /api/reconvert."""
from __future__ import annotations

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
    assert resp.get_json() == {"accepted": False, "error": "missing file_id"}


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

    assert resp.status_code == 404
    assert resp.get_json() == {"status": "not_found"}
