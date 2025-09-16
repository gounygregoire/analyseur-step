import importlib.util
import io
from pathlib import Path

import pytest


APP_MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"


def _load_create_app():
    spec = importlib.util.spec_from_file_location("cadlytics_app_module", APP_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    loader = spec.loader
    assert loader is not None
    loader.exec_module(module)
    return module.create_app


@pytest.fixture
def client_factory(tmp_path, monkeypatch):
    def _make_client(max_mb="1"):
        upload_dir = tmp_path / "uploads"
        output_dir = tmp_path / "converted"
        monkeypatch.setenv("UPLOAD_FOLDER", str(upload_dir))
        monkeypatch.setenv("OUTPUT_FOLDER", str(output_dir))
        monkeypatch.setenv("MAX_UPLOAD_MB", str(max_mb))
        create_app = _load_create_app()
        app = create_app()
        app.config["TESTING"] = True
        client = app.test_client()
        return client, upload_dir, output_dir

    return _make_client


def test_api_upload_success(client_factory):
    client, upload_dir, output_dir = client_factory()
    payload = {"file": (io.BytesIO(b"cad"), "piece.step")}

    resp = client.post("/api/upload?mode=view", data=payload)
    assert resp.status_code == 200

    data = resp.get_json()
    assert data["mode"] == "view"
    assert data["step_name"] == "piece.step"
    file_id = data["file_id"]
    assert len(file_id) == 32

    saved_path = Path(data["step_path"])
    assert saved_path.exists()
    assert saved_path.parent == upload_dir
    assert saved_path.name == f"{file_id}.step"
    assert data["xkt_url"] == f"/outputs/{file_id}.xkt"


def test_api_upload_rejects_bad_extension(client_factory):
    client, _, _ = client_factory()
    payload = {"file": (io.BytesIO(b"cad"), "notes.txt")}

    resp = client.post("/api/upload", data=payload)
    assert resp.status_code == 400
    data = resp.get_json()
    assert "Extension non supportée" in data["error"]


def test_api_upload_requires_file(client_factory):
    client, _, _ = client_factory()

    resp = client.post("/api/upload")
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["error"] == "Aucun fichier reçu"


def test_api_upload_too_large(client_factory):
    client, _, _ = client_factory(max_mb="0.0001")
    payload = {"file": (io.BytesIO(b"x" * 2048), "big.step")}

    resp = client.post("/api/upload", data=payload)
    assert resp.status_code == 413
    data = resp.get_json()
    assert (
        data["error"]
        == "Fichier trop volumineux. Réduis la taille ou augmente MAX_UPLOAD_MB."
    )


def test_api_upload_save_failure(monkeypatch, client_factory):
    import werkzeug.datastructures

    def _fail_save(self, dst, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(werkzeug.datastructures.FileStorage, "save", _fail_save)
    client, upload_dir, _ = client_factory()
    payload = {"file": (io.BytesIO(b"cad"), "piece.step")}

    resp = client.post("/api/upload", data=payload)
    assert resp.status_code == 500
    data = resp.get_json()
    assert data["error"] == "Impossible de sauvegarder le fichier"
    assert not any(upload_dir.iterdir())


def test_outputs_returns_404_when_missing(client_factory):
    client, _, _ = client_factory()
    resp = client.get("/outputs/does-not-exist.xkt")
    assert resp.status_code == 404


def test_api_unknown_route_returns_json_404(client_factory):
    client, _, _ = client_factory()
    resp = client.get("/api/does-not-exist")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "Ressource API introuvable"}


def test_api_convert_creates_dummy_xkt(client_factory):
    client, upload_dir, output_dir = client_factory()
    payload = {"file": (io.BytesIO(b"cad"), "piece.step")}

    upload_resp = client.post("/api/upload", data=payload)
    assert upload_resp.status_code == 200
    file_id = upload_resp.get_json()["file_id"]

    convert_resp = client.post(f"/api/convert/{file_id}")
    assert convert_resp.status_code == 200

    data = convert_resp.get_json()
    assert data["file_id"] == file_id
    assert data["xkt_url"] == f"/outputs/{file_id}.xkt"

    xkt_path = output_dir / f"{file_id}.xkt"
    assert xkt_path.exists()
    assert xkt_path.read_bytes() == b"XKT_DUMMY"

    served = client.get(data["xkt_url"])
    assert served.status_code == 200
    assert served.data == b"XKT_DUMMY"


def test_api_convert_rejects_invalid_id(client_factory):
    client, _, _ = client_factory()
    resp = client.post("/api/convert/not-a-uuid")
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "Identifiant de fichier invalide"


def test_api_convert_requires_existing_source(client_factory):
    client, _, _ = client_factory()
    bogus_id = "f" * 32
    resp = client.post(f"/api/convert/{bogus_id}")
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "Fichier source introuvable pour conversion"
