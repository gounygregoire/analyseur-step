"""Celery task for running DFM analysis."""

from celery import shared_task

from app.dfm.dfm_analyzer import run_dfm
from app.material_profiles import get_profile

import json
import os
import logging

logger = logging.getLogger(__name__)


@shared_task(bind=True, name="tasks.dfm.dfm_run")
def dfm_run(self, file_id, material_profile_id, axis, invert=False, tolerance=None):
    """Run the DFM analysis for a given STEP file and write report.json."""
    # >>> CADLYTICS PATCH: RESOLVE STEP (BEGIN)
    from app.storage.storage import Storage

    step_path = Storage.get_step_path(file_id)
    if not (step_path and os.path.isfile(step_path)):
        raise FileNotFoundError(f"step_not_found_for_file_id {file_id}")
    # >>> CADLYTICS PATCH: RESOLVE STEP (END)
    profile = get_profile(material_profile_id)
    if profile is None:
        raise ValueError("unknown_material_profile")

    dfm_input = {
        "file_id": file_id,
        "step_path": step_path,
        "axis": axis,
        "invert": invert,
        "material_profile": profile.model_dump(),
    }

    out_dir = os.path.join("static", "dfm", file_id)
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, "report.json")

    def _write_report(data: dict) -> None:
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    # Generate viewer artefacts (heatmaps, thumbnails...)
    try:
        result = run_dfm(dfm_input, progress_cb=None, fast_mode=False)
    except Exception as exc:  # pragma: no cover - artefact generation is best effort
        logger.exception("[DFM] run_dfm failed for file_id=%s", file_id)
        error_report = {
            "status": "error",
            "message": f"DFM échoué: {exc}",
        }
        _write_report(error_report)
        raise

    heatmap_file = os.path.join(out_dir, "heatmap_faces.json")

    # Aggregate a DFM report based on the computed results
    report_data = {
        "status": "done",
        "metrics": result.metrics,
        "issues": result.issues,
        "heatmaps": result.heatmaps,
        "views": result.views,
        "flags": result.flags,
        "material_profile_id": material_profile_id,
        "axis": axis,
        "invert": invert,
        "step_path": step_path,
        "heatmap_files": {"faces": heatmap_file} if os.path.isfile(heatmap_file) else {},
    }

    _write_report(report_data)
    logger.info("DFM written \u2192 %s", report_path)

    return report_data
