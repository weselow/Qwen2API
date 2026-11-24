'use strict'
/*
 * Open the account's page exactly as the worker does and watch what happens
 * around the first in-page call (Qwen2API-3ue.5). Built for the live rollout
 * of 2026-11-24, when the worker's /egress call hung and the worker log said
 * only "The resident page stopped responding".
 *
 *   node tools/egress-page-diag.js --profile=<userDataDir> --worker=<dir with lib/>
 *        [--origin=https://chat.qwen.ai] [--out=/tmp/egress-page-diag]
 *        [--headless-mode=shell|chrome] [--settle-ms=0] [--transport=worker|xhr|fetch]
 *        [--like-fe=1] [--completions=1] [--ui-send=1] [--signed=1]
 *        [--bearer-compare=1] [--loopback-only=1] [--fast=1]
 *
 * How the call is sent:
 *   --transport=worker  exactly what the worker sends (Qwen2API-3ue.5): its
 *                    own in-page call (lib/egress-fetch.js, pageCall) — an
 *                    XMLHttpRequest with the page's headers, read off the page.
 *                    The default to open a question about the worker's call.
 *   --transport=xhr   through XMLHttpRequest as the page's own code sends it,
 *                    by this script's own probe. Its request hooks wrap XHR
 *                    open() and send() (baxiaCommon.js), so whatever they add
 *                    to the page's requests they add to this one.
 *   --transport=fetch how the worker sent it until Qwen2API-3ue.5: fetch,
 *                    content-type only — kept to show what that got.
 *   --like-fe=1      with the headers the page sends with every API call of its
 *                    own: accept, accept-language, source, version, timezone,
 *                    x-request-id, and authorization from the page's localStorage.
 *   --settle-ms=N    leaves the page alone for N ms first.
 *   --ui-send=1     the page sends a message with its own interface — typed
 *                    into its input, sent with its button — instead of this
 *                    run's own chats/new calls. What its own chats/new and
 *                    completions carried, and what qwen.ai answered, is
 *                    reported (2026-11-25: completions sent from the page was
 *                    refused while chats/new passed; was the page's own call
 *                    refused too?).
 *   --signed=1      after the page's own completions passed (needs
 *                    --ui-send=1): one chats/new, then one completions call by
 *                    the worker's own code, carrying the bx-ua / bx-umidtoken
 *                    the page put on its own completions request. Their
 *                    values are read here and never printed.
 *   --bearer-compare=1
 *                    two chats/new by the worker's own code on the warm page,
 *                    the runbook's pause apart: with the token the renewal
 *                    harvested, then with the page's current one
 *                    (Qwen2API-jr9).
 *   --fast=1        the pause between calls cut to 2 s — for --loopback-only=1
 *                    rehearsals only; a live run refuses it.
 * On 2026-11-24 the worker's old way (fetch, content-type only) got a WAF
 * challenge page under status 200 and the page showed a puzzle captcha; the
 * page's way (XMLHttpRequest with its headers, after 20 s) got
 * {"success":true}. Which single header mattered was not isolated; nor
 * whether the wait mattered.
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
 * responsive — or when qwen.ai answered the first but refused its session;
 * never earlier than a minute after the first; with --completions=1, one POST
 * /api/v2/chat/completions from inside the page, right after a chats/new
 * passed). With --ui-send=1 the page's own message is one chats/new and one
 * completions of the page's own, and --bearer-compare=1 / --signed=1 add at
 * most three chats/new and one completions of this run's, one call at a time,
 * the runbook's pause apart. This script requests nothing else. Tokens and
 * cookies are never
 * printed: URLs are cut to host and path,
 * console text is masked and cut, secret headers by name only, the page's
 * token by a fingerprint (length, hash, expiry).
 *
 * Dry run first, without any network: tools/egress-page-diag-stub.js serves a
 * stub chat site on the loopback interface, and --loopback-only=1 aborts every
 * request to another host:
 *
 *   STUB_MODE=hangfreeze node tools/egress-page-diag-stub.js &
 *   node tools/egress-page-diag.js --worker=signin-worker --profile=/tmp/p \
 *        --origin=http://127.0.0.1:3847 --loopback-only=1
 */
/* global location, document, window, XMLHttpRequest, getComputedStyle */
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
// worker: the worker's own in-page call (its default). xhr: the page's own
// code's way, by this script's probe. fetch: how the worker sent it until 3ue.5.
const TRANSPORT = ['worker', 'xhr'].includes(args.transport) ? args.transport : args.transport === 'fetch' ? 'fetch' : 'worker'
// Send the headers the page's own code sends with its API calls.
const LIKE_FE = args['like-fe'] === '1'
// After a chats/new passed: one completions stream from the page too, by the
// worker's own streaming code. Completions is guarded more strictly than
// chats/new (24.11: punished from the page while chats/new passed).
const COMPLETIONS = args.completions === '1'
// The page sends a message with its own interface, and what it sent and what
// qwen.ai answered is reported instead of this run's own chats/new calls.
const UI_SEND = args['ui-send'] === '1'
// After the page's own completions passed: one chats/new, then one completions
// call by the worker's own code, carrying the bx-ua / bx-umidtoken the page put
// on its own completions request.
const SIGNED = args.signed === '1'
// Two chats/new by the worker's own code on the warm page, the runbook's pause
// apart: with the token the renewal harvested, then with the page's current one.
const BEARER_COMPARE = args['bearer-compare'] === '1'
const LOOPBACK_ONLY = args['loopback-only'] === '1'
const MAX_BYTES = 8 * 1024 * 1024
const BACKSTOP_MS = 5000
// The pause the runbook asks for between two live calls.
const MIN_BETWEEN_CALLS_MS = 60000
const LINUX = fs.existsSync('/proc/uptime')
// What each way of sending the call is called in the report.
const TRANSPORT_LABEL = {
    worker: 'the worker\'s own call: XMLHttpRequest with the page\'s headers',
    xhr: 'xhr',
    fetch: 'fetch, as the worker sent it until Qwen2API-3ue.5'
}

// The pause between two calls: the runbook's minute, or next to none in a rehearsal.
const PAUSE_MS = args.fast === '1' ? 2000 : MIN_BETWEEN_CALLS_MS
const UI_TEXT = 'Say pong'
if (!WORKER || !PROFILE) {
    console.error('usage: node tools/egress-page-diag.js --profile=<dir> --worker=<dir with lib/> [--origin=] [--out=]')
    process.exit(2)
}
if (args.fast === '1' && !LOOPBACK_ONLY) {
    console.error('--fast=1 is for --loopback-only=1 rehearsals only: a live run keeps the pause between calls')
    process.exit(2)
}
if (SIGNED && !UI_SEND) {
    console.error('--signed=1 needs --ui-send=1: the signature is taken from the page\'s own completions request')
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
 * Runs INSIDE the page. How the worker sent its call until Qwen2API-3ue.5
 * (lib/egress-fetch.js, fetch with the caller's headers only), with a console
 * line at every stage, so the timeline shows where a call stands.
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

/**
 * Runs INSIDE the page: a fingerprint of the page's session token — its
 * length, a hash and the token's own expiry — never the token. The token
 * rotates as the page boots; when it does is part of whether the page is
 * ready for a call.
 */
function pageTokenFingerprint() {
    const token = localStorage.getItem('token')
    if (!token) return null
    let hash = 0x811c9dc5
    for (let at = 0; at < token.length; at++) {
        hash ^= token.charCodeAt(at)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    let exp = null
    try {
        exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp
    } catch { /* not a JWT as the page writes it: no expiry to read */ }
    return `${token.length}:${hash.toString(16)}:${exp}`
}

/**
 * The same fingerprint of a token this process holds (the one a renewal
 * harvested): length, a hash, its own expiry — never the token.
 */
const tokenFingerprint = token => {
    if (!token) return 'none'
    let hash = 0x811c9dc5
    for (let at = 0; at < token.length; at++) {
        hash ^= token.charCodeAt(at)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    let exp = null
    try {
        exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp
    } catch { /* not a JWT: no expiry to read */ }
    return `${token.length}:${hash.toString(16)}:${exp}`
}

/**
 * Runs INSIDE the page: what there is to type a message in and to send it
 * with — the shown inputs and buttons. With `mark`, the input and the send
 * button are marked where a real click can find them: by the id the front end
 * gives them (2026-11-25: `chat-input`, `send-message-button`), else by their
 * names (aria-label, title, data-testid: send / submit), else the first shown
 * input and no button.
 */
function pageControls({ mark = false } = {}) {
    // An input is wide; a send button is often a small icon.
    const shown = (element, width = 40) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return box.width > width && box.height > width / 3 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const text = value => String(value || '').replace(/\s+/g, ' ').slice(0, 40)
    const name = element => [element.id, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid')].filter(Boolean).join(' ')
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(element => shown(element, 14))
    const input = inputs.find(element => element.id === 'chat-input' && shown(element)) || inputs.find(element => shown(element)) || null
    const button = buttons.find(element => element.id === 'send-message-button') ||
        buttons.find(element => /send|submit|发送/i.test(name(element))) || null
    if (mark) {
        if (input) input.setAttribute('data-e4diag-input', '1')
        if (button) button.setAttribute('data-e4diag-send', '1')
    }
    return {
        inputs: inputs.map(element => ({
            tag: element.tagName.toLowerCase(), id: element.id || '',
            placeholder: text(element.getAttribute('placeholder') || element.getAttribute('data-placeholder')), shown: shown(element)
        })),
        buttons: buttons.map(element => ({ name: text(name(element)), text: text(element.innerText), icon: Boolean(element.querySelector('svg')), off: Boolean(element.disabled) })),
        pickedInput: input ? input.id || input.tagName.toLowerCase() : null,
        pickedButton: button ? text(name(button)) : null
    }
}

/**
 * Runs INSIDE the page: what it shows now — the path, whether a verification
 * is up, and the end of its text, where an answer would be.
 */
function pageState() {
    const text = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ')
    const verification = /access verification|security verification|verify you are human|are you a robot|complete the puzzle|slide to verify/i.test(text) ||
        Boolean(document.querySelector('#captcha-element, iframe[src*="captcha"]'))
    return { path: location.pathname, verification, text: text.slice(-360) }
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

    /** Header names and harmless values of a request: secret ones by name, opaque ones by length. */
    const headerNames = sent => Object.keys(sent).sort().map(name => {
        if (SECRET_HEADERS.test(name)) return name
        if (OPAQUE_HEADERS.test(name)) return `${name}(${String(sent[name]).length})`
        return `${name}=${cut(sent[name], 60)}`
    })

    /** Header names and harmless values of one exchange, for the summary. */
    async function describeExchange(response, entry) {
        try {
            const sent = await response.request().allHeaders()
            entry.sent = headerNames(sent)
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
    }, UI_SEND ? 780000 : 420000).unref()
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

    // The same channel the worker exposes before the first navigation; here
    // it also carries the completions probe's events.
    const relayed = []
    await page.exposeFunction(egress.STREAM_CHANNEL, (id, event) => { relayed.push(event) })

    // The page's token, watched from before its first load: when the page
    // boots it rotates it, and a call made before that is refused.
    let tokenNow
    const tokenWatch = setInterval(async () => {
        let seen
        try {
            seen = await page.evaluate(pageTokenFingerprint)
        } catch {
            return // mid-navigation: the next look lands on the new document
        }
        if (seen === tokenNow) return
        const firstSight = tokenNow === undefined
        tokenNow = seen
        const [length, hash, exp] = seen ? seen.split(':') : [null, null, null]
        const left = Number.isFinite(Number(exp)) && exp !== 'null' ? `exp in ${Math.round((Number(exp) * 1000 - Date.now()) / 1000)} s` : 'no expiry read'
        log('token', `${firstSight ? 'the page has' : 'the page changed'} its token: ${seen ? `${length} chars, ${hash}, ${left}` : 'none'}`)
    }, 250)
    tokenWatch.unref?.()

    const tRenewStart = ms()
    let harvested
    try {
        harvested = await signer.renew(context, { chatOrigin: ORIGIN, timeoutMs: 120000 })
    } catch (error) {
        log('life', `renew failed after ${ms() - tRenewStart} ms: ${error.code || ''} ${cut(error.message, 160)}`)
    }
    const tReady = ms()
    log('life', `page ready ${harvested ? 'with a token' : 'WITHOUT a token'} at ${tReady} ms (renew took ${tReady - tRenewStart} ms)`)

    // A chats/new as the app sends it — with `bearer` on it when a caller brings its own.
    const chatsNew = bearer => egress.normalizeEgress({
        url: '/api/v2/chats/new',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({
            chatId: '', models: ['qwen3.7-plus'], project_id: '', timestamp: Date.now(),
            chat_type: 't2t', chat_mode: 'normal'
        }),
        timeoutMs: 30000
    }, { chatOrigin: ORIGIN, defaultTimeoutMs: 120000, maxTimeoutMs: 600000 })
    // This run's own chats/new: the worker's call, which brings no Bearer of its own.
    const request = chatsNew()

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
    async function attempt(label, callRequest = request) {
        const started = Date.now()
        const ownBearer = 'authorization' in callRequest.init.headers ? ', with a Bearer of its own' : ''
        log(label, `in-page call starts (${TRANSPORT_LABEL[TRANSPORT]}${LIKE_FE && TRANSPORT !== 'worker' ? ', with the headers of the page' : ''}${ownBearer})`)
        const call = TRANSPORT === 'xhr' ? pageXhrProbe : TRANSPORT === 'fetch' ? pageFetchProbe : egress.pageCall
        const running = page.evaluate(call, { ...callRequest, maxBytes: MAX_BYTES, fe: LIKE_FE, reasons: egress.ABORT_REASON })
            .then(outcome => ({ outcome }), error => ({ error }))
        const backstop = new Promise(resolve => {
            const id = setTimeout(() => resolve({ backstop: true }), callRequest.timeoutMs + BACKSTOP_MS)
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
        // The chat a passing chats/new created: what a completions call needs.
        try {
            const parsed = JSON.parse(first.outcome.body)
            if (parsed?.success === true && typeof parsed.data?.id === 'string') result.chatId = parsed.data.id
        } catch { /* no chat came of it */ }
        // Answered, and the answer refuses the session of the call (status 200, a JSON envelope).
        result.sessionRefused = Boolean(first.outcome && typeof first.outcome.body === 'string' &&
            /"code":\s*"unauthorized"/.test(first.outcome.body))
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
        if (result.sessionRefused) result.outcome += ' — THE SESSION OF THE CALL WAS REFUSED'
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

    /**
     * One completions call from the page, by the worker's own streaming code
     * (pageCall with a channel): what qwen.ai answered with its first frames.
     */
    async function completions(chatId, signature = {}) {
        relayed.length = 0
        const started = Date.now()
        const signed = Object.keys(signature).length ? ` and the page's own ${Object.keys(signature).join(', ')}` : ''
        log('completions', `the stream call starts (the worker's own code, with the headers the worker gives it${signed})`)
        const running = page.evaluate(egress.pageCall, {
            url: `/api/v2/chat/completions?chat_id=${chatId}`,
            init: {
                method: 'POST',
                // What the app puts on it: the worker adds the page's own headers.
                headers: { 'content-type': 'application/json', accept: 'application/json', ...signature },
                body: JSON.stringify({
                    model: 'qwen3.7-plus', max_tokens: 64, stream: true,
                    chat_id: chatId, chatId, parent_id: null, parentId: null,
                    messages: [{ role: 'user', content: 'Say pong', parent_id: null, parentId: null }]
                })
            },
            timeoutMs: 120000, maxBytes: 0,
            channel: egress.STREAM_CHANNEL, registry: egress.STREAM_ABORTS, id: 1, reasons: egress.ABORT_REASON
        })
        let outcome
        try {
            outcome = await withTimeout(running, 150000, 'the completions call')
        } catch (error) {
            outcome = { ok: false, error: 'no answer', message: cut(error.message, 120) }
        }
        const head = relayed.find(event => event.type === 'head') || null
        const answered = relayed.filter(event => event.type === 'chunk').map(event => Buffer.from(event.data, 'base64').toString('utf8')).join('')
        // What qwen.ai's risk control answers instead of an answer, under status 200 (21.11, 24.11).
        const challenge = /FAIL_SYS_USER_VALIDATE|RGV587|punish|aliyun_waf|被挤爆/i.test(answered)
        const frames = (answered.match(/^data: /gm) || []).length
        const said = {
            ok: outcome.ok, error: outcome.error || undefined, status: head ? head.status : null,
            type: head ? head.headers['content-type'] : null, bytes: answered.length, frames,
            answer: challenge ? 'A CHALLENGE' : frames ? 'an answer (SSE frames)' : answered ? 'text, no SSE frame' : 'nothing',
            took: Date.now() - started
        }
        log('completions', `${said.ok ? 'ok' : `not ok: ${said.error}`} · HTTP ${said.status} · ${said.type || '-'} · ` +
            `${said.bytes} bytes, ${said.frames} SSE frame(s) · ${said.answer} · ${said.took} ms`)
        log('completions', `starts: ${cut(answered.replace(/\s+/g, ' '), 420)}`)
        return said
    }

    // ---- the page's own message (--ui-send), and what may follow it -------------------------
    // What the page's own code sent from the moment the message was typed on:
    // its chats/new and its completions, kept as the responses — for what
    // their requests carried and what qwen.ai answered.
    const own = { typedAt: null, chatsNew: null, completions: null }
    page.on('response', response => {
        const entry = requests.get(response.request())
        if (own.typedAt === null || !entry || entry.t < own.typedAt || entry.host !== originHost || entry.method !== 'POST') return
        const pathname = new URL(response.url()).pathname
        if (pathname === '/api/v2/chats/new' && !own.chatsNew) own.chatsNew = response
        if (pathname === '/api/v2/chat/completions' && !own.completions) own.completions = response
    })

    // The runbook's pause between two calls, counted from the end of the last one.
    let lastCallEndedAt = 0
    async function pauseBetweenCalls() {
        const wait = lastCallEndedAt + PAUSE_MS - ms()
        if (wait > 0) {
            log('life', `a pause of ${Math.round(wait / 1000)} s before the next call`)
            await sleep(wait)
        }
        lastCallEndedAt = ms()
    }

    /** The Baxia headers the page put on its own request, for the worker's call to carry. Kept in memory only. */
    async function pageSignature(response) {
        const sent = await response.request().allHeaders().catch(() => ({}))
        const signature = {}
        for (const name of ['bx-ua', 'bx-umidtoken']) if (sent[name]) signature[name] = sent[name]
        return Object.keys(signature).length ? signature : null
    }

    /** What the page's own request carried, and what qwen.ai answered to it. */
    async function ownExchange(response, { body: readBody = false } = {}) {
        const request = response.request()
        const sent = await request.allHeaders().catch(() => ({}))
        const said = {
            at: requests.get(request)?.t, path: new URL(request.url()).pathname, sent: headerNames(sent),
            status: response.status(), type: response.headers()['content-type'] || ''
        }
        const posted = request.postData()
        if (posted) said.body = cut(posted.replace(/\s+/g, ' '), 900)
        if (!readBody) {
            said.answer = cut(String(await response.text().catch(() => '')).replace(/\s+/g, ' '), 420)
            return said
        }
        // An answer that streams is whole once it is over; one that does not end is not read.
        const text = String(await withTimeout(response.text(), 120000, 'the answer').catch(() => ''))
        // What qwen.ai's risk control answers instead of an answer, under status 200 (21.11, 24.11).
        const challenge = /FAIL_SYS_USER_VALIDATE|RGV587|punish|aliyun_waf|被挤爆/i.test(text)
        const frames = (text.match(/^data: /gm) || []).length
        said.bytes = text.length
        said.answer = challenge ? 'A CHALLENGE' : frames ? `an answer, ${frames} SSE frame(s)${/\[DONE\]/.test(text) ? ' to [DONE]' : ''}` : text ? 'text, no SSE frame' : 'nothing'
        said.starts = cut(text.replace(/\s+/g, ' '), 600)
        return said
    }

    /** The page sends a message the way a person makes it: typed into its input, sent with its button. */
    async function uiSend(text) {
        const controls = await withTimeout(page.evaluate(pageControls, { mark: true }), 8000, 'controls')
        log('ui', `inputs: ${controls.inputs.map(item => `${item.tag}${item.id ? '#' + item.id : ''}${item.placeholder ? ` "${item.placeholder}"` : ''}${item.shown ? '' : ' (hidden)'}`).join(' | ') || 'NONE'}`)
        log('ui', `buttons: ${controls.buttons.map(item => `[${[item.name, item.text].filter(Boolean).join(' ')}${item.icon ? ' icon' : ''}${item.off ? ' off' : ''}]`).join(' ') || 'NONE'}`)
        const result = { controls }
        if (!controls.pickedInput) {
            log('ui', 'no input field on the page: nothing typed, nothing sent')
            return result
        }
        const field = page.locator('[data-e4diag-input]').first()
        const button = page.locator('[data-e4diag-send]').first()
        const typedAt = Date.now()
        own.typedAt = ms()
        await field.click({ timeout: 5000 })
        await page.keyboard.type(text, { delay: 40 })
        await sleep(2500)
        // Some front ends make the chat while the first character is typed.
        if (own.chatsNew) log('ui', `the page made its chats/new while the message was typed (HTTP ${own.chatsNew.status()})`)
        const tries = []
        if (controls.pickedButton) tries.push(['its send button', () => button.click({ timeout: 5000 })])
        tries.push(['Enter in the input', () => field.press('Enter')])
        for (const [how, press] of tries) {
            try {
                await press()
            } catch (error) {
                log('ui', `${how}: ${cut(error.message, 100)}`)
                continue
            }
            const until = Date.now() + 15000
            while (Date.now() < until && !own.completions) await sleep(250)
            if (own.completions) {
                result.sentWith = how
                break
            }
            log('ui', `${how}: the page sent no completions in 15 s`)
        }
        result.msToSent = Date.now() - typedAt
        return result
    }

    /** --bearer-compare: the harvested token and the page's own, each on a chats/new of the worker's code. */
    async function bearerCompare() {
        const pageToken = await withTimeout(page.evaluate(() => localStorage.getItem('token')), 5000, 'the page token')
        const lines = []
        for (const [label, which, token] of [
            ['bearer-harvested', 'the token the renewal harvested', harvested.token],
            ['bearer-page', "the page's token now", pageToken]
        ]) {
            await pauseBetweenCalls()
            log('bearer', `${which}: ${tokenFingerprint(token)}`)
            const call = await attempt(label, chatsNew(token))
            lines.push({ which, fingerprint: tokenFingerprint(token), outcome: call.outcome, sessionRefused: Boolean(call.sessionRefused) })
        }
        return lines
    }

    /** --signed: one chats/new, then one completions call of the worker's own code, on the page's signature. */
    async function signedCall(signature) {
        await pauseBetweenCalls()
        const created = await attempt('signed-chats-new')
        if (!created.chatId) {
            log('signed', `skipped: the chats/new before it made no chat (${created.outcome})`)
            return { chatsNew: created.outcome, completions: null }
        }
        return { chatsNew: created.outcome, completions: await completions(created.chatId, signature) }
    }

    /** All of --ui-send, and what was asked for after it. */
    async function ownMessage() {
        const typed = await uiSend(UI_TEXT)
        const report = { typed }
        log('ui', `the message was ${typed.sentWith ? `sent with ${typed.sentWith}` : 'NOT SENT'}`)
        if (own.chatsNew) {
            report.chatsNew = await ownExchange(own.chatsNew)
            log('ui', `its chats/new at ${report.chatsNew.at} ms -> HTTP ${report.chatsNew.status}; sent: ${report.chatsNew.sent.join(' ')}`)
            log('ui', `its chats/new answered: ${report.chatsNew.answer}`)
        }
        // The signature is read here and goes no further than the worker's call: by name and length into the report.
        const signature = own.completions ? await pageSignature(own.completions) : null
        if (own.completions) {
            report.completions = await ownExchange(own.completions, { body: true })
            report.signature = signature ? Object.keys(signature).map(name => `${name}(${signature[name].length})`) : []
            log('ui', `its completions at ${report.completions.at} ms -> HTTP ${report.completions.status} [${report.completions.type}]; sent: ${report.completions.sent.join(' ')}`)
            log('ui', `on its completions: ${report.signature.join(' ') || 'no bx-ua / bx-umidtoken'}`)
            log('ui', `its completions body: ${report.completions.body}`)
            log('ui', `its completions answered: ${report.completions.answer}`)
            log('ui', `its completions starts: ${report.completions.starts}`)
        }
        report.screenshotAfter = await shot('after-the-message.png')
        report.stateAfter = await withTimeout(page.evaluate(pageState), 8000, 'the page').catch(error => ({ error: cut(error.message, 100) }))
        log('ui', `the page shows: ${JSON.stringify(report.stateAfter)}`)
        lastCallEndedAt = ms()
        if (BEARER_COMPARE) report.bearer = await bearerCompare()
        if (SIGNED) {
            const passed = report.completions && /^an answer/.test(report.completions.answer)
            if (!passed) log('signed', 'skipped: the page\'s own completions did not pass')
            else if (!signature) log('signed', 'skipped: the page\'s own completions carried no bx-ua / bx-umidtoken to carry over')
            else report.signed = await signedCall(signature)
        }
        return report
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
    } else if (UI_SEND) {
        out.ui = await ownMessage()
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
        } else if (first.sessionRefused) {
            // qwen.ai answered at once but refused the session of the call:
            // the page may not have been ready that early (24.11, the first
            // call 0.3 s after the page opened; the same call later passed).
            // The page is left alone for the runbook's pause, then asked once more.
            const wait = MIN_BETWEEN_CALLS_MS - (Date.now() - T0 - first.at)
            if (wait > 0) await sleep(wait)
            const verification = events.findIndex(event => event.kind === 'verification' && event.t >= first.at)
            if (verification !== -1) {
                out.verificationAt = events[verification].t
                log('call-2', 'skipped: the page is showing a verification (a puzzle captcha) for the first call')
            } else {
                out.call2 = await attempt('call-2')
            }
        } else {
            await sleep(15000)
        }
        if (COMPLETIONS) {
            // Right after a chats/new passed, as the app sends it.
            const passed = [out.call1, out.call2].find(call => call && call.chatId)
            if (passed) out.completions = await completions(passed.chatId)
            else log('completions', 'skipped: no chats/new passed')
        }
    }
    clearInterval(tokenWatch)

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
    console.log(`call sent via ${TRANSPORT_LABEL[TRANSPORT]}${LIKE_FE && TRANSPORT !== 'worker' ? ' with the headers of the page' : TRANSPORT === 'worker' ? ' with the headers the worker gives it' : ''}${SETTLE_MS ? `, after ${SETTLE_MS} ms of waiting` : ''}`)
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
    if (out.completions) {
        console.log(`completions: ${JSON.stringify(out.completions)}`)
    }
    if (out.ui) {
        const ui = out.ui
        console.log('--- the page\'s own message, and what was asked for after it')
        console.log(`the message was ${ui.typed.sentWith ? `sent with ${ui.typed.sentWith}, ${ui.typed.msToSent} ms after typing began` : 'NOT SENT'}`)
        if (ui.chatsNew) console.log(`its chats/new: HTTP ${ui.chatsNew.status}; sent: ${ui.chatsNew.sent.join(' ')} -> ${ui.chatsNew.answer}`)
        if (ui.completions) {
            console.log(`its completions: HTTP ${ui.completions.status} [${ui.completions.type}]; sent: ${ui.completions.sent.join(' ')}`)
            console.log(`  on it: ${ui.signature.join(' ') || 'no bx-ua / bx-umidtoken'}`)
            console.log(`  body sent: ${ui.completions.body}`)
            console.log(`  answered: ${ui.completions.answer}`)
            console.log(`  starts: ${ui.completions.starts}`)
        }
        console.log(`the page shows after it: ${JSON.stringify(ui.stateAfter)}`)
        for (const line of ui.bearer || []) console.log(`chats/new with ${line.which} (${line.fingerprint}): ${line.outcome}`)
        if (ui.signed) {
            console.log(`the worker's chats/new before the signed call: ${ui.signed.chatsNew}`)
            if (ui.signed.completions) console.log(`the worker's completions on the page's signature: ${JSON.stringify(ui.signed.completions)}`)
        }
    }
    console.log('--- page facts')
    console.log('ready:', JSON.stringify(out.factsReady))
    console.log('end:  ', JSON.stringify(out.factsEnd))
    console.log('--- still open at the end')
    for (const line of out.pendingAtEnd.slice(0, 12)) console.log(line)
    console.log(`screenshots: ${out.screenshotReady}, ${out.screenshotEnd}${out.ui ? `, after-the-message.png` : ''} in ${OUT}`)
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ ...out, events, requests: list, console: consoleAll }, null, 1))
}

main().then(() => process.exit(0), error => {
    console.error('diagnostic failed:', error && error.stack ? cut(error.stack, 600) : error)
    process.exit(1)
})
