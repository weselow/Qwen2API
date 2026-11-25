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
 * relayed while it arrives, and it may take minutes. A stream is deliberately
 * NOT an in-flight call: it does not hold the page against eviction, and a
 * renewal does not wait for it. What that costs is that a page reloaded or
 * evicted meanwhile ends its streams — they fail as page_closed, the way a
 * call does when its page dies.
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
 */

const fs = require('node:fs')
const { WorkerError } = require('./worker-errors')
const {
    pageCall, pageAbortStream, readFrontEndVersion, isChallengePage, isHtmlAnswer, CODE_FOR_OUTCOME,
    ABORT_REASON, STREAM_CHANNEL, STREAM_ABORTS, CHALLENGE_HEAD_BYTES
} = require('./egress-fetch')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    log = () => {},
    onHarvest = () => {},
    onCookies = () => {}
}) {
    // Same scope browser-signin.finish harvests.
    const cookieUrls = [new URL(chatOrigin).origin, 'https://auth.qwen.ai']
    // email -> { context, page, proxy, state: 'opening'|'ready', lastUsed, inflight, exclusive, ... }
    const pages = new Map()
    // email -> the close still in progress. Chromium holds the profile lock
    // until its process is gone, so no launch on that profile may start first.
    const closing = new Map()
    // id -> the stream now running on a page, as stream() registered it. The
    // page reports by id through the channel every page is given on opening.
    const streams = new Map()
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
     * Close the page for good, letting its in-flight fetches finish first.
     * Caller holds the account lock.
     */
    async function retire(entry, reason) {
        entry.exclusive = true
        try {
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
        const victim = [...pages.values()].filter(idle).sort((a, b) => a.lastUsed - b.lastUsed)[0]
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
     */
    async function asked(entry, question, ms) {
        let timer
        try {
            return await Promise.race([
                Promise.resolve().then(() => entry.page.evaluate(question)).catch(() => null),
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
            current.lastUsed = Date.now()
            current.inflight++
            return current
        }
        if (current) await retire(current, current.proxy === proxy ? 'unready' : 'proxy_changed')
        if (!fs.existsSync(profileDir(email))) {
            throw new WorkerError('no_profile', 'No persisted profile for this account.')
        }
        await whenClosed(email)
        await evictForSlot()
        // After the waits above and right before the browser starts: a stop
        // that landed meanwhile (shutdown drops every page it can see) must
        // not be followed by a launch it cannot see.
        if (stopped) throw new WorkerError('page_closed', 'The worker is shutting down.')
        const entry = {
            email, proxy, context: null, page: null, state: 'opening',
            lastUsed: Date.now(), inflight: 0, exclusive: false, polling: false, keepAlive: null
        }
        pages.set(email, entry)
        try {
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
            entry.inflight++
            log('resident-open', `ok (${pages.size}/${maxPages} pages, front-end ${await frontEnd(entry)})`)
            return entry
        } catch (error) {
            await close(entry, 'open_failed')
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
     * @param {object} entry
     * @param {{url: string, init: object, timeoutMs: number}} request as normalizeEgress returned it
     * @param {object} sink
     * @param {number} sink.id - What abort() names this stream by
     * @param {(event: object) => Promise<void>|void} sink.onEvent - May take its time: the page waits
     * @returns {Promise<{cookies: ?Object[], aborted: boolean, challenge?: 'page'|'network'}>} the jar
     *   at the end; `aborted` when the app went away and the request was cut
     *   for it; `challenge` when the answer was a WAF challenge page
     * @throws {WorkerError} the call's own failures, as fetch() throws them
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
        // are what a challenge page is recognised by.
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
            return { cookies: await currentCookies(entry), aborted: false, ...verdict(head?.headers, Buffer.concat(start), 'page') }
        } finally {
            clearTimeout(timer)
            streams.delete(id)
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
     * @param {object} entry
     * @param {(context: object) => Promise<object>} operation
     */
    async function exclusive(entry, operation) {
        entry.exclusive = true
        try {
            await drain(entry)
            const result = await operation(entry.context)
            // The operation reloaded the page (or signed in on it): no call
            // goes out into it before its token has settled.
            await settle(entry)
            return result
        } catch (error) {
            await close(entry, 'operation_failed')
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
