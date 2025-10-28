#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/render/project/src

VENV="/opt/render/project/src/.venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[FATAL] venv python not found at $VENV/bin/python" >&2
  ls -la /opt/render/project/src || true
  exit 127
fi

export PYTHONPATH=/opt/render/project/src
QUEUE_NAME="${RQ_QUEUE_NAME:-default}"
export RQ_QUEUE_NAME="$QUEUE_NAME"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"

echo "[info] Python: $("$VENV/bin/python" -V)"
echo "[info] RQ version: $("$VENV/bin/python" - <<'PY'
import sys, rq
print(rq.__version__, sys.executable)
PY
)"

echo "[info] Checking OCP import..."
"$VENV/bin/python" - <<'PY'
try:
    from OCP.STEPControl import STEPControl_Reader
    print("OCP OK")
except Exception as e:
    import traceback; print("OCP FAIL:", repr(e)); traceback.print_exc(); raise SystemExit(12)
PY

echo "[info] Starting RQ worker on queue: ${RQ_QUEUE_NAME}"
exec "$VENV/bin/rq" worker -u "$REDIS_URL" -P /opt/render/project/src "$QUEUE_NAME"
