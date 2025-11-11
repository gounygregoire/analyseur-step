import importlib.util
import io
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.file_records import get as get_file_record, mark_failed as mark_file_failed, mark_ready as mark_file_ready
from models import File, db

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
        monkeypatch.setenv("SRC_DIR", str(upload_dir))
        db_path = tmp_path / "cadlytics.sqlite"
        monkeypatch.setenv("SQLALCHEMY_DATABASE_URI", f"sqlite:///{db_path}")
        monkeypatch.setenv("MAX_UPLOAD_MB", str(max_mb))
        create_app, module = _load_create_app()
        app = create_app()
        app.config["TESTING"] = True
        with app.app_context():
            db.create_all()
        client = app.test_client()
        return client, upload_dir, output_dir, module

    return _make_client


def test_api_upload_starts_processing(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()

    scheduled: dict[str, tuple[str, str]] = {}

    class _DummyJob:
        def __init__(self, identifier: str | None):
            self.id = identifier

    def _fake_enqueue(*, file_id, src_path):
        scheduled["call"] = (file_id, src_path)
        return _DummyJob("job-123")

    monkeypatch.setattr(module, "enqueue_convert_xkt", _fake_enqueue)

    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    assert resp.status_code == 200

    data = resp.get_json()
    assert data["jobId"] == "job-123"

    file_id = data["fileId"]
    assert file_id

    assert "call" in scheduled
    assert scheduled["call"][0] == file_id
    saved_path = upload_dir / f"{file_id}__piece.step"
    assert saved_path.exists()
    assert (output_dir / f"{file_id}.xkt").exists() is False

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "processing"

    with client.application.app_context():
        file_row = db.session.get(File, file_id)
        assert file_row is not None
        assert file_row.original_name == "piece.step"


def test_status_ready_returns_absolute_url(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()

    class _DummyJob:
        id = None

    monkeypatch.setattr(module, "enqueue_convert_xkt", lambda **_: _DummyJob())
    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    file_id = resp.get_json()["fileId"]

    xkt_path = output_dir / f"{file_id}.xkt"
    xkt_path.write_bytes(b"xkt")
    mark_file_ready(file_id, xkt_path=str(xkt_path), xkt_url=f"https://cdn.example/xkt/{file_id}.xkt")

    status_resp = client.get(f"/api/files/{file_id}/status")
    assert status_resp.status_code == 200
    payload = status_resp.get_json()
    assert payload["status"] == "ready"
    assert payload["xkt_url"] == f"https://cdn.example/xkt/{file_id}.xkt"
    assert payload["xkt_url"].endswith(f"/{file_id}.xkt")
    assert payload["message"] == ""
    assert "file_id" not in payload


def test_status_failed_returns_message(client_factory, monkeypatch):
    client, _, output_dir, module = client_factory()

    class _DummyJob:
        id = None

    monkeypatch.setattr(module, "enqueue_convert_xkt", lambda **_: _DummyJob())
    resp = client.post("/api/upload", data={"file": (io.BytesIO(b"cad"), "piece.step")})
    file_id = resp.get_json()["fileId"]

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
    file_id = resp.get_json()["fileId"]
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
    assert resp.get_json() == {"error": "unknown file_id"}


def test_status_uses_sqlalchemy_model(client_factory):
    client, *_ = client_factory()
    file_id = "11111111-1111-4111-8111-111111111111"
    with client.application.app_context():
        db.session.add(
            File(
                id=file_id,
                original_name="piece.step",
                status="ready",
                xkt_url="https://cdn/sqlalchemy/xkt/file.xkt",
                error_message=None,
                updated_at=datetime.now(timezone.utc),
            )
        )
        db.session.commit()

    resp = client.get(f"/api/files/{file_id}/status")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["status"] == "ready"
    assert payload["xkt_url"] == "https://cdn/sqlalchemy/xkt/file.xkt"
    assert payload["message"] == ""
    assert payload["updated_at"] is not None


def test_conversion_worker_marks_ready(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()
    file_id = "1234567890abcdef1234567890abcdef"
    step_path = upload_dir / f"{file_id}.step"
    step_path.write_bytes(b"cad")
    module._create_record(file_id, "piece.step", str(step_path))

    dummy_xkt = output_dir / f"{file_id}.xkt"
    dummy_xkt.write_bytes(b"xkt")

    def _fake_convert(fid: str, src: str):
        assert fid == file_id
        assert src == str(step_path)
        mark_file_ready(fid, xkt_path=str(dummy_xkt), xkt_url=f"https://cdn/xkt/{fid}.xkt")
        return str(dummy_xkt), f"https://cdn/xkt/{fid}.xkt"

    monkeypatch.setattr(module, "convert_to_xkt", _fake_convert)

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

    def _raise(fid: str, *_args, **_kwargs):
        mark_file_failed(fid, "boom")
        raise RuntimeError("boom")

    monkeypatch.setattr(module, "convert_to_xkt", _raise)

    module._conversion_worker(file_id, str(step_path))

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "failed"
    assert "boom" in (record.error_message or "")


def test_convert_to_xkt_local_updates_db(client_factory, monkeypatch):
    client, upload_dir, output_dir, module = client_factory()
    file_id = "fedcfedc-fedc-4edc-bedc-fedcfedcfedc"
    step_path = upload_dir / f"{file_id}.step"
    step_path.write_bytes(b"cad-data")

    module._create_record(file_id, "piece.step", str(step_path))

    with client.application.app_context():
        db.session.add(File(id=file_id, original_name="piece.step", status="processing"))
        db.session.commit()

    module.XKT_STORAGE = "local"
    module.XKT_BASE_URL = "https://cdn.dev/xkt"

    def _fake_converter(src: str, dest: str) -> None:
        assert src == str(step_path)
        with open(dest, "wb") as handle:
            handle.write(b"XKT-CONVERTED")

    monkeypatch.setattr(module, "run_real_xkt_converter", _fake_converter)

    final_path, xkt_url = module.convert_to_xkt(file_id, str(step_path))

    assert Path(final_path) == output_dir / f"{file_id}.xkt"
    assert Path(final_path).read_bytes() == b"XKT-CONVERTED"
    assert xkt_url == f"https://cdn.dev/xkt/{file_id}.xkt"

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "ready"
    assert record.xkt_url == xkt_url

    with client.application.app_context():
        file_row = db.session.get(File, file_id)
        assert file_row is not None
        assert file_row.status == "ready"
        assert file_row.xkt_url == xkt_url
        assert file_row.error_message in (None, "")
        assert file_row.updated_at is not None


def test_convert_to_xkt_failure_marks_failed(client_factory, monkeypatch):
    client, upload_dir, _, module = client_factory()
    file_id = "deadbeef-dead-4eef-bead-deadbeefdead"
    step_path = upload_dir / f"{file_id}.step"
    step_path.write_bytes(b"cad-data")

    module._create_record(file_id, "piece.step", str(step_path))

    with client.application.app_context():
        db.session.add(File(id=file_id, original_name="piece.step", status="processing"))
        db.session.commit()

    module.XKT_STORAGE = "local"

    def _boom(src: str, dest: str) -> None:
        with open(dest, "wb") as handle:
            handle.write(b"bad")
        raise RuntimeError("explode")

    monkeypatch.setattr(module, "run_real_xkt_converter", _boom)

    with pytest.raises(RuntimeError):
        module.convert_to_xkt(file_id, str(step_path))

    record = get_file_record(file_id)
    assert record is not None
    assert record.status == "failed"
    assert "explode" in (record.error_message or "")

    with client.application.app_context():
        file_row = db.session.get(File, file_id)
        assert file_row is not None
        assert file_row.status == "failed"
        assert file_row.error_message and "explode" in file_row.error_message


def test_api_health_endpoint(client_factory):
    client, *_ = client_factory()
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}


def test_api_routes_endpoint_lists_status_route(client_factory):
    client, *_ = client_factory()
    resp = client.get("/api/_routes")
    assert resp.status_code == 200
    payload = resp.get_json()
    routes = payload.get("routes", [])
    status_routes = [r for r in routes if r.get("rule") == "/api/files/<file_id>/status"]
    assert status_routes, "status route should be listed"
    methods = {m for route in status_routes for m in route.get("methods", "").split(",") if m}
    assert "GET" in methods
