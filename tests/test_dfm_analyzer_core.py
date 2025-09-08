import types
import sys

import numpy as np
import trimesh
from hypothesis import given, settings, strategies as st

import types, sys

fake_cq = types.ModuleType("cadquery")
fake_cq.importers = types.SimpleNamespace(importStep=lambda p: None)
fake_cq.exporters = types.SimpleNamespace(export=lambda wp, path: None)
sys.modules.setdefault("cadquery", fake_cq)

from app.dfm.adapters import step_loader


def test_analyze_dfm_core(monkeypatch):
    fake_mesh = types.SimpleNamespace(
        extents=(1.0, 2.0, 3.0),
        volume=6.0,
        area=10.0,
        faces=np.zeros((1, 3)),
    )

    fake_loader = types.ModuleType("step_loader")
    fake_loader.load_mesh = lambda path: (fake_mesh, False)
    fake_loader.compute_thickness = lambda mesh: (1.0, 0.5, [], [])
    fake_loader.compute_projected_area = lambda mesh, axis: 2.0
    fake_loader.compute_draft = lambda mesh, axis, deg: (0.9, [])
    fake_loader.find_small_radii = lambda mesh: (0.8, [])
    fake_loader.detect_undercuts = lambda mesh, axis: []
    monkeypatch.setitem(sys.modules, "app.dfm.adapters.step_loader", fake_loader)

    from app.dfm.dfm_analyzer import analyze_dfm

    report = analyze_dfm("dummy.step", {"x": 0, "y": 0, "z": 1}, "ABS")
    assert report.dimensions.x_max == 1.0
    assert report.avg_thickness == 1.0
    assert report.draft_ok_ratio == 0.9


def _tol_equal(value: float, expected: float) -> bool:
    tol = abs(expected) * 0.1 or 0.1
    return abs(value - expected) <= tol


def test_compute_projected_area_cube():
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    px = step_loader.compute_projected_area(mesh, (1, 0, 0))
    py = step_loader.compute_projected_area(mesh, (0, 1, 0))
    pz = step_loader.compute_projected_area(mesh, (0, 0, 1))
    assert _tol_equal(px, 2.0)
    assert _tol_equal(py, 2.0)
    assert _tol_equal(pz, 2.0)


def test_compute_thickness_histogram():
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 0.2))
    avg, min_t, hist, _ = step_loader.compute_thickness(mesh, samples=100)
    assert hist and min_t > 0


def test_compute_draft_ratio_changes():
    mesh = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    r1, _ = step_loader.compute_draft(mesh, (0, 0, 1), 1.0)
    r2, _ = step_loader.compute_draft(mesh, (0, 0, 1), 10.0)
    assert r1 > r2


def test_small_radii_and_undercuts(monkeypatch):
    mesh = trimesh.creation.icosphere(subdivisions=2, radius=0.1)

    def fake_curv(mesh, points, radius):
        return np.ones(len(points)) * 10.0

    monkeypatch.setattr(trimesh.curvature, "discrete_gaussian_curvature_measure", fake_curv)
    min_r, issues = step_loader.find_small_radii(mesh, min_radius=0.5)
    assert issues and min_r < 0.5
    cuts = step_loader.detect_undercuts(mesh, (0, 0, 1))
    assert len(cuts) > 0


@given(
    st.lists(st.floats(-1, 1), min_size=3, max_size=3)
)
@settings(max_examples=20, deadline=None)
def test_projected_area_non_negative(axis_vals):
    axis = np.array(axis_vals, dtype=float)
    if np.linalg.norm(axis) == 0:
        axis = np.array([1.0, 0.0, 0.0])
    axis /= np.linalg.norm(axis)
    mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    area = step_loader.compute_projected_area(mesh, tuple(axis))
    assert area >= 0


@given(
    st.tuples(
        st.floats(0.1, 2.0),
        st.floats(0.1, 2.0),
        st.floats(0.1, 2.0),
    )
)
@settings(max_examples=20, deadline=None)
def test_thickness_min_le_avg(extents):
    mesh = trimesh.creation.box(extents=extents)
    avg, min_t, _, _ = step_loader.compute_thickness(mesh, samples=50)
    assert min_t <= avg + 1e-6
