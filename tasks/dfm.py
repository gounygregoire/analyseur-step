"""Celery task for running DFM analysis."""

from celery import shared_task

from app.dfm.dfm_analyzer import run_dfm
from app.material_profiles import get_profile


@shared_task(bind=True, name="tasks.dfm.dfm_run")
def dfm_run(self, file_id, material_profile_id, axis, invert=False):
    """Run the DFM analysis for a given STEP file."""
    # >>> CADLYTICS PATCH: RESOLVE STEP (BEGIN)
    from app.storage.storage import Storage, os

    step_path = Storage.get_step_path(file_id)
    if not (step_path and os.path.isfile(step_path)):
        raise FileNotFoundError(f"step_not_found_for_file_id {file_id}")
    # >>> CADLYTICS PATCH: RESOLVE STEP (END)
    profile = get_profile(material_profile_id)
    if profile is None:
        raise ValueError("unknown_material_profile")
    dfm_input = {
        "file_id": file_id,
        "step_path": step_path,
        "axis": axis,
        "invert": invert,
        "material_profile": profile.model_dump(),
    }
    return run_dfm(dfm_input, progress_cb=None, fast_mode=False)
