# Boot-time checks for directories and converter availability.

import logging
import os
import shutil
import subprocess

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("boot")

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/uploads")
OUTPUT_FOLDER = os.environ.get("OUTPUT_FOLDER", "/tmp/converted")

for d in (UPLOAD_FOLDER, OUTPUT_FOLDER):
    os.makedirs(d, exist_ok=True)


def _xeokit_cmd() -> list[str]:
    exe = (os.environ.get("XEOKIT_CONVERT") or "").strip()
    if exe:
        if exe == "npx":
            return ["npx", "-y", "@xeokit/xeokit-convert", "--version"]
        if os.path.isfile(exe) and os.access(exe, os.X_OK):
            return [exe, "--version"]
    p = shutil.which("xeokit-convert")
    if p:
        return [p, "--version"]
    return ["npx", "-y", "@xeokit/xeokit-convert", "--version"]


def _check_xkt(timeout: int = 5) -> bool:
    cmd = _xeokit_cmd()
    try:
        subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=True,
            text=True,
        )
        logger.info("XKT converter OK")
        return True
    except Exception as exc:
        logger.warning("XKT converter unavailable: %s", exc)
        return False


XKT_AVAILABLE = _check_xkt()

parts = [
    f"UPLOAD_FOLDER={UPLOAD_FOLDER}",
    f"OUTPUT_FOLDER={OUTPUT_FOLDER}",
]
max_upload = os.environ.get("MAX_UPLOAD_MB")
if max_upload:
    parts.append(f"MAX_UPLOAD_MB={max_upload}")
path_env = os.environ.get("PATH", "")[:200]
parts.append(f"PATH={path_env}")
parts.append(f"XKT={int(XKT_AVAILABLE)}")

logger.info("BOOT_OK " + " ".join(parts))

