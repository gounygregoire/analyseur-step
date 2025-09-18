# web.py
import os
import uuid
import pathlib
import requests
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS

# ---------- App & CORS ----------
app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# ---------- Config ----------
def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        return int(float(str(v).strip().strip('"').strip("'")))
    except Exception:
        return default

MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 50)  # 50 Mo par défaut
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# URL du converter (env > fallback hardcodé demandé)
CONVERTER_URL = os.environ.get("CONVERTER_URL", "https://cadlytics-converter.onrender.com").rstrip("/")

# Extensions acceptées (le converter gère .stl et .step/.stp)
ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str:
    return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool:
    return _ext(name) in ALLOWED_EXTS

# ---------- Helpers ----------
def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# ---------- Pages ----------
@app.get("/")
def landing():
    """
    Cherche un index dans templates/ puis dans static/
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
    # Ta page viewer (templates/app.html)
    return render_template("app.html", max_upload_mb=MAX_UPLOAD_MB)

@app.get("/favicon.ico")
def favicon():
    return "", 204

@app.get("/healthz")
def healthz():
    return "ok"

# ---------- API : upload -> forward au converter ----------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not _allowed(f.filename):
        return jsonify(error="bad_ext", detail="Formats acceptés : .stl, .step, .stp"), 400

    file_id = str(uuid.uuid4())
    in_path  = os.path.join(UPLOAD_FOLDER, f"{file_id}{_ext(f.filename) or '.step'}")
    out_xkt  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    # On sauvegarde localement (utile pour debug et pour rejouer si besoin)
    try:
        f.save(in_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    # Envoi au converter privé (ou public si tu préfères) et récupération du XKT
    try:
        # On renvoie le nom d'origine au converter (ça ne change rien, mais c’est propre)
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600,  # la conversion peut être longue
            )
        if resp.status_code != 200:
            # Essaye d’extraire un message utile si JSON
            detail = resp.text
            try:
                detail = resp.json()
            except Exception:
                pass
            return jsonify(error="convert_fail", detail=detail, status_code=resp.status_code), 500

        # Sauvegarde le XKT renvoyé
        with open(out_xkt, "wb") as out:
            out.write(resp.content)

        if not os.path.isfile(out_xkt):
            return jsonify(error="no_xkt", detail=f".xkt introuvable après conversion: {out_xkt}"), 500

        return jsonify(file_id=file_id, status="ready", xkt_url=f"/xkt/{file_id}.xkt")

    except requests.Timeout:
        return jsonify(error="convert_timeout", detail="Converter timeout (>=600s)"), 504
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

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
    info = {
        "cwd": os.getcwd(),
        "UPLOAD_FOLDER": UPLOAD_FOLDER,
        "OUTPUT_FOLDER": OUTPUT_FOLDER,
        "MAX_UPLOAD_MB": MAX_UPLOAD_MB,
        "converter_url": CONVERTER_URL,
    }
    # ping rapide du converter (optionnel)
    try:
        r = requests.get(f"{CONVERTER_URL}/healthz", timeout=2)
        info["converter_health"] = {"ok": (r.status_code == 200), "code": r.status_code}
    except Exception as e:
        info["converter_health"] = {"ok": False, "error": str(e)}
    return jsonify(info)
# --- fin web.py ---
