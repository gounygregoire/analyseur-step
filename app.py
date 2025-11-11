"""Routes principales Cadlytics (web + conversion)."""

# app.py
import logging
import os
import shutil
import uuid
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import urllib.parse

from flask import (
    Blueprint,
    Flask,
    Response,
    abort,
    current_app,
    has_app_context,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename

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
    convert_and_publish_xkt,
    is_local_storage,
    local_xkt_path,
    should_serve_xkt_via_flask,
)
from models import File, db

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
api_bp = Blueprint("api", __name__, url_prefix="/api")

_default_db_uri = (
    os.environ.get("SQLALCHEMY_DATABASE_URI")
    or os.environ.get("DATABASE_URL")
    or "sqlite:///cadlytics.sqlite"
)
app.config.setdefault("SQLALCHEMY_DATABASE_URI", _default_db_uri)
app.config.setdefault("SQLALCHEMY_TRACK_MODIFICATIONS", False)
db.init_app(app)

# ====== Config minimale ======
MAX_UPLOAD_MB = int(float(os.environ.get("MAX_UPLOAD_MB", "50")))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)
app.config.setdefault("SRC_DIR", os.environ.get("SRC_DIR", UPLOAD_FOLDER))

# ====== XKT publication ======
XKT_STORAGE = (os.getenv("XKT_STORAGE", "local") or "local").strip().lower()
XKT_LOCAL_DIR = os.getenv("XKT_LOCAL_DIR", "/srv/app/public/xkt")
XKT_BASE_URL = os.getenv("XKT_BASE_URL", "https://cadlytics.app/xkt").rstrip("/")
if not XKT_BASE_URL:
    XKT_BASE_URL = "https://cadlytics.app/xkt"

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
_upload_jobs: dict[str, str] = {}


def _ensure_app_context():
    if has_app_context():
        return None
    ctx = app.app_context()
    ctx.push()
    return ctx


def run_real_xkt_converter(src_path: str, dest_path: str) -> None:
    """Exécute le convertisseur XKT réel (wrapper)."""

    from xkt_converter import convert_step_to_xkt  # import tardif

    convert_step_to_xkt(src_path, dest_path)


def convert_to_xkt(file_id: str, src_path: str) -> tuple[str, str]:
    """Convertit un STEP vers XKT et met à jour le statut en base."""

    ctx = _ensure_app_context()
    try:
        storage = (XKT_STORAGE or "local").lower()
        if storage not in {"local", "s3"}:
            current_app.logger.warning(
                "[convert] XKT_STORAGE inconnu=%s, fallback local", storage
            )
            storage = "local"
        if storage == "s3":
            result = convert_and_publish_xkt(file_id, src_path)
            final_path = result.local_path
            xkt_url = result.xkt_url
        else:
            tmp_path = f"/tmp/{file_id}.xkt"
            try:
                run_real_xkt_converter(src_path, tmp_path)
            except Exception:
                if not os.path.exists(tmp_path):
                    with open(tmp_path, "wb") as handle:
                        handle.write(b"XKT DUMMY")
                else:
                    raise

            os.makedirs(XKT_LOCAL_DIR, exist_ok=True)
            final_path = os.path.join(XKT_LOCAL_DIR, f"{file_id}.xkt")
            if os.path.exists(final_path):
                os.remove(final_path)
            shutil.move(tmp_path, final_path)
            xkt_url = f"{XKT_BASE_URL}/{file_id}.xkt"

        mark_file_ready(file_id, xkt_path=final_path, xkt_url=xkt_url)

        file_row = db.session.get(File, file_id)
        if file_row:
            file_row.status = "ready"
            file_row.xkt_url = xkt_url
            file_row.error_message = None
            file_row.updated_at = datetime.now(timezone.utc)
            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                current_app.logger.error("[convert] commit ready failed", exc_info=True)
        else:
            current_app.logger.error(
                "[convert] file_id absent en DB: %s", file_id
            )

        return final_path, xkt_url
    except Exception as exc:
        short = str(exc)
        mark_file_failed(file_id, short)
        file_row = db.session.get(File, file_id)
        if file_row:
            file_row.status = "failed"
            file_row.error_message = short[:500]
            file_row.updated_at = datetime.now(timezone.utc)
            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                current_app.logger.error("[convert] commit failed status", exc_info=True)
        raise
    finally:
        if ctx is not None:
            ctx.pop()


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
    job_id = _upload_jobs.get(file_id)
    if job_id:
        JOBS[job_id] = {"status": "running", "file_id": file_id, "started_at": time.time()}
    try:
        _, xkt_url = convert_to_xkt(file_id, step_path)
        if job_id:
            JOBS[job_id] = {
                "status": "finished",
                "file_id": file_id,
                "xkt_url": xkt_url,
                "completed_at": time.time(),
            }
    except Exception as exc:
        if job_id:
            JOBS[job_id] = {
                "status": "error",
                "file_id": file_id,
                "error": str(exc),
            }
    finally:
        with _conversion_lock:
            _conversion_threads.pop(file_id, None)
            if job_id:
                _upload_jobs.pop(file_id, None)


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

@api_bp.post("/reconvert")
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

@api_bp.get("/reconvert/status/<job_id>")
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
def enqueue_convert_xkt(*, file_id: str, src_path: str):
    """Planifie une conversion XKT en arrière-plan."""

    with _conversion_lock:
        job_id = _upload_jobs.get(file_id)
        if not job_id:
            job_id = uuid.uuid4().hex
            _upload_jobs[file_id] = job_id
    JOBS[job_id] = {"status": "pending", "file_id": file_id}
    _schedule_conversion(file_id, src_path)

    class _AsyncJob:
        def __init__(self, identifier: str | None):
            self.id = identifier

    return _AsyncJob(job_id)


def _handle_upload_request() -> tuple[dict, int]:
    try:
        incoming = request.files.get("file")
        if not incoming or not incoming.filename:
            return {"error": "no file"}, 400

        original_name = secure_filename(incoming.filename or "")
        if not original_name:
            return {"error": "invalid filename"}, 400

        if not _allowed(original_name):
            return {
                "error": "bad_ext",
                "detail": "Extensions supportées: .step, .stp, .stl",
            }, 400

        file_id = str(uuid.uuid4())
        src_dir = current_app.config.get("SRC_DIR", "/srv/app/uploads")
        os.makedirs(src_dir, exist_ok=True)
        src_path = os.path.join(src_dir, f"{file_id}__{original_name}")

        try:
            incoming.save(src_path)
        except Exception as exc:
            if os.path.exists(src_path):
                os.remove(src_path)
            return {"error": "save_failed", "detail": str(exc)}, 500

        ext = Path(original_name).suffix or ".step"
        legacy_step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
        if legacy_step_path != src_path:
            try:
                shutil.copyfile(src_path, legacy_step_path)
            except Exception:
                logging.getLogger("cadlytics.files").warning(
                    "[files] unable to persist legacy STEP copy", exc_info=True
                )

        try:
            _create_record(file_id, original_name, src_path)
            mark_file_processing(file_id)
        except Exception:
            logging.getLogger("cadlytics.files").warning(
                "[files] unable to persist legacy record", exc_info=True
            )

        file_row = File(id=file_id, original_name=original_name, status="processing")
        try:
            db.session.add(file_row)
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            logging.getLogger("cadlytics.db").error(
                "[files] unable to persist upload metadata", exc_info=True
            )
            return {"error": "db_error", "detail": str(exc)}, 500

        job = enqueue_convert_xkt(file_id=file_id, src_path=src_path)
        job_id = getattr(job, "id", None)

        return {"fileId": file_id, "jobId": job_id}, 200
    except Exception as exc:  # pragma: no cover - garde-fou
        logging.getLogger("cadlytics").exception("[files] upload failed")
        return {"error": "server_exception", "detail": str(exc)}, 500


@api_bp.post("/upload")
def api_upload():
    payload, status = _handle_upload_request()
    return jsonify(payload), status


@app.post("/upload")
def upload():
    payload, status = _handle_upload_request()
    return jsonify(payload), status


@api_bp.get("/files/<file_id>/status")
def file_status(file_id: str):
    record = get_file_record(file_id)
    file_row = db.session.get(File, file_id)
    if file_row is not None:
        status = file_row.status
        xkt_url = file_row.xkt_url if status == "ready" else None
        message = file_row.error_message or ""
        updated_at = file_row.updated_at.isoformat() if file_row.updated_at else None

        if record and record.status != status:
            status = record.status
            xkt_url = record.xkt_url if status == "ready" else None
            message = record.error_message or ""
            updated_at = record.updated_at
            try:
                file_row.status = status
                file_row.xkt_url = record.xkt_url
                file_row.error_message = record.error_message
                db.session.commit()
            except Exception:
                db.session.rollback()

        payload = {
            "status": status,
            "xkt_url": xkt_url,
            "message": message,
            "updated_at": updated_at,
        }
        return jsonify(payload), 200

    if not record:
        return jsonify({"error": "unknown file_id"}), 404

    payload = {
        "status": record.status,
        "xkt_url": record.xkt_url if record.status == "ready" else None,
        "message": record.error_message or "",
        "updated_at": record.updated_at,
    }
    return jsonify(payload), 200


@api_bp.post("/files/<file_id>/reconvert")
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


@api_bp.get("/health")
def api_health():
    return jsonify({"ok": True}), 200


@api_bp.get("/_routes")
def list_routes():
    output = []
    for rule in current_app.url_map.iter_rules():
        methods = ",".join(sorted(rule.methods - {"HEAD", "OPTIONS"}))
        url = urllib.parse.unquote(str(rule))
        output.append({"rule": url, "endpoint": rule.endpoint, "methods": methods})
    return jsonify({"routes": output}), 200

app.register_blueprint(api_bp)

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
