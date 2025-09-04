from celery import shared_task
import time, logging

@shared_task(bind=True)
def dfm_run(self, file_id, material_profile, demould_axis):
    t0 = time.time()
    self.update_state(state="PROGRESS", meta={"step": "prepare", "progress": 5})
    # ... parsing STEP ...

    self.update_state(state="PROGRESS", meta={"step": "thickness", "progress": 35})
    # ... calcul épaisseurs ...

    self.update_state(state="PROGRESS", meta={"step": "undercuts", "progress": 70})
    # ... calcul contre-dépouilles ...

    self.update_state(state="PROGRESS", meta={"step": "summary", "progress": 90})
    # ... synthèse ...

    logging.info("DFM %s done in %.2fs", file_id, time.time() - t0)
    return {"ok": True, "file_id": file_id, "summary": {"score": 86}}
