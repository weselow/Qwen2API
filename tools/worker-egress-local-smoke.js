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
 * A completions the stand-in answers as qwen.ai did on 2026-11-25
 * (Qwen2API-3ue.9): made as an XMLHttpRequest, with a challenge page; made as
 * a fetch with the page's headers, with SSE. The worker's stream is that
 * fetch — made the old way, it gets the challenge here.
 *
 * Since Qwen2API-xun, Qwen2API-nch and Qwen2API-ops (2026-11-26): a page's
 * token nearly spent is renewed in place by the front end's own refresh call —
 * a cross-origin XMLHttpRequest from the page to the auth host, which the
 * stand-in plays from ANOTHER loopback address (127.0.0.2), with the browser's
 * preflight and its rule about credentials, as on chat.qwen.ai → auth.qwen.ai;
 * a renewal waits for the streams on its page, up to its limit; the page loads
 * of two accounts take turns. (Not what qwen.ai makes of that call: it is
 * never asked.)
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

/* global XMLHttpRequest, window */

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
 *   (Qwen2API-3ue.6) is exercised with it. And do to a fetch what the real
 *   hooks are known to do (Qwen2API-3ue.9)
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
        // What tells the stand-in this went out as an XMLHttpRequest. How the
        // real server tells one from a fetch is not known.
        this.setRequestHeader('x-stub-transport', 'xhr')
        // Whether the session's cookies were asked for: what the front end's
        // refresh asks on a request to another origin (Qwen2API-xun).
        this.setRequestHeader('x-stub-credentials', String(this.withCredentials))
        // An answer taken for a block is never told to these.
        for (const name of ['onload', 'onloadend']) {
            const own = this[name]
            if (!own) continue
            this[name] = function (event) { if (!blocked(this)) own.call(this, event) }
        }
        return send.apply(this, arguments)
    }
    // Every fetch is wrapped, to tell the stand-in — `x-stub-fetch-order` —
    // the order the page's script gave its headers in. The order on the wire
    // is not the script's to give: it is the browser's, and Chromium 159 does
    // not keep the script's against this stand-in.
    const realFetch = window.fetch
    window.fetch = function (resource, init) {
        const sent = { ...(init || {}) }
        sent.headers = { 'x-stub-fetch-order': Object.keys(sent.headers || {}).join(','), ...sent.headers }
        if (!strict) return realFetch.call(this, resource, sent)
        // What the real page's hooks are known to do to a fetch (2026-11-24):
        // an answer they take for a block is never handed to the caller — its
        // promise stays pending — and an abort through their wrapper changes
        // nothing: the request is not the caller's signal's. Only a page is
        // looked into for a block: any other answer is the caller's while its
        // body still arrives.
        delete sent.signal
        return realFetch.call(this, resource, sent).then(response => {
            if (!/text\/html/i.test(response.headers.get('content-type') || '')) return response
            return response.clone().text().then(text => (/aliyun_waf_/.test(text) ? new Promise(() => {}) : response))
        })
    }
    if (!strict) return
    const add = proto.addEventListener
    proto.addEventListener = function (type, listener, options) {
        return add.call(this, type, function (event) { if (!blocked(this)) listener.call(this, event) }, options)
    }
}

/**
 * What the stand-in answers an SSE route with, a frame at a time: with a pause
 * between, so that a relay has to hand them over as they come, not once they
 * are all in.
 */
function sseFrames(res) {
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

/**
 * The stand-in: a root page that settles a token the way the chat FE does,
 * and API routes that report what actually reached the server. The root page
 * carries a frame from another site — another loopback address, so it is
 * another site to the browser — because that is where a captcha lives, and
 * what that frame sees of itself is part of what the page presents.
 */
function startStandIn() {
    let pageLoads = 0
    // When each load of the root page was asked for: page loads take turns since Qwen2API-nch.
    const pageLoadTimes = []
    // What /api/sse-long saw when its client went away — which, for a relay,
    // is the fetch inside the page being aborted.
    const longStream = { sent: 0, closedAt: 0 }
    // What the third-party frame saw of itself, the last time it loaded.
    const frame = { document: null, request: null, page: null }
    // Whether the page loaded next hides blocked answers from listeners too,
    // and how many seconds the token it keeps has left.
    const state = { holdListeners: false, tokenSeconds: 3600 }
    // The last completions the stand-in was asked for: how it went out.
    const completions = { last: null }
    // The auth host for the front end's token refresh (Qwen2API-xun), which
    // the "other" site plays: another loopback address, so another site to the
    // browser — as auth.qwen.ai is to chat.qwen.ai. `refresh` is what it
    // answers the next refresh with; every refresh it was asked is written down.
    const auth = { refresh: 'ok', asked: [], preflights: 0, token: null }
    const other = http.createServer((req, res) => {
        if (req.url === '/frame' && req.method === 'GET') {
            frame.document = req.headers['user-agent'] || null
            // A cookie the session's refresh is known by, as auth.qwen.ai's must
            // be for a call made from chat.qwen.ai: one a request from another
            // site is allowed to carry.
            res.writeHead(200, {
                'content-type': 'text/html',
                'set-cookie': 'standin_auth=1; Path=/; SameSite=None; Secure'
            })
            return res.end(`<html><body>frame<script>fetch('/api/echo',{method:'POST',headers:{
                'content-type':'application/json'},body:JSON.stringify({userAgent:navigator.userAgent})})</script></body></html>`)
        }
        if (req.url === '/api/v2/auths/refresh') {
            // What the browser asks first of a request to another origin with
            // headers of its own: whether it may send them, and with the
            // session's cookies.
            if (req.method === 'OPTIONS') {
                auth.preflights++
                res.writeHead(204, {
                    'access-control-allow-origin': `http://127.0.0.1:${server.address().port}`,
                    'access-control-allow-credentials': 'true',
                    'access-control-allow-methods': 'GET',
                    'access-control-allow-headers': req.headers['access-control-request-headers'] || ''
                })
                return res.end()
            }
            auth.asked.push({ method: req.method, headers: req.headers, at: Date.now() })
            const allowed = {
                'access-control-allow-origin': `http://127.0.0.1:${server.address().port}`,
                'access-control-allow-credentials': 'true',
                'content-type': 'application/json'
            }
            // The page names itself in x-request-origin — the interceptor sets it on what goes to
            // /auths/* (main.js of 0.3.50–0.3.54). Without it the refresh is refused as qwen.ai
            // refused the worker's own on 2026-11-27: under a 200, with the code Bad_Request.
            // `auth.refresh = 'bad_request'` gets the same answer for a request that does name
            // the page, to see the worker say the refusal.
            const pageOrigin = `http://127.0.0.1:${server.address().port}`
            if (req.headers['x-request-origin'] !== pageOrigin || auth.refresh === 'bad_request') {
                res.writeHead(200, allowed)
                return res.end(JSON.stringify({ success: false, code: 'Bad_Request' }))
            }
            // qwen.ai refusing the session: as the front end is refused, under 401.
            if (auth.refresh === 'refused') {
                res.writeHead(401, allowed)
                return res.end(JSON.stringify({ success: false, data: { code: 'unauthorized', details: 'stub refusal' } }))
            }
            auth.token = tokenExpiringIn(900)
            res.writeHead(200, allowed)
            return res.end(JSON.stringify({ success: true, data: { access_token: auth.token, expires_at: Math.floor(Date.now() / 1000) + 900 } }))
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
            pageLoadTimes.push(Date.now())
            // How the front end keeps a token once its refresh wrote it (main.js of 0.3.50, IC):
            // the state it reads first, and the two keys it falls back on. `state.tokenSeconds`
            // is how long the page's token has left: the default is an hour; a test makes it less.
            const expiresAt = Date.now() + state.tokenSeconds * 1000
            const token = tokenExpiringIn(state.tokenSeconds)
            const kept = `localStorage.setItem('token', '${token}');localStorage.setItem('at_expire_time', '${expiresAt}');` +
                `localStorage.setItem('qwen_access_token_state', JSON.stringify({version:1,stateId:'stand-in',token:'${token}',expiresAt:${expiresAt},updatedAt:0,sourceId:'page'}))`
            // What the page keeps now: a call that brings no Bearer goes out on it.
            state.pageToken = token
            res.writeHead(200, {
                'content-type': 'text/html', 'set-cookie': 'standin=1; Path=/',
                // So that the calls the page makes carry the hints a guard can ask for.
                'accept-ch': 'Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List'
            })
            return res.end(`<html><body>stand-in<iframe src="http://127.0.0.2:${
                other.address().port}/frame" style="width:0;height:0;border:0"></iframe><script>${kept}</script></body></html>`.replace(
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
            pageLoadTimes.push(Date.now())
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
        if (req.url.startsWith('/api/v2/chat/completions')) {
            // What qwen.ai did with a completions from the page on 2026-11-25
            // (Qwen2API-3ue.9), as the stand-in's rule for one: made as an
            // XMLHttpRequest, it is answered with a challenge page; made as a
            // fetch with the page's headers — x-accel-buffering: no among them
            // — with SSE. How the real server told the two apart is not known:
            // the rule stands for "not in the form that passed".
            let body = ''
            req.on('data', chunk => { body += chunk })
            return req.on('end', () => {
                const byXhr = req.headers['x-stub-transport'] === 'xhr'
                const asThePage = req.headers['x-accel-buffering'] === 'no'
                completions.last = {
                    byXhr, asThePage, body, headers: req.headers,
                    // What went over the wire, by name, in its order — the
                    // browser's, not the page's script's.
                    order: req.rawHeaders.filter((_, at) => at % 2 === 0).map(name => name.toLowerCase()),
                    // The order the page's script gave the fetch its headers in (the page's hook reports it).
                    given: String(req.headers['x-stub-fetch-order'] || '').split(',').filter(Boolean)
                }
                if (byXhr || !asThePage) {
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                    return res.end(CHALLENGE_PAGE)
                }
                return sseFrames(res)
            })
        }
        if (req.url === '/api/sse') return sseFrames(res)
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
        pageLoadTimes,
        state,
        completions,
        longStream,
        frame,
        auth
    }))))
}

// What the worker logs while `fn` runs — as it runs.
async function logged(fn) {
  const lines = []
  const real = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    return await fn(lines)
  } finally {
    console.log = real
  }
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
        egressMaxBytes: 4096,
        // The queue that keeps the page loads of every account apart, and the
        // turns of the pages' token refreshes, are off here: both are measured
        // in tests, and the queue once more below, with two accounts
        // (Qwen2API-nch, Qwen2API-ops). The auth host a page renews its token
        // on is the stand-in's other site (Qwen2API-xun).
        loadMinIntervalMs: 1,
        tokenRefreshMinIntervalMs: 1,
        authOrigin: `http://127.0.0.2:${standIn.other.address().port}`
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
    const relay = async (extra, base = worker) => {
        const controller = new AbortController()
        const response = await fetch(`${base}/egress`, {
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
    // Everything a relay says up to its end.
    const drain = async opened => {
      const events = []
      for (;;) {
        const event = await opened.next()
        if (event.type === 'end' || event.type === 'eof') return events
        events.push(event)
      }
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
        // Relayed as a stream too: whole, the head and then the page. A stream
        // is a fetch since Qwen2API-3ue.9, and the hook keeps that promise
        // pending, as the real one is known to: it is the worker's reading of
        // the page's network that relays the page — in about the grace the
        // worker gives the page, not after the call's own timer (30 s here)
        // or the backstop.
        const keptStream = await logged(async lines => {
            const since = Date.now()
            const events = await drain(await relay({ url: '/api/challenged', body: undefined, timeoutMs: 30000 }))
            return { events, took: Date.now() - since, said: lines }
        })
        assert.deepEqual(keptStream.events.map(event => event.type), ['head', 'chunk'])
        assert.equal(Buffer.from(keptStream.events[1].data, 'base64').toString('utf8'), CHALLENGE_PAGE)
        assert.ok(keptStream.said.some(line =>
            /egress-stream \/api\/challenged end \(\d+ ms\) — WAF challenge page, kept from the call by the page$/.test(line)),
        keptStream.said.join('\n'))
        assert.ok(keptStream.took < 5000, `the stream waited ${keptStream.took} ms on a fetch the hook keeps pending`)
        console.log(`ok kept challenge as a stream: relayed by the worker off the page's network (${keptStream.took} ms) while the hook kept the fetch pending`)
        // That fetch is pending still: the page is none the worse, and its
        // next stream is its own.
        const afterKept = await drain(await relay())
        assert.deepEqual(afterKept.map(event => event.type), ['head', 'chunk', 'chunk', 'chunk'])
        console.log('ok after a kept challenge: the next stream ran on the page as if nothing was held')
        // ...and the page answers the next call itself, once the answer is an ordinary one.
        assert.equal((await egress({ body: '{"after":true}' })).status, 200)
        assert.equal(JSON.parse((await egress()).body.body).body, '{"hello":"world"}')
        standIn.state.holdListeners = false
        assert.equal((await call('/renew', { email })).status, 200)
        console.log(`ok kept challenge: read off the page's network (${Date.now() - keptAt} ms); the page stayed`)

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

        // The call this change is for (Qwen2API-3ue.9): a completions, as the
        // app makes it — content-type, x-request-id and accept: application/json,
        // and no authorization (Qwen2API-jr9: the Bearer is the page's). qwen.ai
        // refused it as an XMLHttpRequest (prod, 25.11) and passed it as a fetch
        // with the page's headers; the stand-in answers likewise. What the app
        // gets has to be qwen.ai's answer, and not the challenge.
        const completionsStarted = Date.now()
        const completions = await relay({
            url: '/api/v2/chat/completions?chat_id=smoke', body: '{"stream":true}',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'x-request-id': 'smoke-completions-1' }
        })
        assert.equal(completions.response.status, 200, 'the relay must start with an ordinary 200')
        const completionsHead = await completions.next()
        assert.equal(completionsHead.type, 'head', JSON.stringify(completionsHead))
        // The old way, an XMLHttpRequest, is answered with the challenge page:
        // a head with text/html, then the page as one piece.
        assert.equal(completionsHead.headers['content-type'], 'text/event-stream', 'the stream was answered with a challenge page')
        const completionsEvents = await drain(completions)
        assert.deepEqual(completionsEvents.map(event => event.type), ['chunk', 'chunk', 'chunk'])
        assert.equal(completionsEvents.map(event => Buffer.from(event.data, 'base64').toString('utf8')).join(''), SSE_FRAMES.join(''))
        // How it went out: a fetch — not through the page's hook for XHRs,
        // which marks and signs theirs.
        const sent = standIn.completions.last
        assert.equal(sent.byXhr, false, 'the stream went out as an XMLHttpRequest')
        assert.equal(sent.headers['x-stub-v'], undefined)
        assert.equal(sent.body, '{"stream":true}')
        // Of what the call carries, the call gave fetch() the headers of the
        // call that passed, in its order (prod, 25.11)...
        const carried = ['accept', 'accept-language', 'content-type', 'authorization', 'source', 'timezone', 'version',
            'x-accel-buffering', 'bx-v', 'x-request-id']
        assert.deepEqual(sent.given.filter(name => carried.includes(name)), carried, sent.given.join(', '))
        // ...and they went over the wire, with what it reads off the page and
        // what the caller brought of its own.
        assert.equal(sent.headers.accept, 'application/json')
        assert.equal(sent.headers['accept-language'], 'en-US,en;q=0.9')
        assert.equal(sent.headers['content-type'], 'application/json')
        assert.equal(sent.headers.source, 'web')
        assert.match(sent.headers.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
        assert.equal(sent.headers.version, '0.3.50')
        assert.equal(sent.headers['x-accel-buffering'], 'no')
        assert.equal(sent.headers['bx-v'], '2.5.36')
        assert.equal(sent.headers['x-request-id'], 'smoke-completions-1')
        // The Bearer is the page's own token and the profile's jar rides along:
        // the call brought neither.
        assert.match(sent.headers.authorization, /^Bearer eyJ/)
        assert.match(sent.headers.cookie || '', /(^|;\s*)standin=1/)
        console.log(`ok completions: out of the page as a fetch with the page's headers, in the page's order;` +
            ` the relay carried qwen.ai's answer (${Date.now() - completionsStarted} ms)`)
        // The order on the wire is the browser's own, and not the call's: the
        // call's holds up to fetch(). (The same browser sends the headers of an
        // XMLHttpRequest in the same order of its own.)
        console.log(`   on the wire, what the call carries went in the browser's order:` +
            ` ${sent.order.filter(name => carried.includes(name)).join(', ')}`)

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

        // Since Qwen2API-nch a renewal waits for the streams on its page: the
        // answer reaches the app whole, and the page is reloaded after it.
        // (Before, the reload went through the stream, and the app's client
        // got an error frame for an answer it had begun to read.) Measured
        // without a network on 2026-11-26: NOTES Qwen2API-nch.
        const loadsBeforeTheWait = standIn.pageLoads()
        const during = await relay()
        assert.equal((await during.next()).type, 'head')
        const renewStarted = Date.now()
        const whileStreaming = await logged(async lines => ({
            lines, answer: await call('/renew', { email })
        }))
        assert.equal(whileStreaming.answer.status, 200, JSON.stringify(whileStreaming.answer.body))
        // Three frames and the end, not an error: the stream was over before the page was reloaded.
        // (drain() stops at the end without keeping it: what is read here is everything, the end included.)
        const rest = []
        for (;;) {
            const event = await during.next()
            rest.push(event)
            if (event.type === 'end' || event.type === 'eof') break
        }
        assert.deepEqual(rest.map(event => event.type), ['chunk', 'chunk', 'chunk', 'end'],
            `${whileStreaming.lines.join('\n')}\n${JSON.stringify(rest.map(event => ({ ...event, data: undefined, cookies: undefined })))}`)
        assert.ok(standIn.pageLoads() >= loadsBeforeTheWait + 1, 'the renewal did not reload the page')
        assert.ok(whileStreaming.lines.some(line => /resident-wait ended \(waited \d+ ms for the page's streams\)$/.test(line)),
            whileStreaming.lines.join('\n'))
        assert.equal((await health()).residentPages, 1)
        console.log(`ok stream vs renewal: the renewal waited for the stream (${Date.now() - renewStarted} ms), the answer reached the app whole, the page was reloaded after it`)

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

        // Since Qwen2API-xun a page's token that is nearly spent is renewed in
        // place, by the front end's own call from the page to the auth host:
        // no page is reloaded, and the call goes out on the renewed token. The
        // page is given a token with a minute of it left — as one is after
        // fourteen minutes without a renewal — and then called. (What qwen.ai
        // makes of that call is not asked here: the stand-in answers it.)
        standIn.state.tokenSeconds = 60
        assert.equal((await call('/renew', { email, force: true })).status, 200)
        const loadsBeforeTheRenewal = standIn.pageLoads()
        const { answer: onRenewedToken, lines: tokenLines } = await logged(async lines => ({
            lines, answer: await egress({ headers: { 'content-type': 'application/json' } })
        }))
        assert.equal(onRenewedToken.status, 200, JSON.stringify(onRenewedToken.body))
        assert.equal(standIn.auth.asked.length, 1, 'the page did not make exactly one refresh call')
        assert.equal(standIn.pageLoads(), loadsBeforeTheRenewal, 'a page was loaded to renew a token')
        // What reached the auth host from a real Chromium: the browser asked
        // first whether it might send these headers, and with the session's
        // cookies — the preflight a request to another origin gets...
        assert.equal(standIn.auth.preflights, 1)
        const refresh = standIn.auth.asked[0]
        assert.equal(refresh.method, 'GET')
        assert.equal(refresh.headers['x-stub-transport'], 'xhr', 'the front end makes the refresh as an XMLHttpRequest')
        assert.equal(refresh.headers['x-stub-credentials'], 'true', 'the session’s cookies were not asked for')
        // ...and the page's request hook signed it as one of the page's own.
        assert.equal(refresh.headers['x-stub-v'], '2.5.37')
        // No Bearer — the front end's interceptor sets none for /auths/refresh —
        // and no Content-Type, which axios drops from a request without a body.
        // The page names itself in x-request-origin: the interceptor sets it on
        // what goes to /auths/* (and three other auth paths), on nothing else
        // (main.js of 0.3.50–0.3.54).
        for (const name of ['authorization', 'content-type']) {
            assert.equal(refresh.headers[name], undefined, `${name} was sent`)
        }
        assert.equal(refresh.headers['x-request-origin'], standIn.origin, tokenLines.join('\n'))
        assert.equal(refresh.headers.accept, 'application/json')
        assert.equal(refresh.headers['accept-language'], 'en-US,en;q=0.9')
        assert.equal(refresh.headers.source, 'web')
        assert.equal(refresh.headers.version, '0.3.50')
        assert.match(refresh.headers.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
        assert.match(refresh.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.equal(refresh.headers.origin, standIn.origin)
        // The session's cookies of that origin went along — the cookie was
        // made for it (SameSite=None, as a session of the auth host has to be
        // for a call from the chat's pages): withCredentials asked for them.
        assert.match(refresh.headers.cookie || '', /(^|;\s*)standin_auth=1/,
            'the session’s cookies of the auth origin did not go along with the refresh')
        // The page keeps what it was answered, as the front end writes a token: the call after it carries the renewed one.
        assert.ok(standIn.auth.token.startsWith('eyJ'))
        assert.equal(JSON.parse(onRenewedToken.body.body).authorization, `Bearer ${standIn.auth.token}`)
        assert.notEqual(standIn.auth.token, standIn.state.pageToken)
        assert.ok(tokenLines.some(line => /token-refresh ok \(\d+ ms, 15 min left\)$/.test(line)), tokenLines.join('\n'))
        console.log(`ok page token: renewed in place by the front end's own call to another origin — the browser's preflight answered, ` +
            `the session’s cookies of that origin went along, the page's hook signed it; the call went out on the renewed token, no page loaded`)

        // A refresh that is refused costs the call its time and nothing else:
        // the call goes out on the token the page had, and the app's recovery
        // is what answers a refusal of it — as before.
        standIn.state.tokenSeconds = 60
        assert.equal((await call('/renew', { email, force: true })).status, 200)
        standIn.auth.refresh = 'refused'
        const { answer: unrenewed, lines: unrenewedLines } = await logged(async lines => ({
            lines, answer: await egress({ headers: { 'content-type': 'application/json' } })
        }))
        assert.equal(unrenewed.status, 200, JSON.stringify(unrenewed.body))
        assert.equal(standIn.auth.asked.length, 2)
        assert.equal(JSON.parse(unrenewed.body.body).authorization, `Bearer ${standIn.state.pageToken}`)
        assert.ok(unrenewedLines.some(line => /token-refresh failed \(refused, status 401, code unauthorized, \d+ ms\)$/.test(line)), unrenewedLines.join('\n'))
        console.log('ok page token refused: the call went out all the same, on the token the page had')

        // Refused the way qwen.ai refused the worker's own refresh on 2026-11-27 — under a 200,
        // with Bad_Request: said so on the worker's line, and the call goes out all the same.
        standIn.state.tokenSeconds = 60
        assert.equal((await call('/renew', { email, force: true })).status, 200)
        standIn.auth.refresh = 'bad_request'
        const { answer: badRequest, lines: badRequestLines } = await logged(async lines => ({
            lines, answer: await egress({ headers: { 'content-type': 'application/json' } })
        }))
        assert.equal(badRequest.status, 200, JSON.stringify(badRequest.body))
        assert.equal(standIn.auth.asked.length, 3)
        assert.equal(standIn.auth.asked[2].headers['x-request-origin'], standIn.origin)
        assert.equal(JSON.parse(badRequest.body.body).authorization, `Bearer ${standIn.state.pageToken}`)
        assert.ok(badRequestLines.some(line => /token-refresh failed \(refused, status 200, code Bad_Request, \d+ ms\)$/.test(line)), badRequestLines.join('\n'))
        console.log('ok page token refused under a 200 with Bad_Request (as on 2026-11-27): said so, and the call went out all the same')
        standIn.auth.refresh = 'ok'

        // A token with its margin left is left alone: no refresh call.
        standIn.state.tokenSeconds = 3600
        assert.equal((await call('/renew', { email, force: true })).status, 200)
        assert.equal((await egress({ headers: { 'content-type': 'application/json' } })).status, 200)
        assert.equal(standIn.auth.asked.length, 3, 'a token with its margin left was renewed')
        console.log('ok page token young: not renewed')

        // A clean stop closes the browser, which flushes the profile.
        await server.workerShutdown()
        assert.equal((await health()).residentPages, 0)
        const stores = ['Default/Network/Cookies', 'Default/Cookies'].map(file => path.join(profile, file))
        assert.ok(stores.some(file => fs.existsSync(file)), 'Chromium must flush its cookie store on close')
        console.log('ok shutdown: the browser closed cleanly and flushed the profile to disk')

        // An explicit invalidation (Qwen2API-3ue.2) on a worker whose cache is
        // FRESH: a plain /renew answers from the cache, force reloads the page.
        // The smoke's own worker above keeps its cache permanently stale, so
        // this runs on a second one with the default freshness window. Its
        // stream cap is 32 bytes: less than the stand-in's first frame.
        const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worker-smoke-force-'))
        const fresh = createServer({
            dataDir: freshDir, token: 'secret', chatOrigin: standIn.origin, keepAliveMs: 200, egressMaxStreamBytes: 32,
            loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1,
            // A renewal on this worker waits no longer than this for the streams on its page (Qwen2API-nch).
            streamWaitMs: 400
        })
        await new Promise(resolve => fresh.listen(0, '127.0.0.1', resolve))
        const freshUrl = `http://127.0.0.1:${fresh.address().port}`
        const onFresh = (route, payload) => call(route, payload, freshUrl)
        try {
            fs.mkdirSync(profileDirOf(freshDir))
            assert.equal((await onFresh('/egress', { email, url: '/api/echo', method: 'GET', timeoutMs: 30000 })).status, 200)
            // The stream cap, in a real browser: a stream is a fetch
            // (Qwen2API-3ue.9), and it is cut as the cap is passed — inside
            // the page, before the body is in.
            const capped = await drain(await relay({ timeoutMs: 5000 }, freshUrl))
            assert.deepEqual(capped.map(event => [event.type, event.code]), [['head', undefined], ['error', 'egress_too_large']],
                JSON.stringify(capped))
            console.log('ok stream size cap: a stream over its cap is cut inside the page')
            const loads = standIn.pageLoads()
            const plain = await onFresh('/renew', { email })
            assert.equal(plain.status, 200, JSON.stringify(plain.body))
            assert.equal(standIn.pageLoads(), loads, 'a fresh cache answers without a reload')
            const forced = await Promise.all([1, 2, 3].map(() => onFresh('/renew', { email, force: true })))
            assert.deepEqual(forced.map(answer => answer.status), [200, 200, 200])
            assert.equal(new Set(forced.map(answer => answer.body.token)).size, 1)
            assert.equal(standIn.pageLoads(), loads + 1, 'three forced renewals, one reload')
            console.log('ok forced renewal: /renew {force} reloads despite a fresh cache; a burst shares one reload')

            // ...and a renewal waits for the streams on its page up to its
            // limit, not longer: a stream that has not ended when the limit
            // comes is cut by the reload (Qwen2API-nch). This one says one
            // frame and then nothing.
            const stalling = await relay({ url: '/api/sse-stall' }, freshUrl)
            assert.equal((await stalling.next()).type, 'head')
            assert.equal((await stalling.next()).type, 'chunk')
            const limitAt = Date.now()
            const { answer: pastTheLimit, lines: pastTheLimitLines } = await logged(async lines => ({
                lines, answer: await call('/renew', { email, force: true }, freshUrl)
            }))
            assert.equal(pastTheLimit.status, 200, JSON.stringify(pastTheLimit.body))
            // Timers never fire early: the reload waited the whole limit.
            const reloadAt = standIn.pageLoadTimes.at(-1)
            assert.ok(reloadAt - limitAt >= 400, `the page was reloaded ${reloadAt - limitAt} ms into the wait`)
            assert.deepEqual((await drain(stalling)).map(event => [event.type, event.code]), [['error', 'browser_error']])
            assert.ok(pastTheLimitLines.some(line => /resident-wait 1 still running \(waited \d+ ms for the page's streams\)$/.test(line)),
                pastTheLimitLines.join('\n'))
            console.log(`ok stream vs renewal, the limit: the reload waited ${reloadAt - limitAt} ms for a stream that did not end, then went through it; the stream ended as browser_error`)
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
            dataDir, token: 'secret', chatOrigin: standIn.origin, headlessMode: 'chrome', keepAliveMs: 200,
            loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1
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

        // Since Qwen2API-nch and Qwen2API-ops every page load of every account
        // takes a turn: two accounts opening their pages at once do not load
        // qwen.ai at once. The queue's interval is short here, to be seen.
        const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worker-smoke-queue-'))
        const queued = createServer({ dataDir: queueDir, token: 'secret', chatOrigin: standIn.origin, keepAliveMs: 200, loadMinIntervalMs: 600 })
        await new Promise(resolve => queued.listen(0, '127.0.0.1', resolve))
        const queuedUrl = `http://127.0.0.1:${queued.address().port}`
        try {
            const accounts = ['first@example.invalid', 'second@example.invalid']
            for (const who of accounts) {
                fs.mkdirSync(path.join(queueDir, 'account-' + crypto.createHash('sha256').update(who).digest('hex').slice(0, 32)), { recursive: true })
            }
            const loadsBefore = standIn.pageLoads()
            const opened = await Promise.all(accounts.map(who =>
                call('/egress', { email: who, url: '/api/echo', method: 'POST', timeoutMs: 30000 }, queuedUrl)))
            assert.deepEqual(opened.map(answer => answer.status), [200, 200], JSON.stringify(opened.map(answer => answer.body)))
            const times = standIn.pageLoadTimes.slice(loadsBefore).sort((a, b) => a - b)
            assert.equal(times.length, 2)
            // Timers never fire early.
            assert.ok(times[1] - times[0] >= 600, `the second page was loaded ${times[1] - times[0]} ms after the first`)
            console.log(`ok page loads take turns: two accounts opening their pages at once loaded them ${times[1] - times[0]} ms apart (the queue's interval here: 600 ms)`)
        } finally {
            await queued.workerShutdown()
            await new Promise(resolve => queued.close(resolve))
            fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
