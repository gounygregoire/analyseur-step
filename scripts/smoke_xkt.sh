#!/usr/bin/env bash
# CODENAME: SMOKE-XKT
# Petit smoke test pour vérifier la disponibilité d'un XKT côté frontend/backend.

set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:5000}
STEP_PATH=${STEP_PATH:-tests/sample.step}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-60}

if [[ ! -f "${STEP_PATH}" ]]; then
  echo "FAIL: STEP introuvable à ${STEP_PATH}" >&2
  exit 1
fi

upload_payload=$(mktemp)
trap 'rm -f "${upload_payload}"' EXIT

upload_code=$(curl -sS -w "%{http_code}" -o "${upload_payload}" \
  -F "file=@${STEP_PATH}" \
  "${BASE_URL}/upload")

if [[ "${upload_code}" != "200" && "${upload_code}" != "202" ]]; then
  echo "FAIL: upload HTTP ${upload_code}" >&2
  cat "${upload_payload}" >&2
  exit 1
fi

file_id=$(python - <<'PY'
import json, sys
from pathlib import Path
payload = Path(sys.argv[1]).read_text()
try:
    data = json.loads(payload)
except json.JSONDecodeError:
    print("")
    sys.exit(0)
print(data.get("file_id", ""))
PY
"${upload_payload}")

if [[ -z "${file_id}" ]]; then
  echo "FAIL: file_id manquant dans la réponse d'upload" >&2
  cat "${upload_payload}" >&2
  exit 1
fi

echo "[smoke][upload] file_id=${file_id} code=${upload_code}"

attempt=1
head_ok=0
head_size=0
while [[ ${attempt} -le ${MAX_ATTEMPTS} ]]; do
  now=$(date +%s%3N)
  headers=$(curl -sS -D - -o /dev/null -X HEAD \
    -H "Cache-Control: no-store" \
    "${BASE_URL}/xkt/${file_id}.xkt?nocache=${now}")

  status=$(printf '%s\n' "${headers}" | head -n 1 | awk '{print $2}')
  length=$(printf '%s\n' "${headers}" | awk 'tolower($1)=="content-length:" {print $2}' | tail -n 1 | tr -d '\r')
  length=${length:-0}

  if [[ "${status}" == "200" && "${length}" =~ ^[0-9]+$ && ${length} -gt 0 ]]; then
    head_ok=1
    head_size=${length}
    echo "[smoke][head] attempt=${attempt} status=${status} size=${length}"
    break
  fi

  delay=$(python - <<'PY'
import sys
attempt = int(sys.argv[1])
delay = 1.0 + attempt * 0.2
if delay > 3.0:
    delay = 3.0
print(f"{delay:.3f}")
PY
"${attempt}")
  echo "[smoke][head] attempt=${attempt} status=${status:-none} size=${length} retry_in=${delay}s"
  sleep "${delay}"
  attempt=$((attempt + 1))
done

if [[ ${head_ok} -ne 1 ]]; then
  echo "FAIL: HEAD /xkt/${file_id}.xkt non disponible après ${MAX_ATTEMPTS} tentatives" >&2
  exit 1
fi

exists_payload=$(mktemp)
trap 'rm -f "${upload_payload}" "${exists_payload}"' EXIT
curl -sS -H "Cache-Control: no-store" \
  "${BASE_URL}/exists/xkt/${file_id}" \
  -o "${exists_payload}"

exists_case=$(python - <<'PY'
import json, sys
from pathlib import Path
payload = Path(sys.argv[1]).read_text()
try:
    data = json.loads(payload)
except json.JSONDecodeError:
    print("invalid")
    sys.exit(0)
exists = bool(data.get("exists"))
status = str(data.get("status", "")).lower() or "pending"
if exists and status == "done":
    print("done")
elif (not exists) and status == "pending":
    print("pending")
else:
    print(f"other:{status}")
PY
"${exists_payload}")

echo "[smoke][exists] response=$(cat "${exists_payload}")"

if [[ "${exists_case}" != "done" && "${exists_case}" != "pending" ]]; then
  echo "FAIL: statut /exists inattendu (${exists_case})" >&2
  exit 1
fi

echo "PASS: file_id=${file_id} size=${head_size} status=${exists_case}"
exit 0
