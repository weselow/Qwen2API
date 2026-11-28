#!/bin/bash
# Repository copy (tools/prod-host/) of /root/v2-verify.sh on the prod host, taken
# from the host on 28.11.2026. sha256 of the host original:
#   9ab5fa5ca8cb181af3eb55a3b71b6bae541ace127dc4e50c666730af9a28702a
# Since 28.11.2026 this file is the source; docs/prod-hybrid-deploy.md,
# «Скрипты хоста в репозитории», says how a copy gets to the host. The copy
# differs from the host original by these comment lines only.
# Runbook step 2 after the deploy: what the prod stack is now. Read-only; nothing goes to qwen.ai.
#   bash /root/v2-verify.sh <expected image tag, e.g. the merge commit in production>
set -u
S=m04skwsg8kck8ckwkc04ssss
WANT=${1:?expected image tag}
date -u +%FT%TZ
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}' | grep "$S" | sed -E 's/m04skwsg8kck8ckwkc04ssss_?//' | cut -c1-130
Q=$(docker ps --format '{{.Names}}' | grep "$S" | grep -v -E 'signin-worker|dnsproxy')
W=$(docker ps --format '{{.Names}}' | grep "$S" | grep signin-worker)
APP_TAG=$(docker inspect --format '{{.Config.Image}}' "$Q" | sed 's/.*://')
WORKER_TAG=$(docker inspect --format '{{.Config.Image}}' "$W" | sed 's/.*://')
echo "image tags: app=$APP_TAG worker=$WORKER_TAG expected=$WANT"
[ "$APP_TAG" = "$WANT" ] && [ "$WORKER_TAG" = "$WANT" ] && echo "IMAGES MATCH" || echo "IMAGES DO NOT MATCH — stop and look"
docker exec "$Q" bun -e 'fetch("http://signin-worker:3100/health").then(async r=>console.log("worker health:",r.status,await r.text()))'
echo "transport flags the app started with: $(docker exec "$Q" bun -e 'console.log(process.env.CHAT_CREATION_TRANSPORT, process.env.COMPLETIONS_TRANSPORT)')"
echo "worker headless mode env: $(docker exec "$W" printenv SIGNIN_HEADLESS_MODE || echo '(unset: shell)')"
echo "--- worker: listening line"; docker logs "$W" 2>&1 | grep -a listening | tail -n 1
echo "--- app: start record, transport lines"; docker logs "$Q" 2>&1 | grep -a -A16 '服务器启动成功' | grep -a -E 'chatCreationTransport|completionsTransport|v2SessionMode' | cut -c1-90
echo "--- app: session restore and errors since the start"; docker logs "$Q" 2>&1 | grep -a -E 'V2SESSION|\[ERROR\]|启动成功' | cut -c1-160 | tail -n 8
echo "--- foreign traffic since the deploy: creation failures $(docker logs "$Q" 2>&1 | grep -c 'Qwen chat creation failed'), requests to /v1/ $(docker logs "$Q" 2>&1 | grep -c '/v1/chat')"
echo "chromium processes in the worker: $(docker exec "$W" sh -c 'ls -l /proc/*/exe 2>/dev/null | grep -i -c chrom')"
