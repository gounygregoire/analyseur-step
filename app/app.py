import os
import uuid
import shutil
import time
import logging
from flask import Flask, request, send_from_directory, url_for, render_template
from rq.job import Job
from werkzeug.utils import secure_filename
from flask_compress import Compress
from .jobs import generate_low_preview, generate_full_model
from .queue import q, conn
from .tasks import heavy_compute
from server.dfm_api_blueprint_stub import dfm_bp
from app.storage.storage import Storage

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.getenv("UPLOAD_FOLDER", "/tmp/uploads")
app.config["OUTPUT_FOLDER"] = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_UPLOAD_MB", "300")) * 1024 * 1024
app.config["COMPRESS_MIMETYPES"] = [
    "text/html",
    "application/json",
    "text/css",
    "application/javascript",
    "model/xkt",
    "model/gltf-binary",
]

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUT_FOLDER"], exist_ok=True)

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

@app.route("/upload", methods=["POST"])
def upload():
    file = request.files.get("file")
    if not file:
        return {"error": "No file provided"}, 400

    job_id = uuid.uuid4().hex
    original_filename = secure_filename(file.filename or "")
    step_name = secure_filename(f"{job_id}.step")
    step_path = os.path.join(app.config["UPLOAD_FOLDER"], step_name)
    with open(step_path, "wb") as dst:
        shutil.copyfileobj(file.stream, dst, length=1024 * 1024)

    abs_step_path = os.path.abspath(step_path)
    Storage.save_step_record(
        file_id=job_id,
        filename=original_filename,
        path=abs_step_path,
        size=os.path.getsize(abs_step_path),
    )

    low_job = q.enqueue(
        generate_low_preview,
        step_path,
        job_id=job_id,
        job_timeout=300,
    )
    full_job = q.enqueue(
        generate_full_model,
        step_path,
        depends_on=low_job,
        job_timeout=1800,
    )
    low_job.meta["full_job_id"] = full_job.id
    low_job.save_meta()

    return {"job_id": low_job.id}, 202

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

@app.route("/models/<path:filename>")
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
