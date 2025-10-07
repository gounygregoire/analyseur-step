# worker_tasks.py
import os
import json
import time
import pathlib
import tempfile
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
    from skimage.draw import polygon as _ski_polygon
    HAS_SKIMAGE = True
except Exception:
    HAS_SKIMAGE = False

# ---------- ENV ----------
UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
AXES = ("X", "Y", "Z")

STATS_SOFT_TIMEOUT_SEC = int(os.getenv("STATS_SOFT_TIMEOUT_SEC", "600"))
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

# ---------- OCCT loader (OCP puis OCC), minimal (STEP + tessellation + STL) ----------
_OCCT = None
_OCCT_LIB = None

def _occt():
    global _OCCT, _OCCT_LIB
    if _OCCT is not None:
        return _OCCT

    ocp_err = None
    try:
        from OCP import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS
        # modules optionnels
        try:
            from OCP.StlAPI import StlAPI_Writer
        except Exception:
            StlAPI_Writer = None
        try:
            from OCP.BRepTools import BRepTools
        except Exception:
            BRepTools = None
        try:
            from OCP.ShapeFix import ShapeFix_Shape
        except Exception:
            ShapeFix_Shape = None

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
            "StlAPI_Writer": StlAPI_Writer,
            "BRepTools": BRepTools,
            "ShapeFix_Shape": ShapeFix_Shape,
        }
        return _OCCT
    except Exception as e:
        ocp_err = e

    try:
        from OCC.Core import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS, StlAPI, BRepTools, ShapeFix
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
            "StlAPI_Writer": getattr(StlAPI, "StlAPI_Writer", None),
            "BRepTools": BRepTools.BRepTools,
            "ShapeFix_Shape": ShapeFix.ShapeFix_Shape,
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
    Convertit un TopoDS_Shape en TopoDS_Face (OCP 7.7.x : topods_Face, sinon DownCast).
    """
    tf = c.get("topods_Face")
    if tf is not None:
        try:
            f = tf(s); _ = f.Location()
            return f
        except Exception:
            pass
    TDF = c.get("TopoDS_Face")
    if TDF is not None and hasattr(TDF, "DownCast"):
        try:
            f = TDF.DownCast(s); _ = f.Location()
            return f
        except Exception:
            pass
    return None

def _face_triangulation(face, c):
    """
    Retourne la Poly_Triangulation si accrochée à la face (multi-API).
    """
    BT = c["BRep_Tool"]
    loc = face.Location()
    if hasattr(BT, "Triangulation_s"):
        for args in ((face, loc), (face, loc, 0), (face, loc, 1), (face, loc, 2)):
            try:
                tri = BT.Triangulation_s(*args)
                if tri is not None:
                    return tri
            except TypeError:
                continue
            except Exception:
                continue
    if hasattr(BT, "Triangulation"):
        try:
            return BT.Triangulation(face, loc)
        except Exception:
            return None
    return None

def _triangulation_sizes(tri) -> Tuple[int, int]:
    if tri is None:
        return 0, 0
    try:
        return tri.Nodes().Size(), tri.Triangles().Size()
    except Exception:
        try:
            return tri.NbNodes(), tri.NbTriangles()
        except Exception:
            return 0, 0

def _heal_shape(shape, c):
    # Healing doux pour fiabiliser le maillage / STL
    try:
        SFS = c.get("ShapeFix_Shape")
        if SFS:
            fixer = SFS(shape)
            fixer.Perform()
            shape = fixer.Shape()
    except Exception:
        pass
    try:
        BRT = c.get("BRepTools")
        if BRT:
            try: BRT.Clean(shape)
            except Exception: pass
            try: BRT.Update(shape)
            except Exception: pass
    except Exception:
        pass
    return shape

def _mesh_any(target, c, tol_mm: float, ang_rad: float):
    # Essaye plusieurs signatures de BRepMesh_IncrementalMesh
    ok = False
    try:
        c["BRepMesh_IncrementalMesh"](target, tol_mm, False, ang_rad, True)
        ok = True
    except TypeError:
        pass
    if not ok:
        try:
            c["BRepMesh_IncrementalMesh"](target, tol_mm, False, ang_rad)
            ok = True
        except TypeError:
            pass
    if not ok:
        try:
            c["BRepMesh_IncrementalMesh"](target, tol_mm)
            ok = True
        except Exception:
            pass
    return ok

def _shape_to_trimesh_via_stl(shape, tol_mm: float, ang_rad: float) -> Optional[trimesh.Trimesh]:
    """
    Fallback robuste : maillage OCCT + export STL + chargement via trimesh.
    """
    c = _occt()
    shape = _heal_shape(shape, c)

    # déflection auto (borne 0.02..0.5 mm) ~ 0.1% du diag
    try:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib
        bb = Bnd_Box(); BRepBndLib.Add(shape, bb)
        xmin, ymin, zmin, xmax, ymax, zmax = bb.Get()
        diag = float(((xmax-xmin)**2 + (ymax-ymin)**2 + (zmax-zmin)**2) ** 0.5)
    except Exception:
        diag = 10.0
    defl = max(0.0005 * diag, tol_mm)
    defl = float(np.clip(defl, 0.02, 0.5))

    _mesh_any(shape, c, defl, max(ang_rad, TESSELLATION_ANG_RAD))

    writer = c.get("StlAPI_Writer")
    if writer is None:
        return None

    stl_path = tempfile.mkstemp(prefix="cadlytics_", suffix=".stl")[1]
    try:
        w = writer()
        try:
            w.SetASCIIMode(False)
        except Exception:
            pass
        ok = bool(w.Write(shape, stl_path))
        if not ok:
            return None

        m = trimesh.load(stl_path, file_type="stl", force="mesh")
        if isinstance(m, trimesh.Scene):
            m = trimesh.util.concatenate(m.dump())
        if m is None or m.faces is None or m.faces.shape[0] == 0:
            return None
        # nettoyage doux
        try:
            if not m.is_watertight:
                m = m.fill_holes()
        except Exception:
            pass
        return m
    finally:
        try:
            os.remove(stl_path)
        except Exception:
            pass

def _triangulate_shape_to_mesh(shape, tol_mm: float, ang_rad: float) -> trimesh.Trimesh:
    # --- FORCE le fallback STL si demandé par une variable d'env ---
    if str(os.getenv("FORCE_STL_FALLBACK", "0")).lower() in ("1", "true", "yes", "on"):
        bump_stage("triangulate_forced_fallback_stl")
        m = _shape_to_trimesh_via_stl(shape, tol_mm, ang_rad)
        if m is None or m.faces is None or m.faces.shape[0] == 0:
            raise RuntimeError("Fallback STL a échoué")
        return m
    # --- (le code existant continue ici) ---
    """
    1) tente la triangulation “native” OCCT par faces (si la wheel l’expose),
    2) si vide → fallback STL (export puis lecture trimesh).
    """
    c = _occt()
    shape = _heal_shape(shape, c)

    # Maillage global (au cas où) – certaines wheels n’attachent pas le tri aux faces
    _mesh_any(shape, c, tol_mm, ang_rad)

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

        tri = _face_triangulation(f, c)
        npts, ntri = _triangulation_sizes(tri)
        if npts == 0 or ntri == 0:
            # tente re-mesh local de la face
            try:
                _mesh_any(f, c, tol_mm, ang_rad)
                tri = _face_triangulation(f, c)
                npts, ntri = _triangulation_sizes(tri)
            except Exception:
                tri = None
                npts = ntri = 0

        if npts == 0 or ntri == 0:
            continue

        # extraction (2 API possibles)
        try:
            nodes = tri.Nodes()
            tris = tri.Triangles()
            def get_node(i):
                p = nodes.Value(i); return (float(p.X()), float(p.Y()), float(p.Z()))
            def get_tri(i):
                t = tris.Value(i); a, b, cidx = t.Get(); return (a, b, cidx)
        except Exception:
            def get_node(i):
                p = tri.Node(i); return (float(p.X()), float(p.Y()), float(p.Z()))
            def get_tri(i):
                t = tri.Triangle(i); a, b, cidx = t.Get(); return (a, b, cidx)

        for i in range(1, npts + 1):
            x, y, z = get_node(i)
            verts.append([x, y, z])

        for i in range(1, ntri + 1):
            a, b, cidx = get_tri(i)
            faces.append([v_off + a - 1, v_off + b - 1, v_off + cidx - 1])

        v_off += npts

    if not verts or not faces:
        bump_stage("triangulate_native_empty")
        m = _shape_to_trimesh_via_stl(shape, tol_mm, ang_rad)
        if m is None or m.faces is None or m.faces.shape[0] == 0:
            raise RuntimeError("Triangulation vide (native + STL fallback)")
        bump_stage("triangulate_fallback_stl_ok", {"faces": int(m.faces.shape[0])})
        return m

    mesh = trimesh.Trimesh(
        vertices=np.asarray(verts, dtype=float),
        faces=np.asarray(faces, dtype=int),
        process=True,
    )
    return mesh

def _bbox_from_mesh_mm(mesh: trimesh.Trimesh) -> Tuple[float, float, float]:
    ex = mesh.bounds[1] - mesh.bounds[0]
    return round(float(ex[0]), 4), round(float(ex[1]), 4), round(float(ex[2]), 4)

# ---------- Projected area (Définition 1 : union 2D) ----------
def _projected_area_union_cm2(mesh: trimesh.Trimesh, axis: str) -> Tuple[float, str]:
    """
    Aire de la silhouette (union des projections orthographiques) en cm^2.
    Retourne (aire_cm2, methode), où methode ∈ {'shapely','raster_fallback','empty','unavailable'}.
    """
    axis = (axis or "Z").upper()
    if axis not in AXES:
        axis = "Z"

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
        v0[:, 0] * (v1[:, 1] - v2[:, 1]) +
        v1[:, 0] * (v2[:, 1] - v0[:, 1]) +
        v2[:, 0] * (v0[:, 1] - v1[:, 1])
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
            batch = tri2[i:i+CHUNK]
            polys = []
            for t in batch:
                p0, p1, p2 = (t[0, 0], t[0, 1]), (t[1, 0], t[1, 1]), (t[2, 0], t[2, 1])
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
        return round(area_mm2 / 100.0, 6), "shapely"  # mm^2 -> cm^2

    # Fallback raster (approx) si Shapely absent
    if not HAS_SKIMAGE:
        return 0.0, "unavailable"

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
    """
    Épaisseur locale estimée par tir de rayons double-face :
    - pour chaque point surfacique, on tire un rayon dans +n et un dans -n
    - si les deux intersectent, on somme les deux distances (épaisseur traversée)
    - si un seul intersecte (bord/ouverture), on garde cette distance
    Pas de filtrage par orientation des faces -> robuste aux normales incohérentes.
    """
    try:
        try:
            from trimesh.ray.ray_pyembree import RayMeshIntersector   # rapide si dispo
            inter = RayMeshIntersector(mesh)
        except Exception:
            from trimesh.ray.ray_triangle import RayMeshIntersector   # fallback pur numpy
            inter = RayMeshIntersector(mesh)

        # Échantillons surfaciques quasi-uniformes
        pts, f_idx = trimesh.sample.sample_surface_even(mesh, samples)
        n = mesh.face_normals[f_idx]

        # Petits décalages pour éviter l’auto-intersection
        bb = mesh.bounds
        diag = float(np.linalg.norm(bb[1] - bb[0]))
        eps = max(diag * 1e-6, 1e-6)

        # Garde-fou : une épaisseur ne peut pas dépasser ~1.5× la plus petite dimension
        cap = float(mesh.extents.min()) * 1.5

        # Deux jeux de rayons (origines légèrement décalées)
        ori_a = pts - n * eps;  dir_a =  n
        ori_b = pts + n * eps;  dir_b = -n

        loc_a, ia, _ = inter.intersects_location(ori_a, dir_a, multiple_hits=False)
        loc_b, ib, _ = inter.intersects_location(ori_b, dir_b, multiple_hits=False)

        # Distances côté +n
        dist_a = np.full(len(pts), np.nan)
        if len(ia):
            da = np.linalg.norm(loc_a - ori_a[ia], axis=1)
            dist_a[ia] = da

        # Distances côté -n
        dist_b = np.full(len(pts), np.nan)
        if len(ib):
            db = np.linalg.norm(loc_b - ori_b[ib], axis=1)
            dist_b[ib] = db

        # Combine : somme si deux côtés, sinon le côté disponible
        thickness = np.zeros(len(pts), dtype=float)
        has_a = np.isfinite(dist_a); has_b = np.isfinite(dist_b)
        both  = has_a & has_b
        only_a = has_a & ~has_b
        only_b = has_b & ~has_a

        thickness[both]   = dist_a[both] + dist_b[both]
        thickness[only_a] = dist_a[only_a]
        thickness[only_b] = dist_b[only_b]

        # Nettoyage : distances non triviales, bornées
        good = (thickness > eps * 5) & np.isfinite(thickness) & (thickness < cap)
        thickness = thickness[good]
        if thickness.size == 0:
            return None, None

        # Bornes robustes (réduction d’outliers)
        lo_q = float(np.percentile(thickness, 0.5))
        hi_q = float(np.percentile(thickness, 99.5))
        sel = thickness[(thickness >= lo_q) & (thickness <= hi_q)]
        if sel.size == 0:
            sel = thickness

        tmin = float(sel.min())
        tmax = float(min(sel.max(), float(mesh.extents.min())))
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

    import sys
    bump_stage("runtime_env", {
        "python": sys.executable,
        "cwd": os.getcwd(),
        "path0": sys.path[:5],
    })

    axis = (axis or "Z").upper()
    if axis not in AXES:
        axis = "Z"

    # 0) STEP local
    local = step_path if (step_path and os.path.isfile(step_path)) else _ensure_local_step(file_id, step_ext)
    if not local or not os.path.isfile(local):
        bump_stage("error_no_step", {"path": local or (step_path or f"/tmp/uploads/{file_id}.step")})
        raise FileNotFoundError(f"STEP introuvable pour {file_id}")

    step_path = local
    step_ext = pathlib.Path(step_path).suffix.lstrip(".")
    bump_stage("step_ready", {"step_path": step_path, "step_ext": step_ext})

    # OCCT lib
    lib = occt_lib_name()
    bump_stage("occt_lib", {"lib": lib})
    if lib is None:
        _ = _occt()  # force ImportError détaillé

    # 1) Read STEP
    if _deadline_reached(t0):
        raise TimeoutError("deadline before read")
    bump_stage("read_step", {"step_path": step_path})
    shape = _read_step_shape(step_path)

    # 2) Triangulation → mesh (avec fallback STL)
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

    # 3) BBox
    if _deadline_reached(t0):
        raise TimeoutError("deadline before bbox")
    bx, by, bz = _bbox_from_mesh_mm(mesh)
    bbox_mm = [bx, by, bz]
    bump_stage("bbox_ok", {"bbox_mm": bbox_mm, "method": "mesh_bounds"})

    # 4) Surface/Volume
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
