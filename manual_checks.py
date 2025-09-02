#!/usr/bin/env python3
"""Manual API checks for local development."""

import json
import requests

BASE_URL = "http://localhost:5000"


def check_health():
    resp = requests.get(f"{BASE_URL}/health", timeout=5)
    status_ok = resp.status_code == 200
    print("GET /health ->", resp.status_code, resp.text)
    print("health OK" if status_ok else "health FAIL")


def check_dfm_start():
    session = requests.Session()
    resp = session.post(f"{BASE_URL}/api/dfm/start", json={}, timeout=5)
    print("POST /api/dfm/start (no file_id) ->", resp.status_code, resp.text)
    print("expected 400" if resp.status_code == 400 else "unexpected status")

    resp2 = session.post(
        f"{BASE_URL}/api/dfm/start", json={"file_id": "demo"}, timeout=5
    )
    print("POST /api/dfm/start (with file_id) ->", resp2.status_code, resp2.text)
    try:
        job_id = resp2.json().get("job_id")
    except Exception:
        job_id = None
    if resp2.status_code == 200 and job_id:
        print("job queued:", job_id)
    else:
        print("unexpected response")


if __name__ == "__main__":
    check_health()
    check_dfm_start()
