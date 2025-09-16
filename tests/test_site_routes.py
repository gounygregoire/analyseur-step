"""Tests de fumée pour les routes publiques (landing, viewer, outputs)."""

import importlib.util
from pathlib import Path

import pytest


APP_MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"


def _load_create_app():
    spec = importlib.util.spec_from_file_location("cadlytics_app_module_site", APP_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    loader = spec.loader
    assert loader is not None
    loader.exec_module(module)
    return module.create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(outputs))
    create_app = _load_create_app()
    app = create_app()
    with app.test_client() as client:
        yield client


def test_marketing_page_served(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Cadlytics" in resp.data


def test_viewer_page_served(client):
    resp = client.get("/app")
    assert resp.status_code == 200
    assert b"Viewer" in resp.data


def test_public_outputs_serves_file(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    target = outputs / "dummy.txt"
    target.write_text("hello", encoding="utf-8")
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(outputs))
    create_app = _load_create_app()
    app = create_app()
    with app.test_client() as client:
        resp = client.get("/outputs/dummy.txt")
    assert resp.status_code == 200
    assert resp.data == b"hello"


def test_public_outputs_rejects_traversal(client):
    resp = client.get("/outputs/../../app.py")
    assert resp.status_code == 404


def test_index_template_points_to_marketing():
    tpl = Path(__file__).resolve().parents[1] / "templates" / "index.html"
    content = tpl.read_text(encoding="utf-8")
    assert "marketing_index.html" in content
    assert "{% include 'marketing_index.html' %}" in content


def test_app_viewer_has_no_three_import():
    tpl = Path(__file__).resolve().parents[1] / "templates" / "app_viewer.html"
    content = tpl.read_text(encoding="utf-8").lower()
    assert "three.js" not in content
    assert "orbitcontrols" not in content


def test_no_legacy_static_viewer_assets():
    root = Path(__file__).resolve().parents[1]
    assert not (root / "static" / "viewer.js").exists()
    assert not (root / "static" / "uploader.js").exists()
