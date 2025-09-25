# web.py — mode hybride (inline + worker), S3 pour STEP & caches, Redis TLS
import os, uuid, pathlib, json, requests, mimetypes, tempfile
from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv
from urllib.parse import urlparse, urlunparse, unquote

load_dotenv()

# ==== RQ / Redis ====
import redis
from rq import Queue
from rq.job import Job

# ==== S3 utils (fourni dans s3io.py) ====
from s3io import put_file, get_file, exists as s3_exists

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# ---------- Config ----------
def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if not v:
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

CONVERTER_URL = os.environ.get("CONVERTER_URL", "https://cadlytics-converter.onrender.com").rstrip("/")

# seuil inline (MB). Mettre 0 pour forcer le passage par le worker.
INLINE_MAX_MB = float(os.getenv("INLINE_MAX_MB", "8"))

ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str: return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool: return _ext(name) in ALLOWED_EXTS

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# ---------- Clés S3 ----------
def _s3_step_key(file_id: str, ext: str) -> str:
    return f"uploads/{file_id}.{ext.lstrip('.').lower()}"

def _s3_stats_key(file_id: str) -> str:
    return f"stats/{file_id}.stats.json"

def _s3_proj_key(file_id: str, axis: str) -> str:
    return f"stats/{file_id}.proj.{axis}.json"

# ---------- Redis / RQ : normalisation + connexion (support rediss:// + diag) ----------
def _normalize_redis_url(url: str) -> str:
    """Nettoie l'URL et force TLS (rediss://) pour Redis Cloud si besoin."""
    if not url:
        return url
    url = str(url).strip().strip('"').strip("'")
    parsed = urlparse(url)

    # Redis Cloud exige TLS sur l'endpoint public -> force rediss://
    host = (parsed.hostname or "")
    needs_tls = (
        host.endswith("redis-cloud.com")
        or host.endswith("redns.redis-cloud.com")
        or host.endswith("redns.redis-cloud.com.")
        or (parsed.port == 12922)
    )
    if needs_tls and parsed.scheme.lower() == "redis":
        parsed = parsed._replace(scheme="rediss")

    return urlunparse(parsed)

REDIS_URL = _normalize_redis_url(
    os.environ.get("REDIS_URL")
    or os.environ.get("REDIS_TLS_URL")
    or "redis://localhost:6379/0"
)
RQ_QUEUE_NAME = os.environ.get("RQ_QUEUE_NAME", "default")

# objets globaux + messages d'erreur visibles dans /__rq
_redis: redis.Redis | None = None
q: Queue | None = None
_redis_err: str | None = None
_rq_err: str | None = None

# 1) Connexion Redis (TLS si rediss://)
try:
    parsed = urlparse(REDIS_URL.strip().strip('"').strip("'"))
    use_ssl = (parsed.scheme or "").lower().startswith("rediss")

    _redis = redis.Redis(
        host=parsed.hostname,
        port=parsed.port or 6379,
        username=(parsed.username or "default"),
        password=unquote(parsed.password or ""),
        db=int((parsed.path or "/0").lstrip("/")),
        ssl=use_ssl,
        # on désactive la vérif du certificat pour éviter CERTIFICATE_VERIFY_FAILED
        # si le CA n'est pas installé côté plateforme
        ssl_cert_reqs=None,
        socket_timeout=5,
    )
    _redis.ping()  # test immédiat
except Exception as e:
    _redis = None
    _redis_err = repr(e)

# 2) Création de la Queue RQ (séparée pour diagnostiquer finement)
if _redis is not None:
    try:
        q = Queue(RQ_QUEUE_NAME, connection=_redis)
        _ = q.count  # forcer une commande côté RQ
    except Exception as e:
        q = None
        _rq_err = repr(e)

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

# ---------- Fichiers statiques XKT ----------
@app.get("/xkt/<path:fname>")
def serve_xkt(fname):
    if not fname.endswith(".xkt"):
        abort(404)
    return send_from_directory(OUTPUT_FOLDER, fname, as_attachment=False)

# ---------- Helpers analyse / caches ----------
def _step_path_for(file_id: str) -> str | None:
    return _first_existing([
        os.path.join(UPLOAD_FOLDER, f"{file_id}.step"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stp"),
    ])

def _cache_paths(file_id: str, axis: str):
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
        "volume_cm3": round(vol_mm3 / 1000.0, 4),
        "projected_area_cm2": round(float(j2.get("projected_area_cm2") or 0.0), 4),
        "thickness_min_mm": round(float(j1.get("thickness_min_mm") or 0.0), 4),
        "thickness_max_mm": round(float(j1.get("thickness_max_mm") or 0.0), 4),
        "bbox_mm": [round(float(x), 4) for x in bbox_mm],
    }

def _ensure_caches_local(file_id: str, axis: str):
    """
    Si les caches n'existent pas localement, tente de les rapatrier depuis S3.
    Retourne (ok, base_cache_path, proj_cache_path).
    """
    base, proj = _cache_paths(file_id, axis)
    ok = True
    try:
        if not os.path.isfile(base):
            if s3_exists(_s3_stats_key(file_id)):
                get_file(_s3_stats_key(file_id), base)
            else:
                ok = False
        if not os.path.isfile(proj):
            if s3_exists(_s3_proj_key(file_id, axis)):
                get_file(_s3_proj_key(file_id, axis), proj)
            else:
                ok = False
    except Exception:
        ok = False
    return ok, base, proj

# ---------- API : upload -> S3 + converter XKT ----------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not _allowed(f.filename):
        return jsonify(error="bad_ext", detail="Formats acceptés : .stl, .step, .stp"), 400

    ext = (_ext(f.filename) or ".step").lower().lstrip(".")
    file_id = str(uuid.uuid4())
    in_path  = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
    out_xkt  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    # 1) save local
    try:
        f.save(in_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    # 2) upload STEP → S3 (même si STL, pour historique ; l'analyse ne portera que sur STEP/STP)
    try:
        put_file(in_path, _s3_step_key(file_id, ext),
                 content_type=mimetypes.guess_type(in_path)[0] or "application/octet-stream")
    except Exception as e:
        return jsonify(error="s3_upload_fail", detail=str(e)), 500

    # 3) conversion STEP/STL → XKT via service converter
    try:
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600,
            )
        if resp.status_code != 200:
            detail = resp.text
            try: detail = resp.json()
            except Exception: pass
            return jsonify(error="convert_fail", detail=detail, status_code=resp.status_code), 500

        with open(out_xkt, "wb") as out:
            out.write(resp.content)

        if not os.path.isfile(out_xkt):
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

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

# ---------- API analyse : caches (S3→local), inline petit fichier, sinon RQ ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    """
    1) Tente caches locaux (ou S3 -> local) -> 200
    2) Sinon, si INLINE_MAX_MB > 0 et que le STEP en S3 est <= seuil -> calcule inline (écrit caches + push S3) -> 200
    3) Sinon -> RQ :
         - job inexistant => enqueue -> 202
         - job en cours   => 202
         - job fini       => relit caches (S3->local) ou job.result -> 200/202
    """
    file_id = request.args.get("file_id")
    axis = (request.args.get("axis") or "Z").upper()
    if not file_id:
        return jsonify(error="no_file_id"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    # 0) caches ?
    ok, base_cache, proj_cache = _ensure_caches_local(file_id, axis)
    if ok and os.path.isfile(base_cache) and os.path.isfile(proj_cache):
        try:
            return jsonify(_response_from_caches(base_cache, proj_cache))
        except Exception as e:
            return jsonify(error="cache_read_fail", detail=str(e)), 500

    # 1) décider .step ou .stp à partir de S3
    step_ext = "step"
    try:
        if not s3_exists(_s3_step_key(file_id, step_ext)):
            step_ext = "stp"
            if not s3_exists(_s3_step_key(file_id, step_ext)):
                return jsonify(error="not_step_found",
                               detail="Analyse disponible uniquement pour STEP/STP (fichier introuvable en S3).",
                               file_id=file_id), 400
    except Exception as e:
        return jsonify(error="s3_not_configured", detail=str(e)), 500

    # 2) Inline si petit fichier
    if INLINE_MAX_MB > 0:
        tmp = tempfile.mktemp(suffix=f".{step_ext}")
        try:
            if get_file(_s3_step_key(file_id, step_ext), tmp):
                size_mb = os.path.getsize(tmp) / (1024 * 1024)
                if size_mb <= INLINE_MAX_MB:
                    # import local pour éviter de charger les libs lourdes si on ne fait pas d'inline
                    from shape_metrics import stats_json as compute_stats_json
                    data = compute_stats_json(tmp, axis=axis, cache_dir=OUTPUT_FOLDER, file_id=file_id)
                    # pousse caches en S3 pour les prochains appels
                    base_cache, proj_cache = _cache_paths(file_id, axis)
                    try:
                        put_file(base_cache, _s3_stats_key(file_id), content_type="application/json")
                        put_file(proj_cache, _s3_proj_key(file_id, axis), content_type="application/json")
                    except Exception:
                        pass
                    # réponse finale
                    return jsonify({
                        "units": "mm_internal",
                        "volume_cm3": round(float(data.get("volume_cm3", 0.0)), 4),
                        "projected_area_cm2": round(float(data.get("projected_area_cm2", 0.0)), 4),
                        "thickness_min_mm": round(float(data.get("thickness_min_mm", 0.0)), 4),
                        "thickness_max_mm": round(float(data.get("thickness_max_mm", 0.0)), 4),
                        "bbox_mm": [round(float(x), 4) for x in (data.get("bbox_mm") or [0, 0, 0])],
                    })
        except Exception as e:
            return jsonify(error="compute_fail", detail=str(e)), 500
        finally:
            try: os.remove(tmp)
            except Exception: pass

    # 3) Worker RQ
    if q is None or _redis is None:
        return jsonify(error="rq_unavailable",
                       detail="REDIS_URL/RQ_QUEUE_NAME non configurés côté web ou connexion échouée."), 503

    job_id = f"shape_stats:{file_id}:{axis}"
    try:
        job = Job.fetch(job_id, connection=_redis)
    except Exception:
        job = None

    if job:
        st = (job.get_status() or "").lower()
        if st in ("queued", "started", "deferred"):
            return jsonify(status="processing", job_id=job_id, retry_in_sec=2), 202
        if st == "finished":
            # le worker a dû pousser les caches en S3 → retente fetch S3->local
            ok, base_cache, proj_cache = _ensure_caches_local(file_id, axis)
            if ok and os.path.isfile(base_cache) and os.path.isfile(proj_cache):
                return jsonify(_response_from_caches(base_cache, proj_cache))
            # sinon, tenter job.result
            try:
                res = job.result
                if isinstance(res, dict) and "volume_cm3" in res:
                    return jsonify(res)
            except Exception:
                pass
            # pas encore prêt
            return jsonify(status="processing", job_id=job_id, retry_in_sec=2), 202
        if st == "failed":
            return jsonify(error="compute_fail", detail="job failed", job_id=job_id), 500

    # Pas de job -> enqueue (le worker téléchargera le STEP depuis S3)
    try:
        q.enqueue(
            "tasks.compute_and_cache_stats",
            kwargs={"file_id": file_id, "axis": axis, "step_ext": step_ext},
            job_id=job_id,
            result_ttl=3600, ttl=3600, failure_ttl=3600
        )
        return jsonify(status="queued", job_id=job_id, retry_in_sec=2), 202
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
        "redis_url_set": bool(REDIS_URL),
        "queue": RQ_QUEUE_NAME,
        "has_q": bool(q is not None),
        "is_connected": bool(_redis is not None),
        "probe_ok": False,
        "redis_error": _redis_err,
        "rq_error": _rq_err,
    }
    try:
        if _redis is not None:
            _redis.setex("rq_probe", 5, "ok")
            info["probe_ok"] = (_redis.get("rq_probe") == b"ok")
    except Exception as e:
        info["rq_probe_error"] = repr(e)
    return jsonify(info)

@app.get("/__diag")
def __diag():
    info = {
        "cwd": os.getcwd(),
        "UPLOAD_FOLDER": UPLOAD_FOLDER,
        "OUTPUT_FOLDER": OUTPUT_FOLDER,
        "MAX_UPLOAD_MB": MAX_UPLOAD_MB,
        "INLINE_MAX_MB": INLINE_MAX_MB,
        "converter_url": CONVERTER_URL,
        "redis_url": REDIS_URL,
        "rq_queue": RQ_QUEUE_NAME,
        "rq_connected": bool(q is not None),
    }
    try:
        r = requests.get(f"{CONVERTER_URL}/healthz", timeout=2)
        info["converter_health"] = {"ok": (r.status_code == 200), "code": r.status_code}
    except Exception as e:
        info["converter_health"] = {"ok": False, "error": str(e)}
    return jsonify(info)
