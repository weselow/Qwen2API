# et0: live integration with chat.qwen.ai / auth.qwen.ai (2026-11-21)

Branch: `codex/et0-live-integration-20261121` (base: `codex/et0-v2-cookie-lab`, commit 784ddfd).
Full-session probe tools: `tools/et0-live-probe.js`, `tools/et0-session-probe.js`
(credentials via `QWEN_TEST_EMAIL`/`QWEN_TEST_PASSWORD` or `.tmp/et0-session.json`; reports to `.tmp/`).
No secrets in this document; cookie/token values are never recorded.

## Result: full v2 cycle completed with a browser-acquired session

1. **Sign-in (real browser)** — `GET chat.qwen.ai/auth` form → FE posts to
   `auth.qwen.ai/api/v2/auths/signin`; the Aliyun WAF captcha page (v2.0.1, interactive
   slider, `u_atoken`/`u_asig` re-submit) **auto-passed in a real Chrome context** — no
   manual solve. Session produced: JWT (`localStorage.token`, HS256 "legacy", **~30 min
   TTL**) + JS-visible cookies on chat.qwen.ai (`cna`, `tfstk`, `isg`, `ssxmod_itna`,
   `ssxmod_itna2`, `x-ap`, …). `acw_tc` is HttpOnly.
2. **Pure-Node sign-in is confirmed blocked**: POST signin from axios (with or without
   form cookies / `acw_tc`) receives the WAF captcha HTML, never JSON. The captcha is
   interactive (Baxia/Aliyun slider), not a computable `acw_sc__v2`-style challenge.
   Automated slider dragging failed (page resets / flags the trajectory).
3. **Session handoff to the adapter works**:
   - adapter `GET chat.qwen.ai/` (plain axios/HTTP1.1) → 200, receives its own
     `acw_tc`, `x-ap` (host-only) — no captcha.
   - adapter `POST /api/v2/chats/new` → **200 JSON, chat created** (no captcha) with
     browser token in `Authorization` + merged cookies. This overturns the 2026-11-18
     "chats/new always captcha" evidence: with a fresh valid token, FE-aligned headers
     and cookies it passes from plain Node.
   - adapter `POST /api/v2/chat/completions` from plain Node (axios or native `http2`)
     → **Baxia punish**: JSON `FAIL_SYS_USER_VALIDATE`/`RGV587_ERROR` with
     `_____tmd_____/punish?x5secdata=…__bx__` URL. Header alignment alone does not help.
4. **Root cause of the completions block: TLS fingerprint.** The same request (same
   token, cookies, FE headers) sent through **curl-impersonate-chrome (v0.6.1,
   Chrome TLS ClientHello + HTTP/2)** returns **200 `text/event-stream` with the model
   answer** ("pong"). Verified end-to-end from the same home IP via WSL.

## Protocol facts captured from the live FE (0.3.49)

- `Version` header is now **0.3.49** (repo ships 0.3.19 — stale, needs sync).
- completions request headers (FE): `Accept: application/json` (not
  `text/event-stream`), `source: web`, `Timezone: <Date().toString()>`,
  `X-Request-Id`, `X-Accel-Buffering: no`, `Authorization: Bearer`.
- completions body shape is now **version "2.1"**: `version`, `incremental_output`,
  `timestamp`, message metadata (`fid`, `user_action`, `files`, `models`,
  `feature_config{thinking_enabled, output_schema, research_mode, auto_thinking,
  thinking_mode, thinking_format, auto_search}`, `extra.meta.subChatType`,
  `sub_chat_type`). A minimal v0.3.19-era body gets `Bad_Request: Internal error`;
  the 2.1-shaped body streams fine.
- Model ids rotated: `qwen3-max` → `Not_Found`; current default **`qwen3.7-plus`**
  (list via `GET /api/v2/models`, response nests at `data.data`).
- v2 refresh `GET auth.qwen.ai/api/v2/auths/refresh`:
  - returns JSON (no WAF) but rejects without the FE's exact header set
    (`Invalid request header` → `Missing origin` with `source: web`);
  - the FE bundle calls it only as `/auths/refresh?code=<e>` (Electron `set_cookie`
    flow). The web FE renews its ~30-min token silently (auth.qwen.ai session
    cookies); after a page reload `localStorage.token` comes back rotated.
- Pre-login form cookies (`acw_tc`, `x-ap` from `GET /auth`) are **host-only for
  chat.qwen.ai** — they cannot and do not need to travel to auth.qwen.ai.

## Architecture conclusion for production (recommendation)

Hybrid, matching the lab branch's cookie-jar design:

1. **Session acquisition via a real browser context** (headless Chromium/Playwright
   worker): navigate the auth form, submit credentials, let the WAF captcha auto-pass,
   harvest `token` + cookies. Re-acquire silently on token expiry (reload does renew).
2. **Adapter carries the session** (tough-cookie jar per account) for `chats/new`
   (plain axios is enough) and for `GET /` warm-up.
3. **completions must ride a Chrome-grade TLS transport**: curl-impersonate
   (Linux builds exist; the prod container can ship the wrapper + libcurl-impersonate)
   or an equivalent impersonating client. Plain Node TLS is Baxia-flagged.
4. Body/headers sync: FE `Version` 0.3.49, completions body v2.1, model id
   `qwen3.7-plus`.

Path A (Playwright) therefore covers only sign-in; the chat pipeline itself stays on
HTTP with an impersonating transport — no browser per-request overhead.
