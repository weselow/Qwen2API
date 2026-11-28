#!/bin/bash
# Repository copy (tools/prod-host/) of /root/v2-abort.sh on the prod host, taken
# from the host on 28.11.2026. sha256 of the host original:
#   164cab27cedfc98ca39ac601c8d9d006a0c41435fdab34bedbbb6068c5b525ea
# Since 28.11.2026 this file is the source; docs/prod-hybrid-deploy.md,
# «Скрипты хоста в репозитории», says how a copy gets to the host. The copy
# differs from the host original by these comment lines only.
# Live check of Qwen2API-mxs (a client leaving closes its upstream): ONE streaming request
# into the app, read to the first frames of the answer, then the connection is cut by the
# client. Shaped after /root/v2-media.sh: the same minute barrier (/root/.v2-media-last), the
# same masking. The admin key is read inside the container and never printed.
#   bash /root/v2-abort.sh dry    the same client against a stand-in on 127.0.0.1 inside the app
#                                 container — nothing goes to qwen.ai; the stand-in reads its
#                                 request body as the app does and tells what it saw of the cut
#   bash /root/v2-abort.sh abort  the one live request: POST /v1/chat/completions, stream: true
#   bash /root/v2-abort.sh plain  one text request without a stream, read to its end
# Live requests go one at a time, a minute apart by the prod host's own clock.
set -u
S=m04skwsg8kck8ckwkc04ssss
MODE=${1:-dry}
LAST=/root/.v2-media-last
PORT=3899
Q=$(docker ps --format '{{.Names}}' | grep "$S" | grep -v -E 'signin-worker|dnsproxy')
W=$(docker ps --format '{{.Names}}' | grep "$S" | grep signin-worker)
date -u +%FT%TZ

mask() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
worker_log() {
  echo "--- worker log ($1)"
  docker logs --since "$1" "$W" 2>&1 | mask | grep -a -E 'resident-open|resident-close|egress|renew|session|challenge|kept|page_|egress_|error|Error' | tail -n 70 | cut -c1-230
}
app_log() {
  echo "--- app log ($1)"
  docker logs --since "$1" "$Q" 2>&1 | mask | grep -a -E '聊天处理错误|mid_stream_|ERROR|WARN|chat challenge|signin-worker|v2 |续期|challenge|usage|切换|switch|retry|重试|补偿|-> 4|-> 5' | tail -n 70 | cut -c1-250
}
flags() {
  echo "worker: $(docker exec "$Q" bun -e 'fetch("http://signin-worker:3100/health").then(async r=>console.log(r.status,await r.text()))' 2>&1 | cut -c1-200)"
}

# The stand-in: a server of the app's own runtime (Bun in the app's container) that reads the
# request body as the application does and then streams frames until the client goes away.
# It exits by itself (on /quit, or 40 s after the start); nothing has to be stopped by hand.
SERVER_JS=$(cat <<'JS'
/* v2-abort-dry stand-in */
const http = require("node:http")
const PORT = 3899
const state = { started: Date.now(), listening: null, requestAt: null, bodyBytes: null, events: [], goneEpoch: null, framesSent: 0, writeAfterGone: null }
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://stand-in").pathname
  const json = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)) }
  if (path === "/ready") return json(200, { ready: true })
  if (path === "/report") return json(200, state)
  if (path === "/quit") { json(200, { bye: true }); setTimeout(() => process.exit(0), 100); return }
  if (path !== "/v1/chat/completions" || state.requestAt) return json(state.requestAt ? 429 : 404, { error: "not accepted" })
  const socket = req.socket
  const requestAt = Date.now()
  state.requestAt = requestAt
  const since = () => "+" + (Date.now() - requestAt) + " ms"
  const hasAddress = () => { const a = socket.address(); return Boolean(a && typeof a === "object" && a.address !== undefined) }
  const event = what => {
    state.events.push(since() + " " + what + " (socket address: " + (hasAddress() ? "yes" : "no") +
      "; socket.destroyed: " + socket.destroyed + "; res.destroyed: " + res.destroyed + "; res.writableEnded: " + res.writableEnded + ")")
  }
  req.on("aborted", () => event("req aborted"))
  req.on("close", () => event("req close"))
  socket.on("end", () => event("socket end"))
  socket.on("close", () => event("socket close"))
  res.on("close", () => event("res close"))
  res.on("finish", () => event("res finish"))
  // The body is read before anything is answered, as express.json reads every request of the
  // application: that is the condition under which the application has to learn of a client leaving.
  let bodyBytes = 0
  for await (const piece of req) bodyBytes += piece.length
  state.bodyBytes = bodyBytes
  event("body read, the answer starts")
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  let lost = false
  const frames = setInterval(() => {
    state.framesSent++
    const delta = state.framesSent <= 6 ? { reasoning_content: "thinking " } : { content: "line " + (state.framesSent - 6) + "\n" }
    res.write("data: " + JSON.stringify({ id: "dry", choices: [{ delta }] }) + "\n\n")
  }, 120)
  const watch = setInterval(() => {
    if (lost || hasAddress()) return
    lost = true
    state.goneEpoch = Date.now()
    event("socket lost its address")
    clearInterval(frames)
    clearInterval(watch)
    setTimeout(() => {
      state.writeAfterGone = { returned: res.write('data: {"choices":[{"delta":{"content":"after"}}]}\n\n'), at: since() }
      event("one write tried 30 ms after the loss")
    }, 30)
  }, 25)
})
server.on("error", error => { console.error("stand-in: " + error.message); process.exit(1) })
server.listen(PORT, "127.0.0.1", () => { state.listening = Date.now() })
setTimeout(() => process.exit(0), 40000)
JS
)

CLIENT_JS=$(cat <<'JS'
const MODE = process.env.MODE
const BASE = process.env.TARGET || "http://127.0.0.1:3000"
const DRY = MODE === "dry"
const CUTS = MODE === "abort" || DRY
const started = Date.now()
const at = () => "+" + ((Date.now() - started) / 1000).toFixed(2) + "s"
const say = what => console.log(at(), what)
const auth = { Authorization: DRY ? "Bearer dry" : "Bearer " + process.env.API_KEY, "Content-Type": "application/json" }
// The client reads until the answer proper has begun and a few frames of it are in — then it goes.
const CONTENT_FRAMES_TO_SEE = 4
// A model that thinks for longer than this is left while it still thinks: the upstream is generating either way.
const THINKING_LIMIT_MS = 25000
const BUDGET_MS = 60000
const LIST = "List the numbers from 1 to 150 in words, one number per line, with no other text."
const bodies = {
  abort: () => ({ model: "qwen3.7-plus", stream: true, messages: [{ role: "user", content: LIST }] }),
  plain: () => ({ model: "qwen3.7-plus", stream: false, messages: [{ role: "user", content: "Reply with the single word: pong" }] })
}
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

if (DRY) {
  // Nothing is asked of qwen.ai: the request goes to a stand-in inside this container.
  let ready = false
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await fetch(BASE + "/ready").then(r => r.ok, () => false)
    if (!ready) await sleep(100)
  }
  if (!ready) { console.log("DRY: the stand-in did not come up on " + BASE); process.exit(6) }
  say("stand-in ready on " + BASE)
}

// dry is the abort's request, sent to the stand-in instead of the application.
const KIND = MODE === "plain" ? "plain" : (MODE === "abort" || DRY) ? "abort" : null
if (!KIND) throw new Error("unknown mode " + MODE)
const body = bodies[KIND]()
const cutter = new AbortController()
const timer = setTimeout(() => cutter.abort(new Error("client gave up after " + BUDGET_MS + " ms")), BUDGET_MS)
let abortEpoch = null
console.log("client clock at the start: " + new Date(started).toISOString())
say("request " + MODE + " /v1/chat/completions | body bytes: " + bytes(body) + " | stream: " + body.stream + " | key present: " + Boolean(process.env.API_KEY))
try {
  const r = await fetch(BASE + "/v1/chat/completions", { method: "POST", signal: cutter.signal, headers: auth, body: JSON.stringify(body) })
  const headAt = Date.now()
  say("status " + r.status + " | content-type: " + r.headers.get("content-type") + " | retry-after: " + r.headers.get("retry-after"))
  if (body.stream !== true) {
    const text = await r.text()
    let answer = ""
    try { answer = JSON.parse(text).choices?.[0]?.message?.content ?? "" } catch (_) {}
    say("body bytes: " + text.length + " | \"pong\" in the answer: " + /pong/i.test(answer))
    console.log("answer:", JSON.stringify(answer.slice(0, 200)))
  } else {
    const decoder = new TextDecoder()
    let buffer = "", frames = 0, contentFrames = 0, thinkingFrames = 0, received = 0, why = null
    const look = text => {
      buffer += text
      let edge
      while ((edge = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, edge)
        buffer = buffer.slice(edge + 2)
        const data = raw.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
        if (!data) continue
        if (data === "[DONE]") { why = why || "the stream ended with [DONE] before any cut"; continue }
        let frame
        try { frame = JSON.parse(data) } catch (_) { continue }
        frames++
        const delta = frame.choices?.[0]?.delta
        if (delta?.reasoning_content) thinkingFrames++
        if (delta?.content) {
          contentFrames++
          if (contentFrames <= CONTENT_FRAMES_TO_SEE) say("content frame " + contentFrames + ": " + JSON.stringify(delta.content.slice(0, 50)))
        }
      }
    }
    try {
      for await (const piece of r.body) {
        const text = typeof piece === "string" ? piece : decoder.decode(piece, { stream: true })
        received += text.length
        look(text)
        if (!CUTS) continue
        if (contentFrames >= CONTENT_FRAMES_TO_SEE) {
          why = "cut after " + contentFrames + " content frames (" + frames + " frames, " + received + " bytes read)"
        } else if (Date.now() - headAt > THINKING_LIMIT_MS) {
          why = "cut on the thinking limit (" + THINKING_LIMIT_MS / 1000 + " s after the head without " +
            CONTENT_FRAMES_TO_SEE + " content frames): " + contentFrames + " content frame(s) and " + thinkingFrames + " thinking frame(s) read"
        }
        if (why) {
          // The abort closes the connection; a reader.cancel() alone under Bun does not.
          abortEpoch = Date.now()
          cutter.abort()
          break
        }
      }
    } catch (error) { why = why || ("body error: " + (error?.name || "") + " " + error.message) }
    say((abortEpoch ? "CUT: " : "NO CUT: ") + why)
    if (abortEpoch) console.log("client clock at the cut: " + new Date(abortEpoch).toISOString())
    say("frames: " + frames + " (content " + contentFrames + ", thinking " + thinkingFrames + ") | bytes read: " + received + " | signal aborted: " + cutter.signal.aborted)
  }
} catch (error) { say("FETCH ERR " + (error?.name || "") + " " + error.message) }
clearTimeout(timer)

if (DRY && abortEpoch) {
  await sleep(400)
  const report = await fetch(BASE + "/report").then(r => r.json()).catch(error => ({ error: error.message }))
  say("the stand-in's account (its times are its own, counted from its request):")
  console.log("  body read: " + report.bodyBytes + " bytes | frames sent: " + report.framesSent)
  for (const line of report.events || []) console.log("  " + line)
  console.log("  the socket lost its address " + (report.goneEpoch ? (report.goneEpoch - abortEpoch) + " ms after the client's cut" : "NEVER (not seen before the report)"))
  console.log("  a write tried 30 ms after the loss returned: " + (report.writeAfterGone ? report.writeAfterGone.returned : "(no loss seen)"))
  await fetch(BASE + "/quit", { method: "POST" }).catch(() => {})
}
JS
)

echo "containers: app=$Q worker=$W"
# The client's output goes to the host first, as /root/v2-media.sh does it.
OUT=$(mktemp /root/.v2-abort-out.XXXXXX)
chmod 600 "$OUT"

if [ "$MODE" = dry ]; then
  docker exec -d "$Q" bun -e "$SERVER_JS"
  docker exec -e MODE=dry -e TARGET="http://127.0.0.1:$PORT" "$Q" bun -e "$CLIENT_JS" > "$OUT" 2>&1
  RC=$?
else
  now=$(date -u +%s); last=$(cat "$LAST" 2>/dev/null || echo 0); left=$((65 - (now - last)))
  if [ "$left" -gt 0 ]; then
    echo "REFUSED: $left s are left of the minute between two live requests (prod clock)"
    rm -f "$OUT"
    exit 3
  fi
  date -u +%s > "$LAST"
  docker exec -e MODE="$MODE" "$Q" bun -e "$CLIENT_JS" > "$OUT" 2>&1
  RC=$?
fi
sed -E 's/(key=|eyJ)[A-Za-z0-9_.-]+/\1<redacted>/g' "$OUT" | cut -c1-400
rm -f "$OUT"
echo "client exit: $RC"

if [ "$MODE" = dry ]; then
  sleep 2
  still=$(docker top "$Q" 2>/dev/null | grep -F -c 'v2-abort-dry stand-in')
  answers=$(docker exec "$Q" bun -e "fetch('http://127.0.0.1:$PORT/ready').then(r=>'STILL ANSWERS '+r.status,()=>'down').then(console.log)" 2>&1 | head -n 1)
  echo "the stand-in after the rehearsal: $answers | its processes left in the container: $still"
fi
[ "$RC" = 0 ] || exit $RC

case "$MODE" in
  abort|plain) worker_log 3m; app_log 3m; flags ;;
esac
