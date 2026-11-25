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

// What the page's own requests carry that a caller may leave out. The front
// end's client sends its XHRs with axios's defaults and `source: web`. The
// same values are written out in pageCall: that function reaches the page as
// source text and can read nothing from this module.
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
 * returned once it is whole.
 *
 * How the request is made:
 *
 * - An XMLHttpRequest, subscribed with addEventListener. The page's request
 *   hooks (baxiaCommon.js 2.5.37) keep a script from seeing an answer they
 *   take for a block by never calling its onload, onloadend and
 *   onreadystatechange PROPERTIES; a listener added with addEventListener is
 *   called all the same. So a challenge page reaches the worker as an answer,
 *   instead of leaving the call hanging (Qwen2API-3ue.6). readyState is never
 *   read for the same reason: its getter is one of the hooks'.
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
    const xhr = new XMLHttpRequest()
    const target = new URL(url, location.href)
    const encoder = new TextEncoder()
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
    controller.signal.addEventListener('abort', () => {
        // Said before the request is aborted: abort() before send() fires no
        // event at all, and the one it fires later does not know why.
        end({ ok: false, error: controller.signal.reason === reasons.timeout ? 'timeout' : 'aborted' })
        xhr.abort()
    }, { once: true })

    // Streaming: reports go out one at a time, each once the one before was
    // taken — a report is the page waiting for the worker to write it out.
    const aborted = new Promise(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const report = event => Promise.race([emit(id, event), aborted])
    let queue = Promise.resolve()
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
    let last = new Uint8Array(0)
    let headSent = false
    let html = false
    // What arrived since the last look. False once the answer is over the cap.
    const take = () => {
        let text
        try {
            text = xhr.responseText
        } catch {
            // A page hook's getter: nothing is known to have arrived. What was
            // told so far stands — a blank read must not tell it all again.
            last = new Uint8Array(0)
            return true
        }
        last = encoder.encode(text.slice(delivered))
        delivered = text.length
        size += last.byteLength
        return !maxBytes || size <= maxBytes
    }
    const cutOff = () => {
        end({ ok: false, error: 'too_large', status: xhr.status })
        xhr.abort()
    }
    // One more report, after those already queued.
    const relay = event => { queue = queue.then(() => ended ? undefined : tell(event)) }
    const relayChunk = bytes => relay({ type: 'chunk', data: toBase64(bytes) })
    const onHead = () => {
        headSent = true
        const head = answer()
        html = /text\/html/i.test(head.headers['content-type'] || '')
        if (!html) relay({ type: 'head', ...head })
    }
    const onProgress = async () => {
        if (ended) return
        // However the events are ordered, the head is told before any of the body.
        if (streaming && !headSent) onHead()
        if (!take()) return cutOff()
        // The browser announces the end of a body with a progress event of its own, carrying nothing.
        if (streaming && !html && last.byteLength) relayChunk(last)
        await queue
    }
    const onLoad = async () => {
        if (ended) return
        if (!streaming) {
            if (!take()) return cutOff()
            return end({ ok: true, ...answer(), body: xhr.responseText })
        }
        // From the browser's cache no state change may have been reported.
        if (!headSent) onHead()
        if (!take()) return cutOff()
        if (html) {
            relay({ type: 'head', ...answer() })
            relayChunk(encoder.encode(xhr.responseText))
        } else if (last.byteLength) {
            relayChunk(last)
        }
        await queue
        end({ ok: true })
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
    if (streaming) {
        xhr.addEventListener('readystatechange', () => {
            // status is set once the head is in. (Not readyState: see above.)
            if (!ended && !headSent && xhr.status !== 0) guarded(onHead)()
        })
        xhr.addEventListener('progress', guarded(onProgress))
    } else {
        xhr.addEventListener('progress', guarded(onProgress))
    }
    xhr.addEventListener('load', guarded(onLoad))
    xhr.addEventListener('error', () => end({ ok: false, error: 'network_error', message: 'network error' }))
    // The call's own aborts end the call before the request is aborted, so
    // this event means a script of the page's cut the request: not the app
    // going away, and a failure the worker names (page_fault).
    xhr.addEventListener('abort', () => end({ ok: false, error: 'aborted_in_page' }))

    try {
        const headers = { accept: 'application/json, text/plain, */*', source: 'web', ...init.headers }
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
// request a script of the page cuts is not the call's abort at all: that is
// the request's own 'abort' event, and ends the call as `aborted_in_page`.
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
    pageCall, pageAbortStream, readFrontEndVersion, normalizeEgress, isChallengePage, isHtmlAnswer, CODE_FOR_OUTCOME,
    ABORT_REASON, STREAM_CHANNEL, STREAM_ABORTS, PAGE_HEADERS, CHALLENGE_HEAD_BYTES
}
