'use strict'

const { WorkerError } = require('./worker-errors')

/**
 * One turn for every page qwen.ai is asked to serve the worker, from whatever
 * account (Qwen2API-nch, Qwen2API-ops; 2026-11-26): a lazy open, a renewal.
 * They start at least `minIntervalMs` apart, plus up to the same again as
 * jitter, measured from the turn before. The worker's pages are like tabs: one
 * reloading is a tab reloading, and sixteen reloading within a second, as they
 * would after a restart or when a timer renews every account at once, is a
 * burst from one address — what fed qwen.ai's risk score on 2026-11-21.
 *
 * How it differs from the login pacer (lib/login-pacer.js), whose idea it shares:
 *
 *   - It never refuses: a page load is on the way of a call somebody is waiting
 *     for. What bounds the wait instead is the line: no load waits for its turn
 *     longer than `maxWaitMs` — save for what a sign-in that begins just before
 *     its turn holds it back by, one interval at most. A line too long for that
 *     is packed evenly into it — the same order, still one after the other, only
 *     closer — so that a long line neither outlives the application's budget for
 *     the request it is on the way of nor turns, past some limit, into a burst.
 *   - A sign-in does not wait here. The login pacer is what spaces sign-ins, and
 *     the application's budget for one accounts for that pacer alone. A sign-in
 *     tells the queue when it begins (note()), and the queue keeps what follows
 *     a gap away from it — even where that makes a wait longer than the limit:
 *     keeping apart is what the queue is for, and the application's budget for a
 *     call has room for one interval more.
 *
 * The turn is for the browser's launch: a lazy open waits for it before the
 * browser starts, so that a line of openings is not a line of browsers waiting,
 * and the navigation follows the launch within seconds.
 *
 * @param {object} options
 * @param {number} options.minIntervalMs minimum between page loads, across every account; <= 1 turns the queue off
 * @param {number} options.maxWaitMs longest a load waits for its turn, not counting what a sign-in held it back by; <= 0 = unbounded
 * @param {() => number} options.random jitter source in [0, 1)
 * @param {(event: string, detail: string) => void} options.log told of every wait: 'page-load'
 */
function createPageLoadQueue({ minIntervalMs = 10000, maxWaitMs = 120000, random = Math.random, log = () => {} } = {}) {
    const off = !(minIntervalMs > 1)
    // The turns handed out and not begun, in order: when each arrived and when
    // it begins, and how far it keeps the one after it.
    const line = []
    // Not before this may the next turn be: one gap after the load that began last.
    let freeAt = 0
    let stopped = false

    const closed = () => new WorkerError('page_closed', 'The worker is shutting down.')
    const gap = () => minIntervalMs * (1 + random())
    const arm = (entry, at) => {
        entry.at = at
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => entry.wake?.(), Math.max(0, at - Date.now()))
        entry.timer.unref?.()
    }

    /**
     * A line the newest of them would wait longer than `maxWaitMs` for: packed
     * evenly, from the first turn to that limit, no turn moved later than it
     * was. Nothing done while the line fits, so an ordinary line never notices.
     *
     * What a sign-in held a turn back by is not the line's doing, and is left
     * out of the measure: a load may wait longer than the limit by that much,
     * one interval at most, when a sign-in begins just before its turn.
     * @returns {boolean} whether the line was packed
     */
    function pack() {
        if (!(maxWaitMs > 0) || !line.length) return false
        const now = Date.now()
        const newest = line.at(-1)
        if (newest.at - newest.pushed - now <= maxWaitMs) return false
        if (line.length === 1) {
            // One load in line, and the gap after the load before it alone is longer than the
            // limit. What a sign-in held it back by needs no room here: the measure above has left it out.
            const [only] = line
            only.packed = true
            only.gap = Math.min(only.gap, maxWaitMs)
            arm(only, Math.min(only.at, only.arrived + maxWaitMs))
            return true
        }
        // No jitter on a packed line: it is as long as it is only because the ordinary spacing did not fit.
        const spacing = Math.min(minIntervalMs, Math.max(1, Math.floor((maxWaitMs - Math.max(0, line[0].at - now)) / (line.length - 1))))
        const first = Math.max(now, line[0].at)
        line.forEach((entry, at) => {
            entry.packed = true
            entry.gap = Math.min(entry.gap, spacing)
            arm(entry, Math.min(entry.at, first + at * spacing))
        })
        return true
    }

    /** Resolves when the caller may load a page. Rejects only with `page_closed`, when the worker is stopping. */
    async function wait() {
        if (stopped) throw closed()
        const arrived = Date.now()
        if (off) return
        // `pushed`: how far sign-ins that began while it waited held its turn back by.
        const entry = { arrived, at: arrived, gap: gap(), timer: null, wake: null, packed: false, pushed: 0 }
        line.push(entry)
        try {
            // Behind the line, or one gap after the load that began last, whichever is later.
            const before = line[line.length - 2]
            arm(entry, Math.max(arrived, freeAt, before ? before.at + before.gap : 0))
            pack()
            await new Promise((resolve, reject) => {
                entry.wake = () => (stopped ? reject(closed()) : resolve())
            })
        } finally {
            clearTimeout(entry.timer)
            const at = line.indexOf(entry)
            if (at >= 0) line.splice(at, 1)
        }
        // Stopped in the very moment its turn came: the turn is nobody's now.
        if (stopped) throw closed()
        const now = Date.now()
        // Began later than its turn (a loaded machine): the line moves with it, and stays a gap behind.
        const late = now - entry.at
        if (late > 0) {
            for (const rest of line) arm(rest, rest.at + late)
            pack()
        }
        freeAt = now + entry.gap
        // Said of a load that had a turn to wait for, not of the first after a quiet queue.
        if (entry.at > arrived) log('page-load', `waited (${Math.ceil(now - arrived)} ms${entry.packed ? ', a long line packed' : ''})`)
    }

    /**
     * A load began outside the queue — a sign-in, which the login pacer spaces.
     * What follows keeps a gap away from it: the line in front is moved back as one.
     * That is the queue keeping its distance, not the line being too long: what
     * is moved back is not made up for by packing the rest closer than need be.
     *
     * No load is held back by more than one interval in all, however many
     * sign-ins begin while it waits: sign-ins coming faster than that would
     * otherwise put its turn off for as long as they come. Past that it takes
     * its turn, close to a sign-in or not.
     */
    function note() {
        if (off || stopped) return
        freeAt = Date.now() + gap()
        if (!line.length) return
        const push = Math.max(0, freeAt - line[0].at)
        if (push > 0) {
            // The line moves as one, so that its order and its spacing stay what they were.
            const by = Math.min(push, ...line.map(entry => Math.max(0, 2 * minIntervalMs - entry.pushed)))
            for (const entry of line) {
                arm(entry, entry.at + by)
                entry.pushed += by
            }
        }
        pack()
    }

    /** The worker is stopping: nobody waits for a turn any more, and nobody gets one. */
    function stop() {
        stopped = true
        for (const entry of line.splice(0)) {
            clearTimeout(entry.timer)
            entry.wake?.()
        }
    }

    /** For /health: how many loads wait for their turn, and how far the next turn is. */
    function stats() {
        return { waiting: line.length, nextInMs: line.length ? Math.max(0, line[0].at - Date.now()) : 0 }
    }

    return { wait, note, stop, stats }
}

module.exports = { createPageLoadQueue }
