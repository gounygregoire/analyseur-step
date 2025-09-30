# worker_tasks.py
from __future__ import annotations
import os, json, pathlib, logging
from typing import Optional, Tuple, List

logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))
logger = logging.getLogger(__name__)

# ----------------- ENV helpers -----------------
def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")

def env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    try:
        return float(v) if v is not None else default
    except Exception:
        return default

# ----------------- Dossiers -----------------
UPLOAD_FOLDER  = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER  = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# ----------------- S3 helpers (optionnels) -----------------
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _s3_put(local_path: str, key: str, content_type: Optional[str] = None) -> bool:
    if not _s3_enabled():
        return False
    try:
        from s3io import put_file
        ok = put_file(local_path, key, content_type=content_type)
        if not ok:
            logger.warning("[worker] S3 put_file returned False key=%s", key)
        return bool(ok)
    except Exception as e:
        logger.warning("[worker] S3 upload failed key=%s: %s", key, e)
        return False

def _s3_get(key: str, dest_path: str) -> bool:
    if not _s3_enabled():
        return False
    try:
        from s3io import get_file
        ok = get_file(key, dest_path)
        return bool(ok and os.path.isfile(dest_path))
    except Exception as e:
        logger.warning("[worker] S3 get_file failed key=%s: %s", key, e)
        return False

# ----------------- Caches -----------------
def _cache_paths(file_id: str, axis: str) -> Tuple[str, str, str]:
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    thick = os.path.join(OUTPUT_FOLDER, f"{file_id}.thick.json")
    return base, proj, thick

# ----------------- STEP/STL -> trimesh -----------------
def _mesh_from_step(step_path: str):
    import numpy as np
    import trimesh
    try:
        import cadquery as cq
    except Exception as e:
        raise RuntimeError(f"CadQuery indisponible: {e}")

    tol_mm = env_float("TESSELLATION_TOL_MM", 0.05)
    ang_rd = env_float("TESSELLATION_ANG_RAD", 0.25)

    shape = cq.importers.importStep(step_path)
    verts, faces = shape.tessellate(tol_mm, angular_tolerance=ang_rd)
    if not verts or not faces:
        raise RuntimeError("Tessellation vide")

    V = np.asarray(verts, dtype=float)
    F = np.asarray(faces, dtype=int)
    mesh = trimesh.Trimesh(vertices=V, faces=F, process=True)

    if mesh.is_empty:
        raise RuntimeError("Mesh vide")
    try:
        if not mesh.is_watertight:
            mesh = mesh.fill_holes()
    except Exception:
        pass
    return mesh

def _mesh_from_stl(stl_path: str):
    import trimesh
    m = trimesh.load_mesh(stl_path, force="mesh")
    if m.is_empty:
        raise RuntimeError("STL vide")
    try:
        if not m.is_watertight:
            m = m.fill_holes()
    except Exception:
        pass
    return m

def _load_mesh(path: str):
    ext = pathlib.Path(path).suffix.lower()
    if ext == ".stl":
        return _mesh_from_stl(path)
    if ext in (".step", ".stp"):
        return _mesh_from_step(path)
    raise RuntimeError(f"Extension non supportée: {ext}")

# ----------------- Mesures -----------------
def _bbox_mm(mesh) -> List[float]:
    import numpy as np
    ext = mesh.extents.astype(float)
    return [float(np.round(ext[0], 4)), float(np.round(ext[1], 4)), float(np.round(ext[2], 4))]

def _volume_mm3(mesh) -> Optional[float]:
    try:
        vol = float(mesh.volume)
        if vol > 0:
            return vol
    except Exception:
        pass
    try:
        parts = mesh.split(only_watertight=True)
        if parts:
            s = sum(float(p.volume) for p in parts if p.volume > 0)
            return s if s > 0 else None
    except Exception:
        pass
    return None

def _projected_area_cm2(mesh, axis: str) -> float:
    import numpy as np
    axis = (axis or "Z").upper()
    if axis == "X":
        d = np.array([1.0, 0.0, 0.0])
    elif axis == "Y":
        d = np.array([0.0, 1.0, 0.0])
    else:
        d = np.array([0.0, 0.0, 1.0])
    try:
        area_faces = mesh.area_faces
        n = mesh.face_normals
        scale = np.abs((n * d).sum(axis=1))
        a_mm2 = float((area_faces * scale).sum())
        return round(a_mm2 / 100.0, 4)  # mm² -> cm²
    except Exception:
        return 0.0

# ----------------- Épaisseur via voxel + EDT + squelette -----------------
def _thickness_mm_voxel(mesh, pitch_mm: Optional[float] = None, max_voxels: int = 80_000_000, dbg: dict | None = None):
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    try:
        from skimage.morphology import skeletonize_3d
    except Exception as e:
        raise RuntimeError(f"scikit-image manquant: {e}")

    if pitch_mm is None:
        pitch_mm = env_float("VOXEL_PITCH_MM", 0.12)

    ext = mesh.extents.astype(float)
    dims = np.ceil(ext / pitch_mm).astype(int)
    voxels = int(dims[0]) * int(dims[1]) * int(dims[2])
    if voxels > max_voxels:
        scale = (voxels / float(max_voxels)) ** (1.0 / 3.0)
        pitch_mm *= scale
        dims = np.ceil(ext / pitch_mm).astype(int)
        if dbg is not None:
            dbg["voxel_pitch_scaled_mm"] = float(pitch_mm)

    vg = mesh.voxelized(pitch_mm).fill()
    vol = vg.matrix.astype(bool)
    if vol.size == 0 or not vol.any():
        return None, None

    if dbg is not None:
        dbg["voxel_shape"] = list(vol.shape)
        dbg["voxel_pitch_mm"] = float(pitch_mm)

    edt = distance_transform_edt(vol) * float(pitch_mm)
    skel = skeletonize_3d(vol)
    vals = edt[skel]
    if vals.size == 0:
        return None, None

    tmin = float(2.0 * vals.min())
    tmax = float(2.0 * vals.max())
    return tmin, tmax

# ----------------- Résolution du chemin source -----------------
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    # 1) direct
    if step_path and os.path.isfile(step_path):
        return step_path
    # 2) local
    for ext in (step_ext, "step", "stp", "stl"):
        if not ext:
            continue
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if os.path.isfile(p):
            return p
    # 3) S3 (facultatif)
    if _s3_enabled():
        for ext in (step_ext, "step", "stp", "stl"):
            if not ext:
                continue
            key = f"uploads/{file_id}.{ext}"
            dest = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
            if _s3_get(key, dest):
                return dest
    raise FileNotFoundError(f"Fichier introuvable pour file_id={file_id} (step_path={step_path}, step_ext={step_ext})")

# ----------------- Job RQ principal -----------------
def compute_and_cache_stats(*, file_id: str, axis: str, step_path: Optional[str], step_ext: Optional[str], cache_dir: Optional[str] = None) -> dict:
    axis = (axis or "Z").upper()
    out_dir = cache_dir or OUTPUT_FOLDER
    os.makedirs(out_dir, exist_ok=True)
    base_cache, proj_cache, thick_cache = _cache_paths(file_id, axis)

    dbg = {}

    # 1) Charger la source
    src_path = _resolve_source_path(file_id, step_path, step_ext)

    # 2) Mesh
    mesh = _load_mesh(src_path)

    # 3) BBox / Volume
    bbox = _bbox_mm(mesh)
    vol_mm3 = _volume_mm3(mesh)

    # 4) Aire projetée
    proj_cm2 = _projected_area_cm2(mesh, axis=axis)

    # 5) Épaisseur (VOXEL/SDF only)
    pitch_env = os.getenv("VOXEL_PITCH_MM")
    pitch = float(pitch_env) if pitch_env else None
    tmin, tmax = _thickness_mm_voxel(mesh, pitch_mm=pitch, dbg=dbg)

    # 6) Écrire caches
    base_payload = {
        "volume_mm3": vol_mm3,
        "bbox_mm": bbox,
        "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
        "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
        "volume_cm3": round(vol_mm3 / 1000.0, 4) if (vol_mm3 is not None) else None,
    }
    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(base_payload, fh)

    proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4)}
    with open(proj_cache, "w", encoding="utf-8") as fh:
        json.dump(proj_payload, fh)

    # 6b) Écrire le fichier d’épaisseur dédié (lu par le web)
    thick_payload = {
        "tmin": base_payload["thickness_min_mm"],
        "tmax": base_payload["thickness_max_mm"],
        "method": "voxel_sdf",
        "debug": dbg,
    }
    with open(thick_cache, "w", encoding="utf-8") as fh:
        json.dump(thick_payload, fh)

    logger.info(
        "[worker] file_id=%s axis=%s bbox=%s vol_cm3=%.4f t=(%s,%s)mm proj=%.4fcm2 pitch=%s",
        file_id, axis, bbox, (vol_mm3 / 1000.0 if vol_mm3 else 0.0),
        thick_payload["tmin"], thick_payload["tmax"], proj_payload["projected_area_cm2"], pitch
    )

    # 7) Upload S3 (optionnel, recommandé en multi-instance)
    if _s3_enabled() and env_bool("UPLOAD_RESULTS_TO_S3", True):
        _s3_put(base_cache,   f"converted/{file_id}.stats.json", "application/json")
        _s3_put(proj_cache,   f"converted/{file_id}.proj.{axis}.json", "application/json")
        _s3_put(thick_cache,  f"converted/{file_id}.thick.json", "application/json")

    return {
        "ok": True,
        "file_id": file_id,
        "axis": axis,
        "written": {"stats": base_cache, "proj": proj_cache, "thick": thick_cache},
        "debug": dbg,
    }
