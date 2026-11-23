const axios = require('axios')
const config = require('../config')
const store = require('./v2-session-store')
const { SigninError } = require('./signin-error')
const { resolveProxyUrl } = require('./proxy-helper')

/**
 * HTTP client for the signin-worker sidecar (jik.3). The worker owns real
 * Chromium profiles; this module asks it to acquire or renew a chat.qwen.ai
 * session and hands the harvested token + cookies to the session store. Since
 * Qwen2API-3ue.2 it also carries qwen.ai API calls into the account's resident
 * page (/egress).
 *
 * Credentials travel only in request bodies over the internal network and
 * are never logged: error paths log worker status codes, never payloads.
 */

// Worker error codes -> public sign-in error codes.
const CODE_FOR_WORKER_CODE = {
    invalid_credentials: 'signin_rejected',
    captcha_stuck: 'signin_verification_required',
    form_not_found: 'signin_verification_required',
    signin_timeout: 'signin_transport_error',
    browser_error: 'signin_upstream_error',
    // The worker paces full sign-ins; retryAfterMs says when it has a slot.
    signin_paced: 'signin_busy',
    no_profile: 'signin_session_lost',
    session_expired: 'signin_session_lost'
}

// Worker codes meaning "the persisted browser profile can no longer
// authenticate" — the caller should fall back to a full password sign-in.
const SESSION_LOST_CODES = new Set(['no_profile', 'session_expired'])

function workerHeaders() {
    const headers = {}
    if (config.signinWorkerToken) headers.authorization = `Bearer ${config.signinWorkerToken}`
    return headers
}

/**
 * POST to the worker and return the axios response. Every worker failure
 * leaves as a SigninError carrying the worker's own code (workerCode) for the log.
 * @param {number} [timeoutMs] - Defaults to the configured worker budget: a
 *   full sign-in may wait in the worker's login line before it runs (Qwen2API-43a)
 */
async function postWorker(path, payload, timeoutMs = config.signinWorkerTimeoutMs) {
    let response
    try {
        response = await axios.post(`${config.signinWorkerUrl}${path}`, payload, {
            headers: workerHeaders(),
            timeout: timeoutMs,
            maxRedirects: 0
        })
    } catch (error) {
        if (error.response) {
            const code = error.response.data?.code
            const failure = new SigninError(
                CODE_FOR_WORKER_CODE[code] || 'signin_upstream_error',
                error.response.status >= 500 ? 502 : error.response.status,
                'Signin worker rejected the request.',
                error.response.status
            )
            failure.sessionLost = SESSION_LOST_CODES.has(code)
            if (Number.isFinite(error.response.data?.retryAfterMs)) {
                failure.retryAfterMs = error.response.data.retryAfterMs
            }
            failure.workerCode = typeof code === 'string' ? code : null
            throw failure
        }
        // The same code either way (callers branch on it); the log line should not blame a worker that is up and still working.
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            throw new SigninError('signin_transport_error', 502, 'Signin worker did not answer in time.')
        }
        throw new SigninError('signin_transport_error', 502, 'Signin worker unreachable.')
    }
    return response
}

async function callWorker(path, payload) {
    const response = await postWorker(path, payload)
    const { token, expiresAt, cookies } = response.data || {}
    if (typeof token !== 'string' || !token || !Array.isArray(cookies) || !Number.isFinite(expiresAt)) {
        throw new SigninError('signin_upstream_error', 502, 'Signin worker returned a malformed session.',
            response.status)
    }
    return { token, expiresAt, cookies }
}

/**
 * Full interactive sign-in; returns a jar-backed session for the store.
 * The worker answers from the session it already holds while that one is
 * live; `force` asks for a real sign-in regardless (Qwen2API-43a), for a
 * session that was just refused upstream.
 */
async function acquireSession(email, password, account, { force = false } = {}) {
    const harvested = await callWorker('/session', {
        email,
        password,
        proxy: resolveProxyUrl(account),
        ...(force ? { force: true } : {})
    })
    return { token: harvested.token, expiresAt: harvested.expiresAt, jar: store.jarFromCookies(harvested.cookies) }
}

/**
 * Silent renewal from the persisted profile; sessionLost errors mean "re-login".
 * @param {Object} [options]
 * @param {boolean} [options.force] - the session was refused upstream: reload
 *   the page live instead of answering from the worker's cache (Qwen2API-3ue.2)
 */
async function renewSession(email, account, { force = false } = {}) {
    const payload = { email, proxy: resolveProxyUrl(account) }
    if (force) payload.force = true
    const harvested = await callWorker('/renew', payload)
    return { token: harvested.token, expiresAt: harvested.expiresAt, jar: store.jarFromCookies(harvested.cookies) }
}

// What the worker's own budget does not cover on /egress: opening the
// account's page if nobody has yet (Chromium start, chat root, a settled token).
const EGRESS_OPEN_MARGIN_MS = 60000

/**
 * One qwen.ai API call from inside the account's resident page
 * (Qwen2API-3ue.2). The worker answers 200 whenever the call left the page:
 * qwen.ai's status and body travel inside, along with the browser's live jar.
 * The HTTP budget is the worker's own on top of the call: an account's call
 * can wait behind that account's sign-in, and then for its page to open.
 * Giving up earlier would not stop the worker — it would leave a chat behind
 * and have the client's retry create another.
 *
 * @param {string} email
 * @param {Object} [account] - Account (its proxy opens the page)
 * @param {Object} request
 * @param {string} request.url - Absolute, or rooted at the chat origin
 * @param {string} [request.method]
 * @param {Object<string,string>} [request.headers]
 * @param {string} [request.body] - Passed through as text
 * @param {number} [request.timeoutMs] - Budget for the call inside the page
 * @returns {Promise<{status:number, headers:Object, body:string, url:string, redirected:boolean, cookies:Object[]}>}
 */
async function egress(email, account, { url, method = 'POST', headers = {}, body, timeoutMs = 30000 }) {
    const answer = (await postWorker('/egress', {
        email, url, method, headers, body, timeoutMs, proxy: resolveProxyUrl(account)
    }, timeoutMs + config.signinWorkerTimeoutMs + EGRESS_OPEN_MARGIN_MS)).data
    if (!Number.isInteger(answer?.status) || typeof answer.body !== 'string' || !Array.isArray(answer.cookies)) {
        throw new SigninError('signin_upstream_error', 502, 'Signin worker returned a malformed egress.')
    }
    return answer
}

module.exports = { acquireSession, renewSession, egress, EGRESS_OPEN_MARGIN_MS }
