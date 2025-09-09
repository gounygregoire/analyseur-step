import sys
import types

import numpy as np
import pytest


def _setup_fake_modules(monkeypatch):
    fake_cq = types.SimpleNamespace(
        importers=types.SimpleNamespace(importStep=lambda path: "wp"),
        exporters=types.SimpleNamespace(
            export=lambda wp, path: open(path, "wb").write(b""))
    )

    class FakeMesh:
        def __init__(self):
            self.faces = np.zeros((10, 3))
            self.decimated = False

        def simplify_quadratic_decimation(self, target):
            self.decimated = True
            return self

    fake_trimesh = types.SimpleNamespace(
        load=lambda path, force="mesh": FakeMesh(),
        Scene=type("Scene", (), {}),
    )

    monkeypatch.setitem(sys.modules, "cadquery", fake_cq)
    monkeypatch.setitem(sys.modules, "trimesh", fake_trimesh)

    return FakeMesh


def test_load_mesh_faces(monkeypatch, sample_step_path):
    _setup_fake_modules(monkeypatch)
    from importlib import reload
    from app.dfm.adapters import step_loader

    reload(step_loader)
    mesh, low_res = step_loader.load_mesh(str(sample_step_path("cube_small.step")))
    assert mesh.faces.shape[0] > 0
    assert low_res is False


def test_low_res_threshold_env(monkeypatch, sample_step_path):
    _setup_fake_modules(monkeypatch)
    monkeypatch.setenv("STEP_LOADER_MAX_BYTES", "1")
    from importlib import reload
    from app.dfm.adapters import step_loader

    reload(step_loader)
    mesh, low_res = step_loader.load_mesh(str(sample_step_path("huge_dummy.step")))
    assert low_res is True
    assert mesh.decimated


def test_corrupted_step(monkeypatch, tmp_path):
    def _bad(*a, **k):
        raise RuntimeError("bad step")

    fake_cq = types.SimpleNamespace(
        importers=types.SimpleNamespace(importStep=_bad),
        exporters=types.SimpleNamespace(export=lambda wp, path: None),
    )
    fake_trimesh = types.SimpleNamespace(load=lambda *a, **k: None, Scene=type("Scene", (), {}))

    monkeypatch.setitem(sys.modules, "cadquery", fake_cq)
    monkeypatch.setitem(sys.modules, "trimesh", fake_trimesh)
    from importlib import reload
    from app.dfm.adapters import step_loader

    reload(step_loader)
    step_file = tmp_path / "bad.step"
    step_file.write_text("ISO-10303-21;")
    with pytest.raises(ValueError) as exc:
        step_loader.load_mesh(str(step_file))
    assert "Failed to load STEP" in str(exc.value)
