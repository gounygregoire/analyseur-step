# worker_tasks.py
import os
import json
import time
import uuid
import math
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

# ---------- OCCT loader (log détaillé) ----------
_OCCT = None
_OCCT_LIB = None

def _occt():
    """
    Charge OCCT via OCP (cadquery-ocp) en priorité, fallback pythonocc-core.
    En cas d'échec, lève ImportError avec les VRAIES raisons (OCP puis OCC).
    """
    global _OCCT, _OCCT_LIB
    if _OCCT is not None:
        return _OCCT

    ocp_err = None
    occ_err = None

    # Tentative OCP (cadquery-ocp)
    try:
        from OCP.STEPControl import STEPControl_Reader
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.BRepGProp import brepgprop_VolumeProperties, brepgprop_SurfaceProperties
        from OCP.GProp import GProp_GProps
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import brepbndlib_Add
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp_Explorer
        from OCP.BRep import BRep_Tool
        from OCP.BRepMesh import BRepMesh_IncrementalMesh

        _OCCT_LIB = "OCP"
        _OCCT = {
            "STEPControl_Reader": STEPControl_Reader,
            "IFSelect_RetDone": IFSelect_RetDone,
            "brepgprop_VolumeProperties": brepgprop_VolumeProperties,
            "brepgprop_SurfaceProperties": brepgprop_SurfaceProperties,
            "GProp_GProps": GProp_GProps,
            "Bnd_Box": Bnd_Box,
            "brepbndlib_Add": brepbndlib_Add,
            "TopAbs_FACE": TopAbs_FACE,
            "TopExp_Explorer": TopExp_Explorer,
            "BRep_Tool": BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh_IncrementalMesh,
        }
        return _OCCT
    except Exception as e:
        import traceback
        ocp_err = f"{e.__class__.__name__}: {e}"
        ocp_tb = traceback.format_exc()

    # Tentative OCC (pythonocc-core)
    try:
        from OCC.Core.STEPControl import STEPControl_Reader
        from OCC.Core.IFSelect import IFSelect_RetDone
        from OCC.Core.BRepGProp import brepgprop_VolumeProperties, brepgprop_SurfaceProperties
        from OCC.Core.GProp import GProp_GProps
        from OCC.Core.Bnd import Bnd_Box
        from OCC.Core.BRepBndLib import brepbndlib_Add
        from OCC.Core.TopAbs import TopAbs_FACE
        from OCC.Core.TopExp import TopExp_Explorer
        from OCC.Core.BRep import BRep_Tool
        from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh

        _OCCT_LIB = "OCC"
        _OCCT = {
            "STEPControl_Reader": STEPControl_Reader,
            "IFSelect_RetDone": IFSelect_RetDone,
            "brepgprop_VolumeProperties": brepgprop_VolumeProperties,
            "brepgprop_SurfaceProperties": brepgprop_SurfaceProperties,
            "GProp_GProps": GProp_GProps,
            "Bnd_Box": Bnd_Box,
            "brepbndlib_Add": brepbndlib_Add,
            "TopAbs_FACE": TopAbs_FACE,
            "TopExp_Explorer": TopExp_Explorer,
            "BRep_Tool": BRep_Tool,
            "BRepMesh_IncrementalMesh": BRepMesh_IncrementalMesh,
        }
        return _OCCT
    except Exception as e2:
        import traceback
        occ_err = f"{e2.__class__.__name__}: {e2}"
        occ_tb = traceback.format_exc()

    msg = "OCCT introuvable: ni OCP (cadquery-ocp) ni OCC (pythonocc-core)."
    if ocp_err:
        msg += f"\n- OCP error: {ocp_err}"
        if 'ocp_tb' in locals():
            msg += f"\n{ocp_tb}"
    if occ_err:
        msg += f"\n- OCC error: {occ_err}"
        if 'occ_tb' in locals():
            msg += f"\n{occ_tb}"
    raise ImportError(msg)

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

def _shape_bbox_mm(shape) -> Tuple[float, float, float, float, float, float]:
    c = _occt()
    box = c["Bnd_Box"]()
    box.SetGap(0.0)
    c["brepbndlib_Add"](shape, box, False)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return float(xmin), float(ymin), float(zmin), float(xmax), float(ymax), float(zmax)

def _shape_volume_surface_mm(shape) -> Tuple[float, float]:
    c = _occt()
    g = c["GProp_GProps"]()
    c["brepgprop_VolumeProperties"](shape, g)
    vol = float(g.Mass())  # mm^3
    g2 = c["GProp_GProps"]()
    c["brepgprop_SurfaceProperties"](shape, g2)
    area = float(g2.Mass())  # mm^2
    return vol, area

def _triangulate_shape_to_mesh(shape, tol_mm: float, ang_rad: float) -> trimesh.Trimesh:
    c = _occt()
    c["BRepMesh_IncrementalMesh"](shape, tol_mm, False, ang_rad, True)

    verts: list[list[float]] = []
    faces: list[list[int]] = []
    v_off = 0

    exp = c["TopExp_Explorer"](shape, c["TopAbs_FACE"])
    while exp.More():
        f = exp.Current()
        loc = f.Location()
        tri = c["BRep_Tool"].Triangulation(f, loc)
        if tri is not None:
            nodes = tri.Nodes()
            tris = tri.Triangles()
            npts = nodes.Size()
            ntri = tris.Size()
            for i in range(1, npts + 1):
                p = nodes.Value(i)
                verts.append([float(p.X()), float(p.Y()), float(p.Z())])
            for i in range(1, ntri + 1):
                t = tris.Value(i)
                a, b, cidx = t.Get()
                faces.append([v_off + a - 1, v_off + b - 1, v_off + cidx - 1])
            v_off += npts
        exp.Next()

    if not verts or not faces:
        raise RuntimeError("Triangulation vide")

    mesh = trimesh.Trimesh(
        vertices=np.asarray(verts, dtype=float),
        faces=np.asarray(faces, dtype=int),
        process=True,
    )
    return mesh

# ---------- Projected area (cm^2) ----------
def _projected_area_cm2(mesh: trimesh.Trimesh, axis: str) -> float:
    axis = axis.upper()
    if axis not in AXES:
        axis = "Z"

    if axis == "Z":
        tri = mesh.triangles[:, :, :2]           # XY
    elif axis == "Y":
        tri = mesh.triangles[:, :, [0, 2]]       # XZ
    else:
        tri = mesh.triangles[:, :, [1, 2]]       # YZ

    v0 = tri[:, 0, :]
    v1 = tri[:, 1, :]
    v2 = tri[:, 2, :]
    area2d = 0.5 * np.abs(
        v0[:, 0] * (v1[:, 1] - v2[:, 1]) +
        v1[:, 0] * (v2[:, 1] - v0[:, 1]) +
        v2[:, 0] * (v0[:, 1] - v1[:, 1])
    )
    mm2 = float(area2d.sum())
    return mm2 / 100.0  # mm^2 -> cm^2

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

    # OCCT lib (OCP/OCC)
    try:
        lib = occt_lib_name()
        bump_stage("occt_lib", {"lib": lib})
        if lib is None:
            raise ImportError("Aucune lib OCCT disponible (ni OCP ni OCC)")
    except Exception as e:
        bump_stage("occt_import_fail", {"occt_error": repr(e)})
        raise

    # 1) Read STEP
    if _deadline_reached(t0):
        raise TimeoutError("deadline before read")
    bump_stage("read_step", {"step_path": step_path})
    shape = _read_step_shape(step_path)

    # 2) BBox
    if _deadline_reached(t0):
        raise TimeoutError("deadline before bbox")
    xmin, ymin, zmin, xmax, ymax, zmax = _shape_bbox_mm(shape)
    bbox_mm = [
        round(float(xmax - xmin), 4),
        round(float(ymax - ymin), 4),
        round(float(zmax - zmin), 4),
    ]
    bump_stage("bbox_ok", {"bbox_mm": bbox_mm})

    # 3) Volume / Surface
    if _deadline_reached(t0):
        raise TimeoutError("deadline before volume_surface")
    bump_stage("volume_surface_begin")
    vol_mm3, surf_mm2 = _shape_volume_surface_mm(shape)
    bump_stage("volume_surface_ok", {"vol_mm3": vol_mm3, "surf_mm2": surf_mm2})

    # 4) Triangulation → mesh
    if _deadline_reached(t0):
        raise TimeoutError("deadline before triangulate")
    bump_stage("triangulate_begin")
    mesh = _triangulate_shape_to_mesh(shape, TESSELLATION_TOL_MM, TESSELLATION_ANG_RAD)
    try:
        if not mesh.is_watertight:
            mesh = mesh.fill_holes()
    except Exception:
        pass
    bump_stage("triangulate_ok", {"faces": int(mesh.faces.shape[0])})

    # 5) Projected area
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
        "surface_mm2": round(float(surf_mm2), 4),
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
