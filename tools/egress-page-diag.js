'use strict'
/*
 * Open the account's page exactly as the worker does and watch what happens
 * around the first in-page call (Qwen2API-3ue.5). Built for the live rollout
 * of 2026-11-24, when the worker's /egress call hung and the worker log said
 * only "The resident page stopped responding".
 *
 *   node tools/egress-page-diag.js --profile=<userDataDir> --worker=<dir with lib/>
 *        [--origin=https://chat.qwen.ai] [--out=/tmp/egress-page-diag]
 *        [--headless-mode=shell|chrome] [--settle-ms=0] [--transport=xhr|fetch]
 *        [--like-fe=1] [--loopback-only=1]
 *
 * The call goes the way the worker sends it (fetch, content-type only) unless:
 *   --transport=xhr  through XMLHttpRequest, the way the page's own code sends.
 *                    Its request hooks wrap XHR open() and send() (baxiaCommon.js),
 *                    so whatever they add to the page's requests they add to this
 *                    one: bx-v always, bx-ua and bx-umidtoken when they decide to.
 *   --like-fe=1      with the headers the page sends with every API call of its
 *                    own: accept, accept-language, source, version, timezone,
 *                    x-request-id, and authorization from the page's localStorage.
 *   --settle-ms=N    leaves the page alone for N ms first.
 * On 2026-11-24 the worker's way (fetch, content-type only) got a WAF challenge
 * page under status 200 and the page showed a puzzle captcha; the page's way
 * (--transport=xhr --like-fe=1, after 20 s) got {"success":true}. Which single
 * header matters was not isolated; nor whether fetch would do with the same
 * headers, nor whether the wait mattered.
 *
 * Run it inside the worker container, as the worker's user, with the worker's
 * lib/ as --worker (on prod: /app) and the account's profile as --profile,
 * while nothing else uses that profile. What it reports: every request of the
 * page (host and path, status, how long), what was sent with the same-origin
 * API calls and what qwen.ai answered to this run's own calls, console errors,
 * whether the page answers other calls while the first one is pending, the
 * renderer's load, screenshots before and after.
 *
 * What it does on the network: one page load of the chat root and at most two
 * POST /api/v2/chats/new from inside the page (the second only when the first
 * got no HTTP status, nothing showed a verification and the page is still
 * responsive; never earlier than a minute after the first). This script
 * requests nothing else. Tokens and cookies are never printed: URLs are cut to
 * host and path, console text is masked and cut, secret headers by name only.
 *
 * Dry run first, without any network: tools/egress-page-diag-stub.js serves a
 * stub chat site on the loopback interface, and --loopback-only=1 aborts every
 * request to another host:
 *
 *   STUB_MODE=hangfreeze node tools/egress-page-diag-stub.js &
 *   node tools/egress-page-diag.js --worker=signin-worker --profile=/tmp/p \
 *        --origin=http://127.0.0.1:3847 --loopback-only=1
 */
/* global location, document, window, XMLHttpRequest */
const fs = require('fs')
const path = require('path')

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.join('=') || '1']
}))
const WORKER = args.worker && path.resolve(args.worker)
const PROFILE = args.profile
const ORIGIN = args.origin || 'https://chat.qwen.ai'
const OUT = args.out || '/tmp/egress-page-diag'
const HEADLESS_MODE = args['headless-mode'] || 'shell'
// How long to leave the page alone after it is ready, before the first call.
const SETTLE_MS = Number(args['settle-ms'] || 0)
// fetch: the worker's way. xhr: the page's own code's way.
const TRANSPORT = args.transport === 'xhr' ? 'xhr' : 'fetch'
// Send the headers the page's own code sends with its API calls.
const LIKE_FE = args['like-fe'] === '1'
const LOOPBACK_ONLY = args['loopback-only'] === '1'
const MAX_BYTES = 8 * 1024 * 1024
const BACKSTOP_MS = 5000
// The pause the runbook asks for between two live calls.
const MIN_BETWEEN_CALLS_MS = 60000
const LINUX = fs.existsSync('/proc/uptime')

if (!WORKER || !PROFILE) {
    console.error('usage: node tools/egress-page-diag.js --profile=<dir> --worker=<dir with lib/> [--origin=] [--out=]')
    process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms))
])
const cut = (value, max = 200) => {
    let text = String(value)
    text = text.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    text = text.replace(/Bearer\s+\S+/g, 'Bearer <masked>')
    return text.slice(0, max)
}
const hostPath = url => {
    try {
        const u = new URL(url)
        return u.host + (u.pathname || '/').slice(0, 70)
    } catch {
        return cut(url, 70)
    }
}
// Requests that carry data, as opposed to the page's static files.
const apiType = entry => ['xhr', 'fetch', 'document', 'websocket', 'eventsource', 'other', 'manifest'].includes(entry.type)

/**
 * Runs INSIDE the page. The worker's pageFetch (lib/egress-fetch.js) with a
 * console line at every stage, so the timeline shows where a call stands.
 */
async function pageFetchProbe({ url, init, timeoutMs, maxBytes }) {
    const say = (...parts) => console.log('E4DIAG', Date.now(), ...parts)
    const controller = new AbortController()
    const timer = setTimeout(() => {
        say('timer: aborting the fetch')
        controller.abort()
    }, timeoutMs)
    try {
        say('fetch: calling', init.method, new URL(url, location.href).pathname)
        const response = await fetch(url, { ...init, credentials: 'include', signal: controller.signal })
        say('fetch: answered', response.status, response.redirected ? 'redirected' : 'direct', new URL(response.url).pathname)
        const headers = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        const reader = response.body ? response.body.getReader() : null
        const chunks = []
        let size = 0
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > maxBytes) {
                    await reader.cancel().catch(() => {})
                    return { ok: false, error: 'too_large', status: response.status }
                }
                chunks.push(value)
            }
        }
        say('fetch: body read', size, 'bytes')
        return {
            ok: true,
            status: response.status,
            url: response.url,
            redirected: response.redirected,
            headers,
            body: chunks.length ? await new Blob(chunks).text() : ''
        }
    } catch (error) {
        const aborted = error && error.name === 'AbortError'
        say('fetch: error', error && error.name, cutInPage(error && error.message), 'signalAborted=' + controller.signal.aborted)
        return {
            ok: false,
            error: aborted ? (controller.signal.aborted ? 'timeout' : 'aborted') : 'network_error',
            message: String((error && error.message) || error)
        }
    } finally {
        clearTimeout(timer)
        say('fetch: leaving')
    }
    function cutInPage(value) {
        return String(value || '').slice(0, 120)
    }
}

/**
 * Runs INSIDE the page. The same call through XMLHttpRequest, which is how the
 * page's own code sends its API requests — and what its request hooks sign.
 * `fe` asks for the headers the page's own requests carry. Like pageFetchProbe,
 * it says every stage to the console and never throws.
 */
async function pageXhrProbe({ url, init, timeoutMs, maxBytes, fe }) {
    const say = (...parts) => console.log('E4DIAG', Date.now(), ...parts)
    const xhr = new XMLHttpRequest()
    let timer = null
    let timerFired = false
    try {
        const target = new URL(url, location.href)
        // open() first: the page's hook decides here whether to sign this URL.
        say('xhr: opening', init.method, target.pathname)
        xhr.open(init.method, target.href, true)
        const headers = { ...(init.headers || {}) }
        if (fe) {
            headers.accept = 'application/json, text/plain, */*'
            headers['accept-language'] = 'en-US,en;q=0.9'
            headers['x-request-id'] = crypto.randomUUID()
            headers.source = 'web'
            // The front end's own version, from the address its scripts load from.
            const script = [...document.scripts].map(item => item.src).find(src => /qwen-chat-fe\/\d+\.\d+\.\d+\//.test(src))
            headers.version = script ? script.match(/qwen-chat-fe\/(\d+\.\d+\.\d+)\//)[1] : ''
            headers.timezone = new Date().toString()
            headers['content-type'] = headers['content-type'] || 'application/json'
            const token = localStorage.getItem('token')
            if (token) headers.authorization = `Bearer ${token}`
            say('xhr: asking for', Object.keys(headers).sort().join(','))
        }
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
        xhr.responseType = ''
        timer = setTimeout(() => {
            timerFired = true
            say('xhr: timer, aborting')
            xhr.abort()
        }, timeoutMs)
        // abort() before send() does not fire the abort event, so the caller's
        // own backstop remains the last resort for a hook that never sends.
        await new Promise((resolve, reject) => {
            xhr.onload = () => resolve()
            xhr.onerror = () => reject(Object.assign(new Error('network error'), { name: 'Error' }))
            xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            xhr.ontimeout = () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
            // send() is where the page's hook steps in and signs the request.
            say('xhr: sending')
            xhr.send(init.body === undefined ? null : init.body)
        })
        const responseHeaders = {}
        xhr.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).forEach(line => {
            const at = line.indexOf(':')
            responseHeaders[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
        })
        const body = xhr.responseText
        say('xhr: answered', xhr.status, `${body.length} chars`)
        if (body.length > maxBytes) return { ok: false, error: 'too_large', status: xhr.status }
        return {
            ok: true,
            status: xhr.status,
            url: xhr.responseURL,
            redirected: Boolean(xhr.responseURL) && xhr.responseURL !== target.href,
            headers: responseHeaders,
            body
        }
    } catch (error) {
        const aborted = error && error.name === 'AbortError'
        say('xhr: error', error && error.name, cutInPage(error && error.message), `timerFired=${timerFired}`)
        return {
            ok: false,
            error: aborted ? (timerFired ? 'timeout' : 'aborted') : 'network_error',
            message: String((error && error.message) || error)
        }
    } finally {
        clearTimeout(timer)
        say('xhr: leaving')
    }
    function cutInPage(value) {
        return String(value || '').slice(0, 120)
    }
}

const alive = pid => {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error.code === 'EPERM'
    }
}

/** Chromium's own processes in this container: state and CPU ticks per type. */
function chromiumProcesses() {
    const out = []
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        let cmd
        let stat
        try {
            cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
            stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        } catch {
            continue
        }
        const type = (cmd.match(/--type=(\w+)/) || [])[1]
        if (!type) continue
        // A shell whose command line merely quotes "--type=" is not Chromium.
        try {
            if (!/chrom|headless_shell/i.test(fs.readlinkSync(`/proc/${pid}/exe`))) continue
        } catch {
            continue
        }
        try {
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
            // fields[0] is the state; utime is field 14 of the line, stime 15.
            // Context switches of the main thread tell a busy loop from a wait.
            const status = fs.readFileSync(`/proc/${pid}/task/${pid}/status`, 'utf8')
            const switches = name => Number((status.match(new RegExp(`^${name} (\\d+)`, 'm')) || [])[1] || 0)
            out.push({
                pid: Number(pid), type, state: fields[0], ticks: Number(fields[11]) + Number(fields[12]),
                voluntary: switches('voluntary_ctxt_switches'), nonvoluntary: switches('nonvoluntary_ctxt_switches'),
                profile: (cmd.split('\0').find(part => part.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length)
            })
        } catch {
            /* the process left between the reads */
        }
    }
    return out
}

async function main() {
    const signer = require(path.join(WORKER, 'lib/browser-signin'))
    const egress = require(path.join(WORKER, 'lib/egress-fetch'))
    fs.mkdirSync(OUT, { recursive: true })

    const events = []
    const consoleAll = []
    const requests = new Map()
    const cpu = []
    let T0 = Date.now()
    const ms = () => Date.now() - T0
    const log = (kind, text) => events.push({ t: ms(), kind, text })
    const originHost = new URL(ORIGIN).hostname
    const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key)$/i
    const OPAQUE_HEADERS = /^(bx-|x-bx-|umid|e-|acw_|ssxmod)/i

    /** Header names and harmless values of one exchange, for the summary. */
    async function describeExchange(response, entry) {
        try {
            const sent = await response.request().allHeaders()
            entry.sent = Object.keys(sent).sort().map(name => {
                if (SECRET_HEADERS.test(name)) return name
                if (OPAQUE_HEADERS.test(name)) return `${name}(${String(sent[name]).length})`
                return `${name}=${cut(sent[name], 60)}`
            })
            const got = response.headers()
            entry.got = Object.keys(got).sort().map(name => (OPAQUE_HEADERS.test(name) ? `${name}(${String(got[name]).length})` : name))
            entry.contentType = got['content-type'] || ''
            // The answer to this run's own call: what qwen.ai said to it.
            if (entry.path.endsWith('/chats/new') && entry.method === 'POST' && ['fetch', 'xhr'].includes(entry.type)) {
                entry.answer = cut((await response.text()).replace(/\s+/g, ' '), 420)
            }
        } catch {
            /* the answer was not kept; the status above is all there is */
        }
    }

    const context = await signer.openContext({
        dataDir: PROFILE, proxy: null, headless: true, timeoutMs: 30000, headlessMode: HEADLESS_MODE
    })
    // The browser process of this launch, for the clean-up at the end.
    const browserProcess = (context._browser || context.browser())?.process?.()
    const browserPid = browserProcess ? browserProcess.pid : null
    const tOpen = ms()
    // Nothing in this run may take longer than this. A step that hangs would
    // keep the profile from the worker, so the browser goes first.
    setTimeout(() => {
        log('life', 'WATCHDOG: the run took too long and is stopped')
        try {
            if (browserPid && alive(browserPid)) process.kill(LINUX ? -browserPid : browserPid, 'SIGKILL')
        } catch {
            /* already gone */
        }
        console.error('E4 diagnostic stopped by its own watchdog')
        process.exit(3)
    }, 420000).unref()
    const page = context.pages()[0]
    log('life', `browser open in ${tOpen} ms`)

    if (LOOPBACK_ONLY) {
        await context.route('**/*', route => {
            const host = new URL(route.request().url()).hostname
            if (host === '127.0.0.1' || host === 'localhost') return route.continue()
            log('guard', `aborted a request to ${host}`)
            return route.abort()
        })
    }

    page.on('request', request => {
        const u = new URL(request.url())
        requests.set(request, {
            t: ms(), host: u.hostname, path: (u.pathname || '/').slice(0, 70),
            method: request.method(), type: request.resourceType(), status: null, tAnswer: null, tEnd: null, failed: null
        })
    })
    page.on('response', response => {
        const entry = requests.get(response.request())
        if (!entry) return
        entry.status = response.status()
        entry.tAnswer = ms()
        if (response.fromServiceWorker()) entry.viaServiceWorker = true
        if (apiType(entry) && entry.host === originHost) describeExchange(response, entry)
    })
    // What the SDKs of the page loaded: a verification shown for a call.
    page.on('request', request => {
        const url = request.url()
        if (/AliyunCaptcha|captcha-open|static-captcha/i.test(url)) log('verification', `the page loads ${hostPath(url)}`)
    })
    page.on('requestfinished', request => {
        const entry = requests.get(request)
        if (entry) entry.tEnd = ms()
    })
    page.on('requestfailed', request => {
        const entry = requests.get(request)
        if (!entry) return
        entry.failed = cut((request.failure() && request.failure().errorText) || 'failed', 60)
        entry.tEnd = ms()
    })
    page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) log('navigation', hostPath(frame.url()))
    })
    page.on('console', message => {
        const text = message.text()
        consoleAll.push({ t: ms(), type: message.type(), text: cut(text, 220) })
        if (text.startsWith('E4DIAG')) log('page', cut(text, 200))
    })
    page.on('pageerror', error => log('pageerror', cut(error.message, 200)))
    page.on('dialog', async dialog => {
        log('dialog', `${dialog.type()}: ${cut(dialog.message(), 120)}`)
        await dialog.dismiss().catch(() => {})
    })
    page.on('crash', () => log('life', 'PAGE CRASHED'))
    page.on('close', () => log('life', 'PAGE CLOSED'))
    page.on('websocket', socket => log('websocket', hostPath(socket.url())))
    context.on('page', extra => log('life', `a second page opened: ${hostPath(extra.url())}`))
    context.on('close', () => log('life', 'CONTEXT CLOSED'))

    const cpuTimer = LINUX
        ? setInterval(() => {
            cpu.push({ t: ms(), procs: chromiumProcesses() })
        }, 3000)
        : null
    if (cpuTimer) cpuTimer.unref()

    // The same channel the worker exposes before the first navigation.
    await page.exposeFunction(egress.STREAM_CHANNEL, () => {})

    const tRenewStart = ms()
    let harvested
    try {
        harvested = await signer.renew(context, { chatOrigin: ORIGIN, timeoutMs: 120000 })
    } catch (error) {
        log('life', `renew failed after ${ms() - tRenewStart} ms: ${error.code || ''} ${cut(error.message, 160)}`)
    }
    const tReady = ms()
    log('life', `page ready ${harvested ? 'with a token' : 'WITHOUT a token'} at ${tReady} ms (renew took ${tReady - tRenewStart} ms)`)

    const request = egress.normalizeEgress({
        url: '/api/v2/chats/new',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chatId: '', models: ['qwen3.7-plus'], project_id: '', timestamp: Date.now(),
            chat_type: 't2t', chat_mode: 'normal'
        }),
        timeoutMs: 30000
    }, { chatOrigin: ORIGIN, defaultTimeoutMs: 120000, maxTimeoutMs: 600000 })

    async function ping() {
        const started = Date.now()
        try {
            await withTimeout(page.evaluate(() => Date.now()), 5000, 'ping')
            return Date.now() - started
        } catch {
            return -1
        }
    }

    /** The worker's call step for step, with a ping every 2 s while it runs. */
    async function attempt(label) {
        const started = Date.now()
        log(label, `in-page call starts (${TRANSPORT}${LIKE_FE ? ', with the headers of the page' : ''})`)
        const call = TRANSPORT === 'xhr' ? pageXhrProbe : pageFetchProbe
        const running = page.evaluate(call, { ...request, maxBytes: MAX_BYTES, fe: LIKE_FE })
            .then(outcome => ({ outcome }), error => ({ error }))
        const backstop = new Promise(resolve => {
            const id = setTimeout(() => resolve({ backstop: true }), request.timeoutMs + BACKSTOP_MS)
            id.unref?.()
        })
        const pings = []
        let settled = false
        let lastPing = 0
        const watcher = (async () => {
            while (!settled) {
                if (Date.now() - lastPing >= 2000) {
                    lastPing = Date.now()
                    pings.push(await ping())
                }
                await sleep(100)
            }
        })()
        const first = await Promise.race([running, backstop])
        settled = true
        await watcher
        const result = { label, at: started - T0, ms: Date.now() - started, pings }
        // "Answered" means qwen.ai's status came back; a call the page itself
        // cut, or one the page never reported on, is not an answer.
        result.answered = Boolean(first.outcome && typeof first.outcome.status === 'number')
        if (first.backstop) {
            // What the worker saw: no answer at all, not even from the page's own timer.
            result.outcome = 'no answer from the page (the worker closes it here)'
            running.then(late => {
                log(label + '-late', late.outcome ? `the page answered ${Date.now() - started} ms after the call: ${describe(late.outcome)}` : `the call failed ${Date.now() - started} ms after it started: ${cut(late.error && late.error.message, 160)}`)
            })
        } else if (first.error) {
            result.outcome = `evaluate failed: ${cut(first.error.message, 160)}`
        } else {
            result.outcome = describe(first.outcome)
        }
        log(label, `ends after ${result.ms} ms: ${result.outcome}`)
        return result
    }

    function describe(outcome) {
        if (!outcome.ok) return `not ok: ${outcome.error} ${cut(outcome.message, 120)}`
        let shape
        try {
            const parsed = JSON.parse(outcome.body)
            shape = parsed && typeof parsed === 'object'
                ? `json keys: ${Object.keys(parsed).slice(0, 8).join(',')}${'success' in parsed ? ` (success: ${parsed.success})` : ''}`
                : 'json'
        } catch {
            const text = outcome.body.replace(/\s+/g, ' ')
            // What qwen.ai's WAF answers instead of JSON — on 2026-11-24 under status 200.
            const challenge = /aliyun_waf|acw_sc__v2|_____tmd_____|punish/i.test(text)
            shape = text ? `NOT JSON${challenge ? ' — A WAF CHALLENGE PAGE' : ''}, starts: ${cut(text, 80)}` : 'empty body'
        }
        return `ok: HTTP ${outcome.status} ${outcome.redirected ? '(redirected to ' + hostPath(outcome.url) + ')' : ''}, ${shape}`
    }

    async function facts() {
        try {
            return await withTimeout(page.evaluate(async () => ({
                path: location.pathname,
                host: location.host,
                visibility: document.visibilityState,
                readyState: document.readyState,
                userAgent: navigator.userAgent,
                hasToken: Boolean(localStorage.getItem('token')),
                fetchSource: String(fetch).replace(/\s+/g, ' ').slice(0, 900),
                xhrOpenSource: String(XMLHttpRequest.prototype.open).replace(/\s+/g, ' ').slice(0, 60),
                frames: window.frames.length,
                title: document.title.slice(0, 60),
                serviceWorkers: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 'unsupported'
            })), 8000, 'facts')
        } catch (error) {
            return { error: cut(error.message, 120) }
        }
    }
    async function shot(name) {
        try {
            await withTimeout(page.screenshot({ path: path.join(OUT, name) }), 8000, 'screenshot')
            return name
        } catch (error) {
            return `no screenshot (${cut(error.message, 60)})`
        }
    }

    const out = { origin: ORIGIN, headlessMode: HEADLESS_MODE, transport: TRANSPORT, likeFe: LIKE_FE, settleMs: SETTLE_MS, tOpen, tReady }
    out.screenshotReady = await shot('ready.png')
    out.factsReady = await facts()
    log('facts', JSON.stringify(out.factsReady))
    // The frames on the page: the main one, and every embedded site with it.
    const framesNow = () => page.frames().map(frame => frame === page.mainFrame() ? 'main' : hostPath(frame.url())).join('  ')
    out.framesReady = framesNow()
    log('life', `frames: ${out.framesReady}`)

    if (SETTLE_MS > 0 && harvested) {
        await sleep(SETTLE_MS)
        log('life', `the page was left alone for ${SETTLE_MS} ms`)
    }

    if (!harvested) {
        log('life', 'no page to probe: stopping without any call')
    } else {
        const first = await attempt('call-1')
        out.call1 = first
        if (!first.answered) {
            // The page is left alone for a while: does it come back by itself?
            const until = Date.now() + 45000
            const idle = []
            while (Date.now() < until) {
                idle.push(await ping())
                await sleep(5000)
            }
            out.idlePings = idle
            const wait = MIN_BETWEEN_CALLS_MS - (Date.now() - T0 - first.at)
            if (wait > 0) await sleep(wait)
            const last = idle[idle.length - 1]
            // A second call into a page that is showing a verification would
            // only be held by the same one.
            const verification = events.findIndex(event => event.kind === 'verification' && event.t >= first.at)
            if (verification !== -1) {
                out.verificationAt = events[verification].t
                log('call-2', 'skipped: the page is showing a verification (a puzzle captcha) for the first call')
            } else if (last >= 0) {
                out.call2 = await attempt('call-2')
            } else {
                log('call-2', 'skipped: the page still answers nothing')
            }
        } else {
            await sleep(15000)
        }
    }

    out.screenshotEnd = await shot('end.png')
    out.factsEnd = await facts()
    out.framesEnd = framesNow()
    log('life', `frames at the end: ${out.framesEnd}`)
    const list = [...requests.values()]
    out.pendingAtEnd = list.filter(entry => entry.tEnd === null).map(entry => `${entry.method} ${entry.host}${entry.path} (since ${entry.t} ms)`)
    if (cpuTimer) clearInterval(cpuTimer)

    try {
        await withTimeout(context.close(), 20000, 'close')
    } catch (error) {
        log('life', `context.close: ${cut(error.message, 120)}`)
    }
    // A page that does not answer can keep its browser from closing. Nothing
    // of this launch may outlive the run: Chromium holds the profile lock,
    // and the worker could not open the account again. Only this launch's
    // processes, by pid: Playwright starts the browser on its own, as the
    // leader of a process group, so the group is exactly this browser's tree.
    if (browserPid && alive(browserPid)) {
        await sleep(3000)
        if (alive(browserPid)) {
            try {
                // A negative pid is the process group; it exists only off Windows.
                process.kill(LINUX ? -browserPid : browserPid, 'SIGKILL')
                log('life', `browser pid ${browserPid} was still alive: ${LINUX ? 'its process group' : 'it'} killed`)
            } catch (error) {
                log('life', `browser pid ${browserPid}: ${cut(error.message, 80)}`)
            }
        }
    }
    if (LINUX) {
        // Last resort, and only for helpers that name this very profile.
        for (const proc of chromiumProcesses().filter(entry => entry.profile === PROFILE)) {
            try {
                process.kill(proc.pid, 'SIGKILL')
                log('life', `helper ${proc.type} pid ${proc.pid} of this profile killed`)
            } catch {
                /* gone meanwhile */
            }
        }
        const rest = chromiumProcesses()
        if (rest.length) log('life', `chromium processes still running in this container: ${rest.map(entry => `${entry.type} pid ${entry.pid} profile ${entry.profile ? 'ours' : 'other'}`).join(', ')}`)
    }

    // The run ends when the browser is gone, not when Node is: the launcher
    // still has to see its process out.
    if (browserProcess && browserProcess.exitCode === null) {
        await withTimeout(new Promise(resolve => browserProcess.once('exit', resolve)), 15000, 'browser exit').catch(() => {
            log('life', `browser pid ${browserPid} did not exit`)
        })
    }

    // ---- summary ------------------------------------------------------------------------------
    console.log(`=== resident page diagnostic: ${ORIGIN}, headless mode ${HEADLESS_MODE}, profile ${path.basename(PROFILE)}`)
    console.log(`call sent via ${TRANSPORT}${LIKE_FE ? ' with the headers of the page' : ' with the headers the worker sends'}${SETTLE_MS ? `, after ${SETTLE_MS} ms of waiting` : ''}`)
    console.log(`browser open ${tOpen} ms, page ready ${tReady} ms, finished ${ms()} ms`)
    console.log('--- timeline (ms since launch)')
    for (const event of events) console.log(`${String(event.t).padStart(7)}  ${event.kind.padEnd(13)} ${event.text}`)
    console.log('--- requests by host')
    const byHost = {}
    for (const entry of list) {
        const key = `${entry.type} ${entry.host}`
        byHost[key] = (byHost[key] || 0) + 1
    }
    Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([key, n]) => console.log(`${String(n).padStart(5)}  ${key}`))
    console.log('--- same-origin API requests: start ms | +duration | type METHOD path | status | state')
    for (const entry of list.filter(e => apiType(e) && e.host === originHost).slice(0, 70)) {
        const duration = entry.tEnd !== null ? entry.tEnd - entry.t : null
        const state = entry.failed ? `FAILED ${entry.failed}` : entry.status === null ? (entry.tEnd === null ? 'PENDING' : 'no status') : entry.viaServiceWorker ? 'done via service worker' : 'done'
        console.log(`${String(entry.t).padStart(7)}  ${String(duration === null ? '-' : '+' + duration).padStart(8)}  ${entry.type.padEnd(8)} ${entry.method.padEnd(4)} ${entry.path.slice(0, 60)}  ${entry.status === null ? '-' : entry.status}  ${state}`)
    }
    console.log("--- what was sent with them (header names; opaque values by length) and what qwen.ai answered to this run's calls")
    const shown = new Set()
    for (const entry of list.filter(e => apiType(e) && e.host === originHost && e.sent && e.type !== 'document')) {
        const key = `${entry.type} ${entry.method} ${entry.sent.join(',')}`
        if (shown.has(key)) continue
        shown.add(key)
        const type = entry.contentType.split(';')[0] || 'no content-type'
        console.log(`${String(entry.t).padStart(7)} ${entry.type} ${entry.method} ${entry.path.slice(0, 44)}  [${type}]  sent: ${entry.sent.join(' ')}`)
        if (entry.answer !== undefined) console.log(`    answered: ${entry.answer}`)
    }
    const foreignFailed = list.filter(e => e.failed && e.host !== originHost)
    console.log(`--- requests of other hosts that failed or never ended: ${foreignFailed.length}`)
    for (const entry of foreignFailed.slice(0, 12)) console.log(`${String(entry.t).padStart(7)}  ${entry.type} ${entry.method} ${entry.host}${entry.path.slice(0, 40)}  ${entry.failed || 'pending'}`)
    console.log('--- console: counts by type, then errors, warnings and the probe lines')
    const byType = {}
    consoleAll.forEach(entry => { byType[entry.type] = (byType[entry.type] || 0) + 1 })
    console.log(JSON.stringify(byType))
    consoleAll.filter(entry => ['error', 'warning'].includes(entry.type)).slice(0, 25)
        .forEach(entry => console.log(`${String(entry.t).padStart(7)}  ${entry.type}: ${entry.text}`))
    if (LINUX) {
        // Every renderer process, per sampling interval: R (running) or S
        // (sleeping), how much of one core it used (100 = a full core; a clock
        // tick is 10 ms), and how many times its main thread gave the CPU up
        // voluntarily. A busy loop is busy and never switches; a thread waiting
        // is idle and switching. Runs of the same kind are folded. A page with
        // third-party iframes has several renderers; the main frame is one of them.
        const samples = cpu.map(sample => ({
            t: sample.t,
            procs: sample.procs.filter(proc => proc.type === 'renderer').sort((a, b) => a.pid - b.pid)
        }))
        const runs = []
        for (let i = 1; i < samples.length; i++) {
            const a = samples[i - 1]
            const b = samples[i]
            const seconds = (b.t - a.t) / 1000
            if (seconds <= 0 || b.procs.length !== a.procs.length) continue
            const perProcess = b.procs.map((proc, index) => {
                const was = a.procs[index]
                const core = Math.round(Math.max(0, proc.ticks - was.ticks) / seconds)
                const switches = Math.round(Math.max(0, proc.voluntary - was.voluntary) / seconds)
                return { pid: proc.pid, core, switches, kind: `${proc.state} ${core >= 25 ? 'busy' : 'idle'} ${switches >= 20 ? 'switching' : 'no-switches'}` }
            })
            const signature = perProcess.map(item => item.kind).join(', ')
            const last = runs[runs.length - 1]
            if (last && last.signature === signature) {
                last.to = b.t
                perProcess.forEach((item, index) => {
                    last.core[index].push(item.core)
                    last.switches[index].push(item.switches)
                })
            } else {
                runs.push({
                    from: b.t, to: b.t, signature,
                    pids: perProcess.map(item => item.pid),
                    core: perProcess.map(item => [item.core]),
                    switches: perProcess.map(item => [item.switches])
                })
            }
        }
        const mean = list => Math.round(list.reduce((sum, value) => sum + value, 0) / list.length)
        console.log('--- renderers by interval: from-to ms | renderer pid: state, % of one core, voluntary switches per second')
        runs.forEach(run => {
            const parts = run.pids.map((pid, index) => `${pid}: ${run.signature.split(', ')[index]} (core ${mean(run.core[index])}%, switches ${mean(run.switches[index])}/s)`)
            console.log(`${String(run.from).padStart(7)}-${String(run.to).padEnd(7)} | ${parts.join(' | ')}`)
        })
        const types = [...new Set(cpu.flatMap(sample => sample.procs.map(proc => proc.type)))]
        console.log(`chromium helper types seen: ${types.join(', ') || 'none'}`)
    }
    console.log('--- calls')
    for (const call of [out.call1, out.call2]) {
        if (!call) continue
        console.log(`${call.label}: at ${call.at} ms, ended after ${call.ms} ms -> ${call.outcome}`)
        console.log(`  pings while it ran (ms, -1 = no answer in 5 s): ${call.pings.join(' ')}`)
    }
    if (out.idlePings) console.log(`pings while left alone: ${out.idlePings.join(' ')}`)
    console.log('--- page facts')
    console.log('ready:', JSON.stringify(out.factsReady))
    console.log('end:  ', JSON.stringify(out.factsEnd))
    console.log('--- still open at the end')
    for (const line of out.pendingAtEnd.slice(0, 12)) console.log(line)
    console.log(`screenshots: ${out.screenshotReady}, ${out.screenshotEnd} in ${OUT}`)
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ ...out, events, requests: list, console: consoleAll }, null, 1))
}

main().then(() => process.exit(0), error => {
    console.error('diagnostic failed:', error && error.stack ? cut(error.stack, 600) : error)
    process.exit(1)
})
