'use strict'

/*
 * The one retry of a whole answer (Qwen2API-jk9, 2026-11-27).
 *
 * A request without a stream — stream:false on /v1/chat/completions and on /v1/messages — is
 * answered whole: not a byte of the answer reaches the client before all of it is in. So when
 * the request's first attempt dies, the client has been told nothing yet, and the request can
 * be made once more from its start — a new chats/new, a new completions call, the answer read
 * from its first byte — and the client never learns there was a first one.
 *
 * What that is worth was measured in the first hour of real traffic on 27.11: 57 requests, 6
 * refused, and not one of the six asked for again. Two chats/new did not come back out of the
 * page in 30 s (the worker: 504 egress_timeout; the client: 503). Two answers qwen.ai refused
 * with a 502 on the head of completions (the client: 502). Two answers had their connection go
 * under them while they were being read (the worker: egress_failed; the application:
 * ECONNRESET) — both without a stream, 241 666 bytes and 147 128 bytes read, and not a byte
 * delivered.
 *
 * What gets the retry is the death of the request's first attempt, in three ways — and nothing
 * else about that attempt does:
 *
 *   upstream_broke      the answer broke while it was read. The relay ended in an error event
 *                       that is qwen.ai's or the road to it — egress_failed —, or the page's
 *                       doing — page_closed, browser_error; or, on a direct transport, the
 *                       connection went and qwen.ai said nothing at all
 *                       (request.js#isRetryableNetworkError).
 *   upstream_5xx        qwen.ai answered the head of completions with a status of 500 or more.
 *   chats_new_timeout   chats/new did not come back out of the page in time, and the worker
 *                       said so (504 egress_timeout).
 *
 * The handlers of a whole answer ask once more on their own at times: the empty-output
 * compensation of chat.js, and the correcting round the turn gate asks for in anthropic.js and
 * in the agent handler of chat.js. Of what happens on such a round of theirs, one thing gets the
 * whole retry — its answer breaking while it is read, for the client was told nothing of that
 * round either. A call refused on it, by any word, and qwen.ai's 5xx on the head of its
 * completions are the handler's to answer, as they always were.
 *
 * A refused call is told from a broken read by what the error is, never by the word on it. Every
 * refusal of chats/new is a ChatCreationError; the verdict the application reads off a frame —
 * a quota, a challenge, a business failure — is an UpstreamResponseError; a context attachment
 * that failed is a ContextExternalizationError, and its cause may well say "other side closed".
 * A broken read is the relay's plain Error with the worker's word on it
 * (browser-egress.js#relayFailure), or a direct transport's error with the network's code.
 *
 * Everything else is answered as it always was (the decisions of Qwen2API-jk9): the relay's
 * own silences and malformations — relay_silent, relay_closed, relay_malformed, relay_error —,
 * an account removed, a worker that is not there or misconfigured, qwen.ai's silence under an
 * answer that began (egress_timeout), an answer that ended early without an error
 * (upstream_incomplete), its 4xx and its 429, and every failure of the application's own.
 *
 * One retry per request. A retry that dies is answered as that second failure always was. The
 * retry is made only while the request is younger than WHOLE_ANSWER_RETRY_BUDGET_MS, and never
 * for a client that is gone: whether it is, is asked of the request and its socket and of
 * nothing else (utils/client-gone.js), as everywhere.
 *
 * Requests with a stream do not come here. A stream commits with its first frame, and what it
 * delivered cannot be taken back.
 */

const { logger } = require('./logger')
const { isRetryableNetworkError } = require('./request.js')
const { ChatCreationError, UpstreamResponseError, isContextAttachmentError } = require('./upstream-error.js')
const { COMPLETIONS_TIMEOUT_MS } = require('./browser-egress.js')

// How old a request may be and still get its whole retry: half of what qwen.ai may take to
// answer one (browser-egress.js#COMPLETIONS_TIMEOUT_MS). The age is counted from the moment
// the controller began with the request, ahead of its first chats/new.
const WHOLE_ANSWER_RETRY_BUDGET_MS = COMPLETIONS_TIMEOUT_MS / 2

// Before the request is asked again, with chats/new that did not come back in time.
const CHATS_NEW_TIMEOUT_PAUSE_MS = 2000

// How the relay says an answer broke under its reader, and the break is qwen.ai's or the
// road's (browser-egress.js#relayFailure). Any other word on it is not this retry's to mend.
const BROKEN_ANSWER_CODES = new Set(['egress_failed', 'page_closed', 'browser_error'])

// The worker's word for a call its page did not answer in time
// (signin-worker/lib/egress-fetch.js#CODE_FOR_OUTCOME).
const CHATS_NEW_TIMEOUT = 'egress_timeout'

// How the log lines name each reason. A reason may carry a detail after a comma: the relay's
// code, the network error's, the status qwen.ai answered with.
const BROKEN = 'upstream_broke'
const NETWORK_ERROR = 'network_error'
const UPSTREAM_5XX = 'upstream_5xx'
const CHATS_NEW_TIMED_OUT = 'chats_new_timeout'

// Injectable, like setRecoveryClockForTests in v2-session-persistence.js and setTimingForTests
// in browser-egress.js: tests move the clock instead of waiting the budget out, and shorten or
// hold the pause instead of sleeping through it.
let clock = () => Date.now()
let sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const setWholeAnswerRetryForTests = ({ now = null, pause = null } = {}) => {
    clock = typeof now === 'function' ? now : () => Date.now()
    sleep = typeof pause === 'function' ? pause : ms => new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `ms`, or less: the pause of a retry is not sat out for a client that goes away meanwhile.
 * @param {number} ms
 * @param {object|null} client - What watchClient(req) returns; without one nobody leaves
 */
const waitFor = async (ms, client) => {
    if (!client) return sleep(ms)
    let unsubscribe = () => {}
    const leaving = new Promise(resolve => { unsubscribe = client.onGone(resolve) })
    try {
        await Promise.race([sleep(ms), leaving])
    } finally {
        unsubscribe()
    }
}

/**
 * Why a first attempt that died gets the request's whole retry — or null: it does not.
 * @param {{thrown?: Error, refused?: object, broke?: Error}} failure - How the attempt died:
 *   `thrown` — sendChatRequest threw; `refused` — it answered {status: false}; `broke` — what
 *   came out of the handler answering it: the read of its answer ended in an error, or the
 *   handler let out the failure of a round of its own, which is no break of a read (see below)
 * @returns {string|null} The reason, as the log lines name it
 */
const reasonFor = ({ thrown = null, refused = null, broke = null }) => {
    if (thrown) {
        // chats/new: the worker's code travels on the error the request module throws
        // (request.js#generateChatID). A transport that went with no word from any worker
        // carries none, and is not this one.
        return thrown instanceof ChatCreationError && thrown.workerCode === CHATS_NEW_TIMEOUT
            ? CHATS_NEW_TIMED_OUT
            : null
    }
    if (refused) {
        // The HTTP status that stands on the refusal, when one does — which status that can be,
        // and that a 401 among them may be the egress's own, request.js#postChatRequest says. A
        // 5xx is qwen.ai refusing the call, by the only measure the request module has; the 401
        // is not taken even where it is qwen.ai's, for the egress recovers from that inside the call.
        const status = refused.upstreamStatus
        return Number.isInteger(status) && status >= 500 ? `${UPSTREAM_5XX}, ${status}` : null
    }
    if (!broke || typeof broke !== 'object') return null
    // A refused call, or a failure of the application's own, is no break of a read — whatever
    // stands on it. Every refusal of chats/new is a ChatCreationError, with the worker's word on
    // it (request.js#generateChatID), and a handler that asked for a call on a round of its own
    // lets its refusal out like a broken read; the word on it may be page_closed. The verdict the
    // application reads off a frame — a quota, a challenge — is an UpstreamResponseError. A
    // context attachment that failed is a ContextExternalizationError, and its cause may well
    // say "other side closed". The handler that asked, or read, answers these as it always did.
    // What is left is a read of an answer that broke: the relay's plain Error with the worker's
    // word on it (browser-egress.js#relayFailure), or a direct transport's error with the
    // network's code.
    if (broke instanceof UpstreamResponseError || isContextAttachmentError(broke)) return null
    // What the relay said of it is the whole of it: with a worker's code on it, the break is
    // judged by that code and by nothing else — a relay that fell silent cuts like a socket
    // does (ECONNRESET, ETIMEDOUT), and is no break of qwen.ai's.
    const workerCode = typeof broke.workerCode === 'string' ? broke.workerCode : ''
    if (workerCode) return BROKEN_ANSWER_CODES.has(workerCode) ? `${BROKEN}, ${workerCode}` : null
    return isRetryableNetworkError(broke)
        ? `${NETWORK_ERROR}, ${broke.code || broke.cause?.code || 'unknown'}`
        : null
}

// What a first attempt's death gets when its client is gone: nothing is retried, nothing is
// answered, and nothing of it is logged as a failure.
const CLIENT_LEFT = Symbol('client left')

/**
 * The whole retry of one request. The controller makes it as it begins with the request: that
 * moment is where the budget is counted from.
 * @param {object} [request]
 * @param {object|null} [request.client] - What watchClient(req) returns (utils/client-gone.js);
 *   a request without one is a client that stays
 * @returns {{run: Function, wants: Function}}
 */
const createWholeAnswerRetry = ({ client = null } = {}) => {
    const startedAt = clock()
    const gone = () => client?.gone() === true
    // Said once the retry is under way: there is no third request.
    let spent = false

    /**
     * What a first attempt's death gets: the reason of the retry, CLIENT_LEFT — or null, and
     * the failure is answered as it always was.
     * @param {{thrown?: Error, refused?: object, broke?: Error}} failure
     * @returns {string|Symbol|null}
     */
    const judge = (failure) => {
        const reason = reasonFor(failure)
        if (!reason) return null
        if (gone()) return CLIENT_LEFT
        return clock() - startedAt < WHOLE_ANSWER_RETRY_BUDGET_MS ? reason : null
    }

    return {
        /**
         * Whether the handler of a whole answer lets an error of its read out instead of answering
         * it — for the handler to ask before it answers a failure itself. True for a break of a
         * read that the request still has its retry for, and true when the client is gone: in
         * both nothing is the handler's to answer — `run` makes the request once more, or ends it
         * for the client that left. False for everything else, and then the handler answers as it
         * always did.
         * @param {Error} error - As the read of the answer ended
         * @returns {boolean}
         */
        wants: (error) => !spent && judge({ broke: error }) !== null,

        /**
         * One request answered whole, with its one retry.
         * @param {object} handlers
         * @param {() => Promise<object>} handlers.send - One sendChatRequest, as the client made the request
         * @param {(upstream: object) => Promise<boolean|void>} handlers.answer - Reads one answer and answers the
         *   client with it; resolves with true once the answer was delivered. Whatever else it resolves with is
         *   a failure it answered itself.
         * @param {(refusal: object) => Promise<void>|void} handlers.refused - Answers a request sendChatRequest refused
         * @returns {Promise<boolean>} Whether the client got its answer. What is not retried here is thrown back,
         *   or given to `refused`, for the controller to answer as it always did.
         */
        run: async ({ send, answer, refused }) => {
            // The reason of the retry under way; null while this is the first attempt.
            let reason = null
            for (;;) {
                let failure = null
                let upstream = null
                try {
                    upstream = await send()
                } catch (error) {
                    // A rejection with nothing in it is still a failure, and goes back as one: thrown
                    // back as it is, it would leave the controller's catch with nothing to read.
                    failure = { thrown: error ?? new TypeError('sendChatRequest rejected with nothing said') }
                }
                // sendChatRequest answers an object — {status: true, response, …} or {status: false,
                // failure, …}. Anything else is no answer of its: it goes back to the controller as the
                // failure it always was, and not as a refusal that is not one.
                if (!failure && (!upstream || typeof upstream !== 'object')) {
                    failure = {
                        thrown: new TypeError('sendChatRequest answered nothing that could be read as the result of a request')
                    }
                }
                if (!failure && (!upstream.status || !upstream.response)) failure = { refused: upstream }
                if (!failure) {
                    try {
                        const delivered = await answer(upstream)
                        if (reason && delivered === true) {
                            logger.info(`非流式整体重试成功 (原因: ${reason})`, 'REQUEST')
                        }
                        return delivered === true
                    } catch (error) {
                        failure = { broke: error }
                    }
                }

                const verdict = reason ? null : judge(failure)
                if (verdict === CLIENT_LEFT || (reason && gone())) return false
                if (!verdict) {
                    // Not the retry's to mend — a first attempt that is not its, or the retry itself.
                    if (!failure.refused) throw failure.thrown || failure.broke
                    await refused(failure.refused)
                    return false
                }
                if (failure.thrown) {
                    // chats/new did not come back in time: a pause first, which the client's leaving ends.
                    await waitFor(CHATS_NEW_TIMEOUT_PAUSE_MS, client)
                    if (gone()) return false
                }
                reason = verdict
                spent = true
                logger.warn(`非流式整体重试 (原因: ${reason})`, 'REQUEST')
            }
        }
    }
}

module.exports = {
    createWholeAnswerRetry,
    setWholeAnswerRetryForTests,
    reasonFor,
    WHOLE_ANSWER_RETRY_BUDGET_MS,
    CHATS_NEW_TIMEOUT_PAUSE_MS
}
