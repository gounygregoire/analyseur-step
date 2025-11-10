#!/usr/bin/env python3
"""Smoke test du pipeline XKT : upload STEP -> statut -> téléchargement XKT."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Tuple
from urllib.parse import urljoin

try:
    import requests
except ImportError as exc:  # pragma: no cover - dépendance manquante
    raise SystemExit(
        "Le module 'requests' est requis pour scripts/smoke_xkt.py (pip install requests)."
    ) from exc

DEFAULT_BASE_URL = "http://localhost:5000/"
DEFAULT_STEP_PATH = "tests/sample.step"
DEFAULT_TIMEOUT = 120
DEFAULT_INITIAL_DELAY = 1.0
DEFAULT_MAX_DELAY = 5.0


class SmokeError(RuntimeError):
    """Exception fonctionnelle pour signaler un échec du smoke test."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vérifie la publication XKT complète.")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"URL de base de l'API (défaut: {DEFAULT_BASE_URL}).",
    )
    parser.add_argument(
        "--step-file",
        default=DEFAULT_STEP_PATH,
        help=f"Chemin du fichier STEP à téléverser (défaut: {DEFAULT_STEP_PATH}).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"Timeout global en secondes (défaut: {DEFAULT_TIMEOUT}).",
    )
    parser.add_argument(
        "--initial-delay",
        type=float,
        default=DEFAULT_INITIAL_DELAY,
        help=f"Délai initial entre deux polls (défaut: {DEFAULT_INITIAL_DELAY}).",
    )
    parser.add_argument(
        "--max-delay",
        type=float,
        default=DEFAULT_MAX_DELAY,
        help=f"Délai maximum entre deux polls (défaut: {DEFAULT_MAX_DELAY}).",
    )
    return parser.parse_args()


def upload_step(base_url: str, step_path: str) -> str:
    if not os.path.isfile(step_path):
        raise SmokeError(f"Fichier STEP introuvable: {step_path}")

    endpoint = urljoin(base_url, "api/upload")
    with open(step_path, "rb") as handle:
        files = {"file": (os.path.basename(step_path), handle, "application/step")}
        response = requests.post(endpoint, files=files, timeout=60)

    if response.status_code >= 400:
        raise SmokeError(f"Upload HTTP {response.status_code}: {response.text}")

    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise SmokeError(f"Réponse upload invalide: {response.text}") from exc

    file_id = payload.get("file_id") or payload.get("fileId")
    if not file_id:
        raise SmokeError(f"file_id absent dans la réponse upload: {payload}")

    return str(file_id)


def poll_status(
    base_url: str,
    file_id: str,
    timeout_s: float,
    initial_delay: float,
    max_delay: float,
) -> Tuple[str, str]:
    status_endpoint = urljoin(base_url, f"api/files/{file_id}/status")
    deadline = time.monotonic() + timeout_s
    delay = max(initial_delay, 0.5)

    while True:
        if time.monotonic() > deadline:
            raise SmokeError(f"Timeout {timeout_s}s atteint sans statut ready.")

        response = requests.get(status_endpoint, timeout=30)
        if response.status_code >= 400:
            raise SmokeError(
                f"Statut HTTP {response.status_code}: {response.text}"
            )

        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise SmokeError(f"Réponse statut invalide: {response.text}") from exc

        status = (payload.get("status") or "").lower()
        xkt_url = payload.get("xkt_url")
        message = payload.get("message") or payload.get("error") or ""

        print(f"[status] {status} {xkt_url or ''}")

        if status == "ready":
            if not xkt_url:
                raise SmokeError("Status ready mais xkt_url manquant.")
            return status, str(xkt_url)
        if status == "failed":
            raise SmokeError(f"Conversion échouée: {message}")

        time.sleep(delay)
        delay = min(delay * 2, max_delay)


def fetch_xkt(xkt_url: str, base_url: str) -> int:
    if xkt_url.startswith("/"):
        xkt_url = urljoin(base_url, xkt_url.lstrip("/"))
    response = requests.get(xkt_url, stream=True, timeout=60)
    if response.status_code >= 400:
        raise SmokeError(
            f"Téléchargement XKT HTTP {response.status_code}: {response.text}"
        )

    total = 0
    for chunk in response.iter_content(chunk_size=65536):
        if chunk:
            total += len(chunk)
    if total <= 0:
        raise SmokeError("Fichier XKT vide ou non téléchargé.")
    return total


def main() -> int:
    args = parse_args()
    base_url = args.base_url if args.base_url.endswith("/") else f"{args.base_url}/"

    start = time.monotonic()
    print(f"[smoke] Upload depuis {args.step_file} vers {base_url}api/upload")

    try:
        file_id = upload_step(base_url, args.step_file)
        print(f"[smoke] file_id={file_id}")
        status, xkt_url = poll_status(
            base_url, file_id, args.timeout, args.initial_delay, args.max_delay
        )
        size = fetch_xkt(xkt_url, base_url)
    except SmokeError as err:
        print(f"[smoke] Échec: {err}", file=sys.stderr)
        return 1
    except requests.RequestException as err:
        print(f"[smoke] Erreur réseau: {err}", file=sys.stderr)
        return 1

    duration = time.monotonic() - start
    print(
        f"[smoke] Succès statut={status} en {duration:.1f}s (taille XKT={size} octets)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
