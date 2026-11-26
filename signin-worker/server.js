'use strict'

/**
 * Signin worker sidecar (jik.3): acquires and silently renews chat.qwen.ai
 * sessions in a real Chromium via Playwright.
 *
 *   POST /session {email, password, proxy?, force?} -> {token, expiresAt, cookies[]}
 *   POST /renew   {email, proxy?, force?}   -> {token, expiresAt, cookies[]}
 *   GET  /health                             -> {ok, sessions, residentPages, headlessMode,
 *                                                pageTokenRefresh, streamWaitMs, loadMinIntervalMs,
 *                                                loadMaxWaitMs, pageLoadQueue}
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
 * cached session that was just refused upstream. /renew takes the same flag
 * (Qwen2API-3ue.2): the same explicit invalidation, answered with a live page
 * reload.
 *
 * Since Qwen2API-3ue.1 it is also the egress service: a resident page per
 * active account carries qwen.ai API calls, sent from inside the page the way
 * the page's own code sends its requests, so upstream sees the browser's TLS,
 * its live cookies and its headers (Qwen2API-3ue.5).
 *
 *   POST /egress {email, url, method, headers, body, timeoutMs, proxy?}
 *                                          -> {status, headers, body, cookies[]}
 *
 * With `stream: true` (Qwen2API-3ue.3) /egress answers with a relay instead:
 * one JSON event per line while qwen.ai's answer arrives, and the app cutting
 * its connection cuts the request inside the page (relayEgress).
 *
 * qwen.ai's status and body always travel inside a 200: a WAF challenge page
 * too, under whatever status it came. The worker names it in its log (and
 * hands it on whether the page's scripts did or kept it back,
 * Qwen2API-3ue.6); what it means is the app's to say.
 *
 * Since Qwen2API-0c6 (2026-11-26) the log says more of a whole answer than
 * its status: a refusal qwen.ai puts in the body of a 200 by its code, and an
 * answer that is no 2xx by its code, its headers and the start of its body
 * (egress-fetch.js#answerNote) — none that could hold a credential.
 *
 * Since Qwen2API-nch, Qwen2API-ops and Qwen2API-xun (2026-11-26), for many
 * accounts:
 *
 *   - the page loads of every account — a lazy open, a renewal — take turns
 *     in one queue (lib/page-load-queue.js), so that a burst of openings after
 *     a restart, or of renewals in one tick of the app's timer, is not a burst
 *     of page loads from one address; a sign-in does not wait in that queue
 *     (the login pacer spaces sign-ins), it only tells it when it begins;
 *   - a navigation on a live page waits first for the streams running on it
 *     (RESIDENT_STREAM_WAIT_MS), which a reload cuts otherwise;
 *   - a page's token is renewed in place before a call that finds it nearly
 *     spent — the front end's own refresh call, no reload (SIGNIN_PAGE_TOKEN_REFRESH).
 *
 *   token-refresh ok (…), token-refresh failed (…)          the page's token, renewed in place
 *   resident-wait ended (…), resident-wait N still running (…)   what a navigation waited for
 *   page-load waited (…[, a long line packed])             how long a load waited for its turn
 *   renew no reload (…)                                      a renewal answered by a session that turned live meanwhile
 *
 * Design: docs/browser-egress-design.md.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { WorkerError, STATUS_FOR_CODE } = require('./lib/worker-errors')
const { normalizeEgress, answerNote } = require('./lib/egress-fetch')
const { createResidents } = require('./lib/resident-pages')
const { createLoginPacer } = require('./lib/login-pacer')
const { createPageLoadQueue } = require('./lib/page-load-queue')
const { parseHeadlessMode } = require('./lib/browser-identity')

const envInt = (name, fallback) => {
    const raw = parseInt(process.env[name], 10)
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
// Like envInt, where 0 is a value of its own and not "unset".
const envCount = (name, fallback) => {
    const raw = parseInt(process.env[name], 10)
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const REQUEST_BODY_LIMIT = 131072

/**
 * Write one event of a relay, and say when the app has taken it: at once, or
 * once the socket drained when the app is behind. A socket that goes is as
 * good as drained — nothing will ever drain it, and the relay is over anyway —
 * which is what keeps a handler from waiting on an app that left.
 * @param {http.ServerResponse} res
 * @param {() => boolean} gone - The app left: say it is written, write nothing
 * @returns {(event: object) => Promise<void>|undefined}
 */
const relayWriter = (res, gone) => event => {
    // Gone: say it is written. The page must not wait on a socket nobody will drain.
    if (gone()) return
    if (res.write(`${JSON.stringify(event)}\n`)) return
    // The app is behind: the page (and behind it qwen.ai) waits until it catches up.
    return new Promise(resolve => {
        const taken = () => {
            res.off('drain', taken)
            res.off('close', taken)
            resolve()
        }
        res.once('drain', taken)
        res.once('close', taken)
    })
}
// Egress relays request bodies built by the app (agent contexts, images).
const EGRESS_BODY_LIMIT = 32 * 1024 * 1024

// How the log names a WAF challenge page (Qwen2API-3ue.6), by who got to see
// qwen.ai's answer: the page's scripts handed it to the call ('page'), or
// kept it back and the worker read it off the page's network ('network').
// Nothing to say for any other answer. tools/egress-log-watch.js reads these.
const CHALLENGE_NOTE = { page: ' — WAF challenge page', network: ' — WAF challenge page, kept from the call by the page' }

function createServer(overrides = {}) {
    const signer = overrides.signer || require('./lib/browser-signin')
    const config = {
        port: overrides.port ?? envInt('PORT', 3100),
        dataDir: overrides.dataDir || process.env.SIGNIN_DATA_DIR || path.join(__dirname, 'profiles'),
        headless: overrides.headless ?? process.env.SIGNIN_HEADLESS !== 'false',
        // Which headless browser that is (Qwen2API-3ue.4): the shell, or the
        // full Chromium presenting as one with a window. Nothing when headed.
        // Strict: createServer throws on a value it does not know.
        headlessMode: overrides.headlessMode ?? parseHeadlessMode(process.env.SIGNIN_HEADLESS_MODE),
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
        // A stream is relayed, not buffered: the whole-answer cap is not its.
        // Off unless set.
        egressMaxStreamBytes: overrides.egressMaxStreamBytes ?? envInt('SIGNIN_EGRESS_MAX_STREAM_BYTES', 0),
        // A WAF challenge page the page's scripts keep from the call is read
        // off the page's network this long after qwen.ai answered
        // (Qwen2API-3ue.6).
        keptGraceMs: overrides.keptGraceMs ?? 1000,
        // After a page (re)loads its token changes more than once; a call
        // before it has settled is refused (Qwen2API-3ue.5).
        settleStableMs: overrides.settleStableMs ?? 2500,
        settlePollMs: overrides.settlePollMs ?? 250,
        settleTimeoutMs: overrides.settleTimeoutMs ?? 20000,
        // Grace periods, all bounded so a wedged browser cannot stall a request.
        drainMs: overrides.drainMs ?? 5000,
        backstopMs: overrides.backstopMs ?? 5000,
        closeMs: overrides.closeMs ?? 5000,
        shutdownMs: overrides.shutdownMs ?? 8000,
        // The page's token is renewed in place before a call that finds it
        // nearly spent (Qwen2API-xun): by the front end's own refresh call to
        // the auth host, not by a reload of the page. Off — and a refused call
        // is the app's recovery's alone, as before: a reload, a retry.
        pageTokenRefresh: overrides.pageTokenRefresh ?? process.env.SIGNIN_PAGE_TOKEN_REFRESH !== 'false',
        authOrigin: overrides.authOrigin || process.env.SIGNIN_AUTH_ORIGIN || 'https://auth.qwen.ai',
        // The front end's own margin: a token with less than this left is renewed.
        tokenRefreshMarginMs: overrides.tokenRefreshMarginMs ?? 180000,
        tokenRefreshTimeoutMs: overrides.tokenRefreshTimeoutMs ?? 10000,
        // After a refresh that failed, none is tried for this long.
        tokenRetryMs: overrides.tokenRetryMs ?? 30000,
        // What was read of a page's token stands this long at most before it is read again.
        tokenReadAgainMs: overrides.tokenReadAgainMs ?? 60000,
        // After a refresh that did not get through (the auth host not
        // answering), no other page tries its own for this long.
        tokenRefreshCircuitMs: overrides.tokenRefreshCircuitMs ?? 60000,
        // Token refreshes of every page together are kept this far apart; 1 turns that off.
        tokenRefreshMinIntervalMs: overrides.tokenRefreshMinIntervalMs ?? envInt('SIGNIN_TOKEN_REFRESH_MIN_INTERVAL_MS', 2000),
        // A navigation on a live page waits this long for the streams running
        // on it (Qwen2API-nch); 0 = it does not wait, and cuts them.
        streamWaitMs: overrides.streamWaitMs ?? envCount('RESIDENT_STREAM_WAIT_MS', 20000),
        // Every page load of every account starts at least this far from the
        // previous one, plus up to the same again as jitter (Qwen2API-nch,
        // Qwen2API-ops); 1 turns the queue off. Sign-ins are not in that line:
        // the login pacer spaces them.
        loadMinIntervalMs: overrides.loadMinIntervalMs ?? envInt('RESIDENT_LOAD_MIN_INTERVAL_MS', 10000),
        // No page load waits longer than this for its turn; a longer line is
        // packed closer instead. One exception: a sign-in that begins just
        // before a load's turn holds it back by up to one interval more — one
        // interval in all, however many begin. A renewal waits, inside the
        // application's budget for /renew (SIGNIN_WORKER_TIMEOUT_MS), for the
        // streams on its page (streamWaitMs), for the calls in flight
        // (drainMs), then here, then for the reload and for the token to
        // settle after it: this must leave all of them room.
        // 0 = no limit.
        loadMaxWaitMs: overrides.loadMaxWaitMs ?? envCount('RESIDENT_LOAD_MAX_WAIT_MS', 120000)
    }

    fs.mkdirSync(config.dataDir, { recursive: true })

    // email -> {token, exp, cookies, proxy, timer}; tokens stay in RAM only.
    const sessions = new Map()
    // email -> the live renewal in flight; every caller of one moment shares
    // one page reload.
    const renewing = new Map()
    // The accounts whose renewal in flight has a caller that insists on a live
    // reload: for these the cache answers nothing, whoever started the renewal.
    const insisting = new Set()
    // Set when the worker begins to stop: no browser is launched for a request that lands after it.
    let halting = false
    // Chromium locks a profile directory: serialize every launch per account.
    const locks = new Map()
    // email -> the full sign-in now running for it. A /session that lands on
    // an account whose sign-in is already in flight takes that result.
    const logins = new Map()
    // What names a stream while it runs: the app going away aborts "its" stream.
    let streamSequence = 0
    const pacer = createLoginPacer({
        minIntervalMs: config.minLoginIntervalMs,
        maxWaitMs: config.maxLoginWaitMs
    })

    const log = (event, extra) => console.log(`${new Date().toISOString()} ${event}${extra ? ' ' + extra : ''}`)
    // Every page qwen.ai is asked to serve the worker, from whatever account,
    // takes a turn (lib/page-load-queue.js): a burst of openings after a
    // restart, or of renewals in one tick of the app's timer, would be a burst
    // of page loads from one address. A sign-in does not wait in that line —
    // the login pacer spaces sign-ins, and the application's budget for one
    // accounts for that pacer alone — it only tells the queue when it begins.
    // The pages' token refreshes take turns of their own, closer together —
    // they are no page loads.
    const pageLoads = createPageLoadQueue({ minIntervalMs: config.loadMinIntervalMs, maxWaitMs: config.loadMaxWaitMs, log })
    // The refreshes take the queue's default limit of two minutes: with a gap of two to four
    // seconds it would take more than sixty pages in one moment for a line to be packed.
    const tokenRefreshes = createPageLoadQueue({ minIntervalMs: config.tokenRefreshMinIntervalMs })
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
        const context = await signer.openContext({
            dataDir: profileDir(email), proxy, headless: config.headless, headlessMode: config.headlessMode
        })
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

    // Drop the cached session together with its silent-renew timer.
    const forget = email => {
        clearTimeout(sessions.get(email)?.timer)
        sessions.delete(email)
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
        headlessMode: config.headlessMode,
        openTimeoutMs: config.timeoutMs,
        maxPages: config.maxPages,
        keepAliveMs: config.keepAliveMs,
        maxBytes: config.egressMaxBytes,
        maxStreamBytes: config.egressMaxStreamBytes,
        keptGraceMs: config.keptGraceMs,
        settleStableMs: config.settleStableMs,
        settlePollMs: config.settlePollMs,
        settleTimeoutMs: config.settleTimeoutMs,
        drainMs: config.drainMs,
        backstopMs: config.backstopMs,
        closeMs: config.closeMs,
        log,
        onHarvest: remember,
        onCookies: syncCookies,
        pageTokenRefresh: config.pageTokenRefresh,
        authOrigin: config.authOrigin,
        tokenRefreshMarginMs: config.tokenRefreshMarginMs,
        tokenRefreshTimeoutMs: config.tokenRefreshTimeoutMs,
        tokenRetryMs: config.tokenRetryMs,
        tokenReadAgainMs: config.tokenReadAgainMs,
        tokenRefreshCircuitMs: config.tokenRefreshCircuitMs,
        streamWaitMs: config.streamWaitMs,
        beforeTokenRefresh: tokenRefreshes.wait,
        // A sign-in on a resident page tells the queue itself, when it begins (fullLogin).
        beforeLoad: ({ turn } = {}) => (turn === false ? undefined : pageLoads.wait())
    })

    async function silentRenew(email) {
        try {
            // Shared like any other renewal: a forced /renew that lands while
            // the timer's reload is running joins it, not a second reload.
            await liveRenewShared(email, null, false, true)
            log('silent-renew', `ok (${sessions.size} sessions)`)
            return null
        } catch (error) {
            // Drop the cache; the app re-logins with the password via /session.
            forget(email)
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
        // Asked once the account is this renewal's, before any turn is taken or page
        // touched: the session may have turned live while it waited for the account's
        // page — another load of it settled a fresh one. A renewal that stood in the
        // line of page loads behind the page's own opening, for one, has nothing left
        // to reload for: it answers that session, and loads no page. A caller whose
        // session was refused gets its reload, whoever joined the renewal.
        const outcome = await withBrowserContext(email, effectiveProxy,
            async context => ({ reloaded: await signer.renew(context, { chatOrigin: config.chatOrigin, timeoutMs: config.timeoutMs }) }),
            { unless: () => (insisting.has(email) ? undefined : fresh(email)) })
        // The cache answered: its entry. Else what the reload harvested.
        return outcome.reloaded ? outcome : { answered: outcome }
    }

    /**
     * `turn` false: the operation is a sign-in, which does not wait in the
     * line of page loads (lib/page-load-queue.js) — the login pacer spaces
     * sign-ins — and tells the queue itself when it begins.
     *
     * `unless` is asked under the account's lock, before anything else: when it
     * returns something other than undefined, that is the operation's answer, and
     * no turn is taken and no page touched.
     */
    async function withBrowserContext(email, proxy, operation, { turn = true, unless } = {}) {
        return serialized(email, async () => {
            // The worker is stopping: a request that reached it late launches and reloads nothing.
            if (halting) throw new WorkerError('page_closed', 'The worker is shutting down.')
            const instead = unless?.()
            if (instead !== undefined) return instead
            // A resident page owns the profile directory (Chromium locks it):
            // sign-in and renewal run on that page instead of a second launch.
            // A null proxy means "whatever the account already uses".
            const resident = residents.get(email)
            const wanted = proxy ?? resident?.proxy ?? null
            if (resident && resident.proxy === wanted) return residents.exclusive(resident, operation, { turn })
            if (resident) await residents.close(resident, 'proxy_changed')
            // The page may still be closing (crash, eviction): its browser
            // holds the profile lock until it is gone.
            await residents.whenClosed(email)
            // No page to run on: one is opened for the operation. That is a
            // page load, and waits for the worker's turn like every other.
            if (turn) await pageLoads.wait()
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
            log('session', `queued (${Math.ceil(slot.waitMs)}ms)`)
            await sleep(slot.waitMs)
        }
        const harvested = await withBrowserContext(email, proxy, async context => {
            // The wait above is long enough for a lazy page open or a silent
            // renewal to have produced the session asked for here.
            if (!force && fresh(email)) return null
            await pacer.enter(slot)
            // A sign-in is a page load too, but not one in line for a turn:
            // the login pacer spaces sign-ins, and the app's budget for one
            // accounts for it alone. The queue is told right here, as late as
            // may be, so that what follows keeps a gap away from this load.
            pageLoads.note()
            return signer.signin(context, { email, password, chatOrigin: config.chatOrigin, timeoutMs: config.timeoutMs })
        }, { turn: false })
        if (!harvested) {
            log('session', 'cached')
            return shape(sessions.get(email))
        }
        const entry = remember(email, harvested, proxy)
        log('session', `acquired (${sessions.size} sessions)`)
        return shape(entry)
    }

    /**
     * `force` on /session and /renew is the explicit invalidation: the
     * caller's session was refused upstream, so the answer has to be live
     * even while the cache looks fresh.
     */
    const parseForce = body => {
        if (body.force !== undefined && typeof body.force !== 'boolean') {
            throw new WorkerError('invalid_request', 'force must be a boolean.')
        }
        return body.force === true
    }

    async function handleSession(body) {
        const email = parseEmail(body)
        const { password } = body
        if (typeof password !== 'string' || !password || password.length > 1024) {
            throw new WorkerError('invalid_request', 'A password is required.')
        }
        const force = parseForce(body)
        const proxy = parseProxy(body)
        // A live session answers for the password. One "add account" is one
        // login, however many /session calls the app makes of it.
        const live = force ? undefined : fresh(email)
        if (live) {
            log('session', 'cached')
            return shape(live)
        }
        const running = logins.get(email)
        if (running) {
            log('session', 'joined')
            return running
        }
        const login = fullLogin(email, password, proxy, force)
        const tracked = login.finally(() => { if (logins.get(email) === tracked) logins.delete(email) })
        logins.set(email, tracked)
        return tracked
    }

    /**
     * One live renewal per account: callers that arrive while one is running
     * share its result instead of queueing a reload of their own.
     * @param {boolean} [forced] - The caller that starts it invalidated the session
     * @param {boolean} [quiet] - The caller reports the outcome in its own words
     */
    function liveRenewShared(email, proxy, forced = false, quiet = false) {
        if (!renewing.has(email)) {
            const task = liveRenew(email, proxy).then(outcome => {
                // Nothing reloaded: the session turned live while the renewal waited (liveRenew).
                if (outcome.reloaded) remember(email, outcome.reloaded, proxy)
                // One line per reload: the callers that joined it do not log
                // their own, or a burst would read as a burst of reloads.
                if (!quiet) log('renew', `${outcome.reloaded ? `ok${forced ? ' (forced)' : ''}` : 'no reload'} (${sessions.size} sessions)`)
                return shape(sessions.get(email))
            }).finally(() => {
                renewing.delete(email)
                insisting.delete(email)
            })
            renewing.set(email, task)
        }
        // A caller whose session was refused needs the reload, whoever started the renewal it joins.
        if (forced) insisting.add(email)
        return renewing.get(email)
    }

    /**
     * `force` is the explicit invalidation (Qwen2API-3ue.2): the caller's
     * session was refused upstream, so the answer has to be a live reload
     * even while the cached token still has TTL left. Answering from the
     * cache here is what made "unauthorized → renew" replay the refused jar
     * for as long as that lasted. The refused entry is dropped first, so a
     * reload that fails leaves nothing behind to hand it out again.
     */
    async function handleRenew(body) {
        const email = parseEmail(body)
        const proxy = parseProxy(body)
        const force = parseForce(body)
        if (force) forget(email)
        else if (fresh(email)) return shape(fresh(email))
        return liveRenewShared(email, proxy, force)
    }

    async function handleEgress(req, res, body) {
        const email = parseEmail(body)
        const proxy = parseProxy(body)
        const request = normalizeEgress(body, {
            chatOrigin: config.chatOrigin,
            defaultTimeoutMs: config.timeoutMs,
            maxTimeoutMs: config.egressMaxTimeoutMs
        })
        // The lock covers finding or opening the page only; the call itself
        // runs free, so calls on one page stay concurrent.
        const entry = await serialized(email, () => residents.acquire(email,
            proxy ?? residents.get(email)?.proxy ?? sessions.get(email)?.proxy ?? null))
        if (request.stream) return relayEgress(req, res, entry, request)
        const result = await residents.fetch(entry, request)
        // What qwen.ai answered, beyond the status (Qwen2API-0c6): a challenge page, a refusal in the body, the headers and the start of a body that is no 2xx.
        log('egress', `${new URL(request.url).pathname} -> ${result.status} (${residents.stats().residentPages}/${config.maxPages} pages)` +
            (CHALLENGE_NOTE[result.challenge] || '') + answerNote(result))
        return result
    }

    /**
     * The streaming /egress: what the page reports, written out as it comes
     * in. One JSON event per line:
     *
     *   {"type":"head","status":200,"url":"…","redirected":false,"headers":{…},"cookies":[…]}
     *   {"type":"chunk","data":"<base64 of the bytes qwen.ai just delivered>"}
     *   {"type":"end","cookies":[…]}
     *   {"type":"error","code":"egress_timeout","message":"…"}
     *
     * Nothing is written until qwen.ai answered: whatever goes wrong before
     * that is an ordinary error status, with the codes /egress always had.
     * After it the status is spent, so a failure travels as the last event.
     *
     * The app cancelling is it closing the connection — the body of its own
     * request is long gone by then. That ends the stream here AND the request
     * in the page (resident-pages.js#abort): a request already running there is
     * beyond a Node-side timer, let alone a socket this process no longer holds.
     */
    async function relayEgress(req, res, entry, request) {
        const pathname = new URL(request.url).pathname
        const id = ++streamSequence
        // The app may have gone while its page was opening, before there was
        // anything to listen with: the socket says so all the same.
        let gone = req.socket.destroyed
        // The socket, not the response: under Bun a server-side response
        // never emits 'close' when its client goes.
        const onGone = () => {
            gone = true
            residents.abort(id)
        }
        req.socket.on('close', onGone)
        // The app may be gone by the time a frame is written. Not this handler's error.
        res.on('error', () => {})
        const started = Date.now()
        const frame = relayWriter(res, () => gone)
        try {
            // The app gave up while its page was opening: nothing to run.
            if (gone) return residents.release(entry)
            const result = await residents.stream(entry, request, {
                id,
                onEvent: async event => {
                    // The app left while the page was busy (reading its jar,
                    // say): nothing is written — and nothing is logged as if it were.
                    if (gone) return
                    if (event.type === 'head') {
                        res.writeHead(200, {
                            'content-type': 'application/x-ndjson',
                            'cache-control': 'no-cache',
                            'x-accel-buffering': 'no'
                        })
                        res.flushHeaders()
                        log('egress-stream',
                            `${pathname} -> ${event.status} (${Date.now() - started} ms, ` +
                            `${residents.stats().residentPages}/${config.maxPages} pages)`)
                    }
                    await frame(event)
                }
            })
            if (result.aborted) {
                log('egress-stream', `${pathname} cancelled (${Date.now() - started} ms)`)
                return
            }
            await frame({ type: 'end', cookies: result.cookies })
            res.end()
            log('egress-stream', `${pathname} end (${Date.now() - started} ms)${CHALLENGE_NOTE[result.challenge] || ''}`)
        } catch (error) {
            const code = error.code && STATUS_FOR_CODE[error.code] ? error.code : 'browser_error'
            if (!res.headersSent) {
                if (!gone) throw error
                return
            }
            log('egress-stream', `${pathname} ${code} (${Date.now() - started} ms)`)
            await frame({ type: 'error', code, message: error.message || 'Signin worker failure.' })
            res.end()
        } finally {
            req.socket.off('close', onGone)
        }
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
            // The headless mode is here to be checked after a flip, before the
            // first request that depends on it. So are the settings of
            // 2026-11-26 (Qwen2API-xun, Qwen2API-nch, Qwen2API-ops), and how
            // long the line of page loads is.
            return send(res, 200, {
                ok: true, sessions: sessions.size, ...residents.stats(),
                headless: config.headless, headlessMode: config.headless ? config.headlessMode : null,
                pageTokenRefresh: config.pageTokenRefresh, streamWaitMs: config.streamWaitMs,
                loadMinIntervalMs: config.loadMinIntervalMs, loadMaxWaitMs: config.loadMaxWaitMs,
                pageLoadQueue: pageLoads.stats()
            })
        }
        if ((req.method === 'POST' && req.url === '/session') || (req.method === 'POST' && req.url === '/renew')) {
            if (!authorized(req)) throw new WorkerError('unauthorized', 'Invalid worker token.')
            const body = await readJson(req, REQUEST_BODY_LIMIT)
            return send(res, 200, req.url === '/session' ? await handleSession(body) : await handleRenew(body))
        }
        if (req.method === 'POST' && req.url === '/egress') {
            if (!authorized(req)) throw new WorkerError('unauthorized', 'Invalid worker token.')
            const body = await readJson(req, EGRESS_BODY_LIMIT)
            // A relay answers for itself, as it goes; there is nothing left to send after it.
            if (body.stream === true) return handleEgress(req, res, body)
            return send(res, 200, await handleEgress(req, res, body))
        }
        throw new WorkerError('invalid_request', 'Unknown route.')
    }

    server.workerConfig = config
    server.workerShutdown = () => {
        // Nobody waits for a turn any more: a page that was to load is closed instead.
        halting = true
        pageLoads.stop()
        tokenRefreshes.stop()
        return residents.shutdown(config.shutdownMs)
    }
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

module.exports = { createServer, WorkerError, shutdownHandler, relayWriter }

if (require.main === module) {
    const server = createServer()
    server.listen(server.workerConfig.port, () => {
        const { headless, headlessMode } = server.workerConfig
        console.log(`${new Date().toISOString()} signin-worker listening on :${server.workerConfig.port}` +
            ` (browser: ${headless ? `headless ${headlessMode}` : 'headed'})`)
    })
    const stop = shutdownHandler(server)
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))
}
