"""Blueprint DFM stub pour préparation du backend."""

from flask import Blueprint, jsonify, request


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")


@dfm_bp.post("/start")
def start() -> tuple[dict, int]:
    """Valide l'entrée et file l'analyse DFM."""
    data = request.get_json(force=True) or {}
    file_id = data.get("file_id")
    material_profile_id = data.get("material_profile_id")

    if not file_id or not material_profile_id:
        return jsonify({"error": "file_id and material_profile_id requis"}), 400

    job_id = "stub"
    return jsonify({"job_id": job_id, "status": "queued"}), 202


@dfm_bp.get("/status/<job_id>")
def status(job_id: str) -> tuple[dict, int]:
    """Renvoie l'état du job DFM."""
    return jsonify({"job_id": job_id, "status": "queued"}), 200

