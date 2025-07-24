"""Heatmap generation for STL files using trimesh.
"""

from typing import List, Dict
import trimesh
import numpy as np


def generate_heatmap(stl_path: str) -> List[Dict[str, float]]:
    """Analyze an STL file and return per-face defect severity.

    Each dict in the returned list has the form::
        {"face_index": int, "severity": float}

    Severity is based on the maximum angular deviation between a face and
    its neighbours. Values are expressed in degrees.
    """
    mesh = trimesh.load(stl_path, process=False)

    if isinstance(mesh, trimesh.Scene):
        # Take first geometry if a scene is loaded
        if len(mesh.geometry) == 0:
            return []
        mesh = list(mesh.geometry.values())[0]

    # Simplify very large meshes to keep processing fast
    face_count = len(mesh.faces)
    if face_count > 1_000_000:
        try:
            simplified = mesh.simplify_quadratic_decimation(1_000_000)
            if simplified and len(simplified.faces) > 0:
                mesh = simplified
                face_count = len(mesh.faces)
        except Exception:
            pass

    normals = mesh.face_normals
    adjacency = mesh.face_adjacency

    severities = []
    for i in range(face_count):
        neighbours = adjacency[np.any(adjacency == i, axis=1)].flatten()
        neighbours = neighbours[neighbours != i]
        if len(neighbours) == 0:
            severity = 0.0
        else:
            neighbour_normals = normals[neighbours]
            dots = np.clip(neighbour_normals @ normals[i], -1.0, 1.0)
            angles = np.degrees(np.arccos(dots))
            severity = float(np.max(angles))
        severities.append({"face_index": int(i), "severity": severity})

    return severities
