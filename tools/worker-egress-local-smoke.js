#!/usr/bin/env node
'use strict'

/**
 * Local end-to-end smoke for the signin worker's resident egress
 * (Qwen2API-3ue.1): the REAL worker, the REAL browser-signin and a REAL
 * headless Chromium — against a stand-in for chat.qwen.ai on 127.0.0.1.
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

/**
 * The stand-in: a root page that settles a token the way the chat FE does,
 * and API routes that report what actually reached the server.
 */
function startStandIn() {
    let pageLoads = 0
    const server = http.createServer((req, res) => {
        if (req.url === '/' && req.method === 'GET') {
            pageLoads++
            res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'standin=1; Path=/' })
            return res.end(`<html><body>stand-in<script>localStorage.setItem('token', '${
                tokenExpiringIn(3600)}')</script></body></html>`)
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
                    userAgent: req.headers['user-agent'] || null
                }))
            })
        }
        res.writeHead(404)
        res.end()
    })
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        pageLoads: () => pageLoads
    })))
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

        console.log('SMOKE OK — real worker, real Chromium, stand-in origin; qwen.ai was not contacted')
    } finally {
        await server.workerShutdown()
        await Promise.all([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => standIn.server.close(resolve))
        ])
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
}

main().catch(error => {
    console.error(error.stack || error)
    process.exit(1)
})
