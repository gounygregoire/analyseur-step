"""
STEP/STP -> XKT conversion pipeline.

Pipeline:
  1) STEP/STP --(CadQuery/OpenCascade)--> STL
  2) STL --(@xeokit/xeokit-convert)--> XKT

Dépendances:
  - cadquery (et OCC via OCP) pour STEP->STL
  - Node + @xeokit/xeokit-convert pour STL->XKT
  - Variable d'env (optionnelle): XEOKIT_CONVERT
      * chemin absolu du binaire 'xeokit-convert'
      * ou 'npx' pour utiliser npx à l'exécution
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import logging
from pathlib import Path
from typing import Optional

import cadquery as cq  # STEP -> STL

logger = logging.getLogger(__name__)


# ---------- Utils ----------

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


# ---------- Public API ----------

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


# ---------- CLI ----------

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        print("Usage: python xkt_converter.py input.step output.xkt")
        sys.exit(1)
    convert_step_to_xkt(sys.argv[1], sys.argv[2])
