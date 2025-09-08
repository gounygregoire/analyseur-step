"""Chargement du STEP et utilitaires de métriques basés Trimesh."""

from __future__ import annotations

import os
import tempfile
from typing import Iterable, Tuple

import cadquery as cq
import numpy as np
import trimesh


def load_mesh(step_path: str, max_bytes: int | None = None) -> Tuple[trimesh.Trimesh, bool]:
    """Charge un STEP et retourne un mesh Trimesh.

    ``max_bytes`` peut être défini via l'argument ou la variable
    d'environnement ``STEP_LOADER_MAX_BYTES``. Si la taille du fichier
    dépasse cette valeur, une décimation est appliquée et ``low_res`` vaut
    ``True``.
    """

    limit = (
        max_bytes
        if max_bytes is not None
        else int(os.getenv("STEP_LOADER_MAX_BYTES", 100 * 1024 * 1024))
    )

    try:
        workplane = cq.importers.importStep(step_path)
    except Exception as exc:  # pragma: no cover - robustesse
        raise ValueError(f"Failed to load STEP: {exc}") from exc

    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp:
        cq.exporters.export(workplane, tmp.name)
        stl_path = tmp.name
    try:
        mesh = trimesh.load(stl_path, force="mesh")
        if isinstance(mesh, trimesh.Scene):
            if mesh.geometry:
                mesh = next(iter(mesh.geometry.values()))
            else:  # pragma: no cover - STEP vide
                raise ValueError("No geometry in STEP file")
        low_res = False
        if os.path.getsize(step_path) > limit:
            target = int(mesh.faces.shape[0] * 0.2)
            if target > 0:
                mesh = mesh.simplify_quadratic_decimation(target)
                low_res = True
        return mesh, low_res
    finally:
        if os.path.exists(stl_path):
            os.unlink(stl_path)


def compute_thickness(mesh: trimesh.Trimesh, samples: int = 1000) -> Tuple[float, float, Iterable[Tuple[float, float, int]], list]:
    """Évalue l'épaisseur moyenne et minimale du maillage."""

    points, faces = trimesh.sample.sample_surface(mesh, samples)
    normals = mesh.face_normals[faces]
    origins = points - normals * 1e-3
    hits, ray_idx, _ = mesh.ray.intersects_location(origins, -normals, multiple_hits=False)
    thickness = np.full(samples, np.nan)
    thickness[ray_idx] = np.linalg.norm(hits - points[ray_idx], axis=1)
    thickness = thickness[~np.isnan(thickness)]
    if len(thickness) == 0:
        return 0.0, 0.0, [], []
    avg = float(thickness.mean())
    min_th = float(thickness.min())
    if np.ptp(thickness) < 1e-9:
        histogram = [(float(thickness.min()), float(thickness.max()), len(thickness))]
    else:
        hist, edges = np.histogram(thickness, bins=10)
        histogram = [
            (float(edges[i]), float(edges[i + 1]), int(hist[i]))
            for i in range(len(hist))
        ]
    per_face: dict[int, list[float]] = {}
    for f, t in zip(faces[: len(thickness)], thickness):
        per_face.setdefault(int(f), []).append(float(t))
    per_face_avg = [
        {"face_id": fid, "value": float(np.mean(vals))}
        for fid, vals in per_face.items()
    ]
    return avg, min_th, histogram, per_face_avg


def compute_projected_area(mesh: trimesh.Trimesh, axis: Tuple[float, float, float]) -> float:
    """Surface projetée sur le plan perpendiculaire à ``axis``."""

    axis_v = np.asarray(axis, dtype=float)
    axis_v /= np.linalg.norm(axis_v) or 1.0
    proj = np.eye(3) - np.outer(axis_v, axis_v)
    projected = (mesh.vertices @ proj.T)[mesh.faces]
    areas = np.cross(projected[:, 1] - projected[:, 0], projected[:, 2] - projected[:, 0])
    return float(0.5 * np.linalg.norm(areas, axis=1).sum())


def compute_draft(mesh: trimesh.Trimesh, axis: Tuple[float, float, float], min_deg: float) -> Tuple[float, list]:
    """Calcule le ratio de dépouille valide et retourne les faces hors tolérance."""

    axis_v = np.asarray(axis, dtype=float)
    axis_v /= np.linalg.norm(axis_v) or 1.0
    normals = mesh.face_normals
    angles = np.degrees(np.arccos(np.clip(np.abs(normals @ axis_v), -1.0, 1.0)))
    draft = 90.0 - angles
    ok_ratio = float(np.mean(draft >= min_deg))
    issues = []
    for i, d in enumerate(draft):
        if d < min_deg:
            c = mesh.triangles_center[i]
            issues.append(
                {
                    "face_id": int(i),
                    "point": (float(c[0]), float(c[1]), float(c[2])),
                    "value": float(d),
                }
            )
    return ok_ratio, issues


def find_small_radii(mesh: trimesh.Trimesh, min_radius: float = 0.5) -> Tuple[float, list]:
    """Détecte les zones à faible rayon de courbure."""

    curv = trimesh.curvature.discrete_gaussian_curvature_measure(
        mesh, np.arange(len(mesh.vertices)), 1.0
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        radius = np.where(curv != 0, 1.0 / np.abs(curv), np.inf)
    min_r = float(np.nanmin(radius)) if len(radius) else 0.0
    issues = []
    if min_r < min_radius:
        idx = int(np.nanargmin(radius))
        v = mesh.vertices[idx]
        issues.append(
            {
                "face_id": idx,
                "point": (float(v[0]), float(v[1]), float(v[2])),
                "value": min_r,
            }
        )
    return min_r, issues


def detect_undercuts(mesh: trimesh.Trimesh, axis: Tuple[float, float, float]) -> list:
    """Renvoie les faces orientées contre l'axe de démoulage."""

    axis_v = np.asarray(axis, dtype=float)
    axis_v /= np.linalg.norm(axis_v) or 1.0
    dots = mesh.face_normals @ axis_v
    issues = []
    for i, dot in enumerate(dots):
        if dot > 0:  # face orientée vers le démoulage → contre-dépouille
            c = mesh.triangles_center[i]
            issues.append(
                {
                    "face_id": int(i),
                    "point": (float(c[0]), float(c[1]), float(c[2])),
                    "value": float(dot),
                }
            )
    return issues

