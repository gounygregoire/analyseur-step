#!/usr/bin/env bash
# Smoke test du pipeline XKT : upload -> statut -> téléchargement du XKT.

set -euo pipefail

BASE_URL=${1:-"http://localhost:5000"}
STEP_FILE=${STEP_FILE:-"tests/sample.step"}
TIMEOUT=${TIMEOUT:-120}
MAX_DELAY=${MAX_DELAY:-5}
INITIAL_DELAY=${INITIAL_DELAY:-1}

if [[ ! -f "$STEP_FILE" ]]; then
  echo "[smoke] Fichier STEP introuvable: $STEP_FILE" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

UPLOAD_RESPONSE="$TMP_DIR/upload.json"
STATUS_RESPONSE="$TMP_DIR/status.json"
XKT_FILE="$TMP_DIR/model.xkt"

start_ts=$(date +%s)

echo "[smoke] Upload $STEP_FILE vers $BASE_URL/api/upload"

upload_code=$(curl -sS -o "$UPLOAD_RESPONSE" -w '%{http_code}' \
  -F "file=@${STEP_FILE}" \
  "$BASE_URL/api/upload")

if [[ "$upload_code" -ge 400 ]]; then
  echo "[smoke] Upload HTTP $upload_code" >&2
  cat "$UPLOAD_RESPONSE" >&2
  exit 1
fi

file_id=$(python - <<'PY'
import json,sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data=json.load(fh)
print(data.get('file_id',''))
PY
"$UPLOAD_RESPONSE")

if [[ -z "$file_id" ]]; then
  echo "[smoke] Impossible de récupérer file_id dans la réponse:" >&2
  cat "$UPLOAD_RESPONSE" >&2
  exit 1
fi

echo "[smoke] file_id=$file_id"

delay=$INITIAL_DELAY
elapsed=0

while (( elapsed < TIMEOUT )); do
  echo "[smoke] Poll statut (wait ${delay}s)"
  sleep "$delay"
  status_code=$(curl -sS -o "$STATUS_RESPONSE" -w '%{http_code}' \
    "$BASE_URL/api/files/${file_id}/status")
  if [[ "$status_code" -ge 400 ]]; then
    echo "[smoke] Statut HTTP $status_code" >&2
    cat "$STATUS_RESPONSE" >&2
    exit 1
  fi
  status=$(python - <<'PY'
import json,sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data=json.load(fh)
print(data.get('status',''))
print(data.get('xkt_url') or '')
print(data.get('message') or '')
PY
"$STATUS_RESPONSE")
  IFS=$'\n' read -r current_status xkt_url message <<<"$status"
  echo "[smoke] statut=$current_status"

  if [[ "$current_status" == "ready" ]]; then
    if [[ -z "$xkt_url" ]]; then
      echo "[smoke] URL XKT absente malgré status=ready" >&2
      exit 1
    fi
    if [[ "$xkt_url" == /* ]]; then
      xkt_url="${BASE_URL%/}$xkt_url"
    fi
    echo "[smoke] Téléchargement XKT $xkt_url"
    xkt_code=$(curl -sS -o "$XKT_FILE" -w '%{http_code}' "$xkt_url")
    if [[ "$xkt_code" -ge 400 ]]; then
      echo "[smoke] Téléchargement XKT HTTP $xkt_code" >&2
      exit 1
    fi
    if [[ ! -s "$XKT_FILE" ]]; then
      echo "[smoke] Fichier XKT vide ou absent" >&2
      exit 1
    fi
    total=$(( $(date +%s) - start_ts ))
    size=$(wc -c < "$XKT_FILE")
    echo "[smoke] Succès en ${total}s (size=${size}B)"
    exit 0
  fi

  if [[ "$current_status" == "failed" ]]; then
    echo "[smoke] Conversion échouée: $message" >&2
    exit 2
  fi

  elapsed=$(( $(date +%s) - start_ts ))
  delay=$(( delay * 2 ))
  if (( delay > MAX_DELAY )); then
    delay=$MAX_DELAY
  fi
done

echo "[smoke] Timeout ${TIMEOUT}s atteint sans statut ready" >&2
exit 3
