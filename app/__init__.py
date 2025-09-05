try:
    from .app import app  # type: ignore
except Exception:  # pragma: no cover
    app = None

__all__ = ["app"]
