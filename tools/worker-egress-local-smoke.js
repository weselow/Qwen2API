#!/usr/bin/env node
'use strict'

/**
 * Local end-to-end smoke for the signin worker's resident egress
 * (Qwen2API-3ue.1): the REAL worker, the REAL browser-signin and a REAL
 * headless Chromium — against a stand-in for chat.qwen.ai on 127.0.0.1. The
 * headless mode `chrome` (Qwen2API-3ue.4) runs here too: what the stand-in
 * sees of the full Chromium against what it saw of the shell.
 *
 * The stand-in's page carries a request hook in the shape of the real page's
 * (baxiaCommon.js 2.5.37): it signs every XHR, and it keeps an answer it takes
 * for a block away from the request's onload and onloadend properties
 * (Qwen2API-3ue.5 and .6). That is what hung /egress for 35 s on prod on
 * 2026-11-24; here the worker has to see a challenge page through it, at once.
 *
 * qwen.ai is never contacted: run this freely, it is not a live probe. Use it
 * after touching the worker's browser paths: signin-worker/server.js (the
 * sign-in path), lib/login-pacer.js, lib/resident-pages.js,
 * lib/egress-fetch.js. The tests in tests/ run a fake Playwright, this one
 * does not.
 *
 *   bunx playwright install chromium     # once
 *   node tools/worker-egress-local-smoke.js
 */

/* global XMLHttpRequest */

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

const { createServer } = require('../signin-worker/server')

const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const tokenExpiringIn = seconds =>
    `${b64url({ alg: 'HS256', type: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + seconds })}.signature`

// What /api/sse answers, a frame at a time. Cyrillic on purpose: a frame cut
// inside a two-byte character must come back whole through the relay.
const SSE_FRAMES = [
    'data: {"choices":[{"delta":{"content":"при"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
    'data: [DONE]\n\n'
]
// What /api/sse-wide answers, in 7-byte pieces: every two-, three- and
// four-byte character gets cut somewhere. A stream is read as text off the
// request, and has to come back as the bytes that were sent.
const WIDE = 'data: {"choices":[{"delta":{"content":"привет 中文テスト \ud83d\ude00\ud83c\udf89"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"конец 结束 \ud83c\udf8a"}}]}\n\n' + 'data: [DONE]\n\n'
// What qwen.ai's WAF answered an API call with on 2026-11-24: status 200, a page.
const CHALLENGE_PAGE = '<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="stub"> ' +
    '<script> /* v2.0.1 */ </script>'

/**
 * The stand-in page's request hook, as the real page's (baxiaCommon.js
 * 2.5.37) behaves where it matters here. Runs in the page.
 * @param {boolean} strict - Also hide a blocked answer from addEventListener,
 *   which the real hook does not do: the second line of the worker's
 *   (Qwen2API-3ue.6) is exercised with it
 */
function pageHook(strict) {
    const proto = XMLHttpRequest.prototype
    const blocked = xhr => {
        let text = ''
        try { text = xhr.response || xhr.responseText } catch (error) { /* nothing to read yet */ }
        return /aliyun_waf_/.test(String(text))
    }
    const send = proto.send
    proto.send = function () {
        // What the page's hook adds to every request of the page's, this one included.
        this.setRequestHeader('x-stub-v', '2.5.37')
        // An answer taken for a block is never told to these.
        for (const name of ['onload', 'onloadend']) {
            const own = this[name]
            if (!own) continue
            this[name] = function (event) { if (!blocked(this)) own.call(this, event) }
        }
        return send.apply(this, arguments)
    }
    if (!strict) return
    const add = proto.addEventListener
    proto.addEventListener = function (type, listener, options) {
        return add.call(this, type, function (event) { if (!blocked(this)) listener.call(this, event) }, options)
    }
}

/**
 * The stand-in: a root page that settles a token the way the chat FE does,
 * and API routes that report what actually reached the server. The root page
 * carries a frame from another site — another loopback address, so it is
 * another site to the browser — because that is where a captcha lives, and
 * what that frame sees of itself is part of what the page presents.
 */
function startStandIn() {
    let pageLoads = 0
    // What /api/sse-long saw when its client went away — which, for a relay,
    // is the fetch inside the page being aborted.
    const longStream = { sent: 0, closedAt: 0 }
    // What the third-party frame saw of itself, the last time it loaded.
    const frame = { document: null, request: null, page: null }
    // Whether the page loaded next hides blocked answers from listeners too.
    const state = { holdListeners: false }
    const other = http.createServer((req, res) => {
        if (req.url === '/frame' && req.method === 'GET') {
            frame.document = req.headers['user-agent'] || null
            res.writeHead(200, { 'content-type': 'text/html' })
            return res.end(`<html><body>frame<script>fetch('/api/echo',{method:'POST',headers:{
                'content-type':'application/json'},body:JSON.stringify({userAgent:navigator.userAgent})})</script></body></html>`)
        }
        if (req.url === '/api/echo' && req.method === 'POST') {
            frame.request = req.headers['user-agent'] || null
            let body = ''
            req.on('data', chunk => { body += chunk })
            return req.on('end', () => {
                frame.page = JSON.parse(body).userAgent
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('{}')
            })
        }
        res.writeHead(404)
        return res.end()
    })
    const server = http.createServer((req, res) => {
        if (req.url === '/' && req.method === 'GET') {
            pageLoads++
            res.writeHead(200, {
                'content-type': 'text/html', 'set-cookie': 'standin=1; Path=/',
                // So that the calls the page makes carry the hints a guard can ask for.
                'accept-ch': 'Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List'
            })
            return res.end(`<html><body>stand-in<iframe src="http://127.0.0.2:${
                other.address().port}/frame" style="width:0;height:0;border:0"></iframe><script>localStorage.setItem('token', '${
                tokenExpiringIn(3600)}')</script></body></html>`.replace(
                '<script>localStorage', `<script src="/scripts/qwen-chat-fe/0.3.50/js/index.js"></script>` +
                `<script>(${pageHook})(${state.holdListeners})</script><script>localStorage`))
        }
        if (req.url === '/scripts/qwen-chat-fe/0.3.50/js/index.js' && req.method === 'GET') {
            // The front end's script: only its address matters here.
            res.writeHead(200, { 'content-type': 'application/javascript' })
            return res.end('')
        }
        if (req.url === '/api/challenged') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            return res.end(CHALLENGE_PAGE)
        }
        if (req.url === '/auth' && req.method === 'GET') {
            // What the chat FE does on /auth for a profile that is signed in:
            // it settles a token right there. Long-lived, so the worker's
            // session cache counts it as live next to the smoke's minCacheSeconds.
            pageLoads++
            res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'standin=1; Path=/' })
            return res.end(`<html><body>auth stand-in<script>localStorage.setItem('token', '${
                tokenExpiringIn(30 * 86400)}')</script></body></html>`)
        }
        if (req.url === '/api/slow') {
            // Longer than the timeout the smoke asks for.
            return setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('{"late":true}')
            }, 3000)
        }
        if (req.url === '/api/big') {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ filler: 'x'.repeat(64 * 1024) }))
        }
        if (req.url === '/api/echo') {
            let body = ''
            req.on('data', chunk => { body += chunk })
            return req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({
                    method: req.method,
                    body,
                    cookie: req.headers.cookie || null,
                    authorization: req.headers.authorization || null,
                    requestId: req.headers['x-request-id'] || null,
                    // What makes the call one of the page's own requests (Qwen2API-3ue.5).
                    accept: req.headers.accept || null,
                    acceptLanguage: req.headers['accept-language'] || null,
                    source: req.headers.source || null,
                    timezone: req.headers.timezone || null,
                    version: req.headers.version || null,
                    signed: req.headers['x-stub-v'] || null,
                    userAgent: req.headers['user-agent'] || null,
                    secChUa: req.headers['sec-ch-ua'] || null,
                    platformVersion: req.headers['sec-ch-ua-platform-version'] ?? null,
                    fullVersionList: req.headers['sec-ch-ua-full-version-list'] ?? null
                }))
            })
        }
        if (req.url === '/api/sse') {
            // A frame at a time, with a pause between: a relay has to hand
            // them over as they come, not once they are all in.
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            SSE_FRAMES.forEach((frame, at) => setTimeout(() => {
                if (at === 0) {
                    // Two writes, the first ending inside the "р".
                    const bytes = Buffer.from(frame)
                    const split = bytes.indexOf(Buffer.from('р')) + 1
                    res.write(bytes.subarray(0, split))
                    res.write(bytes.subarray(split))
                    return
                }
                res.write(frame)
            }, 150 * (at + 1)))
            return setTimeout(() => res.end(), 150 * SSE_FRAMES.length + 50)
        }
        if (req.url === '/api/sse-wide') {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const bytes = Buffer.from(WIDE, 'utf8')
            let at = 0
            const step = () => {
                if (at >= bytes.length) return res.end()
                res.write(bytes.subarray(at, at + 7))
                at += 7
                setTimeout(step, 15)
            }
            return setTimeout(step, 30)
        }
        if (req.url === '/api/sse-long') {
            // For as long as the client listens.
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const timer = setInterval(() => {
                longStream.sent++
                res.write(`data: {"n":${longStream.sent}}\n\n`)
            }, 100)
            return res.on('close', () => {
                clearInterval(timer)
                longStream.closedAt = Date.now()
            })
        }
        if (req.url === '/api/sse-stall') {
            // One frame, then silence for good: the client has to give up.
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            return res.write('data: {"choices":[]}\n\n')
        }
        res.writeHead(404)
        res.end()
    })
    return new Promise(resolve => other.listen(0, '127.0.0.2', () => server.listen(0, '127.0.0.1', () => resolve({
        server,
        other,
        origin: `http://127.0.0.1:${server.address().port}`,
        pageLoads: () => pageLoads,
        state,
        longStream,
        frame
    }))));
}

// Poll until the condition holds: a relay's chunks are timed by the stand-in.
async function until(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('condition not met in time')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

async function main() {
    const standIn = await startStandIn()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worker-smoke-'))
    const server = createServer({
        dataDir,
        token: 'secret',
        chatOrigin: standIn.origin,
        keepAliveMs: 200,
        // Forces the live path on /renew: the smoke wants a real reload.
        minCacheSeconds: 7200,
        // Short enough for a smoke, long enough to be seen: the second full
        // sign-in below has to wait for its slot.
        minLoginIntervalMs: 5000,
        egressMaxBytes: 4096
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const worker = `http://127.0.0.1:${port}`
    const call = async (route, payload, base = worker) => {
        const response = await fetch(base + route, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
            body: JSON.stringify(payload)
        })
        return { status: response.status, body: await response.json() }
    }
    const health = async () => (await fetch(`${worker}/health`)).json()

    const email = 'smoke@example.invalid'
    const profileDirOf = dir => path.join(dir,
        'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32))
    const profile = profileDirOf(dataDir)
    const egress = extra => call('/egress', {
        email, url: '/api/echo', method: 'POST',
        headers: {
            'content-type': 'application/json', authorization: 'Bearer app-token', 'x-request-id': 'smoke-1'
        },
        body: '{"hello":"world"}', timeoutMs: 30000, ...extra
    })
    // A streaming /egress (Qwen2API-3ue.3), read one event at a time.
    const relay = async extra => {
        const controller = new AbortController()
        const response = await fetch(`${worker}/egress`, {
            method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
            body: JSON.stringify({
                email, url: '/api/sse', method: 'POST', stream: true, body: '{"hello":"world"}',
                headers: { 'content-type': 'application/json', authorization: 'Bearer app-token' },
                timeoutMs: 5000, ...extra
            })
        })
        const reader = response.body.getReader()
        let pending = ''
        const next = async () => {
            for (;;) {
                const newline = pending.indexOf('\n')
                if (newline >= 0) {
                    const line = pending.slice(0, newline)
                    pending = pending.slice(newline + 1)
                    return line ? JSON.parse(line) : { type: 'eof' }
                }
                const { value, done } = await reader.read()
                if (done) return { type: 'eof' }
                pending += Buffer.from(value).toString('utf8')
            }
        }
        return { response, next, cancel: () => controller.abort() }
    }

    try {
        // No persisted profile: refused, and nothing is launched for it.
        const missing = await egress()
        assert.equal(missing.status, 404)
        assert.equal(missing.body.code, 'no_profile')
        assert.equal(standIn.pageLoads(), 0)
        fs.mkdirSync(profile)

        // First call: Chromium launches on the profile, loads the page, the
        // token settles, then the call leaves from inside that page.
        const started = Date.now()
        const first = await egress()
        assert.equal(first.status, 200, JSON.stringify(first.body))
        assert.equal(first.body.status, 200)
        const echo = JSON.parse(first.body.body)
        console.log(`ok lazy open + in-page fetch: ${Date.now() - started} ms, ${standIn.pageLoads()} page load(s)`)
        console.log(`   upstream saw User-Agent: ${echo.userAgent}`)
        // What the headless shell says about itself — and what the chrome mode
        // further down has to change, and only that.
        assert.match(echo.userAgent, /HeadlessChrome\/[\d.]+/)
        assert.match(echo.secChUa || '', /"HeadlessChrome"/)
        assert.match(echo.fullVersionList || '', /"HeadlessChrome"/)
        const shell = { userAgent: echo.userAgent, hints: echo.secChUa, platformVersion: echo.platformVersion }
        // The third-party frame on the page says the same of itself, in every way it can be seen.
        await until(() => standIn.frame.page)
        for (const seen of Object.values(standIn.frame)) assert.match(seen, /HeadlessChrome\//)

        assert.equal(echo.method, 'POST')
        assert.equal(echo.body, '{"hello":"world"}')
        assert.equal(echo.authorization, 'Bearer app-token')
        assert.equal(echo.requestId, 'smoke-1')
        // The point of the whole epic: the profile's own jar rides along.
        assert.match(echo.cookie || '', /(^|;\s*)standin=1/)
        assert.ok(first.body.cookies.some(cookie => cookie.name === 'standin'))
        assert.equal((await health()).residentPages, 1)
        console.log('ok credentials: upstream saw the profile cookie; the jar rides back with the answer')

        // Second call reuses the page: no reload.
        const loads = standIn.pageLoads()
        const again = await egress({ body: '{"again":true}' })
        assert.equal(again.status, 200)
        assert.equal(JSON.parse(again.body.body).body, '{"again":true}')
        assert.equal(standIn.pageLoads(), loads)
        console.log('ok reuse: second call answered without reloading the page')

        // The call is one of the page's own requests (Qwen2API-3ue.5): the
        // browser's jar and the app's headers, with what the page's own
        // requests carry besides — signed by the page's hook as its own are.
        // This is the shape qwen.ai answered with JSON on 24.11, where a fetch
        // with nothing but content-type got a challenge page.
        assert.equal(again.body.challenge, undefined)
        const shaped = JSON.parse(again.body.body)
        assert.equal(shaped.method, 'POST')
        assert.equal(shaped.authorization, 'Bearer app-token')
        assert.equal(shaped.accept, 'application/json, text/plain, */*')
        assert.equal(shaped.source, 'web')
        // The page's clock, in the front end's format ('Tue Nov 24 2026 14:19:55 GMT+0000'),
        // in the page's own zone. (Not the very second: the call and this check may straddle one.)
        assert.match(shaped.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
        const zone = (() => {
            const minutes = -new Date().getTimezoneOffset()
            const pad = value => String(value).padStart(2, '0')
            return `GMT${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`
        })()
        assert.ok(shaped.timezone.endsWith(zone), `${shaped.timezone} is not in the page's own zone (${zone})`)
        // The front end's version, off the address of the script the page loaded.
        assert.equal(shaped.version, '0.3.50')
        // The page's language in Chrome's own form for it. Set by the call: in
        // this very browser a request left to itself says only 'en-US' (as the
        // worker's call did on prod on 24.11), where the page's own requests
        // say this.
        assert.equal(shaped.acceptLanguage, 'en-US,en;q=0.9')
        // The caller's own request id is sent, as given.
        assert.equal(shaped.requestId, 'smoke-1')
        assert.equal(shaped.signed, '2.5.37')
        console.log('ok page request: an XMLHttpRequest with the page\'s headers (the language as the page\'s own requests say it), signed by the page\'s hook')

        // A WAF challenge page (Qwen2API-3ue.6): qwen.ai's answer, status 200
        // and a page. The page's hook holds it back from a request's onload
        // and onloadend; the call listens the other way and has it at once —
        // not 35 s later, as a page that "stopped responding".
        const challengedAt = Date.now()
        const challenged = await egress({ url: '/api/challenged', body: undefined, timeoutMs: 30000 })
        assert.equal(challenged.status, 200, JSON.stringify(challenged.body))
        const verdict = challenged.body
        assert.equal(verdict.status, 200)
        assert.equal(verdict.headers['content-type'], 'text/html; charset=utf-8')
        assert.equal(verdict.body, CHALLENGE_PAGE)
        assert.equal(verdict.challenge, 'page')
        assert.ok(Date.now() - challengedAt < 5000, `the challenge was recognised after ${Date.now() - challengedAt} ms`)
        assert.equal((await health()).residentPages, 1, 'a challenge closed the page')
        console.log(`ok challenge: the page the hooks held from onload reached the call anyway (${Date.now() - challengedAt} ms); the page stayed`)

        // The same answer with the hooks hiding it from listeners too — more
        // than the real page's are known to do: the worker reads it off the
        // page's network, which no script in the page can hold back.
        standIn.state.holdListeners = true
        assert.equal((await call('/renew', { email })).status, 200)
        const keptAt = Date.now()
        const kept = await egress({ url: '/api/challenged', body: undefined, timeoutMs: 30000 })
        assert.equal(kept.status, 200)
        const readOff = kept.body
        assert.equal(readOff.body, CHALLENGE_PAGE)
        assert.equal(readOff.challenge, 'network')
        assert.ok(Date.now() - keptAt < 5000, `the kept challenge was read off after ${Date.now() - keptAt} ms`)
        assert.equal((await health()).residentPages, 1, 'a kept challenge closed the page')
        // Relayed as a stream too: whole, the head and then the page.
        const keptStream = await relay({ url: '/api/challenged', body: undefined, timeoutMs: 30000 })
        const keptEvents = []
        for (;;) {
            const event = await keptStream.next()
            if (event.type === 'end' || event.type === 'eof') break
            keptEvents.push(event)
        }
        assert.deepEqual(keptEvents.map(event => event.type), ['head', 'chunk'])
        assert.equal(Buffer.from(keptEvents[1].data, 'base64').toString('utf8'), CHALLENGE_PAGE)
        // ...and the page answers the next call itself, once the answer is an ordinary one.
        assert.equal((await egress({ body: '{"after":true}' })).status, 200)
        assert.equal(JSON.parse((await egress()).body.body).body, '{"hello":"world"}')
        standIn.state.holdListeners = false
        assert.equal((await call('/renew', { email })).status, 200)
        console.log(`ok kept challenge: read off the page's network (${Date.now() - keptAt} ms), relayed whole as a stream; the page stayed`)

        // The in-page abort timer.
        const slow = await egress({ url: '/api/slow', method: 'GET', body: undefined, timeoutMs: 500 })
        assert.equal(slow.status, 504)
        assert.equal(slow.body.code, 'egress_timeout')
        assert.equal((await health()).residentPages, 1)
        console.log('ok timeout: a stalled upstream is aborted inside the page')

        // The size cap, read while streaming.
        const big = await egress({ url: '/api/big', method: 'GET', body: undefined })
        assert.equal(big.status, 502)
        assert.equal(big.body.code, 'egress_too_large')
        console.log('ok size cap: an oversized upstream body is cut off')

        // Another origin is refused before any page is touched: here, the worker itself.
        const refused = await egress({ url: `${worker}/health`, method: 'GET', body: undefined })
        assert.equal(refused.status, 400)
        assert.equal(refused.body.code, 'invalid_request')
        console.log('ok allowlist: an off-origin target is refused')

        // A streaming answer is relayed one event at a time, as it comes
        // (Qwen2API-3ue.3): the head, then every chunk, then the end with the jar.
        const streamStarted = Date.now()
        const sse = await relay()
        assert.equal(sse.response.status, 200, 'the relay must start with an ordinary 200')
        assert.match(sse.response.headers.get('content-type') || '', /ndjson/)
        const head = await sse.next()
        assert.equal(head.type, 'head', JSON.stringify(head))
        assert.equal(head.status, 200)
        assert.equal(head.headers['content-type'], 'text/event-stream')
        assert.ok(head.cookies.some(cookie => cookie.name === 'standin'))
        let body = ''
        const chunkAt = []
        for (;;) {
            const event = await sse.next()
            if (event.type === 'end') {
                assert.ok(event.cookies.some(cookie => cookie.name === 'standin'))
                break
            }
            assert.equal(event.type, 'chunk', JSON.stringify(event))
            body += Buffer.from(event.data, 'base64').toString('utf8')
            chunkAt.push(Date.now())
        }
        assert.equal(body, SSE_FRAMES.join(''), 'a frame cut inside a two-byte character must come back whole')
        assert.ok(chunkAt.at(-1) - chunkAt[0] >= 250, 'the chunks arrived together, not as they came')
        console.log(`ok stream: head, ${chunkAt.length} chunk(s) and the end relayed as they came (${Date.now() - streamStarted} ms)`)

        // Silence ends a stream: one chunk, then nothing. The page's own
        // timer cuts it, as it does for a whole-answer call.
        const stallStarted = Date.now()
        const stalled = await relay({ url: '/api/sse-stall', timeoutMs: 500 })
        assert.equal((await stalled.next()).type, 'head')
        assert.equal((await stalled.next()).type, 'chunk')
        const cut = await stalled.next()
        assert.equal(cut.type, 'error', JSON.stringify(cut))
        assert.equal(cut.code, 'egress_timeout')
        assert.ok(Date.now() - stallStarted >= 450, 'the stream was cut before its silence ran out')
        assert.equal((await stalled.next()).type, 'eof')
        assert.equal((await health()).residentPages, 1)
        console.log(`ok stream timeout: a stream that went silent was cut inside the page (${Date.now() - stallStarted} ms)`)

        // The app cancelling: it closes its connection, and the fetch inside
        // the page is aborted — the stand-in sees its client go.
        standIn.longStream.sent = 0
        standIn.longStream.closedAt = 0
        const long = await relay({ url: '/api/sse-long' })
        assert.equal((await long.next()).type, 'head')
        await long.next()
        assert.ok(standIn.longStream.sent >= 1)
        const cancelledAt = Date.now()
        long.cancel()
        await until(() => standIn.longStream.closedAt > 0)
        assert.ok(standIn.longStream.closedAt - cancelledAt < 2000, 'the in-page fetch outlived its relay')
        // ... and the page is none the worse.
        assert.equal((await health()).residentPages, 1)
        assert.equal((await egress({ body: '{"after":true}' })).status, 200)
        console.log(`ok cancel: closing the relay aborted the in-page fetch (${standIn.longStream.closedAt - cancelledAt} ms); the page stayed`)

        // Every kind of multi-byte character, cut by the network where it
        // may: the bytes come back as they were sent.
        const wide = await relay({ url: '/api/sse-wide', timeoutMs: 5000 })
        assert.equal((await wide.next()).type, 'head')
        const wideBytes = []
        for (;;) {
            const event = await wide.next()
            if (event.type === 'end') break
            assert.equal(event.type, 'chunk', JSON.stringify(event))
            wideBytes.push(Buffer.from(event.data, 'base64'))
        }
        assert.equal(Buffer.concat(wideBytes).toString('utf8'), WIDE)
        // How many pieces the browser reports is its own (it merges ones that
        // come close together); that they are several, each ending wherever
        // the network cut, is what the relay has to carry.
        assert.ok(wideBytes.length >= 6, `the pieces came as they arrived (${wideBytes.length})`)
        assert.ok(wideBytes.slice(0, -1).some(piece => (piece[piece.length - 1] & 0xc0) === 0x80),
            'no piece ended inside a multi-byte character')
        console.log(`ok stream, wide characters: ${wideBytes.length} pieces of 7 bytes, two-, three- and four-byte characters whole`)

        // A stream does not pin the page: a live renewal reloads it without
        // waiting, and the stream ends.
        const during = await relay({ url: '/api/sse-long' })
        assert.equal((await during.next()).type, 'head')
        await during.next()
        const loadsBefore = standIn.pageLoads()
        const renewStarted = Date.now()
        const whileStreaming = await call('/renew', { email })
        assert.equal(whileStreaming.status, 200, JSON.stringify(whileStreaming.body))
        assert.equal(standIn.pageLoads(), loadsBefore + 1)
        assert.ok(Date.now() - renewStarted < 4500, 'the renewal waited for the stream')
        const ended = await during.next()
        assert.equal(ended.type, 'error', JSON.stringify(ended))
        // The document left from under the fetch: what /egress always
        // called a page that merely navigated.
        assert.equal(ended.code, 'browser_error')
        assert.equal((await health()).residentPages, 1)
        console.log(`ok stream vs renewal: the renewal did not wait for the stream (${Date.now() - renewStarted} ms); the stream ended as browser_error`)

        // A live renewal on the account reloads the resident page. A second
        // launch on the same profile would hit Chromium's profile lock and
        // fail right here.
        const beforeRenewal = standIn.pageLoads()
        const renewed = await call('/renew', { email })
        assert.equal(renewed.status, 200, JSON.stringify(renewed.body))
        assert.equal(standIn.pageLoads(), beforeRenewal + 1)
        assert.equal((await health()).residentPages, 1)
        console.log('ok renewal: the live /renew reloaded the resident page (no second launch on the profile)')

        // Full sign-ins are deduplicated and paced (Qwen2API-43a). With the
        // resident page up, a sign-in runs on that very page.
        const signIn = extra => call('/session', { email, password: 'pw', ...extra })
        const beforeSignIn = standIn.pageLoads()
        const signedIn = await signIn({ force: true })
        assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body))
        assert.equal(standIn.pageLoads(), beforeSignIn + 1)
        assert.equal((await health()).residentPages, 1)
        console.log('ok sign-in: the full sign-in ran on the resident page (no second launch on the profile)')

        // That session is live: the next /session is answered from it, and
        // no page is loaded for it.
        const cached = await signIn()
        assert.equal(cached.status, 200)
        assert.equal(cached.body.token, signedIn.body.token)
        assert.equal(standIn.pageLoads(), beforeSignIn + 1)
        console.log('ok dedup: /session answered from the live session without loading a page')

        // A sign-in that does run takes its slot: not before the pacing gap.
        const slotAsked = Date.now()
        const spaced = await signIn({ force: true })
        assert.equal(spaced.status, 200, JSON.stringify(spaced.body))
        assert.notEqual(spaced.body.token, signedIn.body.token)
        assert.equal(standIn.pageLoads(), beforeSignIn + 2)
        assert.ok(Date.now() - slotAsked >= 5000, 'the second sign-in ran before its slot')
        console.log(`ok pacing: the next full sign-in waited for its slot (${Date.now() - slotAsked} ms in total)`)

        // The page was reloaded and signed in on since its channel was
        // exposed: a stream still runs on it.
        const afterNavigations = await relay()
        assert.equal((await afterNavigations.next()).type, 'head')
        assert.equal((await afterNavigations.next()).type, 'chunk')
        console.log('ok stream after navigation: the channel survived the reloads')

        // A clean stop closes the browser, which flushes the profile.
        await server.workerShutdown()
        assert.equal((await health()).residentPages, 0)
        const stores = ['Default/Network/Cookies', 'Default/Cookies'].map(file => path.join(profile, file))
        assert.ok(stores.some(file => fs.existsSync(file)), 'Chromium must flush its cookie store on close')
        console.log('ok shutdown: the browser closed cleanly and flushed the profile to disk')

        // An explicit invalidation (Qwen2API-3ue.2) on a worker whose cache is
        // FRESH: a plain /renew answers from the cache, force reloads the page.
        // The smoke's own worker above keeps its cache permanently stale, so
        // this runs on a second one with the default freshness window.
        const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worker-smoke-force-'))
        const fresh = createServer({ dataDir: freshDir, token: 'secret', chatOrigin: standIn.origin, keepAliveMs: 200 })
        await new Promise(resolve => fresh.listen(0, '127.0.0.1', resolve))
        const freshUrl = `http://127.0.0.1:${fresh.address().port}`
        const onFresh = (route, payload) => call(route, payload, freshUrl)
        try {
            fs.mkdirSync(profileDirOf(freshDir))
            assert.equal((await onFresh('/egress', { email, url: '/api/echo', method: 'GET', timeoutMs: 30000 })).status, 200)
            const loads = standIn.pageLoads()
            const plain = await onFresh('/renew', { email })
            assert.equal(plain.status, 200, JSON.stringify(plain.body))
            assert.equal(standIn.pageLoads(), loads, 'a fresh cache answers without a reload')
            const forced = await Promise.all([1, 2, 3].map(() => onFresh('/renew', { email, force: true })))
            assert.deepEqual(forced.map(answer => answer.status), [200, 200, 200])
            assert.equal(new Set(forced.map(answer => answer.body.token)).size, 1)
            assert.equal(standIn.pageLoads(), loads + 1, 'three forced renewals, one reload')
            console.log('ok forced renewal: /renew {force} reloads despite a fresh cache; a burst shares one reload')
        } finally {
            await fresh.workerShutdown()
            await new Promise(resolve => fresh.close(resolve))
            fs.rmSync(freshDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        }

        // The headless mode `chrome` (Qwen2API-3ue.4, lib/browser-identity.js):
        // the full Chromium, presenting as a browser with a window. On the
        // profile the shell wrote at the start of this run — what it started,
        // the full Chromium must resume — and on a worker that has not been
        // told anything else. The stand-in shows what reached it.
        const presented = createServer({
            dataDir, token: 'secret', chatOrigin: standIn.origin, headlessMode: 'chrome', keepAliveMs: 200
        })
        await new Promise(resolve => presented.listen(0, '127.0.0.1', resolve))
        const presentedUrl = `http://127.0.0.1:${presented.address().port}`
        const onPresented = (route, payload) => call(route, payload, presentedUrl)
        try {
            // The first call pays for asking the browser its name, the browser and the page load.
            const chromeStarted = Date.now()
            Object.assign(standIn.frame, { document: null, request: null, page: null })
            const asChrome = await onPresented('/egress', {
                email, url: '/api/echo', method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 30000
            })
            assert.equal(asChrome.status, 200, JSON.stringify(asChrome.body))
            const seen = JSON.parse(asChrome.body.body)
            // That call brought no request id: the worker gave it one, by which
            // it knows qwen.ai's answer to it whoever else asks in the page.
            assert.match(seen.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
            // That call brought no Bearer: it went on the page's own session.
            assert.match(seen.authorization, /^Bearer eyJ/)
            assert.equal(seen.version, '0.3.50')
            assert.equal(seen.acceptLanguage, 'en-US,en;q=0.9')
            // The page loaded for this browser: the frame on it reported afresh.
            await until(() => standIn.frame.page)
            const state = await (await fetch(`${presentedUrl}/health`)).json()
            assert.equal(state.headlessMode, 'chrome')
            assert.equal(state.residentPages, 1)
            console.log(`ok chrome mode: resident page up in ${Date.now() - chromeStarted} ms; health says ${JSON.stringify(
                { residentPages: state.residentPages, headless: state.headless, headlessMode: state.headlessMode })}`)
            console.log(`   upstream saw User-Agent: ${seen.userAgent}`)
            console.log(`   upstream saw sec-ch-ua: ${seen.secChUa}`)

            // The profile the shell wrote is the one this browser resumed.
            assert.match(seen.cookie || '', /(^|;\s*)standin=1/)
            // One word of the User-Agent changed: the same string, as the full
            // Chromium reports it (the version reduced), with "Headless" gone.
            const major = /HeadlessChrome\/(\d+)/.exec(shell.userAgent)?.[1]
            assert.ok(major, shell.userAgent)
            assert.equal(seen.userAgent,
                shell.userAgent.replace(/HeadlessChrome\/[\d.]+/, `Chrome/${major}.0.0.0`))
            assert.doesNotMatch(seen.userAgent, /headless/i)
            // ...and the hints keep the browser's own brands: the GREASE one is
            // the build's, not something an override could invent.
            assert.doesNotMatch(seen.secChUa || '', /headless/i)
            assert.match(seen.secChUa || '', new RegExp(`"Chromium";v="${major}"`))
            for (const [grease] of (shell.hints || '').matchAll(/"[^"]*B[Rr][Aa][Nn][Dd][^"]*";v="\d+"/g)) {
                assert.ok(seen.secChUa.includes(grease), `${seen.secChUa} does not carry ${grease}`)
            }
            assert.doesNotMatch(seen.fullVersionList || '', /headless/i)
            // platformVersion is the one hint the option fills in itself: empty,
            // which is what the browser says on Linux; elsewhere the browser says more.
            assert.equal(seen.platformVersion, process.platform === 'linux' ? shell.platformVersion : '"10.0"')
            // The third-party frame on the page — where a captcha lives — says
            // the same, in its document request, in the calls it makes and to its own scripts.
            for (const [what, value] of Object.entries(standIn.frame)) {
                assert.doesNotMatch(value || '', /headless/i, `the frame's ${what}`)
            }
            assert.match(standIn.frame.request, /Chrome\/[\d.]+/)
            console.log(`   the third-party frame saw User-Agent: ${standIn.frame.page}`)

            // A reload (a live renewal) is a navigation: the identity must survive it.
            const reloaded = await onPresented('/renew', { email, force: true })
            assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body))
            const afterReload = await onPresented('/egress', {
                email, url: '/api/echo', method: 'POST', headers: { 'content-type': 'application/json' }
            })
            assert.equal(afterReload.status, 200, JSON.stringify(afterReload.body))
            assert.equal(JSON.parse(afterReload.body.body).userAgent, seen.userAgent)
            console.log('ok chrome mode: the profile the shell wrote is resumed, "Headless" is gone from the User-Agent' +
                ' and from the hints, the hints keep the browser\'s own brands, the third-party frame says the same,' +
                ' and a reload keeps it so')
        } finally {
            await presented.workerShutdown()
            await new Promise(resolve => presented.close(resolve))
        }

        console.log('SMOKE OK — real worker, real Chromium, stand-in origin; qwen.ai was not contacted')
    } finally {
        await server.workerShutdown()
        await Promise.all([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => standIn.server.close(resolve)),
            new Promise(resolve => standIn.other.close(resolve))
        ])
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
}

main().catch(error => {
    console.error(error.stack || error)
    process.exit(1)
})
