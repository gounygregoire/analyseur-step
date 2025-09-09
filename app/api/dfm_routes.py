"""Endpoints Flask pour l'analyse DFM."""

from flask import Blueprint, jsonify, request

from app.storage import files
from app.dfm import services


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api")


@dfm_bp.post("/upload")
def upload() -> tuple[dict, int] | tuple[dict, int]:
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "missing_file"}), 400
    meta = files.save_file(file)
    return jsonify({"file_id": meta.file_id, "kind": "step", "filename": meta.filename}), 200


@dfm_bp.post("/dfm/start")
def start_dfm():
    data = request.get_json(force=True) or {}
    file_id = data.get("file_id")
    material_profile = data.get("material_profile")
    axis = data.get("axis")
    if not file_id:
        return jsonify({"error": "file_id_missing"}), 400
    if not files.get(file_id):
        return jsonify({"error": "file_not_found"}), 400
    if not material_profile:
        return jsonify({"error": "material_profile_missing"}), 400
    job_id = services.launch_job(file_id, material_profile, axis)
    return jsonify({"job_id": job_id}), 202


@dfm_bp.get("/dfm/status")
def status_dfm():
    job_id = request.args.get("job_id")
    info = services.get_status(job_id)
    status_code = 404 if info.get("error") == "job_not_found" else 200
    return jsonify(info), status_code


@dfm_bp.get("/dfm/result")
def result_dfm():
    job_id = request.args.get("job_id")
    res = services.get_result(job_id)
    if not res:
        return jsonify({"error": "result_not_ready"}), 404
    return jsonify(res), 200


@dfm_bp.get("/dfm/health")
def dfm_health():
    return jsonify(services.health_info()), 200
