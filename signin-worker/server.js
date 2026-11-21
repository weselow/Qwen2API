'use strict'

/**
 * Signin worker sidecar (jik.3): acquires and silently renews chat.qwen.ai
 * sessions in a real Chromium via Playwright.
 *
 *   POST /session {email, password, proxy?} -> {token, expiresAt, cookies[]}
 *   POST /renew   {email, proxy?}            -> {token, expiresAt, cookies[]}
 *   GET  /health                             -> {ok, sessions}
 *
 * One persistent context (userDataDir) per account on the SIGNIN_DATA_DIR
 * volume: auth cookies survive restarts and renewal is a silent reload.
 * Tokens live in memory only; passwords are never stored or logged. The
 * worker must stay on an internal network (optionally guarded by
 * SIGNIN_WORKER_TOKEN as a shared bearer secret).
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const envInt = (name, fallback) => {
    const raw = parseInt(process.env[name], 10)
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// Error codes -> HTTP statuses; unknown browser failures land on 500.
const STATUS_FOR_CODE = {
    invalid_request: 400,
    unauthorized: 401,
    invalid_credentials: 401,
    no_profile: 404,
    session_expired: 422,
    captcha_stuck: 502,
    form_not_found: 502,
    signin_timeout: 504,
    browser_error: 500
}

class WorkerError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

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
        // Shared bearer secret; empty = no auth (internal network only).
        token: overrides.token !== undefined ? overrides.token : (process.env.SIGNIN_WORKER_TOKEN || '')
    }

    fs.mkdirSync(config.dataDir, { recursive: true })

    // email -> {token, exp, cookies, proxy, timer}; tokens stay in RAM only.
    const sessions = new Map()
    // Chromium locks a profile directory: serialize every launch per account.
    const locks = new Map()

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
        return serialized(email, () => withBrowser(email, proxy, operation))
    }

    async function handleSession(body) {
        const { email, password, proxy } = body
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
            throw new WorkerError('invalid_request', 'A valid email is required.')
        }
        if (typeof password !== 'string' || !password || password.length > 1024) {
            throw new WorkerError('invalid_request', 'A password is required.')
        }
        if (proxy !== undefined && proxy !== null && (typeof proxy !== 'string' || proxy.length > 2048)) {
            throw new WorkerError('invalid_request', 'Invalid proxy URL.')
        }
        const harvested = await withBrowserContext(email, proxy || null,
            context => signer.signin(context, { email, password, chatOrigin: config.chatOrigin, timeoutMs: config.timeoutMs }))
        remember(email, harvested, proxy || null)
        log('session', `acquired (${sessions.size} sessions)`)
        return shape(sessions.get(email))
    }

    async function handleRenew(body) {
        const { email, proxy } = body
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
            throw new WorkerError('invalid_request', 'A valid email is required.')
        }
        if (proxy !== undefined && proxy !== null && (typeof proxy !== 'string' || proxy.length > 2048)) {
            throw new WorkerError('invalid_request', 'Invalid proxy URL.')
        }
        const cached = sessions.get(email)
        if (cached && cached.exp - now() > config.minCacheSeconds) return shape(cached)
        const harvested = await liveRenew(email, proxy || null)
        remember(email, harvested, proxy || null)
        log('renew', `ok (${sessions.size} sessions)`)
        return shape(sessions.get(email))
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

    async function readJson(req) {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
            size += chunk.length
            if (size > 131072) throw new WorkerError('invalid_request', 'Request body too large.')
            chunks.push(chunk)
        }
        if (!chunks.length) return {}
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            throw new WorkerError('invalid_request', 'Request body must be JSON.')
        }
    }

    const server = http.createServer((req, res) => {
        const started = Date.now()
        handle(req, res)
            .catch(error => {
                const code = error.code && STATUS_FOR_CODE[error.code] ? error.code : 'browser_error'
                const status = STATUS_FOR_CODE[code] || 500
                send(res, status, { code, message: error.message || 'Signin worker failure.' })
            })
            .finally(() => {
                if (req.url !== '/health') {
                    log('request', `${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms`)
                }
            })
    })

    async function handle(req, res) {
        if (req.method === 'GET' && req.url === '/health') {
            return send(res, 200, { ok: true, sessions: sessions.size })
        }
        if ((req.method === 'POST' && req.url === '/session') || (req.method === 'POST' && req.url === '/renew')) {
            if (!authorized(req)) throw new WorkerError('unauthorized', 'Invalid worker token.')
            const body = await readJson(req)
            return send(res, 200, req.url === '/session' ? await handleSession(body) : await handleRenew(body))
        }
        throw new WorkerError('invalid_request', 'Unknown route.')
    }

    server.workerConfig = config
    return server
}

module.exports = { createServer, WorkerError }

if (require.main === module) {
    const server = createServer()
    server.listen(server.workerConfig.port, () => {
        console.log(`${new Date().toISOString()} signin-worker listening on :${server.workerConfig.port}`)
    })
}
