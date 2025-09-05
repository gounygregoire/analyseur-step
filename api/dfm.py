# api/dfm.py
from flask import Blueprint, request, jsonify
from celery_app import celery
from tasks.dfm import dfm_run  # <-- important: force l’import pour enregistrer la tâche

bp = Blueprint("dfm_api", __name__, url_prefix="/api/dfm")

@bp.post("/start")
def dfm_start():
    data = request.get_json(silent=True) or {}
    file_id = data.get("file_id")
    if not file_id:
        return jsonify({"error": "file_id is required"}), 400

    material_profile = data.get("material_profile") or {
        "mechanical": [], "aesthetic": [], "regulatory": [], "resin": "generic", "notes": ""
    }
    demould_axis = data.get("demould_axis") or {"axis": "Y", "direction": 1}

    # queue = os.getenv("CELERY_DEFAULT_QUEUE", "dfm")  # si vous voulez rendre la queue configurable
    job = dfm_run.apply_async(args=[file_id, material_profile, demould_axis], queue="dfm")
    return jsonify({"jobId": job.id}), 200


@bp.get("/status")
def dfm_status():
    job_id = request.args.get("jobId")
    if not job_id:
        return jsonify({"error": "jobId is required"}), 400

    async_res = celery.AsyncResult(job_id)
    # Celery renvoie .info quand state == PROGRESS (dict meta) ou une exception si échec
    meta = async_res.info if isinstance(async_res.info, dict) else {}
    return jsonify({"state": async_res.state, "meta": meta}), 200


@bp.get("/results")
def dfm_results():
    job_id = request.args.get("jobId")
    if not job_id:
        return jsonify({"error": "jobId is required"}), 400

    async_res = celery.AsyncResult(job_id)
    if async_res.successful():
        return jsonify(async_res.result), 200
    if async_res.failed():
        return jsonify({"state": async_res.state, "error": str(async_res.info)}), 500
    # pas prêt -> 404 attendu par votre front
    return ("", 404)
