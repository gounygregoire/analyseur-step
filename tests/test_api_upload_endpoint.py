import importlib.util
import io
import sys
from pathlib import Path

import pytest

from app.file_records import get as get_file_record, mark_failed as mark_file_failed, mark_ready as mark_file_ready

APP_MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"


def _load_create_app():
    spec = importlib.util.spec_from_file_location("cadlytics_app_module", APP_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    loader = spec.loader
    assert loader is not None
    loader.exec_module(module)
    sys.modules.setdefault("cadlytics_app_module", module)
    return module.create_app, module


@pytest.fixture
def client_factory(tmp_path, monkeypatch):
    def _make_client(max_mb="1"):
        upload_dir = tmp_path / "uploads"
        output_dir = tmp_path / "converted"
        monkeypatch.setenv("UPLOAD_FOLDER", str(upload_dir))
        monkeypatch.setenv("OUTPUT_FOLDER", str(output_dir))
        monkeypatch.setenv("XKT_LOCAL_DIR", str(output_dir))
        monkeypatch.setenv("MAX_UPLOAD_MB", str(max_mb))
        create_app, module = _load_create_app()
        app = create_app()
        app.config["TESTING"] = True
        client = app.test_client()
        return client, upload_dir, output_dir, module

    return _make_client


def test_api_upload_starts_processing(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()

    scheduled: dict[str, tuple[str, str]] = {}

    def _fake_schedule(file_id, step_path):
        scheduled["call"] = (file_id, step_path)

    monkeypatch.setattr(module, "_schedule_conversion", _fake_schedule)

    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    assert resp.status_code == 202

    data = resp.get_json()
    assert data["status"] == "processing"
    assert data["xkt_url"] is None
    assert data["message"] is None

    file_id = data["file_id"]
    assert len(file_id) == 32

    assert "call" in scheduled
    assert scheduled["call"][0] == file_id
    saved_path = upload_dir / f"{file_id}.step"
    assert saved_path.exists()
    assert (output_dir / f"{file_id}.xkt").exists() is False

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "processing"


def test_status_ready_returns_absolute_url(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()

    monkeypatch.setattr(module, "_schedule_conversion", lambda *a, **k: None)
    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    file_id = resp.get_json()["file_id"]

    xkt_path = output_dir / f"{file_id}.xkt"
    xkt_path.write_bytes(b"xkt")
    mark_file_ready(file_id, xkt_path=str(xkt_path), xkt_url=f"https://cdn.example/xkt/{file_id}.xkt")

    status_resp = client.get(f"/api/files/{file_id}/status")
    assert status_resp.status_code == 200
    payload = status_resp.get_json()
    assert payload["status"] == "ready"
    assert payload["xkt_url"].endswith(f"/{file_id}.xkt")
    assert payload["message"] is None


def test_status_failed_returns_message(client_factory, monkeypatch):
    client, _, output_dir, module = client_factory()

    monkeypatch.setattr(module, "_schedule_conversion", lambda *a, **k: None)
    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    file_id = resp.get_json()["file_id"]

    mark_file_failed(file_id, "Conversion échouée")

    status_resp = client.get(f"/api/files/{file_id}/status")
    assert status_resp.status_code == 200
    payload = status_resp.get_json()
    assert payload["status"] == "failed"
    assert payload["message"] == "Conversion échouée"
    assert payload["xkt_url"] is None


def test_reconvert_resets_status_and_triggers_worker(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()

    recorder: list[tuple[str, str]] = []

    def _fake_schedule(file_id, step_path):
        recorder.append((file_id, step_path))

    monkeypatch.setattr(module, "_schedule_conversion", _fake_schedule)

    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    file_id = resp.get_json()["file_id"]
    step_path = upload_dir / f"{file_id}.step"
    assert step_path.exists()

    mark_file_ready(file_id, xkt_path=str(output_dir / f"{file_id}.xkt"), xkt_url=f"https://cdn/xkt/{file_id}.xkt")

    reconv = client.post(f"/api/files/{file_id}/reconvert")
    assert reconv.status_code == 202
    data = reconv.get_json()
    assert data["status"] == "processing"
    assert recorder
    assert recorder[-1][0] == file_id


def test_status_unknown_returns_404(client_factory):
    client, _, _, _ = client_factory()
    resp = client.get("/api/files/ffffffffffffffffffffffffffffffff/status")
    assert resp.status_code == 404


def test_conversion_worker_marks_ready(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()
    file_id = "1234567890abcdef1234567890abcdef"
    step_path = upload_dir / f"{file_id}.step"
    step_path.write_bytes(b"cad")
    module._create_record(file_id, "piece.step", str(step_path))

    class _DummyResult:
        def __init__(self, local_path: str, xkt_url: str):
            self.local_path = local_path
            self.xkt_url = xkt_url

    dummy_xkt = output_dir / f"{file_id}.xkt"
    dummy_xkt.write_bytes(b"xkt")

    monkeypatch.setattr(
        module,
        "convert_and_publish_xkt",
        lambda fid, path: _DummyResult(str(dummy_xkt), f"https://cdn/xkt/{fid}.xkt"),
    )

    module._conversion_worker(file_id, str(step_path))

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "ready"
    assert record.xkt_url and record.xkt_url.endswith(f"/{file_id}.xkt")


def test_conversion_worker_marks_failed(client_factory, monkeypatch):
    client, upload_dir, _, module = client_factory()
    file_id = "abcdefabcdefabcdefabcdefabcdefab"
    step_path = upload_dir / f"{file_id}.step"
    step_path.write_bytes(b"cad")
    module._create_record(file_id, "piece.step", str(step_path))

    def _raise(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(module, "convert_and_publish_xkt", _raise)

    module._conversion_worker(file_id, str(step_path))

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "failed"
    assert "boom" in (record.error_message or "")
