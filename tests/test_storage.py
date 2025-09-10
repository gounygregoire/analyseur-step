import os
import pathlib
import sys
import importlib
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
import app.storage.storage as storage


def test_paths(tmp_path, monkeypatch):
    db_path = tmp_path / "files.sqlite"
    uploads = tmp_path / "uploads"
    converted = tmp_path / "converted"
    uploads.mkdir()
    converted.mkdir()
    monkeypatch.setenv("FILES_DB_PATH", str(db_path))
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(converted))
    importlib.reload(storage)
    Storage = storage.Storage

    step = uploads / "abc.step"
    step.write_text("STEP")
    xkt = converted / "abc.xkt"
    xkt.write_text("XKT")

    assert Storage.get_step_path("abc") == str(step)
    assert Storage.get_xkt_path("abc") == str(xkt)
    assert Storage.get_step_path("missing") is None
    assert Storage.get_xkt_path("missing") is None

    db_step = uploads / "db.step"
    db_step.write_text("DB")
    Storage.save_step_record("dbid", "db.step", str(db_step), db_step.stat().st_size)
    assert Storage.get_step_path("dbid") == str(db_step)
