"""STEP/STP vers STL via CadQuery dans un sous-processus isolé."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Final

__all__ = ["step_to_stl"]

_DEFAULT_TOLERANCE: Final[float] = 0.6
_DEFAULT_TIMEOUT: Final[int] = 180


class StepToSTLError(RuntimeError):
    """Erreur levée lorsque l'export STEP→STL échoue."""


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def step_to_stl(
    step_path: str | Path,
    stl_path: str | Path,
    *,
    tolerance: float = _DEFAULT_TOLERANCE,
    timeout: int = _DEFAULT_TIMEOUT,
) -> Path:
    """Exporte ``step_path`` (STEP/STP) vers ``stl_path`` en utilisant CadQuery.

    L'export est exécuté dans un sous-processus Python afin d'isoler les
    éventuels plantages de l'OCC.
    """

    step_path = Path(step_path)
    stl_path = Path(stl_path)
    if not step_path.exists():
        raise StepToSTLError(f"Fichier STEP introuvable: {step_path}")

    _ensure_parent(stl_path)

    script = textwrap.dedent(
        """
        import sys
        import cadquery as cq  # type: ignore
        from cadquery import importers, exporters  # type: ignore

        step, stl, tol = sys.argv[1], sys.argv[2], float(sys.argv[3])
        shape = importers.importStep(step)
        exporters.export(shape, stl, "STL", tolerance=tol)
        print("OK", file=sys.stderr)
        """
    )

    env = os.environ.copy()
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("OPENBLAS_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")

    proc = subprocess.run(
        [sys.executable, "-c", script, str(step_path), str(stl_path), str(tolerance)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        timeout=timeout,
        check=False,
    )

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "ignore")
        stdout = proc.stdout.decode("utf-8", "ignore")
        raise StepToSTLError(
            f"STEP→STL a échoué (rc={proc.returncode})\nSTDERR:{stderr}\nSTDOUT:{stdout}"
        )

    if not stl_path.exists() or stl_path.stat().st_size == 0:
        raise StepToSTLError("STEP→STL a produit un fichier vide")

    return stl_path
