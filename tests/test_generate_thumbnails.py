import pathlib
import importlib.util
import pytest

trimesh = pytest.importorskip("trimesh")

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("thumbs", root / "generate_thumbnails.py")
thumbs_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(thumbs_mod)
generate_thumbnails = thumbs_mod.generate_thumbnails


def test_generate_thumbnails(tmp_path):
    mesh = trimesh.primitives.Box(extents=(1, 1, 1))
    stl_path = tmp_path / "cube.stl"
    mesh.export(stl_path)
    out_dir = tmp_path / "thumbs"
    thumbs = generate_thumbnails(str(stl_path), str(out_dir))
    assert {"iso", "top", "side"} <= set(thumbs.keys())
    for path in thumbs.values():
        assert pathlib.Path(path).exists()
