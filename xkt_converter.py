"""
STEP/STP -> XKT conversion pipeline + Local thickness (mm).

Pipeline:
  1) STEP/STP --(CadQuery/OpenCascade)--> STL
  2) STL --(@xeokit/xeokit-convert)--> XKT

Dépendances:
  - cadquery (et OCC via OCP) pour STEP->STL
  - Node + @xeokit/xeokit-convert pour STL->XKT
  - Variable d'env (optionnelle): XEOKIT_CONVERT
      * chemin absolu du binaire 'xeokit-convert'
      * ou 'npx' pour utiliser npx à l'exécution

Épaisseur locale (mm):
  - Calcul par tirs de rayons ± normale sur un maillage OCC -> trimesh
  - Variables d'env optionnelles:
      THICKNESS_UNIT_HINT = mm | m | inch (défaut heuristique=mm)
      THICKNESS_SPF = 2            (samples per face)
      THICKNESS_MAX_SAMPLES = 50000
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import logging
import importlib
from pathlib import Path
from typing import Optional

_CQ = None


def _cadquery():
    global _CQ
    if _CQ is None:
        _CQ = importlib.import_module("cadquery")
    return _CQ

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))

# =====================================================================================
#                                   Utils XKT
# =====================================================================================

def _resolve_xeokit() -> str:
    """
    Retourne le binaire xeokit-convert à utiliser.
    1) XEOKIT_CONVERT si défini (peut être 'npx')
    2) which xeokit-convert
    3) fallback 'npx'
    """
    p = (os.environ.get("XEOKIT_CONVERT") or "").strip()
    if p:
        if p == "npx":
            return "npx"
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    p2 = shutil.which("xeokit-convert")
    return p2 if p2 else "npx"


def _step_to_stl(step_path: str, stl_path: str, tolerance: float = 0.6) -> None:
    """
    Convertit STEP -> STL via CadQuery.
    - tolerance plus grande => fichier plus léger et conversion plus rapide.
    """
    step = Path(step_path)
    out = Path(stl_path)
    if not step.exists():
        raise FileNotFoundError(step)
    out.parent.mkdir(parents=True, exist_ok=True)

    cq = _cadquery()

    logger.info("CadQuery import: %s", step)
    shape = cq.importers.importStep(str(step))

    logger.info("CadQuery export STL -> %s (tolerance=%.3f)", out, tolerance)
    cq.exporters.export(shape, str(out), "STL", tolerance=tolerance)

    # Sanity checks
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"STL non généré ou vide: {out}")
    logger.info("STL generated: %s (%.1f KB)", out, out.stat().st_size / 1024.0)


def _run_xeokit_convert(source: str, target: str, timeout: int = 600) -> None:
    """
    Exécute xeokit-convert:
      - d'abord avec -s/-o
      - si erreur 'unknown option', retente avec --source/--output
    Lève CalledProcessError en cas d'échec.
    """
    xeokit = _resolve_xeokit()
    base = [xeokit, "-y", "@xeokit/xeokit-convert"] if xeokit == "npx" else [xeokit]

    # Try short flags
    cmd = base + ["-s", source, "-o", target]
    logger.info("Executing: %s", " ".join(cmd))
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out_txt = ((res.stdout or "") + "\n" + (res.stderr or "")).strip()

    if res.returncode != 0:
        logger.warning("xeokit-convert rc=%s\n%s", res.returncode, out_txt[:1500])
        # Retry with long flags if relevant
        if "unknown option" in out_txt.lower():
            cmd = base + ["--source", source, "--output", target]
            logger.info("Retry with --source/--output: %s", " ".join(cmd))
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            out_txt = ((res.stdout or "") + "\n" + (res.stderr or "")).strip()

    if res.returncode != 0 or not Path(target).exists():
        logger.error("xeokit-convert failed (rc=%s)\n%s", res.returncode, out_txt[:2000])
        raise subprocess.CalledProcessError(res.returncode, cmd, output=res.stdout, stderr=res.stderr)


# ---------- Public API XKT ----------

def convert_step_to_xkt(step_path: str, xkt_path: str, *, stl_tolerance: float = 0.6, timeout: int = 600) -> None:
    """
    Convertit un STEP/STP en XKT via STL intermédiaire.

    :param step_path: chemin du fichier .step/.stp source
    :param xkt_path: chemin du .xkt cible
    :param stl_tolerance: tolérance d'export STL (plus grand = plus rapide/moins lourd)
    :param timeout: timeout total pour l'appel xeokit-convert
    """
    step = Path(step_path)
    xkt = Path(xkt_path)
    if not step.exists():
        raise FileNotFoundError(step)
    xkt.parent.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path(tempfile.mkdtemp(prefix="xktconv_"))
    stl_path = tmp_dir / (step.stem + ".stl")

    try:
        # 1) STEP -> STL (CadQuery)
        _step_to_stl(str(step), str(stl_path), tolerance=stl_tolerance)

        # 2) STL -> XKT (xeokit-convert)
        _run_xeokit_convert(str(stl_path), str(xkt), timeout=timeout)

        logger.info("XKT generated: %s (%.1f KB)", xkt, xkt.stat().st_size / 1024.0)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

# =====================================================================================
#                          Épaisseur locale (mm) – thickness
# =====================================================================================

def _resolve_unit_scale_mm(unit_hint: str | None, default: float = 1.0) -> float:
    """
    Retourne le facteur multiplicatif pour convertir les unités géométriques vers des millimètres.
    unit_hint: 'mm' | 'm' | 'inch' | None  (None => THICKNESS_UNIT_HINT ou heuristique=1.0)
    """
    if unit_hint is None:
        unit_hint = (os.getenv("THICKNESS_UNIT_HINT") or "").strip().lower() or None
    table = {"mm": 1.0, "m": 1000.0, "meter": 1000.0, "metre": 1000.0, "inch": 25.4, "in": 25.4}
    return float(table.get((unit_hint or "").lower(), default))


def _read_step_shape(step_path: str):
    """Lecture directe du STEP via pythonOCC → TopoDS_Shape."""
    from OCC.Core.STEPControl import STEPControl_Reader
    from OCC.Core.IFSelect import IFSelect_RetDone

    step = Path(step_path)
    if not step.exists():
        raise FileNotFoundError(step)

    reader = STEPControl_Reader()
    stat = reader.ReadFile(str(step))
    if stat != IFSelect_RetDone:
        raise RuntimeError(f"Impossible de lire le STEP: {step}")
    reader.TransferRoots()
    shape = reader.OneShape()
    return shape


def _occ_to_trimesh(shape, lin_def: float = 0.15, ang_def: float = 0.35):
    """
    Maillage OCC → trimesh.Trimesh
    """
    import numpy as np
    import trimesh
    from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
    from OCC.Core.BRep import BRep_Tool
    from OCC.Core.TopLoc import TopLoc_Location
    from OCC.Core.TopAbs import TopAbs_FACE
    from OCC.Core.TopExp import TopExp_Explorer

    BRepMesh_IncrementalMesh(shape, lin_def, False, ang_def, True).Perform()

    vertices = []
    faces = []
    v_offset = 0

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = exp.Current()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation(face, loc)
        if tri is None:
            exp.Next()
            continue

        trsf = loc.Transformation()
        nodes = tri.Nodes()

        for i in range(1, nodes.Size() + 1):
            p = nodes.Value(i).Transformed(trsf)
            vertices.append([p.X(), p.Y(), p.Z()])

        tris = tri.Triangles()
        for i in range(1, tris.Size() + 1):
            a, b, c = tris.Value(i).Get()
            faces.append([v_offset + a - 1, v_offset + b - 1, v_offset + c - 1])

        v_offset = len(vertices)
        exp.Next()

    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=np.float64),
                           faces=np.asarray(faces, dtype=np.int64),
                           process=True)
    if not mesh.is_watertight:
        mesh.remove_degenerate_faces()
        mesh.remove_duplicate_faces()
        mesh.remove_unreferenced_vertices()
        mesh.fill_holes()
        mesh.process(validate=True)
    return mesh


def _make_intersector(mesh):
    """Intersector rayons trimesh – pyembree si dispo (plus rapide), sinon fallback triangle."""
    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector
        logger.info("thickness: using pyembree intersector")
        return RayMeshIntersector(mesh)
    except Exception:
        from trimesh.ray.ray_triangle import RayMeshIntersector
        logger.info("thickness: using triangle intersector")
        return RayMeshIntersector(mesh)


def compute_thickness_mm_from_mesh(
    mesh,
    unit_scale_mm: float = 1.0,
    samples_per_face: int = 2,
    max_samples: int = 50000,
    backface_dot: float = -0.3,
    eps: float = 1e-6,
):
    """
    Calcule l'épaisseur locale par tirs de rayons ± normale depuis la peau du mesh.
    Retourne (t_min_mm, t_max_mm) en millimètres.
    """
    import numpy as np
    import trimesh

    if not isinstance(mesh, trimesh.Trimesh):
        raise TypeError("mesh must be trimesh.Trimesh")

    inter = _make_intersector(mesh)

    n_samples = max(5000, mesh.faces.shape[0] * samples_per_face)
    n_samples = min(n_samples, max_samples)

    # Échantillonnage uniforme de surface
    pts, f_idx = trimesh.sample.sample_surface_even(mesh, n_samples)
    n = mesh.face_normals[f_idx]

    # Origines décalées pour éviter l'auto-impact
    origins_p = pts + n * eps
    origins_m = pts - n * eps

    # Intersections (premier impact)
    loc_p, ir_p, it_p = inter.intersects_location(origins_p,  n, multiple_hits=False)
    loc_m, ir_m, it_m = inter.intersects_location(origins_m, -n, multiple_hits=False)

    dist = np.full(len(pts), np.inf)

    if len(ir_p):
        d = np.linalg.norm(loc_p - origins_p[ir_p], axis=1)
        nf = mesh.face_normals[it_p]
        good = (np.einsum("ij,ij->i", nf, n[ir_p]) < backface_dot)  # face opposée
        d[~good] = np.inf
        dist[ir_p] = np.minimum(dist[ir_p], d)

    if len(ir_m):
        d = np.linalg.norm(loc_m - origins_m[ir_m], axis=1)
        nf = mesh.face_normals[it_m]
        good = (np.einsum("ij,ij->i", nf, -n[ir_m]) < backface_dot)
        d[~good] = np.inf
        dist[ir_m] = np.minimum(dist[ir_m], d)

    d = dist[np.isfinite(dist)]
    d = d[d > 5 * eps]
    if d.size == 0:
        return float("nan"), float("nan")

    # min strict + max robuste (évite spikes numériques)
    tmin = float(d.min()) * unit_scale_mm
    tmax = float(np.percentile(d, 99.9)) * unit_scale_mm

    # garde-fou : le max ne peut pas dépasser la plus petite dimension de bbox
    tmax = min(tmax, float(min(mesh.extents) * unit_scale_mm))
    return round(tmin, 4), round(tmax, 4)


def compute_thickness_mm_from_occ_shape(
    shape,
    unit_hint: str | None = None,
    samples_per_face: int = 2,
    max_samples: int = 50000,
    backface_dot: float = -0.3,
):
    """
    Wrapper OCC -> mesh -> thickness (mm).
    """
    mesh = _occ_to_trimesh(shape)
    unit_scale_mm = _resolve_unit_scale_mm(unit_hint, default=1.0)
    return compute_thickness_mm_from_mesh(
        mesh,
        unit_scale_mm=unit_scale_mm,
        samples_per_face=samples_per_face,
        max_samples=max_samples,
        backface_dot=backface_dot,
    )


def compute_thickness_mm_from_step(
    step_path: str,
    unit_hint: str | None = None,
    samples_per_face: int = 2,
    max_samples: int = 50000,
    backface_dot: float = -0.3,
):
    """
    Lecture d'un STEP + calcul de l'épaisseur min/max en millimètres.
    Usage:
        tmin, tmax = compute_thickness_mm_from_step("part.step", unit_hint="mm")
    """
    shape = _read_step_shape(step_path)
    return compute_thickness_mm_from_occ_shape(
        shape,
        unit_hint=unit_hint,
        samples_per_face=samples_per_face,
        max_samples=max_samples,
        backface_dot=backface_dot,
    )

# =====================================================================================
#                                      CLI
# =====================================================================================

if __name__ == "__main__":
    import sys
    # Usage historique (conversion XKT) : python converter.py input.step output.xkt
    if len(sys.argv) == 3:
        convert_step_to_xkt(sys.argv[1], sys.argv[2])
        sys.exit(0)

    # Petit mode pratique pour tester l'épaisseur :
    # python converter.py --thickness input.step [mm|m|inch]
    if len(sys.argv) in (3, 4) and sys.argv[1] == "--thickness":
        unit = sys.argv[3] if len(sys.argv) == 4 else os.getenv("THICKNESS_UNIT_HINT")
        tmin, tmax = compute_thickness_mm_from_step(sys.argv[2], unit_hint=unit)
        print(f"thickness_min_mm={tmin}, thickness_max_mm={tmax}")
        sys.exit(0)

    print("Usage:")
    print("  python converter.py input.step output.xkt")
    print("  python converter.py --thickness input.step [mm|m|inch]")
    sys.exit(1)
