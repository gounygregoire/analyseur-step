# thickness.py
import os
import math
import logging
import numpy as np

log = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))

# ---------- Intersector helper (pyembree si dispo) ----------
def _make_intersector(mesh):
    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector
        log.info("thickness: using pyembree intersector")
        return RayMeshIntersector(mesh)
    except Exception:
        from trimesh.ray.ray_triangle import RayMeshIntersector
        log.info("thickness: using triangle intersector")
        return RayMeshIntersector(mesh)

# ---------- Units ----------
def resolve_unit_scale_mm(unit_hint: str | None, default: float = 1.0) -> float:
    """
    Retourne le facteur multiplicatif pour convertir les unités du mesh vers des millimètres.
    unit_hint: 'mm' | 'm' | 'inch' | None
    """
    if unit_hint is None:
        unit_hint = os.getenv("THICKNESS_UNIT_HINT", "").strip().lower() or None
    table = {"mm": 1.0, "m": 1000.0, "meter": 1000.0, "metre": 1000.0, "inch": 25.4, "in": 25.4}
    return float(table.get((unit_hint or "").lower(), default))

# ---------- OCC -> Trimesh ----------
def _occ_to_trimesh(shape, lin_def: float = 0.15, ang_def: float = 0.35):
    """
    Maillage OCC → trimesh.Trimesh
    """
    from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
    from OCC.Core.BRep import BRep_Tool
    from OCC.Core.TopLoc import TopLoc_Location
    from OCC.Core.TopAbs import TopAbs_FACE
    from OCC.Core.TopExp import TopExp_Explorer
    import trimesh

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

# ---------- Thickness core ----------
def compute_thickness_mm_from_mesh(
    mesh,
    unit_scale_mm: float = 1.0,
    samples_per_face: int = 2,
    max_samples: int = 50000,
    backface_dot: float = -0.3,
    eps: float = 1e-6,
):
    """
    Calcule épaisseur locale par tirs de rayons ± normale.
    Retourne (t_min_mm, t_max_mm) en millimètres.
    """
    import trimesh

    if not isinstance(mesh, trimesh.Trimesh):
        raise TypeError("mesh must be trimesh.Trimesh")

    inter = _make_intersector(mesh)

    n_samples = max(5000, mesh.faces.shape[0] * samples_per_face)
    n_samples = min(n_samples, max_samples)

    # échantillonnage uniforme de surface
    pts, f_idx = trimesh.sample.sample_surface_even(mesh, n_samples)
    n = mesh.face_normals[f_idx]

    # origines décalées pour éviter auto-hit
    origins_p = pts + n * eps
    origins_m = pts - n * eps

    # intersections (premier impact)
    loc_p, ir_p, it_p = inter.intersects_location(origins_p,  n, multiple_hits=False)
    loc_m, ir_m, it_m = inter.intersects_location(origins_m, -n, multiple_hits=False)

    dist = np.full(len(pts), np.inf)

    if len(ir_p):
        d = np.linalg.norm(loc_p - origins_p[ir_p], axis=1)
        nf = mesh.face_normals[it_p]
        # “opposé” : normale de l’impact à l’opposé de la direction tirée
        good = (np.einsum("ij,ij->i", nf, n[ir_p]) < backface_dot)
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
    Wrapper OCC → mesh → thickness (mm)
    """
    mesh = _occ_to_trimesh(shape)
    unit_scale_mm = resolve_unit_scale_mm(unit_hint, default=1.0)
    return compute_thickness_mm_from_mesh(
        mesh,
        unit_scale_mm=unit_scale_mm,
        samples_per_face=samples_per_face,
        max_samples=max_samples,
        backface_dot=backface_dot,
    )
