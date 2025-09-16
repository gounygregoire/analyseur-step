# tasks.py — exécuté côté worker
import time


def run_dfm(step_path: str, xkt_path: str):
    # Imports lourds internes (lazy)
    import numpy as np
    import trimesh as tm
    # import cadquery as cq
    # import casadi

    # TODO: télécharger/charger les fichiers si stockage distant
    time.sleep(2)  # simule un calcul

    return {
        "ok": True,
        "metrics": {"thin_walls": 3, "min_radius_mm": 0.82, "overhang_area_mm2": 124.5},
    }
