"""Endpoints d'API DFM minimalistes."""

from __future__ import annotations

from flask import Blueprint, jsonify, request
import os
import json
from celery.result import AsyncResult
from tasks.dfm import dfm_run
from app.material_profiles import get_profile
import logging

logger = logging.getLogger(__name__)


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")

debug_bp = Blueprint("debug", __name__, url_prefix="/api")

# Public endpoints without /api prefix
dfm_public_bp = Blueprint("dfm_public", __name__, url_prefix="/dfm")

# Stockage en mémoire des statuts des jobs (fallback)
_jobs: dict[str, str] = {}


_CELERY_STATES = {
    "PENDING": "queued",
    "STARTED": "running",
    "PROGRESS": "running",
    "SUCCESS": "done",
    "FAILURE": "failed",
}


def _map_state(state: str) -> str:
    return _CELERY_STATES.get(state, state.lower())


@dfm_bp.post("/start")
def start() -> tuple[dict, int]:
    """Valide l'entrée et enfile la tâche Celery d'analyse DFM."""
    data = request.get_json(silent=True) or {}
    file_id = data.get("file_id")
    material_profile_id = data.get("material_profile_id")
    axis = data.get("axis")
    invert = bool(data.get("invert")) if "invert" in data else False
    if not file_id or not material_profile_id or not axis:
        return (
            jsonify({"error": "file_id, material_profile_id et axis requis"}),
            400,
        )
    if not get_profile(material_profile_id):
        return jsonify({"error": "unknown_material_profile"}), 400
    # >>> CADLYTICS PATCH: DFM PRECHECK (BEGIN)
    from app.storage.storage import Storage, os
    from flask import current_app

    step_path = Storage.get_step_path(file_id)
    current_app.logger.info("[DFM/START] file_id=%s resolved_step=%s exists=%s",
                            file_id, step_path, bool(step_path and os.path.isfile(step_path)))
    if not step_path:
        return {"error":"step_not_found_for_file_id",
                "hint":"Persist via ensure_step_persisted → /tmp/uploads/<file_id>.step|.stp"}, 400
    # >>> CADLYTICS PATCH: DFM PRECHECK (END)
    logger.info("/api/dfm/start file_id=%s step_path=%s", file_id, step_path)
    job = dfm_run.delay(
        file_id=file_id,
        material_profile_id=material_profile_id,
        axis=axis,
        invert=invert,
    )
    _jobs[job.id] = "queued"
    return jsonify({"job_id": job.id, "status": "queued"}), 202


@dfm_public_bp.post("/start")
def public_start() -> tuple[dict, int]:
    """Endpoint legacy: lance une analyse DFM."""
    data = request.get_json(silent=True) or {}
    file_id = data.get("file_id")
    material = data.get("material") or data.get("material_profile_id")
    axis = data.get("axis")
    invert = bool(data.get("invert")) if "invert" in data else False
    tolerance = data.get("tolerance")
    if not file_id or not material or not axis:
        return jsonify({"error": "file_id, material et axis requis"}), 400
    if not get_profile(material):
        return jsonify({"error": "unknown_material"}), 400
    from app.storage.storage import Storage

    step_path = Storage.get_step_path(file_id)
    if not step_path or not os.path.isfile(step_path):
        return jsonify({"error": "step_not_found"}), 404
    job = dfm_run.delay(
        file_id=file_id,
        material_profile_id=material,
        axis=axis,
        invert=invert,
        tolerance=tolerance,
    )
    return jsonify({"job_id": job.id, "status": "queued"}), 202


@dfm_bp.get("/status")
def status() -> tuple[dict, int]:
    """Renvoie l'état du job DFM."""
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id requis"}), 400
    res = AsyncResult(job_id)
    if res.state != "PENDING" or job_id in _jobs:
        status = _map_state(res.state)
        if res.state == "FAILURE":
            error = str(res.info)
            return jsonify({"job_id": job_id, "status": status, "error": error}), 200
        meta = res.info if isinstance(res.info, dict) else None
        return jsonify({"job_id": job_id, "status": status, "result": meta}), 200
    state = _jobs.get(job_id)
    if state is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify({"job_id": job_id, "status": state, "result": None}), 200


@dfm_bp.get("/result")
def result() -> tuple[dict, int]:
    """Renvoie le résultat du job DFM."""
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id requis"}), 400
    res = AsyncResult(job_id)
    if res.state != "PENDING" or job_id in _jobs:
        status = _map_state(res.state)
        if res.state == "FAILURE":
            error = str(res.info)
            return (
                jsonify({"job_id": job_id, "status": status, "summary": {}, "issues": [], "error": error}),
                200,
            )
        if res.state == "SUCCESS" and isinstance(res.result, dict):
            summary = res.result.get("summary", {})
            issues = res.result.get("issues", [])
        else:
            summary, issues = {}, []
        return (
            jsonify({"job_id": job_id, "status": status, "summary": summary, "issues": issues}),
            200,
        )
    state = _jobs.get(job_id)
    if state is None:
        return jsonify({"error": "job not found"}), 404
    return (
        jsonify({"job_id": job_id, "status": state, "summary": {}, "issues": []}),
        200,
    )


@dfm_public_bp.get("/report/<file_id>")
def public_report(file_id: str):
    """Retourne le report.json pour un file_id donné."""
    path = os.path.join("static", "dfm", file_id, "report.json")
    if not os.path.isfile(path):
        return jsonify({"error": "not_found"}), 404
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return jsonify(data), 200


@debug_bp.get("/debug/file/<file_id>")
def debug_file(file_id: str):
    from app.storage.storage import Storage, os
    step = Storage.get_step_path(file_id)
    xkt = Storage.get_xkt_path(file_id)
    return {
        "file_id": file_id,
        "step_path": step,
        "exists_step": bool(step and os.path.isfile(step)),
        "xkt_path": xkt,
        "exists_xkt": bool(xkt and os.path.isfile(xkt)),
    }


