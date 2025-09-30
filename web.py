# web.py
import os, uuid, pathlib, json, requests, re, glob
from urllib.parse import urlparse, urlunparse, unquote

from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv

# S3 helpers
from s3io import put_file  # utilisé dans /upload

load_dotenv()

# ==== RQ / Redis (connexion légère) ====
import redis
from rq import Queue
from rq.job import Job

# (Optionnel) Épaisseur via converter local (CadQuery/pythonocc). Gardé mais inactif par défaut.
from xkt_converter import compute_thickness_mm_from_step

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

def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")

MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 50)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

CONVERTER_URL = os.environ.get("CONVERTER_URL", "https://cadlytics-converter.onrender.com").rstrip("/")
RQ_TASK_PATH   = os.environ.get("RQ_TASK_PATH", "worker_tasks.compute_and_cache_stats")

ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str: return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool: return _ext(name) in ALLOWED_EXTS

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# ---------- Redis / RQ : normalisation + connexion ----------
def _normalize_redis_url(url: str) -> str:
    if not url:
        return url
    url = str(url).strip().strip('"').strip("'")
    parsed = urlparse(url)
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

_redis: redis.Redis | None = None
q: Queue | None = None
_redis_err: str | None = None
_rq_err: str | None = None

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
        ssl_cert_reqs=None,
        socket_timeout=5,
    )
    _redis.ping()
except Exception as e:
    _redis = None
    _redis_err = repr(e)

if _redis is not None:
    try:
        q = Queue(RQ_QUEUE_NAME, connection=_redis)
        _ = q.count
    except Exception as e:
        q = None
        _rq_err = repr(e)

# ---------- Helpers génériques ----------
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _step_or_stl_path_for(file_id: str) -> str | None:
    return _first_existing([
        os.path.join(UPLOAD_FOLDER, f"{file_id}.step"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stp"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stl"),
    ])

def _step_path_for(file_id: str) -> str | None:
    return _first_existing([
        os.path.join(UPLOAD_FOLDER, f"{file_id}.step"),
        os.path.join(UPLOAD_FOLDER, f"{file_id}.stp"),
    ])

def _cache_paths(file_id: str, axis: str):
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    return base, proj

def _thickness_cache_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.thick.json")

def _read_json(p: str) -> dict:
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)

def _normalize_metrics_dict(raw: dict) -> dict:
    if "volume_cm3" in raw and raw.get("volume_cm3") is not None:
        vol_cm3 = float(raw.get("volume_cm3") or 0.0)
    else:
        vol_mm3 = float(raw.get("volume_mm3") or 0.0)
        vol_cm3 = vol_mm3 / 1000.0
    proj_cm2 = float(raw.get("projected_area_cm2") or 0.0)
    bbox_mm = raw.get("bbox_mm") or raw.get("bbox") or [0.0, 0.0, 0.0]
    def _fix(v):
        try:
            x = float(v or 0.0)
        except Exception:
            return 0.0
        if x > 1000.0: x = x / 1000.0
        return x
    tmin = _fix(raw.get("thickness_min_mm") or raw.get("thickness_min"))
    tmax = _fix(raw.get("thickness_max_mm") or raw.get("thickness_max"))
    return {
        "units": "mm_internal",
        "volume_cm3": round(vol_cm3, 4),
        "projected_area_cm2": round(proj_cm2, 4),
        "thickness_min_mm": round(tmin, 4),
        "thickness_max_mm": round(tmax, 4),
        "bbox_mm": [round(float(x), 4) for x in bbox_mm],
    }

def _response_from_caches(base_path: str, proj_path: str) -> dict:
    j1 = _read_json(base_path)
    j2 = _read_json(proj_path)
    merged = {
        "volume_mm3": j1.get("volume_mm3"),
        "volume_cm3": j1.get("volume_cm3"),
        "bbox_mm": j1.get("bbox_mm"),
        "thickness_min_mm": j1.get("thickness_min_mm"),
        "thickness_max_mm": j1.get("thickness_max_mm"),
        "projected_area_cm2": j2.get("projected_area_cm2"),
    }
    return _normalize_metrics_dict(merged)

def _abs_url(path: str) -> str:
    proto = request.headers.get("X-Forwarded-Proto", request.scheme)
    host  = request.headers.get("X-Forwarded-Host", request.host)
    return f"{proto}://{host}{path}"

# ---------- NEW: pull des artefacts worker depuis S3 -------------------------
def _pull_worker_artifacts_from_s3(file_id: str, axis: str, *, force: bool = False) -> dict:
    """
    Télécharge vers OUTPUT_FOLDER si absent ou si force=True :
      converted/<id>.stats.json      -> {OUTPUT}/{id}.stats.json
      converted/<id>.proj.<axis>.json-> {OUTPUT}/{id}.proj.<axis>.json
      thick/<id>.json                -> {OUTPUT}/{id}.thick.json
    """
    res = {"stats": False, "proj": False, "thick": False}
    if not _s3_enabled():
        return res
    try:
        from s3io import get_file
    except Exception as e:
        app.logger.warning("s3io.get_file indisponible: %s", e)
        return res

    dst = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    if force or not os.path.isfile(dst):
        for key in (f"converted/{file_id}.stats.json", f"shape/{file_id}.stats.json"):
            try:
                if get_file(key, dst):
                    res["stats"] = True; break
            except Exception as e:
                app.logger.warning("S3 get_file fail stats %s: %s", key, e)

    dst = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    if force or not os.path.isfile(dst):
        for key in (f"converted/{file_id}.proj.{axis}.json", f"shape/{file_id}.proj.{axis}.json"):
            try:
                if get_file(key, dst):
                    res["proj"] = True; break
            except Exception as e:
                app.logger.warning("S3 get_file fail proj %s: %s", key, e)

    dst = _thickness_cache_path(file_id)
    if force or not os.path.isfile(dst):
        for key in (f"thick/{file_id}.json", f"converted/{file_id}.thick.json", f"{file_id}.thick.json"):
            try:
                if get_file(key, dst):
                    res["thick"] = True; break
            except Exception as e:
                app.logger.warning("S3 get_file fail thick %s: %s", key, e)
    return res

# ---------- Épaisseur : merge valeurs du worker ------------------------------
def _merge_thickness_from_worker(file_id: str, data: dict, prefer_worker: bool = True) -> dict:
    p = _thickness_cache_path(file_id)
    if os.path.isfile(p):
        try:
            j = _read_json(p)
            tmin, tmax = j.get("tmin"), j.get("tmax")
            if tmin is not None and tmax is not None and float(tmin) > 0 and float(tmax) > 0:
                if prefer_worker or data.get("thickness_source") in (None, "cache", "raycast"):
                    data["thickness_min_mm"] = round(float(tmin), 4)
                    data["thickness_max_mm"] = round(float(tmax), 4)
                    data["thickness_source"] = "worker"
                    data.pop("thickness_warning", None)
        except Exception as e:
            app.logger.warning("[thickness] merge worker file failed: %s", e)
    return data

# ---------- Converter local (optionnel) --------------------------------------
def _ensure_thickness_via_converter(file_id: str, data: dict) -> dict:
    try:
        step_path = _step_path_for(file_id)
        if not step_path or not os.path.isfile(step_path):
            return data
        unit_hint = os.getenv("THICKNESS_UNIT_HINT", "mm")
        ctmin, ctmax = compute_thickness_mm_from_step(step_path, unit_hint=unit_hint)
        if ctmin is None or ctmax is None or not (ctmin == ctmin and ctmax == ctmax):
            data["thickness_warning"] = "converter_returned_nan"
            return data
        data["thickness_min_mm"] = round(float(ctmin), 4)
        data["thickness_max_mm"] = round(float(ctmax), 4)
        data["thickness_source"] = "converter"
        data.pop("thickness_warning", None)
    except Exception as e:
        data["thickness_warning"] = f"{e.__class__.__name__}: {e}"
    return data

# ---------- (Optionnel) ray casting local conservé ---------------------------
def _try_imports_for_thickness():
    reason = None
    try:
        import numpy as _np  # noqa
    except Exception as e:
        reason = f"numpy manquant: {e}"; return False, reason
    try:
        import trimesh as _trimesh  # noqa
    except Exception as e:
        reason = f"trimesh manquant: {e}"; return False, reason
    return True, None

# (les helpers ray casting restent inchangés dans ta base et sont conservés)

# ---------- Pages ------------------------------------------------------------
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

# ---------- Upload -> converter XKT ------------------------------------------
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

    try:
        f.save(in_path)
    except Exception as e:
        return jsonify(error="save_fail", detail=str(e)), 500

    s3_uploaded = False
    s3_key = f"uploads/{file_id}{ext}"
    try:
        ok = put_file(in_path, s3_key)
        s3_uploaded = bool(ok)
        if not s3_uploaded:
            app.logger.warning("S3 put_file returned False for %s", s3_key)
    except Exception as e:
        app.logger.exception("S3 upload failed for %s: %s", s3_key, e)

    try:
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600, stream=True,
                headers={"Accept": "application/octet-stream"},
            )
        if resp.status_code != 200:
            try: detail = resp.json()
            except Exception: detail = resp.text
            return jsonify(error="convert_fail", detail=detail, status_code=resp.status_code), 500

        with open(out_xkt, "wb") as out:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk: out.write(chunk)

        if not os.path.isfile(out_xkt):
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

        try:
            if _s3_enabled():
                put_file(out_xkt, f"xkt/{file_id}.xkt", content_type="application/octet-stream")
        except Exception as e:
            app.logger.warning("S3 upload XKT failed for %s: %s", file_id, e)

        xkt_rel = f"/xkt/{file_id}.xkt"
        xkt_abs = _abs_url(xkt_rel)
        return jsonify(file_id=file_id, status="ready", xktUrl=xkt_abs, xkt_url=xkt_abs, s3_uploaded=s3_uploaded)

    except requests.Timeout:
        return jsonify(error="convert_timeout", detail="Converter timeout (>=600s)"), 504
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

# -- Serve XKT (fallback S3) --------------------------------------------------
@app.get("/xkt/<file_id>.xkt")
def serve_xkt(file_id: str):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return abort(400)
    path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.isfile(path):
        return send_from_directory(OUTPUT_FOLDER, f"{file_id}.xkt",
                                  mimetype="application/octet-stream",
                                  as_attachment=False, max_age=0, etag=False, conditional=False)
    if _s3_enabled():
        try:
            from s3io import get_file
            os.makedirs(OUTPUT_FOLDER, exist_ok=True)
            key = f"xkt/{file_id}.xkt"
            ok = get_file(key, path)
            if ok and os.path.isfile(path):
                return send_from_directory(OUTPUT_FOLDER, f"{file_id}.xkt",
                                          mimetype="application/octet-stream",
                                          as_attachment=False, max_age=0, etag=False, conditional=False)
            app.logger.warning("S3 fallback miss for XKT key=%s", key)
        except Exception as e:
            app.logger.warning("S3 fallback error for XKT %s: %s", file_id, e)
    return abort(404)

# ---------- API analyse : ASYNC ONLY ----------------------------------------
@app.get("/api/shape/stats")
def api_shape_stats():
    """
    - Pull S3 -> caches locaux si besoin
    - Si caches présents -> on répond 200 (merge tmin/tmax worker)
    - Sinon -> enqueue job RQ -> 202
    Aucun calcul lourd local par défaut (THICKNESS_ON_WEB=0).
    """
    import json as _json

    file_id = request.args.get("file_id")
    axis = (request.args.get("axis") or "Z").upper()
    if not file_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return jsonify(error="bad_file_id", detail="file_id doit être un UUID v4"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    base_cache, proj_cache = _cache_paths(file_id, axis)

    # NEW: rapatrier depuis S3 (par défaut force=1 pour éviter les vieux caches)
    _pull_worker_artifacts_from_s3(file_id, axis, force=env_bool("PULL_ALWAYS_FROM_S3", True))

    # 0) caches présents ?
    if os.path.isfile(base_cache) and os.path.isfile(proj_cache):
        try:
            data = _response_from_caches(base_cache, proj_cache)
            data = _merge_thickness_from_worker(file_id, data, prefer_worker=True)

            if env_bool("THICKNESS_ON_WEB", False):
                data = _ensure_thickness_via_converter(file_id, data)
            return jsonify(data)
        except Exception as e:
            return jsonify(error="cache_read_fail", detail=str(e)), 500

    # 1) pas de caches -> worker
    if q is None or _redis is None:
        return jsonify(error="rq_unavailable", detail="Redis/RQ non dispo sur le web service."), 503

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
            _pull_worker_artifacts_from_s3(file_id, axis, force=True)
            if os.path.isfile(base_cache) and os.path.isfile(proj_cache):
                data = _response_from_caches(base_cache, proj_cache)
                data = _merge_thickness_from_worker(file_id, data, prefer_worker=True)
                if env_bool("THICKNESS_ON_WEB", False):
                    data = _ensure_thickness_via_converter(file_id, data)
                return jsonify(data)
            try:
                raw = _redis.get(f"shape_stats:{file_id}:{axis}")
                if raw:
                    data = _normalize_metrics_dict(_json.loads(raw))
                    data = _merge_thickness_from_worker(file_id, data, prefer_worker=True)
                    return jsonify(data)
            except Exception:
                pass
            return jsonify(status="processing", job_id=job_id, retry_in_sec=1), 202
        if st == "failed":
            return jsonify(error="compute_fail", job_id=job_id,
                           status=st, exc=str(job.exc_info) if getattr(job, "exc_info", None) else None), 500

    # 2) enqueue
    step_path = _step_path_for(file_id)
    step_ext = pathlib.Path(step_path).suffix.lstrip(".") if step_path else None
    try:
        q.enqueue(
            RQ_TASK_PATH,
            kwargs={"file_id": file_id, "axis": axis, "step_path": step_path, "step_ext": step_ext, "cache_dir": OUTPUT_FOLDER},
            job_id=job_id, result_ttl=3600, ttl=3600, failure_ttl=3600
        )
        return jsonify(status="queued", job_id=job_id, retry_in_sec=2), 202
    except Exception as e:
        return jsonify(error="enqueue_fail", detail=str(e)), 500

# ---------- Debug / Diag -----------------------------------------------------
@app.get("/__job/<path:job_id>")
def __job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=_redis)
        info = {
            "id": job.id, "status": job.get_status(),
            "enqueued_at": str(job.enqueued_at) if job.enqueued_at else None,
            "started_at": str(job.started_at) if job.started_at else None,
            "ended_at": str(job.ended_at) if job.ended_at else None,
            "result": job.result if hasattr(job, "result") else None,
            "exc_info": job.exc_info if hasattr(job, "exc_info") else None,
        }
        return jsonify(ok=True, **info)
    except Exception as e:
        return jsonify(ok=False, error=str(e), job_id=job_id), 500

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
        "task_path": RQ_TASK_PATH,
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
    s3 = boto3.client(
        "s3",
        region_name=region,
        endpoint_url=endpoint or None,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        config=cfg,
    )

    key = f"__diag/{uuid.uuid4().hex}.txt"

    try:
        s3.head_bucket(Bucket=bucket)
    except ClientError as e:
        err_code = None
        try: err_code = (e.response or {}).get("Error", {}).get("Code")
        except Exception: pass
        return jsonify(ok=False, step="head_bucket", error=str(e), code=err_code)

    try:
        s3.put_object(Bucket=bucket, Key=key, Body=b"ok", ContentType="text/plain")
        obj = s3.get_object(Bucket=bucket, Key=key)
        data = obj["Body"].read()
        s3.delete_object(Bucket=bucket, Key=key)
        return jsonify(ok=(data == b"ok"), region=region, bucket=bucket, key=key)
    except (ClientError, BotoCoreError, Exception) as e:
        err_code = None
        try:
            err_code = getattr(getattr(e, "response", {}), "get", lambda *_: {})("Error", {}).get("Code")
        except Exception:
            pass
        return jsonify(ok=False, step="put/get/delete", error=str(e), code=err_code, bucket=bucket, region=region, key=key)

# ---------- Diag épaisseur vue par le web -----------------------------------
@app.get("/__thick/<file_id>")
def __thick(file_id: str):
    axis = (request.args.get("axis") or "Z").upper()
    pulled = _pull_worker_artifacts_from_s3(file_id, axis, force=False)
    p = _thickness_cache_path(file_id)
    info = {"exists": os.path.isfile(p), "path": p, "pulled": pulled}
    if os.path.isfile(p):
        try:
            info["content"] = _read_json(p)
        except Exception as e:
            info["read_error"] = str(e)
    return jsonify(info)

# --- Maintenance -------------------------------------------------------------
@app.post("/__clear_caches")
def __clear_caches():
    file_id = request.args.get("file_id") or (request.json.get("file_id") if request.is_json else None)
    if not file_id:
        return jsonify(ok=False, error="file_id manquant"), 400
    removed = []
    for p in glob.glob(os.path.join(OUTPUT_FOLDER, f"{file_id}.*")):
        try:
            os.remove(p); removed.append(os.path.basename(p))
        except Exception:
            pass
    return jsonify(ok=True, removed=removed)
