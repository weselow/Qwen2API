'use strict'

/**
 * In-page fetch for the resident pages (Qwen2API-3ue.1) and the validation
 * that feeds it. The point of running the call inside the page is that the
 * browser's own TLS fingerprint and its live cookie jar are what upstream
 * sees — see docs/browser-egress-design.md.
 */

const { WorkerError } = require('./worker-errors')

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MIN_TIMEOUT_MS = 100
// RFC 9110 token.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// What a browser accepts in a header value: tab and Latin-1 printables.
const HEADER_VALUE = /^[\t\x20-\xff]*$/

const invalid = message => new WorkerError('invalid_request', message)

/**
 * Runs INSIDE the page. page.evaluate serializes this function by source, so
 * it must not reference anything from this module.
 *
 * The browser attaches the profile's cookies (credentials: 'include') and
 * Chromium's TLS. The abort timer lives here too: a Node-side timer cannot
 * reach a fetch that is already running in the page.
 */
async function pageFetch({ url, init, timeoutMs, maxBytes }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, { ...init, credentials: 'include', signal: controller.signal })
        const headers = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        const reader = response.body ? response.body.getReader() : null
        const chunks = []
        let size = 0
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > maxBytes) {
                    await reader.cancel().catch(() => {})
                    return { ok: false, error: 'too_large', status: response.status }
                }
                chunks.push(value)
            }
        }
        return {
            ok: true,
            status: response.status,
            url: response.url,
            redirected: response.redirected,
            headers,
            body: chunks.length ? await new Blob(chunks).text() : ''
        }
    } catch (error) {
        const aborted = error && error.name === 'AbortError'
        return {
            ok: false,
            // Only our timer aborts the controller; any other AbortError is
            // the page's doing.
            error: aborted ? (controller.signal.aborted ? 'timeout' : 'aborted') : 'network_error',
            message: String((error && error.message) || error)
        }
    } finally {
        clearTimeout(timer)
    }
}

// What a stream's fetch was aborted for, as the page reports it back. The
// page aborts with the timeout reason itself; anything else aborted it from
// outside, which only the app going away does.
const ABORT_REASON = { timeout: 'timeout', cancelled: 'cancelled' }

// Names the worker and the page know each other by. Both live on the page's
// globalThis: the channel the in-page stream reports on (an exposed binding,
// page -> Node) and the registry of the streams' AbortControllers, which is
// what lets Node abort a fetch that is already running in the page.
const STREAM_CHANNEL = '__qwenEgressEvent'
const STREAM_ABORTS = '__qwenEgressAborts'

/**
 * Runs INSIDE the page. Same rules as pageFetch: serialized by source, no
 * module scope. The streaming counterpart (Qwen2API-3ue.3): the answer is
 * relayed while it arrives, instead of returned once it is whole.
 *
 * `channel` names the binding resident-pages.js exposed on the page. The
 * page reports on it and waits for the call to return, which is how the
 * worker holds the page back when the app is not keeping up: a stalled reader
 * is a stalled upstream. Bytes travel as base64 — the channel carries
 * strings, and a chunk may cut a multi-byte character in half.
 *
 * The AbortController is registered on the page for the life of the call, so
 * an abort that Node asks for (the app's client went away) reaches a fetch
 * that is already running: pageAbortStream() looks it up by id.
 *
 * `timeoutMs` is a budget of SILENCE here, not for the whole call: a stream
 * may legitimately run for minutes, and every chunk upstream delivers re-arms
 * the timer. A stream that stops producing is cut at timeoutMs; one that
 * keeps producing is not cut at all. The app's turn is not silence: while it
 * has not taken a report nothing is read from qwen.ai, and the timer waits.
 *
 * `maxBytes` caps the body. 0 is no cap — a stream's default: nothing is
 * buffered for a stream, so it needs none.
 */
async function pageFetchStream({ url, init, timeoutMs, maxBytes, channel, registry, id, reasons }) {
    const controller = new AbortController()
    const aborts = globalThis[registry] || (globalThis[registry] = {})
    aborts[id] = controller
    // The binding resident-pages.js exposed on this page, by the name it was
    // given. It takes the stream's id with every event: the page carries
    // several streams at once, and each report names its own.
    const emit = globalThis[channel]
    let timer = null
    const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(reasons.timeout), timeoutMs)
    }
    // Settles when the fetch is aborted, whatever the loop is waiting for:
    // a report the app has not acknowledged yet must not outlive its stream.
    const aborted = new Promise(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const report = event => Promise.race([emit(id, event), aborted])
    const toBase64 = bytes => {
        let binary = ''
        for (let at = 0; at < bytes.length; at += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
        }
        return btoa(binary)
    }
    try {
        arm()
        const response = await fetch(url, { ...init, credentials: 'include', signal: controller.signal })
        const headers = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        // The app's turn: while it has not taken a report, qwen.ai is not being
        // read, and waiting for the app is not qwen.ai falling silent.
        const tell = async event => {
            clearTimeout(timer)
            await report(event)
            arm()
        }
        await tell({ type: 'head', status: response.status, url: response.url, redirected: response.redirected, headers })
        const reader = response.body ? response.body.getReader() : null
        let size = 0
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (maxBytes && size > maxBytes) {
                    await reader.cancel().catch(() => {})
                    return { ok: false, error: 'too_large', status: response.status }
                }
                await tell({ type: 'chunk', data: toBase64(value) })
            }
        }
        return { ok: true }
    } catch (error) {
        const aborted = controller.signal.aborted
        return {
            ok: false,
            // The signal says who aborted: a fetch the page itself aborted
            // for silence is a timeout, one aborted from outside is not.
            error: aborted ? (controller.signal.reason === reasons.timeout ? 'timeout' : 'aborted') : 'network_error',
            message: aborted ? undefined : String((error && error.message) || error)
        }
    } finally {
        clearTimeout(timer)
        delete aborts[id]
    }
}

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
// failure on the browser side ("Failed to fetch").
const CODE_FOR_OUTCOME = {
    timeout: 'egress_timeout',
    too_large: 'egress_too_large'
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
    pageFetch, pageFetchStream, pageAbortStream, normalizeEgress, CODE_FOR_OUTCOME,
    ABORT_REASON, STREAM_CHANNEL, STREAM_ABORTS
}
