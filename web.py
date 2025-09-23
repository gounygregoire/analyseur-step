# web.py
import os
import uuid
import pathlib
import time
import json
import requests
# RQ / Redis (Option B : analyse déléguée au worker)
import redis
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv
load_dotenv()  # charge .env si présent



from rq import Queue

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

# ---------- Redis / RQ (Option B) ----------
# Essaie d'abord REDIS_URL, puis REDIS_TLS_URL (certains providers),
# sinon fallback sur TON URL gérée (au lieu de localhost).
REDIS_URL = (
    os.environ.get("REDIS_URL")
    or os.environ.get("REDIS_TLS_URL")
    or "redis://default:gISbsmwsGo5RgJtTA9xX9TQknzx0cvD6@redis-12922.c327.europe-west1-2.gce.redns.redis-cloud.com:12922/0"
)
RQ_QUEUE_NAME = os.environ.get("RQ_QUEUE_NAME", "analysis")  # "default" si ton worker écoute la default

try:
    _redis = redis.from_url(REDIS_URL)
    q = Queue(RQ_QUEUE_NAME, connection=_redis)
except Exception:
    q = None
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

    # Envoi au converter et récupération du XKT
    try:
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600,  # la conversion peut être longue
            )
        if resp.status_code != 200:
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

# ---------- Helpers analyse / caches (Option B) ----------
def _step_path_for(file_id: str) -> str | None:
    # L'upload a sauvé le fichier sous file_id + extension d'origine ; on cible ici uniquement STEP/STP.
    candidates = [
        os.path.join(UPLOAD_FOLDER, f"{file_id}.step"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stp"),
        # (on pourrait ajouter un fallback .stl si on autorise l'analyse depuis STL)
    ]
    return _first_existing(candidates)

def _cache_paths(file_id: str, axis: str) -> tuple[str, str]:
    # shape_metrics écrit :
    # - {file_id}.stats.json  (volume_mm3, bbox_mm, thickness_min/max_mm)
    # - {file_id}.proj.{axis}.json (projected_area_cm2)
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    return base, proj

def _read_json(p: str) -> dict:
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)

def _response_from_caches(base_path: str, proj_path: str) -> dict:
    j1 = _read_json(base_path)
    j2 = _read_json(proj_path)
    vol_mm3 = float(j1.get("volume_mm3") or 0.0)
    bbox_mm = j1.get("bbox_mm") or [0.0, 0.0, 0.0]
    return {
        "units": "mm_internal",
        "volume_cm3": round(vol_mm3 / 1000.0, 4),  # 1 cm³ = 1000 mm³
        "projected_area_cm2": round(float(j2.get("projected_area_cm2") or 0.0), 4),
        "thickness_min_mm": round(float(j1.get("thickness_min_mm") or 0.0), 4),
        "thickness_max_mm": round(float(j1.get("thickness_max_mm") or 0.0), 4),
        "bbox_mm": [round(float(x), 4) for x in bbox_mm],
    }

# ---------- API : analyse shape (Option B via worker) ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    """
    Renvoie les métriques géométriques du STEP via un job RQ (worker).
    - Si cache présent : renvoie immédiatement.
    - Sinon : enqueue un job shape_metrics.stats_json(...) et attend quelques secondes
      que le worker écrive le cache, puis renvoie.
    """
    file_id = request.args.get("file_id")
    axis = (request.args.get("axis") or "Z").upper()
    if not file_id:
        return jsonify(error="no_file_id"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    step_path = _step_path_for(file_id)
    if not step_path:
        return jsonify(
            error="not_step_found",
            detail="Analyse disponible uniquement pour un import STEP/STP.",
            file_id=file_id
        ), 400

    base_path, proj_path = _cache_paths(file_id, axis)

    # 1) Cache déjà prêt ?
    if os.path.isfile(base_path) and os.path.isfile(proj_path):
        return jsonify(_response_from_caches(base_path, proj_path))

    # 2) Pas de cache -> envoi au worker
    if q is None:
        return jsonify(error="rq_unavailable",
                       detail="Connexion Redis/RQ non dispo côté web."), 503
    try:
        # IMPORTANT : on référence la fonction par chemin importable (string),
        # pour que le worker l'importe et exécute (le web n'importe pas shape_metrics).
        job = q.enqueue(
            "shape_metrics.stats_json",
            step_path,          # arg 1
            axis,               # arg 2
            OUTPUT_FOLDER,      # kw cache_dir
            file_id,            # kw file_id
            job_timeout=1800,   # gros STEP
            result_ttl=600
        )
    except Exception as e:
        return jsonify(error="enqueue_fail", detail=str(e)), 500

    # 3) Attente raisonnable du cache (poll disque)
    wait_s = env_int("STATS_WAIT_S", 20)  # configurable ; défaut 20s
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if os.path.isfile(base_path) and os.path.isfile(proj_path):
            return jsonify(_response_from_caches(base_path, proj_path))
        time.sleep(0.4)

    # 4) Bonus : si le job a déjà un résultat dict, on le renvoie
    try:
        if job.is_finished and isinstance(job.result, dict):
            return jsonify(job.result)
    except Exception:
        pass

    # 5) Sinon : encore en traitement
    return jsonify(status="processing", file_id=file_id, axis=axis, retryAfterMs=1500)

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
        "redis_url": REDIS_URL,
        "rq_queue": RQ_QUEUE_NAME,
        "rq_connected": bool(q is not None),
    }
    # ping rapide du converter (optionnel)
    try:
        r = requests.get(f"{CONVERTER_URL}/healthz", timeout=2)
        info["converter_health"] = {"ok": (r.status_code == 200), "code": r.status_code}
    except Exception as e:
        info["converter_health"] = {"ok": False, "error": str(e)}
    return jsonify(info)

# --- fin web.py ---
