# Design: hybrid v2 session pipeline (Qwen2API-jik)

Proven live 2026-11-21 (docs/et0-live-integration-2026-11-21.md, branch codex/et0-live-integration-20261121).
Success criterion: from the deployed container, full cycle signin -> chats/new -> completions -> model
answer against real qwen.ai; instant rollback to the current v1 path via config.

## Target architecture

    [client] -> Qwen2API app (Bun, DEBIAN-based image)
        |- GET /  and  POST /api/v2/chats/new ....... plain axios (proven passing, http1.1 ok)
        |- POST /api/v2/chat/completions ............ ImpersonateTransport:
        |        spawn curl-impersonate-chrome (pinned v0.6.1, glibc build),
        |        Chrome ClientHello + HTTP/2, SSE from stdout piped to a Readable;
        |        one spawn per request (overhead ~tens of ms, SSE requests are long-lived)
        |- SigninWorker SIDECAR (node:slim + playwright + chromium, compose pattern
             like the existing dns-sidecar):
             POST /session  {email, password, proxy?} -> {token, cookies[], expiresAt}
             POST /renew    {email}                    -> {token, cookies[], expiresAt}
             per-account persistent browser contexts (userDataDir on a volume) so
             auth.qwen.ai cookies survive restarts and renewal is a silent reload.

## Config flags (all default to today's behavior)

- V2_SESSION_MODE=off|lab|browser   (off = current v1 path; lab = existing .test behavior;
  browser = hybrid described here). One flag switches TokenManager.login/refresh and
  the session source; COMPLETIONS_TRANSPORT=auto|impersonate|axios (auto = use
  impersonate when the binary is present, else axios + warn once).
- SIGNIN_WORKER_URL (default http://signin-worker:3100).

## Code touchpoints (verified in repo)

- src/utils/request.js:805 — the single completions send site; route through the
  transport abstraction (axios stays the fallback).
- src/utils/header-profile.js — QWEN_WEB_VERSION 0.3.19 -> 0.3.49; timezone header
  to Date().toString() format; completions accept 'application/json'.
- src/utils/request.js rawPayload — body v2.1: version:'2.1', incremental_output,
  timestamp, message metadata (fid uuid, user_action:'chat', files:[], models[],
  chat_type, feature_config{...FE capture...}, extra.meta.subChatType, sub_chat_type).
- src/utils/v2-lab-sessions.js — generalize into the real per-account session store
  behind V2_SESSION_MODE (same jar semantics, domain/path scoping already proven).
- src/utils/token-manager.js — login() delegates to the worker in browser mode;
  refresh becomes "ask worker to renew" (v2 refresh endpoint is not web-FE usable).
- src/utils/data-persistence.js — persist session {token, expiresAt, jar} per account
  (file + redis backends, 0600 perms; token is a bearer credential).
- docker/Dockerfile — base alpine -> debian (oven/bun:<ver> debian variant): official
  curl-impersonate is glibc-only. COPY pinned tarballs for TARGETARCH (amd64/arm64),
  verify sha256. Image grows ~30 MB for curl-impersonate (browser lives in the sidecar).
- docker-compose — add signin-worker service (+ volume for userDataDir), mirroring
  docker-compose.dns.yml conventions.

## Phases / order (subtasks)

1. jik.1 protocol sync — no new deps, verifiable on the .test lab stand; update
   fixtures/tests to the captured FE body (tests/fixtures + chat-creation-errors).
2. jik.2 impersonating transport — src/utils/impersonate-transport.js + integration
   at request.js:805 + docker changes; unit tests mock child_process.spawn and assert
   argv/header injection and secret redaction; punish/WAF classification reused from
   upstream-error.js.
3. jik.3 signin worker sidecar + TokenManager delegation + V2_SESSION_MODE=browser.
   Dev order inside: minimal harvest script first (it also unlocks manual testing of
   jik.2 with a real session), then the service, then renewal loop.
4. jik.4 session persistence (blocked by jik.3).
5. jik.5 prod deploy + live smoke (blocked by jik.1-jik.3): Coolify compose update,
   verify from the datacenter egress IP, then close Qwen2API-et0.

## Open decisions (decide at implementation start)

1. Sidecar worker (recommended — isolation, node playwright, existing compose pattern)
   vs in-process playwright under Bun.
2. Debian base for the main image (required for glibc curl-impersonate) vs a musl
   community build (not recommended).
3. Spawn-per-request curl (recommended) vs a resident proxy process.

## Risks / mitigations

- Baxia risk score on the datacenter egress IP may differ from the proven home IP ->
  test early from a prod-like VPS (part of jik.5); per-account proxies are the lever
  (curl --proxy and playwright context proxy both honor account.proxy).
- FE version rot (0.3.49 will age) -> tools/et0-live-probe.js stays as the drift
  detector; header/body constants isolated in header-profile.js.
- curl-impersonate chrome116 profile vs future WAF tightening -> pin v0.6.1, keep the
  axios fallback path alive, revisit newer impersonation forks if punished again.
- Playwright/chromium memory in the sidecar -> one shared browser, contexts per
  account, headless, restart policy in compose.

## Rollback

V2_SESSION_MODE=off + COMPLETIONS_TRANSPORT=axios restores today's v1 behavior with a
config change only; the sidecar can be stopped independently.

## Branch strategy

Integration trunk for the epic: codex/et0-live-integration-20261121 (already holds the
lab cookie-jar base + both docs). Per-task branches cut FROM the trunk, merged back into it:

- codex/jik1-fe-protocol-sync — merges first (jik.2 shares its files).
- codex/jik2-impersonate-transport and codex/jik3-signin-worker — cut after jik.1 merges,
  run in parallel (separate .worktrees/*, mostly disjoint files: request.js/header-profile.js
  vs new sidecar + token-manager.js).
- jik.4 branch after jik.3 merges. jik.5 = final PR of the trunk -> main -> production
  after the live smoke passes.

Order rationale: jik.1 and jik.2 touch the same files (header-profile.js, request.js) and
must be sequential; jik.3 is mostly new code and is the clean parallel track. jik.3's first
deliverable (session harvest script) also unlocks manual testing of jik.2 with a live token.

