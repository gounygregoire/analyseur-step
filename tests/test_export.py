import gzip
import json
import cadquery as cq
from dfm.export import export_step


def _make_block_with_fillet(path):
    w = cq.Workplane("XY").box(10, 10, 10).edges("|Z").fillet(0.2)
    cq.exporters.export(w, path)


def _make_thin_plate(path):
    w = cq.Workplane("XY").box(20, 20, 0.5)
    cq.exporters.export(w, path)


def test_radius_issue(tmp_path):
    step_path = tmp_path / "fillet.step"
    _make_block_with_fillet(step_path)
    data = gzip.decompress(export_step(str(step_path)))
    js = json.loads(data)
    assert js["summary"]["issues_count"] > 0
    assert any(i["type"] == "radius" for i in js["issues"])
    assert "face_issue_map" in js


def test_thin_wall_issue(tmp_path):
    step_path = tmp_path / "thin.step"
    _make_thin_plate(step_path)
    data = gzip.decompress(export_step(str(step_path)))
    js = json.loads(data)
    assert any(i["type"] == "thin_wall" for i in js["issues"])
