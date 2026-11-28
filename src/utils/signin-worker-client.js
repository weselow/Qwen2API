const axios = require('axios')
const { StringDecoder } = require('node:string_decoder')
const config = require('../config')
const store = require('./v2-session-store')
const { SigninError } = require('./signin-error')
const { accountRemoved, ACCOUNT_REMOVED } = require('./account-registry')
const { resolveProxyUrl } = require('./proxy-helper')

/**
 * HTTP client for the signin-worker sidecar (jik.3). The worker owns real
 * Chromium profiles; this module asks it to acquire or renew a chat.qwen.ai
 * session and hands the harvested token + cookies to the session store. Since
 * Qwen2API-3ue.2 it also carries qwen.ai API calls into the account's resident
 * page (/egress) — streamed since Qwen2API-3ue.3 (egressStream) — and it
 * tells the worker when the app drops an account (Qwen2API-2l0, forgetAccount).
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
 * What a failed call to the worker means in the app's terms: a SigninError
 * carrying the worker's own code (workerCode) for the log.
 * @param {Error & {response?: object}} error - As axios rejected it
 * @param {boolean} [timedOut] - A budget this module ran itself ran out
 */
function workerFailure(error, timedOut = false) {
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
        return failure
    }
    // The same code either way (callers branch on it); the log line should not blame a worker that is up and still working.
    if (timedOut || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        const failure = new SigninError('signin_transport_error', 502, 'Signin worker did not answer in time.')
        // Not a refusal: whatever the worker was asked goes on without the app.
        failure.timedOut = true
        return failure
    }
    return new SigninError('signin_transport_error', 502, 'Signin worker unreachable.')
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
        throw workerFailure(error)
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

// No call that a request makes reaches the worker for an account the app has
// removed (account-registry.js, Qwen2API-u50); the worker's own forget and
// the sign-in that adds an account are not a request's. What such a call ends
// with is not a lost session — no password sign-in follows it — nor the kind
// of failure a retry mends: the request ends there, and nothing is charged to
// the account.
const refuseRemoved = email => {
    if (!accountRemoved(email)) return
    throw Object.assign(new SigninError(ACCOUNT_REMOVED, 409, 'The account was removed from the app.'),
        { workerCode: 'account_removed', notAccountFault: true })
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
 * @throws {SigninError} signin_account_removed — the app no longer has the account
 */
async function renewSession(email, account, { force = false } = {}) {
    refuseRemoved(email)
    const payload = { email, proxy: resolveProxyUrl(account) }
    if (force) payload.force = true
    const harvested = await callWorker('/renew', payload)
    return { token: harvested.token, expiresAt: harvested.expiresAt, jar: store.jarFromCookies(harvested.cookies) }
}

// What /forget takes at the worker before the worker's own waits are over:
// the streams on the page get their moment to finish (20 s by default,
// RESIDENT_STREAM_WAIT_MS of the worker), then the whole-answer calls in
// flight (5 s), then the page closes (5 s). A sign-in or renewal still
// running for the account, or standing in the worker's line of page loads,
// is not waited for here: the worker finishes the job without the app.
const FORGET_TIMEOUT_MS = 35000

/**
 * The app dropped the account: the worker forgets it too (Qwen2API-2l0) — the
 * session it cached, with its silent-renew timer, and the resident page. An
 * account the worker never saw is forgotten all the same. Whether the browser
 * profile goes with it is the worker's own setting: deleted at once, or after
 * a pause (`deferred`, Qwen2API-t8s) that any request the worker then takes
 * for the account takes back — the sign-in of an adding again, a call.
 * @param {string} email
 * @param {number} [timeoutMs]
 * @returns {Promise<{session: boolean, page: boolean, profile: 'kept'|'deleted'|'deferred'|'absent'|'left',
 *   pending?: 'login'|'renewal'}>}
 *   what the worker dropped; `profile` says what became of the browser profile;
 *   `pending` when the worker gave up waiting for a sign-in or a renewal that
 *   kept starting for the account — it may leave a session behind after all
 * @throws {SigninError} the worker refused or did not answer
 */
async function forgetAccount(email, timeoutMs = FORGET_TIMEOUT_MS) {
    const answer = (await postWorker('/forget', { email }, timeoutMs)).data
    if (answer?.ok !== true || typeof answer.session !== 'boolean' || typeof answer.page !== 'boolean' ||
        !['kept', 'deleted', 'deferred', 'absent', 'left'].includes(answer.profile) ||
        (answer.pending !== undefined && !['login', 'renewal'].includes(answer.pending))) {
        throw new SigninError('signin_upstream_error', 502, 'Signin worker returned a malformed forget.')
    }
    const forgotten = { session: answer.session, page: answer.page, profile: answer.profile }
    if (answer.pending !== undefined) forgotten.pending = answer.pending
    return forgotten
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
 * @throws {SigninError} signin_account_removed — the app no longer has the account (refuseRemoved)
 */
async function egress(email, account, { url, method = 'POST', headers = {}, body, timeoutMs = 30000 }) {
    refuseRemoved(email)
    const answer = (await postWorker('/egress', {
        email, url, method, headers, body, timeoutMs, proxy: resolveProxyUrl(account)
    }, timeoutMs + config.signinWorkerTimeoutMs + EGRESS_OPEN_MARGIN_MS)).data
    if (!Number.isInteger(answer?.status) || typeof answer.body !== 'string' || !Array.isArray(answer.cookies)) {
        throw new SigninError('signin_upstream_error', 502, 'Signin worker returned a malformed egress.')
    }
    return answer
}

// A worker refusal to a streamed call arrives as a stream of its own: its
// JSON is a few hundred bytes.
const ERROR_BODY_LIMIT = 16384

// What each event of the relay has to look like (signin-worker/server.js#relayEgress).
const RELAY_EVENTS = {
    head: event => Number.isInteger(event.status) && event.headers !== null && typeof event.headers === 'object',
    chunk: event => typeof event.data === 'string',
    end: () => true,
    error: event => typeof event.code === 'string'
}

// A line that is not an event — an old worker answering whole, a relay out of
// shape. The egress's fault: never the account's, and not a thing a retry mends.
// (The line itself stays out of the message: it may be a piece of an answer.)
const malformedRelay = detail => Object.assign(
    new Error(`Signin worker returned a malformed egress stream (${detail}).`),
    { code: 'EGRESS_RELAY_MALFORMED', workerCode: 'relay_malformed', notAccountFault: true }
)

const relayEvent = line => {
    let event
    try {
        event = JSON.parse(line)
    } catch { /* not an event: reported below */ }
    const shape = event && typeof event === 'object' && Object.hasOwn(RELAY_EVENTS, event.type)
        ? RELAY_EVENTS[event.type]
        : null
    if (!shape || !shape(event)) {
        throw malformedRelay(event && typeof event.type === 'string' ? `event type ${event.type}` : 'not an event')
    }
    return event
}

/**
 * The worker's relay as an async iterator of its events, one JSON object per
 * line (signin-worker/server.js#relayEgress). An `error` event is yielded
 * like any other: what it means for the caller is the caller's to say.
 *
 * Ending the iteration early is what tells the worker to stop: `return()`
 * lands in the finally, which closes the connection — and the worker, seeing
 * it go, aborts the fetch inside the page.
 */
async function* relayFrames(relay) {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    try {
        for await (const chunk of relay) {
            pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
            for (;;) {
                const newline = pending.indexOf('\n')
                if (newline < 0) break
                const line = pending.slice(0, newline).trim()
                pending = pending.slice(newline + 1)
                if (line) yield relayEvent(line)
            }
        }
        const rest = (pending + decoder.end()).trim()
        if (rest) yield relayEvent(rest)
    } finally {
        relay.destroy?.()
    }
}

/**
 * The failure of a streamed call, in the terms of every other worker failure
 * (workerFailure) — which needs the worker's JSON, and to a streamed call
 * the worker sends that as a stream too.
 */
async function streamWorkerFailure(error, timedOut) {
    const body = error.response?.data
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = []
        let size = 0
        try {
            for await (const chunk of body) {
                size += chunk.length
                chunks.push(chunk)
                if (size >= ERROR_BODY_LIMIT) break
            }
        } catch { /* the body is all there was to read */ }
        try {
            error.response.data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            error.response.data = null
        }
    }
    return workerFailure(error, timedOut)
}

/**
 * One qwen.ai API call from inside the account's resident page, its answer
 * relayed as it arrives (Qwen2API-3ue.3): the streaming /egress. Resolves once
 * the worker took the call; the answer comes through `frames`.
 *
 * The budget is the whole-answer call's, and it covers nothing after the
 * worker started: a stream lasts as long as qwen.ai keeps talking, and its
 * silence is the worker's own timer to police (request.timeoutMs, inside the page).
 *
 * The app cancelling is it closing the relay: `frames` ending early, or
 * `close()`, destroys the connection, and the worker aborts the fetch inside
 * the page when it sees it go.
 *
 * @param {string} email
 * @param {Object} [account] - Account (its proxy opens the page)
 * @param {Object} request - What egress() takes
 * @param {number} [request.timeoutMs] - How long qwen.ai may fall silent between two chunks
 * @param {object} [options]
 * @param {number} [options.budgetMs] - How long the worker may take to start
 *   the relay; by default the call's silence budget, the worker's own budget
 *   and the page's open, as for egress()
 * @returns {Promise<{frames: AsyncGenerator<Object>, close: () => void}>}
 * @throws {SigninError} the worker could not take the call; signin_account_removed —
 *   the app no longer has the account (refuseRemoved)
 */
async function egressStream(email, account, { url, method = 'POST', headers = {}, body, timeoutMs = 30000 },
    { budgetMs } = {}) {
    refuseRemoved(email)
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
        expired = true
        controller.abort()
    }, budgetMs ?? (timeoutMs + config.signinWorkerTimeoutMs + EGRESS_OPEN_MARGIN_MS))
    let response
    try {
        response = await axios.post(`${config.signinWorkerUrl}/egress`, {
            email, url, method, headers, body, timeoutMs, proxy: resolveProxyUrl(account), stream: true
        }, {
            headers: workerHeaders(),
            responseType: 'stream',
            timeout: 0,
            maxRedirects: 0,
            signal: controller.signal
        })
    } catch (error) {
        throw await streamWorkerFailure(error, expired)
    } finally {
        clearTimeout(timer)
    }
    const relay = response.data
    return {
        frames: relayFrames(relay),
        // For a relay that is never read, or read no further: the same closing of the connection.
        close: () => {
            controller.abort()
            relay.destroy?.()
        }
    }
}

module.exports = {
    acquireSession, renewSession, forgetAccount, egress, egressStream,
    EGRESS_OPEN_MARGIN_MS, FORGET_TIMEOUT_MS
}
