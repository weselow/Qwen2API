'use strict'

/**
 * A "browser" for the worker's HTTP tests when the subject is not the call
 * inside the page (that one is tests/signin-worker-egress.test.js's, with its
 * own fake): contexts and pages that answer what a resident page is asked
 * while it opens, run a whole-answer call as a plain success, and record what
 * the worker does to them. No Chromium anywhere near CI.
 *
 * `script` stages what the tests need to hold or stretch:
 *   ttlSeconds  - how long a harvested token lives (default an hour)
 *   renew       - () => Promise<harvest>, in place of the plain harvest
 *   call        - () => Promise, awaited before a whole-answer call answers
 *   beforeClose - () => Promise, awaited before a context is closed
 */
const fs = require('node:fs')
const { readFrontEndVersion } = require('../../signin-worker/lib/egress-fetch')

// Whether a profile directory is there — what the 'closed' record says of it.
const there = dir => {
    try { return fs.statSync(dir).isDirectory() } catch { return false }
}

function fakeResidentBrowser(script = {}) {
    const calls = []
    const contexts = []
    let generation = 0
    const harvest = source => ({
        token: `token-${source}-${++generation}`,
        exp: Math.floor(Date.now() / 1000) + (script.ttlSeconds ?? 3600),
        cookies: [{ name: 'cna', value: source, domain: 'chat.qwen.ai', path: '/' }]
    })
    const emitter = () => {
        const handlers = {}
        return {
            on(event, handler) { (handlers[event] ||= []).push(handler) },
            off(event, handler) { handlers[event] = (handlers[event] || []).filter(kept => kept !== handler) },
            emit(event, ...args) { for (const handler of [...handlers[event] || []]) handler(...args) }
        }
    }
    const signer = {
        calls, contexts,
        async openContext(options) {
            calls.push({ op: 'open', dataDir: options.dataDir })
            const page = {
                ...emitter(),
                exposeFunction: async () => {},
                async evaluate(fn, arg) {
                    if (fn === readFrontEndVersion) return '0.3.50'
                    if (arg?.url) {
                        if (script.call) await script.call()
                        return {
                            ok: true, status: 200, url: arg.url, redirected: false,
                            headers: { 'content-type': 'application/json' }, body: '{"success":true}'
                        }
                    }
                    return 'page-token'
                }
            }
            const context = {
                ...emitter(), page, dataDir: options.dataDir, closed: false,
                pages: () => [page],
                cookies: async () => [],
                async close() {
                    // 'closing' = the close began (the page is gone); 'closed' = the
                    // browser process is. Chromium keeps the profile locked in between.
                    calls.push({ op: 'closing', dataDir: context.dataDir })
                    page.emit('close')
                    context.emit('close')
                    if (script.beforeClose) await script.beforeClose()
                    context.closed = true
                    calls.push({ op: 'closed', dataDir: context.dataDir, profileThere: there(context.dataDir) })
                }
            }
            contexts.push(context)
            return context
        },
        async signin() { return harvest('signin') },
        async renew(context) {
            calls.push({ op: 'renew', dataDir: context.dataDir })
            return script.renew ? script.renew() : harvest('renew')
        }
    }
    return signer
}

module.exports = { fakeResidentBrowser }
