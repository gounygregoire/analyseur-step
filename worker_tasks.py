# worker_tasks.py
from __future__ import annotations
import os, json, pathlib, logging
from typing import Optional, Tuple, List

logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))
logger = logging.getLogger(__name__)

# --- Dossiers (compat avec le web)
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# --- S3 helpers --------------------------------------------------------------
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
        logger.warning("[worker] S3 get_file failed key=%s: %s", key, e)
        return False

def _s3_put(path: str, key: str, *, content_type: str = "application/json") -> bool:
    if not _s3_enabled() or not os.path.isfile(path):
        return False
    try:
        from s3io import put_file
        ok = put_file(path, key, content_type=content_type)
        return bool(ok)
    except Exception as e:
        logger.warning("[worker] S3 put_file failed key=%s: %s", key, e)
        return False

# --- Caches, mêmes noms que côté web ----------------------------------------
def _cache_paths(file_id: str, axis: str) -> Tuple[str, str]:
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    return base, proj

def _thick_path(file_id: str) -> str:
    return os.path.join(OUTPUT_FOLDER, f"{file_id}.thick.json")

# --- Chargement STEP/STL -> trimesh -----------------------------------------
def _mesh_from_step(step_path: str):
    """
    Tessellation STEP via CadQuery/OCP -> trimesh.Trimesh (en mm).
    """
    import numpy as np
    import trimesh
    import cadquery as cq

    tol_mm = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
    ang_rd = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))

    shape = cq.importers.importStep(step_path)
    verts, faces = shape.tessellate(tol_mm, angular_tolerance=ang_rd)
    if not verts or not faces:
        raise RuntimeError("Tessellation vide")

    V = np.asarray(verts, dtype=float)
    F = np.asarray(faces, dtype=int)
    m = trimesh.Trimesh(vertices=V, faces=F, process=True)

    if m.is_empty:
        raise RuntimeError("Mesh vide après tessellation")
    try:
        if not m.is_watertight:
            m = m.fill_holes()
    except Exception:
        pass
    return m

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

# --- Mesures de base ---------------------------------------------------------
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
        return round(a_mm2 / 100.0, 4)  # mm^2 -> cm^2
    except Exception:
        return 0.0

# --- Épaisseur via voxel + EDT + squelette 3D -------------------------------
def _thickness_mm_voxel(mesh, pitch_mm: Optional[float] = None,
                        max_voxels: int = 80_000_000, dbg: dict | None = None):
    """
    1) voxelisation (pas pitch_mm en mm)
    2) distance transform (EDT) -> rayon local (mm)
    3) squelette 3D -> min/max rayons -> épaisseur = 2 * rayon
    """
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    try:
        from skimage.morphology import skeletonize_3d
    except Exception as e:
        raise RuntimeError(f"scikit-image manquant: {e}")

    if pitch_mm is None:
        pitch_mm = float(os.getenv("VOXEL_PITCH_MM", "0.12"))

    # Contrôle du nombre de voxels
    ext = mesh.extents.astype(float)
    dims = np.ceil(ext / pitch_mm).astype(int)
    voxels = int(dims[0]) * int(dims[1]) * int(dims[2])
    if voxels > max_voxels:
        scale = (voxels / float(max_voxels)) ** (1.0 / 3.0)
        pitch_mm *= scale
        dims = np.ceil(ext / pitch_mm).astype(int)
        if isinstance(dbg, dict):
            dbg["voxel_pitch_scaled_mm"] = float(pitch_mm)

    vg = mesh.voxelized(pitch_mm).fill()
    vol = vg.matrix.astype(bool)
    if vol.size == 0 or not vol.any():
        return None, None

    if isinstance(dbg, dict):
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

# --- Résolution de la source (local/S3) -------------------------------------
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    # 1) chemin fourni et présent ?
    if step_path and os.path.isfile(step_path):
        return step_path

    # 2) UPLOAD_FOLDER local ?
    for ext in (step_ext, "step", "stp", "stl"):
        if not ext:
            continue
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if os.path.isfile(p):
            return p

    # 3) S3 (uploads/<id>.<ext>)
    if _s3_enabled():
        for ext in (step_ext, "step", "stp", "stl"):
            if not ext:
                continue
            key = f"uploads/{file_id}.{ext}"
            dest = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
            if _s3_get(key, dest):
                return dest

    raise FileNotFoundError(f"Fichier introuvable pour file_id={file_id} (step_path={step_path}, step_ext={step_ext})")

# --- Job principal RQ --------------------------------------------------------
def compute_and_cache_stats(*, file_id: str, axis: str,
                            step_path: Optional[str],
                            step_ext: Optional[str],
                            cache_dir: Optional[str] = None) -> dict:
    """
    Ecrit :
      - {OUTPUT}/{file_id}.stats.json
      - {OUTPUT}/{file_id}.proj.{axis}.json
      - {OUTPUT}/{file_id}.thick.json   (tmin/tmax uniquement)
    Puis upload vers S3 :
      - converted/<file_id>.stats.json
      - converted/<file_id>.proj.<axis>.json
      - thick/<file_id>.json
    """
    axis = (axis or "Z").upper()
    out_dir = cache_dir or OUTPUT_FOLDER
    os.makedirs(out_dir, exist_ok=True)
    base_cache, proj_cache = _cache_paths(file_id, axis)
    thick_cache = _thick_path(file_id)

    dbg = {}

    # 1) Source
    src_path = _resolve_source_path(file_id, step_path, step_ext)

    # 2) Mesh
    mesh = _load_mesh(src_path)

    # 3) Mesures
    bbox = _bbox_mm(mesh)
    vol_mm3 = _volume_mm3(mesh)
    proj_cm2 = _projected_area_cm2(mesh, axis=axis)

    # 4) Épaisseurs (voxel/SDF only)
    pitch = os.getenv("VOXEL_PITCH_MM")
    pitch = float(pitch) if pitch else None
    tmin, tmax = _thickness_mm_voxel(mesh, pitch_mm=pitch, dbg=dbg)

    # 5) Ecriture caches locaux
    base_payload = {
        "volume_mm3": vol_mm3,
        "bbox_mm": bbox,
        "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
        "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
        "volume_cm3": round(vol_mm3 / 1000.0, 4) if (vol_mm3 is not None) else None,
    }
    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(base_payload, fh)

    with open(proj_cache, "w", encoding="utf-8") as fh:
        json.dump({"projected_area_cm2": round(float(proj_cm2), 4)}, fh)

    with open(thick_cache, "w", encoding="utf-8") as fh:
        json.dump({"tmin": base_payload["thickness_min_mm"], "tmax": base_payload["thickness_max_mm"]}, fh)

    logger.info("[worker] caches écrits file_id=%s axis=%s bbox=%s vol=%.4f cm3 t=(%s,%s) proj=%.4f",
                file_id, axis, bbox, (vol_mm3 / 1000.0 if vol_mm3 else 0.0),
                base_payload["thickness_min_mm"], base_payload["thickness_max_mm"], proj_cm2)

    # 6) Upload S3 (best-effort)
    _s3_put(base_cache, f"converted/{file_id}.stats.json")
    _s3_put(proj_cache, f"converted/{file_id}.proj.{axis}.json")
    _s3_put(thick_cache, f"thick/{file_id}.json")

    return {
        "ok": True,
        "file_id": file_id,
        "axis": axis,
        "written": {"stats": base_cache, "proj": proj_cache, "thick": thick_cache},
        "debug": dbg,
    }
