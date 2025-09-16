import os, uuid, shlex, subprocess
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from redis import Redis
from rq import Queue

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

REDIS_URL = os.environ.get("REDIS_URL")
redis_conn = Redis.from_url(REDIS_URL) if REDIS_URL else None
q = Queue(connection=redis_conn) if redis_conn else None

ALLOWED = {".stp", ".step"}
def allowed(name): return os.path.splitext(name.lower())[1] in ALLOWED

# ---------- Routes pages ----------
@app.get("/")
def index():
    # 1) si templates/index.html existe, on la rend
    tpl = os.path.join(app.root_path, "templates", "index.html")
    if os.path.exists(tpl):
        return render_template("index.html")
    # 2) sinon, si static/index.html existe, on le sert
    st = os.path.join(app.root_path, "static", "index.html")
    if os.path.exists(st):
        return send_from_directory("static", "index.html")
    # 3) fallback minimal pour éviter 500
    return "Landing non trouvée (templates/index.html ou static/index.html)", 200

@app.get("/app")
def app_viewer():
    return render_template("app.html")

@app.get("/favicon.ico")
def favicon():
    return "", 204

@app.get("/healthz")
def healthz():
    return "ok"

# ---------- Conversion XKT via npx ----------
def _npx_cmd(): return "npx"  # Render expose Node via NODE_VERSION

def run_xkt_convert(step_path: str, xkt_path: str):
    npx = _npx_cmd()
    cmd = f"""{shlex.quote(npx)} -y @xeokit/xeokit-convert@latest --input {shlex.quote(step_path)} --output {shlex.quote(xkt_path)}"""
    env = os.environ.copy()
    env["PATH"] = env.get("PATH","") + ":/opt/render/project/nodes/node-20.19.5/bin"
    proc = subprocess.run(cmd, shell=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-convert failed ({proc.returncode})\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")

# ---------- API ----------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename: return jsonify(error="no_file"), 400
    if not allowed(f.filename): return jsonify(error="bad_ext"), 400

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
    if not file_id: return jsonify(error="no_file_id"), 400
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.exists(xkt_path): return jsonify(status="ready", xkt_url=f"/xkt/{file_id}.xkt")
    return jsonify(status="processing")

@app.get("/xkt/<path:fname>")
def serve_xkt(fname):
    if not fname.endswith(".xkt"): abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)
