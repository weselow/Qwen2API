# The gate image: the runtime CI's regression job matches (Linux, Node 24).
# How it is built and run: AGENTS.md, "The test gate".
#
#   MSYS_NO_PATHCONV=1 docker build -t qwen2api-gate-node24 tools/gate-image
#
# openssl: tests/v2-lab-sessions.test.js issues a self-signed certificate.
# git: tests/release-workflow.test.js makes a scratch repository (PR #42).
# Neither is in node:24-slim, and the gate fails on a clean main without them
# (Qwen2API-288).
FROM node:24-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl git \
    && rm -rf /var/lib/apt/lists/*
