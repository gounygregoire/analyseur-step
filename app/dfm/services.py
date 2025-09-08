"""Fonctions de haut niveau pour l'analyse DFM."""

import json
import os
import threading
import uuid
import time
import logging
from pathlib import Path
from typing import Any, Dict

import numpy as np

from app.storage import files
from .dfm_analyzer import analyze_dfm
from .interfaces import Axis, DFMResult, Heatmap, HeatmapEntry, MaterialProfile, Summary

RESULTS_DIR = Path(os.getenv("RESULTS_DIR", "/data/results"))
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

LOG_PATH = Path(os.getenv("DFM_LOG", "logs/dfm.log"))
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
_logger = logging.getLogger("dfm")
if not _logger.handlers:
    _logger.setLevel(logging.INFO)
    _handler = logging.FileHandler(LOG_PATH)
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    _logger.addHandler(_handler)

_jobs: Dict[str, Dict[str, Any]] = {}


def _axis_dict(axis: Any) -> Dict[str, float]:
    if isinstance(axis, dict):
        return {
            "x": float(axis.get("x", 0.0)),
            "y": float(axis.get("y", 0.0)),
            "z": float(axis.get("z", 1.0)),
        }
    if isinstance(axis, str):
        axis = axis.lower()
        if axis == "x":
            return {"x": 1.0, "y": 0.0, "z": 0.0}
        if axis == "y":
            return {"x": 0.0, "y": 1.0, "z": 0.0}
        return {"x": 0.0, "y": 0.0, "z": 1.0}
    return {"x": 0.0, "y": 0.0, "z": 1.0}


def _auto_axis(step_path: str) -> Dict[str, float]:
    from .adapters.step_loader import load_mesh
    mesh, _ = load_mesh(step_path)
    vec = mesh.principal_inertia_vectors[0]
    norm = float(np.linalg.norm(vec)) or 1.0
    vec = vec / norm
    return {"x": float(vec[0]), "y": float(vec[1]), "z": float(vec[2])}


def launch_job(file_id: str, material_profile: str, axis: Any | None) -> str:
    """Lance une analyse DFM asynchrone."""
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "pending", "progress": 0, "file_id": file_id}

    def _worker() -> None:
        start = time.perf_counter()
        try:
            _jobs[job_id]["status"] = "running"
            _jobs[job_id]["progress"] = 10
            meta = files.get(file_id)
            if not meta:
                raise FileNotFoundError("file_not_found")
            axis_dict = _axis_dict(axis) if axis else _auto_axis(str(meta.path))
            report = analyze_dfm(str(meta.path), axis_dict, material_profile)
            per_face = getattr(report, "thickness_per_face", []) or []
            result = DFMResult(
                job_id=job_id,
                file_id=file_id,
                summary=Summary(
                    mass_g=float(getattr(report.dimensions, "volume", 0.0) * 1e-3),
                    bbox_mm=(
                        getattr(report.dimensions, "x_max", 0.0),
                        getattr(report.dimensions, "y_max", 0.0),
                        getattr(report.dimensions, "z_max", 0.0),
                    ),
                    projected_area_mm2=getattr(report.dimensions, "projected_area_z", 0.0),
                    avg_thickness_mm=getattr(report, "avg_thickness", 0.0),
                    min_thickness_mm=getattr(report, "min_thickness", 0.0),
                    wall_thickness_histogram=getattr(report, "thickness_histogram", []) or [],
                    min_radius_mm=getattr(report, "min_radius", 0.0),
                    draft_ok_ratio=getattr(report, "draft_ok_ratio", 0.0),
                    low_res=getattr(report.dimensions, "low_res", False),
                ),
                issues=[],
                heatmap=Heatmap(
                    metric="thickness_mm",
                    range=(
                        float(min((v["value"] for v in per_face), default=0.0)),
                        float(max((v["value"] for v in per_face), default=0.0)),
                    ),
                    per_face=[
                        HeatmapEntry(face_id=int(v["face_id"]), value=float(v["value"]))
                        for v in per_face
                    ],
                ),
                axis=Axis(**axis_dict),
                material_profile=MaterialProfile(
                    id=material_profile, draft_min_deg=1.0
                ),
            )
            result_json = result.model_dump()
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            res_path = RESULTS_DIR / f"{job_id}.json"
            res_path.write_text(json.dumps(result_json))
            _jobs[job_id]["result_path"] = str(res_path)
            _jobs[job_id]["result"] = result_json
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["progress"] = 100
            duration = time.perf_counter() - start
            _logger.info(
                "job=%s file=%s size=%d bbox=%s dt=%.2f",
                job_id,
                file_id,
                meta.size,
                result.summary.bbox_mm,
                duration,
            )
        except Exception as exc:  # pragma: no cover - robustesse
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(exc)
            _jobs[job_id]["progress"] = 100
            _jobs[job_id]["result"] = {"job_id": job_id, "file_id": file_id, "error": str(exc)}
            _logger.error(
                "job=%s file=%s size=%s error=%s",
                job_id,
                file_id,
                getattr(meta, "size", 0),
                exc,
            )

    threading.Thread(target=_worker, daemon=True).start()
    return job_id


def get_status(job_id: str) -> Dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        return {"status": "error", "progress": 0, "error": "job_not_found"}
    return {"status": job["status"], "progress": job.get("progress", 0)}


def get_result(job_id: str) -> Dict[str, Any] | None:
    job = _jobs.get(job_id)
    if not job:
        return None
    if job.get("result"):
        return job["result"]
    if job.get("status") == "done":
        path = job.get("result_path")
        if path and Path(path).exists():
            with open(path) as fh:
                return json.load(fh)
    elif job.get("status") == "error":
        return {"job_id": job_id, "file_id": job.get("file_id"), "error": job.get("error")}
    return None


def health_info() -> Dict[str, Any]:
    depth = sum(1 for j in _jobs.values() if j["status"] in {"pending", "running"})
    return {"ok": True, "queue_depth": depth, "workers": threading.active_count()}
