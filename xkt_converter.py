# worker_tasks.py
from __future__ import annotations
import os, io, json, math, tempfile, pathlib, logging, shlex, subprocess
from typing import Optional, Tuple, List
from datetime import timedelta

# =========================
# Logs
# =========================
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=getattr(logging, os.getenv("LOGLEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [worker] %(message)s"
)


try:  # pragma: no cover - optional OCC dependency
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # type: ignore
except Exception:  # pragma: no cover - OCC absent
    BRepMesh_IncrementalMesh = None  # type: ignore


def _with_node_path(env: Optional[dict] = None) -> dict:
    env = dict(env or os.environ)
    extra_paths = []
    project_root = pathlib.Path(__file__).resolve().parent
    local_bin = project_root / "node_modules" / ".bin"
    if local_bin.exists():
        extra_paths.append(str(local_bin))
    extra_paths.append("/opt/render/project/nodes/node-20.19.5/bin")
    existing = env.get("PATH", "")
    env["PATH"] = os.pathsep.join([p for p in (*extra_paths, existing) if p])
    return env


def _xeokit_command(input_path: str, output_path: str) -> list[str]:
    exe = (os.environ.get("XEOKIT_CONVERT") or "npx").strip() or "npx"
    extra = shlex.split(os.environ.get("XEOKIT_ARGS", ""))
    if extra:
        blocked = {"--edges-only", "--lines-only", "--wireframe"}
        filtered: list[str] = []
        removed: list[str] = []
        for token in extra:
            lowered = token.lower()
            if lowered in blocked or any(lowered.startswith(f"{flag}=") for flag in blocked):
                removed.append(token)
                continue
            filtered.append(token)
        if removed:
            logger.warning(
                "[convert][xkt] ignoring geometry-filtering args: %s",
                ", ".join(removed),
            )
        extra = filtered
    if exe == "npx":
        base = ["npx", "-y", "@xeokit/xeokit-convert@latest"]
    else:
        base = shlex.split(exe)
    return base + extra + [input_path, "--output", output_path]


def _count_glb_faces(glb_path: str) -> int:
    import trimesh

    if not os.path.exists(glb_path):
        return -1
    scene = trimesh.load(glb_path, force="scene")
    if hasattr(scene, "geometry"):
        return sum(getattr(g, "faces", []).shape[0] for g in scene.geometry.values())
    try:
        return int(getattr(scene, "faces", []).shape[0])
    except Exception:
        return 0


def _force_triangulation(shape_obj, linear_deflection: float, angular_deflection: float = 0.5) -> None:
    """Force OCC tessellation before cadquery.tessellate()."""

    if BRepMesh_IncrementalMesh is None:
        return
    try:
        occ_shape = getattr(shape_obj, "wrapped", None)
        if occ_shape is None and hasattr(shape_obj, "val"):
            try:
                candidate = shape_obj.val()
                occ_shape = getattr(candidate, "wrapped", None)
            except Exception:
                occ_shape = None
        if occ_shape is None:
            return
        mesh = BRepMesh_IncrementalMesh(
            occ_shape,
            float(linear_deflection),
            True,
            float(angular_deflection),
            True,
        )
        if hasattr(mesh, "Perform"):
            mesh.Perform()
    except Exception as exc:
        logger.warning("[convert] OCC triangulation failed: %s", exc)


def convert_step_to_xkt(step_path: str, xkt_path: str, *, stl_tolerance: float = 0.1) -> None:
    """Convertit un STEP en XKT avec garde-fous sur le GLB intermédiaire."""

    import cadquery as cq
    import trimesh

    if not step_path or not os.path.exists(step_path):
        raise FileNotFoundError(f"STEP introuvable: {step_path}")

    out_dir = os.path.dirname(xkt_path or "")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    tol = float(stl_tolerance or 0.1)

    with tempfile.TemporaryDirectory(prefix="step2xkt_") as tmp_dir:
        glb_path = os.path.join(tmp_dir, "scene.glb")

        logger.info("[convert] tessellate step=%s tol=%s", step_path, tol)
        wp = cq.importers.importStep(step_path)
        meshes: List[trimesh.Trimesh] = []

        solids: List = []
        try:
            solids = wp.solids().toList()  # type: ignore[attr-defined]
        except Exception:
            solids = []

        if solids:
            targets = solids
        else:
            fallback_shape = wp.val()
            targets = [fallback_shape] if fallback_shape else []

        for solid in targets:
            try:
                _force_triangulation(solid, tol)
                verts, faces = solid.tessellate(tol)
            except Exception as exc:
                logger.warning("[convert] tessellate failed on solid: %s", exc)
                continue
            if not len(faces):
                continue
            mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
            if mesh.is_empty:
                continue
            try:
                mesh.remove_degenerate_faces()
                mesh.remove_unreferenced_vertices()
            except Exception:
                pass
            meshes.append(mesh)

        if not meshes:
            logger.warning("[convert] tessellation produced no meshes")
            raise RuntimeError("GLB has 0 faces -> triangulation failed. Aborting XKT convert.")

        if len(meshes) == 1:
            export_mesh = meshes[0]
        else:
            export_mesh = trimesh.util.concatenate(meshes)

        export_mesh.export(glb_path, file_type="glb")

        nfaces = _count_glb_faces(glb_path)
        logger.info("[convert][glb] faces=%s path=%s", nfaces, glb_path)
        if nfaces <= 0:
            raise RuntimeError("GLB has 0 faces -> triangulation failed. Aborting XKT convert.")

        if os.path.exists(xkt_path):
            try:
                os.remove(xkt_path)
            except OSError:
                pass

        cmd = _xeokit_command(glb_path, xkt_path)
        logger.info("[convert][xkt] cmd=%s", " ".join(shlex.quote(c) for c in cmd))
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_with_node_path(os.environ),
        )
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        if stdout:
            logger.info("[convert][xkt] stdout=%s", stdout)
        if stderr:
            logger.info("[convert][xkt] stderr=%s", stderr)
        if proc.returncode != 0:
            raise RuntimeError(
                "xeokit-convert failed (rc={})\nSTDOUT:\n{}\nSTDERR:\n{}".format(
                    proc.returncode,
                    stdout,
                    stderr,
                )
            )

        size_xkt = os.path.getsize(xkt_path) if os.path.exists(xkt_path) else 0
        logger.info("[convert][xkt] size_bytes=%s path=%s", size_xkt, xkt_path)
        if size_xkt < 100 * 1024:
            raise RuntimeError("XKT too small (<100KB) -> likely empty. Aborting.")

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
    Unités supposées en mm (STEP doit être cohérent).
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
    """
    Aire projetée sur le plan ⟂ à axis (X/Y/Z).
    a_proj = Σ (area_face * |n·d|).  mm² -> cm² (/100).
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
        a_mm2 = float((mesh.area_faces * np.abs((mesh.face_normals * d).sum(axis=1))).sum())
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
        # au pire: min/max global EDT
        v = edt[vol]
        if v.size == 0:
            return None, None
        return float(2.0 * v.min()), float(2.0 * v.max())

    vals = edt[skel]
    if vals.size == 0:
        return None, None

    return float(2.0 * vals.min()), float(2.0 * vals.max())

# =========================
# Résolution du fichier source (local / S3)
# =========================
def _resolve_source_path(file_id: str, step_path: Optional[str], step_ext: Optional[str]) -> str:
    # 1) chemin direct fourni ?
    if step_path and os.path.isfile(step_path):
        return step_path

    # 2) uploads locaux (on tente plusieurs extensions)
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

    # 6) Écrire les caches (toujours écrire stats + proj)
    base_payload = {
        "volume_mm3": float(vol_mm3) if vol_mm3 is not None else None,
        "volume_cm3": vol_cm3,
        "bbox_mm": bbox,
        "thickness_min_mm": round(float(tmin), 4) if tmin is not None else None,
        "thickness_max_mm": round(float(tmax), 4) if tmax is not None else None,
    }
    with open(base_cache, "w", encoding="utf-8") as fh:
        json.dump(base_payload, fh)

    proj_payload = {"projected_area_cm2": round(float(proj_cm2), 4)}
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
        "Caches écrits file_id=%s axis=%s  bbox=%s  vol=%s cm3  t=(%s,%s) mm  proj=%s cm2",
        file_id,
        axis,
        bbox,
        f"{vol_cm3:.4f}" if vol_cm3 is not None else "None",
        base_payload["thickness_min_mm"],
        base_payload["thickness_max_mm"],
        proj_payload["projected_area_cm2"],
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
