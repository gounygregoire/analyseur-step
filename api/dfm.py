# api/dfm.py
from flask import Blueprint, request, jsonify
from tasks.dfm import dfm_run
from celery.result import AsyncResult

dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")

@dfm_bp.post("/start")
def start_dfm():
    payload = request.get_json(force=True) or {}

    # Accepter camelCase et snake_case
    file_id = payload.get("file_id") or payload.get("fileId")
    material = payload.get("material_profile") or payload.get("materialProfile") or {"resin": "generic"}
    axis = payload.get("demould_axis") or payload.get("demouldAxis") or {"axis": "Y", "direction": 1}

    if not file_id:
        return jsonify({"error": "file_missing"}), 400

    job = dfm_run.apply_async(args=[file_id, material, axis], queue="dfm")
    return jsonify({"jobId": job.id}), 202


@dfm_bp.get("/status")
def status_dfm():
    from celery.result import AsyncResult

    job_id = request.args.get("jobId")
    if not job_id:
        return jsonify({"status": "error", "error": "missing_jobId"}), 400

    r = AsyncResult(job_id)

    # Map Celery -> front-end
    celery_state = r.state or "PENDING"
    meta = r.info if isinstance(r.info, dict) else {}

    if celery_state in ("PENDING", "RECEIVED"):
        payload = {"status": "queued"}
        return jsonify(payload), 200

    if celery_state in ("STARTED", "PROGRESS"):
        # PROGRESS meta may carry step/progress from update_state(...)
        payload = {
            "status": "running",
            "step": meta.get("step"),
            "progress": meta.get("progress"),
        }
        return jsonify(payload), 200

    if celery_state == "SUCCESS":
        return jsonify({"status": "done"}), 200

    # FAILURE, REVOKED, RETRY, etc.
    return jsonify({"status": "error", "error": str(meta) or celery_state}), 200


@dfm_bp.get("/results")
def results_dfm():
    job_id = request.get_args().get("jobId") if hasattr(request, "get_args") else request.args.get("jobId")
    r = AsyncResult(job_id)
    if r.successful():
        return jsonify(r.result), 200
    return jsonify({"error": "not_ready"}), 404

# Désactive le cache sur toutes les routes /api/dfm/* pour éviter les 200 “stales”
@dfm_bp.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp
