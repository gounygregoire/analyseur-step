import importlib
import logging
import shutil
import sys


def test_boot_creates_dirs_and_logs(monkeypatch, tmp_path, caplog):
    uploads = tmp_path / "up"
    converted = tmp_path / "conv"
    monkeypatch.setenv("UPLOAD_FOLDER", str(uploads))
    monkeypatch.setenv("OUTPUT_FOLDER", str(converted))
    monkeypatch.setenv("XEOKIT_CONVERT", shutil.which("echo"))
    monkeypatch.setenv("PATH", "x")

    if "boot" in sys.modules:
        del sys.modules["boot"]

    with caplog.at_level(logging.INFO):
        boot = importlib.import_module("boot")
        importlib.reload(boot)

    assert uploads.exists()
    assert converted.exists()
    assert any("BOOT_OK" in rec.message for rec in caplog.records)

