# api/dfm.py
from flask import Blueprint, request, jsonify
from tasks.dfm import dfm_run   # importe la tâche Celery (pas l'app Flask)

dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")

@dfm_bp.post("/start")
def start_dfm():
    payload = request.get_json(force=True) or {}
    file_id = payload.get("file_id")
    material = payload.get("material_profile", {"resin": "generic"})
    axis = payload.get("demould_axis", {"axis": "Y", "direction": 1})

    job = dfm_run.apply_async(args=[file_id, material, axis], queue="dfm")
    return jsonify({"jobId": job.id}), 200

@dfm_bp.get("/status")
def status_dfm():
    from celery.result import AsyncResult
    job_id = request.args.get("jobId")
    r = AsyncResult(job_id)
    return jsonify({"state": r.state, "meta": r.info if isinstance(r.info, dict) else None}), 200

@dfm_bp.get("/results")
def results_dfm():
    from celery.result import AsyncResult
    job_id = request.args.get("jobId")
    r = AsyncResult(job_id)
    if r.successful():
        return jsonify(r.result), 200
    return jsonify({"error": "not_ready"}), 404
