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
 *                         hook (in the shape of baxiaCommon.js 2.5.37) signs every
 *                         XMLHttpRequest, signs XMLHttpRequests to /api/v2/chats/… further
 *                         (x-stub-ua, x-stub-umidtoken), and leaves fetch alone. The server
 *                         answers an unsigned chats/new with a challenge page under status
 *                         200, the way qwen.ai's WAF did on 2026-11-24. To a request whose
 *                         onload or onloadend is set, the hook never tells such an answer
 *                         — which is how the worker's call hung for 35 s that day. A request
 *                         that listens with addEventListener gets it all the same.
 *   STUB_MODE=unauthorized-first
 *                         the first chats/new is answered at once, with no challenge, but with
 *                         the session refused ({"code":"unauthorized"}) — the way qwen.ai answered
 *                         the first call 0.3 s after the page opened on 2026-11-24. The page
 *                         rotates its token 1.5 s after its script starts. Later calls succeed.
 *   STUB_MODE=punish      chats/new succeeds; POST /api/v2/chat/completions is answered with the risk
 *                         control's envelope under status 200 ({"ret":["FAIL_SYS_USER_VALIDATE",
 *                         "RGV587_ERROR::SM::…被挤爆啦…"],"data":{"url":"…/punish?…"}}) — what qwen.ai
 *                         answered the completions call from the page on 2026-11-24. Without it the
 *                         stub answers completions with three SSE frames ("pon", "g", [DONE]).
 *   STUB_PORT             default 3847
 */
const http = require('http')

const mode = process.env.STUB_MODE || 'ok'
const hang = mode === 'hang' || mode === 'hangfreeze'
const waf = mode === 'waf'
// unauthorized-first: the first chats/new is answered at once, no challenge, with the session refused; the page rotates its token 1.5 s after its script starts.
const refuseFirst = mode === 'unauthorized-first'
// punish: completions is answered with the risk control's envelope under status 200, as qwen.ai did from the page on 2026-11-24.
const punish = mode === 'punish'
let refusalsLeft = refuseFirst ? 1 : 0
const freezeAfterMs = mode === 'freeze' ? 2500 : mode === 'hangfreeze' ? 1500 : 0
const port = Number(process.env.STUB_PORT || 3847)
const payload = Buffer.from(JSON.stringify({ sub: 'stub', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')
const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.stub-signature`
const rotated = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'stub', exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.stub-rotated`
const sockets = new Set()

// What stands in for the page's own request hook (baxiaCommon.js on the real page).
const hook = `
    (function () {
        const proto = XMLHttpRequest.prototype
        const open = proto.open
        proto.open = function (method, url) {
            this.protected = /\\/api\\/v2\\/chats\\//.test(String(url))
            return open.apply(this, arguments)
        }
        const blocked = xhr => {
            let text = ''
            try { text = xhr.response || xhr.responseText } catch (error) { /* nothing to read yet */ }
            return /aliyun_waf_/.test(String(text))
        }
        const send = proto.send
        proto.send = function () {
            this.setRequestHeader('x-stub-v', '2.5.37')
            if (this.protected) {
                this.setRequestHeader('x-stub-ua', 'stub-ua')
                this.setRequestHeader('x-stub-umidtoken', 'stub-umidtoken')
            }
            // An answer the hook takes for a block is never told to these.
            for (const name of ['onload', 'onloadend']) {
                const own = this[name]
                if (own) this[name] = function (event) { if (!blocked(this)) own.call(this, event) }
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
            ${refuseFirst ? `setTimeout(() => localStorage.setItem('token', ${JSON.stringify(rotated)}), 1500);` : ''}
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
    if (pathname === '/api/v2/chat/completions') {
        if (punish) {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({
                ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'],
                data: { url: 'https://stub.example/_____tmd_____/punish?x5secdata=stub' }
            }))
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const frames = ['data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"pon"}}]}\n\n',
            'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"g"}}]}\n\n', 'data: [DONE]\n\n']
        return frames.forEach((frame, at) => setTimeout(() => (at === frames.length - 1 ? res.end(frame) : res.write(frame)), 150 * (at + 1)))
    }
    if (pathname === '/api/v2/chats/new' && refuseFirst && refusalsLeft-- > 0) {
        // What qwen.ai answered the first call after the page opened (24.11): at once, no challenge, the session refused.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, request_id: 'stub', data: { code: 'unauthorized', details: '401 Unauthorized' } }))
        return
    }
    if (pathname === '/api/v2/chats/new' && waf && !req.headers['x-stub-ua']) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="stub"> <script> /* stub */ </script>')
        return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(pathname === '/api/v2/chats/new'
        ? { success: true, request_id: 'stub', data: { id: 'stub-chat', chat_mode: 'normal' } }
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
