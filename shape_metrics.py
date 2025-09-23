# shape_metrics.py — version maillage (pas d'import OCP direct)
from __future__ import annotations
import os, io, json, math, tempfile, hashlib, random
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Tuple, Optional, Dict

import numpy as np
import trimesh

# CadQuery uniquement pour convertir STEP -> STL (aucun import OCP direct ici)
import importlib
_CQ = None
def _cadquery():
    global _CQ
    if _CQ is None:
        _CQ = importlib.import_module("cadquery")
    return _CQ

# (Optionnel) Pillow pour une surface projetée précise par rasterisation
try:
    from PIL import Image, ImageDraw
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False

Axis = Literal["X", "Y", "Z"]

# --------------------------- Utils ---------------------------
def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]

def _ensure_dir(p: str | Path):
    Path(p).mkdir(parents=True, exist_ok=True)

def _proj2d(vertices_mm: np.ndarray, axis: Axis) -> np.ndarray:
    if axis == "Z":  # plan XY
        return vertices_mm[:, [0, 1]]
    if axis == "X":  # plan YZ
        return vertices_mm[:, [1, 2]]
    return vertices_mm[:, [0, 2]]  # "Y" -> plan XZ

def _bbox2d(pts2d: np.ndarray):
    mins = pts2d.min(axis=0)
    maxs = pts2d.max(axis=0)
    return float(mins[0]), float(mins[1]), float(maxs[0]), float(maxs[1])

def _triangle_areas_2d(pts2d: np.ndarray, faces: np.ndarray) -> float:
    v0 = pts2d[faces[:, 0]]
    v1 = pts2d[faces[:, 1]]
    v2 = pts2d[faces[:, 2]]
    areas = 0.5 * np.abs(
        v0[:, 0] * (v1[:, 1] - v2[:, 1]) +
        v1[:, 0] * (v2[:, 1] - v0[:, 1]) +
        v2[:, 0] * (v0[:, 1] - v1[:, 1])
    )
    return float(areas.sum())

def _raster_union_area_mm2(pts2d: np.ndarray, faces: np.ndarray, max_px: int = 2000) -> Optional[float]:
    if not _HAS_PIL:
        return None
    minx, miny, maxx, maxy = _bbox2d(pts2d)
    w_mm = max(1e-9, maxx - minx)
    h_mm = max(1e-9, maxy - miny)
    scale = max_px / max(w_mm, h_mm)
    scale = max(scale, 1.0)  # >= 1 px/mm

    W = int(min(max_px, max(8, math.ceil(w_mm * scale))))
    H = int(min(max_px, max(8, math.ceil(h_mm * scale))))
    def to_px(p):
        x = (p[:, 0] - minx) * scale
        y = (p[:, 1] - miny) * scale
        return np.c_[x, (H - 1) - y]

    img = Image.new("1", (W, H), 0)
    draw = ImageDraw.Draw(img)
    for f in faces:
        tri = to_px(pts2d[f])
        poly = [tuple(map(float, tri[i])) for i in range(3)]
        draw.polygon(poly, fill=1, outline=1)
    on = np.array(img, dtype=np.uint8).sum()
    mm_per_px = 1.0 / scale
    return float(on * (mm_per_px ** 2))

# --------------------- Mesh (depuis STEP via CadQuery) -------------------
def _ensure_mesh_from_step(step_path: str) -> trimesh.Trimesh:
    """Exporte un STL via CadQuery puis charge en Trimesh. Unités : mm."""
    cq = _cadquery()
    tmp_dir = Path(tempfile.mkdtemp(prefix="shape_metrics_"))
    stl_path = tmp_dir / (Path(step_path).stem + ".stl")
    try:
        shape = cq.importers.importStep(str(step_path))
        # maillage raisonnable en perf/qualité
        cq.exporters.export(shape, str(stl_path), "STL", tolerance=0.6)
        if not stl_path.exists() or stl_path.stat().st_size == 0:
            raise RuntimeError("STL non généré")
        mesh = trimesh.load_mesh(str(stl_path), file_type="stl", process=True)
        # nettoyer un peu si nécessaire
        if mesh.is_empty:
            raise RuntimeError("Maillage vide")
        mesh.remove_degenerate_faces()
        mesh.remove_unreferenced_vertices()
        mesh.rezero()
        return mesh
    finally:
        try:
            for p in tmp_dir.glob("*"):
                p.unlink(missing_ok=True)
            tmp_dir.rmdir()
        except Exception:
            pass

# --------------------- Métriques à partir du mesh -----------------------
def compute_volume_mm3(mesh: trimesh.Trimesh) -> float:
    """Volume signé -> on prend la valeur absolue. (mm³)"""
    try:
        vol = float(abs(mesh.volume))
        if not np.isfinite(vol): vol = 0.0
        return vol
    except Exception:
        return 0.0

def compute_bbox_mm(mesh: trimesh.Trimesh) -> Tuple[float, float, float]:
    bounds = mesh.bounds  # (min, max)
    if bounds is None or len(bounds) != 2:
        return (0.0, 0.0, 0.0)
    mins, maxs = bounds
    dims = np.maximum(0.0, maxs - mins)
    return float(dims[0]), float(dims[1]), float(dims[2])

def compute_projected_area_cm2(mesh: trimesh.Trimesh, axis: Axis, *, max_px: int = 2000) -> float:
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int32)
    pts2d = _proj2d(verts, axis)
    area_mm2 = _raster_union_area_mm2(pts2d, faces, max_px=max_px)
    if area_mm2 is None:
        area_mm2 = _triangle_areas_2d(pts2d, faces)
    return float(area_mm2 / 100.0)  # -> cm²

def compute_thickness_minmax_mm(mesh: trimesh.Trimesh, *, samples: int = 2000, seed: int = 42) -> Tuple[float, float]:
    """Estimation : raycasts à partir de sommets vers l'intérieur (normales)."""
    rng = random.Random(seed)
    n = len(mesh.vertices)
    if n == 0:
        return (0.0, 0.0)
    idxs = list(range(n)); rng.shuffle(idxs); idxs = idxs[: min(samples, n)]
    origins = mesh.vertices[idxs]
    norms   = mesh.vertex_normals[idxs]
    eps = 0.01
    dirs_in = -norms
    origins_in = origins + norms * eps
    try:
        intersector = trimesh.ray.ray_pyembree.RayMeshIntersector(mesh)
    except Exception:
        intersector = trimesh.ray.ray_triangle.RayMeshIntersector(mesh)

    dists = []
    BATCH = 10000
    for i in range(0, len(origins_in), BATCH):
        ori = origins_in[i:i+BATCH]
        dirv= dirs_in[i:i+BATCH]
        try:
            hits = intersector.intersects_first(ray_origins=ori, ray_directions=dirv)
        except Exception:
            loc = intersector.intersects_location(ray_origins=ori, ray_directions=dirv)
            points, index_ray, _ = loc
            _d = np.full(len(ori), -1.0, dtype=np.float64)
            for j, p in zip(index_ray, points):
                v = p - ori[j]
                dist = float(np.linalg.norm(v))
                if _d[j] < 0 or dist < _d[j]:
                    _d[j] = dist
            hits = _d
        for h in hits:
            if h is not None and h > eps * 0.5:
                dists.append(float(h))
    if not dists:
        return (0.0, 0.0)
    return float(max(0.0, min(dists))), float(max(dists))

# --------------------- API haut niveau + cache --------------------------
@dataclass
class ShapeStats:
    units: str
    volume_cm3: float
    projected_area_cm2: float
    thickness_min_mm: float
    thickness_max_mm: float
    bbox_mm: Tuple[float, float, float]

def compute_stats(step_path: str, axis: Axis = "Z",
                  cache_dir: Optional[str] = None,
                  file_id: Optional[str] = None) -> ShapeStats:
    step_path = str(step_path)
    axis = (axis or "Z").upper()
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    stats_base_name = (file_id or _hash_file(step_path))
    vol_mm3 = bbox_mm = tmin = tmax = proj_cm2 = None
    cache_base = cache_proj = None

    if cache_dir:
        _ensure_dir(cache_dir)
        cache_base = Path(cache_dir) / f"{stats_base_name}.stats.json"
        cache_proj = Path(cache_dir) / f"{stats_base_name}.proj.{axis}.json"
        if cache_base.exists():
            try:
                j = json.loads(cache_base.read_text("utf-8"))
                vol_mm3 = j.get("volume_mm3")
                bbox_mm = tuple(j.get("bbox_mm") or []) or None
                tmin = j.get("thickness_min_mm")
                tmax = j.get("thickness_max_mm")
            except Exception:
                pass
        if cache_proj.exists():
            try:
                j = json.loads(cache_proj.read_text("utf-8"))
                proj_cm2 = j.get("projected_area_cm2")
            except Exception:
                pass

    # On travaille depuis le maillage (généré depuis le STEP)
    mesh = _ensure_mesh_from_step(step_path)

    # volume / bbox / thickness (indépendants de l’axe)
    if vol_mm3 is None or bbox_mm is None or tmin is None or tmax is None:
        vol_mm3 = compute_volume_mm3(mesh)
        bbox_mm = compute_bbox_mm(mesh)
        tmin, tmax = compute_thickness_minmax_mm(mesh)
        if cache_base:
            try:
                cache_base.write_text(json.dumps({
                    "volume_mm3": vol_mm3,
                    "bbox_mm": list(bbox_mm),
                    "thickness_min_mm": tmin,
                    "thickness_max_mm": tmax
                }, ensure_ascii=False, indent=2))
            except Exception:
                pass

    # surface projetée (dépend de l’axe)
    if proj_cm2 is None:
        proj_cm2 = compute_projected_area_cm2(mesh, axis)
        if cache_dir:
            try:
                (Path(cache_dir) / f"{stats_base_name}.proj.{axis}.json").write_text(json.dumps({
                    "axis": axis,
                    "projected_area_cm2": proj_cm2
                }, ensure_ascii=False, indent=2))
            except Exception:
                pass

    return ShapeStats(
        units="mm_internal",
        volume_cm3=float((vol_mm3 or 0.0) / 1000.0),   # mm3 -> cm3
        projected_area_cm2=float(proj_cm2 or 0.0),
        thickness_min_mm=float(tmin or 0.0),
        thickness_max_mm=float(tmax or 0.0),
        bbox_mm=tuple(bbox_mm or (0.0, 0.0, 0.0))
    )

def stats_json(step_path: str, axis: Axis = "Z",
               cache_dir: Optional[str] = None,
               file_id: Optional[str] = None) -> Dict:
    s = compute_stats(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)
    return {
        "units": s.units,
        "volume_cm3": round(s.volume_cm3, 4),
        "projected_area_cm2": round(s.projected_area_cm2, 4),
        "thickness_min_mm": round(s.thickness_min_mm, 4),
        "thickness_max_mm": round(s.thickness_max_mm, 4),
        "bbox_mm": [round(x, 4) for x in s.bbox_mm],
    }
