# worker_tasks.py
from __future__ import annotations
import os, io, json, math, tempfile, pathlib, logging
from typing import Optional, Tuple, List

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))

# --- Dossiers (compat avec le web)
UPLOAD_FOLDER  = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER  = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# --- S3 helper (optionnel)
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _try_get_from_s3(key: str, dest_path: str) -> bool:
    if not _s3_enabled(): 
        return False
    try:
        from s3io import get_file
        ok = get_file(key, dest_path)
        if ok and os.path.isfile(dest_path):
            return True
    except Exception as e:
        logger.warning("[worker] S3 get_file failed key=%s: %s", key, e)
    return False

# --- Caches, noms identiques à ceux du web
def _cache_paths(file_id: str, axis: str) -> Tuple[str, str]:
    base = os.path.join(OUTPUT_FOLDER, f"{file_id}.stats.json")
    proj = os.path.join(OUTPUT_FOLDER, f"{file_id}.proj.{axis}.json")
    return base, proj

# --- STEP/STL -> mesh
def _mesh_from_step(step_path: str):
    """
    Tessellation STEP via CadQuery/OCP -> trimesh.Trimesh (en mm).
    """
    import numpy as np
    import trimesh
    try:
        import cadquery as cq
    except Exception as e:
        raise RuntimeError(f"CadQuery indisponible: {e}")

    # Import & tessellation
    tol_mm = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
    ang_rd = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))

    shape = cq.importers.importStep(step_path)
    verts, faces = shape.tessellate(tol_mm, angular_tolerance=ang_rd)
    if not verts or not faces:
        raise RuntimeError("Tessellation vide")

    V = np.asarray(verts, dtype=float)
    F = np.asarray(faces, dtype=int)

    mesh = trimesh.Trimesh(vertices=V, faces=F, process=True)
    if mesh.is_empty:
        raise RuntimeError("Mesh vide après tessellation")

    # Optionnel : boucher quelques trous
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

# --- Mesures géométriques de base
def _bbox_mm(mesh) -> List[float]:
    import numpy as np
    ext = mesh.extents.astype(float)  # mm
    return [float(np.round(ext[0], 4)), float(np.round(ext[1], 4)), float(np.round(ext[2], 4))]

def _volume_mm3(mesh) -> Optional[float]:
    try:
        vol = float(mesh.volume)  # mm^3 si le mesh est en mm et watertight
        if vol > 0:
            return vol
    except Exception:
        pass
    # Fallback: sommer volumes des composants étanches
    try:
        parts = mesh.split(only_watertight=True)
        if parts:
            s = sum(float(p.volume) for p in parts if p.volume > 0)
            return s if s > 0 else None
    except Exception:
        pass
    return None

def _projected_area_cm2(mesh, axis: str) -> float:
    """
    Aire projetée sur le plan perpendiculaire à axis (X/Y/Z).
    Utilise la formule: somme(face_area * |n · d|).
    Convertit mm^2 -> cm^2 (/100).
    """
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

# --- Épaisseur via Voxel + EDT + squelette 3D
def _thickness_mm_voxel(mesh, pitch_mm: Optional[float]=None, max_voxels: int=80_000_000, dbg: dict | None=None):
    """
    Calcule tmin/tmax robustes (mm):
      1) voxelisation (pas 'pitch_mm' en mm)
      2) distance transform (EDT) -> rayon local (mm)
      3) squelette 3D -> min/max rayons squelettiques
    """
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    try:
        from skimage.morphology import skeletonize_3d
    except Exception as e:
        raise RuntimeError(f"scikit-image manquant: {e}")

    if pitch_mm is None:
        pitch_mm = float(os.getenv("VOXEL_PITCH_MM", "0.12"))

    # Ajustement de pas si trop de voxels
    ext = mesh.extents.astype(float)
    dims = np.ceil(ext / pitch_mm).astype(int)
    voxels = int(dims[0]) * int(dims[1]) * int(dims[2])
    if voxels > max_voxels:
        scale = (voxels / float(max_voxels)) ** (1.0/3.0)
        pitch_mm *= scale
        dims = np.ceil(ext / pitch_mm).astype(int)
        if isinstance(dbg, dict):
            dbg["voxel_pitch_scaled_mm"] = float(pitch_mm)

    # Voxelisation
    vg = mesh.voxelized(pitch_mm).fill()
    vol = vg.matrix.astype(bool)
    if vol.size == 0 or not vol.any():
        return None, None

    if isinstance(dbg, dict):
        dbg["voxel_shape"] = list(vol.shape)
        dbg["voxel_pitch_mm"] = float(pitch_mm)

    # Distance transform -> rayon en mm
    edt = distance_transform_edt(vol) * float(pitch_mm)

    # Squelette + lecture des rayons le long du squelette
    skel = skeletonize_3d(vol)
    vals = edt[skel]
    if vals.size == 0:
        return None, None

    tmin = float(2.0 * vals.min())
    tmax = float(2.0 * vals.max())
    return tmin, tmax

# --- Résolution du STEP local/S3
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    # 1) chemin direct ?
    if step_path and os.path.isfile(step_path):
        return step_path

    # 2) dans UPLOAD_FOLDER ?
    for ext in (step_ext, "step", "stp", "stl"):
        if not ext: 
            continue
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if os.path.isfile(p):
            return p

    # 3) S3 ?
    if _s3_enabled():
        # Tente step/stp/stl
        for ext in (step_ext, "step", "stp", "stl"):
            if not ext:
                continue
            key = f"uploads/{file_id}.{ext}"
            dest = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
            if _try_get_from_s3(key, dest):
                return dest

    raise FileNotFoundError(f"Impossible de localiser le fichier pour file_id={file_id} (step_path={step_path}, step_ext={step_ext})")

# --- Job principal appelé par RQ
def compute_and_cache_stats(*, file_id: str, axis: str, step_path: Optional[str], step_ext: Optional[str], cache_dir: Optional[str]=None) -> dict:
    """
    Job RQ.
    Ecrit:
      - {OUTPUT}/{file_id}.stats.json            (volume_mm3, bbox_mm, thickness_min_mm, thickness_max_mm)
      - {OUTPUT}/{file_id}.proj.{axis}.json      (projected_area_cm2)
    """
    axis = (axis or "Z").upper()
    out_dir = cache_dir or OUTPUT_FOLDER
    os.makedirs(out_dir, exist_ok=True)
    base_cache, proj_cache = _cache_paths(file_id, axis)

    dbg = {}

    # 1) Résoudre la source
    src_path = _resolve_source_path(file_id, step_path, step_ext)

    # 2) Charger le mesh
    mesh = _load_mesh(src_path)

    # 3) BBox & volume
    bbox = _bbox_mm(mesh)
    vol_mm3 = _volume_mm3(mesh)

    # 4) Aire projetée (pour l'axe demandé uniquement)
    proj_cm2 = _projected_area_cm2(mesh, axis=axis)

    # 5) Épaisseur (VOXEL/SDF only)
    pitch = os.getenv("VOXEL_PITCH_MM")
    pitch = float(pitch) if pitch else None
    tmin, tmax = _thickness_mm_voxel(mesh, pitch_mm=pitch, dbg=dbg)

    # 6) Ecrire les caches
    base_payload = {
        "volume_mm3": vol_mm3,
        "bbox_mm": bbox,
        "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
        "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
        # pour compat éventuelle avec le web
        "volume_cm3": round(vol_mm3/1000.0, 4) if (vol_mm3 is not None) else None,
    }
    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(base_payload, fh)

    proj_payload = {
        "projected_area_cm2": round(float(proj_cm2), 4)
    }
    with open(proj_cache, "w", encoding="utf-8") as fh:
        json.dump(proj_payload, fh)

    logger.info("[worker] caches écrits file_id=%s axis=%s  bbox=%s  vol=%.4f cm3  t=(%s,%s) mm  proj=%.4f cm2",
                file_id, axis, bbox,
                (vol_mm3/1000.0 if vol_mm3 else 0.0),
                base_payload["thickness_min_mm"], base_payload["thickness_max_mm"],
                proj_payload["projected_area_cm2"])

    # (optionnel) tu peux renvoyer une synthèse
    return {
        "ok": True,
        "file_id": file_id,
        "axis": axis,
        "written": {
            "stats": base_cache,
            "proj": proj_cache
        },
        "debug": dbg
    }
