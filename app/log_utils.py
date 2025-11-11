"""Outils de logging partagés (masquage de secrets)."""
from __future__ import annotations

from urllib.parse import urlparse, urlunparse


def mask_db_uri(uri: str | None) -> str:
    """Masque le mot de passe d'une URI SQLAlchemy pour les logs."""

    if not uri:
        return ""

    try:
        parsed = urlparse(uri)
    except Exception:
        return uri

    netloc = parsed.netloc
    if "@" in netloc and ":" in netloc.split("@", 1)[0]:
        userinfo, hostpart = netloc.split("@", 1)
        username = userinfo.split(":", 1)[0]
        netloc = f"{username}:***@{hostpart}"
    return urlunparse(parsed._replace(netloc=netloc))
