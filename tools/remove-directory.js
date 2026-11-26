'use strict'

/*
 * Take a temporary directory away without failing the run over it
 * (Qwen2API-3ue.13).
 *
 * The smokes start the application with its working directory inside a
 * temporary one (tools/bun-smoke.js#startApplication) and take that directory
 * away in a `finally`. On Windows it can still be held when everything the run
 * checks is over. 2026-11-25, CI on main (3d7d99f, job "Binary and container
 * (windows-x64)"): all nineteen steps of the smoke had passed, and the
 * `finally` failed with
 *
 *   EBUSY: resource busy or locked, rm '...\Temp\qwen-bun-smoke-browser-4qt0UV'
 *
 * The rerun of the same commit was green.
 *
 * fs.rm takes maxRetries and retryDelay for exactly this, but Bun ignores both
 * (measured 2026-11-26 on Windows, Bun 1.3.11 and 1.3.14: with maxRetries: 10
 * and retryDelay: 100 the call failed after 2 ms while the directory was held
 * for another 600 ms; Node 25 does retry). The smokes run on Bun, so the
 * retries are made here.
 *
 * What held it on the runner is not established. The message names the
 * directory itself, not a file in it: under Bun the entries go first and the
 * last step, the directory, is what fails. Measured 2026-11-26 on Windows 11
 * with a process started in such a directory: in most runs Windows keeps the
 * directory while the process lives (EBUSY on every try, the entries in it go
 * freely), taking it a few milliseconds after the start rather than at it; in
 * the other runs it is never taken; and it is free again by the time the parent
 * has the process's `close` (350 of 350) — so "the application's working
 * directory, not let go yet" did not reproduce there, and what holds it on the
 * runner is still to be found. The retries cover each case alike.
 *
 * A removal that does not succeed is not a failed check: the caller is told
 * what became of the directory, the smoke says so and goes on.
 */

const { readdir, rm } = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')

// What Windows answers while something still holds the directory or a file in it —
// the three codes fs.rm retries on Node as well.
const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

const ATTEMPTS = 10
const PAUSE_MS = 100

/**
 * Remove `directory` like `rm(directory, { recursive: true, force: true })`, asking
 * again while it is busy: up to `attempts` tries, the pause before the nth one being
 * n × `pauseMs` (10 and 100 by default: under five seconds in all).
 *
 * `remove` and `sleep` are what the run uses; the tests hand in their own.
 *
 * @returns {Promise<{removed: boolean, attempts: number, error?: Error & {code?: string}}>}
 *   `removed` is false with the last error when the directory is still there.
 */
async function removeDirectory(directory, { attempts = ATTEMPTS, pauseMs = PAUSE_MS, remove = rm, sleep = delay } = {}) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await remove(directory, { recursive: true, force: true })
            return { removed: true, attempts: attempt }
        } catch (error) {
            if (!BUSY.has(error.code) || attempt >= attempts) return { removed: false, attempts: attempt, error }
            await sleep(pauseMs * attempt)
        }
    }
}

/**
 * For the `finally` of a smoke: the directory goes, or the run hears that it
 * stayed — and is not failed by it. What is left in the directory is named, for
 * whoever reads the log of a run that kept it.
 */
async function discardTemporaryDirectory(directory, options) {
    const outcome = await removeDirectory(directory, options)
    if (!outcome.removed) {
        const left = await readdir(directory).then(names => names.join(', ') || 'nothing', () => 'not readable')
        console.warn(`The temporary directory is left in place — still there after ${outcome.attempts} attempts ` +
            `(${outcome.error.code || outcome.error.message}); in it now: ${left}: ${directory}`)
    }
    return outcome
}

module.exports = { removeDirectory, discardTemporaryDirectory }
