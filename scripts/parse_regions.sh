#!/usr/bin/env bash
# Parse DisconSchedule.fact from outputs/*.html into data/<region>.json using Node parser.
# Continues on per-region errors and prints a summary.
# Requires:
#   - node (>=16)
#   - scripts/parse_fact.js
#   - jq (to resolve upstream URL from REGION_SOURCES_JSON)
#   - .env with REGION_SOURCES_JSON for upstream mapping (optional but recommended)

set -euo pipefail

PROJECT_ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$PROJECT_ROOT_DIR" || exit 1

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required. Install jq and re-run." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node is required. Install Node.js and re-run." >&2
  exit 1
fi

# Load .env to get REGION_SOURCES_JSON (if available)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

REGION_SOURCES_JSON=${REGION_SOURCES_JSON:-}

mkdir -p data

success=0
failed=0
processed=0

shopt -s nullglob
for html in outputs/*.html; do
  base=$(basename "$html")
  region=${base%.html}
  processed=$((processed+1))

  upstream=""
  if [ -n "$REGION_SOURCES_JSON" ]; then
    upstream=$(echo "$REGION_SOURCES_JSON" | jq -r --arg r "$region" '.[$r] // empty')
  fi

  out="data/${region}.json"
  echo "[INFO] Parsing region='$region' from $html → $out"
  if node scripts/parse_fact.js --region "$region" --in "$html" --out "$out" --upstream "$upstream" --pretty; then
    echo "[OK] Wrote $out"
    success=$((success+1))
  else
    echo "[WARN] Parser returned non-zero for region '$region'"
    failed=$((failed+1))
  fi

done
shopt -u nullglob

echo "[INFO] Done. Processed: $processed, successful: $success, failed: $failed"
# Always exit 0 to not break pipelines due to partial failures
exit 0
