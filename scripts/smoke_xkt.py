#!/usr/bin/env python3
"""Smoke test pour la conversion XKT sur cadlytics.app.

Exemple d'usage :
    python scripts/smoke_xkt.py --file /chemin/vers/piece.step \
        --base-url https://cadlytics.app

Le script :
1. Envoie un fichier STEP via POST /api/upload.
2. Suit le statut /api/files/<file_id>/status (si disponible).
3. Fait un polling HEAD sur l'URL XKT publique jusqu'à obtenir un HTTP 200.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Optional

import requests


DEFAULT_BASE_URL = "https://cadlytics.app"
STATUS_POLL_INTERVAL = 2.0
STATUS_POLL_MAX = 180.0
FALLBACK_HEAD_INTERVAL = 1.0
FALLBACK_HEAD_MAX = 180.0


class SmokeError(RuntimeError):
    """Erreur enveloppe pour signaler un échec du smoke test."""


def _join_url(base: str, path: str) -> str:
    base = base.rstrip("/")
    path = path.lstrip("/")
    return f"{base}/{path}"


def upload_step(base_url: str, file_path: str) -> dict:
    url = _join_url(base_url, "api/upload")
    with open(file_path, "rb") as fh:
        files = {"file": (os.path.basename(file_path), fh, "application/step")}
        response = requests.post(url, files=files, timeout=60)
    try:
        response.raise_for_status()
    except Exception as exc:  # pragma: no cover - simple CLI
        raise SmokeError(f"Upload échoué ({response.status_code}): {response.text}") from exc

    payload = response.json()
    required = {"file_id", "job_id", "xkt_url"}
    if not required.issubset(payload):
        raise SmokeError(f"Réponse upload incomplète: {payload}")
    return payload


def poll_status(base_url: str, file_id: str) -> Optional[str]:
    """Retourne l'URL XKT prête si la route de statut existe et répond ready.

    Retourne ``None`` si la route n'est pas disponible (404 répétés).
    """
    url = _join_url(base_url, f"api/files/{file_id}/status")
    deadline = time.time() + STATUS_POLL_MAX
    backoff = STATUS_POLL_INTERVAL
    consecutive_404 = 0

    while time.time() < deadline:
        response = requests.get(url, timeout=15)
        if response.status_code == 404:
            consecutive_404 += 1
            if consecutive_404 >= 2:
                return None
        elif response.ok:
            consecutive_404 = 0
            data = response.json()
            status = data.get("status")
            if status == "ready" and data.get("xkt_url"):
                return data["xkt_url"]
            if status == "failed":
                raise SmokeError(f"Conversion en échec: {data}")
        else:
            response.raise_for_status()

        time.sleep(backoff)
        backoff = min(backoff * 1.5, 10.0)

    return None


def poll_head(url: str) -> str:
    deadline = time.time() + FALLBACK_HEAD_MAX
    delay = FALLBACK_HEAD_INTERVAL
    while time.time() < deadline:
        response = requests.head(url, allow_redirects=True, timeout=10)
        if response.ok:
            return url
        time.sleep(delay)
        delay = min(delay * 1.5, 5.0)

    raise SmokeError(f"Timeout en attendant HTTP 200 sur {url}")


def run_smoke(file_path: str, base_url: str) -> str:
    print(f"[upload] POST /api/upload -> {base_url}")
    payload = upload_step(base_url, file_path)
    file_id = payload["file_id"]
    job_id = payload.get("job_id")
    initial_url = payload.get("xkt_url") or payload.get("xktUrl")
    if not initial_url:
        raise SmokeError("Réponse upload sans xkt_url/xktUrl")

    print(f"[upload] file_id={file_id} job_id={job_id} xkt_url={initial_url}")

    print("[status] GET /api/files/<id>/status")
    ready_url = poll_status(base_url, file_id)
    if ready_url:
        print(f"[status] ready -> {ready_url}")
        target_url = ready_url
    else:
        print("[fallback] statut indisponible ou pas ready, tentative HEAD directe")
        target_url = initial_url

    print(f"[fallback-xkt] HEAD {target_url}")
    return poll_head(target_url)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test du pipeline XKT public")
    parser.add_argument("--file", required=True, help="Chemin vers le fichier STEP à téléverser")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"URL de base de l'API (défaut: {DEFAULT_BASE_URL})",
    )
    args = parser.parse_args()

    try:
        final_url = run_smoke(args.file, args.base_url)
    except SmokeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print(f"[ok] XKT disponible: {final_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
