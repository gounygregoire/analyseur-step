import os
import uuid
import shutil
import time
from flask import Flask, request, send_from_directory, url_for, render_template
from redis import Redis
from rq import Queue, Job
from werkzeug.utils import secure_filename
from flask_compress import Compress
from .jobs import generate_low_preview, generate_full_model

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

redis_conn = Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
queue = Queue("dfm", connection=redis_conn)

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
    step_name = secure_filename(f"{job_id}.step")
    step_path = os.path.join(app.config["UPLOAD_FOLDER"], step_name)
    with open(step_path, "wb") as dst:
        shutil.copyfileobj(file.stream, dst, length=1024 * 1024)

    low_job = queue.enqueue(
        generate_low_preview,
        step_path,
        job_id=job_id,
        job_timeout=300,
    )
    full_job = queue.enqueue(
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
        low_job = Job.fetch(job_id, connection=redis_conn)
    except Exception:
        return {"error": "Job not found"}, 404

    full_job = None
    if "full_job_id" in low_job.meta:
        try:
            full_job = Job.fetch(low_job.meta["full_job_id"], connection=redis_conn)
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
        message = _exc_message(low_job.exc_info)
    elif full_job and full_job.is_failed:
        message = _exc_message(full_job.exc_info)

    return {"status": status, "low_url": low_url, "full_url": full_url, "message": message}

@app.route("/jobs/<job_id>/result")
def job_result(job_id: str):
    try:
        low_job = Job.fetch(job_id, connection=redis_conn)
    except Exception:
        return {"error": "Job not found"}, 404

    full_job = None
    if "full_job_id" in low_job.meta:
        try:
            full_job = Job.fetch(low_job.meta["full_job_id"], connection=redis_conn)
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

if __name__ == "__main__":
    app.run()
