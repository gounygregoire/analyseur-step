"""Endpoints d'API DFM minimalistes."""

from flask import Blueprint, jsonify, request


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")


@dfm_bp.post("/start")
def start() -> tuple[dict, int]:
    """Lance une analyse DFM (stub)."""
    data = request.get_json(force=True) or {}
    file_id = data.get("file_id")
    material_profile_id = data.get("material_profile_id")
    axis = data.get("axis")
    invert = data.get("invert")
    job_id = "stub"
    return jsonify({"job_id": job_id, "status": "queued"}), 202

