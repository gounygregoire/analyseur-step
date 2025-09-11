"""Celery task for running DFM analysis."""

from celery import shared_task

from app.dfm.dfm_analyzer import run_dfm, analyze_dfm
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

    # Generate viewer artefacts (heatmaps, thumbnails...)
    run_dfm(dfm_input, progress_cb=None, fast_mode=False)

    # Full analysis for metrics/recommendations
    axis_vec = _axis_to_dict(axis, invert)
    try:
        report = analyze_dfm(step_path, axis_vec, profile.id)
        per_face = getattr(report, "thickness_per_face", []) or []
        max_t = max((v.get("value", 0.0) for v in per_face), default=0.0)
        recs = [
            {
                "id": i.issue_type,
                "level": i.severity,
                "message": i.recommendation or i.description,
            }
            for i in getattr(report, "geometry_issues", [])
        ]
        report_data = {
            "status": "done",
            "score": int(getattr(report, "moldability_rating", 0) * 10),
            "recommendations": recs,
            "metrics": {
                "min_thickness_mm": float(getattr(report, "min_thickness", 0.0)),
                "max_thickness_mm": float(max_t),
                "avg_thickness_mm": float(getattr(report, "avg_thickness", 0.0)),
                "undercuts_count": int(
                    sum(1 for i in getattr(report, "geometry_issues", []) if i.issue_type == "undercut")
                ),
            },
        }
    except Exception as exc:  # pragma: no cover - robustness
        report_data = {"status": "error", "message": str(exc)}

    out_dir = os.path.join("static", "dfm", file_id)
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report_data, fh)
    logger.info("DFM written \u2192 %s", report_path)

    return report_data


def _axis_to_dict(axis, invert):
    """Normalize axis/invert to a dict understood by analyze_dfm."""
    a = (axis or "z").lower()
    mul = -1.0 if invert else 1.0
    if a == "x":
        return {"x": mul, "y": 0.0, "z": 0.0}
    if a == "y":
        return {"x": 0.0, "y": mul, "z": 0.0}
    return {"x": 0.0, "y": 0.0, "z": mul}
