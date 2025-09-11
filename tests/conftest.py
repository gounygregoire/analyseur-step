# >>> CADLYTICS PATCH: TEST-PATH (BEGIN)
"""Pytest configuration ensuring project root is on sys.path."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# >>> CADLYTICS PATCH: TEST-PATH (END)
# >>> CADLYTICS PATCH: CADQUERY-PATCH (BEGIN)
try:
    import cadquery
    _orig_export = cadquery.exporters.export

    def _export(w, fname, *args, **kwargs):
        if not isinstance(fname, str):
            fname = str(fname)
        return _orig_export(w, fname, *args, **kwargs)

    cadquery.exporters.export = _export
except Exception:  # pragma: no cover - if cadquery missing
    pass
# >>> CADLYTICS PATCH: CADQUERY-PATCH (END)
