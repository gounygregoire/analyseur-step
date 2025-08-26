"""Mesh simplification helpers using trimesh."""

import trimesh


def mesh_simplify(mesh_in: str, mesh_out: str, *, factor: float) -> None:
    """Simplify mesh geometry with quadratic decimation.

    Parameters
    ----------
    mesh_in: str
        Source mesh path (STL).
    mesh_out: str
        Output mesh path.
    factor: float
        Fraction of faces to keep (0 < factor <= 1).
    """

    mesh = trimesh.load(mesh_in, force="mesh")
    target_faces = max(int(len(mesh.faces) * factor), 4)
    simplified = mesh.simplify_quadratic_decimation(target_faces)
    simplified.export(mesh_out)

