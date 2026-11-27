'use strict'

/* global document, location, XMLHttpRequest */

/**
 * In-page calls for the resident pages (Qwen2API-3ue.1) and the validation
 * that feeds them. The point of running the call inside the page is that the
 * browser's own TLS fingerprint and its live cookie jar are what upstream
 * sees — see docs/browser-egress-design.md.
 *
 * Since Qwen2API-3ue.5 the call is an XMLHttpRequest carrying the page's own
 * headers, sent the way the page's own code sends its API requests. On
 * 2026-11-24 a fetch with nothing but content-type was answered with a WAF
 * challenge page under status 200, and the same call made that way was
 * answered with JSON. Which single header matters was not isolated; the call
 * carries all of them.
 *
 * Since Qwen2API-3ue.9 (2026-11-25) that is the whole-answer call alone
 * (chats/new), which stays an XMLHttpRequest because it passes. The streaming
 * one (completions) is a fetch again, made as the page's own front end makes
 * its: on prod qwen.ai's risk control refused the call as an XMLHttpRequest —
 * status 200 with the punish envelope FAIL_SYS_USER_VALIDATE / RGV587_ERROR,
 * or an HTML challenge page — where a fetch from the same page passed (HTTP
 * 200, SSE, the model answered). The body and x-accel-buffering: no did not
 * rescue the XMLHttpRequest, nor did the Baxia signature; why the server
 * tells two calls with the same headers apart is not known.
 *
 * Since Qwen2API-xun and Qwen2API-0c6 (2026-11-26) the module also carries
 * what is the page's own about its token — how long it has left, and the
 * front end's call that renews it without a reload (pageTokenState,
 * pageRefreshToken) — and what the log quotes of a whole answer that qwen.ai
 * refused (answerNote).
 */

const crypto = require('node:crypto')
const { WorkerError } = require('./worker-errors')

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MIN_TIMEOUT_MS = 100
// RFC 9110 token.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// What a browser accepts in a header value: tab and Latin-1 printables.
const HEADER_VALUE = /^[\t\x20-\xff]*$/

const invalid = message => new WorkerError('invalid_request', message)

// What the page's own requests carry that a caller may leave out on a
// whole-answer call. The front end's client sends its XHRs with axios's
// defaults and `source: web`. The same values are written out in pageCall:
// that function reaches the page as source text and can read nothing from
// this module. (A stream's defaults are the page's own completions call's,
// written out where the stream is made.)
const PAGE_HEADERS = { accept: 'application/json, text/plain, */*', source: 'web' }

/**
 * Runs INSIDE the page: the front end's version, read off the address its
 * scripts load from (…/qwen-chat-fe/0.3.50/…). Empty when it cannot be read.
 */
function readFrontEndVersion() {
    const source = Array.from(document.scripts, script => script.src || '')
        .find(src => /qwen-chat-fe\/\d+\.\d+\.\d+\//.test(src))
    return (source && /qwen-chat-fe\/(\d+\.\d+\.\d+)\//.exec(source) || [])[1] || ''
}

/**
 * Runs INSIDE the page. page.evaluate serializes this function by source, so
 * it must not reference anything from this module.
 *
 * One function for both kinds of call: given `channel`, the answer is relayed
 * while it arrives (the streaming /egress, Qwen2API-3ue.3); without one, it is
 * returned once it is whole. They differ in how the request is made, and not
 * in what it carries — which is why they are one function.
 *
 * How the request is made:
 *
 * - A whole answer: an XMLHttpRequest, subscribed with addEventListener. The
 *   page's request hooks (baxiaCommon.js 2.5.37) keep a script from seeing an
 *   answer they take for a block by never calling its onload, onloadend and
 *   onreadystatechange PROPERTIES; a listener added with addEventListener is
 *   called all the same. So a challenge page reaches the worker as an answer,
 *   instead of leaving the call hanging (Qwen2API-3ue.6). readyState is never
 *   read for the same reason: its getter is one of the hooks'.
 * - A stream: a fetch, the way the page's own front end makes its completions
 *   call (Qwen2API-3ue.9, 2026-11-25). Observed on prod, from one headless
 *   page of one account, one call at a time: the page's own call (a fetch)
 *   passed, and so did ours as a fetch with its headers; ours as an
 *   XMLHttpRequest was refused — an HTML challenge page — with the worker's
 *   simplified body or with the page's own body and x-accel-buffering: no,
 *   with the Baxia signature or without it. The app's request was refused
 *   with status 200 and the punish envelope FAIL_SYS_USER_VALIDATE /
 *   RGV587_ERROR. Why the server tells a fetch from an XMLHttpRequest is not
 *   known; a fetch passes, an XMLHttpRequest is refused. So the stream
 *   carries what the passing call carried, in its order. The whole-answer
 *   call stays an XMLHttpRequest: it passes, and is not touched.
 *   A fetch has no events to listen to: the page's hooks are known to keep
 *   its promise pending on a challenge page, and to ignore an abort through
 *   their wrapper (2026-11-24). The call is ended from its own signal
 *   whatever the fetch does, and an answer kept from it is the worker's to
 *   read off the page's network (resident-pages.js#watchAnswer).
 * - With the page's headers. Three of them are the page's to say, so they are
 *   read here and not passed in: the front end's version (off the address its
 *   scripts load from), the time zone (off the page's own clock), and the
 *   language. That last one is set, not left to the browser: the page's own
 *   requests carry 'en-US,en;q=0.9' where a request of the page's left to
 *   itself says only 'en-US' (both on 2026-11-24, prod). A call that brings
 *   no Bearer is sent on the page's own session. A header the caller brought
 *   is sent as given.
 *
 * The browser attaches the profile's cookies and Chromium's TLS. The abort
 * timer lives here too: a Node-side timer cannot reach a request that is
 * already running in the page.
 *
 * `timeoutMs` is a budget of SILENCE for a relay, not for the whole call: a
 * stream may legitimately run for minutes, and every piece upstream delivers
 * re-arms the timer. The app's turn is not silence: while it has not taken a
 * report nothing more is reported, and the timer waits.
 *
 * `maxBytes` caps the body. 0 is no cap — a stream's default.
 *
 * A text/html answer is a page, not data. Relayed, it goes out whole at the
 * end rather than as it arrives: the worker can then tell it from an answer
 * that is being kept back, and never relays a challenge page twice.
 */
async function pageCall({ url, init, timeoutMs, maxBytes, channel, registry, id, reasons }) {
    const streaming = Boolean(channel)
    const target = new URL(url, location.href)
    const controller = new AbortController()
    const aborts = streaming ? (globalThis[registry] || (globalThis[registry] = {})) : null
    if (aborts) aborts[id] = controller
    // The binding resident-pages.js exposed on this page, by the name it was
    // given. It takes the stream's id with every event: the page carries
    // several streams at once, and each report names its own.
    const emit = streaming ? globalThis[channel] : null

    let timer = null
    let ended = false
    let resolveEnd
    // The call is said once: the first word is its outcome, whatever comes after.
    const theEnd = new Promise(resolve => { resolveEnd = resolve })
    const end = outcome => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        if (aborts) delete aborts[id]
        resolveEnd(outcome)
    }
    const arm = () => {
        clearTimeout(timer)
        if (!ended) timer = setTimeout(() => controller.abort(reasons.timeout), timeoutMs)
    }

    // What the call carries: `defaults` where the caller brought nothing, a
    // header the caller brought as given, and then what the page is the
    // authority on, read here rather than passed in.
    const carry = defaults => {
        const headers = { ...defaults, ...init.headers }
        // Chrome's own form for a language ('en-US,en;q=0.9'): what the page's
        // requests carry, where the browser would send only the language.
        if (!('accept-language' in headers)) {
            const language = navigator.language
            headers['accept-language'] = language.includes('-') ? `${language},${language.split('-')[0]};q=0.9` : language
        }
        if (!('timezone' in headers)) {
            // The front end's own format, off the page's clock: 'Sat Nov 21 2026 19:55:52 GMT+0400'.
            const now = new Date()
            const offset = -now.getTimezoneOffset()
            const pad = value => String(value).padStart(2, '0')
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
            const zone = `GMT${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
            headers.timezone = `${days[now.getDay()]} ${months[now.getMonth()]} ${pad(now.getDate())} ${now.getFullYear()} ${clock} ${zone}`
        }
        if (!('version' in headers)) {
            const source = Array.from(document.scripts, script => script.src || '')
                .find(src => /qwen-chat-fe\/\d+\.\d+\.\d+\//.test(src))
            const version = (source && /qwen-chat-fe\/(\d+\.\d+\.\d+)\//.exec(source) || [])[1]
            if (version) headers.version = version
        }
        if (!('authorization' in headers)) {
            // A call that brings no Bearer is one of the page's own: its session's token is the page's. The app brings none (Qwen2API-jr9): every call of its goes out this way.
            let token = null
            try {
                token = localStorage.getItem('token')
            } catch { /* the page keeps none: the call goes without, as it asked */ }
            if (token) headers.authorization = `Bearer ${token}`
        }
        return headers
    }

    if (streaming) {
        // Said from the signal, not from what the fetch does next. The page's
        // request hooks are known to keep a fetch pending on a challenge page,
        // and to ignore an abort through their wrapper (2026-11-24): the call
        // is over all the same, and nothing of it waits on the fetch. An
        // answer kept that way is the worker's to see, off the page's network
        // (resident-pages.js#watchAnswer); what is still unanswered after
        // that, its backstop ends.
        controller.signal.addEventListener('abort', () => {
            end({ ok: false, error: controller.signal.reason === reasons.timeout ? 'timeout' : 'aborted' })
        }, { once: true })

        // Streaming: reports go out one at a time, each once the one before was
        // taken — a report is the page waiting for the worker to write it out.
        const aborted = new Promise(resolve => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        const report = event => Promise.race([emit(id, event), aborted])
        // Bytes travel as base64 — the channel carries strings, and a chunk may
        // cut a multi-byte character in half.
        const toBase64 = bytes => {
            let binary = ''
            for (let at = 0; at < bytes.length; at += 0x8000) {
                binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
            }
            return btoa(binary)
        }
        const tell = async event => {
            clearTimeout(timer)
            await report(event)
            arm()
        }
        // One report. False once the call is over — by an abort, or by a
        // report that could not be made: a listener that throws must not
        // leave the call hanging, and nothing would say why. The page's
        // doing, not qwen.ai's.
        const told = async event => {
            try {
                await tell(event)
            } catch (error) {
                end({ ok: false, error: 'report_failed', message: String((error && error.message) || error) })
                controller.abort()
            }
            return !ended
        }

        // On its own, and not awaited: the call is `theEnd`, and end() is
        // what says it. Every wait below is followed by a look at `ended` —
        // a fetch a hook kept pending settles when it pleases, and by then
        // nothing of its answer is the call's.
        void (async () => {
            try {
                // What the passing call carried (prod, 2026-11-25), in the
                // order it sent them in. What the caller brought that is not
                // among them goes after, as it brought it.
                const carried = carry({ accept: 'application/json', 'x-accel-buffering': 'no', 'bx-v': '2.5.36', source: 'web' })
                const sent = {}
                for (const name of ['accept', 'accept-language', 'content-type', 'authorization', 'source', 'timezone', 'version',
                    'x-accel-buffering', 'bx-v', 'x-request-id']) {
                    if (name in carried) sent[name] = carried[name]
                }
                Object.assign(sent, carried)
                arm()
                const response = await fetch(target.href, {
                    method: init.method, headers: sent, body: init.body, credentials: 'include', signal: controller.signal
                })
                if (ended) return
                // The page's hooks may add to the address; a move to another page is what a redirect is.
                const responseUrl = new URL(response.url || target.href)
                const headers = {}
                response.headers.forEach((value, name) => { headers[name] = value })
                const head = {
                    type: 'head', status: response.status, url: responseUrl.href,
                    redirected: responseUrl.origin !== target.origin || responseUrl.pathname !== target.pathname,
                    headers
                }
                // A page, not data: whole, once it is in — the head, then the page as one piece.
                const page = /text\/html/i.test(headers['content-type'] || '')
                // The head goes out before a byte of the body is read.
                if (!page && !(await told(head))) return
                const reader = response.body ? response.body.getReader() : null
                let size = 0
                const whole = []
                if (reader) {
                    for (;;) {
                        const { done, value } = await reader.read()
                        if (ended) return
                        if (done) break
                        size += value.byteLength
                        if (maxBytes && size > maxBytes) {
                            // Cut as it arrives, not after it: the request is aborted.
                            end({ ok: false, error: 'too_large', status: response.status })
                            return controller.abort()
                        }
                        if (page) {
                            whole.push(value)
                            arm()
                        } else if (!(await told({ type: 'chunk', data: toBase64(value) }))) {
                            return
                        }
                    }
                }
                if (page) {
                    const bytes = new Uint8Array(size)
                    let at = 0
                    for (const piece of whole) {
                        bytes.set(piece, at)
                        at += piece.byteLength
                    }
                    if (!(await told(head))) return
                    if (!(await told({ type: 'chunk', data: toBase64(bytes) }))) return
                }
                end({ ok: true })
            } catch (error) {
                if (ended) return
                // Stopped as an abort, and not by the call's own signal: a
                // script of the page cut the request. That is the page's doing, not the app going away — what the 'abort' event of an XMLHttpRequest says below.
                if (error && error.name === 'AbortError') return end({ ok: false, error: 'aborted_in_page' })
                // The browser's own failure: a dead connection, a blocked request.
                end({ ok: false, error: 'network_error', message: String((error && error.message) || error) })
            }
        })()
        return theEnd
    }

    const xhr = new XMLHttpRequest()
    const encoder = new TextEncoder()
    controller.signal.addEventListener('abort', () => {
        // Said before the request is aborted: abort() before send() fires no
        // event at all, and the one it fires later does not know why.
        end({ ok: false, error: controller.signal.reason === reasons.timeout ? 'timeout' : 'aborted' })
        xhr.abort()
    }, { once: true })

    const answer = () => {
        const headers = {}
        xhr.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).forEach(line => {
            const at = line.indexOf(':')
            headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
        })
        // The page's hooks may add to the address; a move to another page is what a redirect is.
        const responseUrl = new URL(xhr.responseURL || target.href)
        const redirected = responseUrl.origin !== target.origin || responseUrl.pathname !== target.pathname
        return { status: xhr.status, url: responseUrl.href, redirected, headers }
    }

    let delivered = 0
    let size = 0
    // What arrived since the last look. False once the answer is over the cap.
    const take = () => {
        let text
        try {
            text = xhr.responseText
        } catch {
            // A page hook's getter: nothing is known to have arrived. What was
            // counted so far stands — a blank read must not count it all again.
            return true
        }
        const fresh = encoder.encode(text.slice(delivered))
        delivered = text.length
        size += fresh.byteLength
        return !maxBytes || size <= maxBytes
    }
    const cutOff = () => {
        end({ ok: false, error: 'too_large', status: xhr.status })
        xhr.abort()
    }
    const onProgress = async () => {
        if (ended) return
        if (!take()) return cutOff()
    }
    const onLoad = async () => {
        if (ended) return
        if (!take()) return cutOff()
        end({ ok: true, ...answer(), body: xhr.responseText })
    }
    // A listener that throws must not leave the call hanging: the backstop is
    // 35 s away, and nothing would say why. The page's doing, not qwen.ai's.
    const guarded = listener => async () => {
        try {
            await listener()
        } catch (error) {
            end({ ok: false, error: 'report_failed', message: String((error && error.message) || error) })
        }
    }
    xhr.addEventListener('progress', guarded(onProgress))
    xhr.addEventListener('load', guarded(onLoad))
    xhr.addEventListener('error', () => end({ ok: false, error: 'network_error', message: 'network error' }))
    // The call's own aborts end the call before the request is aborted, so
    // this event means a script of the page's cut the request: not the app
    // going away, and a failure the worker names (page_fault).
    xhr.addEventListener('abort', () => end({ ok: false, error: 'aborted_in_page' }))

    try {
        const headers = carry({ accept: 'application/json, text/plain, */*', source: 'web' })
        // open() first: the page's hooks decide here whether this address is one they sign.
        xhr.open(init.method, target.href, true)
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
        arm()
        // send() is where the page's hooks step in and sign the request.
        xhr.send(init.body === undefined ? null : init.body)
    } catch (error) {
        end({ ok: false, error: 'network_error', message: String((error && error.message) || error) })
    }
    return theEnd
}

// What a stream's request was aborted for, as the page reports it back. The
// page aborts with the timeout reason itself; anything else aborted it from
// outside, which only the app going away does (resident-pages.js#abort). A
// request a script of the page cuts is not the call's abort at all: an
// XMLHttpRequest says so with its own 'abort' event, a fetch by stopping as
// an abort that is not the call's. Either ends the call as `aborted_in_page`.
const ABORT_REASON = { timeout: 'timeout', cancelled: 'cancelled' }

// Names the worker and the page know each other by. Both live on the page's
// globalThis: the channel the in-page stream reports on (an exposed binding,
// page -> Node) and the registry of the streams' AbortControllers, which is
// what lets Node abort a request that is already running in the page.
const STREAM_CHANNEL = '__qwenEgressEvent'
const STREAM_ABORTS = '__qwenEgressAborts'

/**
 * Runs INSIDE the page: abort the stream `id` if it is still running. Returns
 * whether there was one — a stream that already finished needs no abort.
 */
const pageAbortStream = ({ registry, id, reason }) => {
    const controller = globalThis[registry] && globalThis[registry][id]
    if (controller) controller.abort(reason)
    return Boolean(controller)
}

// Since Qwen2API-xun a page's token is renewed in place, by the call the page's
// own front end makes for it (pageTokenState, pageRefreshToken below). What the
// front end of 0.3.50 does was read off its main.js: the token of a call is the
// one in localStorage ("token"); it is an access token of 15 minutes; the front
// end trades it for a new one by GET /api/v2/auths/refresh on the auth host,
// by XMLHttpRequest with the session's cookies and no Bearer, and writes the
// answer with one function (IC) to three places at once — the state it reads
// first ("qwen_access_token_state"), and the two keys it falls back on. It
// makes that call only for a request of its own, when the token has less than
// three minutes left, or after it was refused as unauthorized: never on a
// timer. So a page that only the worker talks to keeps an expired token until
// qwen.ai refuses a call for it.
//
// Read again on 2026-11-27, off main.js of 0.3.51, 0.3.52, 0.3.53 and 0.3.54:
// the call, the margin and the writer are the same in all of them under other
// names (the interceptor nV, the writer FC; compared piece by piece, the names
// set aside). One thing had been read wrong in 0.3.50. Its interceptor sets
// x-request-origin — the origin of the page itself — on what goes to /auths/*
// and on three other auth paths (/users/logout/, /users/reset/password,
// /oauth/), and on nothing else; it was taken to set it on everything but
// those. So the refresh the worker made went out without the header the front
// end's own carries, and qwen.ai refused it each time it was tried live
// (2026-11-27: status 200, code Bad_Request) — as it had refused a refresh
// without the front end's headers on 2026-11-21 ("Invalid request header" →
// "Missing origin", docs/et0-live-integration-2026-11-21.md). That the header
// is what it wanted is what the live check of the next rollout is for.

// The two functions below run in the page as their source, and carry the names
// the front end keeps its token under as literals: the state it reads first
// ("qwen_access_token_state"), the token ("token"), its expiry ("at_expire_time"),
// and the mark of a session logged out ("qwen_token_logged_out_marker").

/**
 * Runs INSIDE the page. page.evaluate serializes this function by source, so
 * it must not reference anything from this module.
 *
 * The page's token and how long it has left, read the way the front end's kC
 * reads it: the state first, then the two keys it wrote before it kept a state.
 * The token itself stays in the page.
 *
 * @returns {{present: boolean, msLeft: number|null, expiresAt: number|null, source: 'state'|'keys'|'jwt'|'none'}}
 *   `present` false when the page keeps no token; `msLeft` null when how long
 *   it lasts cannot be read
 */
function pageTokenState() {
    const read = name => {
        try {
            return localStorage.getItem(name)
        } catch {
            return null
        }
    }
    const expOf = token => {
        const part = String(token || '').split('.')[1]
        if (!part) return null
        try {
            const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
            return Number.isFinite(payload.exp) ? payload.exp * 1000 : null
        } catch {
            return null
        }
    }
    let token = null
    let expiresAt = null
    let source = 'none'
    try {
        const state = JSON.parse(read('qwen_access_token_state') || 'null')
        if (state && typeof state.token === 'string' && state.token && Number.isFinite(state.expiresAt)) {
            token = state.token
            expiresAt = state.expiresAt
            source = 'state'
        }
    } catch { /* no state, or none that reads: the two keys below */ }
    if (!token) {
        token = read('token')
        const written = Number(read('at_expire_time'))
        if (token && written > 0) {
            expiresAt = written
            source = 'keys'
        }
    }
    if (!token) return { present: false, msLeft: null, expiresAt: null, source: 'none' }
    if (!expiresAt || expiresAt <= 0) {
        expiresAt = expOf(token)
        source = 'jwt'
    }
    return { present: true, expiresAt, msLeft: expiresAt ? expiresAt - Date.now() : null, source }
}

/**
 * Runs INSIDE the page. page.evaluate serializes this function by source, so
 * it must not reference anything from this module.
 *
 * The front end's own token refresh (main.js of 0.3.50, performHttpRefresh and
 * the request interceptor SV; the same in 0.3.51, 0.3.52, 0.3.53 and 0.3.54,
 * where the interceptor is nV): a GET on the auth host — another origin than the
 * chat's, so the session's cookies ride along by `withCredentials` and the
 * browser asks the host first whether it may send these headers — made as an
 * XMLHttpRequest, with no Bearer and no body. Of its headers, what every
 * request of the page's own API client carries; Content-Type is not among them,
 * as axios drops it from a request that has no body. And x-request-origin, the
 * page's own origin: the interceptor sets it on what goes to /auths/* and on
 * three other auth paths, on nothing else (read the other way round on
 * 2026-11-26; see above). A fresh access token is the answer; it is written
 * the way the front end's IC writes one, so that the front end's own requests
 * find it too. Listened to with addEventListener, as
 * pageCall listens: the page's request hooks are known to hold an answer back
 * from the onload PROPERTIES.
 *
 * Nothing here goes through the front end's own interceptors, so what they do
 * on a refusal — clear the token, mark the session logged out — is not done:
 * the token stays as it was, and the worker decides (resident-pages.js).
 *
 * @param {object} options
 * @param {string} options.url - The refresh call's address
 * @param {number} options.timeoutMs
 * @param {string} options.sourceId - What the written state names as its source
 * @returns {Promise<object>} `{ ok: true, status, expiresAt, msLeft }` when the page now holds a
 *   token with time left; else `{ ok: false, status, code, reason, message? }` with `reason` one of
 *   'refused' (qwen.ai answered, and not with a token), 'network_error', 'timeout', 'aborted',
 *   'page_error'. `tookMs` always. The token is never in it.
 */
function pageRefreshToken({ url, timeoutMs, sourceId }) {
    return new Promise(resolve => {
        const started = Date.now()
        let settled = false
        const end = result => {
            if (settled) return
            settled = true
            resolve({ ...result, tookMs: Date.now() - started })
        }
        const expOf = token => {
            const part = String(token || '').split('.')[1]
            if (!part) return null
            try {
                const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
                return Number.isFinite(payload.exp) ? payload.exp * 1000 : null
            } catch {
                return null
            }
        }
        const uuid = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
            ? globalThis.crypto.randomUUID()
            : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
                const roll = 16 * Math.random() | 0
                return (char === 'x' ? roll : 3 & roll | 8).toString(16)
            })
        // What the page's own requests carry (SV), and what the page is the authority on.
        const headers = () => {
            let locale = null
            try {
                locale = localStorage.getItem('locale')
            } catch { /* the page keeps no locale of its own */ }
            locale = locale || navigator.language || 'en-US'
            const withVersion = Array.from(document.scripts, script => script.src || '')
                .find(src => /qwen-chat-fe\/\d+\.\d+\.\d+\//.test(src))
            const version = withVersion && /qwen-chat-fe\/(\d+\.\d+\.\d+)\//.exec(withVersion)?.[1]
            const sent = {
                accept: 'application/json',
                'accept-language': `${locale},${locale.split('-')[0]};q=0.9`,
                source: 'web',
                // The front end's own form: the date's string without the zone's name in brackets.
                timezone: new Date().toString().replace(/\s*\(.+\)$/, ''),
                'x-request-id': uuid(),
                // Which page asks: the interceptor sets this on what goes to /auths/* and three
                // other auth paths, on nothing else. The page says it of itself, wherever it is.
                'x-request-origin': globalThis.location.origin
            }
            if (version) sent.version = version
            return sent
        }
        let xhr
        try {
            xhr = new XMLHttpRequest()
        } catch (error) {
            return end({ ok: false, status: 0, code: null, reason: 'page_error', message: String((error && error.message) || error) })
        }
        xhr.addEventListener('load', () => {
            const status = xhr.status
            let text = ''
            try {
                text = xhr.responseText
            } catch { /* a hook's getter: nothing is known to have arrived */ }
            let payload = null
            try {
                payload = JSON.parse(text)
            } catch { /* not JSON: a page, or nothing */ }
            const data = payload && typeof payload === 'object' ? payload.data : null
            const code = (payload && typeof payload === 'object'
                ? [payload.code, payload.data?.code, payload.error?.code, payload.error]
                : []).find(value => typeof value === 'string' && value) || null
            const token = data && typeof data === 'object' ? data.access_token : null
            if (status >= 200 && status < 300 && payload?.success === true && typeof token === 'string' && token) {
                const expiresAt = Number.isFinite(data.expires_at) && data.expires_at > 0
                    ? data.expires_at * 1000
                    : (expOf(token) || Date.now() + 900000)
                if (expiresAt <= Date.now()) {
                    return end({ ok: false, status, code, reason: 'refused', message: 'the token is already spent' })
                }
                try {
                    // Written as the front end's own writer does (IC, main.js 0.3.50), in its
                    // order: the state first — it is what the front end reads the token from.
                    localStorage.setItem('qwen_access_token_state', JSON.stringify({
                        version: 1, stateId: uuid(), token, expiresAt, updatedAt: Date.now(), sourceId
                    }))
                    localStorage.setItem('token', token)
                    localStorage.setItem('at_expire_time', String(expiresAt))
                    localStorage.removeItem('qwen_token_logged_out_marker')
                } catch (error) {
                    return end({ ok: false, status, code: null, reason: 'page_error', message: String((error && error.message) || error) })
                }
                return end({ ok: true, status, expiresAt, msLeft: expiresAt - Date.now() })
            }
            const said = data && typeof data === 'object' ? (data.details || data.message) : null
            end({
                ok: false, status, code, reason: 'refused',
                ...(said || payload?.message ? { message: String(said || payload.message).slice(0, 200) } : {})
            })
        })
        xhr.addEventListener('error', () => end({ ok: false, status: 0, code: null, reason: 'network_error' }))
        xhr.addEventListener('abort', () => end({ ok: false, status: 0, code: null, reason: 'aborted' }))
        xhr.addEventListener('timeout', () => end({ ok: false, status: 0, code: null, reason: 'timeout' }))
        try {
            xhr.open('GET', url, true)
            // Another origin than the page's: the session's cookies go with it only when asked for.
            xhr.withCredentials = true
            xhr.timeout = timeoutMs
            for (const [name, value] of Object.entries(headers())) xhr.setRequestHeader(name, value)
            xhr.send()
        } catch (error) {
            end({ ok: false, status: 0, code: null, reason: 'page_error', message: String((error && error.message) || error) })
        }
    })
}

// What the page reported -> worker error code. Anything else is a network
// failure on the browser side. `page_fault`: a script of the page cut the
// request or broke its reporting — the page's doing, neither qwen.ai's nor
// the account's, and retryable.
const CODE_FOR_OUTCOME = {
    timeout: 'egress_timeout',
    too_large: 'egress_too_large',
    aborted_in_page: 'page_fault',
    report_failed: 'page_fault'
}

// What qwen.ai's WAF answers to an API call instead of JSON: a challenge
// page, under status 200 (2026-11-24). The same markers the app classifies by
// (src/utils/upstream-error.js, WAF_HTML_SIGNAL_RE): the worker names what it
// saw, the app alone says what it means.
const CHALLENGE_PAGE = /aliyun_waf_|aliyunCaptcha|_waf_is_mobile|id=["']captcha-element|<title>Verification<\/title>/i
// Of the body, this much is looked at.
const CHALLENGE_HEAD_BYTES = 64 * 1024

/** Is this answer a page (text/html) rather than data? The answer's headers, names in lower case. */
const isHtmlAnswer = headers => /text\/html/i.test(String((headers && headers['content-type']) || ''))

/**
 * Is this answer a WAF challenge page? An HTML answer with the challenge's
 * markers in the start of its body. Only an HTML one, as the app screens only
 * those: an answer that streams may quote a marker as text. Whether an answer
 * is a challenge is the app's verdict, and the worker must not disagree with it.
 * @param {Object<string,string>} headers - The answer's headers, names in lower case
 * @param {string|Buffer} body - The answer's body, or as much of its start as was kept
 */
function isChallengePage(headers, body) {
    if (!isHtmlAnswer(headers)) return false
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')
    return CHALLENGE_PAGE.test(text.slice(0, CHALLENGE_HEAD_BYTES))
}

// Since Qwen2API-0c6 the worker's line about a whole answer says more of it than
// its status. On 2026-11-26 qwen.ai refused chats/new in the body of a 200
// ({"success":false, "code":"unauthorized"}), twice in an hour, and the line
// read exactly like an accepted call; on 2026-11-25 it answered a file call
// with 405, and whether the header that names a regional block was there could
// not be told afterwards. The app classifies the answer; the log only quotes it.

// What a name may hold for its value to be kept off a log line, whatever its
// case: the name of a header, the key of a field in a JSON body, the name of a
// pair in a form. A name is not read for what it means.
const SECRET_NAME = 'cookie|token|key|secret|password|passwd|credential|signature|authorization|session'
// Headers whose values could hold a credential never reach a log line.
const PRIVATE_HEADER = new RegExp(SECRET_NAME, 'i')
// What looks like a credential inside a body: a Bearer, a JWT. The parts of a JWT are bounded,
// so that a long run of characters is not gone through again from every place a JWT may start in it.
const CREDENTIAL = /\bBearer\s+\S+|eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{5,2048}/gi
// What is named one: the value of a field of a JSON body ("AccessKeySecret":"…", "token":123) or
// of a pair of a form (securityToken=…). The name is bounded for the reason a JWT's parts are.
const NAMED_SECRET = new RegExp(String.raw`("[^"]{0,256}(?:${SECRET_NAME})[^"]{0,256}"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^,{}\[\]\s]+)`, 'gi')
const PAIRED_SECRET = new RegExp(String.raw`(\b[\w.-]{0,64}(?:${SECRET_NAME})[\w.-]{0,64}=)("[^"]*"|[^&\s<>]+)`, 'gi')
// A refusal is short: a longer body than this is not looked into.
const REFUSAL_BODY_CHARS = 256 * 1024
// Of what is quoted of a body, only this start is looked through for credentials: far more than is ever quoted.
const MASKED_BODY_CHARS = 64 * 1024
const QUOTED_BODY_CHARS = 300
const QUOTED_HEADERS = 12

/** The value on one line of log: control characters, line separators and direction marks become spaces; nothing longer than `max`. */
const quoted = (value, max) => String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .trim().slice(0, max)

/** The start of a body as a log line may show it: a credential, or what is named one, is not qwen.ai's message. */
const masked = text => String(text ?? '').slice(0, MASKED_BODY_CHARS)
    .replace(NAMED_SECRET, '$1"<credential>"')
    .replace(PAIRED_SECRET, '$1<credential>')
    .replace(CREDENTIAL, '<credential>')

/**
 * The code qwen.ai refused an answer in the body with, where the app reads it
 * (src/utils/browser-egress.js#isUnauthorized, and the front end's own reader
 * of a punish envelope, NV): a string on the answer, on its data or on its
 * error, or the lines of its `ret`. A number is a code too. Null when none is there.
 */
function refusalCode(payload) {
    if (!payload || typeof payload !== 'object') return null
    const candidates = [payload.code, payload.data?.code, payload.error?.code, payload.error]
    const code = candidates.find(value => (typeof value === 'string' && value.trim()) || Number.isFinite(value))
    if (code !== undefined) return String(code)
    if (Array.isArray(payload.ret)) {
        const lines = payload.ret.filter(value => typeof value === 'string' && value.trim())
        if (lines.length) return lines.join(' | ')
    }
    return null
}

/**
 * Whether a JSON answer is a refusal: it says so (success false), or it carries
 * what only a refusal does — an error with a code, or the lines of the punish
 * envelope qwen.ai's risk control answers with.
 */
function isRefusal(payload) {
    if (!payload || typeof payload !== 'object') return false
    if (payload.success === false) return true
    return typeof payload.error?.code === 'string' ||
        (Array.isArray(payload.ret) && payload.ret.some(line => typeof line === 'string' && line.trim()))
}

/**
 * What the log says of qwen.ai's whole answer beyond its status (Qwen2API-0c6).
 * A refusal that travels in the body of a 2xx is said by its code — that is
 * what told an accepted call from a refused one on 2026-11-26 — or, a refusal
 * that names none, by being one. An answer that is no 2xx is said by its code,
 * its headers (none that could hold a credential) and the start of its body.
 * Whether an answer is a WAF challenge page is said beside this (server.js,
 * CHALLENGE_NOTE), not here.
 *
 * @param {{status: number, headers: Object<string,string>, body: string}} answer - As fetch() returns it
 * @returns {string} '' for an answer its status says enough of; else ' — …'
 */
function answerNote({ status, headers, body }) {
    const text = String(body ?? '')
    let payload = null
    if (text.length <= REFUSAL_BODY_CHARS) {
        try {
            payload = JSON.parse(text)
        } catch { /* not JSON: a page, or text */ }
    }
    const accepted = status >= 200 && status < 300
    const refusal = isRefusal(payload)
    // The code as a log line may show it: one line, short, and with nothing in it that looks like a credential.
    const shown = quoted(masked(refusalCode(payload)), 80).trim()
    const notes = []
    if (shown && (refusal || !accepted)) notes.push(`code ${shown}`)
    else if (refusal && accepted) notes.push('refused, no code')
    if (!accepted) {
        const shown = Object.entries(headers || {})
            .filter(([name]) => !PRIVATE_HEADER.test(name))
            .slice(0, QUOTED_HEADERS)
            .map(([name, value]) => `${quoted(name, 64)}=${quoted(masked(value), 120)}`)
        notes.push(`headers: ${shown.length ? shown.join(', ') : 'none'}`)
        notes.push(`body: ${quoted(masked(text), QUOTED_BODY_CHARS)}`)
    }
    return notes.length ? ` — ${notes.join('; ')}` : ''
}

/**
 * Validate an /egress body and reduce it to what the page receives.
 *
 * This is the SSRF guard: the worker drives a logged-in browser, so the
 * target is pinned to the configured chat origin before any page is touched.
 * URL parsing is WHATWG in Node and in Chromium alike, which is what makes
 * the origin check here the same one the browser will make.
 *
 * `stream` asks for the answer to be relayed as it arrives (an SSE body)
 * instead of returned whole. With it, `timeoutMs` bounds the silence between
 * two chunks; without it, the whole call.
 *
 * @returns {{url: string, init: {method: string, headers: Object<string,string>, body?: string}, timeoutMs: number, stream: boolean}}
 */
function normalizeEgress(body, { chatOrigin, defaultTimeoutMs, maxTimeoutMs }) {
    const allowed = new URL(chatOrigin).origin
    // Absolute, or a path from the origin root. Anything else would resolve
    // relative to the root by URL rules and mean something the caller did not say.
    if (typeof body.url !== 'string' || !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(body.url)) {
        throw invalid('The url must be absolute or start with /.')
    }
    let target
    try {
        target = new URL(body.url, allowed)
    } catch {
        throw invalid('Invalid url.')
    }
    if (target.origin !== allowed || target.username || target.password) {
        throw invalid('The url must point at the chat origin.')
    }

    const method = typeof body.method === 'string' ? body.method.toUpperCase() : ''
    if (!METHODS.has(method)) throw invalid('Unsupported method.')

    const headers = {}
    if (body.headers !== undefined && body.headers !== null) {
        if (typeof body.headers !== 'object' || Array.isArray(body.headers)) throw invalid('headers must be an object.')
        for (const [name, value] of Object.entries(body.headers)) {
            if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) {
                throw invalid('Invalid header.')
            }
            // The profile's own jar rides along on every call; a caller's
            // Cookie header is one the browser would silently drop anyway.
            if (name.toLowerCase() !== 'cookie') headers[name.toLowerCase()] = value
        }
    }
    // The page's own requests are known by it. So is this call: the worker
    // finds qwen.ai's answer to it by this, whoever else in the page is asking.
    headers['x-request-id'] = headers['x-request-id'] || crypto.randomUUID()

    const raw = body.body
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw invalid('body must be a string.')
    const hasBody = raw !== undefined && raw !== null && raw !== ''
    if (hasBody && !METHODS_WITH_BODY.has(method)) throw invalid(`${method} cannot carry a body.`)

    if (body.timeoutMs !== undefined && !Number.isFinite(body.timeoutMs)) throw invalid('timeoutMs must be a number.')
    const timeoutMs = Math.min(Math.max(body.timeoutMs ?? defaultTimeoutMs, MIN_TIMEOUT_MS), maxTimeoutMs)
    if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') {
        throw invalid('stream must be a boolean.')
    }

    return {
        url: target.href,
        init: { method, headers, body: hasBody ? raw : undefined },
        timeoutMs,
        stream: body.stream === true
    }
}

module.exports = {
    pageCall, pageAbortStream, pageTokenState, pageRefreshToken, readFrontEndVersion, normalizeEgress,
    isChallengePage, isHtmlAnswer, answerNote, CODE_FOR_OUTCOME,
    ABORT_REASON, STREAM_CHANNEL, STREAM_ABORTS, PAGE_HEADERS, CHALLENGE_HEAD_BYTES,
    // For the worker's own lines about a page's token (resident-pages.js#freshen).
    quoted, masked
}
