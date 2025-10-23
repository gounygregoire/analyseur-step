import json
import pathlib
import importlib.util
import pytest

trimesh = pytest.importorskip("trimesh")

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("g3d", root / "generate_3d_view.py")
g3d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g3d)
generate_view_data = g3d.generate_view_data


def test_generate_view_data(tmp_path):
    mesh = trimesh.primitives.Box(extents=(1, 1, 1))
    stl_path = tmp_path / "cube.stl"
    mesh.export(stl_path)

    camera_states, heatmap, notice = generate_view_data(str(stl_path), "unitcube")
    assert set(camera_states.keys()) == {"iso", "top", "right", "front"}
    assert notice is None

    cam_file = pathlib.Path("static/dfm/unitcube/camera_states.json")
    heat_file = pathlib.Path("static/dfm/unitcube/heatmap_faces.json")
    assert cam_file.exists()
    assert heat_file.exists()
    data = json.loads(cam_file.read_text())
    assert data["front"]["eye"][1] < 0
    heat_data = json.loads(heat_file.read_text())
    assert isinstance(heat_data, dict)
