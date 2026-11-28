#!/bin/bash
# Repository copy (tools/prod-host/) of deploy-watch.sh of the development machine,
# taken on 28.11.2026. sha256 of the original:
#   7637a2faf59c34fbb96859434125ee2e60946428e3d414b2d217edebb0f2dacf
# It runs on the development machine, not on the prod host. Since 28.11.2026 this
# file is the source; docs/prod-hybrid-deploy.md, «Скрипты хоста в репозитории»,
# tells of it. The copy differs from the original by these comment lines and by
# the helper's path, which the original had as a literal (COOLIFY_HELPER below).
# After the merge into production: wait for the deployment the webhook should create; if there is
# none within WAIT seconds, say so and stop — the caller then starts one through the API
# (POST /deploy, force false, no Stop; Qwen2API-8kk). Then follow the deployment to its end and
# print the lines of its log that tell the phases. Read-only. The token is never printed.
#   bash deploy-watch.sh <AFTER, ISO time of the merge> [wait seconds for the webhook, 180] [deployment uuid]
set -u
# The helper sets CT (the Coolify API token), CB (the API's address, …/api/v1) and
# APP (the application's uuid). It is a file of the development machine and is not
# in the repository; COOLIFY_HELPER names it. Where the token lives —
# «Переменные» in docs/prod-hybrid-deploy.md.
HELPER=${COOLIFY_HELPER:-/c/temp/qwen-e4-live/coolify.sh}
. "$HELPER"
[ -n "$CT" ] || { echo "no Coolify token"; exit 2; }
AFTER=${1:?after}
WAIT=${2:-180}
UUID=${3:-}
OUT=/tmp/v2run/deploy-watch
mkdir -p "$OUT"
api() { curl -s -m 60 -H "Authorization: Bearer $CT" -H "Accept: application/json" "$CB$1"; }

if [ -z "$UUID" ]; then
  deadline=$(( $(date +%s) + WAIT ))
  while :; do
    line=$(api "/deployments/applications/$APP" | jq -r '(.deployments // []) | map(select(.created_at > "'"$AFTER"'")) | sort_by(.created_at) | reverse | (.[0] // {}) | "\(.deployment_uuid // "-") \(.created_at // "-") webhook=\(.is_webhook // "-") api=\(.is_api // "-") \(.status // "-")"' 2>/dev/null)
    case "$line" in
      ''|-*) ;;
      *) echo "NEW DEPLOYMENT: $line"; UUID=${line%% *}; break ;;
    esac
    if [ "$(date +%s)" -gt "$deadline" ]; then echo "NO NEW DEPLOYMENT within ${WAIT} s (now $(date -u +%FT%TZ))"; exit 1; fi
    sleep 8
  done
fi

PICK='(.logs | if type == "string" then fromjson else . end)[]? | select((.output // .command // "") | test("ARG declarations|Build step skipped|No build-time variables|Pulling & building|Creating .env|Pulling image-based|Removing old containers|Starting new application|New container started|Gracefully shutting|Building image|rolling back|Rollback|ERROR|rror:|failed|FAILED| CACHED| DONE")) | ((.timestamp // "") | tostring) + " " + ((.output // .command // "") | gsub("\\u001b\\[[0-9;]*m"; "") | .[0:120])'
shown=0
start=$(date +%s)
echo "following $UUID from $(date -u +%FT%TZ)"
while :; do
  api "/deployments/$UUID" > "$OUT/deploy.json"
  status=$(jq -r '.status // "-"' "$OUT/deploy.json" 2>/dev/null)
  jq -r "$PICK" "$OUT/deploy.json" 2>/dev/null | tr -d '\r' > "$OUT/phases.txt"
  total=$(wc -l < "$OUT/phases.txt")
  if [ "$total" -gt "$shown" ]; then tail -n +$((shown + 1)) "$OUT/phases.txt" | head -n 400 | cut -c1-170; shown=$total; fi
  case "$status" in
    finished|failed|cancelled-by-user)
      echo "DEPLOYMENT $status | $(date -u +%FT%TZ) | watched $(( $(date +%s) - start )) s | phase lines $total"
      [ "$status" = finished ] && exit 0 || exit 1 ;;
  esac
  if [ $(( $(date +%s) - start )) -gt 3500 ]; then echo "gave up waiting after 58 min (status $status)"; exit 2; fi
  sleep 15
done
