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
 * @returns {{url: string, init: {method: string, headers: Object<string,string>, body?: string}, timeoutMs: number}}
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

    return {
        url: target.href,
        init: { method, headers, body: hasBody ? raw : undefined },
        timeoutMs
    }
}

module.exports = { pageFetch, normalizeEgress, CODE_FOR_OUTCOME }
