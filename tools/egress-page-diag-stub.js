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
 *   STUB_MODE=ui         the page has an input and a send button, as the chat site has, and sends a message
 *                         through them: its own chats/new, then its own completions with bx-ua / bx-umidtoken
 *                         on it, the way the page's own code puts them. The page changes its token 3 s
 *                         after its script starts, and a chats/new on the first one (what a renewal
 *                         harvests) is refused, as qwen.ai refused the app's token on 2026-11-24.
 *                         For --ui-send=1 with --signed=1 and --bearer-compare=1.
 *   STUB_MODE=ui-punish  the same, but the page's own completions is answered with the punish envelope.
 *   STUB_MODE=ui-upload  for --ui-upload=1: the page has a file input, and a file put into it goes the way the chat
 *                         site uploads one — STS, the bytes to the object store, the parse and its status — through
 *                         the page's own code. STUB_UPLOAD_TRANSPORT=xhr|fetch says how the page makes its file
 *                         calls (default xhr). STUB_UPLOAD_REFUSED=1 makes the server answer STS with 405 and an
 *                         HTML error page, as qwen.ai answered the app's own call on 2026-11-25.
 *   STUB_MODE=own-ok     for --like-own=1: POST /api/v2/chat/completions is answered with SSE frames, the worker's own
 *                         call included
 *   STUB_MODE=own-ok-control-punished
 *                         the same, but the worker's own call — an XMLHttpRequest, which the page's hook marks
 *                         with x-stub-v — is answered with the punish envelope
 *   STUB_MODE=own-referrer-needed
 *                         completions is answered with the punish envelope unless the request's referer is
 *                         /c/<chat>, as a fetch from that address of the page sends it
 *   STUB_MODE=own-xhr-ok
 *                         for --isolate-xhr=1: completions is answered with SSE frames when the request carries
 *                         x-accel-buffering: no, and with the punish envelope when it does not
 *   In all of them, as qwen.ai does (2026-11-25), a completions without the chat id in the address is
 *   answered with the server's own validation error, and the page has the request hook of the
 *                         waf mode.
 *   STUB_PORT             default 3847
 */
const http = require('http')

const mode = process.env.STUB_MODE || 'ok'
const hang = mode === 'hang' || mode === 'hangfreeze'
// ui, ui-punish: an input and a send button on the page; a message goes out through them.
const ui = mode === 'ui' || mode === 'ui-punish'
// ui-upload: a file input on the page; a file put into it is uploaded through the page's own code.
const uiUpload = mode === 'ui-upload'
const uploadTransport = process.env.STUB_UPLOAD_TRANSPORT === 'fetch' ? 'fetch' : 'xhr'
const uploadRefused = process.env.STUB_UPLOAD_REFUSED === '1'
// The three modes for --like-own=1.
const own = mode === 'own-ok' || mode === 'own-ok-control-punished' || mode === 'own-referrer-needed' || mode === 'own-xhr-ok'
const waf = mode === 'waf' || ui || own
// unauthorized-first: the first chats/new is answered at once, no challenge, with the session refused; the page rotates its token 1.5 s after its script starts.
const refuseFirst = mode === 'unauthorized-first'
// punish: completions is answered with the risk control's envelope under status 200, as qwen.ai did from the page on 2026-11-24.
const punish = mode === 'punish' || mode === 'ui-punish'
// own-referrer-needed: completions is punished unless the request carries the page's own referer for it.
const referrerNeeded = mode === 'own-referrer-needed'
// own-xhr-ok: completions is punished unless the request carries x-accel-buffering: no.
const accelNeeded = mode === 'own-xhr-ok'
// own-ok-control-punished: the worker's own call — an XMLHttpRequest, marked by the page's hook — is punished still.
const controlPunished = mode === 'own-ok-control-punished'
let refusalsLeft = refuseFirst ? 1 : 0
// ui-upload: how many times the page asked for the parse status; the third answer says success.
let uploadStatusAsks = 0
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

// What stands in for the chat site's input, its send button, and the code that sends a message.
const uiControls = `
    <textarea id="chat-input" placeholder="Message" style="width: 320px; height: 40px"></textarea>
    <button id="send-message-button" type="button" aria-label="Send" disabled><svg width="12" height="12"></svg></button>
    <div id="thread"></div>
    <script>
        (function () {
            const input = document.getElementById('chat-input')
            const button = document.getElementById('send-message-button')
            const thread = document.getElementById('thread')
            const call = (url, body, done) => {
                const xhr = new XMLHttpRequest()
                xhr.open('POST', url)
                xhr.setRequestHeader('content-type', 'application/json')
                xhr.setRequestHeader('authorization', 'Bearer ' + localStorage.getItem('token'))
                // What the page's own code puts on its completions request.
                if (url.indexOf('/completions') !== -1) {
                    xhr.setRequestHeader('bx-ua', 'stub-ua-' + Date.now())
                    xhr.setRequestHeader('bx-umidtoken', 'stub-umidtoken')
                }
                xhr.onload = () => done(xhr.responseText)
                xhr.send(body)
            }
            const send = () => {
                const text = input.value.trim()
                if (!text) return
                input.value = ''
                button.disabled = true
                call('/api/v2/chats/new', JSON.stringify({ chatId: '', models: ['qwen3.7-plus'], chat_type: 't2t' }), answer => {
                    const id = JSON.parse(answer).data.id
                    thread.innerText += 'you: ' + text + ' | '
                    call('/api/v2/chat/completions?chat_id=' + id, JSON.stringify({
                        model: 'qwen3.7-plus', stream: true, chat_id: id, incremental_output: true,
                        messages: [{ role: 'user', content: text }]
                    }), out => { thread.innerText += 'assistant: ' + out.slice(0, 80) })
                })
            }
            input.addEventListener('input', () => { button.disabled = !input.value.trim() })
            button.addEventListener('click', send)
            input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } })
        }())
    </script>`

// What stands in for the chat site's file input and the code that uploads a file put into it.
const uploadControls = `
    <input id="chat-file-input" type="file" accept=".txt,.md,.doc,.docx,.pdf,.png,.jpg" style="display: none">
    <div id="attachments"></div>
    <script>
        (function () {
            const attach = document.getElementById('chat-file-input')
            const shown = document.getElementById('attachments')
            const call = (url, body, done) => {
                const headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + localStorage.getItem('token') }
                if (${JSON.stringify(uploadTransport)} === 'xhr') {
                    const xhr = new XMLHttpRequest()
                    xhr.open('POST', url)
                    for (const name in headers) xhr.setRequestHeader(name, headers[name])
                    xhr.onload = () => done(xhr.status, xhr.responseText)
                    xhr.send(body)
                    return
                }
                fetch(url, { method: 'POST', headers, body, credentials: 'include' }).then(response => response.text().then(text => done(response.status, text)))
            }
            const json = (method, url, payload, done) => call(url, JSON.stringify(payload), done)
            attach.addEventListener('change', () => {
                const file = attach.files[0]
                if (!file) return
                json('POST', '/api/v1/files/getstsToken', { filename: file.name, filesize: file.size, filetype: 'document' }, (status, text) => {
                    if (status !== 200) { shown.innerText += 'sts failed: ' + status + ' | '; return }
                    const data = JSON.parse(text).data
                    fetch('/oss/' + data.file_path, { method: 'PUT', body: file, headers: { 'x-oss-security-token': data.security_token } })
                        .then(put => put.text())
                        .then(() => json('POST', '/api/v2/files/parse', { file_id: data.file_id }, (parseStatus, parseText) => {
                            const poll = attempt => json('POST', '/api/v2/files/parse/status', { file_id_list: [data.file_id] }, (code, out) => {
                                const list = JSON.parse(out).data.list || []
                                const state = list.length ? list[0].status : 'missing'
                                if (code === 200 && state !== 'success' && attempt < 20) return setTimeout(() => poll(attempt + 1), 400)
                                shown.innerText += 'file: ' + file.name + ' ' + state + ' | '
                            })
                            setTimeout(() => poll(0), 300)
                        }))
                })
            })
        }())
    </script>`

http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>stub chat</title><body><h1>stub</h1>${ui ? uiControls : ''}${uiUpload ? uploadControls : ''}<script>
            localStorage.setItem('token', ${JSON.stringify(token)});
            ${waf ? hook : ''}
            ${refuseFirst ? `setTimeout(() => localStorage.setItem('token', ${JSON.stringify(rotated)}), 1500);` : ''}
            ${ui ? `setTimeout(() => localStorage.setItem('token', ${JSON.stringify(rotated)}), 3000);` : ''}
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
    if (pathname === '/api/v1/files/getstsToken') {
        if (uploadRefused) {
            // As qwen.ai answered the app's own STS call from the page on 2026-11-25: 405 with an HTML error page.
            res.writeHead(405, { 'content-type': 'text/html; charset=utf-8' })
            return res.end('<!doctypehtml><html lang="zh-cn"><meta charset="utf-8"><meta name="data-spm" content="a3c0e"><title>405</title><style>a,body{margin:0}</style><body>405</body></html>')
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: true, data: {
            access_key_id: 'stub-access-key-id', access_key_secret: 'stub-access-key-secret', security_token: 'stub-security-token',
            file_url: `http://127.0.0.1:${port}/oss/stub-user/file.txt?key=stub-url-key`, file_path: 'stub-user/file.txt',
            bucketname: 'stub-bucket', region: 'stub-region', file_id: 'stub-file-1'
        } }))
    }
    if (uiUpload && pathname === '/oss/stub-user/file.txt' && req.method === 'PUT') {
        req.resume()
        return req.on('end', () => { res.writeHead(200); res.end('') })
    }
    if (uiUpload && pathname === '/api/v2/files/parse') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: true, data: {} }))
    }
    if (uiUpload && pathname === '/api/v2/files/parse/status') {
        uploadStatusAsks += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: true, data: { list: [{ file_id: 'stub-file-1', status: uploadStatusAsks < 3 ? 'processing' : 'success' }] } }))
    }
    if (pathname === '/api/v2/chat/completions') {
        // As qwen.ai does (25.11): no completions without the chat id in the address.
        if (own && !/[?&]chat_id=/.test(req.url)) {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({
                success: false, request_id: 'stub',
                data: { code: 'RequestValidationError', details: JSON.stringify(["Field 'query -> chat_id': Field required"]) }
            }))
        }
        if (punish || (controlPunished && req.headers['x-stub-v']) || (accelNeeded && req.headers['x-accel-buffering'] !== 'no') ||
            (referrerNeeded && !/\/c\/[^/]+$/.test(String(req.headers.referer || '')))) {
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
    if (pathname === '/api/v2/chats/new' && ui && req.headers.authorization === `Bearer ${token}`) {
        // On the token a renewal harvests (the page's first one): the session of the call is refused, as on 24.11.
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
