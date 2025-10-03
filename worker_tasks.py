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

# ---------- ENV ----------
UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.getenv("OUTPUT_FOLDER", "/tmp/converted")
AXES = ("X", "Y", "Z")

STATS_SOFT_TIMEOUT_SEC = int(os.getenv("STATS_SOFT_TIMEOUT_SEC", "600"))  # 10 min
TESSELLATION_TOL_MM = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
TESSELLATION_ANG_RAD = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))
# passes fines supplémentaires et voxel fallback
TESSELLATION_TOL_MM_FINE = float(os.getenv("TESSELLATION_TOL_MM_FINE", "0.02"))
TESSELLATION_ANG_RAD_FINE = float(os.getenv("TESSELLATION_ANG_RAD_FINE", "0.10"))
TESSELLATION_TOL_MM_ULTRA = float(os.getenv("TESSELLATION_TOL_MM_ULTRA", "0.008"))
TESSELLATION_ANG_RAD_ULTRA = float(os.getenv("TESSELLATION_ANG_RAD_ULTRA", "0.07"))

# voxelisation (dernière ligne de défense si le mesh n'est pas étanche)
VOXEL_PITCH_MM = float(os.getenv("VOXEL_PITCH_MM", "0.05"))  # 50 µm par défaut

WORKER_COMPUTE_THICKNESS = str(os.getenv("WORKER_COMPUTE_THICKNESS", "0")).lower() in ("1", "true", "yes", "on")
THICKNESS_SAMPLES = int(os.getenv("THICKNESS_SAMPLES", "30000"))
PULL_UPLOADS_FROM_S3 = str(os.getenv("PULL_UPLOADS_FROM_S3", "1")).lower() in ("1", "true", "yes", "on")

# ---------- Redis ----------
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

# ---------- S3 ----------
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
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    for ext in (step_ext_hint, "step", "stp", "stl"):
        if not ext:
            continue
        e = ext if str(ext).startswith(".") else f".{ext}"
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}{e}")
        if os.path.isfile(p):
            return p
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

# ---------- Detect STEP units ----------
def _detect_step_unit_scale(step_path: str) -> Tuple[float, str]:
    try:
        with open(step_path, "r", errors="ignore") as f:
            head = f.read(20000).upper()
    except Exception:
        return 1.0, "unknown"
    if "INCH" in head:
        return 25.4, "inch"
    if "SI_UNIT(.MILLI." in head:
        return 1.0, "mm"
    if "SI_UNIT(.CENTI." in head:
        return 10.0, "cm"
    if "SI_UNIT(.DECI." in head:
        return 100.0, "dm"
    if "SI_UNIT(.MICRO." in head:
        return 0.001, "micrometre"
    if "SI_UNIT" in head and "METRE" in head:
        return 1000.0, "metre"
    return 1.0, "assumed_mm"

# ---------- OCCT (OCP puis OCC) ----------
_OCCT = None
_OCCT_LIB = None

def _occt():
    global _OCCT, _OCCT_LIB
    if _OCCT is not None:
        return _OCCT

    ocp_err = None
    try:
        from OCP import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS as TopoDS_mod
        try:
            from OCP.TopoDS import TopoDS_Face as TopoDS_Face_cls
        except Exception:
            TopoDS_Face_cls = None
        _OCCT_LIB = "OCP"
        _OCCT = {
            "STEPControl_Reader": STEPControl.STEPControl_Reader,
            "IFSelect_RetDone": IFSelect.IFSelect_RetDone,
            "TopAbs_FACE": TopAbs.TopAbs_FACE,
            "TopExp_Explorer": TopExp.TopExp_Explorer,
            "BRep_Tool": BRep.BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh.BRepMesh_IncrementalMesh,
            "TopoDS_module": TopoDS_mod,
            "TopoDS_Face_cls": TopoDS_Face_cls,
        }
        return _OCCT
    except Exception as e:
        ocp_err = e

    try:
        from OCC.Core import STEPControl, IFSelect, TopAbs, TopExp, BRep, BRepMesh, TopoDS as TopoDS_mod
        from OCC.Core.TopoDS import TopoDS_Face as TopoDS_Face_cls
        _OCCT_LIB = "OCC"
        _OCCT = {
            "STEPControl_Reader": STEPControl.STEPControl_Reader,
            "IFSelect_RetDone": IFSelect.IFSelect_RetDone,
            "TopAbs_FACE": TopAbs.TopAbs_FACE,
            "TopExp_Explorer": TopExp.TopExp_Explorer,
            "BRep_Tool": BRep.BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh.BRepMesh_IncrementalMesh,
            "TopoDS_module": TopoDS_mod,
            "TopoDS_Face_cls": TopoDS_Face_cls,
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

# ---------- TopoDS helpers ----------
def _to_face(obj, c):
    TDF = c.get("TopoDS_Face_cls")
    TDm = c.get("TopoDS_module")
    if TDF is not None and hasattr(TDF, "DownCast"):
        face = TDF.DownCast(obj)
        if face is not None:
            return face
    func = getattr(TDm, "topods_Face", None)
    if callable(func):
        try:
            return func(obj)
        except Exception:
            pass
    TDclass = getattr(TDm, "TopoDS", None)
    if TDclass is not None and hasattr(TDclass, "Face_s"):
        try:
            return TDclass.Face_s(obj)
        except Exception:
            pass
    raise TypeError("Impossible de caster Shape->Face (Topods helpers non dispo)")

# ---------- STEP & triangulation ----------
def _read_step_shape(step_path: str):
    c = _occt()
    reader = c["STEPControl_Reader"]()
    if reader.ReadFile(step_path) != c["IFSelect_RetDone"]:
        raise RuntimeError("STEP read failed")
    if not reader.TransferRoots():
        raise RuntimeError("STEP transfer failed")
    return reader.OneShape()

def _face_triangulation(face, loc, c):
    BT = c["BRep_Tool"]
    face = _to_face(face, c)
    if hasattr(BT, "Triangulation"):
        return BT.Triangulation(face, loc)
    if hasattr(BT, "Triangulation_s"):
        try:
            return BT.Triangulation_s(face, loc)
        except TypeError:
            return BT.Triangulation_s(face, loc, 0)
    raise AttributeError("Aucune méthode Triangulation(_s) disponible sur BRep_Tool")

def _mesh_repair_inplace(mesh: trimesh.Trimesh):
    try:
        mesh.remove_duplicate_faces()
        mesh.remove_degenerate_faces()
        mesh.remove_unreferenced_vertices()
        trimesh.repair.fix_normals(mesh)  # oriente et recalcule si besoin
        # boucher les petits trous
        try:
            mesh.fill_holes()
        except Exception:
            pass
        # soude les sommets très proches
        mesh.merge_vertices(epsilon=1e-6)
    except Exception:
        pass

def _voxel_volume_mm3(mesh: trimesh.Trimesh, pitch_mm: float) -> float:
    """
    Estimation volumique robuste via voxélisation + remplissage.
    Utile si le mesh n'est pas étanche (trous). Renvoie mm^3.
    """
    try:
        vg = mesh.voxelized(pitch_mm)
        vf = vg.fill()
        # selon les versions de trimesh : .matrix (bool ndarray) ou .points
        try:
            n = int(np.sum(vf.matrix))
        except Exception:
            n = int(getattr(vf, "points", np.empty((0, 3))).shape[0])
        return float(n) * (pitch_mm ** 3)
    except Exception:
        return 0.0


def _triangulate_shape_to_mesh(shape, tol_mm: float, ang_rad: float) -> trimesh.Trimesh:
    c = _occt()

    def _remesh(tol, ang):
        try:
            c["BRepMesh_IncrementalMesh"](shape, tol, False, ang, True)
        except TypeError:
            try:
                c["BRepMesh_IncrementalMesh"](shape, tol, False, ang)
            except TypeError:
                c["BRepMesh_IncrementalMesh"](shape, tol)

    def _collect() -> trimesh.Trimesh:
        verts, faces = [], []
        v_off = 0
        exp = c["TopExp_Explorer"](shape, c["TopAbs_FACE"])
        while exp.More():
            f = exp.Current()
            loc = f.Location()
            tri = _face_triangulation(f, loc, c)
            if tri is None:
                exp.Next(); continue
            try:
                nodes = tri.Nodes(); tris = tri.Triangles()
                npts = nodes.Size(); ntri = tris.Size()
                def get_node(i):
                    p = nodes.Value(i); return (float(p.X()), float(p.Y()), float(p.Z()))
                def get_tri(i):
                    t = tris.Value(i); a,b,cidx = t.Get(); return (a,b,cidx)
            except Exception:
                npts = tri.NbNodes(); ntri = tri.NbTriangles()
                def get_node(i):
                    p = tri.Node(i); return (float(p.X()), float(p.Y()), float(p.Z()))
                def get_tri(i):
                    t = tri.Triangle(i); a,b,cidx = t.Get(); return (a,b,cidx)
            if npts <= 0 or ntri <= 0:
                exp.Next(); continue
            for i in range(1, npts + 1):
                x,y,z = get_node(i); verts.append([x,y,z])
            for i in range(1, ntri + 1):
                a,b,cidx = get_tri(i)
                faces.append([v_off + a - 1, v_off + b - 1, v_off + cidx - 1])
            v_off += npts
            exp.Next()
        if not verts or not faces:
            raise RuntimeError("Triangulation vide")
        m = trimesh.Trimesh(vertices=np.asarray(verts, dtype=float),
                            faces=np.asarray(faces, dtype=int),
                            process=True)
        _mesh_repair_inplace(m)
        return m

    # passe 1
    _remesh(tol_mm, ang_rad)
    mesh = _collect()

    # passe 2 (fine) si nécessaire
    if (not mesh.is_watertight) or (len(mesh.faces) < 2000):
        try:
            _remesh(TESSELLATION_TOL_MM_FINE, TESSELLATION_ANG_RAD_FINE)
            mesh = _collect()
        except Exception:
            pass

    # passe 3 (ultra) si toujours pas étanche et nombre de faces faible
    if (not mesh.is_watertight) or (len(mesh.faces) < 2000):
        try:
            _remesh(TESSELLATION_TOL_MM_ULTRA, TESSELLATION_ANG_RAD_ULTRA)
            mesh = _collect()
        except Exception:
            pass

    return mesh

# ---------- BBox ----------
def _bbox_from_mesh_mm(mesh: trimesh.Trimesh) -> Tuple[float, float, float]:
    ex = mesh.bounds[1] - mesh.bounds[0]
    return round(float(ex[0]), 4), round(float(ex[1]), 4), round(float(ex[2]), 4)

# ---------- Aire projetée (cm²) ----------
def _projected_area_cm2(mesh: trimesh.Trimesh, axis: str) -> float:
    axis = (axis or "Z").upper()
    if axis not in AXES:
        axis = "Z"
    if axis == "Z":
        tri = mesh.triangles[:, :, :2]
    elif axis == "Y":
        tri = mesh.triangles[:, :, [0, 2]]
    else:
        tri = mesh.triangles[:, :, [1, 2]]
    v0, v1, v2 = tri[:, 0, :], tri[:, 1, :], tri[:, 2, :]
    area2d = 0.5 * np.abs(
        v0[:, 0] * (v1[:, 1] - v2[:, 1]) +
        v1[:, 0] * (v2[:, 1] - v0[:, 1]) +
        v2[:, 0] * (v0[:, 1] - v1[:, 1])
    )
    return float(area2d.sum()) / 100.0

# ---------- Épaisseur ----------
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

        loc_p, ir_p, _ = inter.intersects_location(origins_p, n, multiple_hits=False)
        loc_m, ir_m, _ = inter.intersects_location(origins_m, -n, multiple_hits=False)

        dist = np.full(len(pts), np.inf)
        if len(ir_p):
            d = np.linalg.norm(loc_p - origins_p[ir_p], axis=1)
            dist[ir_p] = np.minimum(dist[ir_p], d)
        if len(ir_m):
            d = np.linalg.norm(loc_m - origins_m[ir_m], axis=1)
            dist[ir_m] = np.minimum(dist[ir_m], d)

        d = dist[np.isfinite(dist)]
        if d.size == 0:
            return None, None

        min_keep = max(5 * eps, 1e-5)
        max_keep = diag * 0.75
        d = d[(d > min_keep) & (d < max_keep)]
        if d.size < 20:
            return None, None

        lo = np.percentile(d, 0.1)
        hi = np.percentile(d, 99.9)
        d = d[(d >= lo) & (d <= hi)]

        return round(float(d.min()), 4), round(float(np.percentile(d, 99.5)), 4)
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
        _ = _occt()  # lève un ImportError détaillé

    # 1) Read STEP
    if _deadline_reached(t0):
        raise TimeoutError("deadline before read")
    bump_stage("read_step", {"step_path": step_path})
    shape = _read_step_shape(step_path)

    # 2) Triangulation → mesh (base de tous les calculs)
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

    # 3) BBox depuis le mesh (robuste à tous bindings)
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

    # 5) Aire projetée
    if _deadline_reached(t0):
        raise TimeoutError("deadline before projected_area")
    bump_stage("projected_area_begin", {"axis": axis})
    proj_cm2 = _projected_area_cm2(mesh, axis)
    bump_stage("projected_area_ok", {"projected_area_cm2": proj_cm2})

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
    proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4), "axis": axis}

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
