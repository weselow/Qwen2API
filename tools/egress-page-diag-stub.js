'use strict'
/*
 * Stub chat site for dry runs of tools/egress-page-diag.js (loopback only).
 *   STUB_MODE=ok          POST /api/v2/chats/new answers at once
 *   STUB_MODE=hang        POST /api/v2/chats/new never answers; the page itself stays alive
 *   STUB_MODE=freeze      the page's main thread goes into a busy loop 2.5 s after the
 *                         page's script starts: nothing in the page answers any more
 *   STUB_MODE=hangfreeze  the call never answers, and the busy loop starts 1.5 s after the
 *                         script: the call is pending and the page stops answering —
 *                         what the worker saw on prod on 2026-11-24
 *   STUB_MODE=waf         a model of the real page's request protection. The page's own
 *                         hook signs XMLHttpRequests to /api/v2/chats/… (x-stub-ua,
 *                         x-stub-umidtoken) and leaves fetch alone. The server answers
 *                         an unsigned chats/new with a challenge page under status 200,
 *                         the way qwen.ai's WAF did on 2026-11-24.
 *   STUB_PORT             default 3847
 */
const http = require('http')

const mode = process.env.STUB_MODE || 'ok'
const hang = mode === 'hang' || mode === 'hangfreeze'
const waf = mode === 'waf'
const freezeAfterMs = mode === 'freeze' ? 2500 : mode === 'hangfreeze' ? 1500 : 0
const port = Number(process.env.STUB_PORT || 3847)
const payload = Buffer.from(JSON.stringify({ sub: 'stub', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')
const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.stub-signature`
const sockets = new Set()

// What stands in for the page's own request hook (baxiaCommon.js on the real page).
const hook = `
    (function () {
        const open = XMLHttpRequest.prototype.open
        XMLHttpRequest.prototype.open = function (method, url) {
            this.protected = /\\/api\\/v2\\/chats\\//.test(String(url))
            return open.apply(this, arguments)
        }
        const send = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.send = function () {
            this.setRequestHeader('x-stub-v', '1')
            if (this.protected) {
                this.setRequestHeader('x-stub-ua', 'stub-ua')
                this.setRequestHeader('x-stub-umidtoken', 'stub-umidtoken')
            }
            return send.apply(this, arguments)
        }
    }())`

http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>stub chat</title><body><h1>stub</h1><script>
            localStorage.setItem('token', ${JSON.stringify(token)});
            ${waf ? hook : ''}
            setTimeout(() => fetch('/api/v2/models'), 300);
            setTimeout(() => fetch('https://not-loopback.example/beacon', { method: 'POST' }), 500);
            setTimeout(() => fetch('/api/v2/user'), 700);
            ${freezeAfterMs ? `setTimeout(() => { const until = Date.now() + 600000; while (Date.now() < until) {} }, ${freezeAfterMs});` : ''}
        </script><script src="/qwen-chat-fe/0.3.50/js/index-stub.js"></script></body>`)
        return
    }
    if (pathname === '/qwen-chat-fe/0.3.50/js/index-stub.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end('')
        return
    }
    if (pathname === '/api/v2/chats/new' && hang) return // never answers
    if (pathname === '/api/v2/chats/new' && waf && !req.headers['x-stub-ua']) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="stub"> <script> /* stub */ </script>')
        return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(pathname === '/api/v2/chats/new'
        ? { success: true, data: { chat_id: 'stub-chat', chat_mode: 'normal' } }
        : { success: true, data: [] }))
}).listen(port, '127.0.0.1', () => {
    console.log(`stub listening on http://127.0.0.1:${port} mode=${mode} pid=${process.pid}`)
}).on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
})
process.on('SIGTERM', () => {
    for (const socket of sockets) socket.destroy()
    process.exit(0)
})
