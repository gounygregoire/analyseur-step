import os, uuid, shlex, subprocess, mimetypes, pathlib
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from redis import Redis
from rq import Queue

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# Limites & dossiers
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# Queue optionnelle (pour /dfm si besoin)
REDIS_URL = os.environ.get("REDIS_URL")
redis_conn = Redis.from_url(REDIS_URL) if REDIS_URL else None
q = Queue(connection=redis_conn) if redis_conn else None

ALLOWED = {".stp", ".step"}
def allowed(name: str) -> bool:
    return pathlib.Path(name.lower()).suffix in ALLOWED

# -------- Helpers --------
def _npx_bin() -> str:
    # Render expose Node via NODE_VERSION, on ajoute son PATH par sécurité
    return "npx"

def _with_node_path(env: dict) -> dict:
    env = env.copy()
    # Chemin de Node sur Render (ok si inexistant)
    env["PATH"] = env.get("PATH","") + ":/opt/render/project/nodes/node-20.19.5/bin"
    return env

def run_xkt_convert(step_path: str, xkt_path: str):
    npx = _npx_bin()
    cmd = f"""{shlex.quote(npx)} -y @xeokit/xeokit-convert@latest \
      --input {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"""
    proc = subprocess.run(
        cmd, shell=True, env=_with_node_path(os.environ),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"xeokit-convert failed ({proc.returncode})\n"
            f"STDOUT:\n{proc.stdout}\n\nSTDERR:\n{proc.stderr}"
        )

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# -------- Routes pages --------
@app.get("/")
def landing():
    """
    Essaie dans cet ordre pour ne pas casser ta landing existante :
    1) templates/index.html (Jinja)
    2) templates/home.html ou templates/landing.html
    3) static/index.html
    4) static/dist/index.html (build front)
    5) static/app/index.html
    """
    candidates = [
        os.path.join(app.root_path, "templates", "index.html"),
        os.path.join(app.root_path, "templates", "home.html"),
        os.path.join(app.root_path, "templates", "landing.html"),
        os.path.join(app.root_path, "static", "index.html"),
        os.path.join(app.root_path, "static", "dist", "index.html"),
        os.path.join(app.root_path, "static", "app", "index.html"),
    ]
    found = _first_existing(candidates)
    if not found:
        return "Landing non trouvée (ajoute templates/index.html ou static/index.html)", 200

    # Si c'est un template -> render_template, sinon -> send_from_directory
    rel = os.path.relpath(found, app.root_path)
    parts = rel.split(os.sep)
    if parts[0] == "templates":
        # ex: templates/index.html
        return render_template(parts[-1])
    # ex: static/index.html
    return send_from_directory(os.path.dirname(rel), os.path.basename(rel))

@app.get("/app")
def app_view():
    # Page dédiée au viewer (templates/app.html)
    return render_template("app.html")

@app.get("/favicon.ico")
def favicon():
    return "", 204

@app.get("/healthz")
def healthz():
    return "ok"

# -------- API conversion --------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not allowed(f.filename):
        return jsonify(error="bad_ext"), 400

    file_id = str(uuid.uuid4())
    step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}.step")
    xkt_path  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    try:
        f.save(step_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    try:
        run_xkt_convert(step_path, xkt_path)
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

    xkt_url = f"/xkt/{file_id}.xkt" if os.path.exists(xkt_path) else None
    return jsonify(file_id=file_id, status=("ready" if xkt_url else "processing"), xkt_url=xkt_url)

@app.get("/convert/status")
def convert_status():
    file_id = request.args.get("file_id")
    if not file_id:
        return jsonify(error="no_file_id"), 400
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.exists(xkt_path):
        return jsonify(status="ready", xkt_url=f"/xkt/{file_id}.xkt")
    return jsonify(status="processing")

@app.get("/xkt/<path:fname>")
def serve_xkt(fname):
    if not fname.endswith(".xkt"):
        abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)
# --- fin web.py ---
