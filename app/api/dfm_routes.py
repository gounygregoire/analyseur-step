"""Endpoints d'API DFM minimalistes."""

from flask import Blueprint, jsonify, request


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")


@dfm_bp.post("/start")
def start() -> tuple[dict, int]:
    """Valide l'entrée et file l'analyse DFM (stub)."""
    data = request.get_json(silent=True) or {}
    file_id = data.get("file_id")
    material_profile_id = data.get("material_profile_id")
    axis = data.get("axis")
    invert = bool(data.get("invert")) if "invert" in data else False
    if not file_id or not material_profile_id:
        return jsonify({"error": "file_id and material_profile_id requis"}), 400
    job_id = "stub"
    return jsonify({"job_id": job_id, "status": "queued"}), 202


@dfm_bp.get("/status/<job_id>")
def status(job_id: str) -> tuple[dict, int]:
    """Renvoie l'état du job DFM (stub)."""
    return jsonify({"job_id": job_id, "status": "queued", "result": None}), 200

