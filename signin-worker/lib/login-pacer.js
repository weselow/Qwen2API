'use strict'

const { WorkerError } = require('./worker-errors')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One gate for every FULL sign-in of the worker (Qwen2API-43a), whatever the
 * account: logins line up for a slot, at least `minIntervalMs` apart (plus up
 * to the same again as jitter), measured from the start of the previous one.
 * Bulk import cannot machine-gun qwen.ai from the egress IP: a burst of N
 * logins, which fed the Baxia score on 21.11, becomes N spaced ones.
 *
 * Only the password flow comes through here. Silent renewals and lazy page
 * opens are plain page loads, like an open tab reloading.
 *
 * A request that would wait longer than `maxWaitMs` is refused at once with
 * `signin_paced` and keeps no slot: no HTTP request hangs for minutes, and no
 * sign-in runs that nobody is waiting for any more.
 *
 * Two steps, because the wait must not hold the account lock while the
 * browser flow itself runs under it:
 *
 *   admit()  synchronous, before the lock: takes a slot in line and answers
 *            when it is, plus the gap that follows it. Later arrivals queue
 *            behind that slot, so a burst is counted and refused as a whole
 *            instead of slept through one request at a time.
 *   enter()  right before the browser flow: normally instant. It only waits
 *            when the login before this one began later than its own slot
 *            (it was still launching its browser) and pushed its spacing
 *            forward, so the interval holds between real starts.
 *
 * @param {object} options
 * @param {number} options.minIntervalMs minimum between full sign-ins; <= 0 turns pacing off
 * @param {number} options.maxWaitMs longest wait accepted for a slot; <= 0 = unbounded
 * @param {() => number} options.random jitter source in [0, 1)
 */
function createLoginPacer({ minIntervalMs = 30000, maxWaitMs = 120000, random = Math.random } = {}) {
    // End of the last slot handed out: what the next request would wait for.
    let reservedUntil = 0
    // When a sign-in may really start: the previous real start plus its gap.
    let freeAt = 0

    const gap = () => minIntervalMs * (1 + random())

    /** @returns {{at: number, waitMs: number, spacing: number}} the slot taken, how far off it is, and the gap after it */
    function admit() {
        if (minIntervalMs <= 0) return { at: 0, waitMs: 0, spacing: 0 }
        const start = Date.now()
        const at = Math.max(start, reservedUntil, freeAt)
        const waitMs = at - start
        if (maxWaitMs > 0 && waitMs > maxWaitMs) {
            throw Object.assign(
                new WorkerError('signin_paced', 'Too many sign-ins are waiting; retry later.'),
                { retryAfterMs: waitMs }
            )
        }
        const spacing = gap()
        reservedUntil = at + spacing
        return { at, waitMs, spacing }
    }

    /**
     * Hold the caller until its sign-in may start, then claim the spacing
     * after it. Caller holds the account lock.
     * @param {{at: number, spacing: number}} slot as admit() returned it
     */
    async function enter(slot) {
        if (minIntervalMs <= 0) return
        const waitMs = Math.max(slot.at, freeAt) - Date.now()
        if (waitMs > 0) await sleep(waitMs)
        freeAt = Date.now() + slot.spacing
    }

    return { admit, enter }
}

module.exports = { createLoginPacer }
