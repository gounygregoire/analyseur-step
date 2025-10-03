# worker_tasks.py
from __future__ import annotations
import os, io, json, math, tempfile, pathlib, logging, subprocess, sys, shlex
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
# STEP -> STL via SOUS-PROCESSUS (isolation OCC/CadQuery)
# =========================
def _export_step_to_stl_subprocess(step_path: str, stl_path: str, tol_mm: float, ang_rd: float, timeout_s: int) -> None:
    """
    Exécute CadQuery dans un sous-processus pour éviter qu’un segfault OCC
    ne tue le worker. En cas d’échec, lève RuntimeError avec logs utiles.
    """
    code = r"""
import sys
try:
    import cadquery as cq
    p, out, tol, ang = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
    wp = cq.importers.importStep(p)
    cq.exporters.export(wp, out, exportType="STL", tolerance=tol, angularTolerance=ang)
except Exception as e:
    import traceback, sys
    traceback.print_exc()
    sys.exit(2)
"""
    cmd = [sys.executable, "-c", code, step_path, stl_path, str(tol_mm), str(ang_rd)]
    logger.info("[step2stl] spawn subprocess: %s", " ".join(shlex.quote(x) for x in cmd))
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout_s, check=False
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"STEP->STL export timeout after {timeout_s}s")
    rc = res.returncode
    if rc != 0:
        # 139 = segfault typique
        hint = " (segfault/oom probable)" if rc in (134, 139) else ""
        err = (res.stderr or "").strip()
        out = (res.stdout or "").strip()
        raise RuntimeError(f"STEP->STL export failed rc={rc}{hint}; stderr={err[:800]} stdout={out[:400]}")

# =========================
# Chargement / maillage
# =========================
def _mesh_from_step(step_path: str):
    """
    Tessellation STEP via CadQuery en SOUS-PROCESSUS -> charge STL avec trimesh.
    """
    import trimesh
    tol_mm = float(os.getenv("TESSELLATION_TOL_MM", "0.05"))
    ang_rd = float(os.getenv("TESSELLATION_ANG_RAD", "0.25"))
    timeout_s = int(os.getenv("STEP_EXPORT_TIMEOUT_SEC", "300"))

    logger.info("Import STEP (subprocess) : %s", step_path)
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False)
    stl_path = tmp.name
    tmp.close()
    try:
        _export_step_to_stl_subprocess(step_path, stl_path, tol_mm, ang_rd, timeout_s)
        m = trimesh.load_mesh(stl_path, force="mesh")
    finally:
        try:
            os.remove(stl_path)
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
    try:
        vol = float(mesh.volume)
        if vol > 0:
            return vol
    except Exception:
        pass
    try:
        parts = mesh.split(only_watertight=True)
        s = sum(float(p.volume) for p in parts if getattr(p, "volume", 0) > 0)
        return s if s > 0 else None
    except Exception:
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
    try:
        import numpy as np
        from scipy.ndimage import distance_transform_edt
        from skimage.morphology import skeletonize_3d
    except Exception as e:
        logger.info("Thickness voxel disabled (missing deps?): %s", e)
        return None, None

    if pitch_mm is None:
        pitch_mm = float(os.getenv("VOXEL_PITCH_MM", "0.12"))

    ext = mesh.extents.astype(float)
    dims = (ext / pitch_mm).clip(min=1.0)
    voxels_est = int(math.ceil(dims[0])) * int(math.ceil(dims[1])) * int(math.ceil(dims[2]))
    if voxels_est > max_voxels:
        scale = (voxels_est / float(max_voxels)) ** (1.0 / 3.0)
        pitch_mm *= scale
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
    try:
        skel = skeletonize_3d(vol)
    except Exception:
        v = edt[vol]
        if v.size == 0:
            return None, None
        return float(2.0 * v.min()), float(2.0 * v.max())

    vals = edt[skel]
    if vals.size == 0:
        return None, None

    return float(2.0 * vals.min()), float(2.0 * vals.max())

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
    return area_mm2 / 100.0

def _validate_metrics(data: Dict, axis: str) -> Dict:
    bbox = data.get("bbox_mm") or [0, 0, 0]
    vol = data.get("volume_mm3")
    proj = data.get("projected_area_cm2")
    tmin = data.get("thickness_min_mm")
    tmax = data.get("thickness_max_mm")

    bbox_prod = _bbox_product_mm3(bbox) or 0.0
    bbox_min = min([b for b in bbox if isinstance(b, (int, float))] or [0.0])
    bbox_face = _bbox_face_cm2(bbox, axis) or 0.0

    if isinstance(vol, (int, float)):
        if vol <= 0 or (bbox_prod > 0 and vol > 1.01 * bbox_prod):
            logger.warning("volume_mm3 invalid -> None (vol=%s, bbox_prod=%s)", vol, bbox_prod)
            data["volume_mm3"] = None

    if isinstance(proj, (int, float)):
        if proj < 0 or (bbox_face > 0 and proj > 1.01 * bbox_face):
            logger.warning("projected_area_cm2 invalid -> 0 (proj=%s, bbox_face=%s)", proj, bbox_face)
            data["projected_area_cm2"] = 0.0

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
        data["thickness_min_mm"] = None
        data["thickness_max_mm"] = None

    return data

# =========================
# Résolution du fichier source (local / S3)
# =========================
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    if step_path and os.path.isfile(step_path):
        return step_path

    for ext in (step_ext, "step", "stp", "stl"):
        if not ext:
            continue
        p = os.path.join(UPLOAD_FOLDER, f"{file_id}.{ext}")
        if os.path.isfile(p):
            return p

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
# Helpers: écrire caches vides si échec dur
# =========================
def _write_empty_caches(file_id: str, axis: str, out_dir: str, dbg: dict | None = None) -> None:
    base_cache, proj_cache = _cache_paths(file_id, axis, base_dir=out_dir)
    empty_stats = {
        "volume_mm3": None,
        "volume_cm3": None,
        "bbox_mm": None,
        "thickness_min_mm": None,
        "thickness_max_mm": None,
    }
    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(empty_stats, fh)
    with open(proj_cache, "w", encoding="utf-8") as fh:
        json.dump({"projected_area_cm2": 0.0}, fh)
    _publish_redis(file_id, axis, {
        "volume_mm3": None,
        "bbox_mm": None,
        "thickness_min_mm": None,
        "thickness_max_mm": None,
        "projected_area_cm2": 0.0,
        "debug": (dbg or {}),
    }, ttl_sec=3600)

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
      - {cache_dir}/{fid}.stats.json
      - {cache_dir}/{fid}.proj.{axis}.json
      - {cache_dir}/{fid}.thick.json (si dispo)
    En cas d’échec non récupérable, écrit des caches “vides” pour éviter l’UI bloquée.
    """
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    out_dir = cache_dir or OUTPUT_FOLDER
    os.makedirs(out_dir, exist_ok=True)

    base_cache, proj_cache = _cache_paths(file_id, axis, base_dir=out_dir)
    thick_cache = _thickness_cache_path(file_id, base_dir=out_dir)

    dbg: dict = {}

    try:
        # 1) Résoudre la source
        src_path = _resolve_source_path(file_id, step_path, step_ext)
        logger.info("Source resolved: %s", src_path)

        # 2) Charger le mesh (STEP -> STL dans un sous-processus)
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

        # 6) Écrire les caches
        base_payload = {
            "volume_mm3": float(vol_mm3) if vol_mm3 is not None else None,
            "volume_cm3": vol_cm3,
            "bbox_mm": bbox,
            "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
            "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
        }
        base_payload = _validate_metrics(base_payload, axis)

        with open(base_cache, "w", encoding="utf-8") as fh:
            json.dump(base_payload, fh)

        proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4)}
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
                        {"tmin": base_payload["thickness_min_mm"], "tmax": base_payload["thickness_max_mm"], "method": "voxel_edt"},
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
            "debug": dbg,
        }
        _publish_redis(file_id, axis, merged_for_redis, ttl_sec=3600)

        logger.info(
            "Caches écrits file_id=%s axis=%s  bbox=%s  vol=%s cm3  t=(%s,%s) mm  proj=%s cm2  debug=%s",
            file_id, axis, base_payload["bbox_mm"],
            f"{base_payload['volume_cm3']:.4f}" if base_payload["volume_cm3"] is not None else "None",
            base_payload["thickness_min_mm"], base_payload["thickness_max_mm"],
            proj_payload["projected_area_cm2"], dbg,
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

    except Exception as e:
        # Fallback: on écrit des caches vides pour débloquer le front
        logger.exception("compute_and_cache_stats failed for %s: %s", file_id, e)
        try:
            _write_empty_caches(file_id, axis, out_dir, dbg={"error": str(e)})
        except Exception as ee:
            logger.warning("write_empty_caches failed: %s", ee)
        return {
            "ok": False,
            "file_id": file_id,
            "axis": axis,
            "written": {
                "stats": os.path.join(out_dir, f"{file_id}.stats.json"),
                "proj": os.path.join(out_dir, f"{file_id}.proj.{axis}.json"),
                "thick": None,
            },
            "debug": {"error": str(e)},
        }
