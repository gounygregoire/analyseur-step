"""Material profile lookup table."""
from app.dfm.interfaces import MaterialProfile

_MATERIALS = {
    "ABS": 1.0,
    "GENERIC": 1.0,
}

def get_profile(material_id: str) -> MaterialProfile | None:
    deg = _MATERIALS.get((material_id or "").upper())
    if deg is None:
        return None
    return MaterialProfile(id=material_id, draft_min_deg=deg)
