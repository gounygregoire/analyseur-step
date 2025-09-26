# web.py
import os, uuid, pathlib, json, requests, re, glob, tempfile
from urllib.parse import urlparse, urlunparse, unquote

from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv

# S3 helpers (optionnels, non bloquants)
from s3io import put_file  # utilisé dans /upload

load_dotenv()

# ==== RQ / Redis (connexion légère, SANS calcul local) ====
import redis
from rq import Queue
from rq.job import Job

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

ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str: return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool: return _ext(name) in ALLOWED_EXTS

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

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

# ---------- Helpers génériques ----------
def _s3_enabled() -> bool:
    """Vrai si les 4 variables S3 sont présentes."""
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

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

def _compute_stats_sync_or_error(file_id: str, axis: str, step_path: str):
    """Calcule en local et écrit les caches dans OUTPUT_FOLDER, renvoie le JSON final."""
    from shape_metrics import stats_json as compute_stats_json
    return compute_stats_json(step_path, axis=axis, cache_dir=OUTPUT_FOLDER, file_id=file_id)

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

# ---------- API : upload -> converter XKT ----------
@app.post("/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not _allowed(f.filename):
        return jsonify(error="bad_ext", detail="Formats acceptés : .stl, .step, .stp"), 400

    file_id = str(uuid.uuid4())
    ext = _ext(f.filename) or ".step"
    in_path  = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
    out_xkt  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    # 1) sauvegarde locale
    try:
        f.save(in_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    # 2) tentative d’upload S3 (NON BLOQUANT)
    s3_uploaded = False
    s3_key = f"uploads/{file_id}{ext}"
    try:
        ok = put_file(in_path, s3_key)
        s3_uploaded = bool(ok)
        if not s3_uploaded:
            app.logger.warning("S3 put_file returned False for %s", s3_key)
    except Exception as e:
        # IMPORTANT : on ne bloque pas la conversion pour ça
        app.logger.exception("S3 upload failed for %s: %s", s3_key, e)

    # 3) conversion XKT via le converter (STREAMING pour éviter un pic mémoire)
    try:
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600,
                stream=True,  # <<<<<<<<<< évite de charger tout le XKT en RAM
                headers={"Accept": "application/octet-stream"},
            )

        if resp.status_code != 200:
            # Petit message d'erreur lisible même en mode stream
            try:
                detail = resp.json()
            except Exception:
                # .text suffit, la payload d'erreur est petite
                detail = resp.text
            return jsonify(error="convert_fail", detail=detail, status_code=resp.status_code), 500

        # ÉCRITURE STREAMING
        with open(out_xkt, "wb") as out:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)

        if not os.path.isfile(out_xkt):
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

        # On renvoie aussi s3_uploaded pour que le front sache si l’analyse asynchrone pourra partir
        return jsonify(
            file_id=file_id,
            status="ready",
            xkt_url=f"/xkt/{file_id}.xkt",
            s3_uploaded=s3_uploaded
        )

    except requests.Timeout:
        return jsonify(error="convert_timeout", detail="Converter timeout (>=600s)"), 504
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

# ---------- API analyse : lecture cache / enqueue worker (pas de fallback local) ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    import json as _json
    file_id = request.args.get("file_id")
    axis = (request.args.get("axis") or "Z").upper()
    if not file_id:
        return jsonify(error="no_file_id"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    step_path = _step_path_for(file_id)
    base_cache, proj_cache = _cache_paths(file_id, axis)

    # 1) Caches locaux si dispo
    if os.path.isfile(base_cache) and os.path.isfile(proj_cache):
        try:
            return jsonify(_response_from_caches(base_cache, proj_cache))
        except Exception as e:
            return jsonify(error="cache_read_fail", detail=str(e)), 500

    # 2) Si S3 n'est pas utilisable -> NE PAS calculer sur le web (sauf forçage)
    if not _s3_enabled():
        if os.environ.get("SYNC_METRICS") == "1" and step_path:
            try:
                data = _compute_stats_sync_or_error(file_id, axis, step_path)
                return jsonify(data)
            except Exception as e:
                return jsonify(error="compute_fail", detail=str(e)), 500
        return jsonify(
            error="s3_unavailable",
            detail="S3 indisponible et SYNC_METRICS!=1, calcul non lancé côté web."
        ), 503

    # 3) Mode forcé synchrone (optionnel)
    if os.environ.get("SYNC_METRICS") == "1" and step_path:
        try:
            data = _compute_stats_sync_or_error(file_id, axis, step_path)
            return jsonify(data)
        except Exception as e:
            return jsonify(error="compute_fail", detail=str(e)), 500

    # 4) Sinon RQ (asynchrone) — nécessite Redis OK
    if q is None or _redis is None:
        return jsonify(error="rq_unavailable",
                       detail="REDIS_URL/RQ_QUEUE_NAME non configurés côté web ou connexion échouée."), 503

    job_id = f"shape_stats:{file_id}:{axis}"

    # Existe déjà ?
    try:
        job = Job.fetch(job_id, connection=_redis)
    except Exception:
        job = None

    if job:
        st = (job.get_status() or "").lower()
        if st in ("queued", "started", "deferred"):
            return jsonify(status="processing", job_id=job_id, retry_in_sec=2), 202
        if st == "finished":
            # a) si caches apparus
            if os.path.isfile(base_cache) and os.path.isfile(proj_cache):
                return jsonify(_response_from_caches(base_cache, proj_cache))
            # b) sinon JSON depuis Redis
            try:
                raw = _redis.get(f"shape_stats:{file_id}:{axis}")
                if raw:
                    return jsonify(_json.loads(raw))
            except Exception:
                pass
            # c) sinon on repoll
            return jsonify(status="processing", job_id=job_id, retry_in_sec=1), 202
        if st == "failed":
            # NE PAS relancer un calcul local ici (risque OOM). Le forçage SYNC_METRICS a déjà été géré plus haut.
            return jsonify(error="compute_fail", detail="job failed", job_id=job_id), 500

    # Pas de job -> on en crée un
    try:
        q.enqueue(
            "tasks.compute_and_cache_stats",
            kwargs={
                "file_id": file_id,
                "axis": axis,
                "step_path": step_path,         # peut être None côté worker
                "cache_dir": OUTPUT_FOLDER,     # où écrire les caches
            },
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

@app.get("/__s3_env")
def __s3_env():
    # N'affiche pas les secrets, juste la présence/valeurs utiles
    return jsonify({
        "AWS_ACCESS_KEY_ID_set": bool(os.environ.get("AWS_ACCESS_KEY_ID")),
        "AWS_SECRET_ACCESS_KEY_set": bool(os.environ.get("AWS_SECRET_ACCESS_KEY")),
        "AWS_REGION": os.environ.get("AWS_REGION"),
        "S3_BUCKET": os.environ.get("S3_BUCKET"),
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT"),
        "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE"),
    })

@app.get("/__s3_diag")
def __s3_diag():
    import boto3
    from botocore.client import Config
    from botocore.exceptions import ClientError, BotoCoreError

    bucket = os.environ.get("S3_BUCKET")
    region = os.environ.get("AWS_REGION", "us-east-1")
    endpoint = os.environ.get("S3_ENDPOINT")
    force_ps = os.environ.get("S3_FORCE_PATH_STYLE", "0") == "1"

    if not (os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY") and bucket):
        return jsonify(ok=False, error="Missing env vars (AWS keys / S3_BUCKET).")

    cfg = Config(
        s3={"addressing_style": "path" if force_ps else "virtual"},
        retries={"max_attempts": 3, "mode": "standard"},
        signature_version="s3v4",
    )
    s3 = boto3.client("s3",
        region_name=region,
        endpoint_url=endpoint or None,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        config=cfg
    )

    key = f"__diag/{uuid.uuid4().hex}.txt"
    try:
        # 1) Vérifie l’existence du bucket (HEAD)
        s3.head_bucket(Bucket=bucket)
    except ClientError as e:
        return jsonify(ok=False, step="head_bucket", error=str(e), code=e.response.get("Error",{}).get("Code"))

    try:
        # 2) Put → Get → Delete
        s3.put_object(Bucket=bucket, Key=key, Body=b"ok", ContentType="text/plain")
        obj = s3.get_object(Bucket=bucket, Key=key)
        data = obj["Body"].read()
        s3.delete_object(Bucket=bucket, Key=key)
        return jsonify(ok=(data == b"ok"), region=region, bucket=bucket, key=key)
    except (ClientError, BotoCoreError, Exception) as e:
        code = getattr(getattr(e, "response", {}), "get", lambda *_: None)("Error",{}).get("Code")
        return jsonify(ok=False, step="put/get/delete", error=str(e), code=code, bucket=bucket, region=region, key=key)

@app.get("/__s3_ping")
def __s3_ping():
    key = f"__ping/{uuid.uuid4().hex}.txt"
    tmp = None
    try:
        from s3io import put_file, get_file
        # write temp file
        fd, tmp = tempfile.mkstemp(prefix="s3ping_", suffix=".txt")
        os.write(fd, b"ok")
        os.close(fd)

        # put then get
        put_ok = put_file(tmp, key, content_type="text/plain")
        if not put_ok:
            return jsonify(ok=False, step="put_file returned False", key=key), 500

        # download to another temp path
        fd2, tmp2 = tempfile.mkstemp(prefix="s3ping_dl_", suffix=".txt")
        os.close(fd2)
        get_ok = get_file(key, tmp2)
        if not get_ok:
            return jsonify(ok=False, step="get_file returned False", key=key), 500

        with open(tmp2, "rb") as fh:
            data = fh.read()

        try:
            os.remove(tmp2)
        except Exception:
            pass

        return jsonify(ok=(data == b"ok"), key=key)

    except Exception as e:
        return jsonify(ok=False, error=str(e), key=key), 500
    finally:
        try:
            if tmp and os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass

@app.get("/__xkts")
def __xkts():
    files = sorted(glob.glob(os.path.join(OUTPUT_FOLDER, "*.xkt")))
    return jsonify(count=len(files), files=[os.path.basename(p) for p in files])

# -- Route pour servir les XKT générés localement --
@app.get("/xkt/<file_id>.xkt")
def serve_xkt(file_id: str):
    # sécurité minimale : UUID v4 (simplifié) + .xkt
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return abort(400)
    path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if not os.path.isfile(path):
        return abort(404)
    # IMPORTANT : renvoyer du binaire brut
    return send_from_directory(
        OUTPUT_FOLDER,
        f"{file_id}.xkt",
        mimetype="application/octet-stream",
        as_attachment=False,
        max_age=0,
        etag=False,
        conditional=False,
    )
