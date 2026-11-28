#!/bin/bash
# Repository copy (tools/prod-host/) of /root/v2-media.sh on the prod host, taken
# from the host on 28.11.2026. sha256 of the host original:
#   e780173505e1e7bdbe69d6d15534b245d9593558184f65c63d59b51d74d212d0
# Since 28.11.2026 this file is the source; docs/prod-hybrid-deploy.md,
# «Скрипты хоста в репозитории», says how a copy gets to the host. The copy
# differs from the host original by these comment lines only.
# Live check of Qwen2API-03v (images, video and files through the worker's page): ONE request
# into the app, then the logs that say what the worker and the app made of it. Shaped after
# /root/v2-pong.sh. The admin key is read inside the container and never printed; JWTs are
# masked in what is shown.
#   bash /root/v2-media.sh dry      /api/getAllAccounts on loopback — nothing goes to qwen.ai
#   bash /root/v2-media.sh pong     one text "pong" (the control: the working path is whole)
#   bash /root/v2-media.sh image    POST /v1/images/generations
#   bash /root/v2-media.sh video    POST /v1/videos (minutes: the client waits up to 25)
#   bash /root/v2-media.sh doc      POST /v1/chat/completions: a context over the file threshold, with tools
#   bash /root/v2-media.sh picmsg   POST /v1/chat/completions: a small png in the message
#   bash /root/v2-media.sh close    docker restart of the worker: closes the account's page
#   bash /root/v2-media.sh get [url]   one plain GET of a result's url from the prod host — not for a qwen.ai host;
#                                      without an argument, the last result's url (kept on the host, mode 600)
# Live requests go one at a time, a minute apart by the prod host's own clock (/root/.v2-media-last).
set -u
S=m04skwsg8kck8ckwkc04ssss
MODE=${1:-dry}
ARG=${2:-}
LAST=/root/.v2-media-last
LAST_URL=/root/.v2-media-last-url
Q=$(docker ps --format '{{.Names}}' | grep "$S" | grep -v -E 'signin-worker|dnsproxy')
W=$(docker ps --format '{{.Names}}' | grep "$S" | grep signin-worker)
date -u +%FT%TZ

mask() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
worker_log() {
  echo "--- worker log ($1)"
  docker logs --since "$1" "$W" 2>&1 | mask | grep -a -E 'resident-|egress|renew|session|challenge|kept|page_|egress_|error|Error|token-refresh|page-load|forget' | tail -n 70 | cut -c1-230
}
app_log() {
  echo "--- app log ($1)"
  docker logs --since "$1" "$Q" 2>&1 | mask | grep -a -E 'WAF challenge page|kept from the call|renew ok|session acquired|-> 401|egress_too_large|upstream_transport_error|图片/视频|视频任务|聊天详情|опрос |文件上传到OSS|外置|附件失败|getstsToken|files/parse|tasks/status|Agent |signin-worker|v2 |chat challenge|上传失败|OSS|STS|usage' | tail -n 70 | cut -c1-250
}
flags() {
  echo "worker: $(docker exec "$Q" bun -e 'fetch("http://signin-worker:3100/health").then(async r=>console.log(r.status,await r.text()))' 2>&1 | cut -c1-200)"
  echo "app images: $(docker inspect --format '{{.Config.Image}}' "$Q" | sed 's/.*://')  worker image: $(docker inspect --format '{{.Config.Image}}' "$W" | sed 's/.*://')"
}

if [ "$MODE" = close ]; then
  echo "closing the account's page: docker restart $W"
  docker restart "$W" >/dev/null && sleep 3
  flags
  exit 0
fi

if [ "$MODE" = get ]; then
  [ -n "$ARG" ] || ARG=$(tail -n 1 "$LAST_URL" 2>/dev/null)
  [ -n "$ARG" ] || { echo "no result url kept on the host yet"; exit 5; }
  host=$(printf '%s' "$ARG" | sed -E 's#^[a-z]+://([^/]+).*#\1#')
  if printf '%s' "$host" | grep -q -E '(^|\.)qwen\.ai$'; then
    echo "REFUSED: $host is qwen.ai — from Node it is not asked (the owner decides)"
    exit 4
  fi
  echo "one plain GET from the prod host: $(printf '%s' "$ARG" | sed -E 's/\?.*$//')…"
  curl -sS -o /dev/null --max-time 60 -w 'http=%{http_code} type=%{content_type} bytes=%{size_download} seconds=%{time_total}\n' "$ARG"
  exit 0
fi

if [ "$MODE" != dry ]; then
  now=$(date -u +%s); last=$(cat "$LAST" 2>/dev/null || echo 0); left=$((65 - (now - last)))
  if [ "$left" -gt 0 ]; then
    echo "REFUSED: $left s are left of the minute between two live requests (prod clock)"
    exit 3
  fi
  date -u +%s > "$LAST"
fi

JS=$(cat <<'JS'
const MODE = process.env.MODE
const started = Date.now()
const at = () => "+" + ((Date.now() - started) / 1000).toFixed(2) + "s"
const base = "http://127.0.0.1:3000"
const auth = { Authorization: "Bearer " + process.env.API_KEY }

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
// A plain picture of one colour: 8-bit RGB, no interlace.
const png = (size, [r, g, b]) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr), chunk("IDAT", require("node:zlib").deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
  ])
}
// A word the model can only know from the attached document: it is stated at the document's
// head, far above the live prompt that keeps the message's tail.
const WORD = ["maple", "harbor", "cinder", "velvet", "orchid", "falcon", "ember", "quartz"][started % 8] + "-" + (1000 + started % 9000)
const document = () => {
  let text = "CODE WORD: " + WORD + "\n\nReference document follows. It carries no other code word.\n\n"
  for (let i = 1; i <= 2000; i++) text += "This is filler line " + i + " of the reference document.\n"
  return text + "\nEnd of document. The code word is stated once, at the very beginning of the attached document. Reply with the code word only."
}
const PICTURE = png(128, [220, 30, 30])
const calls = {
  pong: () => ({ path: "/v1/chat/completions", body: { model: "qwen3.7-plus", stream: true, messages: [{ role: "user", content: "Say pong" }] } }),
  image: () => ({ path: "/v1/images/generations", body: { prompt: "A red apple on a wooden table, soft daylight" } }),
  video: () => ({ path: "/v1/videos", body: { prompt: "A slow pan across a calm lake at sunrise" } }),
  doc: () => ({
    path: "/v1/chat/completions",
    body: {
      model: "qwen3.7-plus", stream: false,
      messages: [{ role: "user", content: document() }],
      // DOC_PLAIN=1 in the environment sends the document without tools (27.11: the live check of l7x, "a document without tools").
      ...(process.env.DOC_PLAIN ? {} : { tools: [{ type: "function", function: { name: "noop", description: "Does nothing. Do not call it.", parameters: { type: "object", properties: {}, required: [] } } }] })
    }
  }),
  picmsg: () => ({
    path: "/v1/chat/completions",
    body: {
      model: "qwen3.7-plus", stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is the dominant color of this image? Answer with one word." },
          { type: "image_url", image_url: { url: "data:image/png;base64," + PICTURE.toString("base64") } }
        ]
      }]
    }
  })
}
const bytes = value => Buffer.byteLength(JSON.stringify(value))

if (MODE === "rehearse") {
  for (const name of ["pong", "image", "video", "doc", "picmsg"]) {
    const call = calls[name]()
    console.log(name, call.path, "body bytes:", bytes(call.body))
  }
  if (process.env.PNG_OUT) require("node:fs").writeFileSync(process.env.PNG_OUT, PICTURE)
  console.log("png bytes:", PICTURE.length, "signature:", PICTURE.subarray(0, 8).toString("hex"), "code word:", WORD)
} else if (MODE === "dry") {
  try {
    const r = await fetch(base + "/api/getAllAccounts", { headers: auth })
    const j = await r.json().catch(() => ({}))
    console.log("DRY getAllAccounts", r.status, at(), "| total:", j.total, "| key present:", Boolean(process.env.API_KEY))
  } catch (e) { console.log("DRY FETCH ERR", e.message, at()) }
  console.log("thresholds: AGENT_CONTEXT_FILE_THRESHOLD_BYTES=" + (process.env.AGENT_CONTEXT_FILE_THRESHOLD_BYTES || "(unset: 90 KiB)") +
    " | doc body bytes: " + bytes(calls.doc().body) + " | png bytes: " + PICTURE.length)
  for (const name of ["pong", "image", "video", "doc", "picmsg"]) {
    const call = calls[name]()
    console.log(" ", name, call.path, "body bytes:", bytes(call.body))
  }
} else {
  const call = (calls[MODE] || (() => { throw new Error("unknown mode " + MODE) }))()
  const budget = MODE === "video" ? 25 * 60 * 1000 : 6 * 60 * 1000
  const cutter = new AbortController()
  const timer = setTimeout(() => cutter.abort(new Error("client gave up after " + budget + " ms")), budget)
  console.log("request", MODE, call.path, "body bytes:", bytes(call.body), "| client budget:", budget / 1000, "s")
  try {
    const r = await fetch(base + call.path, {
      method: "POST", signal: cutter.signal,
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(call.body)
    })
    console.log("status", r.status, at(), "| content-type:", r.headers.get("content-type"), "| retry-after:", r.headers.get("retry-after"))
    if (call.body.stream === true && r.body) {
      const dec = new TextDecoder()
      let all = "", chunks = 0
      try {
        for await (const piece of r.body) {
          const text = typeof piece === "string" ? piece : dec.decode(piece, { stream: true })
          all += text; chunks++
          if (chunks <= 4 || chunks % 10 === 0) console.log("chunk", chunks, at(), JSON.stringify(text.length > 200 ? text.slice(0, 100) + " ... " + text.slice(-100) : text))
        }
      } catch (e) { console.log("BODY ERR", e.message, at()) }
      console.log("chunks:", chunks, "| body bytes:", all.length, at())
      console.log("body tail:", JSON.stringify(all.slice(-700)))
    } else {
      const text = await r.text()
      console.log("body bytes:", text.length, at())
      console.log("body:", JSON.stringify(text.length > 1800 ? text.slice(0, 1800) + " ..." : text))
      if (MODE === "doc") console.log("code word " + WORD + " in the answer:", text.includes(WORD))
      const url = (() => { try { return JSON.parse(text).data?.[0]?.url } catch { return undefined } })()
      if (url) console.log("result url host:", new URL(url).host, "| full url:", url)
    }
  } catch (e) { console.log("FETCH ERR", e.message, at()) }
  clearTimeout(timer)
}
JS
)

echo "containers: app=$Q worker=$W"
# The client's output goes to the host first: a result's url carries an access key,
# which stays on the host (mode 600) and is masked in what is shown.
OUT=$(mktemp /root/.v2-media-out.XXXXXX)
chmod 600 "$OUT"
docker exec -e MODE="$MODE" -e PNG_OUT="${PNG_OUT:-}" "$Q" bun -e "$JS" > "$OUT" 2>&1
RC=$?
URL=$(sed -n 's/^result url host: .* | full url: //p' "$OUT" | tail -n 1)
if [ -n "$URL" ]; then printf '%s\n' "$URL" > "$LAST_URL"; chmod 600 "$LAST_URL"; fi
sed -E 's/(key=|eyJ)[A-Za-z0-9_.-]+/\1<redacted>/g' "$OUT" | cut -c1-330
rm -f "$OUT"
echo "client exit: $RC"
[ "$RC" = 0 ] || exit $RC

case "$MODE" in
  dry|rehearse) flags ;;
  pong|image|picmsg|doc) worker_log 4m; app_log 4m ;;
  video) worker_log 30m; app_log 30m ;;
esac
