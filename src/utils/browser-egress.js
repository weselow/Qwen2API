const config = require('../config/index.js')
const http = require('node:http')
const { Readable } = require('node:stream')
const store = require('./v2-session-store')
const signinWorker = require('./signin-worker-client')
const { accountRemoved, ACCOUNT_REMOVED } = require('./account-registry')
const sessionPersistence = require('./v2-session-persistence')
const {
    ChatCreationError, assertChatCreationResponse, detectWafChallenge, isWafChallengeBody,
    CHAT_CHALLENGE_RETRY_AFTER_SECONDS
} = require('./upstream-error.js')
const { SigninError } = require('./signin-error')
const { generateUUID } = require('./tools.js')
const { logger } = require('./logger')

/**
 * App side of the browser egress (Qwen2API-3ue.2 and .3, docs/browser-egress-design.md).
 *
 * qwen.ai API calls leave from inside the account's resident page in the
 * signin worker (POST /egress), so qwen.ai sees Chromium's TLS and the
 * profile's own cookies — and its own session: the app brings no Bearer, the
 * worker sends the call on the page's (Qwen2API-jr9). The worker answers 200
 * whenever the call left the page; qwen.ai's status and body travel inside.
 *
 * chats/new (CHAT_CREATION_TRANSPORT: browser = forced, direct = the axios
 * path, auto = browser when the app runs browser sessions against a
 * configured worker) gets the classification the direct path gives it
 * (assertChatCreationResponse). completions (COMPLETIONS_TRANSPORT=browser,
 * Qwen2API-3ue.3) are relayed as they arrive and handed on in the shape
 * postChatRequest gets from axios and from the impersonating transport.
 *
 * Since Qwen2API-03v the other qwen.ai calls of images/video and of file
 * upload take the same two roads. The JSON ones — chat info, video task
 * status, STS token, file parse — are whole-answer calls (egressJson), behind
 * the flag of chats/new. The generation of an image or a video is a
 * completions call, on the one address qwen.ai takes from a fetch alone
 * (Qwen2API-3ue.9): it goes through postCompletions, behind the flag of
 * completions.
 *
 * A worker that cannot serve the call is never papered over with a direct
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
const WAF_CHALLENGE = 'upstream_waf_challenge'

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

// What the app itself puts on an egress call. Everything a request of the
// page's own carries besides is the worker's to send, and it sends it with
// every call (Qwen2API-3ue.5): accept, source, the language, the time zone and
// the front end's version, read off the page — the direct path's profile has
// them from the account's fingerprint, which is not what the page says.
// The Bearer is not among them either (Qwen2API-jr9, 2026-11-25): a call that
// brings no authorization is one of the page's own, and the worker sends it on
// the page's localStorage.token. The app used to send its session's token —
// the one a renewal harvested, which the page, changing its token as it boots,
// may have moved on from: on 2026-11-24 (prod, image 439c35b) the same
// chats/new passed on the page's token and was refused as unauthorized on the
// renewal's. (Why qwen.ai refused that one is not established: a token of that
// kind passed from Node on 21.11.) On the app's token every rotation was a
// refused call and a reload; the page is the source of truth for the Bearer,
// as it is for cookies.
const egressHeaders = accept => ({
    'content-type': 'application/json',
    'x-request-id': generateUUID(),
    // The one call the page's own code sends with another accept than its XHRs' default.
    ...(accept ? { accept } : {})
})

// The same, for a call that carries no body: there is no content-type to state.
const egressHeadersOf = body => (body === undefined ? { 'x-request-id': generateUUID() } : egressHeaders())

/**
 * One chats/new from inside the resident page.
 * @returns {Promise<string>} chat id
 * @throws {ChatCreationError} the categories the direct path throws; a worker
 *   that could not serve the call leaves as a SigninError for the caller to
 *   classify as a transport failure
 */
async function postChat(context) {
    const { email, account, url, body } = context
    let answer
    try {
        answer = await signinWorker.egress(email, account, {
            url, headers: egressHeaders(), body: JSON.stringify(body), timeoutMs: CHAT_TIMEOUT_MS
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

const accepted = async context => {
    const chatId = await postChat(context)
    sessionPersistence.markSessionAccepted(context.email)
    return chatId
}

/**
 * The account was removed from the app while a request of its was out on it
 * (Qwen2API-u50). The request ends as one that did not get through — a 503
 * the client may retry — never as a fault of a session of an account that is
 * gone. Said once, here: what a request's own failures log is categories.
 * @param {string} email
 * @returns {ChatCreationError}
 */
const removedRequest = email => {
    logger.warn(`The account was removed from the app while its request was out on it; the request ends here (${email})`, 'CHAT')
    return new ChatCreationError(TRANSPORT, 503)
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
    // The session as of the call. None of it is sent — the Bearer is the
    // page's (Qwen2API-jr9) — but it says whether the account has one at all,
    // and below whether a sibling request replaced it while the call was out.
    let session = store.sessions.get(email)
    // No session at all (invalidated meanwhile, or never restored): one recovery may still produce one.
    if (!session) session = await sessionPersistence.recoverSession(email, account, 'v2_session_required')
    if (!session) {
        if (accountRemoved(email)) throw removedRequest(email)
        throw new ChatCreationError('v2_session_required', 409)
    }
    try {
        return await accepted(context)
    } catch (error) {
        if (!recoverable(error)) throw error
        // A sibling request may have recovered this account while this call
        // was out on a page that refused it: the store holds a newer session,
        // and the page is reloaded or re-logged in already. That one carries
        // the recovery; this request schedules none of its own.
        const latest = store.sessions.get(email)
        const recovered = latest && latest.token !== session.token
            ? latest
            : await sessionPersistence.recoverSession(email, account, error.code)
        // Refused as a session while the account was being removed: the account is gone, not its session.
        if (!recovered) throw accountRemoved(email) ? removedRequest(email) : error
        try {
            return await accepted(context)
        } catch (retryError) {
            // Refused as unauthorized again after a reload: a reload cannot
            // help this account. The full sign-in follows in the background,
            // rate-limited; this request has had its one retry.
            if (retryError.code === UNAUTHORIZED) sessionPersistence.escalateToRelogin(email, account, retryError.code)
            throw retryError
        }
    }
}

/* ------------------------------------------------- completions (Qwen2API-3ue.3) -- */

// How long qwen.ai may fall silent between two chunks of an answer. It is the
// page's own timer that cuts a silent stream; this is what the direct
// transports allow (request.js's timeout), handed to the worker as timeoutMs.
const COMPLETIONS_TIMEOUT_MS = 10 * 60 * 1000

// The answer's first SSE frame is held back from the caller for at most this
// long: nothing reaches the client before that frame anyway, and it is where
// a refusal of the session shows. Past it the stream is handed on as it is —
// a thinking model may take its time — so the client's first ping is never
// delayed by more than this.
const FIRST_FRAME_GRACE_MS = 3000
const FIRST_FRAME_MAX_BYTES = 256 * 1024
// A refused answer's body, as the impersonating transport buffers it.
const ERROR_BODY_MAX_BYTES = 64 * 1024
// The page cuts a silent upstream at timeoutMs and says so, and the worker's
// own backstop answers for a page that stopped reporting 5 s later. Past both
// of those a relay that is still quiet is the relay's doing.
const RELAY_GRACE_MS = 10000
// Injectable, like setRecoveryClockForTests in v2-session-persistence.js:
// tests shorten the waits instead of sleeping through them.
let firstFrameGraceMs = FIRST_FRAME_GRACE_MS
let relayGraceMs = RELAY_GRACE_MS
const setTimingForTests = ({ firstFrameMs = FIRST_FRAME_GRACE_MS, relaySilenceMs = RELAY_GRACE_MS } = {}) => {
    firstFrameGraceMs = firstFrameMs
    relayGraceMs = relaySilenceMs
}

const completionsEnabled = () => config.completionsTransport === 'browser'

// A failure of the relay, in the shape the caller's transport bookkeeping
// knows: request.js retries these while nothing reached the client. Whether it
// is charged to the account is said here, failure by failure.
const NODE_CODE_FOR_WORKER_CODE = { egress_timeout: 'ETIMEDOUT', relay_silent: 'ETIMEDOUT' }
// What qwen.ai did, or the road to it, as the page reports it. The direct
// transports see the same as ECONNRESET / ETIMEDOUT and charge it to the
// account; so does this. Every other way a relay ends is the egress's doing.
const UPSTREAM_FAULTS = new Set(['egress_failed', 'egress_timeout'])
const relayFailure = (workerCode, detail) => {
    const error = new Error(`signin-worker egress: ${workerCode}${detail ? ` (${detail})` : ''}`)
    error.code = NODE_CODE_FOR_WORKER_CODE[workerCode] || 'ECONNRESET'
    error.workerCode = workerCode
    error.notAccountFault = !UPSTREAM_FAULTS.has(workerCode)
    return error
}

// An upstream status, as axios and the impersonating transport reject it: the
// caller classifies it from there, the 429 quota included.
const httpError = (status, head, body) => {
    const error = new Error(`Request failed with status code ${status}`)
    error.isAxiosError = true
    error.code = status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST'
    error.response = { status, statusText: http.STATUS_CODES[status] || '', headers: head.headers, data: body }
    return error
}

// The session refused, as a frame of the answer says it: the keys
// assertChatCreationResponse reads for chats/new, and a bare error string.
const isUnauthorized = payload => Boolean(payload) && typeof payload === 'object' &&
    [payload.code, payload.error, payload.error?.code, payload.data?.code]
        .some(code => typeof code === 'string' && code.toLowerCase() === 'unauthorized')

// An HTML answer to an API call. On qwen.ai that is a WAF challenge page under
// status 200 (2026-11-24, through the page): the worker relays it whole.
const isHtmlAnswer = headers => /text\/html/i.test(String(headers?.['content-type'] || ''))

// The first complete SSE frame of what was relayed so far, and its payload
// when it is JSON.
const firstSseFrame = buffered => {
    const text = Buffer.concat(buffered).toString('utf8')
    const end = /\r?\n\r?\n/.exec(text)
    if (!end) return null
    const frame = text.slice(0, end.index)
    const data = frame.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
    let payload = null
    try {
        payload = JSON.parse(data)
    } catch { /* not JSON: nothing to read off it */ }
    return { text: frame, payload }
}

// `promise` settles first (true, however it settled) or `ms` passes (false).
const settlesWithin = async (promise, ms) => {
    let timer
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })
    try {
        return await Promise.race([promise.then(() => true, () => true), timeout])
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The worker's relay for one completions call, read one event at a time.
 * Resolves once qwen.ai answered: `head` is its status and headers. The body
 * is the caller's to read from there.
 *
 * Nothing is lost to a timeout here: a read that lost a race stays pending
 * and is awaited first by the next one, so an event that arrives late is
 * delivered late, not never.
 *
 * @returns {Promise<object>} head; refusal(), firstFrame(), handOff(), stop()
 * @throws the relay's own failures (relayFailure), a dead profile as a
 *   refused session, a misconfigured worker as its SigninError
 */
async function openCompletions(context) {
    let relay
    try {
        relay = await signinWorker.egressStream(context.email, context.account, {
            // The page's own completions call says `accept: application/json`, where its other XHRs carry axios's default.
            url: context.url, headers: egressHeaders('application/json'), body: context.body, timeoutMs: context.timeoutMs
        })
    } catch (error) {
        // The account was removed from the app while this request was out on it
        // (Qwen2API-u50): thrown as it is, ahead of the relay failure a retry
        // would mend — it is neither that nor the account's fault.
        if (error.code === ACCOUNT_REMOVED) throw error
        // The profile no longer authenticates: the same refusal chats/new makes of it.
        if (error.sessionLost) throw httpError(401, { headers: {} }, '')
        // The worker refusing the call itself (bad token, bad request) is a
        // configuration the caller cannot retry its way out of.
        if (!(error instanceof SigninError) || error.upstreamStatus === 400 || error.upstreamStatus === 401) {
            // (A relay out of shape arrives here too: the egress's, as well.)
            error.notAccountFault = true
            throw error
        }
        throw relayFailure(error.workerCode || 'worker_unreachable', error.message)
    }
    const iterator = relay.frames[Symbol.asyncIterator]()
    let pending = null
    let ended = false
    // One watchdog for the whole relay, re-armed by every event taken. The
    // page cuts a silent upstream at timeoutMs and says so, and the worker's
    // own backstop answers 5 s later: a relay still quiet past both is gone.
    // Before the hand-off that is a retryable failure; after it, the stream's.
    let watchdog = null
    let silence = Promise.resolve()
    const arm = () => {
        clearTimeout(watchdog)
        silence = new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(relayFailure('relay_silent')),
                context.timeoutMs + relayGraceMs)
            watchdog.unref?.()
        })
        // It may reject once the relay is over, with nobody left to see that.
        silence.catch(() => {})
    }
    const taken = async reading => {
        const result = await Promise.race([reading, silence])
        arm()
        if (result.done) throw relayFailure('relay_closed', 'the worker ended the stream before it was over')
        const event = result.value
        if (event.type === 'error') throw relayFailure(event.code || 'relay_error', event.message)
        return event
    }
    const read = () => {
        const reading = pending || iterator.next()
        pending = null
        return taken(reading)
    }
    /** The next event, or null when none came in `ms` (the read goes on where it was). */
    const readWithin = async ms => {
        if (!pending) {
            pending = iterator.next()
            // It may reject after the race was lost, with nobody left to see that.
            pending.catch(() => {})
        }
        // The grace, or the relay going quiet: whichever comes first.
        const waited = await Promise.race([
            settlesWithin(pending, ms),
            silence.then(() => 'silent', () => 'silent')
        ])
        if (waited === false) return null
        if (waited === 'silent') return taken(pending)
        const reading = pending
        pending = null
        return taken(reading)
    }
    const stop = () => {
        clearTimeout(watchdog)
        relay.close()
        iterator.return?.().catch?.(() => {})
    }

    let head
    try {
        arm()
        head = await read()
        if (head.type !== 'head' || !Number.isInteger(head.status)) {
            throw relayFailure('relay_malformed', 'no head event')
        }
    } catch (error) {
        stop()
        throw error
    }

    return {
        head,
        /** The rest of a refused answer as an axios-like error. Not waited for: an error body is short, or not worth the time. */
        async refusal() {
            const chunks = []
            let size = 0
            for (;;) {
                const event = await readWithin(firstFrameGraceMs)
                if (event === null || event.type === 'end') break
                const bytes = Buffer.from(event.data, 'base64').subarray(0, ERROR_BODY_MAX_BYTES - size)
                chunks.push(bytes)
                size += bytes.length
                if (size >= ERROR_BODY_MAX_BYTES) break
            }
            return httpError(head.status, head, Buffer.concat(chunks).toString('utf8'))
        },
        /**
         * The answer as far as its first complete SSE frame — every byte of it
         * included — or as far as the grace allows. `frame` is null when no
         * frame completed in time (or the answer is not SSE at all). With
         * `whole` nothing stops at a frame or at the grace: the answer is read
         * to its end, bounded by the size and by the relay's own silence budget.
         * @param {boolean} [whole]
         * @returns {Promise<{bytes: Buffer[], frame: {text: string, payload: object|null}|null}>}
         */
        async firstFrame({ whole = false } = {}) {
            const bytes = []
            let size = 0
            const started = Date.now()
            for (;;) {
                const left = firstFrameGraceMs - (Date.now() - started)
                const event = !whole && left > 0 ? await readWithin(left) : await read()
                if (event === null) return { bytes, frame: null }
                if (event.type === 'end') {
                    ended = true
                    // The jar as of the end, short as this answer was.
                    sessionPersistence.syncCookies(context.email, event.cookies)
                    return { bytes, frame: firstSseFrame(bytes) }
                }
                bytes.push(Buffer.from(event.data, 'base64'))
                size += bytes.at(-1).length
                const frame = firstSseFrame(bytes)
                if (size >= FIRST_FRAME_MAX_BYTES || (!whole && frame)) return { bytes, frame }
            }
        },
        /**
         * The answer in the caller's shape: {status, statusText, headers, data},
         * `data` a Readable of the body with what was read so far already in
         * it. From here on a failure is the stream's (it is destroyed with
         * it), the consumer closing the stream ends the relay, and a relay
         * that falls silent past its budgets ends the stream the same way.
         */
        handOff(readSoFar) {
            const data = new Readable({ read() {} })
            for (const bytes of readSoFar) data.push(bytes)
            // A failure nobody is left to see must not take the process down:
            // an 'error' with no listener is fatal. A consumer's own handling
            // is not in the way; an answer that ended unread leaves a line.
            data.on('error', error => {
                if (data.listenerCount('error') === 1) {
                    logger.warn(`COMPLETIONS_TRANSPORT=browser: the answer ended with nobody reading it` +
                        ` (${error.workerCode || error.code})`, 'REQUEST')
                }
            })
            // The consumer is done with the answer — it read to the end,
            // stopped early or went away — and the relay ends with it.
            data.on('close', stop)
            ;(async () => {
                try {
                    while (!ended) {
                        const event = await read()
                        if (event.type === 'end') {
                            ended = true
                            // The jar as of the end: the last word on what the browser holds.
                            sessionPersistence.syncCookies(context.email, event.cookies)
                            continue
                        }
                        // (No back-pressure from here on, as for the direct
                        // transports: the controllers write to their client
                        // without waiting, so this stream is always drained.)
                        data.push(Buffer.from(event.data, 'base64'))
                    }
                    data.push(null)
                } catch (error) {
                    data.destroy(error)
                } finally {
                    clearTimeout(watchdog)
                }
            })()
            return {
                status: head.status,
                statusText: http.STATUS_CODES[head.status] || '',
                headers: head.headers,
                data
            }
        },
        stop
    }
}

/**
 * One attempt: the call, up to the point the answer is the caller's. A
 * refusal of the session is thrown as the 401 the direct transports reject
 * with; so is everything else that went wrong.
 */
async function streamCompletions(context) {
    const relay = await openCompletions(context)
    try {
        // Jar sync, as for chats/new: what the browser holds now replaces the
        // stored cookies of the same name.
        sessionPersistence.syncCookies(context.email, relay.head.cookies)
        if (relay.head.status < 200 || relay.head.status >= 300) throw await relay.refusal()
        // An HTML answer is read whole — a challenge page is told by its
        // markers, and it is a page, not a frame of an answer.
        const html = isHtmlAnswer(relay.head.headers)
        // Nothing has reached the client yet, so a refusal is still one this
        // request can answer — by the caller's retry in postCompletions.
        const first = await relay.firstFrame({ whole: html })
        if (!html && isUnauthorized(first.frame?.payload)) throw httpError(401, relay.head, first.frame.text)
        // (The session is not marked accepted here: chats/new did that for this
        // very request a moment ago, and it is the call that proves a session.)
        return {
            response: relay.handOff(first.bytes),
            // A WAF challenge page, status 200 and all (2026-11-24): the worker
            // hands it on as qwen.ai's answer; whether it is one is said here,
            // by the markers the direct path is screened by.
            challenge: html && isWafChallengeBody(Buffer.concat(first.bytes).toString('utf8'))
        }
    } catch (error) {
        relay.stop()
        throw error
    }
}

/**
 * One completions call from inside the account's resident page, with the
 * recovery chats/new gets: a session qwen.ai refuses is replaced by a live
 * one (the page is reloaded) and the call is made exactly once more. So is a
 * WAF challenge page — what a refusal of the request, not of the session,
 * looks like through the page (Qwen2API-3ue.6): the page is reloaded and the
 * call made once more.
 *
 * Unlike chats/new, a refusal that survives the reload escalates to nothing.
 * The password is spent on chats/new's verdict alone — that is the call that
 * proves a session — and it has just passed for this very request. A
 * completions refusal after it is no verdict on the profile; and were
 * completions refused for a reason of their own (a header the in-page call
 * lacks, say), every request would otherwise be chats/new accepting the
 * session, resetting the sign-in backoff, and completions spending a password
 * login on it: one a minute, for as long as it lasted.
 *
 * @param {object} context
 * @param {Object} context.account - Account (email, proxy)
 * @param {string} context.url - completions URL
 * @param {string} context.body - The v2.1 request body, serialized
 * @param {number} [context.timeoutMs] - How long qwen.ai may fall silent
 * @returns {Promise<object>} axios-shaped response with data as a Readable
 */
async function postCompletions(context) {
    const { account } = context
    const email = account?.email
    // The session as of the call, for the sibling check below; the call
    // itself goes out on the page's token (Qwen2API-jr9).
    let session = store.sessions.get(email) || null
    // The silence budget is the direct transports' unless the caller brings a
    // number of its own (an undefined one would arm every timer for "NaN").
    const call = { ...context, email, timeoutMs: context.timeoutMs ?? COMPLETIONS_TIMEOUT_MS }
    // A sibling request may have recovered this account while this call was
    // out on a page that refused or challenged it: that one carries the retry.
    const recovered = async reason => {
        const latest = store.sessions.get(email)
        return latest && latest.token !== session?.token
            ? latest
            : await sessionPersistence.recoverSession(email, account, reason)
    }
    for (let attempt = 1; ; attempt++) {
        try {
            const { response, challenge } = await streamCompletions(call)
            if (!challenge || attempt > 1) return response
            // Challenged again after the reload: the answer goes on as it is,
            // and the caller screens it as it screens a direct one's.
            const live = await recovered(WAF_CHALLENGE)
            if (!live) return response
            // The challenged answer is nobody's now: its relay is closed.
            response.data.destroy()
            session = live
        } catch (error) {
            if (error.response?.status !== 401 || attempt > 1) throw error
            const live = await recovered(UNAUTHORIZED)
            // Refused as a session while the account was being removed (Qwen2API-u50): a failure
            // the retry mends — by refusing it; the retry is where the removal is said.
            if (!live) throw accountRemoved(email) ? relayFailure('account_removed', 'The account was removed from the app.') : error
            session = live
        }
    }
}

/* -------------------------- whole-answer calls to any address of the origin (Qwen2API-03v) -- */

// qwen.ai's budget for a JSON call once the page is up: what the direct
// callers allow axios.
const JSON_TIMEOUT_MS = 30000
const TRANSPORT = 'upstream_transport_error'

// What qwen.ai said to a call that cannot use its answer — in the categories
// chats/new throws, the codes the clients know — and the status each goes
// with there. Said of the call it was: these do not create a chat.
const CALL_FAILURES = {
    [UNAUTHORIZED]: ['Qwen session authorization rejected; this is not Qwen2API client authentication', 502],
    [WAF_CHALLENGE]: ['Qwen requires WAF/CAPTCHA verification', 503],
    [TRANSPORT]: ['Qwen upstream call failed in the signin worker', 503]
}

/**
 * A whole-answer call that qwen.ai refused, or that the worker could not
 * carry: a ChatCreationError, so that every caller already answering those
 * (the media controller) answers this one the same way — by code and status.
 */
class EgressCallError extends ChatCreationError {
    constructor(code) {
        super(code, CALL_FAILURES[code][1])
        this.message = this.publicMessage = CALL_FAILURES[code][0]
        this.name = 'EgressCallError'
    }
}

// A worker that could not carry the call — unreachable, a page that closed
// or hung, its limit of pages. Its own code is for the log and the error.
const notCarried = error => Object.assign(new EgressCallError(TRANSPORT), { workerCode: error.workerCode || null })

// Only what a reload of the page can heal is worth one. A worker that could
// not carry the call is not retried either: what is wrong with it is not in the page.
const callRecoverable = error => error instanceof EgressCallError && RECOVERABLE.has(error.code)

// A challenge refused the call. It carries the wait every chat challenge is
// answered with: the media controller gives a generation's to its client as
// Retry-After, and this one's goes the same way.
const challengedCall = () => Object.assign(new EgressCallError(WAF_CHALLENGE), { retryAfter: CHAT_CHALLENGE_RETRY_AFTER_SECONDS })

/**
 * One whole-answer call as far as the worker's answer. The page is the
 * source of the Bearer and of the cookies, as for every egress call: the app
 * sends no authorization.
 * @returns {Promise<object>} the worker's answer, the jar it returned folded into the session
 * @throws {EgressCallError} a profile that no longer authenticates; a worker
 *   that could not carry the call
 */
async function wholeAnswer({ email, account, url, method, body, timeoutMs }) {
    let answer
    try {
        answer = await signinWorker.egress(email, account, {
            url, method, headers: egressHeadersOf(body), body, timeoutMs
        })
    } catch (error) {
        // The profile no longer authenticates: the same refusal as a session qwen.ai rejected.
        if (error.sessionLost) throw new EgressCallError(UNAUTHORIZED)
        logger.error(
            `CHAT_CREATION_TRANSPORT=${config.chatCreationTransport}: ${method} ${new URL(url).pathname}` +
            ` через signin-worker не прошёл${error.workerCode ? ` (${error.workerCode})` : ''}: ${error.message}`, 'CHAT'
        )
        throw notCarried(error)
    }
    sessionPersistence.syncCookies(email, answer.cookies)
    return answer
}

// qwen.ai's answer to a JSON call, in the shape axios hands one over.
const jsonAnswer = answer => {
    let payload = answer.body
    try {
        payload = JSON.parse(answer.body)
    } catch {
        // Not JSON — an HTML challenge page is classified as raw text, like the direct path's.
    }
    // A challenge page under status 200, or the punish envelope (2026-11-24): by
    // the markers the direct path is screened with. Read before the session, as
    // assertChatCreationResponse reads them: a challenge is no verdict on the
    // session — it is worth a reload, and never a password.
    if (detectWafChallenge(payload)) throw challengedCall()
    // A 401, or the envelope under any status: what assertChatCreationResponse reads for chats/new.
    if (answer.status === 401 || isUnauthorized(payload)) throw new EgressCallError(UNAUTHORIZED)
    // The body as parsed as the direct path gets it with responseType json.
    if (answer.status < 200 || answer.status >= 300) throw httpError(answer.status, answer, payload)
    return {
        status: answer.status,
        statusText: http.STATUS_CODES[answer.status] || '',
        headers: answer.headers,
        data: payload
    }
}

/**
 * One JSON call to qwen.ai from inside the account's resident page, answered
 * whole: chat info, video task status, STS token, file parse — any address of
 * the chat origin (Qwen2API-03v). It is a whole-answer call as chats/new is
 * one, an XMLHttpRequest with the page's own headers, and it is switched by
 * the same flag (CHAT_CREATION_TRANSPORT: enabled()).
 *
 * It gets the recovery the completions get, not the one chats/new gets. A
 * session qwen.ai refuses, and a WAF challenge page, are answered with a
 * reload of the page and exactly one more call. A refusal that survives the
 * reload escalates to nothing: the password is spent on chats/new's verdict
 * alone, and that call has just passed for the request this one belongs to
 * (docs/browser-egress-design.md, completions).
 *
 * A worker that cannot carry the call is never papered over — with a direct
 * request, nor with an empty answer: the callers used to read any failure as
 * "not ready yet" and poll on, for the twenty minutes a video task is given.
 * It leaves as a retryable 503.
 *
 * @param {object} context
 * @param {Object} [context.account] - Account (email, proxy): whose page the call leaves from
 * @param {string} context.url - Absolute, on the chat origin
 * @param {string} [context.method] - GET unless said otherwise
 * @param {string} [context.body] - Passed through as text
 * @param {number} [context.timeoutMs] - qwen.ai's budget for the call
 * @returns {Promise<object>} axios-shaped response; `data` is the body parsed
 *   as JSON where it parses, the text otherwise
 * @throws {EgressCallError} a session refused with the recovery spent (twice,
 *   or once inside the interval of the last one), a challenge likewise — with
 *   the chat challenge's wait on it —, a worker that could not carry the call
 * @throws {Error} a non-2xx of qwen.ai, as axios rejects one (isAxiosError, response)
 */
async function egressJson(context) {
    // The worker pins /egress to the chat origin too; this keeps the app-side refusal.
    if (new URL(context.url).origin !== store.chatOrigin) throw new EgressCallError(TRANSPORT)
    const { account } = context
    const email = account?.email
    // The session as of the call, for the sibling check below. None of it is
    // sent — the Bearer is the page's (Qwen2API-jr9) — and none is required:
    // the call goes out on the page's session, as a completions call does.
    let session = store.sessions.get(email) || null
    const call = {
        email, account, url: context.url, method: context.method || 'GET',
        body: context.body === undefined ? undefined : String(context.body),
        // The direct callers' budget unless the caller brings a number of its own.
        timeoutMs: context.timeoutMs ?? JSON_TIMEOUT_MS
    }
    for (let attempt = 1; ; attempt++) {
        try {
            return jsonAnswer(await wholeAnswer(call))
        } catch (error) {
            if (!callRecoverable(error) || attempt > 1) throw error
            // A sibling request may have recovered this account while this
            // call was out on a page that refused it: the store holds a newer
            // session, and the page is reloaded already. That one carries the
            // recovery; this call schedules none of its own.
            const latest = store.sessions.get(email)
            const live = latest && latest.token !== session?.token
                ? latest
                : await sessionPersistence.recoverSession(email, account, error.code)
            // The account was removed meanwhile (Qwen2API-u50): a call that did not get through, not a session's fault.
            if (!live) throw accountRemoved(email) ? notCarried({ workerCode: 'account_removed' }) : error
            session = live
        }
    }
}

/**
 * What a failed egress call is to the client, in the object form the media
 * controller answers with — or null for an error that is not the egress's to
 * name: an HTTP status of qwen.ai's is the caller's to classify, as a direct
 * one is. A session qwen.ai refused twice is a 502 with its code. A call that
 * did not get through the egress is a retryable 503: the worker's doing as
 * often as not, though qwen.ai's own silence on it (`egress_timeout`) and the
 * road to it failing (`egress_failed`) arrive here too — the text path
 * charges those two to the account, and the media controller keeps no books.
 * @param {*} error - As postCompletions rejected
 * @returns {{status: number, error: string, code: string}|null}
 */
const callFailure = error => {
    // As axios and the impersonating transport reject a status; as postCompletions rejects a session.
    if (error?.isAxiosError && error.response?.status === 401) {
        return { status: CALL_FAILURES[UNAUTHORIZED][1], error: CALL_FAILURES[UNAUTHORIZED][0], code: UNAUTHORIZED }
    }
    // The relay's own failures carry the worker's code; a worker refusing
    // the call itself is a SigninError.
    if (error instanceof SigninError || typeof error?.workerCode === 'string') {
        return { status: CALL_FAILURES[TRANSPORT][1], error: CALL_FAILURES[TRANSPORT][0], code: TRANSPORT }
    }
    return null
}

module.exports = {
    enabled, usesWorker, createChat, egressHeaders, CHAT_TIMEOUT_MS,
    completionsEnabled, postCompletions, setTimingForTests,
    COMPLETIONS_TIMEOUT_MS, FIRST_FRAME_GRACE_MS, RELAY_GRACE_MS,
    egressJson, callFailure, EgressCallError, JSON_TIMEOUT_MS
}
