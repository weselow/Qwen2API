const axios = require('axios')
const config = require('../config')
const store = require('./v2-session-store')
const { SigninError } = require('./signin-error')
const { resolveProxyUrl } = require('./proxy-helper')

/**
 * HTTP client for the signin-worker sidecar (jik.3). The worker owns real
 * Chromium profiles; this module asks it to acquire or renew a chat.qwen.ai
 * session and hands the harvested token + cookies to the session store.
 *
 * Credentials travel only in request bodies over the internal network and are
 * never logged: error paths log worker status codes, never payloads.
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

async function callWorker(path, payload) {
    let response
    try {
        response = await axios.post(`${config.signinWorkerUrl}${path}`, payload, {
            headers: workerHeaders(),
            timeout: config.signinWorkerTimeoutMs,
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
            throw failure
        }
        throw new SigninError('signin_transport_error', 502, 'Signin worker unreachable.')
    }
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

/** Silent renewal from the persisted profile; sessionLost errors mean "re-login". */
async function renewSession(email, account) {
    const harvested = await callWorker('/renew', {
        email,
        proxy: resolveProxyUrl(account)
    })
    return { token: harvested.token, expiresAt: harvested.expiresAt, jar: store.jarFromCookies(harvested.cookies) }
}

module.exports = { acquireSession, renewSession }
