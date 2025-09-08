import sys
import types
import pathlib
import trimesh

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

# Inject fake cadquery to avoid heavy dependency
sys.modules.setdefault('cadquery', types.SimpleNamespace())

from app.dfm.adapters import step_loader


def test_compute_thickness_box():
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    avg, min_t, hist, per_face = step_loader.compute_thickness(mesh, samples=500)
    assert 0.9 < avg < 1.1
    assert 0.9 < min_t < 1.1
    assert hist
    assert per_face


def test_compute_projected_area_box():
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    area_x = step_loader.compute_projected_area(mesh, (1.0, 0.0, 0.0))
    assert 1.9 < area_x < 2.1


def test_compute_draft_box():
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    ok_ratio, issues = step_loader.compute_draft(mesh, (0.0, 0.0, 1.0), 1.0)
    assert 0.25 < ok_ratio < 0.4
    assert issues
