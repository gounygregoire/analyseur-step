# web.py
from __future__ import annotations

import os, uuid, pathlib, json, re, glob, socket, time, subprocess, mimetypes
import logging
from urllib.parse import urlparse, urlunparse, unquote
from pathlib import Path
import boto3
import botocore

from flask import (
    Flask,
    request,
    jsonify,
    make_response,
    send_from_directory,
    abort,
    render_template,
    redirect,
    url_for,
)
from flask_cors import CORS
from dotenv import load_dotenv
import requests

# RQ / Redis (imports sans collision de noms)
import redis as redislib
from redis import from_url as redis_from_url
from rq import Queue, Worker
from rq.job import Job
from rq.registry import StartedJobRegistry, FailedJobRegistry

# Conversion locale (utilisée par /reconvert)
from converter import (
    convert_step_to_xkt as _convert_step_to_xkt_local,
    KNOWN_BAD_XKT_BYTES,
)

# (Optionnel) converter local — ignoré s'il n'est pas présent ou incomplet
try:
    from xkt_converter import compute_thickness_mm_from_step  # type: ignore
except Exception:
    compute_thickness_mm_from_step = None  # désactive le chemin local

load_dotenv()

S3_BUCKET = os.environ.get("S3_BUCKET", "")
S3_REGION = os.environ.get("S3_REGION", "eu-west-3")
s3 = boto3.client("s3", region_name=S3_REGION)
s3_client = s3

logger = logging.getLogger(__name__)

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

# Timeouts globaux
RQ_JOB_TIMEOUT_SEC       = env_int("RQ_JOB_TIMEOUT_SEC", 1200)  # 20 min
HTTP_CONNECT_TIMEOUT_SEC = env_int("HTTP_CONNECT_TIMEOUT_SEC", 10)
HTTP_READ_TIMEOUT_SEC    = env_int("HTTP_READ_TIMEOUT_SEC", 540)

CONVERTER_URL = (os.environ.get("CONVERTER_URL", "") or "").rstrip("/")
RQ_TASK_PATH  = os.environ.get("RQ_TASK_PATH", "worker_tasks.compute_and_cache_stats")

# Pull des caches depuis S3 si absents localement (recommandé en multi-instance)
PULL_CONVERTED_FROM_S3 = env_bool("PULL_CONVERTED_FROM_S3", True)

ALLOWED_EXTS = {".stl", ".step", ".stp"}
def _ext(name: str) -> str: return pathlib.Path(name.lower()).suffix
def _allowed(name: str) -> bool: return _ext(name) in ALLOWED_EXTS

# Upload / output folders
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
RQ_QUEUE_NAME = os.environ.get("RQ_QUEUE_NAME", "convert")

_redis_conn: redislib.Redis | None = None
_q: Queue | None = None
_redis_err: str | None = None
_rq_err: str | None = None

def get_redis() -> redislib.Redis:
    global _redis_conn, _redis_err
    if _redis_conn is not None:
        return _redis_conn
    try:
        _redis_conn = redis_from_url(REDIS_URL, ssl_cert_reqs=None, socket_timeout=5)
        # Sanity ping
        _redis_conn.ping()
    except Exception as e:
        _redis_err = repr(e)
        raise
    return _redis_conn

def get_queue() -> Queue:
    global _q, _rq_err
    if _q is not None:
        return _q
    try:
        _q = Queue(RQ_QUEUE_NAME, connection=get_redis())
        _ = _q.count  # touch
    except Exception as e:
        _rq_err = repr(e)
        raise
    return _q

# ---------- HTTP helpers ----------
def _http_timeout():
    return (HTTP_CONNECT_TIMEOUT_SEC, HTTP_READ_TIMEOUT_SEC)

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

def _s3_key_for_xkt(file_id: str) -> str:
    return f"xkt/{file_id}.xkt"

def _public_s3_url(key: str) -> str:
    return f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{key}"

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
def _thickness_cache_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.thick.json")

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
    out_glb  = os.path.join(OUTPUT_FOLDER, f"{file_id}.glb")
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

    # ====== MODE DE CONVERSION ======
    mode_env = (os.getenv("CONVERTER_MODE", "") or "").lower()
    conv_url = (os.getenv("CONVERTER_URL", "") or "").rstrip("/")

    force_rq = not mode_env and not conv_url
    if force_rq:
        use_rq = True
    else:
        use_rq = (mode_env in {"rq", "worker", "queue", "background"}) or (not conv_url)

    if use_rq:
        # 3-RQ) enqueue la conversion dans le worker Docker (pas d'HTTP)
        try:
            qname = os.getenv("RQ_CONVERT_QUEUE", RQ_QUEUE_NAME)
            conn = get_redis()
            job_timeout = int(os.getenv("RQ_JOB_TIMEOUT_SEC", str(RQ_JOB_TIMEOUT_SEC)))

            # on tente l'import direct, sinon on passe par la string de chemin
            try:
                from converter import convert_step_to_xkt as _fn
                job = Queue(qname, connection=conn).enqueue(
                    _fn, file_id, job_timeout=job_timeout, result_ttl=3600, failure_ttl=3600, ttl=job_timeout
                )
            except Exception:
                job = Queue(qname, connection=conn).enqueue(
                    "converter.convert_step_to_xkt", file_id,
                    job_timeout=job_timeout, result_ttl=3600, failure_ttl=3600, ttl=job_timeout
                )

            app.logger.info("[upload] enqueued convert job queue=%s id=%s file_id=%s", qname, job.id, file_id)

            # URLs utiles pour le front
            xkt_rel = f"/xkt/{file_id}.xkt"
            glb_rel = f"/glb/{file_id}.glb"
            return jsonify(
                file_id=file_id,
                status="enqueued",
                job_id=job.id,
                xktUrl=_abs_url(xkt_rel),
                xkt_url=_abs_url(xkt_rel),
                glb_url=_abs_url(glb_rel),
                glb_exists=False,
                s3_uploaded_src=s3_uploaded_src,
                s3_uploaded_xkt=False,
                s3_uploaded_glb=False,
                debugUrl=_abs_url(f"/debug/xkt/{file_id}"),
                note="XKT sera dispo quand le worker aura upload S3",
            ), 202

        except Exception as e:
            app.logger.exception("[upload] rq_enqueue_fail for %s: %s", file_id, e)
            return jsonify(error="convert_enqueue_fail", detail=str(e)), 500

    # ----- sinon: LEGACY HTTP (microservice) -----
    try:
        send_ct = "model/step" if ext == ".step" else ("model/stl" if ext == ".stl" else f.mimetype or "application/octet-stream")
        app.logger.info("[upload] sending to converter %s (in_path=%s, out_xkt=%s)", conv_url, in_path, out_xkt)

        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{conv_url}/convert",
                files={"file": (Path(in_path).name, fh, send_ct)},
                timeout=_http_timeout(),
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

        resp_ct = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        allowed_ct = {"application/octet-stream", "model/xkt"}
        if resp_ct and resp_ct not in allowed_ct:
            detail = (resp.text or "")[:1000]
            app.logger.error("[upload] converter returned unexpected Content-Type=%s for %s", resp_ct, file_id)
            return jsonify(
                error="convert_fail",
                detail="unexpected content-type",
                content_type=resp_ct,
                preview=detail,
            ), 502

        def _looks_like_html(data: bytes) -> bool:
            sample = data[:128].lstrip().lower()
            return sample.startswith(b"<!doctype") or sample.startswith(b"<html") or b"<html" in sample[:64]

        chunk_iter = resp.iter_content(chunk_size=1024 * 1024)
        first_chunk = b""
        while True:
            try:
                first_chunk = next(chunk_iter)
            except StopIteration:
                first_chunk = b""
                break
            if first_chunk:
                break

        if _looks_like_html(first_chunk):
            preview = first_chunk[:512].decode("utf-8", errors="ignore")
            app.logger.error("[upload] converter returned HTML-looking payload for %s", file_id)
            return jsonify(
                error="convert_fail",
                detail="converter returned HTML payload",
                preview=preview,
            ), 502

        with open(out_xkt, "wb") as out:
            if first_chunk:
                out.write(first_chunk)
            for chunk in chunk_iter:
                if chunk:
                    out.write(chunk)
        if not os.path.isfile(out_xkt):
            app.logger.error("[upload] no .xkt produced at %s", out_xkt)
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

    except requests.Timeout:
        app.logger.exception("[upload] converter timeout file_id=%s", file_id)
        return jsonify(error="convert_timeout", detail=f"Converter timeout (>{HTTP_READ_TIMEOUT_SEC}s)"), 504
    except Exception as e:
        app.logger.exception("[upload] unexpected converter error: %s", e)
        return jsonify(error="convert_fail", detail=str(e)), 500

    # 4) optional S3 upload of XKT/GLB (only in HTTP/legacy path: on a le fichier)
    s3_uploaded_xkt = False
    try:
        if _s3_enabled() and put_file:
            put_file(out_xkt, f"xkt/{file_id}.xkt", content_type="application/octet-stream")
            s3_uploaded_xkt = True
    except Exception as e:
        app.logger.warning("[upload] S3 upload XKT failed for %s: %s", file_id, e)

    glb_exists_local = os.path.isfile(out_glb)
    s3_uploaded_glb = False
    if glb_exists_local:
        try:
            if _s3_enabled() and put_file:
                put_file(out_glb, f"glb/{file_id}.glb", content_type="model/gltf-binary")
                s3_uploaded_glb = True
        except Exception as e:
            app.logger.warning("[upload] S3 upload GLB failed for %s: %s", file_id, e)

    xkt_rel = f"/xkt/{file_id}.xkt"
    glb_rel = f"/glb/{file_id}.glb"
    return jsonify(
        file_id=file_id,
        status="ready",
        xktUrl=_abs_url(xkt_rel),
        xkt_url=_abs_url(xkt_rel),
        glb_url=_abs_url(glb_rel),
        glb_exists=glb_exists_local,
        s3_uploaded_src=s3_uploaded_src,
        s3_uploaded_xkt=s3_uploaded_xkt,
        s3_uploaded_glb=s3_uploaded_glb,
    )

# ---------- Fichiers servis ----------
@app.get("/xkt/<file_id>.xkt")
def serve_xkt(file_id: str):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return abort(400)
    path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    def _abort_known_bad(local_path: str):
        try:
            size = os.path.getsize(local_path)
        except OSError:
            size = 0
        if size == KNOWN_BAD_XKT_BYTES and size > 0:
            app.logger.warning("[xkt] known bad artifact blocked", {
                "file_id": file_id,
                "size": size,
            })
            return jsonify({
                "error": "known_bad_xkt",
                "file_id": file_id,
                "size": size,
            }), 409
        return None

    if os.path.isfile(path):
        blocked = _abort_known_bad(path)
        if blocked:
            return blocked
        return send_from_directory(
            OUTPUT_FOLDER, f"{file_id}.xkt",
            mimetype="application/octet-stream",
            as_attachment=False, max_age=0, etag=False, conditional=False
        )
    if _s3_enabled():
        try:
            from s3io import get_file
            os.makedirs(OUTPUT_FOLDER, exist_ok=True)
            key = f"xkt/{file_id}.xkt"
            ok = get_file(key, path)
            if ok and os.path.isfile(path):
                blocked = _abort_known_bad(path)
                if blocked:
                    return blocked
                return send_from_directory(
                    OUTPUT_FOLDER, f"{file_id}.xkt",
                    mimetype="application/octet-stream",
                    as_attachment=False, max_age=0, etag=False, conditional=False
                )
            app.logger.warning("S3 fallback miss for XKT key=%s", key)
        except Exception as e:
            app.logger.warning("S3 fallback error for XKT %s: %s", file_id, e)
    return abort(404)

@app.get("/glb/<file_id>.glb")
def serve_glb(file_id: str):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return abort(400)
    path = os.path.join(OUTPUT_FOLDER, f"{file_id}.glb")
    if os.path.isfile(path):
        return send_from_directory(
            OUTPUT_FOLDER, f"{file_id}.glb",
            mimetype="model/gltf-binary",
            as_attachment=False, max_age=0, etag=False, conditional=False
        )
    if _s3_enabled():
        try:
            from s3io import get_file
            os.makedirs(OUTPUT_FOLDER, exist_ok=True)
            key = f"glb/{file_id}.glb"
            ok = get_file(key, path)
            if ok and os.path.isfile(path):
                return send_from_directory(
                    OUTPUT_FOLDER, f"{file_id}.glb",
                    mimetype="model/gltf-binary",
                    as_attachment=False, max_age=0, etag=False, conditional=False
                )
            app.logger.warning("S3 fallback miss for GLB key=%s", key)
        except Exception as e:
            app.logger.warning("S3 fallback error for GLB %s: %s", file_id, e)
    return abort(404)

# ---------- Helper: lecture stats depuis Redis ----------
def _read_stats_from_redis(file_id: str, axis: str):
    try:
        raw = get_redis().get(f"shape_stats:{file_id}:{axis}")
        if not raw:
            return None
        data = json.loads(raw.decode("utf-8"))
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

# ---------- API analyse ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    file_id = request.args.get("file_id", "").strip()
    axis = (request.args.get("axis") or "Z").upper()
    recompute = (request.args.get("recompute") or "0").lower() in ("1", "true", "yes", "on")

    if not file_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return jsonify(error="bad_file_id", detail="file_id doit être un UUID v4"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    base_cache, proj_cache = _cache_paths(file_id, axis)

    # Recompute -> purge locale
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

    # 3) S3 -> local
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
    try:
        queue = get_queue()
    except Exception as e:
        return jsonify(error="rq_unavailable", detail=str(e)), 503

    job_base = f"shape_stats:{file_id}:{axis}"
    job_id = job_base if not recompute else f"{job_base}:{uuid.uuid4().hex[:8]}"

    if not recompute:
        try:
            job = Job.fetch(job_id, connection=get_redis())
        except Exception:
            job = None
        if job:
            st = (job.get_status() or "").lower()
            if st in ("queued", "started", "deferred"):
                return jsonify(status="processing", job_id=job_id, retry_in_sec=2), 202
            if st == "finished":
                rj = _read_stats_from_redis(file_id, axis)
                if rj:
                    rj = _merge_thickness_from_worker(file_id, rj, prefer_worker=True)
                    if env_bool("THICKNESS_ON_WEB", False):
                        rj = _ensure_thickness_via_converter(file_id, rj)
                    return jsonify(rj)

    try:
        step_path = _step_path_for(file_id)
        step_ext  = pathlib.Path(step_path).suffix.lstrip(".") if step_path else None

        queue.enqueue(
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

# ---------- Estimation épaisseur locale (optionnel) ----------
# (tes fonctions compute_thickness_mm_from_occ_shape et _estimate_thickness_mm_from_mesh peuvent rester telles quelles)
# ... [gardées identiques à ton fichier] ...

# ---------- Debug ----------
@app.get("/__job/<path:job_id>")
def __job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=get_redis())
        info = {
            "id": job.id,
            "status": job.get_status(),
            "enqueued_at": str(job.enqueued_at) if job.enqueued_at else None,
            "started_at": str(job.started_at) if job.started_at else None,
            "ended_at": str(job.ended_at) if job.ended_at else None,
            "result": getattr(job, "result", None),
            "exc_info": getattr(job, "exc_info", None),
            "meta": getattr(job, "meta", None),
        }
        return jsonify(ok=True, **info)
    except Exception as e:
        return jsonify(ok=False, error=str(e), job_id=job_id), 500

@app.get("/__rq_workers")
def __rq_workers():
    try:
        workers = []
        for w in Worker.all(connection=get_redis()):
            workers.append({
                "name": w.name,
                "state": w.get_state(),
                "queues": [qq.name for qq in w.queues],
                "current_job_id": getattr(w, "get_current_job_id", lambda: None)()
            })
        return jsonify(ok=True, queue=RQ_QUEUE_NAME, workers=workers)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

@app.get("/__rq_queue")
def __rq_queue():
    try:
        queue = get_queue()
        jobs = [j.id for j in queue.jobs]
        return jsonify(ok=True, queue=queue.name, count=len(jobs), jobs=jobs)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

def _rq():
    r = redis_from_url(_normalize_redis_url(os.getenv("REDIS_URL")), ssl_cert_reqs=None, socket_timeout=5)
    q = Queue(os.getenv("RQ_QUEUE_NAME", RQ_QUEUE_NAME), connection=r)
    return r, q

@app.get("/__rq_started")
def rq_started_list():
    r, q = _rq()
    reg = StartedJobRegistry(queue=q)
    return jsonify(ok=True, queue=q.name, started=reg.get_job_ids())

@app.post("/__rq_requeue_started")
def rq_requeue_started():
    r, q = _rq()
    reg = StartedJobRegistry(queue=q)
    done = []
    for jid in reg.get_job_ids():
        job = q.job_class.fetch(jid, connection=r)
        reg.remove(job, delete_job=False)
        q.enqueue_job(job)
        done.append(jid)
    return jsonify(ok=True, queue=q.name, requeued=done)

@app.get("/__worker_ping")
def __worker_ping():
    try:
        q = get_queue()
        job_id = f"ping:{uuid.uuid4().hex}"
        q.enqueue("worker_tasks.ping", kwargs={"payload": "ok"}, job_id=job_id,
                  result_ttl=120, ttl=120, failure_ttl=120)
        return jsonify(ok=True, job_id=job_id)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 503

@app.get("/__routes")
def __routes():
    lines = [f"{sorted(r.methods)}  {r.rule}" for r in app.url_map.iter_rules()]
    return "<pre>" + "\n".join(sorted(lines)) + "</pre>"

@app.get("/__rq")
def __rq_info():
    info = {
        "redis_url_set": bool(REDIS_URL), "queue": RQ_QUEUE_NAME,
        "has_q": True, "is_connected": True,
        "probe_ok": False, "redis_error": _redis_err, "rq_error": _rq_err,
        "task_path": RQ_TASK_PATH,
        "rq_job_timeout_sec": RQ_JOB_TIMEOUT_SEC,
    }
    try:
        get_redis().setex("rq_probe", 5, "ok")
        info["probe_ok"] = (get_redis().get("rq_probe") == b"ok")
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
        "http_connect_timeout_sec": HTTP_CONNECT_TIMEOUT_SEC,
        "http_read_timeout_sec": HTTP_READ_TIMEOUT_SEC,
        "rq_job_timeout_sec": RQ_JOB_TIMEOUT_SEC,
        "XEOKIT_ARGS": os.getenv("XEOKIT_ARGS"),
    }
    if CONVERTER_URL:
        try:
            r = requests.get(f"{CONVERTER_URL}/healthz", timeout=_http_timeout())
            info["converter_health"] = {"ok": (r.status_code == 200), "code": r.status_code}
        except Exception as e:
            info["converter_health"] = {"ok": False, "error": str(e)}
    else:
        info["converter_health"] = {"ok": None, "note": "Using RQ worker (no HTTP converter)"}
    return jsonify(info)

_XEOKIT_VERSION_CACHE = None
_XEOKIT_VERSION_TTL = 600

def _get_converter_version() -> dict:
    """
    Retourne {"version": "..."} pour @xeokit/xeokit-convert, sinon {"error": "..."}.
    Cache 10 min comme avant.
    """
    global _XEOKIT_VERSION_CACHE
    now = time.time()
    if isinstance(_XEOKIT_VERSION_CACHE, dict) and (now - _XEOKIT_VERSION_CACHE.get("ts", 0) < _XEOKIT_VERSION_TTL):
        return _XEOKIT_VERSION_CACHE.get("value", {})

    result: dict[str, str] = {}
    try:
        proc = subprocess.run(
            ["npx", "--yes", "@xeokit/xeokit-convert", "--version"],
            capture_output=True, text=True, timeout=30, check=False
        )
        ver = (proc.stdout or proc.stderr or "").strip()
        if proc.returncode == 0 and ver:
            result["version"] = ver
        else:
            result["error"] = (proc.stderr or proc.stdout or "").strip() or f"rc={proc.returncode}"
    except Exception as exc:
        result["error"] = str(exc)

    _XEOKIT_VERSION_CACHE = {"ts": now, "value": result}
    return result

@app.route("/debug/xkt/<file_id>")
def debug_xkt(file_id: str):
    glb_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.glb")
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    def _count_faces(path: str) -> int:
        try:
            import trimesh  # type: ignore
            scene = trimesh.load(path, force="scene")
            if hasattr(scene, "geometry"):
                return sum(getattr(geom, "faces", []).shape[0] for geom in scene.geometry.values())
            return int(getattr(scene, "faces", []).shape[0])
        except Exception:
            return -1

    def _probe_xkt(path: str) -> dict[str, object]:
        if not os.path.exists(path):
            return {}
        head_bytes = b""
        try:
            with open(path, "rb") as fh:
                head_bytes = fh.read(256)
        except Exception:
            head_bytes = b""
        ascii_sample = (head_bytes.decode("utf-8", errors="ignore")[:128]) if head_bytes else ""
        looks_html = ("<html" in ascii_sample.lower()) or ("<!doctype" in ascii_sample.lower())
        return {
            "xkt_mime_guess": mimetypes.guess_type(path)[0],
            "xkt_head_preview": ascii_sample,
            "xkt_looks_like_html": looks_html,
        }

    glb_exists = os.path.exists(glb_path)
    xkt_exists = os.path.exists(xkt_path)

    xkt_size = os.path.getsize(xkt_path) if xkt_exists else 0
    data: dict[str, object] = {
        "file_id": file_id,
        "glb_exists": glb_exists,
        "xkt_exists": xkt_exists,
        "glb_faces": _count_faces(glb_path) if glb_exists else -1,
        "glb_size": os.path.getsize(glb_path) if glb_exists else 0,
        "xkt_size": xkt_size,
        "known_bad_xkt": bool(xkt_exists and xkt_size == KNOWN_BAD_XKT_BYTES),
        "converter": _get_converter_version(),
    }
    if xkt_exists:
        data.update(_probe_xkt(xkt_path))
    else:
        data.update({"xkt_mime_guess": None, "xkt_head_preview": "", "xkt_looks_like_html": False})

    return app.response_class(response=json.dumps(data), status=200, mimetype="application/json")

@app.get("/exists/xkt/<file_id>")
def exists_xkt(file_id: str):
    key = _s3_key_for_xkt(file_id)
    exists = False
    size = 0

    try:
        resp = s3_client.head_object(Bucket=S3_BUCKET, Key=key)
        size = int(resp.get("ContentLength", 0) or 0)
        exists = size > 0
        app.logger.info(f"[exists][s3] key={key} size={size} exists={exists}")
    except botocore.exceptions.ClientError as e:
        app.logger.warning(f"[exists][s3] head failed key={key} err={e}")
    except Exception as e:
        app.logger.error(f"[exists][s3] unexpected err key={key} err={e}")

    if not exists:
        try:
            xkt_url = url_for("serve_xkt", file_id=file_id, _external=True)
            r = requests.head(xkt_url, timeout=5, allow_redirects=True)
            clen = r.headers.get("Content-Length") or r.headers.get("content-length") or "0"
            try:
                size = int(str(clen))
            except (TypeError, ValueError):
                size = 0
            exists = (r.status_code == 200 and size > 0)
            app.logger.info(
                f"[exists][http] url={xkt_url} status={r.status_code} size={size} exists={exists}"
            )
        except Exception as e:
            app.logger.warning(f"[exists][http] head failed key={key} err={e}")

    payload = {"file_id": file_id, "exists": exists, "size": size}
    resp = make_response(jsonify(payload), 200)
    resp.headers["Cache-Control"] = "no-cache, max-age=0"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    logger.info(
        "[exists][result] file_id=%s key=%s exists=%s size=%s", file_id, key, exists, size
    )
    return resp


@app.get("/xkt/<file_id>.xkt")
def xkt_presigned_redirect(file_id: str):
    key = f"xkt/{file_id}.xkt"
    try:
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=300,
        )
        return redirect(url, code=302)
    except Exception as e:
        app.logger.error("[xkt][presign] failed: %s", e)
        return ("", 404)
@app.post("/reconvert/<file_id>")
def reconvert(file_id: str):
    if not file_id:
        return jsonify(ok=False, error="file_id manquant"), 400
    xkt_path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")
    if os.path.exists(xkt_path):
        try: os.remove(xkt_path)
        except OSError as exc:
            app.logger.warning("[web][reconvert] failed to remove old XKT id=%s err=%s", file_id, exc)
    try:
        result = _convert_step_to_xkt_local(file_id)
    except FileNotFoundError as exc:
        return jsonify(ok=False, error=str(exc)), 404
    except RuntimeError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        app.logger.exception("[web][reconvert] unexpected failure id=%s", file_id)
        return jsonify(ok=False, error="internal_error", detail=str(exc)), 500
    payload = {
        "ok": True,
        "faces": result.get("faces", 0),
        "xkt_size": result.get("xkt_size", 0),
        "glb": result.get("glb"),
        "xkt": result.get("xkt"),
    }
    return jsonify(payload)

@app.get("/__s3_env")
def __s3_env():
    return jsonify({
        "AWS_ACCESS_KEY_ID_set": bool(os.environ.get("AWS_ACCESS_KEY_ID")),
        "AWS_SECRET_ACCESS_KEY_set": bool(os.environ.get("AWS_SECRET_ACCESS_KEY")),
        "AWS_REGION": os.environ.get("AWS_REGION"),
        "S3_BUCKET": S3_BUCKET,
        "S3_REGION": S3_REGION,
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT"),
        "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE"),
        "PULL_CONVERTED_FROM_S3": PULL_CONVERTED_FROM_S3,
    })

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

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
