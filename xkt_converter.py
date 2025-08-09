"""STEP -> XKT via pipeline:
   STEP/STP --(OCP/OpenCascade)--> STL --(xeokit-convert)--> XKT
"""

import os
import shutil
import subprocess
import tempfile
import logging
from pathlib import Path

from OCP.STEPControl import STEPControl_Reader
from OCP.StlAPI import StlAPI_Writer
from OCP.Interface import Interface_Static

logger = logging.getLogger(__name__)

def _resolve_xeokit():
    """Chemin du binaire xeokit-convert ou fallback 'npx'."""
    p = os.environ.get("XEOKIT_CONVERT", "").strip()
    if p:
        if p == "npx":
            return "npx"
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    p2 = shutil.which("xeokit-convert")
    return p2 if p2 else "npx"

def _step_to_stl(step_path: str, stl_path: str) -> None:
    """Convertit STEP -> STL via OpenCascade (OCP)."""
    step = Path(step_path)
    if not step.exists():
        raise FileNotFoundError(step)

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step))
    if status != 1:
        raise RuntimeError("Lecture STEP échouée")
    reader.TransferRoots()
    shape = reader.OneShape()

    # Binaire/STL binaire (plus compact)
    Interface_Static.SetIVal_s("write.stl.mode", 0)
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    writer.Write(shape, str(stl_path))

def convert_step_to_xkt(step_path: str, xkt_path: str) -> None:
    """Pipeline STEP/STP -> STL -> XKT."""
    step = Path(step_path)
    out = Path(xkt_path)
    if not step.exists():
        raise FileNotFoundError(step)
    out.parent.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path(tempfile.mkdtemp())
    stl_path = tmp_dir / (step.stem + ".stl")

    try:
        # 1) STEP -> STL (Python, OCP)
        logger.info("Converting STEP->STL with OCP: %s -> %s", step, stl_path)
        _step_to_stl(str(step), str(stl_path))

        # 2) STL -> XKT (xeokit-convert)
        xeokit = _resolve_xeokit()
        base = [xeokit, "-y", "@xeokit/xeokit-convert"] if xeokit == "npx" else [xeokit]

        cmd = base + ["-s", str(stl_path), "-o", str(out)]
        logger.info("Executing: %s", " ".join(cmd))
        res = subprocess.run(cmd, capture_output=True, text=True)

        if res.returncode != 0 or not out.exists():
            log_out = ((res.stdout or "") + "\n" + (res.stderr or "")).strip()
            logger.error("xeokit-convert failed (rc=%s)\n%s", res.returncode, log_out)
            # Retry syntax longue si binaire ancien
            if "unknown option" in log_out.lower():
                cmd = base + ["--source", str(stl_path), "--output", str(out)]
                logger.info("Retry with --source/--output: %s", " ".join(cmd))
                res = subprocess.run(cmd, capture_output=True, text=True)
                if res.returncode == 0 and out.exists():
                    return
            raise subprocess.CalledProcessError(res.returncode, cmd, output=res.stdout, stderr=res.stderr)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        print("Usage: python xkt_converter.py input.step output.xkt")
        sys.exit(1)
    convert_step_to_xkt(sys.argv[1], sys.argv[2])
