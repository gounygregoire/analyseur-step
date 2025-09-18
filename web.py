# web.py
import os, uuid, shlex, subprocess, pathlib, shutil, importlib
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

ALLOWED_STEP = {".stp", ".step"}
ALLOWED_STL  = {".stl"}
def _ext(path: str) -> str:
    return pathlib.Path(path.lower()).suffix
def allowed(name: str) -> bool:
    e = _ext(name)
    return (e in ALLOWED_STEP) or (e in ALLOWED_STL)

# ---------- Helpers ----------
def _with_node_path(env: dict) -> dict:
    env = env.copy()
    extra = [
        os.path.join(app.root_path, "node_modules", ".bin"),
        "/opt/render/project/nodes/node-20.19.5/bin",
    ]
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + extra)
    return env

def _run(cmd: str):
    proc = subprocess.run(
        cmd, shell=True, env=_with_node_path(os.environ),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    print(f"[xeokit] CMD: {cmd}", flush=True)
    print(f"[xeokit] RC={proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}", flush=True)
    return proc

def has_ocp() -> tuple[bool,str]:
    try:
        mod = importlib.import_module("OCP")
        ver = getattr(mod, "__version__", "unknown")
        return True, ver
    except Exception:
        return False, ""

def step_to_stl(step_path: str, stl_path: str, linear_def=0.1, angular_def=0.5):
    """STEP -> STL via OCP (OpenCascade)."""
    try:
        from OCP.STEPControl import STEPControl_Reader
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.StlAPI import StlAPI_Writer
    except Exception as e:
        raise RuntimeError(
            "OCP (OpenCascade) n'est pas installé. Ajoute 'OCP==7.7.2' à requirements-web.txt."
        ) from e

    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        raise RuntimeError("Lecture STEP échouée (fichier invalide ?).")

    reader.TransferRoots()
    shape = reader.OneShape()

    BRepMesh_IncrementalMesh(shape, linear_def, True, angular_def, True)

    os.makedirs(os.path.dirname(stl_path), exist_ok=True)
    writer = StlAPI_Writer()
    if not writer.Write(shape, stl_path):
        raise RuntimeError("Écriture STL échouée.")

def run_xkt_convert(src_mesh_path: str, out_xkt: str):
    """STL/IFC/GLTF -> XKT, 2 syntaxes, succès = fichier XKT réellement présent."""
    os.makedirs(os.path.dirname(out_xkt), exist_ok=True)
    local_bin = os.path.join(app.root_path, "node_modules", ".bin", "xeokit-convert")
    bin_cmd   = shlex.quote(local_bin) if os.path.exists(local_bin) else "npx -y @xeokit/xeokit-convert@latest"

    # try 1: avec --source
    cmd1 = f"{bin_cmd} -s {shlex.quote(src_mesh_path)} --output {shlex.quote(out_xkt)}"
    p1 = _run(cmd1)
    if os.path.isfile(out_xkt):
        return

    # try 2: positionnel
    cmd2 = f"{bin_cmd} {shlex.quote(src_mesh_path)} --output {shlex.quote(out_xkt)}"
    p2 = _run(cmd2)
    if os.path.isfile(out_xkt):
        return

    raise RuntimeError(
        "xeokit-convert did not produce XKT.\n"
        f"OUT expected: {out_xkt}\nCMD1 RC={p1.returncode}\nCMD2 RC={p2.returncode}"
    )

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
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
        return jsonify(error="bad_ext", detail="Formats acceptés : .stp, .step, .stl"), 400

    file_id   = str(uuid.uuid4())
    in_path   = os.path.join(UPLOAD_FOLDER, f"{file_id}{_ext(f.filename) or '.step'}")
    out_xkt   = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    try:
        f.save(in_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    try:
        ext = _ext(in_path)
        ocp_ok, ocp_ver = has_ocp()
        print(f"[conv] ext={ext} has_ocp={ocp_ok} ocp_ver={ocp_ver} in={in_path}", flush=True)

        if ext in ALLOWED_STEP:
            if not ocp_ok:
                return jsonify(error="missing_ocp", detail="Installe OCP==7.7.2 pour convertir STEP->STL."), 500
            stl_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.stl")
            step_to_stl(in_path, stl_path)
            src_mesh = stl_path
        else:
            src_mesh = in_path  # .stl direct

        print(f"[conv] src_mesh_for_xeokit={src_mesh}", flush=True)
        run_xkt_convert(src_mesh, out_xkt)
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

    if not os.path.isfile(out_xkt):
        return jsonify(error="no_xkt", detail=f".xkt introuvable. Attendu: {out_xkt}"), 500

    return jsonify(file_id=file_id, status="ready", xkt_url=f"/xkt/{file_id}.xkt")

@app.get("/convert/status")
def convert_status():
    file_id = request.args.get("file_id")
    if not file_id:
        return jsonify(error="no_file_id"), 400
    out_xkt = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.isfile(out_xkt):
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
    ocp_ok, ocp_ver = has_ocp()
    info = {
        "cwd": os.getcwd(),
        "node": shutil.which("node"),
        "npx": shutil.which("npx"),
        "local_xeokit": os.path.join(app.root_path, "node_modules", ".bin", "xeokit-convert"),
        "UPLOAD_FOLDER": UPLOAD_FOLDER,
        "OUTPUT_FOLDER": OUTPUT_FOLDER,
        "MAX_UPLOAD_MB": MAX_UPLOAD_MB,
        "ocp_ok": ocp_ok,
        "ocp_ver": ocp_ver,
    }
    return jsonify(info)
# --- fin web.py ---
