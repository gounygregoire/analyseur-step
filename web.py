# web.py
import os
import uuid
import pathlib
import time
import json
import requests

# RQ / Redis (analyse déléguée au worker)
import redis
from rq import Queue

from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv
load_dotenv()  # charge .env si présent

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

# ---------- Redis / RQ ----------
# Utilise REDIS_URL (ou REDIS_TLS_URL). Laisse un fallback explicite (ton URL).
REDIS_URL = (
    os.environ.get("REDIS_URL")
    or os.environ.get("REDIS_TLS_URL")
    or "redis://default:gISbsmwsGo5RgJtTA9xX9TQknzx0cvD6@redis-12922.c327.europe-west1-2.gce.redns.redis-cloud.com:12922/0"
)
RQ_QUEUE_NAME = os.environ.get("RQ_QUEUE_NAME", "default").strip() or "default"

try:
    _redis = redis.from_url(
        REDIS_URL,
        socket_timeout=5,
        socket_connect_timeout=5,
        retry_on_timeout=True,
        health_check_interval=30,
        ssl=REDIS_URL.startswith("rediss://"),
    )
    _redis.ping()
    q = Queue(RQ_QUEUE_NAME, connection=_redis, default_timeout=600)
    app.logger.info(f"[RQ] Connected. queue='{RQ_QUEUE_NAME}' url='{REDIS_URL}'")
except Exception:
    app.logger.exception("[RQ] init failed")
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

# ---------- Helpers analyse / caches ----------
def _step_path_for(file_id: str) -> str | None:
    # L'upload a sauvé le fichier sous file_id + extension d'origine ; on vise ici STEP/STP.
    candidates = [
        os.path.join(UPLOAD_FOLDER, f"{file_id}.step"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stp"),
    ]
    return _first_existing(candidates)

def _cache_paths(file_id: str, axis: str) -> tuple[str, str]:
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

# ---------- API : analyse shape via worker RQ (worker-only) ----------
from importlib import import_module

@app.get("/api/shape/stats")
def api_shape_stats():
    """
    Enqueue le calcul dans le worker via Redis/RQ :
    - lit le STEP sauvegardé lors de /upload
    - envoie les BYTES au worker (stats_json_from_bytes)
    - attend au plus 90s, sinon renvoie {"status":"processing"}
    Toujours du JSON (jamais de page HTML), donc plus d'erreur "Unexpected token <".
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
            file_id=file_id,
        ), 400

    if not q:
        return jsonify(
            error="rq_unavailable",
            detail="REDIS_URL/RQ_QUEUE_NAME non configurés côté web ou connexion échouée.",
        ), 503

    # Import léger de la fonction util du module de calcul (pas de CadQuery dans le web)
    try:
        sm = import_module("shape_metrics")
        stats_from_bytes = getattr(sm, "stats_json_from_bytes")
    except Exception as e:
        return jsonify(error="import_fail", detail=f"shape_metrics import: {e}"), 500

    # Enqueue + attente raisonnable
    try:
        with open(step_path, "rb") as fh:
            blob = fh.read()

        job = q.enqueue(
            stats_from_bytes,
            kwargs={
                "step_bytes": blob,
                "axis": axis,
                "cache_dir": OUTPUT_FOLDER,
                "file_id": file_id,
            },
            job_timeout=600,
            result_ttl=3600,
            failure_ttl=7200,
        )

        deadline = time.time() + 90.0
        while time.time() < deadline:
            job.refresh()
            st = job.get_status()
            if st == "finished" and job.result:
                return jsonify(job.result)
            if st == "failed":
                return jsonify(error="compute_fail", detail=str(job.exc_info)), 500
            time.sleep(0.5)

        return jsonify(status="processing", job_id=job.get_id())

    except Exception as e:
        return jsonify(error="enqueue_fail", detail=str(e)), 500

# ---------- Diag ----------
@app.get("/__routes")
def __routes():
    lines = [f"{sorted(r.methods)}  {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

@app.get("/__rq")
def __rq():
    info = {
        "queue": RQ_QUEUE_NAME,
        "has_q": bool(q),
        "redis_url_set": bool(REDIS_URL),
    }
    try:
        if q:
            info["queued"] = q.count
            info["is_connected"] = True
            _ = _redis.ping()
        else:
            info["is_connected"] = False
    except Exception as e:
        info["is_connected"] = False
        info["error"] = str(e)
    return jsonify(info)

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
