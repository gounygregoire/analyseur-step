from __future__ import annotations

import logging
from flask import Blueprint, request, jsonify

from jobs.dfm_runner import start_job, get_job

logger = logging.getLogger(__name__)


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")


@dfm_bp.post("/start")
def start_dfm():
    data = request.get_json(force=True) or {}
    file_id = data.get("file_id")
    demold_axis = data.get("demold_axis") or [0, 0, 1]
    material_profile = data.get("material_profile") or {}
    if not file_id:
        return jsonify({"error": "file_id_missing"}), 400
    try:
        job_id = start_job(file_id, demold_axis, material_profile)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("failed to queue dfm job")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"job_id": job_id, "status": "queued"}), 202


@dfm_bp.get("/status")
def status_dfm():
    job_id = request.args.get("job_id")
    job = get_job(job_id) if job_id else None
    if not job:
        return jsonify({"error": "not_found"}), 404
    payload = {"status": job["status"], "progress": job.get("progress", 0)}
    if job["status"] == "done":
        payload["result"] = job["result"]
    if job["status"] == "error":
        payload["error_code"] = job.get("error_code")
        payload["message"] = job.get("message")
    return jsonify(payload), 200


@dfm_bp.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp
