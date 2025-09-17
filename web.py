# web.py
import os, uuid, shlex, subprocess, pathlib, shutil
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# ---------- Limites & dossiers ----------
MAX_UPLOAD_MB = int(float(os.environ.get("MAX_UPLOAD_MB", "50")))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024  # 50 MB par défaut

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

ALLOWED = {".stp", ".step"}
def allowed(name: str) -> bool:
    return pathlib.Path(name.lower()).suffix in ALLOWED

# ---------- Helpers ----------
def _with_node_path(env: dict) -> dict:
    """Ajoute les chemins Node usuels (local + Render)."""
    env = env.copy()
    extra = [
        os.path.join(app.root_path, "node_modules", ".bin"),
        "/opt/render/project/nodes/node-20.19.5/bin",  # inoffensif si absent
    ]
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + extra)
    return env

def run_xkt_convert(step_path: str, xkt_path: str):
    """
    xeokit-convert (versions récentes) :
      xeokit-convert <INPUT> --output <OUTPUT>
    (INPUT en positionnel, pas d'option --input)
    """
    # 1) Binaire local si présent (recommandé)
    local_bin = os.path.join(app.root_path, "node_modules", ".bin", "xeokit-convert")
    if os.path.exists(local_bin):
        cmd = f"{shlex.quote(local_bin)} {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"
    else:
        # 2) Fallback via npx (moins fiable)
        cmd = f"npx -y @xeokit/xeokit-convert@latest {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"

    proc = subprocess.run(
        cmd, shell=True, env=_with_node_path(os.environ),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )

    # Logs utiles (visibles dans Render)
    print(f"[xeokit] CMD: {cmd}", flush=True)
    print(f"[xeokit] RC={proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}", flush=True)

    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-convert failed ({proc.returncode})\nSTDERR:\n{proc.stderr}")

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# ---------- Pages ----------
@app.get("/")
def landing():
    """
    Essaie dans cet ordre pour la landing :
      1) templates/index.html
      2) templates/home.html / templates/landing.html
      3) static/index.html
      4) static/dist/index.html
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

    rel = os.path.relpath(found, app.root_path)
    parts = rel.split(os.sep)
    if parts[0] == "templates":
        return render_template(parts[-1])
    return send_from_directory(os.path.dirname(rel), os.path.basename(rel))

@app.get("/app")
def app_view():
    # Page viewer Xeokit
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)

@app.get("/favicon.ico")
def favicon():
    return "", 204

@app.get("/healthz")
def healthz():
    return "ok"

# ---------- API conversion ----------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not allowed(f.filename):
        return jsonify(error="bad_ext", detail="Seuls .stp / .step sont acceptés."), 400

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
        # On renvoie le détail pour debug rapide côté client
        return jsonify(error="convert_fail", detail=str(e)), 500

    if not os.path.exists(xkt_path):
        return jsonify(error="no_xkt", detail="Conversion OK mais .xkt introuvable."), 500

    return jsonify(file_id=file_id, status="ready", xkt_url=f"/xkt/{file_id}.xkt")

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

# ---------- Routes de diag (pratiques) ----------
@app.get("/__routes")
def __routes():
    lines = [f"{sorted(r.methods)}  {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

@app.get("/__diag")
def __diag():
    info = {
        "cwd": os.getcwd(),
        "node": shutil.which("node"),
        "npx": shutil.which("npx"),
        "local_xeokit": os.path.join(app.root_path, "node_modules", ".bin", "xeokit-convert"),
        "UPLOAD_FOLDER": UPLOAD_FOLDER,
        "OUTPUT_FOLDER": OUTPUT_FOLDER,
        "MAX_UPLOAD_MB": MAX_UPLOAD_MB,
    }
    return jsonify(info)
# --- fin web.py ---
