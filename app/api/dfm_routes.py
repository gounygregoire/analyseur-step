"""Endpoints d'API DFM minimalistes."""

from __future__ import annotations

import threading
import time
import uuid
from flask import Blueprint, jsonify, request


dfm_bp = Blueprint("dfm", __name__, url_prefix="/api/dfm")

# Stockage en mémoire des statuts des jobs (stub)
_jobs: dict[str, str] = {}


def _fake_worker(job_id: str) -> None:
    """Simule une tâche asynchrone DFM."""
    _jobs[job_id] = "running"
    time.sleep(1)
    _jobs[job_id] = "done"


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
    job_id = uuid.uuid4().hex
    _jobs[job_id] = "queued"
    threading.Thread(target=_fake_worker, args=(job_id,), daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"}), 202


@dfm_bp.get("/status")
def status() -> tuple[dict, int]:
    """Renvoie l'état du job DFM (stub)."""
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id requis"}), 400
    state = _jobs.get(job_id)
    if state is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify({"job_id": job_id, "status": state, "result": None}), 200


@dfm_bp.get("/result")
def result() -> tuple[dict, int]:
    """Renvoie un résultat DFM minimal (stub)."""
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id requis"}), 400
    state = _jobs.get(job_id)
    if state is None:
        return jsonify({"error": "job not found"}), 404
    return (
        jsonify({"job_id": job_id, "status": state, "summary": {}, "issues": []}),
        200,
    )

