'use strict'

/**
 * Resident page service (Qwen2API-3ue.1): one live chat.qwen.ai page per
 * ACTIVE account, kept open so qwen.ai API calls leave as in-page fetches
 * (docs/browser-egress-design.md).
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
 */

const fs = require('node:fs')
const { WorkerError } = require('./worker-errors')
const { pageFetch, CODE_FOR_OUTCOME } = require('./egress-fetch')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {object} options
 * @param {object} options.signer browser-signin (or a fake in tests)
 * @param {(email: string) => string} options.profileDir email -> userDataDir
 * @param {(email: string, harvested: object, proxy: ?string) => void} options.onHarvest a lazy open rotated the session
 * @param {(email: string, cookies: object[]) => void} options.onCookies the live jar, after a fetch or a keep-alive poll
 */
function createResidents({
    signer,
    profileDir,
    chatOrigin = 'https://chat.qwen.ai',
    headless = true,
    openTimeoutMs = 120000,
    maxPages = 16,
    keepAliveMs = 5 * 60 * 1000,
    maxBytes = 8 * 1024 * 1024,
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
    let stopped = false

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
     * The returned page is claimed (counted as in use) until fetch() runs, so
     * an eviction on another account cannot take it in between.
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
            entry.context = await signer.openContext({ dataDir: profileDir(email), proxy, headless })
            // Dropped while the browser was launching: never bring the page
            // back from under that.
            if (pages.get(email) !== entry) {
                await close(entry, 'open_aborted')
                throw new WorkerError('page_closed', 'The resident page was closed while opening.')
            }
            // browser-signin drives context.pages()[0]: keeping the first page
            // as THE resident page is what lets it reuse this context later.
            entry.page = entry.context.pages()[0] || await entry.context.newPage()
            watch(entry)
            const harvested = await signer.renew(entry.context, { chatOrigin, timeoutMs: openTimeoutMs })
            onHarvest(email, harvested, proxy)
            entry.state = 'ready'
            entry.keepAlive = setInterval(() => { keepAlive(entry) }, keepAliveMs)
            entry.keepAlive.unref?.()
            entry.lastUsed = Date.now()
            entry.inflight++
            log('resident-open', `ok (${pages.size}/${maxPages} pages)`)
            return entry
        } catch (error) {
            await close(entry, 'open_failed')
            throw error
        }
    }

    /**
     * Run a fetch on a page handed out by acquire(); consumes that claim.
     * Not under the account lock: many fetches may share one page.
     *
     * @param {object} entry
     * @param {{url: string, init: object, timeoutMs: number}} request as normalizeEgress returned it
     */
    async function fetch(entry, request) {
        let backstop = null
        try {
            let outcome
            try {
                outcome = await Promise.race([
                    entry.page.evaluate(pageFetch, { ...request, maxBytes }),
                    new Promise((resolve, reject) => {
                        // The in-page timer answers at timeoutMs. If even that
                        // never comes back, the page itself is hung.
                        backstop = setTimeout(() => reject(new WorkerError('egress_timeout',
                            'The resident page stopped responding.')), request.timeoutMs + backstopMs)
                        backstop.unref?.()
                    })
                ])
            } catch (error) {
                if (error instanceof WorkerError) {
                    close(entry, 'unresponsive')
                    throw error
                }
                // evaluate itself failed: the document left from under the
                // fetch. A page that is still registered merely navigated.
                throw new WorkerError(pages.get(entry.email) === entry ? 'browser_error' : 'page_closed',
                    'The resident page could not run the fetch.')
            } finally {
                clearTimeout(backstop)
            }
            if (!outcome.ok) {
                throw new WorkerError(CODE_FOR_OUTCOME[outcome.error] || 'egress_failed',
                    `In-page fetch failed (${outcome.error}${outcome.message ? `: ${outcome.message}` : ''}).`)
            }
            return {
                status: outcome.status,
                url: outcome.url,
                redirected: outcome.redirected,
                headers: outcome.headers,
                body: outcome.body,
                cookies: await currentCookies(entry)
            }
        } finally {
            entry.inflight--
        }
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
            return await operation(entry.context)
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

    return { acquire, fetch, exclusive, get, close: retire, whenClosed, stats, shutdown }
}

module.exports = { createResidents }
