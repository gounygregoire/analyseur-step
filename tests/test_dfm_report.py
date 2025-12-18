import json
import os
import pathlib
import shutil

from tasks import dfm
from app.storage import storage


def test_dfm_report_contains_results_and_assets(monkeypatch):
    file_id = "reportjson"
    step_path = os.path.join(os.path.dirname(__file__), "sample.step")
    out_dir = pathlib.Path("static") / "dfm" / file_id
    shutil.rmtree(out_dir, ignore_errors=True)

    monkeypatch.setattr(storage.Storage, "get_step_path", lambda _file_id: step_path)

    report = dfm.dfm_run.run(file_id, "GENERIC", (0.0, 0.0, 1.0), False)

    report_path = out_dir / "report.json"
    data = json.loads(report_path.read_text())

    assert data["metrics"]["bounding_box"] == report["metrics"]["bounding_box"]
    assert set(data["metrics"]["bounding_box"].keys()) == {"x", "y", "z"}
    assert data["material_profile_id"] == "GENERIC"
    assert tuple(data["axis"]) == (0.0, 0.0, 1.0)
    assert data["invert"] is False
    assert data["step_path"] == step_path

    for thumb_path in data["views"]["thumbnails"].values():
        assert pathlib.Path(thumb_path).is_file()

    heatmap_path = data.get("heatmap_files", {}).get("faces") or str(out_dir / "heatmap_faces.json")
    assert pathlib.Path(heatmap_path).is_file()
