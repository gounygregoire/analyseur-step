#!/bin/bash
# Simple curl tests for the upload API
HOST=${HOST:-http://localhost:5000}
FILE=${1:-$(dirname "$0")/sample.step}

resp=$(curl -s -F "file=@${FILE}" "$HOST/api/upload")
echo "Upload response: $resp"
id=$(echo "$resp" | python -c 'import sys,json;print(json.load(sys.stdin)["modelId"])')

echo "Status:" 
curl -s "$HOST/api/models/$id"

echo "Assets:" 
curl -s "$HOST/api/models/$id/assets"
