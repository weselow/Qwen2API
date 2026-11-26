'use strict'

const { WorkerError } = require('./worker-errors')
const { createLoginPacer } = require('./login-pacer')

/**
 * One turn for every page qwen.ai is asked to serve the worker, from whatever
 * account (Qwen2API-nch, Qwen2API-ops; 2026-11-26): a lazy open, a renewal, a
 * sign-in. They start at least `minIntervalMs` apart, plus up to the same again
 * as jitter, measured from the start of the previous one — the slots of the
 * login pacer (lib/login-pacer.js), which spaces full sign-ins on their own.
 * The worker's pages are like tabs: one reloading is a tab reloading, and
 * sixteen reloading within a second, as they would after a restart or when a
 * timer renews every account at once, is a burst from one address — what fed
 * qwen.ai's risk score on 2026-11-21.
 *
 * Unlike the login pacer this one never refuses: a page load is on the way of a
 * call somebody is waiting for, so it waits its turn, however long the line.
 * Only the worker stopping ends a wait.
 *
 * @param {object} options
 * @param {number} options.minIntervalMs minimum between page loads, across every account; <= 1 turns the queue off
 * @param {() => number} options.random jitter source in [0, 1)
 * @param {(event: string, detail: string) => void} options.log told of every wait: 'page-load', with how long
 */
function createPageLoadQueue({ minIntervalMs = 10000, random = Math.random, log = () => {} } = {}) {
    const slots = createLoginPacer({ minIntervalMs, maxWaitMs: 0, random })
    let stopped = false
    // Every waiter, to be told at once when the worker stops.
    const waiting = new Set()

    const closed = () => new WorkerError('page_closed', 'The worker is shutting down.')

    /** Resolves when the caller may load a page. Rejects only with `page_closed`, when the worker is stopping. */
    async function wait() {
        if (stopped) throw closed()
        const slot = slots.admit()
        if (slot.waitMs > 0) {
            await new Promise((resolve, reject) => {
                const waiter = { reject, timer: null }
                waiter.timer = setTimeout(() => {
                    waiting.delete(waiter)
                    resolve()
                }, slot.waitMs)
                waiting.add(waiter)
            })
            // Stopped while it waited: the turn it was given is nobody's now.
            if (stopped) throw closed()
        }
        // Normally instant: the slot is this caller's own. It only waits when
        // the load before it began later than its slot, as the login pacer's does.
        await slots.enter(slot)
        if (stopped) throw closed()
        // The jitter makes the wait a fraction of a millisecond: said as a whole one, never rounded down.
        if (slot.waitMs > 0) log('page-load', `waited (${Math.ceil(slot.waitMs)} ms)`)
    }

    /** The worker is stopping: nobody waits for a turn any more, and nobody gets one. */
    function stop() {
        stopped = true
        for (const waiter of waiting) {
            clearTimeout(waiter.timer)
            waiter.reject(closed())
        }
        waiting.clear()
    }

    return { wait, stop }
}

module.exports = { createPageLoadQueue }
