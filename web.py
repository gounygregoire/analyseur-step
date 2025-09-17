# web.py
import os, uuid, shlex, subprocess, pathlib, shutil
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# ---------- Limites & dossiers ----------
def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        return int(float(str(v).strip().strip('"').strip("'")))
    except Exception:
        return default

MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 50)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

ALLOWED = {".stp", ".step"}
def allowed(name: str) -> bool:
    return pathlib.Path(name.lower()).suffix in ALLOWED

# ---------- Helpers ----------
def _with_node_path(env: dict) -> dict:
    env = env.copy()
    extra = [
        os.path.join(app.root_path, "node_modules", ".bin"),
        "/opt/render/project/nodes/node-20.19.5/bin",
    ]
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + extra)
    return env

def run_xkt_convert(step_path: str, out_xkt: str):
    """
    Versions récentes :
      xeokit-convert <INPUT> --output <OUTPUT_XKT_FILE>
    (INPUT en positionnel. OUTPUT = chemin de FICHIER .xkt attendu)
    """
    os.makedirs(os.path.dirname(out_xkt), exist_ok=True)

    local_bin = os.path.join(app.root_path, "node_modules", ".bin", "xeokit-convert")
    if os.path.exists(local_bin):
        cmd = f"{shlex.quote(local_bin)} {shlex.quote(step_path)} --output {shlex.quote(out_xkt)}"
    else:
        cmd = f"npx -y @xeokit/xeokit-convert@latest {shlex.quote(step_path)} --output {shlex.quote(out_xkt)}"

    proc = subprocess.run(
        cmd, shell=True, env=_with_node_path(os.environ),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    print(f"[xeokit] CMD: {cmd}", flush=True)
    print(f"[xeokit] RC={proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}", flush=True)
    if proc.returncode != 0:
        raise RuntimeError(f"xeokit-convert failed ({proc.returncode})\nSTDERR:\n{proc.stderr}")

    # Si la CLI a quand même créé un DOSSIER (comportement vu sur certaines builds),
    # on récupère le premier .xkt et on le déplace vers out_xkt.
    if not os.path.exists(out_xkt) and os.path.isdir(out_xkt):
        for dp, _, fns in os.walk(out_xkt):
            for fn in fns:
                if fn.lower().endswith(".xkt"):
                    src = os.path.join(dp, fn)
                    try:
                        shutil.move(src, out_xkt)
                    except Exception:
                        shutil.copyfile(src, out_xkt)
                        os.remove(src)
                    break


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def _find_first_xkt(root_dir: str) -> str | None:
    for dirpath, _, filenames in os.walk(root_dir):
        for name in filenames:
            if name.lower().endswith(".xkt"):
                return os.path.join(dirpath, name)
    return None

# ---------- Pages ----------
@app.get("/")
def landing():
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

    file_id  = str(uuid.uuid4())
    step_path = os.path.join(UPLOAD_FOLDER, f"{file_id}.step")
    out_xkt   = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    try:
        f.save(step_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    try:
        run_xkt_convert(step_path, out_xkt)
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

    # Fallback ultime : si out_xkt est un dossier (bug de CLI), on retente une fois le scan ici.
    if not os.path.exists(out_xkt):
        produced = None
        if os.path.isdir(out_xkt):
            for dp, _, fns in os.walk(out_xkt):
                for fn in fns:
                    if fn.lower().endswith(".xkt"):
                        produced = os.path.join(dp, fn); break
                if produced: break
            if produced:
                try:
                    shutil.move(produced, out_xkt)
                except Exception:
                    shutil.copyfile(produced, out_xkt)
                    os.remove(produced)

    if not os.path.exists(out_xkt):
        # Diagnostic : liste (max 40) des fichiers autour de OUTPUT_FOLDER
        try:
            listing = []
            for dp, _, fns in os.walk(OUTPUT_FOLDER):
                for fn in fns:
                    listing.append(os.path.join(dp, fn))
                    if len(listing) >= 40:
                        break
                if len(listing) >= 40:
                    break
            listing_text = "\n".join(listing)
        except Exception:
            listing_text = "(listing error)"
        return jsonify(error="no_xkt",
                       detail=f".xkt introuvable. Attendu: {out_xkt}\nFiles around:\n{listing_text}"), 500

    return jsonify(file_id=file_id, status="ready", xkt_url=f"/xkt/{file_id}.xkt")

@app.get("/convert/status")
def convert_status():
    file_id = request.args.get("file_id")
    if not file_id:
        return jsonify(error="no_file_id"), 400
    final_xkt = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.exists(final_xkt):
        return jsonify(status="ready", xkt_url=f"/xkt/{file_id}.xkt")
    return jsonify(status="processing")

@app.get("/xkt/<path:fname>")
def serve_xkt(fname):
    if not fname.endswith(".xkt"):
        abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)

# ---------- Diag ----------
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
