"""Smoke test pour la conversion XKT via l'API publique de CADlytics.

Ce script envoie un STEP factice, poll l'état jusqu'à obtention du fichier
XKT puis vérifie que le contenu est non vide. Usage:
    python scripts/smoke_xkt.py
"""

import os
import sys
import time
import requests

BASE = os.getenv("CADLYTICS_BASE", "https://cadlytics.app")


def main() -> None:
    files = {"file": ("cube.step", b"dummy", "application/octet-stream")}
    r = requests.post(f"{BASE}/api/upload", files=files, timeout=30)
    print("upload:", r.status_code, r.text)
    r.raise_for_status()
    file_id = r.json()["fileId"]

    t0 = time.time()
    while True:
        s = requests.get(f"{BASE}/api/files/{file_id}/status", timeout=10)
        print("status:", s.status_code, s.text)
        if s.status_code == 404:
            sys.exit("ERROR: fileId not found in DB")
        s.raise_for_status()
        data = s.json()
        if data["status"] == "ready" and data.get("xkt_url"):
            break
        if time.time() - t0 > 120:
            sys.exit("ERROR: timeout")
        time.sleep(2)

    x = requests.get(data["xkt_url"], timeout=30)
    print("xkt:", x.status_code, len(x.content))
    x.raise_for_status()
    if not x.content:
        sys.exit("ERROR: empty xkt")
    print("OK")


if __name__ == "__main__":
    main()
