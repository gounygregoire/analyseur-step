# --- APP WEB: upload & conversion XKT ---
import os
import threading
import uuid
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS
from redis import Redis
from rq import Queue

from app.file_records import (
    FileRecord,
    create_or_update as create_file_record,
    get as get_file_record,
    mark_failed as mark_file_failed,
    mark_processing as mark_file_processing,
    mark_ready as mark_file_ready,
)
from app.storage.storage import Storage
from app.xkt_pipeline import (
    build_xkt_url,
    convert_and_publish_xkt,
    is_local_storage,
    local_xkt_path,
    should_serve_xkt_via_flask,
)

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

REDIS_URL = os.environ.get("REDIS_URL")
redis_conn = Redis.from_url(REDIS_URL) if REDIS_URL else None
q = Queue(connection=redis_conn) if redis_conn else None

ALLOWED = {".stp", ".step", ".stl"}

_conversion_threads: dict[str, threading.Thread] = {}
_conversion_lock = threading.Lock()


def allowed(name: str) -> bool:
    return os.path.splitext(name.lower())[1] in ALLOWED


def _conversion_worker(file_id: str, step_path: str) -> None:
    try:
        Path(step_path).parent.mkdir(parents=True, exist_ok=True)
        Path(OUTPUT_FOLDER).mkdir(parents=True, exist_ok=True)
        result = convert_and_publish_xkt(file_id, step_path)
        mark_file_ready(file_id, xkt_path=result.local_path, xkt_url=result.xkt_url)
    except Exception as exc:  # pragma: no cover - log + statut
        mark_file_failed(file_id, str(exc))
    finally:
        with _conversion_lock:
            _conversion_threads.pop(file_id, None)


def _start_conversion(file_id: str, step_path: str) -> None:
    with _conversion_lock:
        if file_id in _conversion_threads:
            return
        thread = threading.Thread(
            target=_conversion_worker,
            args=(file_id, step_path),
            daemon=True,
            name=f"xkt-convert-{file_id}",
        )
        _conversion_threads[file_id] = thread
        thread.start()


def _create_record(file_id: str, filename: str, step_path: str) -> FileRecord:
    record = create_file_record(
        file_id=file_id,
        original_name=filename,
        step_path=step_path,
        status="processing",
    )
    Storage.save_step_record(file_id, filename, step_path, os.path.getsize(step_path))
    return record


def _process_upload_request() -> tuple[dict, int]:
    incoming = request.files.get("file")
    if not incoming or not incoming.filename:
        return {"error": "no_file"}, 400

    if not allowed(incoming.filename):
        return {"error": "bad_ext", "detail": "Extensions supportées: .step, .stp, .stl"}, 400

    file_id = uuid.uuid4().hex
    ext = os.path.splitext(incoming.filename)[1].lower() or ".step"
    step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")

    try:
        incoming.save(step_path)
    except Exception as exc:
        if os.path.exists(step_path):
            os.remove(step_path)
        return {"error": "save_failed", "detail": str(exc)}, 500

    record = _create_record(file_id, incoming.filename, step_path)
    _start_conversion(file_id, step_path)

    payload = record.to_payload()
    payload["file_id"] = file_id
    return payload, 202


@app.post("/api/upload")
def api_upload():
    payload, status = _process_upload_request()
    return jsonify(payload), status


@app.post("/upload")
def legacy_upload():
    payload, status = _process_upload_request()
    return jsonify(payload), status


@app.get("/api/files/<file_id>/status")
def file_status(file_id: str):
    record = get_file_record(file_id)
    if not record:
        return jsonify({"error": "file_not_found"}), 404

    payload = record.to_payload()
    if record.status == "ready" and not payload.get("xkt_url"):
        payload["xkt_url"] = build_xkt_url(file_id)
    payload["file_id"] = file_id
    return jsonify(payload), 200


@app.post("/api/files/<file_id>/reconvert")
def file_reconvert(file_id: str):
    record = get_file_record(file_id)
    if not record:
        return jsonify({"error": "file_not_found"}), 404

    step_path = record.step_path or Storage.get_step_path(file_id)
    if not step_path or not os.path.isfile(step_path):
        return jsonify({"error": "step_missing"}), 404

    updated = mark_file_processing(file_id)
    if updated is None:
        updated = create_file_record(
            file_id=file_id,
            original_name=record.original_name,
            step_path=step_path,
            status="processing",
        )

    if is_local_storage():
        local_path = local_xkt_path(file_id)
        if local_path.exists():
            try:
                local_path.unlink()
            except OSError:
                pass

    _start_conversion(file_id, step_path)

    payload = updated.to_payload()
    payload["file_id"] = file_id
    return jsonify(payload), 202


if should_serve_xkt_via_flask():

    @app.get("/xkt/<file_id>.xkt")
    def serve_xkt(file_id: str):
        path = local_xkt_path(file_id)
        if not path.exists():
            abort(404)
        resp = send_from_directory(
            str(path.parent),
            path.name,
            mimetype="application/octet-stream",
        )
        resp.headers["Cache-Control"] = "public, max-age=31536000"
        return resp

# ---------- DFM (enqueue au worker RQ) ----------
@app.post("/dfm/start")
def dfm_start():
    if not q:
        return jsonify(error="queue_unavailable"), 503
    payload = request.get_json(silent=True) or {}
    file_id = payload.get("file_id")
    if not file_id:
        return jsonify(error="no_file_id"), 400
    step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}.step")
    xkt_path = str(local_xkt_path(file_id))
    job = q.enqueue("tasks.run_dfm", step_path, xkt_path, job_timeout=60*30)
    return jsonify(job_id=job.get_id(), status="queued")

@app.get("/dfm/status")
def dfm_status():
    if not q:
        return jsonify(error="queue_unavailable"), 503
    from rq.job import Job
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify(error="no_job_id"), 400
    try:
        job = Job.fetch(job_id, connection=redis_conn)
    except Exception:
        return jsonify(status="unknown")
    resp = {"status": job.get_status()}
    if job.is_finished:
        resp["result"] = job.result
    elif job.is_failed:
        resp["error"] = str(job.exc_info or "failed")
    return jsonify(resp)

import logging
import time
from flask import url_for, render_template
from flask_compress import Compress
from rq.job import Job

from .tasks import heavy_compute
from server.dfm_api_blueprint_stub import dfm_bp

try:
    from .queue import q as legacy_q, conn as legacy_conn
except Exception:  # pragma: no cover - legacy queue optional
    legacy_q = None
    legacy_conn = None

if redis_conn is None and legacy_conn is not None:
    redis_conn = legacy_conn
if q is None:
    if legacy_q is not None:
        q = legacy_q
    elif redis_conn is not None:
        q = Queue(connection=redis_conn)
conn = redis_conn

# >>> CADLYTICS PATCH: BOOT LOG (BEGIN)
log = logging.getLogger("boot")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)
os.environ.setdefault(
    "FILES_DB_PATH",
    os.path.join(os.path.dirname(__file__), "storage/files.sqlite"),
)
log.info(
    "[BOOT] UPLOAD_FOLDER=%s OUTPUT_FOLDER=%s FILES_DB_PATH=%s cwd=%s",
    UPLOAD_FOLDER,
    OUTPUT_FOLDER,
    os.environ.get("FILES_DB_PATH"),
    os.getcwd(),
)
# >>> CADLYTICS PATCH: BOOT LOG (END)

app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["OUTPUT_FOLDER"] = OUTPUT_FOLDER
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_UPLOAD_MB", "300")) * 1024 * 1024
app.config["COMPRESS_MIMETYPES"] = [
    "text/html",
    "application/json",
    "text/css",
    "application/javascript",
    "model/xkt",
    "model/gltf-binary",
]

compress = Compress()
compress.init_app(app)

app.register_blueprint(dfm_bp)


def cleanup_output_folder(max_age_hours: int = 72) -> None:
    now = time.time()
    cutoff = now - max_age_hours * 3600
    folder = app.config["OUTPUT_FOLDER"]
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
            try:
                os.remove(path)
            except OSError:
                pass


cleanup_output_folder()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


if os.getenv("ENABLE_RQ_TEST_ROUTES") == "1" or os.getenv("FLASK_ENV") != "production":
    @app.route("/enqueue-test")
    def enqueue_test():
        x = request.args.get("x", default=0, type=int)
        fail = request.args.get("fail", default=0, type=int)
        job = q.enqueue(heavy_compute, x, bool(fail))
        return {"job_id": job.id}

    @app.route("/job-status/<job_id>")
    def job_status_simple(job_id: str):
        try:
            job = Job.fetch(job_id, connection=conn)
        except Exception:
            return {"error": "Job not found"}, 404
        result = job.result if job.is_finished else None
        return {"id": job.id, "status": job.get_status(), "result": result}


def _exc_message(exc):
    if not exc:
        return None
    return exc.strip().splitlines()[-1]


@app.route("/jobs/<job_id>/status")
def job_status(job_id: str):
    try:
        low_job = Job.fetch(job_id, connection=conn)
    except Exception:
        return {"error": "Job not found"}, 404

    full_job = None
    if "full_job_id" in low_job.meta:
        try:
            full_job = Job.fetch(low_job.meta["full_job_id"], connection=conn)
        except Exception:
            full_job = None

    status = low_job.get_status()
    if full_job and full_job.get_status() == "failed" and low_job.get_status() == "finished":
        status = "finished_partial"
    elif full_job and full_job.get_status() == "finished":
        status = "finished"
    elif full_job and full_job.get_status() not in ("finished", "failed"):
        status = full_job.get_status()
    elif low_job.get_status() == "failed":
        status = "failed"

    low_url = (
        url_for("models", filename=os.path.basename(low_job.result), _external=True)
        if low_job.is_finished
        else None
    )
    full_url = (
        url_for("models", filename=os.path.basename(full_job.result), _external=True)
        if full_job and full_job.is_finished
        else None
    )

    message = None
    if low_job.is_failed:
        logger.error("Job %s failed: %s", low_job.id, low_job.exc_info)
        message = _exc_message(low_job.exc_info)
    elif full_job and full_job.is_failed:
        logger.error("Job %s failed: %s", full_job.id, full_job.exc_info)
        message = _exc_message(full_job.exc_info)

    return {"status": status, "low_url": low_url, "full_url": full_url, "message": message}


@app.route("/jobs/<job_id>/result")
def job_result(job_id: str):
    try:
        low_job = Job.fetch(job_id, connection=conn)
    except Exception:
        return {"error": "Job not found"}, 404

    full_job = None
    if "full_job_id" in low_job.meta:
        try:
            full_job = Job.fetch(low_job.meta["full_job_id"], connection=conn)
        except Exception:
            full_job = None

    result = {}
    if low_job.is_finished:
        result["low_url"] = url_for("models", filename=os.path.basename(low_job.result), _external=True)
    if full_job and full_job.is_finished:
        result["full_url"] = url_for("models", filename=os.path.basename(full_job.result), _external=True)
    if not result:
        return {"error": "Result not ready"}, 404
    return result


@app.route("/models/<path:filename>", methods=["GET", "HEAD"])
def models(filename):
    mimetype = None
    if filename.endswith(".xkt"):
        mimetype = "model/xkt"
    elif filename.endswith(".glb"):
        mimetype = "model/gltf-binary"
    return send_from_directory(app.config["OUTPUT_FOLDER"], filename, mimetype=mimetype)


@app.route("/")
def index():
    return render_template(
        "index.html",
        max_upload_mb=app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024),
    )


def log_routes() -> None:
    lines = []
    for rule in app.url_map.iter_rules():
        methods = ",".join(sorted(rule.methods - {"HEAD", "OPTIONS"}))
        lines.append(f"{methods} {rule.rule}")
    logger.info("Routes:\n%s", "\n".join(sorted(lines)))


log_routes()

if __name__ == "__main__":
    app.run()
