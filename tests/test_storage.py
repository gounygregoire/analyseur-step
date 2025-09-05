import os
import pathlib
import sys
import pytest

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(root))
from app.storage import Storage


def test_get_step_and_xkt_paths(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    step = uploads / "abc.step"
    step.write_text("STEP")
    converted = tmp_path / "converted"
    converted.mkdir()
    xkt = converted / "abc.xkt"
    xkt.write_text("XKT")

    monkeypatch.setattr(Storage, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(Storage, "CONVERTED_DIR", str(converted))

    assert Storage.get_step_path("abc") == str(step)
    assert Storage.get_xkt_path("abc") == str(xkt)

    with pytest.raises(FileNotFoundError):
        Storage.get_step_path("missing")
    with pytest.raises(FileNotFoundError):
        Storage.get_xkt_path("missing")


def test_ensure_dfm_dir(tmp_path, monkeypatch):
    base = tmp_path / "static" / "dfm"
    monkeypatch.setattr(Storage, "DFM_ROOT", str(base))
    path = Storage.ensure_dfm_dir("foo")
    assert path == os.path.join(str(base), "foo")
    assert pathlib.Path(path).exists()
