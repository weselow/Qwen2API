'use strict'

/**
 * Resident page service (Qwen2API-3ue.1): one live chat.qwen.ai page per
 * ACTIVE account, kept open so qwen.ai API calls leave from inside it, as
 * requests of the page's own (docs/browser-egress-design.md).
 *
 * The page lives in the account's persistent context (userDataDir), which
 * makes it the PROFILE OWNER: Chromium locks a userDataDir, so while a page
 * is resident nothing else may launch on that directory. That is why
 * sign-in and renewal go through exclusive() here instead of a second
 * launch.
 *
 * Every method that can launch or navigate a browser (acquire, exclusive,
 * close) must run under the caller's per-account lock; fetch() must not, so
 * calls on one page stay concurrent.
 *
 * Since Qwen2API-3ue.3 a page also carries streams (stream()): the answer is
 * relayed while it arrives, and may take minutes. A stream is deliberately
 * NOT an in-flight call: it does not hold the page against eviction. What that
 * costs is that a page evicted meanwhile ends its streams — they fail as
 * page_closed, the way a call does when its page dies.
 *
 * Since Qwen2API-nch (2026-11-26) a page that is about to navigate on purpose
 * — a renewal or a sign-in on it (exclusive), or the close before a page is
 * opened anew or on another proxy (retire) — waits first for the streams
 * running on it, up to streamWaitMs. Measured without a network, on the real
 * Chromium and with the real app: a reload cuts every call on the page at
 * once, and an answer the app had begun to hand to its client is lost to that
 * client (a stream ends in an error frame, a whole answer is a 502). Waiting
 * lets an answer finish; the request that asked for the reload waits too, and
 * so do the account's new calls, which then run on the reloaded page. An
 * eviction, which closes a page, picks one without a stream when it can.
 *
 * Also a page load takes a turn (beforeLoad; Qwen2API-nch, Qwen2API-ops): a
 * renewal and a lazy open wait for the worker's turn, so that the pages of
 * every account do not load at once. A sign-in does not wait — the login
 * pacer spaces sign-ins, and the app's budget for one accounts for that pacer
 * alone — and tells the worker's queue itself when it began (server.js).
 *
 * Since Qwen2API-xun (2026-11-26) the page's token is renewed in place before
 * a call that finds it nearly spent (freshen()): by the front end's own
 * refresh call (egress-fetch.js#pageRefreshToken), not by a reload. A reload
 * was what the app's recovery made of every call that came after fifteen
 * minutes without one — and it cut every stream on the page. A refresh that
 * does not get through (the auth host not answering) opens a circuit: for a
 * while no other page tries its own, and each call goes out at once on the
 * token it has, to the app's recovery as before.
 *
 * Since Qwen2API-3ue.6 a WAF challenge page is recognised as what it is, at
 * once. The page's own request hooks keep an answer they take for a block away
 * from the call that asked for it (that is how a challenge hung /egress for
 * 35 s on 2026-11-24, and got the page closed as unresponsive). Two things
 * see the answer regardless: the call listens with addEventListener, which
 * those hooks leave alone, and the worker watches the page's network for the
 * response (watchAnswer). A challenge is handed on as qwen.ai's answer — the
 * app classifies it — named in the log, and the page is left alone.
 *
 * Since Qwen2API-3ue.9 a stream is a fetch, as the page's own front end makes
 * its completions call (qwen.ai refused it as an XMLHttpRequest); a
 * whole-answer call is an XMLHttpRequest still. Of the two things above a
 * fetch has only the second: it is one promise, and the hooks are known to
 * keep it pending on a challenge page, and to ignore an abort through their
 * wrapper. So a challenge answered to a stream is read off the page's network,
 * and the call in the page ends from its own signal, whatever its fetch does.
 *
 * Since Qwen2API-qic (2026-11-28) a stream says, once it is over, when qwen.ai's
 * 2xx carried a refusal in the start of its body — as a whole answer's line
 * says since Qwen2API-0c6 (egress-fetch.js#streamRefusal). Nothing is kept
 * back for it: the start of the body is what stream() keeps anyway to
 * recognise a challenge page, and it is read when the call is over, never
 * while a frame waits. Seen live once, on 2026-11-24, before the stream was
 * a fetch (egress-fetch.js#streamRefusal).
 */

const fs = require('node:fs')
const { WorkerError } = require('./worker-errors')
const {
    pageCall, pageAbortStream, pageTokenState, pageRefreshToken, readFrontEndVersion, isChallengePage, isHtmlAnswer,
    CODE_FOR_OUTCOME, ABORT_REASON, STREAM_CHANNEL, STREAM_ABORTS, CHALLENGE_HEAD_BYTES, quoted, masked, streamRefusal
} = require('./egress-fetch')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// How long the page gets to say what became of its token.
const TOKEN_STATE_MS = 2000

/**
 * @param {object} options
 * @param {object} options.signer browser-signin (or a fake in tests)
 * @param {(email: string) => string} options.profileDir email -> userDataDir
 * @param {(email: string, harvested: object, proxy: ?string) => void} options.onHarvest a lazy open rotated the session
 * @param {(email: string, cookies: object[]) => void} options.onCookies the live jar, after a fetch or a keep-alive poll
 * @param {string} [options.headlessMode] which headless browser opens a page (lib/browser-identity.js)
 * @param {number} [options.maxStreamBytes] - Cap on a streamed body. 0, the default, is none
 * @param {number} [options.keptGraceMs] - How long the page gets to hand over an answer qwen.ai
 *   already gave before the worker reads it off the page's network. Default 1000
 * @param {number} [options.frontEndMs] - How long the page's opening waits for the front end's
 *   version. Default 2000
 * @param {number} [options.settleStableMs] - How long the page's token must stay the same after a
 *   (re)load before a call may go out. Default 2500
 * @param {number} [options.settlePollMs] - How often it is read meanwhile. Default 250
 * @param {number} [options.settleTimeoutMs] - How long the wait may take at most. Default 20000
 * @param {boolean} [options.pageTokenRefresh] - Whether a call first renews the page's token when it
 *   is nearly spent (Qwen2API-xun). Default true
 * @param {string} [options.authOrigin] - The auth host: where the front end's refresh call goes.
 *   Default https://auth.qwen.ai
 * @param {number} [options.tokenRefreshMarginMs] - A token with less than this left is renewed before
 *   a call. Default 180000, the front end's own margin
 * @param {number} [options.tokenRefreshTimeoutMs] - Budget of the refresh call. Default 10000
 * @param {() => Promise<void>} [options.beforeTokenRefresh] - Waits for the worker's turn before a
 *   refresh: the refreshes of every page are kept apart
 * @param {number} [options.tokenRetryMs] - After a refresh that failed, none is tried for this long.
 *   Default 30000
 * @param {number} [options.tokenReadAgainMs] - What was read of the page's token stands this long at most
 *   before it is read again. Default 60000
 * @param {number} [options.tokenRefreshCircuitMs] - After a refresh that did not get through (the auth
 *   host not answering), no other page tries its own for this long. Default 60000
 * @param {number} [options.streamWaitMs] - How long a navigation on a live page waits for the streams
 *   running on it (Qwen2API-nch). Default 20000; 0 = it does not wait
 * @param {(options: {turn: boolean}) => Promise<void>} [options.beforeLoad] - Before a page is loaded
 *   (Qwen2API-nch, Qwen2API-ops): with `turn` it waits for the worker's turn, so that the loads of
 *   every account are kept apart; without it — a sign-in, which the login pacer spaces — nothing is
 *   waited for here: the worker tells its queue of the sign-in itself, as it begins
 */
function createResidents({
    signer,
    profileDir,
    chatOrigin = 'https://chat.qwen.ai',
    headless = true,
    headlessMode = 'shell',
    openTimeoutMs = 120000,
    maxPages = 16,
    keepAliveMs = 5 * 60 * 1000,
    maxBytes = 8 * 1024 * 1024,
    maxStreamBytes = 0,
    keptGraceMs = 1000,
    frontEndMs = 2000,
    settleStableMs = 2500,
    settlePollMs = 250,
    settleTimeoutMs = 20000,
    drainMs = 5000,
    backstopMs = 5000,
    closeMs = 5000,
    pageTokenRefresh = true,
    authOrigin = 'https://auth.qwen.ai',
    tokenRefreshMarginMs = 180000,
    tokenRefreshTimeoutMs = 10000,
    beforeTokenRefresh = async () => {},
    tokenRetryMs = 30000,
    tokenReadAgainMs = 60000,
    tokenRefreshCircuitMs = 60000,
    streamWaitMs = 20000,
    beforeLoad = async () => {},
    log = () => {},
    onHarvest = () => {},
    onCookies = () => {}
}) {
    // Same scope browser-signin.finish harvests.
    const cookieUrls = [new URL(chatOrigin).origin, 'https://auth.qwen.ai']
    const authRoot = String(authOrigin).replace(/\/+$/, '')
    // email -> { context, page, proxy, state: 'opening'|'ready', lastUsed, inflight, exclusive, ... }
    const pages = new Map()
    // email -> the close still in progress. Chromium holds the profile lock
    // until its process is gone, so no launch on that profile may start first.
    const closing = new Map()
    // id -> the stream now running on a page, as stream() registered it. The
    // page reports by id through the channel every page is given on opening.
    const streams = new Map()
    // The front end's refresh does not get through from the pages behind one
    // proxy — the auth host is not answering there: until the moment kept for
    // that proxy, no other page behind it tries its own. A page behind another
    // proxy is on another road, and tries.
    const refreshDownUntil = new Map()
    let stopped = false

    // What the page calls (page -> Node) for every event of a stream. Resolves
    // once the event is written out, or right away for a stream that is gone.
    const onStreamEvent = (id, event) => {
        const live = streams.get(id)
        return live ? live.receive(event) : undefined
    }

    const idle = entry => entry.state === 'ready' && entry.inflight === 0 && !entry.exclusive

    /** Resolves once every browser this account had is fully closed. */
    const whenClosed = email => closing.get(email) || Promise.resolve()

    /** Wait for the page's in-flight fetches: a navigation destroys them. */
    async function drain(entry) {
        const deadline = Date.now() + drainMs
        while (entry.inflight > 0 && Date.now() < deadline) await sleep(25)
    }

    /**
     * Wait for the streams running on the page, up to `streamWaitMs`
     * (Qwen2API-nch): a navigation ends them, and what the app had begun to
     * hand to its client is lost to that client. Only when there is something
     * to wait for. Says how it went — the line is how a reload that waited for
     * the page's answers is told from one that cut them.
     * @param {object} entry
     * @returns {Promise<{waited: number, left: number}>} how long it waited, and how many streams were still running then
     */
    async function waitForStreams(entry) {
        if (!(streamWaitMs > 0) || entry.streams.size === 0) return { waited: 0, left: 0 }
        const started = Date.now()
        while (entry.streams.size > 0 && Date.now() - started < streamWaitMs) await sleep(25)
        const waited = Date.now() - started
        const left = entry.streams.size
        log('resident-wait', `${left ? `${left} still running` : 'ended'} (waited ${waited} ms for the page's streams)`)
        return { waited, left }
    }

    /** Remove the page from the registry and close its browser (bounded). */
    function close(entry, reason, timeoutMs = closeMs) {
        if (pages.get(entry.email) === entry) pages.delete(entry.email)
        clearInterval(entry.keepAlive)
        log('resident-close', `${reason} (${pages.size} pages)`)
        if (!entry.context) return Promise.resolve()
        let timer
        // A wedged browser must not hold up the caller: stop waiting, move on.
        const done = Promise.race([
            entry.context.close().catch(() => {}),
            new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
        ]).finally(() => { clearTimeout(timer) })
        const tracked = Promise.all([whenClosed(entry.email), done])
            .finally(() => { if (closing.get(entry.email) === tracked) closing.delete(entry.email) })
        closing.set(entry.email, tracked)
        return done
    }

    /**
     * Close the page for good, letting what runs on it finish first: its
     * streams (Qwen2API-nch), then its in-flight fetches.
     * Caller holds the account lock.
     */
    async function retire(entry, reason) {
        entry.exclusive = true
        try {
            await waitForStreams(entry)
            await drain(entry)
            await close(entry, reason)
        } finally {
            entry.exclusive = false
        }
    }

    function watch(entry) {
        // Identity first: a late 'close' from a page that was already replaced
        // must not take the new one down with it.
        const drop = reason => {
            if (pages.get(entry.email) === entry) close(entry, reason)
        }
        entry.context.on('close', () => drop('context_closed'))
        entry.page.on('close', () => drop('page_closed'))
        entry.page.on('crash', () => drop('page_crashed'))
    }

    async function keepAlive(entry) {
        if (entry.polling || pages.get(entry.email) !== entry) return
        entry.polling = true
        try {
            const cookies = await entry.context.cookies(cookieUrls)
            if (pages.get(entry.email) === entry) onCookies(entry.email, cookies)
        } catch {
            // The context no longer answers CDP and its 'close' never came.
            // One that was already dropped needs no second close.
            if (pages.get(entry.email) === entry) await close(entry, 'keepalive_failed')
        } finally {
            entry.polling = false
        }
    }

    async function currentCookies(entry) {
        try {
            const cookies = await entry.context.cookies(cookieUrls)
            onCookies(entry.email, cookies)
            return cookies
        } catch {
            // The browser died right after answering; the answer still stands.
            return null
        }
    }

    /** Make room for one more page: evict the least recently used idle one. */
    async function evictForSlot() {
        if (pages.size < maxPages) return
        // Among the idle, one with no stream running goes first, and of those
        // the least recently used (Qwen2API-nch): a page closed takes its
        // streams with it. When every idle page has one, it is the least
        // recently used of them, as it always was.
        const victim = [...pages.values()].filter(idle)
            .sort((a, b) => Number(a.streams.size > 0) - Number(b.streams.size > 0) || a.lastUsed - b.lastUsed)[0]
        if (!victim) {
            throw new WorkerError('resident_capacity', 'Every resident page is busy; none can be evicted.')
        }
        await close(victim, 'evicted')
    }

    /**
     * qwen.ai's answer to one call as the page's own network gets it, which no
     * script in the page can hold back (Qwen2API-3ue.6). The call is found by
     * the request id the worker gave it; the page's own requests carry their
     * own. Only a challenge page is reported: any other answer is the page's
     * to hand over, and the call's own timer and the backstop say when it
     * does not. An answer that is no page (JSON, a stream) is not even read:
     * a page is the only thing the page's scripts are known to keep.
     *
     * The worker gives the page `keptGraceMs` to hand a challenge over itself
     * before reading it off the network; a call whose own `timeoutMs` is
     * shorter than that ends as a timeout first.
     *
     * @param {object} entry
     * @param {{url: string, init: object}} request as normalizeEgress returned it
     * @returns {{answer: Promise<{status: number, url: string, headers: Object<string,string>, body: Buffer}>, stop: () => void}}
     *   `answer` settles once at most and never rejects; `stop` forgets the call
     */
    function watchAnswer(entry, request) {
        const marker = request.init.headers['x-request-id']
        let tell
        const answer = new Promise(resolve => { tell = resolve })
        const onResponse = response => {
            try {
                const sent = response.request()
                if (sent.method() !== request.init.method || sent.headers()['x-request-id'] !== marker) return
                const status = response.status()
                const url = response.url()
                const headers = {}
                for (const [name, value] of Object.entries(response.headers())) headers[name.toLowerCase()] = value
                // No page here: nothing to read.
                if (!isHtmlAnswer(headers)) return stop()
                // Whatever Playwright could not hand out: the page's own report is all there is.
                Promise.resolve(response.text()).then(text => {
                    const body = Buffer.from(text, 'utf8')
                    if (isChallengePage(headers, body)) tell({ status, url, headers, body })
                }, () => {})
            } catch {
                // The same for a response Playwright cannot describe.
            }
        }
        entry.page.on('response', onResponse)
        const stop = () => entry.page.off('response', onResponse)
        return { answer, stop }
    }

    /** qwen.ai's answer as the network saw it, in the shape the page reports an answer in. */
    const fromNetwork = answer => ({ ok: true, ...answer, redirected: false, body: answer.body.toString('utf8') })

    // Whether the answer was a WAF challenge page, and who got to see it:
    // 'page' — the page's scripts handed it to the call; 'network' — they kept
    // it back, and the worker read it off the page's network.
    const verdict = (headers, body, seenBy) => (isChallengePage(headers, body) ? { challenge: seenBy } : {})

    /**
     * The front end the page runs, for the log: its version, or that there was
     * none to read. Bounded and never throwing: this is for a log line, and
     * must neither hold the page's opening nor fail it.
     */
    async function frontEnd(entry) {
        const version = await asked(entry, readFrontEndVersion, frontEndMs)
        return version || 'unknown'
    }

    /**
     * What the page answers to a question, or null: if it cannot be asked,
     * does not answer, or does not answer within `ms`. A page that does not
     * answer is not what any wait here is for, and no wait may hang on it.
     * @param {object} entry
     * @param {Function} question - Runs in the page, by source
     * @param {number} ms
     * @param {*} [arg] - What the question is given
     */
    async function asked(entry, question, ms, arg) {
        let timer
        try {
            return await Promise.race([
                Promise.resolve().then(() => entry.page.evaluate(question, arg)).catch(() => null),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(null), ms)
                    timer.unref?.()
                })
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * Wait until the page's token has stopped changing. A page that has just
     * (re)loaded exchanges its token more than once as it boots (24.11, prod:
     * the old one, then one for 30 days, then one for 15 minutes — within
     * about a second), and a call made before that is over is refused as
     * unauthorized: chats/new was, 0.3 s after the page opened, and passed
     * on the same page a minute later. The app would answer that refusal
     * with a reload and a retry — into a page that has just reloaded.
     *
     * Bounded, and it says nothing of which token a renewal harvested: that
     * stays the first stable one, as before. A page that cannot be asked, or
     * shows no token, is not waited for: nothing here is what deals with that.
     */
    async function settle(entry) {
        const deadline = Date.now() + settleTimeoutMs
        let previous
        let since = Date.now()
        while (Date.now() < deadline) {
            const token = await asked(entry, () => localStorage.getItem('token'), deadline - Date.now())
            if (typeof token !== 'string' || !token) return
            if (token !== previous) {
                previous = token
                since = Date.now()
            } else if (Date.now() - since >= settleStableMs) {
                return
            }
            await sleep(settlePollMs)
        }
    }

    /**
     * The page's token, made young enough for a call (Qwen2API-xun). The Bearer
     * of a call is the page's own (egress-fetch.js#pageCall), an access token
     * of fifteen minutes, and the page's front end renews it only for a
     * request of its own — never on a timer. So a page only the worker talks
     * to keeps an expired token, and qwen.ai refuses the first call that comes
     * after it ran out; the app answers that with a reload of the page, which
     * costs that request about five seconds and cuts every stream on the page.
     *
     * Here the call the front end makes for its token is made for it instead,
     * and no page is reloaded: before a call, when the token has less than
     * `tokenRefreshMarginMs` left (the front end's own margin). What was read
     * of the page's token lately stands for a minute, or exactly as long as it
     * leaves that margin — one question to the page per call at most.
     *
     * A refresh that fails costs the call its time and nothing else: the call
     * goes out on the token there is, and a refusal is the app's recovery's to
     * answer, as it was before (a reload, a retry). One refresh that failed is
     * not followed by another for `tokenRetryMs`, whatever calls arrive.
     *
     * Caller holds the account lock: the calls of one page wait here for one
     * refresh, and find a young token after it. Throws only `page_closed`, when
     * the worker stops while the refresh waits for its turn — the queue of
     * refreshes ends every wait then. A stop or a death while the page is
     * asked is seen by the caller as the page being gone, and said as nothing.
     *
     * A refresh that does not get through — the auth host not answering, a
     * preflight refused — is no page's own trouble: it opens a circuit for the
     * proxy the page is behind, and for `tokenRefreshCircuitMs` no other page
     * behind that proxy tries its own. Without it a host
     * that hangs would cost every page its first call a wait, one after another.
     *
     * @param {object} entry
     */
    async function freshen(entry) {
        const now = Date.now()
        if (now < entry.tokenCheckedUntil || now < entry.tokenRetryAt) return
        const downUntil = refreshDownUntil.get(entry.proxy) ?? 0
        if (now < downUntil) {
            // This page was not asked, so nothing of its token was read: it is read again when the circuit
            // closes, or in a minute at most.
            entry.tokenCheckedUntil = now + Math.min(downUntil - now, tokenReadAgainMs)
            return
        }
        const state = await asked(entry, pageTokenState, TOKEN_STATE_MS)
        const left = Number.isFinite(state?.msLeft) ? state.msLeft : null
        // How long this reading stands: a minute, or exactly as long as it leaves the margin.
        entry.tokenCheckedUntil = Date.now() + (left === null ? tokenReadAgainMs : Math.max(0, Math.min(left - tokenRefreshMarginMs, tokenReadAgainMs)))
        if (left === null || left >= tokenRefreshMarginMs) return
        // The queue of refreshes ends every wait when the worker stops, so no page is asked for a worker that is closing it.
        const queuedAt = Date.now()
        await beforeTokenRefresh()
        const queued = Date.now() - queuedAt
        const wait = queued ? `, after a wait of ${queued} ms` : ''
        const started = Date.now()
        const answer = await asked(entry, pageRefreshToken, tokenRefreshTimeoutMs + backstopMs, {
            url: `${authRoot}/api/v2/auths/refresh`, timeoutMs: tokenRefreshTimeoutMs, sourceId: 'signin-worker'
        })
        // The worker stopped while the page was asked — it drops every page it has, at once —
        // or the page died under the question, a crash: either way it is gone from the registry.
        // Its closing is no failure of the refresh, and is not said as one; the caller sees that
        // the page is gone.
        if (pages.get(entry.email) !== entry) return
        const took = Date.now() - started
        if (answer?.ok && Number.isFinite(answer.msLeft) && answer.msLeft > 0) {
            entry.tokenCheckedUntil = Date.now() + Math.max(0, Math.min(answer.msLeft - tokenRefreshMarginMs, tokenReadAgainMs))
            log('token-refresh', `ok (${took} ms, ${Math.round(answer.msLeft / 60000)} min left${wait})`)
            return
        }
        // Said without what qwen.ai may have put in its message beyond its code: the message is for the app's log, when the app gets the refusal itself.
        // The code is qwen.ai's, as one line of at most 80 characters, with nothing in it that looks like a credential.
        const code = answer?.code ? `, code ${quoted(masked(String(answer.code)), 80).trim()}` : ''
        const why = !answer ? 'the page did not answer'
            : answer.reason === 'refused' ? `refused, status ${answer.status}${code}`
                : String(answer.reason)
        entry.tokenRetryAt = Date.now() + tokenRetryMs
        if (answer?.reason === 'network_error' || answer?.reason === 'timeout') refreshDownUntil.set(entry.proxy, Date.now() + tokenRefreshCircuitMs)
        log('token-refresh', `failed (${why}, ${took} ms${wait})`)
    }

    /**
     * The ready page for this account, if any.
     * @param {string} email
     */
    function get(email) {
        const entry = pages.get(email)
        return entry && entry.state === 'ready' ? entry : undefined
    }

    /**
     * Hand out the account's page for a fetch, opening it on first use.
     * Opening IS a renewal: loading the chat root lets the FE settle a fresh
     * token and cookies, so the caller's session cache is refreshed too.
     *
     * The returned page is claimed (counted as in use) until fetch(), stream()
     * or release() runs, so an eviction on another account cannot take it in
     * between.
     *
     * Caller holds the account lock.
     * @param {string} email
     * @param {?string} proxy the account's proxy; a different one relaunches the page
     */
    async function acquire(email, proxy = null) {
        const current = pages.get(email)
        if (current && current.state === 'ready' && current.proxy === proxy) {
            // Claimed from here — not idle, so not to be evicted — while the
            // page's token is made young enough for the call (Qwen2API-xun).
            current.lastUsed = Date.now()
            current.inflight++
            try {
                if (pageTokenRefresh) await freshen(current)
            } catch (error) {
                current.inflight--
                throw error
            }
            if (pages.get(email) === current && current.state === 'ready') return current
            // Dropped while its token was seen to — a crash, a stop: whatever dropped it closed it.
            current.inflight--
            if (stopped) throw new WorkerError('page_closed', 'The worker is shutting down.')
        }
        // A page still registered is retired, letting what runs on it finish; one already dropped was closed by whatever dropped it.
        if (current && pages.get(email) === current) await retire(current, current.proxy === proxy ? 'unready' : 'proxy_changed')
        if (!fs.existsSync(profileDir(email))) {
            throw new WorkerError('no_profile', 'No persisted profile for this account.')
        }
        await whenClosed(email)
        await evictForSlot()
        // After the waits above and right before the page is registered: a
        // stop that landed meanwhile (shutdown drops every page it can see)
        // must not be followed by a launch it cannot see.
        if (stopped) throw new WorkerError('page_closed', 'The worker is shutting down.')
        const entry = {
            email, proxy, context: null, page: null, state: 'opening',
            lastUsed: Date.now(), inflight: 0, exclusive: false, polling: false, keepAlive: null,
            // The streams now running on it, by id; what was read of its token (freshen).
            streams: new Set(), tokenCheckedUntil: 0, tokenRetryAt: 0
        }
        // Registered before it waits for its turn, so that it counts against
        // the cap meanwhile: whoever else comes while it waits sees it.
        pages.set(email, entry)
        try {
            // The page this opens is a page load like any other: it waits for
            // the worker's turn (Qwen2API-nch, Qwen2API-ops) — before a browser
            // is launched for it, so that a line of openings is not a line of
            // browsers waiting.
            await beforeLoad({ turn: true })
            // Stopping, or dropped while it waited: no browser is launched for it.
            if (stopped || pages.get(email) !== entry) throw new WorkerError('page_closed', 'The worker is shutting down.')
            entry.context = await signer.openContext({ dataDir: profileDir(email), proxy, headless, headlessMode })
            // Dropped while the browser was launching: never bring the page
            // back from under that.
            if (pages.get(email) !== entry) {
                await close(entry, 'open_aborted')
                throw new WorkerError('page_closed', 'The resident page was closed while opening.')
            }
            // browser-signin drives context.pages()[0]: keeping the first page
            // as THE resident page is what lets it reuse this context later.
            entry.page = entry.context.pages()[0] || await entry.context.newPage()
            // The channel the page's streams report on. Exposed once per page
            // here, under the account lock, and it survives the navigations
            // sign-in and renewal make.
            await entry.page.exposeFunction(STREAM_CHANNEL, onStreamEvent)
            watch(entry)
            const harvested = await signer.renew(entry.context, { chatOrigin, timeoutMs: openTimeoutMs })
            await settle(entry)
            onHarvest(email, harvested, proxy)
            entry.state = 'ready'
            entry.keepAlive = setInterval(() => { keepAlive(entry) }, keepAliveMs)
            entry.keepAlive.unref?.()
            entry.lastUsed = Date.now()
            // Claimed for the caller from here — not idle, so not to be
            // evicted — while its token is made young enough (Qwen2API-xun).
            entry.inflight++
            try {
                if (pageTokenRefresh) await freshen(entry)
            } catch (error) {
                entry.inflight--
                throw error
            }
            const front = await frontEnd(entry)
            // Dropped while its token was renewed or its front end read — a
            // crash, or the worker stopping: closed already, and no page to call on.
            if (pages.get(email) !== entry) {
                entry.inflight--
                throw new WorkerError('page_closed', 'The resident page was closed while opening.')
            }
            log('resident-open', `ok (${pages.size}/${maxPages} pages, front-end ${front})`)
            return entry
        } catch (error) {
            // Stopping: the shutdown under way is what closes this page, and
            // a line about a page that died would say what did not happen.
            if (stopped) throw new WorkerError('page_closed', 'The worker is shutting down.')
            // Dropped by whatever closed it — a crash: its close ran, and said
            // why. It is not said to have died a second time.
            if (pages.get(email) === entry) await close(entry, 'open_failed')
            throw error
        }
    }

    /**
     * Run a whole-answer call on a page handed out by acquire(); consumes that
     * claim. Not under the account lock: many calls may share one page.
     *
     * @param {object} entry
     * @param {{url: string, init: object, timeoutMs: number}} request as normalizeEgress returned it
     * @returns {Promise<{status: number, url: string, redirected: boolean, headers: Object<string,string>,
     *   body: string, cookies: ?Object[], challenge?: 'page'|'network'}>} qwen.ai's answer, with
     *   `challenge` when it was a WAF challenge page
     * @throws {WorkerError} the call's own failures
     */
    async function fetch(entry, request) {
        let backstop = null
        const watch = watchAnswer(entry, request)
        try {
            const raced = await Promise.race([
                entry.page.evaluate(pageCall, { ...request, maxBytes, reasons: ABORT_REASON })
                    .then(outcome => ({ outcome }), error => ({ error })),
                new Promise(resolve => {
                    // The in-page timer answers at timeoutMs. If even that
                    // never comes back, the page itself is hung.
                    backstop = setTimeout(() => resolve({ hung: true }), request.timeoutMs + backstopMs)
                    backstop.unref?.()
                }),
                // qwen.ai answered with a challenge page and the page did not
                // hand it over: its scripts are keeping it from the call.
                watch.answer.then(answer => new Promise(resolve => {
                    const grace = setTimeout(() => resolve({ kept: answer }), keptGraceMs)
                    grace.unref?.()
                }))
            ])
            if (raced.hung) {
                close(entry, 'unresponsive')
                throw new WorkerError('egress_timeout', 'The resident page stopped responding.')
            }
            if (raced.error) {
                // evaluate itself failed: the document left from under the
                // request. A page that is still registered merely navigated.
                throw new WorkerError(pages.get(entry.email) === entry ? 'browser_error' : 'page_closed',
                    'The resident page could not run the request.')
            }
            const outcome = raced.kept ? fromNetwork(raced.kept) : raced.outcome
            if (!outcome.ok) {
                throw new WorkerError(CODE_FOR_OUTCOME[outcome.error] || 'egress_failed',
                    `In-page request failed (${outcome.error}${outcome.message ? `: ${outcome.message}` : ''}).`)
            }
            return {
                status: outcome.status,
                url: outcome.url,
                redirected: outcome.redirected,
                headers: outcome.headers,
                body: outcome.body,
                ...verdict(outcome.headers, outcome.body, raced.kept ? 'network' : 'page'),
                cookies: await currentCookies(entry)
            }
        } finally {
            clearTimeout(backstop)
            watch.stop()
            entry.inflight--
        }
    }

    /** Give back a page handed out by acquire() without running a call on it. */
    function release(entry) {
        entry.inflight--
    }

    /**
     * Run a streaming call on a page handed out by acquire(); consumes that
     * claim at once, for the reason the module comment gives.
     *
     * The page reports through its channel while the body arrives; what it
     * reports is handed to `onEvent` in order, and only once the previous one
     * was written out — that promise is the page's hold-back. The promise
     * here settles when the body is over. The head event carries the jar as
     * of the response head, the result the jar as of the end. Not under the
     * account lock.
     *
     * A challenge page the page's scripts kept from the call is relayed by
     * the worker itself, from what the page's network saw: whole, the way the
     * page relays an answer that is a page. A stream is a fetch since
     * Qwen2API-3ue.9, and a promise kept pending is how those scripts hold a
     * fetch back: the call is cut below, and ends with that, whatever its
     * fetch does afterwards.
     *
     * Since Qwen2API-qic (2026-11-28) a 2xx answer whose head says JSON is
     * read for a refusal in the start of its body once the call is over — off
     * what was kept to recognise a challenge page, so no frame waits on it. It
     * is `refusal` on the result, and on the error thrown when the call fails
     * after such an answer.
     *
     * @param {object} entry
     * @param {{url: string, init: object, timeoutMs: number}} request as normalizeEgress returned it
     * @param {object} sink
     * @param {number} sink.id - What abort() names this stream by
     * @param {(event: object) => Promise<void>|void} sink.onEvent - May take its time: the page waits
     * @returns {Promise<{cookies: ?Object[], aborted: boolean, challenge?: 'page'|'network',
     *   refusal?: {code: string, note: string}}>} the jar at the end; `aborted` when the app went
     *   away and the request was cut for it; `challenge` when the answer was a WAF challenge page;
     *   `refusal` when qwen.ai's 2xx carried a refusal in the start of its body (Qwen2API-qic)
     * @throws {WorkerError} the call's own failures, as fetch() throws them — with `refusal` on
     *   it when the call failed after a 2xx answer that began as one (Qwen2API-qic)
     */
    async function stream(entry, request, { id, onEvent }) {
        let timer = null
        let fire = null
        // The page's own timer cuts a silent upstream at timeoutMs and says
        // so. Silence past that plus a grace means nothing came back at all:
        // the page itself is hung.
        const hung = new Promise((resolve, reject) => {
            fire = () => reject(new WorkerError('egress_timeout', 'The resident page stopped responding.'))
        })
        const arm = () => {
            clearTimeout(timer)
            timer = setTimeout(fire, request.timeoutMs + backstopMs)
            timer.unref?.()
        }
        // The answer as relayed so far: its head and the start of its body
        // are what a challenge page is recognised by — and, of a 2xx that says
        // JSON, a refusal in the body (Qwen2API-qic).
        let head = null
        const start = []
        let startBytes = 0
        const live = {
            entry,
            receive: async event => {
                // The page just proved it is alive — and cannot report again
                // until this event is acknowledged, so the watch starts over
                // only once the app has taken it.
                clearTimeout(timer)
                entry.lastUsed = Date.now()
                try {
                    // The jar as of the response head: its Set-Cookie is in the browser by now.
                    if (event.type === 'head') {
                        head = event
                        event = { ...event, cookies: await currentCookies(entry) }
                    } else if (event.type === 'chunk' && startBytes < CHALLENGE_HEAD_BYTES) {
                        const bytes = Buffer.from(event.data, 'base64').subarray(0, CHALLENGE_HEAD_BYTES - startBytes)
                        start.push(bytes)
                        startBytes += bytes.length
                    }
                    return await onEvent(event)
                } finally {
                    arm()
                }
            }
        }
        streams.set(id, live)
        // Running on the page from here: what a navigation on it waits for (Qwen2API-nch).
        entry.streams.add(id)
        entry.inflight--
        arm()
        const watch = watchAnswer(entry, request)
        // What the page ends up saying, however it ends: a value either way,
        // so the race below can only reject from the backstop. Deferred by a
        // microtask, so that even a page.evaluate throwing outright is caught.
        const running = Promise.resolve().then(() => entry.page.evaluate(pageCall, {
            ...request, maxBytes: maxStreamBytes, channel: STREAM_CHANNEL, registry: STREAM_ABORTS, id, reasons: ABORT_REASON
        })).then(outcome => ({ outcome }), error => ({ error }))
        try {
            let settled
            try {
                settled = await Promise.race([running, hung, watch.answer.then(answer => new Promise(resolve => {
                    // The page had its moment. Once it relayed anything of this
                    // answer it is not keeping the answer back, and the answer is
                    // its to finish.
                    const grace = setTimeout(() => { if (!head) resolve({ kept: answer }) }, keptGraceMs)
                    grace.unref?.()
                }))])
            } catch (error) {
                // Only the backstop gets here: the page stopped responding.
                close(entry, 'unresponsive')
                throw error
            }
            if (settled.kept) {
                // The call in the page is over, whether its scripts know it or
                // not: its request is cut now, not when its own timer runs out.
                await abort(id)
                // Nothing the page reports from here on is relayed: the answer is out.
                streams.delete(id)
                entry.streams.delete(id)
                const { body, ...head } = settled.kept
                await live.receive({ type: 'head', ...head })
                await live.receive({ type: 'chunk', data: body.toString('base64') })
                return { cookies: await currentCookies(entry), aborted: false, challenge: 'network' }
            }
            if (settled.error) {
                // evaluate itself failed: the document left from under the
                // request. A page that is still registered merely navigated.
                throw new WorkerError(pages.get(entry.email) === entry ? 'browser_error' : 'page_closed',
                    'The resident page could not run the request.')
            }
            const { outcome } = settled
            if (!outcome.ok && outcome.error === 'aborted') return { cookies: null, aborted: true }
            if (!outcome.ok) {
                throw new WorkerError(CODE_FOR_OUTCOME[outcome.error] || 'egress_failed',
                    `In-page request failed (${outcome.error}${outcome.message ? `: ${outcome.message}` : ''}).`)
            }
            // Read once the body is over (Qwen2API-qic): no frame ever waited for it.
            const refusal = streamRefusal(head, start)
            return {
                cookies: await currentCookies(entry), aborted: false,
                ...verdict(head?.headers, Buffer.concat(start), 'page'),
                ...(refusal ? { refusal } : {})
            }
        } catch (error) {
            // What a 2xx answer began as is said of a stream that ends with an error all the same
            // (Qwen2API-qic): it travels on the error, for the line and the error event
            // (server.js#relayEgress).
            const refusal = streamRefusal(head, start)
            if (refusal && error && typeof error === 'object') error.refusal = refusal
            throw error
        } finally {
            clearTimeout(timer)
            streams.delete(id)
            entry.streams.delete(id)
            watch.stop()
        }
    }

    /**
     * Cut a running stream short: the app that asked for it is gone. Reaches
     * the request inside the page through the AbortController it registered —
     * a request already running there is beyond a Node-side timer, let alone a
     * destroyed socket. Resolves once the request was made; a page that
     * cannot take it (navigating, closing) is losing the request anyway.
     * @param {number} id as given to stream()
     */
    async function abort(id) {
        const live = streams.get(id)
        if (!live) return false
        return live.entry.page.evaluate(pageAbortStream, {
            registry: STREAM_ABORTS, id, reason: ABORT_REASON.cancelled
        }).catch(() => false)
    }

    /**
     * Run a sign-in or renewal on the resident page. Caller holds the account
     * lock. In-flight fetches get a moment to finish first, and a failed
     * operation closes the page: its state is unknown afterwards, and the
     * next fetch reopens it from the profile.
     *
     * Since Qwen2API-nch (2026-11-26) the streams running on the page are
     * waited for first (up to streamWaitMs): a navigation ends them. And a
     * renewal, a page load, waits for the worker's turn like every other. All
     * that the page is the account's: its calls that arrive meanwhile wait on
     * the lock, and run on the page as it is afterwards, and the page is not
     * evicted while the navigation waits. A sign-in does not wait for the turn
     * (the login pacer spaces sign-ins); the worker's queue is told of it by the
     * worker itself, as it begins.
     *
     * @param {object} entry
     * @param {(context: object) => Promise<object>} operation
     * @param {{turn?: boolean}} [options] - `turn` false: the operation is a sign-in
     */
    async function exclusive(entry, operation, { turn = true } = {}) {
        entry.exclusive = true
        try {
            await waitForStreams(entry)
            await drain(entry)
            // Dropped while it waited for the page — a crash, a keep-alive that found the context gone:
            // closed already, and there is no page left to take a turn for.
            if (pages.get(entry.email) !== entry) throw new WorkerError('page_closed', 'The resident page was closed before its navigation.')
            await beforeLoad({ turn })
            // Dropped while it waited for its turn: the same.
            if (pages.get(entry.email) !== entry) throw new WorkerError('page_closed', 'The resident page was closed before its navigation.')
            const result = await operation(entry.context)
            // The operation reloaded the page (or signed in on it): no call
            // goes out into it before its token has settled.
            await settle(entry)
            // A new document: whatever was read of the page's token was the old one's.
            entry.tokenCheckedUntil = 0
            entry.tokenRetryAt = 0
            return result
        } catch (error) {
            // Stopping, or dropped by whatever closed it: the page is not said
            // to have died here — a line about it would say what did not happen.
            if (!stopped && pages.get(entry.email) === entry) await close(entry, 'operation_failed')
            throw error
        } finally {
            entry.exclusive = false
        }
    }

    function stats() {
        const entries = [...pages.values()]
        return {
            residentPages: entries.filter(entry => entry.state === 'ready').length,
            maxResidentPages: maxPages
        }
    }

    /**
     * Container stop. Chromium flushes a profile (auth cookies, localStorage)
     * on a clean close, so resident browsers are closed rather than abandoned.
     * @param {number} budgetMs total time to spend before giving up on stragglers
     */
    async function shutdown(budgetMs = 8000) {
        stopped = true
        const deadline = Date.now() + budgetMs
        const entries = [...pages.values()]
        // Stop admitting work first; in-flight fetches then get to answer.
        for (const entry of entries) {
            pages.delete(entry.email)
            clearInterval(entry.keepAlive)
        }
        // At most half the budget: whatever is still running by then is long
        // (a stream), and the clean close is what must fit before SIGKILL.
        const answering = Math.min(deadline, Date.now() + budgetMs / 2)
        while (Date.now() < answering && entries.some(entry => entry.inflight > 0)) await sleep(25)
        if (entries.length) log('resident-shutdown', `closing ${entries.length} page(s)`)
        const left = Math.max(0, deadline - Date.now())
        await Promise.all(entries.map(entry => close(entry, 'shutdown', left)))
    }

    return { acquire, fetch, stream, abort, release, exclusive, get, close: retire, whenClosed, stats, shutdown }
}

module.exports = { createResidents }
