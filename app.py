# app.py
import os, uuid, shlex, subprocess, pathlib
from flask import Flask, request, jsonify, send_from_directory, abort, render_template

# --------- Flask & config de base ---------
app = Flask(__name__, static_folder="static", template_folder="templates")

# Limite upload (env MAX_UPLOAD_MB en Mo, défaut 50 Mo)
MAX_UPLOAD_MB = int(float(os.environ.get("MAX_UPLOAD_MB", "50")))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# Dossiers de travail (surchargeables via env)
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

ALLOWED = {".stp", ".step"}
def _allowed(filename: str) -> bool:
    return pathlib.Path(filename.lower()).suffix in ALLOWED

# --------- Helpers Xeokit convert ---------
def _npx_bin() -> str:
    # Sur Render, npx est dans le PATH. Sinon, adapte ici.
    return "npx"

def _with_node_path(env: dict) -> dict:
    env = env.copy()
    # Ajoute (inoffensif si absent) un chemin Node fréquent sur Render
    env["PATH"] = env.get("PATH", "") + ":/opt/render/project/nodes/node-20.19.5/bin"
    return env

def run_xkt_convert(step_path: str, xkt_path: str):
    """
    Convertit un STEP en XKT via xeokit-convert (package @xeokit/xeokit-convert).
    """
    cmd = f"""{shlex.quote(_npx_bin())} -y @xeokit/xeokit-convert@latest \
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

# --------- Pages ---------
@app.get("/")
def landing():
    """
    Sert la landing :
    - Priorité templates/index.html (ta landing “complète”)
    - Sinon templates/landing.html si présent
    - Sinon message d’aide
    """
    tpl_dir = os.path.join(app.root_path, "templates")
    if os.path.exists(os.path.join(tpl_dir, "index.html")):
        return render_template("index.html")
    if os.path.exists(os.path.join(tpl_dir, "landing.html")):
        return render_template("landing.html")
    return ("Landing non trouvée. Ajoute templates/index.html ou templates/landing.html.", 200)

@app.get("/app")
def app_view():
    """
    Sert la page viewer Xeokit (templates/app.html).
    On passe max_upload_mb au besoin (certaines versions du template l’utilisent).
    """
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)

@app.get("/healthz")
def healthz():
    return "ok"

@app.get("/__routes")
def routes():
    lines = [f"{r.methods} {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

# --------- API conversion ---------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not _allowed(f.filename):
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
