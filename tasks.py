# tasks.py — exécuté côté worker (DFM)
import time


def run_dfm(step_path: str, xkt_path: str):
    """
    Exemple de tâche DFM. Ici on simule du calcul.
    Les imports lourds sont réalisés à l'intérieur (lazy) pour ne pas charger le web.
    """
    # Imports lourds ici
    import numpy as np
    import trimesh as tm
    # import cadquery as cq
    # import casadi

    # TODO: si nécessaire, télécharger step/xkt depuis un stockage partagé (S3) et travailler en local.
    time.sleep(2)

    # Exemple de résultat
    return {
        "ok": True,
        "metrics": {"thin_walls": 3, "min_radius_mm": 0.82, "overhang_area_mm2": 124.5},
    }
