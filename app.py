# app.py
import os, uuid, shlex, subprocess, pathlib
from flask import Flask, request, jsonify, send_from_directory, abort, render_template

app = Flask(__name__, static_folder="static", template_folder="templates")

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
    return pathlib.Path(name.lower()).suffix in ALLOWED

def _npx_bin() -> str:
    return "npx"

def _with_node_path(env: dict) -> dict:
    env = env.copy()
    env["PATH"] = env.get("PATH", "") + ":/opt/render/project/nodes/node-20.19.5/bin"
    return env

def run_xkt_convert(step_path: str, xkt_path: str):
    cmd = f"""{_npx_bin()} -y @xeokit/xeokit-convert@latest --input {step_path} --output {xkt_path}"""
    proc = subprocess.run(cmd, shell=True, env=_with_node_path(os.environ),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-convert failed ({proc.returncode})\nSTDOUT:\n{proc.stdout}\n\nSTDERR:\n{proc.stderr}")

# ===== Pages =====
@app.get("/")
def landing():
    # Affiche templates/index.html si présent, sinon message clair
    tpl = os.path.join(app.root_path, "templates", "index.html")
    return render_template("index.html") if os.path.exists(tpl) else ("Landing non trouvée : crée templates/index.html", 200)

@app.get("/app")
def app_view():
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)

@app.get("/healthz")
def healthz():
    return "ok"

@app.get("/__routes")
def routes():
    lines = [f"{r.methods} {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

# ===== API conversion (upload -> XKT) =====
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
    f.save(step_path)
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
    return (jsonify(status="ready", xkt_url=f"/xkt/{file_id}.xkt") if os.path.exists(xkt_path)
            else jsonify(status="processing"))

@app.get("/xkt/<path:fname>")
def serve_xkt(fname):
    if not fname.endswith(".xkt"):
        abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)
