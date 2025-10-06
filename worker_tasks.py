# worker_tasks.py
import os
import json
import time
import pathlib
from typing import Optional, Tuple, Dict, Any

import numpy as np
import trimesh

from rq import get_current_job
import redis
from urllib.parse import urlparse, urlunparse, unquote

# --- Optional geometry backends for 2D union ---
HAS_SHAPELY = False
try:
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    HAS_SHAPELY = True
except Exception:
    HAS_SHAPELY = False

HAS_SKIMAGE = False
try:
    # fallback approximatif (raster)
    from skimage.draw import polygon as _ski_polygon
    HAS_SKIMAGE = True
except Exception:
    HAS_SKIMAGE = False

# ---------- ENV ----------
UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
AXES = ("X", "Y", "Z")

# Soft timeout pour toute la tâche
STATS_SOFT_TIMEOUT_SEC = int(os.getenv("STATS_SOFT_TIMEOUT_SEC", "600"))  # 10 min
TESSELLATION_TOL_MM = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
TESSELLATION_ANG_RAD = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))

WORKER_COMPUTE_THICKNESS = str(os.getenv("WORKER_COMPUTE_THICKNESS", "0")).lower() in ("1", "true", "yes", "on")
THICKNESS_SAMPLES = int(os.getenv("THICKNESS_SAMPLES", "30000"))
PULL_UPLOADS_FROM_S3 = str(os.getenv("PULL_UPLOADS_FROM_S3", "1")).lower() in ("1", "true", "yes", "on")

# ---------- Redis helpers ----------
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

REDIS_URL = _normalize_redis_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
RQ_QUEUE_NAME = os.getenv("RQ_QUEUE_NAME", "default")

def _redis_conn() -> redis.Redis:
    parsed = urlparse(REDIS_URL.strip().strip('"').strip("'"))
    use_ssl = (parsed.scheme or "").lower().startswith("rediss")
    return redis.Redis(
        host=parsed.hostname,
        port=parsed.port or 6379,
        username=(parsed.username or "default"),
        password=unquote(parsed.password or ""),
        db=int((parsed.path or "/0").lstrip("/")),
        ssl=use_ssl,
        ssl_cert_reqs=None,
        socket_timeout=5,
    )

# --- S3 helpers (download + upload) ---
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _s3_put(local_path: str, key: str, content_type: Optional[str] = None) -> bool:
    if not _s3_enabled():
        return False
    try:
        from s3io import put_file
        return bool(put_file(local_path, f"converted/{os.path.basename(key)}", content_type=content_type))
    except Exception:
        return False

def _s3_get(key: str, dest_path: str) -> bool:
    """Télécharge un objet S3 dans dest_path. Retourne True si le fichier existe à la fin."""
    if not _s3_enabled():
        return False
    try:
        from s3io import get_file
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        ok = get_file(key, dest_path)
        return bool(ok and os.path.isfile(dest_path))
    except Exception:
        return False

# ---------- RQ meta ----------
def bump_stage(stage: str, extra: Dict[str, Any] = None):
    job = get_current_job()
    if not job:
        return
    meta = job.meta or {}
    meta["stage"] = stage
    meta["ts"] = time.time()
    if extra:
        meta.update(extra)
    job.meta = meta
    job.save_meta()

def _deadline_reached(start_ts: float) -> bool:
    return (time.monotonic() - start_ts) > STATS_SOFT_TIMEOUT_SEC

def _ensure_local_step(file_id: str, step_ext_hint: Optional[str]) -> Optional[str]:
    """
    Retourne un chemin local vers le STEP/STL, en le téléchargeant depuis S3 si besoin.
    Cherche dans UPLOAD_FOLDER: <fid>.step | .stp | .stl
    Puis dans S3: uploads/<fid>.<ext>.
    """
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)

    # 1) local direct
    for ext in (step_ext_hint, "step", "stp", "stl"):
        if not ext:
            continue
        e = ext if ext.startswith(".") else f".{ext}"
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}{e}")
        if os.path.isfile(p):
            return p

    # 2) S3 pull si activé
    if not (_s3_enabled() and PULL_UPLOADS_FROM_S3):
        return None

    bump_stage("pull_step_s3_begin")
    for ext in ("step", "stp", "stl"):
        key = f"uploads/{file_id}.{ext}"
        dest = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if _s3_get(key, dest):
            bump_stage("pull_step_s3_ok", {"ext": ext, "key": key})
            return dest

    bump_stage("pull_step_s3_miss")
    return None

# ---------- OCCT loader (OCP puis OCC), minimal (STEP + tessellation) ----------
_OCCT = None
_OCCT_LIB = None

def _occt():
    """
    Charge OCCT via OCP (cadquery-ocp) en priorité, fallback OCC (pythonocc-core).
    Expose les symboles nécessaires + TopoDS pour caster les faces.
    """
    global _OCCT, _OCCT_LIB
    if _OCCT is not None:
        return _OCCT

    ocp_err = None
    try:
        from OCP import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS
        _OCCT_LIB = "OCP"
        _OCCT = {
            "STEPControl_Reader": STEPControl.STEPControl_Reader,
            "IFSelect_RetDone": IFSelect.IFSelect_RetDone,
            "TopAbs_FACE": TopAbs.TopAbs_FACE,
            "TopExp_Explorer": TopExp.TopExp_Explorer,
            "BRep_Tool": BRep.BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh.BRepMesh_IncrementalMesh,
            "TopoDS": TopoDS,
            "TopoDS_Face": getattr(TopoDS, "TopoDS_Face", None),
            "topods_Face": getattr(TopoDS, "topods_Face", None),
        }
        return _OCCT
    except Exception as e:
        ocp_err = e

    try:
        from OCC.Core import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS
        _OCCT_LIB = "OCC"
        _OCCT = {
            "STEPControl_Reader": STEPControl.STEPControl_Reader,
            "IFSelect_RetDone": IFSelect.IFSelect_RetDone,
            "TopAbs_FACE": TopAbs.TopAbs_FACE,
            "TopExp_Explorer": TopExp.TopExp_Explorer,
            "BRep_Tool": BRep.BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh.BRepMesh_IncrementalMesh,
            "TopoDS": TopoDS,
            "TopoDS_Face": getattr(TopoDS, "TopoDS_Face", None),
            "topods_Face": getattr(TopoDS, "topods_Face", None),
        }
        return _OCCT
    except Exception as e2:
        msg = "OCCT introuvable: ni OCP (cadquery-ocp) ni OCC (pythonocc-core)."
        if ocp_err:
            msg += f"\n- OCP error: {ocp_err.__class__.__name__}: {ocp_err}"
        msg += f"\n- OCC error: {e2.__class__.__name__}: {e2}"
        raise ImportError(msg) from e2

def occt_lib_name() -> Optional[str]:
    try:
        _occt()
        return _OCCT_LIB
    except Exception:
        return None

# ---------- STEP & géométrie ----------
def _read_step_shape(step_path: str):
    c = _occt()
    reader = c["STEPControl_Reader"]()
    if reader.ReadFile(step_path) != c["IFSelect_RetDone"]:
        raise RuntimeError("STEP read failed")
    if not reader.TransferRoots():
        raise RuntimeError("STEP transfer failed")
    return reader.OneShape()

def _as_face(s, c):
    """
    Convertit un TopoDS_Shape en TopoDS_Face.
    Si le cast échoue → retourne None (on skip la face).
    """
    TD = c.get("TopoDS")
    TDF = c.get("TopoDS_Face")
    tf = c.get("topods_Face")

    # 1) topods_Face si dispo
    if tf is not None:
        try:
            f = tf(s)
            return f
        except Exception:
            pass

    # 2) DownCast si dispo
    if TDF is not None and hasattr(TDF, "DownCast"):
        try:
            f = TDF.DownCast(s)
            return f
        except Exception:
            pass

    # 3) échec → on skip
    return None

def _try_mesh(shape, tol_mm: float, ang_rad: float, c):
    """Applique la tesselation OCCT (avec compat de signature)."""
    try:
        c["BRepMesh_IncrementalMesh"](shape, tol_mm, False, ang_rad, True)
    except TypeError:
        c["BRepMesh_IncrementalMesh"](shape, tol_mm, False, ang_rad)

def _collect_tris(shape, c) -> Tuple[list, list]:
    """Parcourt les faces et collecte vertices/faces. Retourne (verts, faces)."""
    verts: list[list[float]] = []
    faces: list[list[int]] = []
    v_off = 0

    exp = c["TopExp_Explorer"](shape, c["TopAbs_FACE"])
    while exp.More():
        s = exp.Current()
        exp.Next()

        f = _as_face(s, c)
        if f is None:
            continue

        loc = f.Location() if hasattr(f, "Location") else None

        BT = c["BRep_Tool"]
        tri = None
        # Triangulation()
        try:
            if hasattr(BT, "Triangulation"):
                tri = BT.Triangulation(f, loc)
        except Exception:
            tri = None
        # Triangulation_s(...)
        if tri is None and hasattr(BT, "Triangulation_s"):
            try:
                tri = BT.Triangulation_s(f, loc)
            except TypeError:
                tri = BT.Triangulation_s(f, loc, 0)

        if tri is None:
            continue

        # Extraction des noeuds/triangles selon le style de la wheel
        try:
            nodes = tri.Nodes()
            tris = tri.Triangles()
            npts, ntri = nodes.Size(), tris.Size()

            def get_node(i):
                p = nodes.Value(i)
                return (float(p.X()), float(p.Y()), float(p.Z()))

            def get_tri(i):
                t = tris.Value(i)
                a, b, cidx = t.Get()  # 1-based
                return (a, b, cidx)
        except Exception:
            try:
                npts, ntri = tri.NbNodes(), tri.NbTriangles()
            except Exception:
                continue

            def get_node(i):
                p = tri.Node(i)
                return (float(p.X()), float(p.Y()), float(p.Z()))

            def get_tri(i):
                t = tri.Triangle(i)
                a, b, cidx = t.Get()
                return (a, b, cidx)

        if npts <= 0 or ntri <= 0:
            continue

        for i in range(1, npts + 1):
            x, y, z = get_node(i)
            verts.append([x, y, z])

        for i in range(1, ntri + 1):
            a, b, cidx = get_tri(i)
            faces.append([v_off + a - 1, v_off + b - 1, v_off + cidx - 1])

        v_off += npts

    return verts, faces

def _triangulate_shape_to_mesh(shape, tol_mm: float, ang_rad: float) -> trimesh.Trimesh:
    """
    Essaie la tesselation avec (tol_mm, ang_rad). Si aucune triangulation n'est produite,
    on retente avec une tolérance plus large (x2 puis 0.2 mm) pour éviter le 'Triangulation vide'.
    """
    c = _occt()

    # Essais progressifs de tesselation (coarse fallback)
    tol_candidates = [tol_mm, max(tol_mm * 2.0, 0.05), 0.2]
    last_err = None

    for tol in tol_candidates:
        try:
            _try_mesh(shape, tol, ang_rad, c)
            verts, faces = _collect_tris(shape, c)
            if verts and faces:
                mesh = trimesh.Trimesh(
                    vertices=np.asarray(verts, dtype=float),
                    faces=np.asarray(faces, dtype=int),
                    process=True,
                )
                return mesh
        except Exception as e:
            last_err = e
            continue

    if last_err:
        raise RuntimeError(f"Triangulation vide après fallback (dernier: {last_err})")
    raise RuntimeError("Triangulation vide")

def _bbox_from_mesh_mm(mesh: trimesh.Trimesh) -> Tuple[float, float, float]:
    ex = mesh.bounds[1] - mesh.bounds[0]
    return round(float(ex[0]), 4), round(float(ex[1]), 4), round(float(ex[2]), 4)

# ---------- Projected area (Définition 1 : union 2D) ----------
def _projected_area_union_cm2(mesh: trimesh.Trimesh, axis: str) -> Tuple[float, str]:
    """
    Aire de la silhouette (union des projections orthographiques) en cm^2.
    Retourne (aire_cm2, methode), où methode est 'shapely' ou 'raster_fallback'.
    """
    axis = (axis or "Z").upper()
    if axis not in AXES:
        axis = "Z"

    # Projection des triangles en 2D
    tri3 = mesh.triangles  # (N,3,3) en mm
    if axis == "Z":
        tri2 = tri3[:, :, :2]          # XY
    elif axis == "Y":
        tri2 = tri3[:, :, [0, 2]]      # XZ
    else:
        tri2 = tri3[:, :, [1, 2]]      # YZ

    # Filtre triangles dégénérés après projection
    v0 = tri2[:, 0, :]
    v1 = tri2[:, 1, :]
    v2 = tri2[:, 2, :]
    area2d = 0.5 * np.abs(
        v0[:, 0] * (v1[:, 1] - v2[:, 1])
        + v1[:, 0] * (v2[:, 1] - v0[:, 1])
        + v2[:, 0] * (v0[:, 1] - v1[:, 1])
    )
    eps = max(float(np.linalg.norm(mesh.extents)) * 1e-12, 1e-12)
    keep = area2d > eps
    tri2 = tri2[keep]
    if tri2.shape[0] == 0:
        return 0.0, "empty"

    # Chemin principal : union exacte via Shapely
    if HAS_SHAPELY:
        CHUNK = 20000
        parts = []
        for i in range(0, tri2.shape[0], CHUNK):
            batch = tri2[i:i + CHUNK]
            polys = []
            for t in batch:
                p0 = (t[0, 0], t[0, 1])
                p1 = (t[1, 0], t[1, 1])
                p2 = (t[2, 0], t[2, 1])
                if (p0 == p1) or (p1 == p2) or (p2 == p0):
                    continue
                poly = Polygon([p0, p1, p2])
                if not poly.is_empty and poly.is_valid and poly.area > 0.0:
                    polys.append(poly)
            if polys:
                parts.append(unary_union(polys))

        if not parts:
            return 0.0, "shapely"

        uni = unary_union(parts)
        area_mm2 = float(getattr(uni, "area", 0.0))
        return round(area_mm2 / 100.0, 6), "shapely"  # mm^2 → cm^2

    # Fallback raster (approx) si Shapely absent
    if not HAS_SKIMAGE:
        return 0.0, "unavailable"

    # Rasterisation : résolution guidée par la taille et la tolérance
    bb_min = tri2.reshape(-1, 2).min(axis=0)
    bb_max = tri2.reshape(-1, 2).max(axis=0)
    span = (bb_max - bb_min)

    px_mm = max(TESSELLATION_TOL_MM, float(span.max()) / 4000.0)
    px_mm = float(np.clip(px_mm, 0.02, 0.5))  # entre 20µm et 0.5mm par pixel
    H = int(np.ceil(span[1] / px_mm)) + 2
    W = int(np.ceil(span[0] / px_mm)) + 2

    MAX_PIX = 9000
    if H > MAX_PIX or W > MAX_PIX:
        scale = max(H / MAX_PIX, W / MAX_PIX)
        px_mm *= scale
        H = int(np.ceil(span[1] / px_mm)) + 2
        W = int(np.ceil(span[0] / px_mm)) + 2

    mask = np.zeros((H, W), dtype=bool)
    for t in tri2:
        pts = (t - bb_min[None, :]) / px_mm
        rr, cc = _ski_polygon(pts[:, 1], pts[:, 0], shape=mask.shape)
        mask[rr, cc] = True

    area_mm2 = float(mask.sum()) * (px_mm ** 2)
    return round(area_mm2 / 100.0, 6), "raster_fallback"

# ---------- Thickness (optionnel) ----------
def _estimate_thickness_mm(mesh: trimesh.Trimesh, samples: int = 30000) -> Tuple[Optional[float], Optional[float]]:
    try:
        try:
            from trimesh.ray.ray_pyembree import RayMeshIntersector
            inter = RayMeshIntersector(mesh)
        except Exception:
            from trimesh.ray.ray_triangle import RayMeshIntersector
            inter = RayMeshIntersector(mesh)

        pts, f_idx = trimesh.sample.sample_surface_even(mesh, samples)
        n = mesh.face_normals[f_idx]

        bb = mesh.bounds
        diag = float(np.linalg.norm(bb[1] - bb[0]))
        eps = max(diag * 1e-5, 1e-6)
        origins_p = pts + n * eps
        origins_m = pts - n * eps

        loc_p, ir_p, it_p = inter.intersects_location(origins_p, n, multiple_hits=False)
        loc_m, ir_m, it_m = inter.intersects_location(origins_m, -n, multiple_hits=False)

        dist = np.full(len(pts), np.inf)

        if len(ir_p):
            d = np.linalg.norm(loc_p - origins_p[ir_p], axis=1)
            nf = mesh.face_normals[it_p]
            good = (np.einsum("ij,ij->i", nf, n[ir_p]) < -0.3)
            d[~good] = np.inf
            dist[ir_p] = np.minimum(dist[ir_p], d)

        if len(ir_m):
            d = np.linalg.norm(loc_m - origins_m[ir_m], axis=1)
            nf = mesh.face_normals[it_m]
            good = (np.einsum("ij,ij->i", nf, -n[ir_m]) < -0.3)
            d[~good] = np.inf
            dist[ir_m] = np.minimum(dist[ir_m], d)

        d = dist[np.isfinite(dist)]
        d = d[d > eps * 10]
        if d.size == 0:
            return None, None

        lo = np.percentile(d, 0.1)
        hi = np.percentile(d, 99.9)
        d = d[(d >= lo) & (d <= hi)]

        tmin = float(d.min())
        tmax = float(min(np.percentile(d, 99.9), float(min(mesh.extents))))
        return round(tmin, 4), round(tmax, 4)
    except Exception:
        return None, None

# ---------- Caches & Redis ----------
def _cache_paths(file_id: str, axis: str):
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    thick = os.path.join(OUTPUT_FOLDER, f"{file_id}.thick.json")
    return base, proj, thick

def _write_json(path: str, data: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)

def _publish_redis(file_id: str, axis: str, payload: dict):
    try:
        r = _redis_conn()
        key = f"shape_stats:{file_id}:{axis}"
        r.setex(key, 3600, json.dumps(payload).encode("utf-8"))
        return True
    except Exception:
        return False

# ---------- Entrypoint ----------
def compute_and_cache_stats(
    file_id: str,
    axis: str = "Z",
    step_path: Optional[str] = None,
    step_ext: Optional[str] = None,
    cache_dir: Optional[str] = None,
):
    t0 = time.monotonic()
    bump_stage("start", {"file_id": file_id, "axis": axis})

    # Trace runtime (diagnostic)
    import sys
    bump_stage("runtime_env", {
        "python": sys.executable,
        "cwd": os.getcwd(),
        "path0": sys.path[:5],
    })

    axis = (axis or "Z").upper()
    if axis not in AXES:
        axis = "Z"

    # 0) Résoudre / rapatrier le STEP local si pas fourni
    local = None
    if step_path and os.path.isfile(step_path):
        local = step_path
    else:
        local = _ensure_local_step(file_id, step_ext)

    if not local or not os.path.isfile(local):
        bump_stage("error_no_step", {"path": local or (step_path or f"/tmp/uploads/{file_id}.step")})
        raise FileNotFoundError(f"STEP introuvable pour {file_id}")

    step_path = local
    step_ext = pathlib.Path(step_path).suffix.lstrip(".")
    bump_stage("step_ready", {"step_path": step_path, "step_ext": step_ext})

    # OCCT lib (OCP/OCC) minimale (STEP + tessellation)
    lib = occt_lib_name()
    bump_stage("occt_lib", {"lib": lib})
    if lib is None:
        _ = _occt()  # force ImportError détaillé

    # 1) Read STEP
    if _deadline_reached(t0):
        raise TimeoutError("deadline before read")
    bump_stage("read_step", {"step_path": step_path})
    shape = _read_step_shape(step_path)

    # 2) Triangulation → mesh
    if _deadline_reached(t0):
        raise TimeoutError("deadline before triangulate")
    bump_stage("triangulate_begin", {"tol_mm": TESSELLATION_TOL_MM, "ang_rad": TESSELLATION_ANG_RAD})
    mesh = _triangulate_shape_to_mesh(shape, TESSELLATION_TOL_MM, TESSELLATION_ANG_RAD)
    try:
        if not mesh.is_watertight:
            mesh = mesh.fill_holes()
    except Exception:
        pass
    bump_stage("triangulate_ok", {"faces": int(mesh.faces.shape[0])})

    # 3) BBox depuis le mesh
    if _deadline_reached(t0):
        raise TimeoutError("deadline before bbox")
    bx, by, bz = _bbox_from_mesh_mm(mesh)
    bbox_mm = [bx, by, bz]
    bump_stage("bbox_ok", {"bbox_mm": bbox_mm, "method": "mesh_bounds"})

    # 4) Surface/Volume depuis le mesh
    if _deadline_reached(t0):
        raise TimeoutError("deadline before volume_surface")
    area_mm2 = float(mesh.area)
    vol_mm3 = float(abs(mesh.volume)) if np.isfinite(mesh.volume) else 0.0
    if vol_mm3 <= 0.0:
        try:
            vol_mm3 = float(abs(mesh.convex_hull.volume))
            bump_stage("volume_surface_fallback_convex_ok", {"volume_mm3": vol_mm3})
        except Exception:
            bump_stage("volume_surface_convex_fail", {})
    bump_stage("volume_surface_ok", {"vol_mm3": vol_mm3, "surf_mm2": area_mm2, "method": "mesh"})

    # 5) Aire projetée (silhouette / union 2D)
    if _deadline_reached(t0):
        raise TimeoutError("deadline before projected_area")
    bump_stage("projected_area_begin", {"axis": axis})
    proj_cm2, pa_method = _projected_area_union_cm2(mesh, axis)
    bump_stage("projected_area_ok", {"projected_area_cm2": proj_cm2, "pa_method": pa_method})

    # 6) Épaisseurs (optionnel)
    tmin = tmax = None
    if WORKER_COMPUTE_THICKNESS:
        if _deadline_reached(t0):
            raise TimeoutError("deadline before thickness")
        bump_stage("thickness_begin", {"samples": THICKNESS_SAMPLES})
        tmin, tmax = _estimate_thickness_mm(mesh, samples=THICKNESS_SAMPLES)
        bump_stage("thickness_ok", {"tmin": tmin, "tmax": tmax})

    # 7) Caches
    if _deadline_reached(t0):
        raise TimeoutError("deadline before write_caches")
    bump_stage("write_caches_begin")
    base_path, proj_path, thick_path = _cache_paths(file_id, axis)

    base_payload = {
        "volume_mm3": round(float(vol_mm3), 4),
        "volume_cm3": round(float(vol_mm3) / 1000.0, 4),
        "surface_mm2": round(float(area_mm2), 4),
        "bbox_mm": bbox_mm,
        "thickness_min_mm": tmin,
        "thickness_max_mm": tmax,
    }
    proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4), "axis": axis, "method": pa_method}

    _write_json(base_path, base_payload)
    _write_json(proj_path, proj_payload)
    if tmin is not None and tmax is not None:
        _write_json(thick_path, {"tmin": tmin, "tmax": tmax, "method": "worker_ray"})

    # 8) S3 (optionnel)
    if _s3_enabled():
        try:
            _s3_put(base_path, f"{file_id}.stats.json", content_type="application/json")
            _s3_put(proj_path, f"{file_id}.proj.{axis}.json", content_type="application/json")
            if tmin is not None and tmax is not None:
                _s3_put(thick_path, f"{file_id}.thick.json", content_type="application/json")
        except Exception:
            pass

    bump_stage("write_caches_ok")

    # 9) Redis publish
    payload = {
        "volume_mm3": base_payload["volume_mm3"],
        "volume_cm3": base_payload["volume_cm3"],
        "bbox_mm": bbox_mm,
        "projected_area_cm2": proj_payload["projected_area_cm2"],
        "thickness_min_mm": tmin,
        "thickness_max_mm": tmax,
    }
    _publish_redis(file_id, axis, payload)
    bump_stage("publish_redis_ok")

    # 10) Done
    bump_stage("done", {"lib": occt_lib_name()})
    return payload

def ping(payload: str = "ok"):
    bump_stage("ping")
    return {"pong": payload}
