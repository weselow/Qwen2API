'use strict'

/**
 * Signin worker sidecar (jik.3): acquires and silently renews chat.qwen.ai
 * sessions in a real Chromium via Playwright.
 *
 *   POST /session {email, password, proxy?, force?} -> {token, expiresAt, cookies[]}
 *   POST /renew   {email, proxy?}            -> {token, expiresAt, cookies[]}
 *   GET  /health                             -> {ok, sessions, residentPages}
 *
 * One persistent context (userDataDir) per account on the SIGNIN_DATA_DIR
 * volume: auth cookies survive restarts and renewal is a silent reload.
 * Tokens live in memory only; passwords are never stored or logged. The
 * worker must stay on an internal network (optionally guarded by
 * SIGNIN_WORKER_TOKEN as a shared bearer secret).
 *
 * Full logins are the risky part: batched ones from one IP feed the Baxia
 * score (Qwen2API-43a). So /session hands a live harvested session back
 * instead of logging in again, joins concurrent sign-ins of one account into
 * one, and every sign-in that does run takes a slot from the login pacer
 * (lib/login-pacer.js). `force` asks for a real sign-in all the same, for a
 * cached session that was just refused upstream.
 *
 * Since Qwen2API-3ue.1 it is also the egress service: a resident page per
 * active account carries qwen.ai API calls as in-page fetches, so upstream
 * sees the browser's TLS and its live cookies.
 *
 *   POST /egress {email, url, method, headers, body, timeoutMs, proxy?}
 *                                          -> {status, headers, body, cookies[]}
 *
 * Design: docs/browser-egress-design.md.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { WorkerError, STATUS_FOR_CODE } = require('./lib/worker-errors')
const { normalizeEgress } = require('./lib/egress-fetch')
const { createResidents } = require('./lib/resident-pages')
const { createLoginPacer } = require('./lib/login-pacer')

const envInt = (name, fallback) => {
    const raw = parseInt(process.env[name], 10)
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const REQUEST_BODY_LIMIT = 131072
// Egress relays request bodies built by the app (agent contexts, images).
const EGRESS_BODY_LIMIT = 32 * 1024 * 1024

function createServer(overrides = {}) {
    const signer = overrides.signer || require('./lib/browser-signin')
    const config = {
        port: overrides.port ?? envInt('PORT', 3100),
        dataDir: overrides.dataDir || process.env.SIGNIN_DATA_DIR || path.join(__dirname, 'profiles'),
        headless: overrides.headless ?? process.env.SIGNIN_HEADLESS !== 'false',
        chatOrigin: overrides.chatOrigin || process.env.SIGNIN_CHAT_ORIGIN || 'https://chat.qwen.ai',
        timeoutMs: overrides.timeoutMs ?? envInt('SIGNIN_TIMEOUT_MS', 120000),
        renewFraction: overrides.renewFraction ?? 0.6,
        minRenewDelayMs: overrides.minRenewDelayMs ?? envInt('SIGNIN_MIN_RENEW_DELAY_MS', 30000),
        minCacheSeconds: overrides.minCacheSeconds ?? 120,
        // Full logins start at least this far apart, plus up to the same
        // again as jitter; 1 turns pacing off. A /session that would wait
        // longer than maxLoginWaitMs for its slot is refused (signin_paced).
        minLoginIntervalMs: overrides.minLoginIntervalMs ?? envInt('SIGNIN_LOGIN_MIN_INTERVAL_MS', 30000),
        maxLoginWaitMs: overrides.maxLoginWaitMs ?? envInt('SIGNIN_LOGIN_MAX_WAIT_MS', 120000),
        // Shared bearer secret; empty = no auth (internal network only).
        token: overrides.token !== undefined ? overrides.token : (process.env.SIGNIN_WORKER_TOKEN || ''),
        // Resident pages (Qwen2API-3ue.1). ~200-300 MB of Chromium each.
        maxPages: overrides.maxPages ?? envInt('MAX_RESIDENT_PAGES', 16),
        keepAliveMs: overrides.keepAliveMs ?? envInt('RESIDENT_KEEPALIVE_MS', 300000),
        // An /egress timeoutMs is clamped to this; unset, it is config.timeoutMs.
        egressMaxTimeoutMs: overrides.egressMaxTimeoutMs ?? envInt('SIGNIN_EGRESS_MAX_TIMEOUT_MS', 600000),
        egressMaxBytes: overrides.egressMaxBytes ?? 8 * 1024 * 1024,
        // Grace periods, all bounded so a wedged browser cannot stall a request.
        drainMs: overrides.drainMs ?? 5000,
        backstopMs: overrides.backstopMs ?? 5000,
        closeMs: overrides.closeMs ?? 5000,
        shutdownMs: overrides.shutdownMs ?? 8000
    }

    fs.mkdirSync(config.dataDir, { recursive: true })

    // email -> {token, exp, cookies, proxy, timer}; tokens stay in RAM only.
    const sessions = new Map()
    // Chromium locks a profile directory: serialize every launch per account.
    const locks = new Map()
    // email -> the full sign-in now running for it. A /session that lands on
    // an account whose sign-in is already in flight takes that result.
    const logins = new Map()
    const pacer = createLoginPacer({
        minIntervalMs: config.minLoginIntervalMs,
        maxWaitMs: config.maxLoginWaitMs
    })

    const log = (event, extra) => console.log(`${new Date().toISOString()} ${event}${extra ? ' ' + extra : ''}`)
    const profileDir = email => path.join(config.dataDir,
        'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32))
    const now = () => Math.floor(Date.now() / 1000)

    function serialized(email, operation) {
        const previous = locks.get(email) || Promise.resolve()
        const result = previous.then(operation, operation)
        const tail = result.then(() => {}, () => {})
        locks.set(email, tail)
        tail.then(() => { if (locks.get(email) === tail) locks.delete(email) })
        return result
    }

    async function withBrowser(email, proxy, operation) {
        const context = await signer.openContext({ dataDir: profileDir(email), proxy, headless: config.headless })
        try {
            return await operation(context)
        } finally {
            await context.close().catch(() => {})
        }
    }

    const shape = entry => ({
        token: entry.token,
        expiresAt: entry.exp,
        chatOrigin: config.chatOrigin,
        harvestedAt: new Date(entry.harvestedAt).toISOString(),
        cookies: entry.cookies
    })

    function remember(email, harvested, proxy) {
        const previous = sessions.get(email)
        clearTimeout(previous?.timer)
        const entry = {
            token: harvested.token,
            exp: harvested.exp,
            cookies: harvested.cookies,
            harvestedAt: Date.now(),
            proxy: proxy ?? previous?.proxy ?? null,
            timer: null
        }
        // Keep the profile warm: renew silently at a fraction of the remaining TTL.
        const delay = Math.max(config.minRenewDelayMs, (entry.exp - now()) * config.renewFraction * 1000)
        entry.timer = setTimeout(() => {
            silentRenew(email).catch(() => {})
        }, delay)
        entry.timer.unref?.()
        sessions.set(email, entry)
        return entry
    }

    // The live page is the source of truth for the jar: what the browser holds
    // now replaces the cached cookies, so a cached /renew never hands out a
    // jar the browser has already rotated away from.
    const syncCookies = (email, cookies) => {
        const cached = sessions.get(email)
        if (cached && Array.isArray(cookies)) cached.cookies = cookies
    }

    // email -> resident page on chat.qwen.ai; fetches run inside it.
    const residents = createResidents({
        signer,
        profileDir,
        chatOrigin: config.chatOrigin,
        headless: config.headless,
        openTimeoutMs: config.timeoutMs,
        maxPages: config.maxPages,
        keepAliveMs: config.keepAliveMs,
        maxBytes: config.egressMaxBytes,
        drainMs: config.drainMs,
        backstopMs: config.backstopMs,
        closeMs: config.closeMs,
        log,
        onHarvest: remember,
        onCookies: syncCookies
    })

    async function silentRenew(email) {
        try {
            const harvested = await liveRenew(email, null)
            remember(email, harvested, null)
            log('silent-renew', `ok (${sessions.size} sessions)`)
            return harvested
        } catch (error) {
            // Drop the cache; the app re-logins with the password via /session.
            clearTimeout(sessions.get(email)?.timer)
            sessions.delete(email)
            log('silent-renew', `failed (${error.code || 'error'})`)
            return null
        }
    }

    async function liveRenew(email, proxy) {
        const cached = sessions.get(email)
        const effectiveProxy = proxy ?? cached?.proxy ?? null
        if (!cached && !fs.existsSync(profileDir(email))) {
            throw new WorkerError('no_profile', 'No persisted profile for this account.')
        }
        return withBrowserContext(email, effectiveProxy,
            context => signer.renew(context, { chatOrigin: config.chatOrigin, timeoutMs: config.timeoutMs }))
    }

    async function withBrowserContext(email, proxy, operation) {
        return serialized(email, async () => {
            // A resident page owns the profile directory (Chromium locks it):
            // sign-in and renewal run on that page instead of a second launch.
            // A null proxy means "whatever the account already uses".
            const resident = residents.get(email)
            const wanted = proxy ?? resident?.proxy ?? null
            if (resident && resident.proxy === wanted) return residents.exclusive(resident, operation)
            if (resident) await residents.close(resident, 'proxy_changed')
            // The page may still be closing (crash, eviction): its browser
            // holds the profile lock until it is gone.
            await residents.whenClosed(email)
            return withBrowser(email, proxy, operation)
        })
    }

    const parseEmail = body => {
        if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(body.email) || body.email.length > 254) {
            throw new WorkerError('invalid_request', 'A valid email is required.')
        }
        return body.email
    }

    const parseProxy = body => {
        const { proxy } = body
        if (proxy !== undefined && proxy !== null && (typeof proxy !== 'string' || proxy.length > 2048)) {
            throw new WorkerError('invalid_request', 'Invalid proxy URL.')
        }
        return proxy || null
    }

    // The session is live for as long as /renew would answer from the cache.
    const fresh = email => {
        const entry = sessions.get(email)
        return entry && entry.exp - now() > config.minCacheSeconds ? entry : undefined
    }

    /** One real sign-in: in line for a slot first, the browser flow under the account lock. */
    async function fullLogin(email, password, proxy, force) {
        const slot = pacer.admit()
        if (slot.waitMs > 0) {
            log('session', `queued (${slot.waitMs}ms)`)
            await sleep(slot.waitMs)
        }
        const harvested = await withBrowserContext(email, proxy, async context => {
            // The wait above is long enough for a lazy page open or a silent
            // renewal to have produced the session asked for here.
            if (!force && fresh(email)) return null
            await pacer.enter(slot)
            return signer.signin(context, { email, password, chatOrigin: config.chatOrigin, timeoutMs: config.timeoutMs })
        })
        if (!harvested) {
            log('session', 'cached')
            return shape(sessions.get(email))
        }
        const entry = remember(email, harvested, proxy)
        log('session', `acquired (${sessions.size} sessions)`)
        return shape(entry)
    }

    async function handleSession(body) {
        const email = parseEmail(body)
        const { password } = body
        if (typeof password !== 'string' || !password || password.length > 1024) {
            throw new WorkerError('invalid_request', 'A password is required.')
        }
        if (body.force !== undefined && typeof body.force !== 'boolean') {
            throw new WorkerError('invalid_request', 'force must be a boolean.')
        }
        const proxy = parseProxy(body)
        // A live session answers for the password. One "add account" is one
        // login, however many /session calls the app makes of it.
        const live = body.force ? undefined : fresh(email)
        if (live) {
            log('session', 'cached')
            return shape(live)
        }
        const running = logins.get(email)
        if (running) {
            log('session', 'joined')
            return running
        }
        const login = fullLogin(email, password, proxy, body.force)
        const tracked = login.finally(() => { if (logins.get(email) === tracked) logins.delete(email) })
        logins.set(email, tracked)
        return tracked
    }

    async function handleRenew(body) {
        const email = parseEmail(body)
        const proxy = parseProxy(body)
        const cached = sessions.get(email)
        if (cached && cached.exp - now() > config.minCacheSeconds) return shape(cached)
        const harvested = await liveRenew(email, proxy)
        remember(email, harvested, proxy)
        log('renew', `ok (${sessions.size} sessions)`)
        return shape(sessions.get(email))
    }

    async function handleEgress(body) {
        const email = parseEmail(body)
        const proxy = parseProxy(body)
        const request = normalizeEgress(body, {
            chatOrigin: config.chatOrigin,
            defaultTimeoutMs: config.timeoutMs,
            maxTimeoutMs: config.egressMaxTimeoutMs
        })
        // The lock covers finding or opening the page only; the fetch itself
        // runs free, so calls on one page stay concurrent.
        const entry = await serialized(email, () => residents.acquire(email,
            proxy ?? residents.get(email)?.proxy ?? sessions.get(email)?.proxy ?? null))
        const result = await residents.fetch(entry, request)
        log('egress', `${new URL(request.url).pathname} -> ${result.status} (${residents.stats().residentPages}/${config.maxPages} pages)`)
        return result
    }

    function authorized(req) {
        if (!config.token) return true
        const header = Buffer.from(String(req.headers.authorization || ''))
        const expected = Buffer.from(`Bearer ${config.token}`)
        return header.length === expected.length && crypto.timingSafeEqual(header, expected)
    }

    function send(res, status, payload) {
        const body = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
    }

    async function readJson(req, limit) {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
            size += chunk.length
            if (size > limit) throw new WorkerError('invalid_request', 'Request body too large.')
            chunks.push(chunk)
        }
        if (!chunks.length) return {}
        let parsed
        try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            throw new WorkerError('invalid_request', 'Request body must be JSON.')
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new WorkerError('invalid_request', 'Request body must be a JSON object.')
        }
        return parsed
    }

    const server = http.createServer((req, res) => {
        const started = Date.now()
        handle(req, res)
            .catch(error => {
                const code = error.code && STATUS_FOR_CODE[error.code] ? error.code : 'browser_error'
                const status = STATUS_FOR_CODE[code] || 500
                send(res, status, {
                    code, message: error.message || 'Signin worker failure.',
                    ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: Math.ceil(error.retryAfterMs) } : {})
                })
            })
            .finally(() => {
                if (req.url !== '/health') {
                    log('request', `${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms`)
                }
            })
    })

    async function handle(req, res) {
        if (req.method === 'GET' && req.url === '/health') {
            return send(res, 200, { ok: true, sessions: sessions.size, ...residents.stats() })
        }
        if ((req.method === 'POST' && req.url === '/session') || (req.method === 'POST' && req.url === '/renew')) {
            if (!authorized(req)) throw new WorkerError('unauthorized', 'Invalid worker token.')
            const body = await readJson(req, REQUEST_BODY_LIMIT)
            return send(res, 200, req.url === '/session' ? await handleSession(body) : await handleRenew(body))
        }
        if (req.method === 'POST' && req.url === '/egress') {
            if (!authorized(req)) throw new WorkerError('unauthorized', 'Invalid worker token.')
            const body = await readJson(req, EGRESS_BODY_LIMIT)
            return send(res, 200, await handleEgress(body))
        }
        throw new WorkerError('invalid_request', 'Unknown route.')
    }

    server.workerConfig = config
    server.workerShutdown = () => residents.shutdown(config.shutdownMs)
    return server
}

/**
 * Handler for a stop signal (container stop).
 *
 * Node runs as PID 1 in the container, where a signal without a handler is
 * ignored altogether — and the SIGKILL 10 s later would skip the clean
 * browser close that flushes every profile (auth cookies) to disk.
 *
 * @param {http.Server} server created by createServer()
 * @param {(code: number) => void} [exit]
 * @returns {(signal: string) => void}
 */
function shutdownHandler(server, exit = code => process.exit(code)) {
    let stopping = false
    return signal => {
        // A second signal means "now": do not wait for the first to finish.
        if (stopping) return exit(0)
        stopping = true
        console.log(`${new Date().toISOString()} stopping on ${signal}`)
        server.close()
        // Either way the process goes: a shutdown that failed has nothing left to say.
        server.workerShutdown().then(() => exit(0), () => exit(0))
    }
}

module.exports = { createServer, WorkerError, shutdownHandler }

if (require.main === module) {
    const server = createServer()
    server.listen(server.workerConfig.port, () => {
        console.log(`${new Date().toISOString()} signin-worker listening on :${server.workerConfig.port}`)
    })
    const stop = shutdownHandler(server)
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))
}
