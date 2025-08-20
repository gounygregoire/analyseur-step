import json
import gzip
import math
from typing import Dict, List

import cadquery as cq

# Mapping severity to RGB colors
SEVERITY_COLORS: Dict[str, List[float]] = {
    "low": [0.4, 0.8, 0.0],
    "medium": [1.0, 1.0, 0.0],
    "high": [1.0, 0.6, 0.0],
    "critical": [1.0, 0.0, 0.0],
}


def _severity_from_ratio(ratio: float) -> str:
    if ratio < 0.5:
        return "critical"
    if ratio < 1.0:
        return "high"
    if ratio < 1.5:
        return "medium"
    return "low"


def export_step(step_path: str, gzip_output: bool = True) -> bytes:
    """Analyse un fichier STEP et retourne un JSON gzippé selon le schéma DFM."""
    model = cq.importers.importStep(step_path)
    shape = model.val()
    faces = list(shape.Faces())
    edges = list(shape.Edges())

    issues: List[Dict] = []
    face_issue_map: Dict[str, List[str]] = {}
    issue_counter = 1

    def add_issue(issue: Dict):
        nonlocal issue_counter
        issue_id = f"ISSUE-{issue_counter:04d}"
        issue["id"] = issue_id
        issues.append(issue)
        for loc in issue.get("locations", []):
            fi = loc.get("faceIndex")
            if fi is not None:
                face_issue_map.setdefault(str(fi), []).append(issue_id)
        issue_counter += 1

    # --- Thin wall check ---
    bb = shape.BoundingBox()
    min_dim = min(bb.xlen, bb.ylen, bb.zlen)
    thickness_threshold = 1.0
    if min_dim < thickness_threshold * 1.5:
        ratio = min_dim / thickness_threshold
        severity = _severity_from_ratio(ratio)
        add_issue({
            "type": "thin_wall",
            "severity": severity,
            "message": "Épaisseur minimale trop faible",
            "recommendation": "Augmenter l'épaisseur au-dessus de 1 mm",
            "locations": [{"xyz": [bb.center.x, bb.center.y, bb.center.z]}],
            "meta": {"threshold": thickness_threshold, "measured": min_dim},
        })

    # --- Draft angle check ---
    min_draft = 2.0  # degrés
    z_axis = cq.Vector(0, 0, 1)
    for idx, face in enumerate(faces):
        u_mid = (face.u1 + face.u2) / 2
        v_mid = (face.v1 + face.v2) / 2
        normal = face.normalAt(u_mid, v_mid)
        angle = math.degrees(math.acos(abs(normal.dot(z_axis))))
        draft = 90 - angle
        if draft < min_draft:
            ratio = draft / min_draft if min_draft else 0
            severity = _severity_from_ratio(ratio)
            c = face.center()
            add_issue({
                "type": "draft",
                "severity": severity,
                "message": "Angle de dépouille insuffisant",
                "recommendation": "Ajouter du dépouille",
                "locations": [{"xyz": [c.x, c.y, c.z], "faceIndex": idx}],
                "meta": {"threshold": min_draft, "measured": draft},
            })

    # --- Radius check ---
    min_radius = 0.5
    for edge in edges:
        if edge.geomType() == "CIRCLE":
            r = edge.radius()
            if r < min_radius:
                ratio = r / min_radius
                severity = _severity_from_ratio(ratio)
                c = edge.center()
                fi = next((i for i, f in enumerate(faces) if edge in f.Edges()), None)
                add_issue({
                    "type": "radius",
                    "severity": severity,
                    "message": "Rayon de congé trop faible",
                    "recommendation": "Utiliser un rayon plus grand",
                    "locations": [{"xyz": [c.x, c.y, c.z], "faceIndex": fi}],
                    "meta": {"threshold": min_radius, "measured": r},
                })

    # Résumé
    histogram: Dict[str, int] = {}
    for issue in issues:
        histogram[issue["severity"]] = histogram.get(issue["severity"], 0) + 1

    legend = [{"severity": k, "color": v} for k, v in SEVERITY_COLORS.items()]

    # Heatmap par face
    face_colors: Dict[str, List[float]] = {}
    for idx in range(len(faces)):
        ids = face_issue_map.get(str(idx))
        if ids:
            sev = next(iss["severity"] for iss in issues if iss["id"] == ids[0])
            face_colors[str(idx)] = SEVERITY_COLORS[sev]
        else:
            face_colors[str(idx)] = [0.8, 0.8, 0.8]

    result = {
        "summary": {"issues_count": len(issues), "severity_histogram": histogram},
        "issues": issues,
        "legend": legend,
        "heatmap": {"mode": "faceColors", "data": face_colors},
        "face_issue_map": face_issue_map,
    }

    json_str = json.dumps(result, separators=(",", ":"))
    if gzip_output:
        return gzip.compress(json_str.encode("utf-8"))
    return json_str.encode("utf-8")
