# worker_tasks.py
from __future__ import annotations
import os, io, json, math, tempfile, pathlib, logging
from typing import Optional, Tuple, List, Dict
from datetime import timedelta

# =========================
# Logs
# =========================
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=getattr(logging, os.getenv("LOGLEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [worker] %(message)s"
)

# =========================
# Dossiers (mêmes valeurs que côté web)
# =========================
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# =========================
# Helpers S3 (optionnels)
# =========================
def _s3_enabled() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"))

def _s3_put(local_path: str, key: str, content_type: str = "application/json") -> bool:
    if not (_s3_enabled() and os.path.isfile(local_path)):
        return False
    try:
        from s3io import put_file
        ok = put_file(local_path, key, content_type=content_type)
        if not ok:
            logger.warning("S3 put_file returned False for key=%s", key)
        return bool(ok)
    except Exception as e:
        logger.warning("S3 upload failed key=%s: %s", key, e)
        return False

def _try_get_from_s3(key: str, dest_path: str) -> bool:
    if not _s3_enabled():
        return False
    try:
        from s3io import get_file
        ok = get_file(key, dest_path)
        return bool(ok and os.path.isfile(dest_path))
    except Exception as e:
        logger.warning("S3 get_file failed key=%s: %s", key, e)
        return False

# =========================
# Redis publish (pour fallback web)
# =========================
def _normalize_redis_url(url: str) -> str:
    from urllib.parse import urlparse, urlunparse
    if not url:
        return url
    parsed = urlparse(str(url).strip().strip('"').strip("'"))
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

def _redis_client():
    import redis
    REDIS_URL = _normalize_redis_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    return redis.from_url(REDIS_URL, ssl_cert_reqs=None, socket_timeout=5)

def _publish_redis(file_id: str, axis: str, payload: dict, ttl_sec: int = 3600) -> None:
    try:
        r = _redis_client()
        r.setex(f"shape_stats:{file_id}:{axis}", timedelta(seconds=ttl_sec), json.dumps(payload))
    except Exception as e:
        # Non bloquant
        logger.info("Redis publish skipped: %s", e)

# =========================
# Noms des caches (acceptent base_dir)
# =========================
def _cache_paths(file_id: str, axis: str, base_dir: Optional[str] = None) -> Tuple[str, str]:
    base_dir = base_dir or OUTPUT_FOLDER
    base = os.path.join(base_dir, f"{file_id}.stats.json")
    proj = os.path.join(base_dir, f"{file_id}.proj.{axis}.json")
    return base, proj

def _thickness_cache_path(file_id: str, base_dir: Optional[str] = None) -> str:
    base_dir = base_dir or OUTPUT_FOLDER
    return os.path.join(base_dir, f"{file_id}.thick.json")

# =========================
# Chargement / maillage
# =========================
def _mesh_from_step(step_path: str):
    """
    Tessellation STEP via CadQuery -> export STL temporaire -> charge avec trimesh.
    Unités supposées en mm (STEP cohérent).
    """
    import cadquery as cq
    import trimesh

    tol_mm = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
    ang_rd = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))

    logger.info("Import STEP with CadQuery: %s", step_path)
    wp = cq.importers.importStep(step_path)  # Workplane/Compound

    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        # exportType="STL" sait traiter Workplane/Compound
        cq.exporters.export(
            wp,
            tmp_path,
            exportType="STL",
            tolerance=tol_mm,
            angularTolerance=ang_rd
        )
        m = trimesh.load_mesh(tmp_path, force="mesh")
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    if m.is_empty:
        raise RuntimeError("Mesh vide après export STL")

    try:
        if not m.is_watertight:
            m = m.fill_holes()
    except Exception:
        pass

    return m

def _mesh_from_stl(stl_path: str):
    import trimesh
    logger.info("Load STL: %s", stl_path)
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

# =========================
# Métriques géométriques
# =========================
def _bbox_mm(mesh) -> List[float]:
    import numpy as np
    ext = mesh.extents.astype(float)
    return [float(np.round(ext[0], 4)), float(np.round(ext[1], 4)), float(np.round(ext[2], 4))]

def _volume_mm3(mesh) -> Optional[float]:
    # volume direct (mm³) si watertight
    try:
        vol = float(mesh.volume)
        if vol > 0:
            return vol
    except Exception:
        pass
    # fallback: somme des pièces étanches
    try:
        parts = mesh.split(only_watertight=True)
        s = sum(float(p.volume) for p in parts if getattr(p, "volume", 0) > 0)
        return s if s > 0 else None
    except Exception:
        return None

def _projected_area_cm2(mesh, axis: str) -> float:
    """
    Aire projetée sur le plan ⟂ à axis (X/Y/Z) : a_proj = Σ(area_face * |n·d|).
    Conversion mm² -> cm² (/100).
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
        areas = mesh.area_faces
        normals = mesh.face_normals
        scale = np.abs((normals * d).sum(axis=1))
        a_mm2 = float((areas * scale).sum())
        return round(a_mm2 / 100.0, 4)
    except Exception:
        return 0.0

# =========================
# Épaisseur via voxel + EDT + squelette (robuste)
# =========================
def _thickness_mm_voxel(
    mesh,
    pitch_mm: Optional[float] = None,
    max_voxels: int = 80_000_000,
    dbg: dict | None = None
) -> tuple[float | None, float | None]:
    """
    1) voxelisation (pitch_mm)  2) EDT -> rayon local (mm)  3) squelette -> min/max*2.
    Retourne (tmin, tmax) en mm ou (None, None) si indisponible.
    """
    try:
        import numpy as np
        from scipy.ndimage import distance_transform_edt
        from skimage.morphology import skeletonize_3d
    except Exception as e:
        logger.info("Thickness voxel disabled (missing deps?): %s", e)
        return None, None

    if pitch_mm is None:
        pitch_mm = float(os.getenv("VOXEL_PITCH_MM", "0.12"))

    # Ajuste le pitch si trop de voxels
    ext = mesh.extents.astype(float)
    dims = (ext / pitch_mm).clip(min=1.0)
    voxels_est = int(math.ceil(dims[0])) * int(math.ceil(dims[1])) * int(math.ceil(dims[2]))
    if voxels_est > max_voxels:
        scale = (voxels_est / float(max_voxels)) ** (1.0 / 3.0)
        pitch_mm *= scale

    vg = mesh.voxelized(pitch_mm).fill()
    vol = vg.matrix.astype(bool)
    if vol.size == 0 or not vol.any():
        return None, None

    if dbg is not None:
        dbg["voxel_shape"] = list(vol.shape)
        dbg["voxel_pitch_mm"] = float(pitch_mm)

    edt = distance_transform_edt(vol) * float(pitch_mm)

    # squelette
    try:
        skel = skeletonize_3d(vol)
        vals = edt[skel]
        if vals.size == 0:
            return None, None
        tmin = float(2.0 * vals.min())
        tmax = float(2.0 * vals.max())
        return tmin, tmax
    except Exception:
        # fallback: min/max EDT sur l’intérieur
        v = edt[vol]
        if v.size == 0:
            return None, None
        return float(2.0 * v.min()), float(2.0 * v.max())

# =========================
# Validations "sanity check"
# =========================
def _bbox_product_mm3(bbox_mm: List[float]) -> Optional[float]:
    try:
        return float(bbox_mm[0]) * float(bbox_mm[1]) * float(bbox_mm[2])
    except Exception:
        return None

def _bbox_face_cm2(bbox_mm: List[float], axis: str) -> Optional[float]:
    try:
        x, y, z = [float(b) for b in bbox_mm]
    except Exception:
        return None
    if axis == "X":
        area_mm2 = y * z
    elif axis == "Y":
        area_mm2 = x * z
    else:
        area_mm2 = x * y
    return area_mm2 / 100.0  # mm² -> cm²

def _validate_metrics(data: Dict, axis: str) -> Dict:
    bbox = data.get("bbox_mm") or [0, 0, 0]
    vol = data.get("volume_mm3")
    proj = data.get("projected_area_cm2")
    tmin = data.get("thickness_min_mm")
    tmax = data.get("thickness_max_mm")

    bbox_prod = _bbox_product_mm3(bbox) or 0.0
    bbox_min = min([b for b in bbox if isinstance(b, (int, float))] or [0.0])
    bbox_face = _bbox_face_cm2(bbox, axis) or 0.0

    # Volume borné
    if isinstance(vol, (int, float)):
        if vol <= 0 or (bbox_prod > 0 and vol > 1.01 * bbox_prod):
            logger.warning("volume_mm3 invalid -> None (vol=%s, bbox_prod=%s)", vol, bbox_prod)
            data["volume_mm3"] = None

    # Aire projetée bornée
    if isinstance(proj, (int, float)):
        if proj < 0 or (bbox_face > 0 and proj > 1.01 * bbox_face):
            logger.warning("projected_area_cm2 invalid -> 0 (proj=%s, bbox_face=%s)", proj, bbox_face)
            data["projected_area_cm2"] = 0.0

    # Épaisseurs bornées
    if isinstance(tmin, (int, float)) and isinstance(tmax, (int, float)):
        if tmin < 0:
            tmin = 0.0
        if tmax < tmin:
            tmax = tmin
        if bbox_min > 0 and tmax > 1.01 * bbox_min:
            logger.warning("thickness_max_mm clipped to bbox_min (tmax=%s, bbox_min=%s)", tmax, bbox_min)
            tmax = bbox_min
        data["thickness_min_mm"] = round(float(tmin), 4)
        data["thickness_max_mm"] = round(float(tmax), 4)
    else:
        # invalide -> None
        data["thickness_min_mm"] = None
        data["thickness_max_mm"] = None

    return data

# =========================
# Résolution du fichier source (local / S3)
# =========================
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    # 1) chemin direct fourni ?
    if step_path and os.path.isfile(step_path):
        return step_path

    # 2) uploads locaux
    for ext in (step_ext, "step", "stp", "stl"):
        if not ext:
            continue
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if os.path.isfile(p):
            return p

    # 3) S3 (uploads/*)
    if _s3_enabled():
        for ext in (step_ext, "step", "stp", "stl"):
            if not ext:
                continue
            key = f"uploads/{file_id}.{ext}"
            dest = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
            if _try_get_from_s3(key, dest):
                return dest

    raise FileNotFoundError(
        f"Impossible de localiser le fichier pour file_id={file_id} (step_path={step_path}, step_ext={step_ext})"
    )

# =========================
# Job principal (appelé par RQ)
# =========================
def compute_and_cache_stats(
    *,
    file_id: str,
    axis: str,
    step_path: Optional[str],
    step_ext: Optional[str],
    cache_dir: Optional[str] = None
) -> dict:
    """
    Écrit:
      - {cache_dir}/{fid}.stats.json       (volume_mm3, bbox_mm, thickness_min_mm, thickness_max_mm, volume_cm3)
      - {cache_dir}/{fid}.proj.{axis}.json (projected_area_cm2)
      - {cache_dir}/{fid}.thick.json       (optionnel: tmin/tmax)
    Pousse aussi vers S3 (converted/*) si configuré et publie une clé Redis pour fallback web.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    out_dir = cache_dir or OUTPUT_FOLDER
    os.makedirs(out_dir, exist_ok=True)

    base_cache, proj_cache = _cache_paths(file_id, axis, base_dir=out_dir)
    thick_cache = _thickness_cache_path(file_id, base_dir=out_dir)

    dbg: dict = {}

    # 1) Résoudre la source
    src_path = _resolve_source_path(file_id, step_path, step_ext)
    logger.info("Source resolved: %s", src_path)

    # 2) Charger le mesh
    mesh = _load_mesh(src_path)

    # 3) BBox & volume
    bbox = _bbox_mm(mesh)
    vol_mm3 = _volume_mm3(mesh)
    vol_cm3 = round(vol_mm3 / 1000.0, 4) if vol_mm3 is not None else None

    # 4) Aire projetée (uniquement l’axe demandé)
    proj_cm2 = _projected_area_cm2(mesh, axis=axis)

    # 5) Épaisseur (voxel EDT)
    pitch_env = os.getenv("VOXEL_PITCH_MM")
    pitch = float(pitch_env) if pitch_env else None
    tmin, tmax = _thickness_mm_voxel(mesh, pitch_mm=pitch, dbg=dbg)

    # 6) Écrire les caches (toujours stats + proj)
    base_payload = {
        "volume_mm3": float(vol_mm3) if vol_mm3 is not None else None,
        "volume_cm3": vol_cm3,
        "bbox_mm": bbox,
        "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
        "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
    }
    # validations bornées
    base_payload = _validate_metrics(base_payload, axis)

    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(base_payload, fh)

    proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4)}
    # revalider l’aire aussi (au cas où bbox a été corrigée)
    proj_payload["projected_area_cm2"] = _validate_metrics(
        {"projected_area_cm2": proj_payload["projected_area_cm2"], "bbox_mm": bbox, "volume_mm3": base_payload["volume_mm3"]},
        axis
    )["projected_area_cm2"]

    with open(proj_cache, "w", encoding="utf-8") as fh:
        json.dump(proj_payload, fh)

    if base_payload["thickness_min_mm"] is not None and base_payload["thickness_max_mm"] is not None:
        try:
            with open(thick_cache, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "tmin": base_payload["thickness_min_mm"],
                        "tmax": base_payload["thickness_max_mm"],
                        "method": "voxel_edt",
                    },
                    fh,
                )
        except Exception as e:
            logger.warning("Impossible d'écrire %s: %s", thick_cache, e)

    # 7) Upload converted/* (optionnel)
    _s3_put(base_cache, f"converted/{pathlib.Path(base_cache).name}")
    _s3_put(proj_cache, f"converted/{pathlib.Path(proj_cache).name}")
    if os.path.isfile(thick_cache):
        _s3_put(thick_cache, f"converted/{pathlib.Path(thick_cache).name}")

    # 8) Publier une clé Redis pour fallback immédiat côté web
    merged_for_redis = {
        "volume_mm3": base_payload["volume_mm3"],
        "bbox_mm": base_payload["bbox_mm"],
        "thickness_min_mm": base_payload["thickness_min_mm"],
        "thickness_max_mm": base_payload["thickness_max_mm"],
        "projected_area_cm2": proj_payload["projected_area_cm2"],
    }
    _publish_redis(file_id, axis, merged_for_redis, ttl_sec=3600)

    logger.info(
        "Caches écrits file_id=%s axis=%s  bbox=%s  vol=%s cm3  t=(%s,%s) mm  proj=%s cm2  debug=%s",
        file_id,
        axis,
        bbox,
        f"{vol_cm3:.4f}" if vol_cm3 is not None else "None",
        base_payload["thickness_min_mm"],
        base_payload["thickness_max_mm"],
        proj_payload["projected_area_cm2"],
        dbg,
    )

    return {
        "ok": True,
        "file_id": file_id,
        "axis": axis,
        "written": {
            "stats": base_cache,
            "proj": proj_cache,
            "thick": (thick_cache if os.path.isfile(thick_cache) else None),
        },
        "debug": dbg,
    }
