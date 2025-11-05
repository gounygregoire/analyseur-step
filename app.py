"""Routes principales Cadlytics (web + conversion)."""

# app.py
import logging
import os
import shlex
import shutil
import subprocess
import sys
import traceback
import uuid
import threading
import time
from xkt_converter import convert_step_to_xkt  # conversion robuste (GLB guard)
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

app = Flask(__name__, static_folder="static", template_folder="templates")
root_bp = Blueprint("root", __name__)

# ===== Config minimale =====
MAX_UPLOAD_MB = int(float(os.environ.get("MAX_UPLOAD_MB", "50")))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

JOBS = {}  # job_id -> {"status": "pending|running|finished|error", ...}

def _step_path(file_id: str) -> str:
    return os.path.join(UPLOAD_FOLDER, f"{file_id}.step")

def _xkt_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

def _glb_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.glb")

def _size_or_0(path: str) -> int:
    try:
        return os.path.getsize(path) if os.path.isfile(path) else 0
    except Exception:
        return 0


# ===== Helpers =====
ALLOWED = {".stp", ".step"}
def _allowed(name: str) -> bool:
    return Path(name.lower()).suffix in ALLOWED

def _with_node_path(env: dict) -> dict:
    env = env.copy()
    root = app.root_path
    # ajoute node + les bins locaux de node_modules
    extra = [
        str(Path(root) / "node_modules" / ".bin"),
        "/opt/render/project/nodes/node-20.19.5/bin",  # Render (si présent)
    ]
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + extra)
    return env

def _resolve_converter_cmd(step_path: str, xkt_path: str) -> str:
    extra = os.getenv("XEOKIT_ARGS", "").strip()  # ex: "--no-merge --keep-hierarchy"
    local_bin = Path(app.root_path) / "node_modules" / ".bin" / "xeokit-convert"
    if local_bin.exists():
        return f"{shlex.quote(str(local_bin))} {extra} {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"
    return f"npx -y @xeokit/xeokit-convert@latest {extra} {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"

def run_xkt_convert(step_path: str, xkt_path: str):
    cmd = _resolve_converter_cmd(step_path, xkt_path)
    proc = subprocess.run(
        cmd, shell=True, env=_with_node_path(os.environ),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    # log côté serveur pour debug Render
    print(f"[xeokit] CMD: {cmd}", file=sys.stderr, flush=True)
    print(f"[xeokit] RC={proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}", file=sys.stderr, flush=True)
    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-convert failed ({proc.returncode})")

# --- Root landing ---
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


@app.route("/app", methods=["GET"], endpoint="site.app_page")
def site_app_page():
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)


@app.route("/outputs/<path:fname>", methods=["GET"], endpoint="site.public_outputs")
def site_public_outputs(fname: str):
    base_dir = OUTPUT_FOLDER
    path = os.path.join(base_dir, fname)
    if not os.path.isfile(path):
        abort(404)
    return send_from_directory(base_dir, fname)

@app.route("/xkt/<file_id>.xkt", methods=["GET", "HEAD"])
def serve_xkt(file_id: str):
    fname = f"{file_id}.xkt"
    path = _xkt_path(file_id)
    if not os.path.isfile(path):
        abort(404)
    resp = send_from_directory(OUTPUT_FOLDER, fname, mimetype="application/octet-stream")
    resp.headers["Cache-Control"] = "no-cache, max-age=0"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    if request.method == "HEAD":
        resp.set_data(b"")
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

@app.get("/exists/xkt/<file_id>")
def exists_xkt(file_id: str):
    p = _xkt_path(file_id)
    exists = os.path.isfile(p)
    size = _size_or_0(p)
    # si un job tourne encore pour ce file_id
    status = "ready" if (exists and size > 0) else "pending"
    return jsonify({"exists": bool(exists), "file_id": file_id, "size": int(size), "status": status})

def _reconvert_job(file_id: str, job_id: str):
    JOBS[job_id] = {"status": "running", "file_id": file_id, "started_at": time.time()}
    try:
        step = _step_path(file_id)
        xkt  = _xkt_path(file_id)
        # Conversion robuste (génère un GLB intermédiaire et refuse les XKT trop petits)
        convert_step_to_xkt(step, xkt)
        size = _size_or_0(xkt)
        JOBS[job_id] = {"status": "finished", "file_id": file_id, "xkt_size": size}
    except Exception as e:
        JOBS[job_id] = {"status": "error", "file_id": file_id, "error": str(e)}

@app.post("/api/reconvert")
def api_reconvert():
    data = request.get_json(silent=True) or {}
    file_id = (data.get("file_id") or data.get("id") or "").strip()
    if not file_id:
        return jsonify(error="missing_file_id"), 400

    # si déjà prêt, on court-circuite
    if _size_or_0(_xkt_path(file_id)) > 0:
        return jsonify(job_id="noop", status="finished")

    job_id = str(uuid.uuid4())
    th = threading.Thread(target=_reconvert_job, args=(file_id, job_id), daemon=True)
    th.start()
    JOBS[job_id] = {"status": "pending", "file_id": file_id}
    return jsonify(job_id=job_id, status="pending")

@app.get("/api/reconvert/status/<job_id>")
def api_reconvert_status(job_id: str):
    info = JOBS.get(job_id)
    if not info:
        return jsonify(status="unknown", job_id=job_id), 404
    return jsonify(info | {"job_id": job_id})



# --- Healthcheck ---
@app.get("/healthz")
def healthz():
    return Response("ok", 200, content_type="text/plain")


# --- Error handler ---
logger = logging.getLogger("cadlytics")


@app.errorhandler(Exception)
def handle_exception(exc):
    if isinstance(exc, HTTPException):
        if exc.code >= 500:
            logger.exception("HTTP %s on %s", exc.code, request.path)
        return exc
    logger.exception("Unhandled exception on %s", request.path)
    return jsonify(error="internal_error"), 500


# ===== API conversion (upload -> XKT) =====
@app.post("/upload")
def upload():
    try:
        f = request.files.get("file")
        if not f or not f.filename:
            return jsonify(error="no_file"), 400
        if not _allowed(f.filename):
            return jsonify(error="bad_ext",
                           detail="Seuls .stp / .step sont acceptés."), 400

        file_id = str(uuid.uuid4())
        step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}.step")
        xkt_path  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

        f.save(step_path)  # peut lever si répertoire manquant, droits, etc.

        try:
            convert_step_to_xkt(step_path, xkt_path)
        except Exception as e:
            # On renvoie stdout/stderr côté client pour debug rapide
            return jsonify(error="convert_fail", detail=str(e)), 500

        if not os.path.exists(xkt_path):
            return jsonify(error="no_xkt", detail="Conversion terminée mais fichier .xkt introuvable."), 500

        return jsonify(file_id=file_id, status="ready", xkt_url=f"/xkt/{file_id}.xkt")
    except Exception as e:
        return jsonify(error="server_exception", detail=str(e)), 500

# --- routes diag (utiles 2 minutes) ---
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
