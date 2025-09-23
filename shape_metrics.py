# shape_metrics.py
"""
Analyse géométrique d'une pièce STEP :
- Volume (cm3) via OpenCascade
- Surface projetée (cm2) selon axe X/Y/Z (ombre portée orthographique)
- Épaisseur min/max (mm) par raycasts à partir du maillage
- BBox (mm)
- Cache JSON par file_id (+ par axe pour la surface projetée)

Dépendances attendues côté serveur (déjà présentes dans ton projet) :
- OCC (pythonocc-core / OCP via CadQuery)
- cadquery (pour exporter un STL temporaire si besoin)
- trimesh (chargement STL + raycasts)
- numpy
- (optionnel) Pillow (PIL) pour rasterisation précise de la surface projetée ;
  sinon, fallback approximatif (somme des aires projetées des triangles).

Unités :
- Interne : millimètres (mm)
- Sortie : volume en cm3 ; surface projetée en cm2 ; épaisseurs en mm ; bbox en mm
"""

from __future__ import annotations
import os, io, json, math, hashlib, tempfile, random
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Tuple, Optional, Dict

import numpy as np

# --- OCP imports (CadQuery-OCP) ---
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepGProp import brepgprop_VolumeProperties
from OCP.GProp import GProp_GProps
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import brepbndlib_Add
from OCP.TopoDS import TopoDS_Shape

# CadQuery pour export STL (utile pour Trimesh si on n'a pas un STL déjà)
import importlib
_CQ = None
def _cadquery():
    global _CQ
    if _CQ is None:
        _CQ = importlib.import_module("cadquery")
    return _CQ

# Trimesh pour mesh + raycasts
import trimesh

# (Optionnel) Pillow pour rasterisation précise
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
    """Projette des points 3D (mm) sur un plan 2D selon l'axe ⟂ au plan.
       - axis='Z' => plan XY -> retourne (x, y)
       - axis='X' => plan YZ -> retourne (y, z)
       - axis='Y' => plan XZ -> retourne (x, z)
    """
    if axis == "Z":
        return vertices_mm[:, [0, 1]]
    if axis == "X":
        return vertices_mm[:, [1, 2]]
    return vertices_mm[:, [0, 2]]  # "Y"


def _bbox2d(pts2d: np.ndarray) -> Tuple[float, float, float, float]:
    """BBox 2D (minx, miny, maxx, maxy)"""
    mins = pts2d.min(axis=0)
    maxs = pts2d.max(axis=0)
    return float(mins[0]), float(mins[1]), float(maxs[0]), float(maxs[1])


def _triangle_areas_2d(pts2d: np.ndarray, faces: np.ndarray) -> float:
    """Somme des aires 2D des triangles projetés (approx ; double-compte si recouvrement)"""
    v0 = pts2d[faces[:, 0]]
    v1 = pts2d[faces[:, 1]]
    v2 = pts2d[faces[:, 2]]
    # Aire = 0.5 * | x1(y2 - y3) + x2(y3 - y1) + x3(y1 - y2) |
    areas = 0.5 * np.abs(
        v0[:, 0] * (v1[:, 1] - v2[:, 1]) +
        v1[:, 0] * (v2[:, 1] - v0[:, 1]) +
        v2[:, 0] * (v0[:, 1] - v1[:, 1])
    )
    return float(areas.sum())


def _raster_union_area_mm2(pts2d: np.ndarray, faces: np.ndarray, max_px: int = 2000) -> Optional[float]:
    """Aire d'union des triangles projetés par rasterisation (mm²).
       Retourne None si PIL indisponible, pour laisser le fallback approché.
    """
    if not _HAS_PIL:
        return None
    minx, miny, maxx, maxy = _bbox2d(pts2d)
    w_mm = max(1e-9, maxx - minx)
    h_mm = max(1e-9, maxy - miny)
    # Limiter la dimension max pour garder des temps raisonnables
    scale = max_px / max(w_mm, h_mm)
    # Éviter des images minuscules si pièce très petite
    scale = max(scale, 1.0)  # >= 1 px / mm

    W = int(math.ceil(w_mm * scale))
    H = int(math.ceil(h_mm * scale))
    W = max(8, min(W, max_px))
    H = max(8, min(H, max_px))

    # Transformation monde(mm) -> pixels
    def to_px(p):
        x = (p[:, 0] - minx) * scale
        y = (p[:, 1] - miny) * scale
        # Pillow: origine en haut-gauche, y vers le bas
        return np.c_[x, (H - 1) - y]

    img = Image.new("1", (W, H), 0)  # 1-bit, fond noir
    draw = ImageDraw.Draw(img)

    # Dessin de chaque triangle rempli
    for f in faces:
        tri = to_px(pts2d[f])
        # tuples [(x0,y0),(x1,y1),(x2,y2)]
        poly = [tuple(map(float, tri[i])) for i in range(3)]
        draw.polygon(poly, fill=1, outline=1)

    # Nombre de pixels "on"
    on = np.array(img, dtype=np.uint8).sum()
    # Aire par pixel = (mm/px)^2
    mm_per_px = 1.0 / scale
    area_mm2 = on * (mm_per_px ** 2)
    return float(area_mm2)


# --------------------- Lecture STEP & métriques OCC ---------------------

def load_shape(step_path: str) -> TopoDS_Shape:
    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Impossible de lire le STEP: {step_path}")
    ok = reader.TransferRoots()
    if not ok:
        raise RuntimeError("TransferRoots a échoué (STEP)")
    shape = reader.OneShape() if hasattr(reader, "OneShape") else reader.Shape(1)
    return shape


def compute_volume_mm3(shape: TopoDS_Shape) -> float:
    props = GProp_GProps()
    brepgprop_VolumeProperties(shape, props, True, True)  # skipClosed=False; Limiting=True
    vol = props.Mass()  # mm^3 si la géométrie est en mm
    return float(max(0.0, vol))


def compute_bbox_mm(shape: TopoDS_Shape) -> Tuple[float, float, float]:
    box = Bnd_Box()
    brepbndlib_Add(shape, box, True)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return (float(xmax - xmin), float(ymax - ymin), float(zmax - zmin))


# --------------------- Mesh (STL) pour analyses maillage ----------------

def _ensure_mesh_from_step(step_path: str) -> trimesh.Trimesh:
    """
    Construit un maillage depuis le STEP en exportant un STL temporaire via CadQuery,
    puis charge ce STL dans Trimesh. Unités : mm.
    """
    cq = _cadquery()
    tmp_dir = Path(tempfile.mkdtemp(prefix="shape_metrics_"))
    stl_path = tmp_dir / (Path(step_path).stem + ".stl")
    try:
        shape = cq.importers.importStep(str(step_path))
        # tolérance : compromis vitesse/qualité (comme ton converter)
        cq.exporters.export(shape, str(stl_path), "STL", tolerance=0.6)
        if not stl_path.exists() or stl_path.stat().st_size == 0:
            raise RuntimeError("STL non généré")
        mesh = trimesh.load_mesh(str(stl_path), file_type="stl", process=True)
        # S'assurer qu'on a des normales
        if not mesh.is_watertight:
            # Ce n'est pas bloquant pour l'analyse, mais on le note.
            pass
        if mesh.vertex_normals is None or len(mesh.vertex_normals) == 0:
            mesh.rezero()
            mesh.remove_degenerate_faces()
            mesh.remove_unreferenced_vertices()
            mesh.rezero()  # recalc interne
        return mesh
    finally:
        try:
            for p in tmp_dir.glob("*"):
                p.unlink(missing_ok=True)
            tmp_dir.rmdir()
        except Exception:
            pass


# --------------------- Surface projetée (cm²) ---------------------------

def compute_projected_area_cm2(mesh: trimesh.Trimesh, axis: Axis, *, max_px: int = 2000) -> float:
    """
    Aire de l'ombre portée sur le plan ⟂ à l'axe donné.
    - Si Pillow dispo : rasterisation (union exacte à la résolution choisie) -> mm²
    - Sinan : fallback approximatif = somme des aires projetées des triangles -> mm²
    Retour : cm² (mm² / 100)
    """
    verts = np.array(mesh.vertices, dtype=np.float64)  # mm
    faces = np.array(mesh.faces, dtype=np.int32)
    pts2d = _proj2d(verts, axis)

    area_mm2 = _raster_union_area_mm2(pts2d, faces, max_px=max_px)
    if area_mm2 is None:
        # Fallback rapide (peut sur- compter si recouvrements)
        area_mm2 = _triangle_areas_2d(pts2d, faces)

    return float(area_mm2 / 100.0)  # -> cm²


# --------------------- Épaisseur min/max (mm) ---------------------------

def compute_thickness_minmax_mm(mesh: trimesh.Trimesh, *, samples: int = 2000, seed: int = 42) -> Tuple[float, float]:
    """
    Estimation d'épaisseur : on échantillonne des points (sommets) et on tire des rayons
    le long de la normale **vers l'intérieur** (offset de 0.01 mm) pour récupérer
    la première intersection opposée. Distance = épaisseur locale approximative.
    """
    rng = random.Random(seed)
    n = len(mesh.vertices)
    if n == 0:
        return (0.0, 0.0)
    idxs = list(range(n))
    rng.shuffle(idxs)
    idxs = idxs[: min(samples, n)]

    origins = mesh.vertices[idxs]
    norms = mesh.vertex_normals[idxs]
    # petits offsets pour s'éloigner de la surface de départ
    eps = 0.01  # mm
    dirs_in = -norms  # vers l'intérieur
    origins_in = origins + norms * eps

    # Trimesh intersector
    # Si pyembree dispo, trimesh l'utilisera pour accélérer
    intersector = trimesh.ray.ray_pyembree.RayMeshIntersector(mesh) \
        if hasattr(trimesh.ray, "ray_pyembree") else trimesh.ray.ray_triangle.RayMeshIntersector(mesh)

    # distances le long de la direction "in"
    # NB: ray_pyembree renvoie (index_tri, distances) ; ray_triangle -> similaire
    dists = []
    BATCH = 10000
    for i in range(0, len(origins_in), BATCH):
        ori_batch = origins_in[i:i+BATCH]
        dir_batch = dirs_in[i:i+BATCH]
        try:
            hits = intersector.intersects_first(ray_origins=ori_batch, ray_directions=dir_batch)
            # intersects_first -> distances; -1 si pas d'intersection
        except Exception:
            # fallback: distances multiples -> on prend le premier positif
            loc = intersector.intersects_location(ray_origins=ori_batch, ray_directions=dir_batch)
            # loc = (points, index_ray, index_tri)
            # reconstruire par ray
            points, index_ray, _ = loc
            # init à -1
            _d = np.full(len(ori_batch), -1.0, dtype=np.float64)
            # pour chaque hit, calcule distance origine->point
            for j, p in zip(index_ray, points):
                v = p - ori_batch[j]
                dist = float(np.linalg.norm(v))
                if _d[j] < 0 or dist < _d[j]:
                    _d[j] = dist
            hits = _d

        # garder seulement > 0
        for h in hits:
            if h is not None and h > eps * 0.5:  # > ~0, filtrer les auto-hits
                dists.append(float(h))

    if not dists:
        return (0.0, 0.0)

    tmin = float(max(0.0, min(dists)))
    tmax = float(max(dists))
    return (tmin, tmax)


# --------------------- API de haut niveau -------------------------------

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
    """
    Calcule (ou lit cache) et renvoie les métriques pour un fichier STEP donné.
    - step_path : chemin du STEP
    - axis      : 'X' / 'Y' / 'Z' pour la surface projetée
    - cache_dir : dossier où écrire/chercher les JSON (ex: OUTPUT_FOLDER dans web.py)
    - file_id   : pour nommer proprement les fichiers de cache
    """
    step_path = str(step_path)
    axis = axis.upper() if axis else "Z"
    if axis not in ("X", "Y", "Z"):
        axis = "Z"

    # 1) Cache
    stats_base_name = (file_id or _hash_file(step_path))
    cache_base = None
    if cache_dir:
        _ensure_dir(cache_dir)
        cache_base = Path(cache_dir) / f"{stats_base_name}.stats.json"
        cache_proj = Path(cache_dir) / f"{stats_base_name}.proj.{axis}.json"
        # lecture cache global
        vol_mm3 = bbox_mm = tmin = tmax = None
        if cache_base.exists():
            try:
                j = json.loads(cache_base.read_text("utf-8"))
                vol_mm3 = j.get("volume_mm3")
                bbox_mm = tuple(j.get("bbox_mm") or []) or None
                tmin = j.get("thickness_min_mm")
                tmax = j.get("thickness_max_mm")
            except Exception:
                pass
        # lecture cache proj
        proj_cm2 = None
        if cache_proj.exists():
            try:
                j = json.loads(cache_proj.read_text("utf-8"))
                proj_cm2 = j.get("projected_area_cm2")
            except Exception:
                pass
    else:
        vol_mm3 = bbox_mm = tmin = tmax = proj_cm2 = None

    # 2) Calculs manquants
    shape = None
    mesh = None

    # volume / bbox / thickness (indépendants de l'axe) -> cache_base
    if vol_mm3 is None or bbox_mm is None or tmin is None or tmax is None:
        # Lire le STEP
        shape = load_shape(step_path)
        # Volume & bbox via OCC (mm^3 / mm)
        vol_mm3 = vol_mm3 or compute_volume_mm3(shape)
        bbox_mm = bbox_mm or compute_bbox_mm(shape)
        # Maillage pour épaisseurs
        mesh = _ensure_mesh_from_step(step_path)
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

    # surface projetée (dépend de l'axe) -> cache_proj
    if proj_cm2 is None:
        if mesh is None:
            mesh = _ensure_mesh_from_step(step_path)
        proj_cm2 = compute_projected_area_cm2(mesh, axis)
        if cache_dir:
            cache_proj = Path(cache_dir) / f"{stats_base_name}.proj.{axis}.json"
            try:
                cache_proj.write_text(json.dumps({
                    "axis": axis,
                    "projected_area_cm2": proj_cm2
                }, ensure_ascii=False, indent=2))
            except Exception:
                pass

    # 3) Conversion volume -> cm3
    volume_cm3 = float((vol_mm3 or 0.0) / 1000.0)  # 1 cm3 = 1000 mm3

    return ShapeStats(
        units="mm_internal",
        volume_cm3=volume_cm3,
        projected_area_cm2=float(proj_cm2 or 0.0),
        thickness_min_mm=float(tmin or 0.0),
        thickness_max_mm=float(tmax or 0.0),
        bbox_mm=tuple(bbox_mm or (0.0, 0.0, 0.0))
    )


# --------------------- Helper pour route Flask --------------------------

def stats_json(step_path: str, axis: Axis = "Z",
               cache_dir: Optional[str] = None,
               file_id: Optional[str] = None) -> Dict:
    """Renvoie un dict JSON prêt à jsonify() dans Flask."""
    s = compute_stats(step_path, axis=axis, cache_dir=cache_dir, file_id=file_id)
    return {
        "units": s.units,
        "volume_cm3": round(s.volume_cm3, 4),
        "projected_area_cm2": round(s.projected_area_cm2, 4),
        "thickness_min_mm": round(s.thickness_min_mm, 4),
        "thickness_max_mm": round(s.thickness_max_mm, 4),
        "bbox_mm": [round(x, 4) for x in s.bbox_mm],
    }
