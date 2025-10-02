# web.py
import os, uuid, pathlib, json, requests, re, glob, socket
from urllib.parse import urlparse, urlunparse, unquote

from flask import Flask, request, jsonify, send_from_directory, abort, render_template
from flask_cors import CORS
from dotenv import load_dotenv
import requests, mimetypes
from pathlib import Path

# S3 helpers
from s3io import put_file  # utilisé pour les XKT (upload)

# (Optionnel) converter local — ignoré s'il n'est pas présent ou incomplet
try:
    from xkt_converter import compute_thickness_mm_from_step  # type: ignore
except Exception:
    compute_thickness_mm_from_step = None  # désactive le chemin local

load_dotenv()

# ==== RQ / Redis ====
import redis
from rq import Queue, Worker
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

def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")

MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 50)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# Timeout RQ appliqué aux jobs (en secondes)
RQ_JOB_TIMEOUT_SEC = env_int("RQ_JOB_TIMEOUT_SEC", 1200)  # 20 min par défaut

CONVERTER_URL = os.environ.get("CONVERTER_URL", "https://cadlytics-converter.onrender.com").rstrip("/")
RQ_TASK_PATH = os.environ.get("RQ_TASK_PATH", "worker_tasks.compute_and_cache_stats")

# Pull des caches depuis S3 si absents localement (recommandé en multi-instance)
PULL_CONVERTED_FROM_S3 = env_bool("PULL_CONVERTED_FROM_S3", True)

ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str: return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool: return _ext(name) in ALLOWED_EXTS

# Upload / output folders (defaults et création)
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

# ---------- Redis / RQ ----------
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

# ---------- S3 helpers ----------
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _s3_get(key: str, dest_path: str) -> bool:
    if not _s3_enabled():
        return False
    try:
        from s3io import get_file
        ok = get_file(key, dest_path)
        return bool(ok and os.path.isfile(dest_path))
    except Exception as e:
        app.logger.warning("[web] S3 get_file failed key=%s: %s", key, e)
        return False

# ---------- Helpers métriques ----------
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

    def _fix_thick(v):
        try:
            x = float(v or 0.0)
        except Exception:
            return 0.0
        if x > 1000.0:
            x = x / 1000.0
        return x

    tmin = _fix_thick(raw.get("thickness_min_mm") or raw.get("thickness_min"))
    tmax = _fix_thick(raw.get("thickness_max_mm") or raw.get("thickness_max"))

    return {
        "units": "mm_internal",
        "volume_cm3": round(vol_cm3, 4),
        "projected_area_cm2": round(proj_cm2, 4),
        "thickness_min_mm": round(tmin, 4),
        "thickness_max_mm": round(tmax, 4),
        "bbox_mm": [round(float(x), 4) for x in bbox_mm],
        "status": "ok",
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

# ---------- Merge épaisseur worker ----------
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
                    data["thickness_source"] = str(j.get("method") or "worker")
                    data.pop("thickness_warning", None)
        except Exception as e:
            app.logger.warning("[thickness] merge worker file failed: %s", e)
    return data

# ---------- Converter local (optionnel) ----------
def _step_path_for(file_id: str) -> str | None:
    for ext in (".step", ".stp"):
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
        if os.path.isfile(p):
            return p
    return None

def _ensure_thickness_via_converter(file_id: str, data: dict) -> dict:
    if compute_thickness_mm_from_step is None:
        return data
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

# ---------- Pull S3 des caches converted/* ----------
def _pull_converted_from_s3_if_missing(file_id: str, axis: str) -> dict:
    """Essaie de rapatrier depuis S3 si absent localement. Renvoie {base_ok, proj_ok, thick_ok}."""
    res = {"base_ok": False, "proj_ok": False, "thick_ok": False}
    if not (_s3_enabled() and PULL_CONVERTED_FROM_S3):
        return res
    base, proj = _cache_paths(file_id, axis)
    thick = _thickness_cache_path(file_id)
    try:
        if not os.path.isfile(base):
            res["base_ok"]  = _s3_get(f"converted/{file_id}.stats.json", base)
        else:
            res["base_ok"]  = True
        if not os.path.isfile(proj):
            res["proj_ok"]  = _s3_get(f"converted/{file_id}.proj.{axis}.json", proj)
        else:
            res["proj_ok"]  = True
        if not os.path.isfile(thick):
            res["thick_ok"] = _s3_get(f"converted/{file_id}.thick.json", thick)
        else:
            res["thick_ok"] = True
    except Exception as e:
        app.logger.warning("[web] pull S3 error: %s", e)
    return res

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

# ---------- Upload -> XKT ----------
@app.post("/upload")
def upload():
    try:
        from s3io import put_file  # ok même si S3 désactivé
    except Exception:
        put_file = None

    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no_file"), 400
    if not _allowed(f.filename):
        return jsonify(error="bad_ext", detail="Formats acceptés : .stl, .step, .stp"), 400

    file_id = str(uuid.uuid4())
    ext = (_ext(f.filename) or ".step").lower()
    if ext == ".stp":
        ext = ".step"

    in_path  = os.path.join(UPLOAD_FOLDER, f"{file_id}{ext}")
    out_xkt  = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    # 1) save original locally
    try:
        f.save(in_path)
    except Exception as e:
        app.logger.exception("[upload] save_fail: %s", e)
        return jsonify(error="save_fail", detail=str(e)), 500

    # 2) optional S3 upload of original
    s3_uploaded_src = False
    try:
        if _s3_enabled() and put_file:
            if ext == ".step":
                src_ct = "model/step"
            elif ext == ".stl":
                src_ct = "model/stl"
            else:
                src_ct = f.mimetype or "application/octet-stream"
            ok = put_file(in_path, f"uploads/{file_id}{ext}", content_type=src_ct)
            s3_uploaded_src = bool(ok)
            if not s3_uploaded_src:
                app.logger.warning("[upload] S3 put returned False for uploads/%s%s", file_id, ext)
    except Exception as e:
        app.logger.warning("[upload] S3 upload (src) failed: %s", e)

    # 3) call converter → XKT
    conv_url = os.getenv("CONVERTER_URL", "").rstrip("/")
    if not conv_url:
        app.logger.error("[upload] CONVERTER_URL is not set")
        return jsonify(error="convert_fail", detail="CONVERTER_URL not set"), 500

    try:
        send_ct = "model/step" if ext == ".step" else ("model/stl" if ext == ".stl" else f.mimetype or "application/octet-stream")
        app.logger.info("[upload] sending to converter %s (in_path=%s, out_xkt=%s)", conv_url, in_path, out_xkt)

        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{conv_url}/convert",
                files={"file": (Path(in_path).name, fh, send_ct)},
                timeout=600,
                stream=True,
                headers={"Accept": "application/octet-stream"},
            )

        app.logger.info("[upload] converter status=%s file_id=%s", resp.status_code, file_id)
        if resp.status_code != 200:
            try:
                detail = resp.json()
            except Exception:
                detail = (resp.text or "")[:1000]
            return jsonify(error="convert_fail", status_code=resp.status_code, detail=detail), 500

        with open(out_xkt, "wb") as out:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)
        if not os.path.isfile(out_xkt):
            app.logger.error("[upload] no .xkt produced at %s", out_xkt)
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

    except requests.Timeout:
        app.logger.exception("[upload] converter timeout file_id=%s", file_id)
        return jsonify(error="convert_timeout", detail="Converter timeout (>=600s)"), 504
    except Exception as e:
        app.logger.exception("[upload] unexpected converter error: %s", e)
        return jsonify(error="convert_fail", detail=str(e)), 500

    # 4) optional S3 upload of XKT (for CDN)
    s3_uploaded_xkt = False
    try:
        if _s3_enabled() and put_file:
            put_file(out_xkt, f"xkt/{file_id}.xkt", content_type="application/octet-stream")
            s3_uploaded_xkt = True
    except Exception as e:
        app.logger.warning("[upload] S3 upload XKT failed for %s: %s", file_id, e)

    # 5) optional warm RQ stats job
    warm_job_id = None
    if os.getenv("WARM_STATS_ON_UPLOAD", "0").lower() in ("1", "true", "yes", "on"):
        try:
            from rq import Queue
            from redis import from_url as _rfromurl
            rurl = _normalize_redis_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
            qq = Queue(os.getenv("RQ_QUEUE_NAME", "default"), connection=_rfromurl(rurl, ssl_cert_reqs=None))
            job_timeout = int(os.getenv("RQ_JOB_TIMEOUT_SEC", "1200"))
            job = qq.enqueue(
                "worker_tasks.compute_and_cache_stats",
                kwargs=dict(file_id=file_id, axis="Z", step_path=None, step_ext=ext.lstrip("."), cache_dir=OUTPUT_FOLDER),
                job_timeout=job_timeout, result_ttl=3600, failure_ttl=3600, ttl=job_timeout,
            )
            warm_job_id = job.id
            app.logger.info("[upload] warm stats enqueued job_id=%s", warm_job_id)
        except Exception as e:
            app.logger.info("[upload] warm stats skipped: %s", e)

    xkt_rel = f"/xkt/{file_id}.xkt"
    xkt_abs = _abs_url(xkt_rel)
    return jsonify(
        file_id=file_id,
        status="ready",
        xktUrl=xkt_abs,
        xkt_url=xkt_abs,
        s3_uploaded_src=s3_uploaded_src,
        s3_uploaded_xkt=s3_uploaded_xkt,
        warm_job_id=warm_job_id,
    )

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

# ---------- Helper: lecture stats depuis Redis (clé publiée par le worker) ----------
def _read_stats_from_redis(file_id: str, axis: str):
    if not _redis:
        return None
    try:
        raw = _redis.get(f"shape_stats:{file_id}:{axis}")
        if not raw:
            return None
        data = json.loads(raw.decode("utf-8"))
        # structure minimale, normalisée pour l'UI
        norm = {
            "volume_mm3": data.get("volume_mm3"),
            "volume_cm3": (float(data.get("volume_mm3") or 0) / 1000.0) if data.get("volume_cm3") is None else data.get("volume_cm3"),
            "bbox_mm": data.get("bbox_mm"),
            "thickness_min_mm": data.get("thickness_min_mm"),
            "thickness_max_mm": data.get("thickness_max_mm"),
            "projected_area_cm2": data.get("projected_area_cm2"),
        }
        return _normalize_metrics_dict(norm)
    except Exception as e:
        app.logger.info("[stats] Redis read error: %s", e)
        return None

# ---------- API analyse (fallback Redis + S3 + RQ) ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    """
    Ordre:
      1) Caches locaux (stats.json + proj.json) -> OK
      2) Redis (clé shape_stats:<fid>:<axis>)      -> OK
      3) S3 converted/* (si activé)                -> OK
      4) Enfile un job RQ et renvoie 202 (queued/processing)
    """
    file_id = request.args.get("file_id", "").strip()
    axis = (request.args.get("axis") or "Z").upper()
    recompute = (request.args.get("recompute") or "0").lower() in ("1", "true", "yes", "on")

    if not file_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return jsonify(error="bad_file_id", detail="file_id doit être un UUID v4"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    base_cache, proj_cache = _cache_paths(file_id, axis)

    # Recompute -> purge locale et on force un nouveau job_id
    if recompute:
        for p in glob.glob(os.path.join(OUTPUT_FOLDER, f"{file_id}.*")):
            try: os.remove(p)
            except Exception: pass

    # 1) caches locaux ?
    if (not recompute) and os.path.isfile(base_cache) and os.path.isfile(proj_cache):
        try:
            data = _response_from_caches(base_cache, proj_cache)
            data = _merge_thickness_from_worker(file_id, data, prefer_worker=True)
            if env_bool("THICKNESS_ON_WEB", False):
                data = _ensure_thickness_via_converter(file_id, data)
            return jsonify(data)
        except Exception as e:
            return jsonify(error="cache_read_fail", detail=str(e)), 500

    # 2) Redis fallback immédiat ?
    if not recompute:
        rj = _read_stats_from_redis(file_id, axis)
        if rj:
            rj = _merge_thickness_from_worker(file_id, rj, prefer_worker=True)
            if env_bool("THICKNESS_ON_WEB", False):
                rj = _ensure_thickness_via_converter(file_id, rj)
            return jsonify(rj)

    # 3) S3 -> local -> lecture
    if (not recompute):
        pulled = _pull_converted_from_s3_if_missing(file_id, axis)
        if (pulled.get("base_ok") and pulled.get("proj_ok")
            and os.path.isfile(base_cache) and os.path.isfile(proj_cache)):
            try:
                data = _response_from_caches(base_cache, proj_cache)
                data = _merge_thickness_from_worker(file_id, data, prefer_worker=True)
                if env_bool("THICKNESS_ON_WEB", False):
                    data = _ensure_thickness_via_converter(file_id, data)
                return jsonify(data)
            except Exception as e:
                return jsonify(error="cache_read_fail", detail=f"after_s3: {e}"), 500

    # 4) Enqueue job RQ
    if q is None or _redis is None:
        return jsonify(error="rq_unavailable", detail="Redis/RQ non dispo sur le web service."), 503

    job_base = f"shape_stats:{file_id}:{axis}"
    job_id = job_base if not recompute else f"{job_base}:{uuid.uuid4().hex[:8]}"

    # Si un job identique existe déjà et qu'on n'est pas en recompute → 202 processing
    if not recompute:
        try:
            job = Job.fetch(job_id, connection=_redis)
        except Exception:
            job = None
        if job:
            st = (job.get_status() or "").lower()
            if st in ("queued", "started", "deferred"):
                return jsonify(status="processing", job_id=job_id, retry_in_sec=2), 202
            if st == "finished":
                # Dernière chance: lecture Redis (si présent)
                rj = _read_stats_from_redis(file_id, axis)
                if rj:
                    rj = _merge_thickness_from_worker(file_id, rj, prefer_worker=True)
                    if env_bool("THICKNESS_ON_WEB", False):
                        rj = _ensure_thickness_via_converter(file_id, rj)
                    return jsonify(rj)

    try:
        step_path = _step_path_for(file_id)  # facultatif (si upload local)
        step_ext = pathlib.Path(step_path).suffix.lstrip(".") if step_path else None

        q.enqueue(
            RQ_TASK_PATH,
            kwargs={
                "file_id": file_id,
                "axis": axis,
                "step_path": step_path,
                "step_ext": step_ext,
                "cache_dir": OUTPUT_FOLDER,
            },
            job_id=job_id,
            job_timeout=RQ_JOB_TIMEOUT_SEC,
            result_ttl=3600, ttl=3600, failure_ttl=3600
        )
        return jsonify(status="queued", job_id=job_id, retry_in_sec=2), 202
    except Exception as e:
        return jsonify(error="enqueue_fail", detail=str(e)), 500

# ---------- Estimation raycast pour l'API /api/shape/thickness ----------
def _estimate_thickness_mm_from_mesh(mesh, samples=30000, eps_factor=1e-5, outlier_pct=0.1, backface_dot=-0.3):
    import numpy as np
    import trimesh

    if not isinstance(mesh, trimesh.Trimesh):
        return None, None

    try: mesh.fix_normals()
    except Exception: pass
    mesh.remove_unreferenced_vertices()
    mesh.remove_degenerate_faces()
    try:
        if not mesh.is_watertight:
            mesh = mesh.fill_holes()
    except Exception:
        pass

    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector
        inter = RayMeshIntersector(mesh)
    except Exception:
        from trimesh.ray.ray_triangle import RayMeshIntersector
        inter = RayMeshIntersector(mesh)

    try:
        pts, f_idx = trimesh.sample.sample_surface_even(mesh, samples)
    except Exception:
        pts, f_idx = mesh.sample(samples, return_index=True)

    n = mesh.face_normals[f_idx]

    bb = mesh.bounds
    diag = float(np.linalg.norm(bb[1] - bb[0]))
    eps = max(diag * eps_factor, 1e-6)

    origins_p = pts + n * eps
    origins_m = pts - n * eps

    loc_p, ir_p, it_p = inter.intersects_location(origins_p,  n, multiple_hits=False)
    loc_m, ir_m, it_m = inter.intersects_location(origins_m, -n, multiple_hits=False)

    dist = np.full(len(pts), np.inf)

    if len(ir_p):
        d = np.linalg.norm(loc_p - origins_p[ir_p], axis=1)
        nf = mesh.face_normals[it_p]
        good = (np.einsum("ij,ij->i", nf, n[ir_p]) < backface_dot)
        d[~good] = np.inf
        dist[ir_p] = np.minimum(dist[ir_p], d)

    if len(ir_m):
        d = np.linalg.norm(loc_m - origins_m[ir_m], axis=1)
        nf = mesh.face_normals[it_m]
        good = (np.einsum("ij,ij->i", nf, -n[ir_m]) < backface_dot)
        d[~good] = np.inf
        dist[ir_m] = np.minimum(dist[ir_m], d)

    d = dist[np.isfinite(dist)]
    d = d[d > eps * 10]
    if d.size == 0:
        return None, None

    if 0.0 < outlier_pct < 5.0:
        lo = np.percentile(d, outlier_pct)
        hi = np.percentile(d, 100.0 - outlier_pct)
        d = d[(d >= lo) & (d <= hi)]

    tmin = float(d.min())
    tmax = float(np.percentile(d, 99.9))
    tmax = min(tmax, float(min(mesh.extents)))
    return tmin, tmax

# ---------- Calcul épaisseur locale (optionnel) ----------
def compute_thickness_mm_from_occ_shape(
    shape,
    unit_hint: str | None = "mm",
    tol_lin_mm: float | None = None,
    ang_rad: float | None = None,
    samples: int | None = None,
) -> tuple[float | None, float | None]:
    try:
        import numpy as np
        import trimesh
        from OCC.Core.BRep import BRep_Tool
        from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
        from OCC.Core.TopExp import TopExp_Explorer
        from OCC.Core.TopAbs import TopAbs_FACE
    except ImportError as e:
        raise ImportError("pythonocc-core + trimesh requis") from e

    uh = (unit_hint or "mm").strip().lower()
    unit_scale_mm = {"mm": 1.0, "millimeter": 1.0, "millimetre": 1.0,
                     "cm": 10.0, "centimeter": 10.0, "centimetre": 10.0,
                     "m": 1000.0, "meter": 1000.0, "metre": 1000.0,
                     "in": 25.4, "inch": 25.4, "inches": 25.4}.get(uh, 1.0)

    tol = float(os.getenv("TESSELLATION_TOL_MM", "0.05")) if tol_lin_mm is None else float(tol_lin_mm)
    ang = float(os.getenv("TESSELLATION_ANG_RAD", "0.25")) if ang_rad is None else float(ang_rad)

    try:
        BRepMesh_IncrementalMesh(shape, tol * unit_scale_mm, False, ang, True)
    except Exception:
        BRepMesh_IncrementalMesh(shape, max(tol * unit_scale_mm, 0.5), False, max(ang, 0.5), True)

    verts: list[list[float]] = []
    faces: list[list[int]] = []
    v_off = 0

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        f = exp.Current()
        loc = f.Location()
        tri = BRep_Tool.Triangulation(f, loc)
        if tri is not None:
            nodes = tri.Nodes()
            tris  = tri.Triangles()
            npts  = nodes.Size()
            ntri  = tris.Size()

            for i in range(1, npts + 1):
                p = nodes.Value(i)
                verts.append([float(p.X()) * unit_scale_mm,
                              float(p.Y()) * unit_scale_mm,
                              float(p.Z()) * unit_scale_mm])

            for i in range(1, ntri + 1):
                t = tris.Value(i)
                a, b, c = t.Get()
                faces.append([v_off + a - 1, v_off + b - 1, v_off + c - 1])

            v_off += npts
        exp.Next()

    if not verts or not faces:
        raise RuntimeError("Triangulation OCC vide")

    mesh = trimesh.Trimesh(vertices=np.asarray(verts, dtype=float),
                           faces=np.asarray(faces, dtype=int),
                           process=True)

    if mesh.is_empty:
        raise RuntimeError("Mesh vide après triangulation")
    try:
        if not mesh.is_watertight:
            mesh = mesh.fill_holes()
    except Exception:
        pass

    if samples is None:
        samples = int(os.getenv("THICKNESS_SAMPLES", "30000"))

    tmin, tmax = _estimate_thickness_mm_from_mesh(mesh, samples=samples)
    if tmin is None or tmax is None:
        return None, None
    return round(float(tmin), 4), round(float(tmax), 4)

# ---------- API épaisseur (optionnel) ----------
@app.get("/api/shape/thickness")
def api_shape_thickness():
    if not env_bool("THICKNESS_ON_WEB", False):
        return jsonify(error="disabled", detail="THICKNESS_ON_WEB=0"), 403

    file_id = request.args.get("file_id")
    if not file_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return jsonify(error="bad_file_id", detail="file_id doit être un UUID v4"), 400

    step_path = _step_path_for(file_id)
    if not step_path or not os.path.isfile(step_path):
        return jsonify(error="no_step", detail="Fichier STEP introuvable"), 404

    try:
        from OCC.Core.STEPControl import STEPControl_Reader
        from OCC.Core.IFSelect import IFSelect_RetDone

        reader = STEPControl_Reader()
        if reader.ReadFile(step_path) != IFSelect_RetDone:
            return jsonify(error="step_read_fail"), 500
        if not reader.TransferRoots():
            return jsonify(error="step_transfer_fail"), 500
        shape = reader.OneShape()

        tmin, tmax = compute_thickness_mm_from_occ_shape(
            shape,
            unit_hint=os.getenv("THICKNESS_UNIT_HINT", "mm"),
            tol_lin_mm=float(os.getenv("THICK_LIN_DEF_MM", os.getenv("TESSELLATION_TOL_MM", "0.05"))),
            ang_rad=float(os.getenv("THICK_ANG_DEF_RAD", os.getenv("TESSELLATION_ANG_RAD", "0.25"))),
            samples=env_int("THICKNESS_SAMPLES", 30000),
        )
        if tmin is None or tmax is None:
            return jsonify(error="thickness_compute_fail"), 500

        thick_cache = _thickness_cache_path(file_id)
        try:
            with open(thick_cache, "w", encoding="utf-8") as fh:
                json.dump({"tmin": tmin, "tmax": tmax, "method": "occ_raycast"}, fh)
        except Exception as e:
            app.logger.warning("write thick cache failed %s: %s", thick_cache, e)

        return jsonify(thickness_min_mm=tmin, thickness_max_mm=tmax, thickness_source="occ_raycast")

    except ImportError:
        return jsonify(error="missing_dependency", detail="pythonocc-core + trimesh requis"), 501
    except Exception as e:
        return jsonify(error="thickness_exception", detail=str(e)), 500

# ---------- Debug ----------
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

# --- RQ: liste des workers connectés ---
@app.get("/__rq_workers")
def __rq_workers():
    try:
        workers = []
        if _redis is not None:
            for w in Worker.all(connection=_redis):
                workers.append({
                    "name": w.name,
                    "state": w.get_state(),
                    "queues": [q.name for q in w.queues],
                    "current_job_id": getattr(w, "get_current_job_id", lambda: None)()
                })
        return jsonify(ok=True, queue=RQ_QUEUE_NAME, workers=workers)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

# --- RQ: contenu de la queue ---
@app.get("/__rq_queue")
def __rq_queue():
    if q is None:
        return jsonify(ok=False, error="no queue"), 503
    try:
        jobs = [j.id for j in q.jobs]
        return jsonify(ok=True, queue=RQ_QUEUE_NAME, count=len(jobs), jobs=jobs)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

# --- RQ: ping ---
@app.get("/__worker_ping")
def __worker_ping():
    if q is None:
        return jsonify(ok=False, error="no queue"), 503
    job_id = f"ping:{uuid.uuid4().hex}"
    try:
        q.enqueue("worker_tasks.ping", kwargs={"payload": "ok"}, job_id=job_id,
                  result_ttl=120, ttl=120, failure_ttl=120)
        return jsonify(ok=True, job_id=job_id)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

@app.get("/__routes")
def __routes():
    lines = [f"{sorted(r.methods)}  {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

@app.get("/__rq")
def __rq():
    info = {
        "redis_url_set": bool(REDIS_URL), "queue": RQ_QUEUE_NAME,
        "has_q": bool(q is not None), "is_connected": bool(_redis is not None),
        "probe_ok": False, "redis_error": _redis_err, "rq_error": _rq_err,
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
        "host": socket.gethostname(),
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
        "PULL_CONVERTED_FROM_S3": PULL_CONVERTED_FROM_S3,
    })

# Voir la présence des fichiers cache/thickness
@app.get("/__thick/<file_id>")
def __thick(file_id: str):
    p = _thickness_cache_path(file_id)
    if os.path.isfile(p):
        try:
            return jsonify(ok=True, path=p, data=_read_json(p))
        except Exception as e:
            return jsonify(ok=False, error=str(e), path=p), 500
    return jsonify(ok=False, error="not_found", path=p), 404

@app.get("/__list_caches/<file_id>")
def __list_caches(file_id: str):
    glob_pat = os.path.join(OUTPUT_FOLDER, f"{file_id}.*")
    matches = [os.path.basename(x) for x in glob.glob(glob_pat)]
    return jsonify(ok=True, folder=OUTPUT_FOLDER, files=sorted(matches))

# Purge simple
@app.post("/__clear_caches")
def __clear_caches():
    file_id = request.args.get("file_id") or (request.json.get("file_id") if request.is_json else None)
    if not file_id:
        return jsonify(ok=False, error="file_id manquant"), 400
    removed = []
    for p in glob.glob(os.path.join(OUTPUT_FOLDER, f"{file_id}.*")):
        try:
            os.remove(p)
            removed.append(os.path.basename(p))
        except Exception:
            pass
    return jsonify(ok=True, removed=removed)
