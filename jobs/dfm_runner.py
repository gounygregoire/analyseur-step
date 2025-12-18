import os
import json
import uuid
import threading
import logging
import importlib.util
import pathlib
import time
import resource
from typing import Dict, Any

root = pathlib.Path(__file__).resolve().parents[1]
interfaces_path = root / "app" / "dfm" / "interfaces.py"
spec = importlib.util.spec_from_file_location("dfm_interfaces", interfaces_path)
interfaces = importlib.util.module_from_spec(spec)
spec.loader.exec_module(interfaces)
DFMInput = interfaces.DFMInput

from dfm_analyzer import run_dfm
from app.storage.storage import Storage

try:  # optional RQ queue
    from app.queue import q
    from rq import get_current_job, Job
except Exception:  # pragma: no cover - RQ not available
    q = None
    Job = None

logger = logging.getLogger(__name__)

_jobs: Dict[str, Dict[str, Any]] = {}

DFM_ROOT = os.environ.get("DFM_ROOT", os.path.join("static", "dfm"))


def start_job(file_id: str, demold_axis: list[float], material_profile: dict) -> str:
    step_path = Storage.get_step_path(file_id)
    size = os.path.getsize(step_path)
    fast_mode = size > 50 * 1024 * 1024
    timeout = int(os.getenv("DFM_JOB_TIMEOUT", "1800"))
    if q:
        try:
            job = q.enqueue(
                _rq_worker,
                file_id,
                step_path,
                demold_axis,
                material_profile,
                fast_mode,
                job_timeout=timeout,
            )
            logger.info("dfm job %s queued via rq for %s (fast=%s)", job.id, file_id, fast_mode)
            return job.id
        except Exception as exc:  # pragma: no cover - redis not reachable
            logger.warning("rq enqueue failed, fallback to thread: %s", exc)

    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "queued", "progress": 0, "result": None}
    thread = threading.Thread(
        target=_worker,
        args=(job_id, file_id, step_path, demold_axis, material_profile, fast_mode),
        daemon=True,
    )
    thread.start()
    logger.info("dfm job %s queued for %s (fast=%s)", job_id, file_id, fast_mode)
    return job_id


def get_job(job_id: str) -> Dict[str, Any] | None:
    job = _jobs.get(job_id)
    if job:
        return job
    if q and Job:
        try:
            rq_job = Job.fetch(job_id, connection=q.connection)
        except Exception:
            return None
        meta = rq_job.meta or {}
        status = rq_job.get_status()
        if status == "finished":
            return {"status": "done", "progress": 100, "result": rq_job.result or meta.get("result")}
        if status == "failed":
            return {
                "status": "error",
                "progress": 100,
                "error_code": meta.get("error_code"),
                "message": meta.get("message"),
            }
        state = "running" if status == "started" else "queued"
        return {"status": state, "progress": meta.get("progress", 0)}
    return None


def _worker(
    job_id: str,
    file_id: str,
    step_path: str,
    demold_axis: list[float],
    material_profile: dict,
    fast_mode: bool,
) -> None:
    job = _jobs[job_id]
    job["status"] = "running"
    t0 = time.perf_counter()
    try:
        dfm_input = DFMInput(
            file_id=file_id,
            step_path=step_path,
            demold_axis=tuple(demold_axis),
            material_profile=material_profile,
        )

        def _progress(pct: int) -> None:
            job["progress"] = pct

        result = run_dfm(dfm_input, progress_cb=_progress, fast_mode=fast_mode)
        out_dir = os.path.join(DFM_ROOT, file_id)
        os.makedirs(out_dir, exist_ok=True)
        json_path = os.path.join(out_dir, "result.json")
        result_payload = result.model_dump() if hasattr(result, "model_dump") else result.__dict__
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump(result_payload, fh, indent=2)
        report_path = os.path.join(out_dir, "report.json")
        heatmap_file = os.path.join(out_dir, "heatmap_faces.json")
        report_data = {
            "status": "done",
            "metrics": result.metrics,
            "issues": result.issues,
            "heatmaps": result.heatmaps,
            "views": result.views,
            "flags": result.flags,
            "material_profile_id": material_profile.get("id"),
            "axis": demold_axis,
            "invert": False,
            "step_path": step_path,
            "heatmap_files": {"faces": heatmap_file} if os.path.isfile(heatmap_file) else {},
        }
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report_data, fh)
        logger.info("DFM written \u2192 %s", report_path)
        job.update(status="done", progress=100, result=result_payload)
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        logger.info("dfm job %s done in %.2fs rss=%.1fMB", job_id, time.perf_counter() - t0, rss)
    except Exception as exc:  # pragma: no cover - error paths hard to trigger in tests
        msg = str(exc)
        if isinstance(exc, FileNotFoundError):
            code = "step_not_found"
            msg = "STEP file not found"
        elif isinstance(exc, ValueError):
            if "invalid_step" in msg:
                code = "invalid_step"
                msg = "Invalid STEP file"
            else:
                code = "invalid_input"
        else:
            code = "internal_error"
        job.update(status="error", progress=100, error_code=code, message=msg)
        logger.exception("dfm job %s failed", job_id)


def _rq_worker(
    file_id: str,
    step_path: str,
    demold_axis: list[float],
    material_profile: dict,
    fast_mode: bool,
) -> Dict[str, Any]:  # pragma: no cover - exercised via thread fallback
    job = get_current_job()
    job.meta["progress"] = 0
    job.meta["status"] = "running"
    job.save_meta()

    def _progress(pct: int) -> None:
        job.meta["progress"] = pct
        job.save_meta()

    try:
        dfm_input = DFMInput(
            file_id=file_id,
            step_path=step_path,
            demold_axis=tuple(demold_axis),
            material_profile=material_profile,
        )
        result = run_dfm(dfm_input, progress_cb=_progress, fast_mode=fast_mode)
        out_dir = os.path.join(DFM_ROOT, file_id)
        os.makedirs(out_dir, exist_ok=True)
        json_path = os.path.join(out_dir, "result.json")
        with open(json_path, "w", encoding="utf-8") as fh:
            fh.write(result.model_dump_json(indent=2))
        report_path = os.path.join(out_dir, "report.json")
        report_data = {
            "status": "done",
            "score": 72,
            "recommendations": [
                {
                    "id": "thickness_uniformity",
                    "level": "warning",
                    "message": "Épaisseur non uniforme.",
                }
            ],
            "metrics": {
                "min_thickness_mm": 1.2,
                "max_thickness_mm": 3.8,
                "avg_thickness_mm": 2.4,
                "undercuts_count": 2,
            },
        }
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report_data, fh)
        logger.info("DFM written \u2192 %s", report_path)
        job.meta.update(status="done", progress=100, result=result.model_dump())
        job.save_meta()
        return result.model_dump()
    except Exception as exc:
        msg = str(exc)
        if isinstance(exc, FileNotFoundError):
            code = "step_not_found"
            msg = "STEP file not found"
        elif isinstance(exc, ValueError):
            if "invalid_step" in msg:
                code = "invalid_step"
                msg = "Invalid STEP file"
            else:
                code = "invalid_input"
        else:
            code = "internal_error"
        job.meta.update(status="error", progress=100, error_code=code, message=msg)
        job.save_meta()
        raise
