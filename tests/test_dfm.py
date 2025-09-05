import os
import importlib.util
import pathlib
import json
import pytest

root = pathlib.Path(__file__).resolve().parents[1]
interfaces_path = root / "app" / "dfm" / "interfaces.py"
spec = importlib.util.spec_from_file_location("dfm_interfaces", interfaces_path)
interfaces = importlib.util.module_from_spec(spec)
spec.loader.exec_module(interfaces)
interfaces.DFMInput.model_rebuild()
DFMInput = interfaces.DFMInput

analyzer_path = root / "dfm_analyzer.py"
spec_a = importlib.util.spec_from_file_location("dfm_analyzer", analyzer_path)
dfm_analyzer = importlib.util.module_from_spec(spec_a)
spec_a.loader.exec_module(dfm_analyzer)
run_dfm = dfm_analyzer.run_dfm


def test_dfm_input_validation():
    with pytest.raises(ValueError):
        DFMInput(file_id="1", step_path="", demold_axis=(1.0, 0.0, 0.0), material_profile={})
    with pytest.raises(ValueError):
        DFMInput(file_id="1", step_path="tests/sample.step", demold_axis=(0.0, 0.0, 0.0), material_profile={})


def test_run_dfm_basic(tmp_path):
    step_path = os.path.join(os.path.dirname(__file__), "sample.step")
    dfm_input = DFMInput(
        file_id="unittest",
        step_path=step_path,
        demold_axis=(0.0, 0.0, 1.0),
        material_profile={},
    )
    result = run_dfm(dfm_input)
    assert "bounding_box" in result.metrics
    assert set(result.views["camera_states"].keys()) == {"iso", "top", "right", "front"}
    assert "iso" in result.views["thumbnails"]
    cam_file = pathlib.Path("static/dfm/unittest/camera_states.json")
    heat_file = pathlib.Path("static/dfm/unittest/heatmap_faces.json")
    thumb_file = pathlib.Path("static/dfm/unittest/thumb_iso.png")
    assert cam_file.exists()
    assert heat_file.exists()
    assert thumb_file.exists()
    data = json.loads(cam_file.read_text())
    assert data["iso"]["eye"] is not None


def test_run_dfm_progress(tmp_path):
    step_path = os.path.join(os.path.dirname(__file__), "sample.step")
    dfm_input = DFMInput(
        file_id="progress",
        step_path=step_path,
        demold_axis=(0.0, 0.0, 1.0),
        material_profile={},
    )
    calls: list[int] = []
    run_dfm(dfm_input, progress_cb=calls.append)
    assert calls == [10, 40, 70, 85]


def test_run_dfm_fast_mode(tmp_path):
    step_path = os.path.join(os.path.dirname(__file__), "sample.step")
    dfm_input = DFMInput(
        file_id="fast",
        step_path=step_path,
        demold_axis=(0.0, 0.0, 1.0),
        material_profile={},
    )
    calls: list[int] = []
    result = run_dfm(dfm_input, progress_cb=calls.append, fast_mode=True)
    assert calls == [10, 40, 85]
    assert result.flags.get("partial") is True
    assert not result.heatmaps
    heat_file = pathlib.Path("static/dfm/fast/heatmap_faces.json")
    assert not heat_file.exists()
