const config = require('../config/index.js')
const store = require('./v2-session-store')
const signinWorker = require('./signin-worker-client')
const sessionPersistence = require('./v2-session-persistence')
const { ChatCreationError, assertChatCreationResponse } = require('./upstream-error.js')
const { generateUUID } = require('./tools.js')
const { logger } = require('./logger')

/**
 * App side of the browser egress (Qwen2API-3ue.2, docs/browser-egress-design.md).
 *
 * chats/new leaves from inside the account's resident page in the signin
 * worker (POST /egress), so qwen.ai sees Chromium's TLS and the profile's own
 * cookies. The worker answers 200 whenever the call left the page; qwen.ai's
 * status and body travel inside and get the classification the direct path
 * gives them (assertChatCreationResponse).
 *
 * CHAT_CREATION_TRANSPORT: browser = forced, direct = the axios path, auto =
 * browser when the app runs browser sessions against a configured worker. A
 * worker that cannot serve the call is never papered over with a direct
 * request: plain Node TLS from the egress IP is what Baxia refuses
 * (2026-11-23), so the failure stays loud and the client gets a retryable 503.
 */

// qwen.ai's budget for chats/new once the page is up. The worker's own HTTP
// budget adds the page's lazy open (Chromium start + chat root load) on top.
const CHAT_TIMEOUT_MS = 30000

// What the upstream can refuse and a live page reload is worth a try for.
const RECOVERABLE = new Set(['upstream_session_unauthorized', 'upstream_waf_challenge'])

// Only a refused session escalates to a password sign-in. A WAF challenge
// is not the session's fault, and logins are what it punishes: that one gets
// its reload and retry, and nothing more.
const UNAUTHORIZED = 'upstream_session_unauthorized'

const recoverable = error => error instanceof ChatCreationError && RECOVERABLE.has(error.code)

/**
 * @param {string} transport CHAT_CREATION_TRANSPORT
 * @param {object} app config: v2SessionMode and whether SIGNIN_WORKER_URL was set
 * @returns {boolean} whether chats/new leaves through the worker
 */
const usesWorker = (transport, { v2SessionMode, signinWorkerConfigured }) => (
    transport === 'browser' ||
    (transport === 'auto' && v2SessionMode === 'browser' && signinWorkerConfigured === true)
)

const enabled = () => usesWorker(config.chatCreationTransport, config)

// Only what the page's own client adds and qwen.ai needs from us; TLS,
// cookies, user agent and the sec-ch-* set are the browser's. The 2026-11-23
// probe passed with content-type + x-request-id. The Bearer is the session's,
// so a token the page rotated away from is refused here — and recovered inside
// this request — instead of failing the generation later on a direct call.
const egressHeaders = token => ({
    'content-type': 'application/json',
    'x-request-id': generateUUID(),
    authorization: `Bearer ${token}`
})

/**
 * One chats/new from inside the resident page.
 * @returns {Promise<string>} chat id
 * @throws {ChatCreationError} the categories the direct path throws; a worker
 *   that could not serve the call leaves as a SigninError for the caller to
 *   classify as a transport failure
 */
async function postChat(context, token) {
    const { email, account, url, body } = context
    let answer
    try {
        answer = await signinWorker.egress(email, account, {
            url, headers: egressHeaders(token), body: JSON.stringify(body), timeoutMs: CHAT_TIMEOUT_MS
        })
    } catch (error) {
        if (error.sessionLost) {
            // The profile no longer authenticates: the same refusal as a rejected session.
            throw new ChatCreationError('upstream_session_unauthorized')
        }
        logger.error(
            `CHAT_CREATION_TRANSPORT=${config.chatCreationTransport}: chats/new через signin-worker не прошёл` +
            `${error.workerCode ? ` (${error.workerCode})` : ''}: ${error.message}`, 'CHAT'
        )
        throw error
    }
    // Jar sync: what the browser holds now replaces the stored cookies of the same name.
    sessionPersistence.syncCookies(email, answer.cookies)
    let payload = answer.body
    try {
        payload = JSON.parse(answer.body)
    } catch {
        // Not JSON — an HTML challenge page is classified as raw text, like the direct path's.
    }
    return assertChatCreationResponse(payload)
}

const accepted = async (context, token) => {
    const chatId = await postChat(context, token)
    sessionPersistence.markSessionAccepted(context.email)
    return chatId
}

/**
 * Create a chat through the account's resident page, with real recovery: a
 * session the upstream refuses is replaced by a live one (the page is
 * reloaded, or the account re-logged in) and the call is made exactly once
 * more, inside this request.
 *
 * @param {object} options
 * @param {Object} [options.account] - Account (email, proxy)
 * @param {string} options.url - chats/new URL
 * @param {object} options.body - FE-shaped request body
 * @returns {Promise<string>} Chat ID
 * @throws {ChatCreationError}
 */
async function createChat({ account, url, body }) {
    // The worker pins /egress to the chat origin too; this keeps the app-side refusal the direct path's.
    if (new URL(url).origin !== store.chatOrigin) throw new Error('Unexpected v2 chat origin')
    const email = account?.email
    const context = { email, account, url, body }
    // The store is the source of truth for the token: a session a sibling
    // request recovered may be newer than the one the caller was handed.
    let session = store.sessions.get(email)
    // No session at all (invalidated meanwhile, or never restored): one recovery may still produce one.
    if (!session) session = await sessionPersistence.recoverSession(email, account, 'v2_session_required')
    if (!session) throw new ChatCreationError('v2_session_required', 409)
    try {
        return await accepted(context, session.token)
    } catch (error) {
        if (!recoverable(error)) throw error
        // A sibling request may have replaced the session this call went out
        // on (and was refused on): that one carries the retry, and this
        // request schedules no recovery of its own.
        const latest = store.sessions.get(email)
        const recovered = latest && latest.token !== session.token
            ? latest
            : await sessionPersistence.recoverSession(email, account, error.code)
        if (!recovered) throw error
        try {
            return await accepted(context, recovered.token)
        } catch (retryError) {
            // Refused as unauthorized again after a reload: a reload cannot
            // help this account. The full sign-in follows in the background,
            // rate-limited; this request has had its one retry.
            if (retryError.code === UNAUTHORIZED) sessionPersistence.escalateToRelogin(email, account, retryError.code)
            throw retryError
        }
    }
}

module.exports = { enabled, usesWorker, createChat, egressHeaders, CHAT_TIMEOUT_MS }
