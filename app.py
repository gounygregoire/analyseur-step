# app.py
import logging
import os
import shlex
import shutil
import subprocess
import sys
import traceback
import uuid

from flask import Blueprint, Flask, current_app, jsonify, request, send_from_directory
from pathlib import Path

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
    landing_dir = os.path.join(current_app.root_path, "static", "landing")
    index_path = os.path.join(landing_dir, "index.html")
    cache_headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    if not os.path.exists(index_path):
        return (
            "<h1>Cadlytics</h1><p>Landing en cours.</p>",
            200,
            cache_headers,
        )
    response = send_from_directory(landing_dir, "index.html", conditional=True)
    response.headers.update(cache_headers)
    return response


app.register_blueprint(root_bp)


# --- Healthcheck ---
@app.get("/healthz")
def healthz():
    return {"ok": True}, 200, {"Cache-Control": "no-store"}


# --- Error handler ---
logger = logging.getLogger("cadlytics")


@app.errorhandler(500)
def handle_500(e):
    logger.error(
        "HTTP 500 on %s — %s\n%s",
        request.path,
        repr(e),
        traceback.format_exc(),
    )
    return (
        "Internal Server Error",
        500,
        {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


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
            run_xkt_convert(step_path, xkt_path)
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
