"""Routes principales Cadlytics (web + conversion)."""

# app.py
import logging
import os
import shutil
import uuid
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from flask import (
    Blueprint,
    Flask,
    Response,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from werkzeug.exceptions import HTTPException

from translations import get_all_translations
from auth import auth_bp
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

# ====== Base paths / i18n ======
BASE_DIR = Path(__file__).resolve().parent
LANDING_FILE = BASE_DIR / "templates" / "landing.html"
LANDING_DIR = LANDING_FILE.parent
SUPPORTED_LANGUAGES = {"fr", "en"}
LANG_COOKIE_NAME = "cadlytics_lang"

class _TranslationsProxy(dict):
    """Expose un dict de traductions avec accès par attribut."""
    def __getattr__(self, key: str) -> str:
        return self.get(key, key)

def _resolve_language() -> str:
    """Détermine la langue courante à partir du cookie ou des préférences."""
    lang = (request.cookies.get(LANG_COOKIE_NAME) or "").lower()
    if lang in SUPPORTED_LANGUAGES:
        return lang
    match = request.accept_languages.best_match(sorted(SUPPORTED_LANGUAGES))
    if match:
        return match
    return "fr"

print("[env] XEOKIT_ARGS =", os.getenv("XEOKIT_ARGS"))

# ====== Flask app / blueprints ======
app = Flask(__name__, static_folder="static", template_folder="templates")
root_bp = Blueprint("root", __name__)

# ====== Config minimale ======
MAX_UPLOAD_MB = int(float(os.environ.get("MAX_UPLOAD_MB", "50")))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# ====== Jobs en mémoire (reconvert) ======
JOBS = {}  # job_id -> {"status": "pending|running|finished|error", ...}

def _step_path(file_id: str) -> str:
    return os.path.join(UPLOAD_FOLDER, f"{file_id}.step")

def _glb_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.glb")

# ===== Helpers upload/convert =====
ALLOWED = {".stp", ".step", ".stl"}
def _allowed(name: str) -> bool:
    return Path(name.lower()).suffix in ALLOWED


_conversion_threads: dict[str, threading.Thread] = {}
_conversion_lock = threading.Lock()


def _create_record(file_id: str, filename: str, step_path: str) -> FileRecord:
    record = create_file_record(
        file_id=file_id,
        original_name=filename,
        step_path=step_path,
        status="processing",
    )
    try:
        Storage.save_step_record(file_id, filename, step_path, os.path.getsize(step_path))
    except Exception:
        logger = logging.getLogger("cadlytics.files")
        logger.warning("[files] unable to persist STEP metadata", exc_info=True)
    return record


def _conversion_worker(file_id: str, step_path: str) -> None:
    try:
        result = convert_and_publish_xkt(file_id, step_path)
        mark_file_ready(file_id, xkt_path=result.local_path, xkt_url=result.xkt_url)
    except Exception as exc:
        mark_file_failed(file_id, str(exc))
    finally:
        with _conversion_lock:
            _conversion_threads.pop(file_id, None)


def _schedule_conversion(file_id: str, step_path: str) -> None:
    with _conversion_lock:
        if file_id in _conversion_threads:
            return
        thread = threading.Thread(
            target=_conversion_worker,
            args=(file_id, step_path),
            daemon=True,
            name=f"convert-{file_id}",
        )
        _conversion_threads[file_id] = thread
        thread.start()

# ====== Landing (marketing) ======
@root_bp.route("/", methods=["GET", "HEAD"])
def landing_index():
    if not LANDING_FILE.is_file():
        abort(404)
    current_language = _resolve_language()
    translations = _TranslationsProxy(get_all_translations(current_language))
    html = render_template(
        LANDING_FILE.name,
        t=translations,
        current_language=current_language,
    )
    response = Response(html, mimetype="text/html")
    if request.method == "HEAD":
        response.set_data(b"")
    return response

def _landing_asset(prefix: str, asset_path: str):
    full_path = LANDING_DIR / prefix / asset_path
    if not full_path.is_file():
        abort(404)
    response = send_from_directory(str(LANDING_DIR), f"{prefix}/{asset_path}")
    if request.method == "HEAD":
        response.set_data(b"")
    return response

for _prefix in ("assets", "css", "js", "img", "images", "fonts", "media"):
    root_bp.add_url_rule(
        f"/{_prefix}/<path:asset_path>",
        endpoint=f"landing_asset_{_prefix}",
        view_func=lambda asset_path, _p=_prefix: _landing_asset(_p, asset_path),
        methods=["GET", "HEAD"],
    )

@root_bp.get("/change-language/<lang>")
def change_language(lang: str):
    lang = (lang or "").lower()
    if lang not in SUPPORTED_LANGUAGES:
        abort(404)
    fallback = url_for("root.landing_index")
    target = request.referrer or fallback
    parsed = urlparse(target)
    if parsed.scheme and parsed.netloc and parsed.netloc != request.host:
        target = fallback
    response = redirect(target)
    response.set_cookie(
        LANG_COOKIE_NAME,
        lang,
        max_age=60 * 60 * 24 * 365,
        secure=request.is_secure,
        samesite="Lax",
    )
    return response

@root_bp.get("/favicon.ico")
def favicon():
    favicon_path = LANDING_DIR / "favicon.ico"
    if not favicon_path.is_file():
        abort(404)
    return send_from_directory(str(LANDING_DIR), "favicon.ico")

app.register_blueprint(root_bp)
app.register_blueprint(auth_bp)
app.add_url_rule("/", endpoint="site.index", view_func=landing_index, methods=["GET", "HEAD"])

# ====== App (viewer) ======
@app.route("/app", methods=["GET"], endpoint="site.app_page")
def site_app_page():
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)

# ====== Public outputs (héritage) ======
@app.route("/outputs/<path:fname>", methods=["GET"], endpoint="site.public_outputs")
def site_public_outputs(fname: str):
    base_dir = OUTPUT_FOLDER
    path = os.path.join(base_dir, fname)
    if not os.path.isfile(path):
        abort(404)
    return send_from_directory(base_dir, fname)

# ====== Serve XKT / GLB comme attendus par le front ======
if should_serve_xkt_via_flask():

    @app.route("/xkt/<file_id>.xkt", methods=["GET"])
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
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp

@app.route("/glb/<file_id>.glb", methods=["GET", "HEAD"])
def serve_glb(file_id: str):
    fname = f"{file_id}.glb"
    path = _glb_path(file_id)
    if not os.path.isfile(path):
        abort(404)
    resp = send_from_directory(OUTPUT_FOLDER, fname, mimetype="model/gltf-binary")
    resp.headers["Cache-Control"] = "no-cache, max-age=0"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    if request.method == "HEAD":
        resp.set_data(b"")
    return resp

# ====== Télémétrie existence pour waitForXKT ======
@app.get("/exists/xkt/<file_id>")
def exists_xkt(file_id: str):
    if is_local_storage():
        path = local_xkt_path(file_id)
        exists = path.exists()
        size = path.stat().st_size if exists else 0
    else:
        record = get_file_record(file_id)
        exists = bool(record and record.status == "ready")
        size = 0
    status = "ready" if exists else "pending"
    return jsonify({"exists": bool(exists), "file_id": file_id, "size": int(size), "status": status})

# ====== Reconvert async léger (thread) ======
def _reconvert_job(file_id: str, job_id: str):
    JOBS[job_id] = {"status": "running", "file_id": file_id, "started_at": time.time()}
    mark_file_processing(file_id)
    try:
        step = Storage.get_step_path(file_id) or _step_path(file_id)
        if not step or not os.path.isfile(step):
            raise FileNotFoundError(f"STEP introuvable pour {file_id}")
        _conversion_worker(file_id, step)
        size = 0
        if is_local_storage():
            local_path = local_xkt_path(file_id)
            if local_path.exists():
                size = local_path.stat().st_size
        JOBS[job_id] = {
            "status": "finished",
            "file_id": file_id,
            "xkt_size": size,
        }
    except Exception as e:
        mark_file_failed(file_id, str(e))
        JOBS[job_id] = {"status": "error", "file_id": file_id, "error": str(e)}

@app.post("/api/reconvert")
def api_reconvert():
    data = request.get_json(silent=True) or {}
    file_id = (data.get("file_id") or data.get("id") or "").strip()
    if not file_id:
        return jsonify(error="missing_file_id"), 400

    # court-circuit si déjà prêt
    record = get_file_record(file_id)
    if record and record.status == "ready":
        return jsonify(job_id="noop", status="finished")

    job_id = str(uuid.uuid4())
    th = threading.Thread(
        target=_reconvert_job,
        args=(file_id, job_id),
        daemon=True,
    )
    th.start()
    JOBS[job_id] = {"status": "pending", "file_id": file_id}
    return jsonify(job_id=job_id, status="pending")

@app.get("/api/reconvert/status/<job_id>")
def api_reconvert_status(job_id: str):
    info = JOBS.get(job_id)
    if not info:
        return jsonify(status="unknown", job_id=job_id), 404
    return jsonify(info | {"job_id": job_id})

# ====== Healthcheck basique ======
@app.get("/healthz")
def healthz():
    return Response("ok", 200, content_type="text/plain")

# ====== Error handler ======
logger = logging.getLogger("cadlytics")

@app.errorhandler(Exception)
def handle_exception(exc):
    if isinstance(exc, HTTPException):
        if exc.code >= 500:
            logger.exception("HTTP %s on %s", exc.code, request.path)
        return exc
    logger.exception("Unhandled exception on %s", request.path)
    return jsonify(error="internal_error"), 500

# ====== Upload / statut fichiers (STEP -> XKT async) ======
def _handle_upload_request() -> tuple[dict, int]:
    try:
        incoming = request.files.get("file")
        if not incoming or not incoming.filename:
            return {"error": "no_file"}, 400
        if not _allowed(incoming.filename):
            return {
                "error": "bad_ext",
                "detail": "Extensions supportées: .step, .stp, .stl",
            }, 400

        file_id = uuid.uuid4().hex
        ext = Path(incoming.filename).suffix.lower() or ".step"
        step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")

        try:
            incoming.save(step_path)
        except Exception as exc:
            if os.path.exists(step_path):
                os.remove(step_path)
            return {"error": "save_failed", "detail": str(exc)}, 500

        record = _create_record(file_id, incoming.filename, step_path)
        mark_file_processing(file_id)
        _schedule_conversion(file_id, step_path)

        payload = record.to_payload()
        payload["file_id"] = file_id
        return payload, 202
    except Exception as exc:  # pragma: no cover - garde-fou
        return {"error": "server_exception", "detail": str(exc)}, 500


@app.post("/api/upload")
def api_upload():
    payload, status = _handle_upload_request()
    return jsonify(payload), status


@app.post("/upload")
def upload():
    payload, status = _handle_upload_request()
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

    step_path = record.step_path or Storage.get_step_path(file_id) or _step_path(file_id)
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

    _schedule_conversion(file_id, step_path)

    payload = updated.to_payload()
    payload["file_id"] = file_id
    return jsonify(payload), 202

# ====== Diag rapide ======
@app.get("/__diag")
def __diag():
    info = {
        "cwd": os.getcwd(),
        "node_bin": shutil.which("node"),
        "npx_bin": shutil.which("npx"),
        "local_xeokit": str(Path(app.root_path) / "node_modules" / ".bin" / "xeokit-convert"),
        "UPLOAD_FOLDER": UPLOAD_FOLDER,
        "OUTPUT_FOLDER": OUTPUT_FOLDER,
        "XEOKIT_ARGS": os.getenv("XEOKIT_ARGS"),
    }
    return jsonify(info)

def create_app() -> Flask:
    """Factory Flask utilisée par Gunicorn."""
    return app

if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
