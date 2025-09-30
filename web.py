# web.py
import os, uuid, pathlib, json, requests, re, glob, tempfile
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

# Épaisseur via converter (lecture STEP + algo ±normales -> mm)
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

# Chemin de la fonction RQ (important : ne pas utiliser "tasks....")
RQ_TASK_PATH = os.environ.get("RQ_TASK_PATH", "worker_tasks.compute_and_cache_stats")

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

# ---- NORMALISATION MÉTRIQUES (µm → mm, mm³ → cm³) ----
def _normalize_metrics_dict(raw: dict) -> dict:
    """Met les champs au format attendu par le front, avec tolérance."""
    # volume
    if "volume_cm3" in raw and raw.get("volume_cm3") is not None:
        vol_cm3 = float(raw.get("volume_cm3") or 0.0)
    else:
        vol_mm3 = float(raw.get("volume_mm3") or 0.0)
        vol_cm3 = vol_mm3 / 1000.0

    # surface projetée (déjà en cm² en principe)
    proj_cm2 = float(raw.get("projected_area_cm2") or 0.0)

    # bbox
    bbox_mm = raw.get("bbox_mm") or raw.get("bbox") or [0.0, 0.0, 0.0]

    # épaisseurs
    def _fix_thickness(v):
        try:
            x = float(v or 0.0)
        except Exception:
            return 0.0
        if x > 1000.0:  # heuristique µm -> mm
            x = x / 1000.0
        return x

    tmin = _fix_thickness(raw.get("thickness_min_mm") or raw.get("thickness_min"))
    tmax = _fix_thickness(raw.get("thickness_max_mm") or raw.get("thickness_max"))

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
        "volume_cm3": j1.get("volume_cm3"),  # compat éventuelle
        "bbox_mm": j1.get("bbox_mm"),
        "thickness_min_mm": j1.get("thickness_min_mm"),
        "thickness_max_mm": j1.get("thickness_max_mm"),
        "projected_area_cm2": j2.get("projected_area_cm2"),
    }
    return _normalize_metrics_dict(merged)

def _compute_stats_sync_or_error(file_id: str, axis: str, step_path: str):
    """Calcule en local et écrit les caches dans OUTPUT_FOLDER, renvoie le JSON brut de shape_metrics."""
    from shape_metrics import stats_json as compute_stats_json
    return compute_stats_json(step_path, axis=axis, cache_dir=OUTPUT_FOLDER, file_id=file_id)

def _abs_url(path: str) -> str:
    """Construit une URL absolue robuste derrière proxy (Render, etc.)."""
    proto = request.headers.get("X-Forwarded-Proto", request.scheme)
    host  = request.headers.get("X-Forwarded-Host", request.host)
    return f"{proto}://{host}{path}"

# ---------- Épaisseur (converter) : helper intégré ----------
def _ensure_thickness_via_converter(file_id: str, data: dict) -> dict:
    """
    Si un STEP est dispo pour file_id, calcule tmin/tmax en mm via converter
    et ÉCRASE les valeurs existantes si le calcul réussit. Écrit un cache .thick.json.
    """
    try:
        step_path = _step_path_for(file_id)
        if not step_path or not os.path.isfile(step_path):
            return data

        unit_hint = os.getenv("THICKNESS_UNIT_HINT", "mm")
        ctmin, ctmax = compute_thickness_mm_from_step(step_path, unit_hint=unit_hint)

        # Vérif NaN/None et > 0
        if (ctmin is None or ctmax is None) or not (ctmin == ctmin and ctmax == ctmax):
            data.setdefault("thickness_warning", "Impossible de calculer l'épaisseur (NaN).")
            return data
        if float(ctmin) <= 0 or float(ctmax) <= 0:
            data.setdefault("thickness_warning", "Épaisseur calculée <= 0 (ignorer).")
            return data

        old_min = data.get("thickness_min_mm")
        old_max = data.get("thickness_max_mm")

        data["thickness_min_mm"] = round(float(ctmin), 4)
        data["thickness_max_mm"] = round(float(ctmax), 4)
        data["thickness_source"] = "converter"
        if "thickness_warning" in data:
            try: del data["thickness_warning"]
            except Exception: pass

        # cache local
        try:
            with open(_thickness_cache_path(file_id), "w", encoding="utf-8") as fh:
                json.dump({"tmin": data["thickness_min_mm"], "tmax": data["thickness_max_mm"]}, fh)
        except Exception:
            pass

        app.logger.info("[thickness] converter %s: old=(%s,%s) new=(%.4f,%.4f)",
                        file_id, old_min, old_max, data["thickness_min_mm"], data["thickness_max_mm"])

    except Exception as e:
        data.setdefault("thickness_warning", f"thickness(converter) error: {e.__class__.__name__}: {e}")
    return data

# ---------- Raffinement des épaisseurs (ray casting) ----------
def _try_imports_for_thickness():
    reason = None
    try:
        import numpy as _np  # noqa
    except Exception as e:
        reason = f"numpy manquant: {e}"
        return False, reason
    try:
        import trimesh as _trimesh  # noqa
    except Exception as e:
        reason = f"trimesh manquant: {e}"
        return False, reason
    return True, None

# ===== Tessellation STEP via CadQuery/OCP (prioritaire) =====
def _mesh_from_step_cadquery(step_path: str):
    """
    Lit un .STEP avec cadquery/ocp et retourne un mesh trimesh.
    Unités : millimètres (CadQuery/OCP renvoie en mm).
    """
    try:
        import cadquery as cq
        import numpy as np
        import trimesh
    except Exception as e:
        app.logger.warning("[thickness] cadquery indisponible: %s", e)
        return None

    try:
        shape = cq.importers.importStep(step_path)
        tol_mm = float(os.environ.get("THICK_LIN_DEF_MM", os.environ.get("TESSELLATION_TOL_MM", "0.05")))
        ang_rad = float(os.environ.get("THICK_ANG_DEF_RAD", os.environ.get("TESSELLATION_ANG_RAD", "0.25")))
        verts, faces = shape.tessellate(tol_mm, angular_tolerance=ang_rad)
        if not verts or not faces:
            app.logger.warning("[thickness] tessellation vide pour %s", step_path)
            return None

        V = np.asarray(verts, dtype=float)
        F = np.asarray(faces, dtype=int)

        mesh = trimesh.Trimesh(vertices=V, faces=F, process=True)
        if mesh.is_empty:
            return None
        if not mesh.is_watertight:
            try: mesh = mesh.fill_holes()
            except Exception: pass
        return mesh

    except Exception as e:
        app.logger.exception("[thickness] STEP→mesh (cadquery) failed: %s", e)
        return None

# ===== Fallback pythonocc (si dispo) =====
def _mesh_from_step_occ(step_path: str):
    """STEP -> trimesh via pythonocc; mm supposés (comme dans le STEP)."""
    try:
        import numpy as np
        import trimesh
        from OCC.Core.STEPControl import STEPControl_Reader
        from OCC.Core.IFSelect import IFSelect_RetDone
        from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
        from OCC.Core.TopExp import TopExp_Explorer
        from OCC.Core.TopAbs import TopAbs_FACE
        from OCC.Core.BRep import BRep_Tool
        from OCC.Core.Poly import Poly_Triangulation
        from OCC.Core.TopoDS import TopoDS_Face
    except Exception as e:
        app.logger.warning("[thickness] pythonocc indisponible: %s", e)
        return None

    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        app.logger.warning("[thickness] STEP read fail: %s", step_path)
        return None
    reader.TransferRoots()
    shape = reader.OneShape()

    try:
        BRepMesh_IncrementalMesh(shape, 0.15, False, 0.3, True)
    except Exception:
        BRepMesh_IncrementalMesh(shape, 0.5, False, 0.5, True)

    verts_all, faces_all = [], []
    v_offset = 0

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS_Face(exp.Current())
        triangulation = BRep_Tool.Triangulation(face, None)
        if triangulation is not None and isinstance(triangulation, Poly_Triangulation):
            pts = triangulation.Nodes()
            tris = triangulation.Triangles()
            npts = pts.Size()
            ntris = tris.Size()
            for i in range(1, npts + 1):
                p = pts.Value(i)
                verts_all.append([p.X(), p.Y(), p.Z()])
            for i in range(1, ntris + 1):
                t = tris.Value(i)
                a, b, c = t.Get()
                faces_all.append([v_offset + a - 1, v_offset + b - 1, v_offset + c - 1])
            v_offset += npts
        exp.Next()

    if not verts_all or not faces_all:
        app.logger.warning("[thickness] tessellation vide")
        return None

    mesh = trimesh.Trimesh(vertices=np.asarray(verts_all), faces=np.asarray(faces_all), process=True)
    return mesh

# ===== Choix chargeur mesh =====
def _mesh_from_file(path: str):
    """Charge un maillage depuis STL/STEP."""
    ext = (_ext(path) or "").lower()

    if ext == ".stl":
        try:
            import trimesh
            return trimesh.load_mesh(path, force="mesh")
        except Exception as e:
            app.logger.warning("[thickness] load STL failed: %s", e)
            return None

    if ext in (".step", ".stp"):
        m = _mesh_from_step_cadquery(path)
        if m is not None:
            return m
        try:
            from OCC.Core.STEPControl import STEPControl_Reader  # probe
            return _mesh_from_step_occ(path)
        except Exception:
            app.logger.warning("[thickness] ni CadQuery ni pythonocc disponibles/valides pour STEP")
            return None
    return None

def _estimate_thickness_mm_from_mesh(mesh, samples=30000, eps_factor=1e-5, outlier_pct=0.1, backface_dot=-0.3):
    """
    Estime min/max d'épaisseur (mm) en tirant des rayons ±n depuis la surface.
    """
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

def _maybe_refine_thickness_with_rays(file_id: str, data: dict, *, force: bool=False, dbg: dict | None=None) -> dict:
    """Raffine thickness_* si possible (cache local, sinon ray casting). Remplit dbg si fourni."""
    def _dbg(k, v):
        if isinstance(dbg, dict):
            dbg[k] = v

    try:
        if not env_bool("REFINE_THICKNESS", True) and not force:
            _dbg("skipped", "REFINE_THICKNESS=0")
            return data

        # Si on dispose d'une valeur "converter" fiable et qu'on ne force pas, on ne remplace pas.
        if not force and data.get("thickness_source") == "converter":
            _dbg("skip_reason", "has_converter_values")
            return data

        thick_cache = _thickness_cache_path(file_id)
        if os.path.isfile(thick_cache) and not force:
            try:
                j = _read_json(thick_cache)
                tmin, tmax = j.get("tmin"), j.get("tmax")
                if tmin is not None and tmax is not None:
                    data["thickness_min_mm"] = round(float(tmin), 4)
                    data["thickness_max_mm"] = round(float(tmax), 4)
                    data["thickness_source"] = "cache"
                    _dbg("cache", thick_cache)
                    return data
            except Exception as e:
                _dbg("cache_read_error", str(e))

        ok, reason = _try_imports_for_thickness()
        if not ok:
            _dbg("imports", reason);  return data

        src = _step_or_stl_path_for(file_id)
        if not src or not os.path.isfile(src):
            _dbg("src", "STEP/STL introuvable");  return data
        _dbg("src_path", src)

        mesh = _mesh_from_file(src)
        if mesh is None:
            _dbg("mesh", "échec création mesh");  return data

        samples = env_int("THICKNESS_SAMPLES", 30000)
        if force and request.args.get("samples"):
            try: samples = max(2000, int(request.args.get("samples")))
            except Exception: pass
        _dbg("samples", samples)

        tmin, tmax = _estimate_thickness_mm_from_mesh(mesh, samples=samples)
        if tmin is None or tmax is None:
            _dbg("result", "raycast vide");  return data

        data["thickness_min_mm"] = round(float(tmin), 4)
        data["thickness_max_mm"] = round(float(tmax), 4)
        data["thickness_source"] = "raycast"
        _dbg("refined_to", {"min": data["thickness_min_mm"], "max": data["thickness_max_mm"]})

        try:
            with open(thick_cache, "w", encoding="utf-8") as fh:
                json.dump({"tmin": data["thickness_min_mm"], "tmax": data["thickness_max_mm"]}, fh)
            _dbg("cache_write", thick_cache)
        except Exception as e:
            _dbg("cache_write_error", str(e))

        return data
    except Exception as e:
        app.logger.warning("[thickness] refine error: %s", e)
        _dbg("exception", str(e))
        return data

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

# ---------- API : upload -> converter XKT (streaming mémoire) ----------
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
        app.logger.exception("S3 upload failed for %s: %s", s3_key, e)

    # 3) conversion XKT via le converter (stream)
    try:
        with open(in_path, "rb") as fh:
            resp = requests.post(
                f"{CONVERTER_URL}/convert",
                files={"file": (f.filename, fh, f.mimetype or "application/octet-stream")},
                timeout=600,
                stream=True,
                headers={"Accept": "application/octet-stream"},
            )
        if resp.status_code != 200:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            return jsonify(error="convert_fail", detail=detail, status_code=resp.status_code), 500

        # ÉCRITURE STREAMING DU XKT
        with open(out_xkt, "wb") as out:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)

        if not os.path.isfile(out_xkt):
            return jsonify(error="no_xkt", detail=f".xkt introuvable: {out_xkt}"), 500

        try:
            if _s3_enabled():
                put_file(out_xkt, f"xkt/{file_id}.xkt", content_type="application/octet-stream")
        except Exception as e:
            app.logger.warning("S3 upload XKT failed for %s: %s", file_id, e)

        xkt_rel = f"/xkt/{file_id}.xkt"
        xkt_abs = _abs_url(xkt_rel)
        return jsonify(
            file_id=file_id,
            status="ready",
            xktUrl=xkt_abs,
            xkt_url=xkt_abs,
            s3_uploaded=s3_uploaded
        )

    except requests.Timeout:
        return jsonify(error="convert_timeout", detail="Converter timeout (>=600s)"), 504
    except Exception as e:
        return jsonify(error="convert_fail", detail=str(e)), 500

# -- Route pour servir les XKT (fallback S3) --
@app.get("/xkt/<file_id>.xkt")
def serve_xkt(file_id: str):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", file_id):
        return abort(400)

    path = os.path.join(OUTPUT_FOLDER, f"{file_id}.xkt")

    if os.path.isfile(path):
        return send_from_directory(
            OUTPUT_FOLDER,
            f"{file_id}.xkt",
            mimetype="application/octet-stream",
            as_attachment=False,
            max_age=0,
            etag=False,
            conditional=False,
        )

    if _s3_enabled():
        try:
            from s3io import get_file
            os.makedirs(OUTPUT_FOLDER, exist_ok=True)
            key = f"xkt/{file_id}.xkt"
            ok = get_file(key, path)
            if ok and os.path.isfile(path):
                return send_from_directory(
                    OUTPUT_FOLDER,
                    f"{file_id}.xkt",
                    mimetype="application/octet-stream",
                    as_attachment=False,
                    max_age=0,
                    etag=False,
                    conditional=False,
                )
            app.logger.warning("S3 fallback miss for XKT key=%s", key)
        except Exception as e:
            app.logger.warning("S3 fallback error for XKT %s: %s", file_id, e)

    return abort(404)

# ---------- API analyse : lecture cache / sync fallback / enqueue worker ----------
@app.get("/api/shape/stats")
def api_shape_stats():
    import json as _json
    file_id = request.args.get("file_id")
    axis = (request.args.get("axis") or "Z").upper()
    force_recalc = (request.args.get("recalc") == "1")  # <— NOUVEAU
    if not file_id:
        return jsonify(error="no_file_id"), 400
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    step_path = _step_path_for(file_id)
    step_ext = pathlib.Path(step_path).suffix.lstrip(".") if step_path else None
    base_cache, proj_cache = _cache_paths(file_id, axis)

    # 1) Caches locaux si dispo
    if os.path.isfile(base_cache) and os.path.isfile(proj_cache) and not force_recalc:
        try:
            data = _response_from_caches(base_cache, proj_cache)
            data = _ensure_thickness_via_converter(file_id, data)  # écrase si ok
            if data.get("thickness_source") != "converter":
                data = _maybe_refine_thickness_with_rays(file_id, data)
            return jsonify(data)
        except Exception as e:
            return jsonify(error="cache_read_fail", detail=str(e)), 500

    # 2) Calcul synchrone local si possible (ou si recalc=1)
    if step_path:
        try:
            data = _compute_stats_sync_or_error(file_id, axis, step_path)
            data = _normalize_metrics_dict(data)
            data = _ensure_thickness_via_converter(file_id, data)
            # si pas de converter, tente le ray casting (force si recalc=1)
            data = _maybe_refine_thickness_with_rays(file_id, data, force=force_recalc)
            return jsonify(data)
        except Exception as e:
            # si on ne peut pas faire en synchrone, on passe à RQ (sauf si pas de S3)
            if not _s3_enabled():
                return jsonify(error="compute_fail", detail=str(e)), 500

    # 3) Sinon RQ (asynchrone)
    if q is None or _redis is None:
        return jsonify(error="rq_unavailable",
                       detail="Redis/RQ non dispo."), 503

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
            if os.path.isfile(base_cache) and os.path.isfile(proj_cache):
                data = _response_from_caches(base_cache, proj_cache)
                data = _ensure_thickness_via_converter(file_id, data)
                if data.get("thickness_source") != "converter":
                    data = _maybe_refine_thickness_with_rays(file_id, data)
                return jsonify(data)
            try:
                raw = _redis.get(f"shape_stats:{file_id}:{axis}")
                if raw:
                    data = _normalize_metrics_dict(_json.loads(raw))
                    data = _ensure_thickness_via_converter(file_id, data)
                    if data.get("thickness_source") != "converter":
                        data = _maybe_refine_thickness_with_rays(file_id, data)
                    return jsonify(data)
            except Exception:
                pass
            return jsonify(status="processing", job_id=job_id, retry_in_sec=1), 202
        if st == "failed":
            return jsonify(error="compute_fail",
                           job_id=job_id,
                           status=st,
                           exc=str(job.exc_info) if getattr(job, "exc_info", None) else None), 500

    try:
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
            result_ttl=3600, ttl=3600, failure_ttl=3600
        )
        return jsonify(status="queued", job_id=job_id, retry_in_sec=2), 202
    except Exception as e:
        return jsonify(error="enqueue_fail", detail=str(e)), 500

# ---------- Debug RQ ----------
@app.get("/__job/<path:job_id>")
def __job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=_redis)
        info = {
            "id": job.id,
            "status": job.get_status(),
            "enqueued_at": str(job.enqueued_at) if job.enqueued_at else None,
            "started_at": str(job.started_at) if job.started_at else None,
            "ended_at": str(job.ended_at) if job.ended_at else None,
            "result": job.result if hasattr(job, "result") else None,
            "exc_info": job.exc_info if hasattr(job, "exc_info") else None,
        }
        return jsonify(ok=True, **info)
    except Exception as e:
        return jsonify(ok=False, error=str(e), job_id=job_id), 500

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
        try:
            err_code = (e.response or {}).get("Error", {}).get("Code")
        except Exception:
            pass
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

# ---------- Endpoint de diagnostic du raffinement ----------
@app.get("/__thickness_test")
def __thickness_test():
    file_id = request.args.get("file_id")
    if not file_id:
        return jsonify(ok=False, error="file_id manquant"), 400

    base_cache, proj_cache = _cache_paths(file_id, "Z")
    base = {}
    if os.path.isfile(base_cache):
        try: base = _read_json(base_cache)
        except Exception: base = {}

    data = _normalize_metrics_dict(base) if base else {"thickness_min_mm": None, "thickness_max_mm": None}
    dbg = {}

    data = _ensure_thickness_via_converter(file_id, data)
    need_raycast = (data.get("thickness_source") != "converter")
    force = env_bool("REFINE_FORCE_PARAM_FALLBACK", True) or (request.args.get("force") == "1") or need_raycast
    out = _maybe_refine_thickness_with_rays(file_id, data, force=force, dbg=dbg)

    return jsonify(ok=True, file_id=file_id, debug=dbg, result={
    "tmin": out.get("thickness_min_mm"),
    "tmax": out.get("thickness_max_mm"),
    "source": out.get("thickness_source", "unknown")
})

# --- Diag: CadQuery dispo ? ---
@app.get("/__cadquery")
def __cadquery():
    info = {}
    try:
        import cadquery as cq
        info["cadquery"] = getattr(cq, "__version__", "unknown")
        cq_ok = True
    except Exception as e:
        cq_ok = False
        info["cadquery_error"] = f"{e.__class__.__name__}: {e}"

    try:
        import OCP as ocp     # <-- le bon module !
        info["OCP"] = getattr(ocp, "__version__", "unknown")
        ocp_ok = True
    except Exception as e:
        ocp_ok = False
        info["OCP_error"] = f"{e.__class__.__name__}: {e}"

    info["ok"] = bool(cq_ok and ocp_ok)
    return jsonify(info)


# --- Maintenance: Purger les caches d'un file_id ---
@app.post("/__clear_caches")
def __clear_caches():
    file_id = request.args.get("file_id") or request.json.get("file_id")
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

