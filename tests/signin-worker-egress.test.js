const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { createServer, shutdownHandler } = require('../signin-worker/server')
const { createResidents } = require('../signin-worker/lib/resident-pages')
const {
    pageCall, normalizeEgress, isChallengePage, isHtmlAnswer, readFrontEndVersion, PAGE_HEADERS, ABORT_REASON,
    STREAM_CHANNEL, STREAM_ABORTS, pageTokenState, pageRefreshToken, answerNote
} = require('../signin-worker/lib/egress-fetch')
const { pageGlobals } = require('./helpers/fake-xml-http-request')

const CHAT = 'https://chat.qwen.ai'
const AUTH = { authorization: 'Bearer secret' }

const profileHash = email => crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
// A persisted profile is what authorizes /renew and the lazy open.
const withProfile = (dataDir, email) => {
  fs.mkdirSync(path.join(dataDir, 'account-' + profileHash(email)), { recursive: true })
}

// Poll until the condition holds: fixed sleeps flake under CI load.
async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
const jsonResponse = (payload, status = 200) =>
  new Response(typeof payload === 'string' ? payload : JSON.stringify(payload),
    { status, headers: { 'content-type': 'application/json' } })

// A fake "Playwright" in the jik.3 mold: contexts and pages that record what
// the worker does. page.evaluate runs the REAL in-page function inside a
// sandbox whose XMLHttpRequest answers from a scripted fetch
// (helpers/fake-xml-http-request.js), so the tests see exactly what the page
// would send. No Chromium anywhere near CI.
function fakeBrowser() {
  const script = { fetch: () => jsonResponse({ success: true }), cookies: [], renew: null, evaluate: null, closeDelay: 0 }
  const calls = []
  const contexts = []
  let generation = 0
  const harvest = source => ({
    token: `token-${source}-${++generation}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    cookies: [{ name: 'cna', value: source, domain: 'chat.qwen.ai', path: '/' }]
  })

  const emitter = () => {
    const handlers = {}
    return {
      on(event, handler) { (handlers[event] ||= []).push(handler) },
      off(event, handler) { handlers[event] = (handlers[event] || []).filter(kept => kept !== handler) },
      emit(event, ...args) { for (const handler of [...handlers[event] || []]) handler(...args) },
      listenerCount(event) { return (handlers[event] || []).length }
    }
  }

  const signer = {
    calls, contexts, script,
    async openContext(options) {
      calls.push({ op: 'open', ...options })
      // `page.storage`: a localStorage of the page's own, when a test gives it
      // one (Qwen2API-xun); by default the page keeps the script's.
      const page = { ...emitter(), evaluations: [], asked: [], pending: new Set(), bindings: {}, storage: null }
      // What the page reads of the script: the script itself, at call time —
      // what the page's requests record goes to it — but for its localStorage.
      const pageScript = new Proxy(script, {
        get: (target, name) => (name === 'storage' ? page.storage ?? (target.storage ??= {}) : Reflect.get(target, name)),
        set: (target, name, value) => {
          if (name === 'storage') page.storage = value
          else Reflect.set(target, name, value)
          return true
        }
      })
      // What exposeFunction puts on the page: its streams report through it.
      page.exposeFunction = async (name, handler) => { page.bindings[name] = handler }
      const inSandbox = (fn, arg) => {
        page.evaluations.push(arg)
        // Which function the page was asked to run, by name: what a test counts (Qwen2API-xun).
        page.asked.push(fn.name)
        // Only what a page can see: no module scope leaks in.
        const sandbox = { AbortController, setTimeout, clearTimeout, Blob, ...page.bindings, ...pageGlobals(pageScript, page) }
        return vm.runInNewContext(`(${fn.toString()})`, sandbox)(arg)
      }
      page.evaluate = (fn, arg) => new Promise((resolve, reject) => {
        page.pending.add(reject)
        // A test may take a question over, and still run it in the page itself.
        const run = (fn, arg) => (script.evaluate ? script.evaluate(fn, arg, inSandbox) : inSandbox(fn, arg))
        Promise.resolve().then(() => run(fn, arg)).then(resolve, reject)
          .finally(() => { page.pending.delete(reject) })
      })
      page.on('close', () => {
        // What the real page.evaluate does when its page dies mid-call.
        for (const reject of page.pending) reject(new Error('Target page, context or browser has been closed'))
        page.pending.clear()
      })
      const context = {
        ...emitter(), page, jar: script.cookies, closed: false,
        pages: () => [page],
        async cookies() { calls.push({ op: 'cookies' }); return context.jar },
        async close() {
          // 'close' = the close began (the page is gone); 'closed' = the
          // browser process is. Chromium keeps the profile locked in between.
          context.closed = true
          calls.push({ op: 'close', context })
          page.emit('close')
          context.emit('close')
          await new Promise(resolve => setTimeout(resolve, script.closeDelay || 0))
          calls.push({ op: 'closed', context })
        }
      }
      contexts.push(context)
      return context
    },
    async signin(context, { email }) {
      calls.push({ op: 'signin', email, page: context.pages()[0] })
      return harvest(`signin-${email}`)
    },
    async renew(context) {
      calls.push({ op: 'renew', page: context.pages()[0] })
      if (script.renew) return script.renew()
      return harvest('renew')
    }
  }
  return signer
}

async function start(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-egress-'))
  const server = createServer({
    dataDir, token: 'secret', timeoutMs: 120000, maxPages: 16,
    minRenewDelayMs: 60000, keepAliveMs: 60000, drainMs: 1000, backstopMs: 5000, frontEndMs: 100, settleStableMs: 40, settlePollMs: 10, settleTimeoutMs: 300,
    // Login pacing is signin-worker-pacing.test.js's subject. So is the queue
    // that keeps the page loads of every account apart (Qwen2API-nch, Qwen2API-ops).
    minLoginIntervalMs: 1, loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1,
    ...options
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const post = (pathName, payload, headers = AUTH) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload)
  })
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json()
  t.after(async () => {
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { post, health, dataDir, server }
}

const egress = (post, email, extra = {}) => post('/egress', {
  email, url: `${CHAT}/api/v2/chats/new`, method: 'POST',
  headers: { 'content-type': 'application/json' }, body: '{"chatId":""}', timeoutMs: 5000, ...extra
})

// What the worker logs while `fn` runs — as it runs, so that `fn` can wait
// for a line.
async function logged(fn) {
  const lines = []
  const real = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    return await fn(lines)
  } finally {
    console.log = real
  }
}

const CHALLENGE_PAGE = '<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="x"> <script> /* v2.0.1 */ </script>'

// page.evaluate serializes pageCall by source: run it the same way, in a
// bare sandbox, to reach the outcomes the HTTP tests cannot stage. Its
// objects come from the sandbox's realm, so they are compared as plain data.
// The guard turns a request that never settles (a broken abort timer) into a
// failure here instead of a hung test runner.
const inPage = async (script, arg) => {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the in-page request never settled')), 2000)
  })
  try {
    const run = vm.runInNewContext(`(${pageCall.toString()})`,
      { AbortController, setTimeout, clearTimeout, btoa, ...script, ...pageGlobals(script) })(arg)
    return JSON.parse(JSON.stringify(await Promise.race([run, guard])))
  } finally {
    clearTimeout(timer)
  }
}

test('egress opens a resident page on first use and runs the call from inside it, as one of the page’s own requests', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'live@example.invalid'
  signer.script.frontEnd = '0.3.50'

  // No persisted profile: nothing to open a page on, and no browser launched.
  const missing = await egress(post, email)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'no_profile')
  assert.equal(signer.calls.length, 0)

  withProfile(dataDir, email)
  signer.script.cookies = [{ name: 'ssxmod_itna', value: 'rotated', domain: 'chat.qwen.ai', path: '/' }]

  const { lines } = await logged(async captured => {
    const first = await egress(post, email, {
      headers: {
        'content-type': 'application/json',
        'X-Request-Id': '6f1c9d2e',
        Authorization: 'Bearer app-token',
        Cookie: 'stolen=1'
      }
    })
    assert.equal(first.status, 200)
    const result = await first.json()
    assert.equal(result.status, 200)
    assert.equal(result.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(result.body), { success: true })
    assert.equal(result.url, `${CHAT}/api/v2/chats/new`)
    assert.equal(result.redirected, false)
    assert.equal(result.challenge, undefined, 'an ordinary JSON answer is no challenge')
    // The live jar rides back with every answer (jar sync, Qwen2API-3ue.2).
    assert.deepEqual(result.cookies.map(cookie => cookie.name), ['ssxmod_itna'])
    return { lines: captured }
  })

  // One browser, on the hashed profile directory, loaded once like a renewal.
  const opens = () => signer.calls.filter(call => call.op === 'open')
  assert.equal(opens().length, 1)
  assert.match(opens()[0].dataDir, /account-[0-9a-f]{32}$/)
  assert.equal(opens()[0].dataDir.includes(email), false)
  const [context] = signer.contexts
  assert.equal(signer.calls.find(call => call.op === 'renew').page, context.page)
  // What the page runs is said once, where the log says the page is up.
  assert.ok(lines.some(line => /resident-open ok \(1\/16 pages, front-end 0\.3\.50\)$/.test(line)), lines.join('\n'))

  // What the page sent (Qwen2API-3ue.5): an XMLHttpRequest, with the app's
  // headers and the page's own on top — the way the page's own code sends
  // its API requests, which is what qwen.ai answered with JSON on 24.11.
  // Cookie is dropped: the profile's own jar rides along instead.
  assert.equal(signer.script.xhrs.length, 1)
  const sent = signer.script.xhrs[0].sent
  assert.equal(sent.url, `${CHAT}/api/v2/chats/new`)
  assert.equal(sent.method, 'POST')
  assert.equal(sent.body, '{"chatId":""}')
  assert.match(sent.headers.timezone,
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
  assert.deepEqual({ ...sent.headers, timezone: '<the page’s clock>' }, {
    accept: PAGE_HEADERS.accept,
    'accept-language': 'en-US,en;q=0.9',
    source: PAGE_HEADERS.source,
    'content-type': 'application/json',
    'x-request-id': '6f1c9d2e',
    authorization: 'Bearer app-token',
    timezone: '<the page’s clock>',
    version: '0.3.50'
  })

  // Second call reuses the page: no launch, no reload.
  await (await egress(post, email)).json()
  assert.equal(opens().length, 1)
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
  // (Of that page's evaluations, the two calls are the ones that were given a request.)
  assert.equal(context.page.evaluations.filter(arg => arg?.url).length, 2)
  // The caller brought no request id on the second call: the worker gave it one.
  assert.match(signer.script.xhrs[1].sent.headers['x-request-id'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  assert.deepEqual(await health(), {
    ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16, headless: true, headlessMode: 'shell',
    // Reported where a flip is verified, as the headless mode is (Qwen2API-xun, Qwen2API-nch); the queue of page loads is off in these tests.
    pageTokenRefresh: true, streamWaitMs: 20000, loadMinIntervalMs: 1, loadMaxWaitMs: 120000,
    pageLoadQueue: { waiting: 0, nextInMs: 0 }
  })

  // Opening the page IS a renewal: the session cache holds what it settled on.
  const cached = await (await post('/renew', { email })).json()
  assert.equal(cached.token, 'token-renew-1')
  assert.deepEqual(cached.cookies.map(cookie => cookie.name), ['ssxmod_itna'])
})

test('egress refuses everything but the chat origin before any browser is touched', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'guard@example.invalid'
  withProfile(dataDir, email)

  const anonymous = await post('/egress', { email, url: '/api/v2/models', method: 'GET' }, {})
  assert.equal(anonymous.status, 401)
  assert.equal((await anonymous.json()).code, 'unauthorized')

  // The worker drives a logged-in browser: a target off the chat origin would
  // be an SSRF with the account's cookies attached.
  const offOrigin = [
    'https://evil.example/api/v2/chats/new',
    '//evil.example/api/v2/chats/new',
    'https://chat.qwen.ai.evil.example/',
    'https://chat.qwen.ai@evil.example/',
    'https://user:pw@chat.qwen.ai/api/v2/chats/new',
    'https://evil.example\\@chat.qwen.ai/',
    'http://chat.qwen.ai/api/v2/chats/new',
    'https://chat.qwen.ai:8443/api/v2/chats/new',
    'http://169.254.169.254/latest/meta-data/',
    'http://signin-worker:3100/session',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url', // relative to nothing the caller meant
    'api/v2/models', // a path must be rooted
    '', undefined, null, 42
  ]
  for (const url of offOrigin) {
    const refused = await egress(post, email, { url })
    assert.equal(refused.status, 400, `${String(url)} must be refused`)
    assert.equal((await refused.json()).code, 'invalid_request')
  }

  const malformed = [
    { method: 'CONNECT' }, { method: '' }, { method: undefined },
    { method: 'GET', body: '{"a":1}' }, // GET cannot carry a body
    { body: { chatId: '' } }, { body: 42 }, // the body is passed through as text
    { headers: [{ name: 'x' }] },
    { headers: { 'x-leak': 'a\r\ninjected: 1' } },
    { headers: { 'x-leak': 1 } },
    { headers: { 'bad name': 'v' } },
    { headers: { 'x-note': 'не-ASCII' } }, // the browser itself would refuse to send it
    { timeoutMs: '5000' }, { timeoutMs: NaN }
  ]
  for (const extra of malformed) {
    const refused = await egress(post, email, extra)
    assert.equal(refused.status, 400, `${JSON.stringify(extra)} must be refused`)
    assert.equal((await refused.json()).code, 'invalid_request')
  }
  const badEmail = await egress(post, 'not-an-email')
  assert.equal(badEmail.status, 400)
  const notAnObject = await post('/egress', [1, 2, 3])
  assert.equal(notAnObject.status, 400)

  assert.equal(signer.calls.length, 0)

  // Same origin in either form is fine; the page always gets the absolute URL.
  const seen = []
  signer.script.fetch = async url => { seen.push(url); return jsonResponse({ models: [] }) }
  for (const url of ['/api/v2/models', `${CHAT}/api/v2/models`]) {
    assert.equal((await egress(post, email, { url, method: 'GET', body: undefined })).status, 200)
  }
  assert.deepEqual([...new Set(seen)], [`${CHAT}/api/v2/models`])
})

test('upstream refusals pass through untouched and the timeout stays clamped', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, egressMaxTimeoutMs: 150000 })
  const email = 'upstream@example.invalid'
  withProfile(dataDir, email)

  // A 401 or a 500 from qwen.ai is the app's call to classify: the egress
  // itself succeeded, so the worker answers 200 with the upstream status inside.
  for (const status of [401, 403, 500]) {
    signer.script.fetch = async () => jsonResponse({ bogus: status }, status)
    const answer = await (await egress(post, email)).json()
    assert.equal(answer.status, status)
    assert.deepEqual(JSON.parse(answer.body), { bogus: status })
  }

  const asked = () => signer.contexts[0].page.evaluations.at(-1).timeoutMs
  await (await egress(post, email, { timeoutMs: 10 })).json()
  assert.equal(asked(), 100) // floor
  await (await egress(post, email, { timeoutMs: 1e9 })).json()
  assert.equal(asked(), 150000) // ceiling
  await (await egress(post, email, { timeoutMs: undefined })).json()
  assert.equal(asked(), 120000) // unset: the worker's own browser-flow timeout
})

test('normalizeEgress pins the target to whatever origin the worker is configured with', () => {
  const lab = { chatOrigin: 'http://127.0.0.1:8080', defaultTimeoutMs: 1000, maxTimeoutMs: 2000 }
  assert.equal(normalizeEgress({ url: '/api/v2/models', method: 'get' }, lab).url,
    'http://127.0.0.1:8080/api/v2/models')
  assert.throws(() => normalizeEgress({ url: `${CHAT}/api/v2/models`, method: 'GET' }, lab), /chat origin/)
  const normalized = normalizeEgress({ url: '/x', method: 'post', headers: { 'X-A': '1' }, body: '' }, lab)
  // Every call is known to the worker by its request id (Qwen2API-3ue.6): the
  // page's own requests carry theirs.
  assert.match(normalized.init.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(normalized, {
    url: 'http://127.0.0.1:8080/x',
    init: { method: 'POST', headers: { 'x-a': '1', 'x-request-id': normalized.init.headers['x-request-id'] }, body: undefined },
    timeoutMs: 1000,
    stream: false
  })
  assert.notEqual(normalizeEgress({ url: '/x', method: 'post' }, lab).init.headers['x-request-id'],
    normalized.init.headers['x-request-id'])
  // The caller's own is sent, not replaced.
  assert.deepEqual(normalizeEgress({ url: '/x', method: 'post', headers: { 'X-Request-Id': 'mine' } }, lab).init.headers,
    { 'x-request-id': 'mine' })
})

test('the in-page call sends the page’s own headers: its time zone and front end version, and what the caller brought', async () => {
  const request = { url: `${CHAT}/api/v2/models`, init: { method: 'GET', headers: {} }, timeoutMs: 1000, maxBytes: 1024, reasons: ABORT_REASON }
  // What one call left the page with, its headers included.
  const sentBy = async (script, init = { method: 'GET', headers: {} }) => {
    const scripted = { frontEnd: '0.3.50', ...script }
    await inPage(scripted, { ...request, init })
    return scripted.xhrs[0].sent
  }

  // The page's clock says the time zone in the front end's own format (its
  // requests on 24.11 carried 'Tue Nov 24 2026 14:19:55 GMT+0000'), and in the
  // page's own zone. (Not the very second: the call and this check may straddle one.)
  const sent = await sentBy({})
  assert.match(sent.headers.timezone,
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
  const offset = -new Date().getTimezoneOffset()
  const pad = value => String(value).padStart(2, '0')
  const zone = `GMT${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
  assert.ok(sent.headers.timezone.endsWith(zone), `${sent.headers.timezone} is not in the page's own zone (${zone})`)
  // The front end's version is read off the address its scripts load from.
  assert.equal(sent.headers.version, '0.3.50')
  assert.equal((await sentBy({ frontEnd: '0.4.1' })).headers.version, '0.4.1')
  // A page that shows no front end version sends none, rather than a guess.
  assert.equal('version' in (await sentBy({ frontEnd: '' })).headers, false)
  assert.equal('version' in (await sentBy({ frontEnd: 'elsewhere' })).headers, false)

  // What a caller may leave out is what the page's own requests carry anyway.
  assert.equal(sent.headers.accept, PAGE_HEADERS.accept)
  assert.equal(sent.headers.source, PAGE_HEADERS.source)
  // The language in Chrome's own form for it — what the page's own requests
  // carried on 24.11, where a request left to the browser said only 'en-US'.
  assert.equal(sent.headers['accept-language'], 'en-US,en;q=0.9')
  assert.equal((await sentBy({ language: 'zh-CN' })).headers['accept-language'], 'zh-CN,zh;q=0.9')
  assert.equal((await sentBy({ language: 'de' })).headers['accept-language'], 'de')

  // A call that brings no Bearer is one of the page's own: it goes on the page's session.
  assert.equal('authorization' in sent.headers, false, 'a page without a session sends no Bearer')
  assert.equal((await sentBy({ pageToken: 'page-session' })).headers.authorization, 'Bearer page-session')

  // A header the caller brought is sent as given, and nothing of the page's is put over it.
  assert.deepEqual((await sentBy({}, {
    method: 'GET',
    headers: {
      timezone: 'Sat Nov 21 2026 19:55:52 GMT+0400', version: '0.0.1', accept: 'text/plain', source: 'app', 'accept-language': 'fr'
    }
  })).headers, {
    timezone: 'Sat Nov 21 2026 19:55:52 GMT+0400', version: '0.0.1', accept: 'text/plain', source: 'app', 'accept-language': 'fr'
  })
})

test('the in-page call maps its own outcomes: a body in pieces, no body, network failure, timeout, an abort, oversize', async () => {
  const request = { url: `${CHAT}/api/v2/models`, init: { method: 'GET', headers: {} }, timeoutMs: 1000, maxBytes: 1024, reasons: ABORT_REASON }

  // The body arrives in pieces and is assembled.
  const stream = (pieces, onCancel = () => {}) => new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
      controller.close()
    },
    cancel: onCancel
  }), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  const split = await inPage({ fetch: async () => stream(['{"answer":"при', 'вет"}']) }, request)
  assert.deepEqual(split, {
    ok: true, status: 200, url: `${CHAT}/api/v2/models`, redirected: false,
    headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '{"answer":"привет"}'
  })

  // No body at all (HEAD, 204).
  assert.deepEqual(await inPage({
    fetch: async () => ({ status: 204, headers: new Headers(), body: null })
  }, request), { ok: true, status: 204, url: `${CHAT}/api/v2/models`, redirected: false, headers: {}, body: '' })

  // The browser's own failure: a dead connection, a blocked request.
  const failed = await inPage({ fetch: async () => { throw new TypeError('Failed to fetch') } }, request)
  assert.deepEqual(failed, { ok: false, error: 'network_error', message: 'network error' })

  // A stalled upstream: the in-page timer aborts the request.
  const stalled = await inPage({
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()))
    })
  }, { ...request, timeoutMs: 20 })
  assert.deepEqual(stalled, { ok: false, error: 'timeout' })

  // An abort that is not the call's own is not the app going away: a script
  // of the page cut the request. That is the page's doing, and is said so.
  const pending = { fetch: () => new Promise(() => {}) }
  const hijacked = inPage(pending, request)
  await until(() => pending.xhrs?.length === 1)
  pending.xhrs[0].abort()
  assert.deepEqual(await hijacked, { ok: false, error: 'aborted_in_page' })

  // Oversize is cut off as it arrives, not after it was buffered whole.
  const oversize = await inPage({
    fetch: async () => stream(['x'.repeat(600), 'x'.repeat(600)])
  }, request)
  assert.deepEqual(oversize, { ok: false, error: 'too_large', status: 200 })
})

test('a WAF challenge page is qwen.ai’s answer, said at once and by name, and the page stays', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, backstopMs: 5000 })
  const email = 'challenged@example.invalid'
  withProfile(dataDir, email)
  // What qwen.ai answered an API call with on 2026-11-24: status 200, a page.
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  const { answer, lines, took } = await logged(async lines => {
    const since = Date.now()
    const response = await egress(post, email, { timeoutMs: 30000 })
    return { answer: { status: response.status, body: await response.json() }, lines, took: Date.now() - since }
  })
  // The worker does not decide what a challenge means: qwen.ai's status and
  // body travel inside its 200, as for any answer, and the app classifies.
  assert.equal(answer.status, 200)
  assert.equal(answer.body.status, 200)
  assert.equal(answer.body.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(answer.body.body, CHALLENGE_PAGE)
  assert.equal(answer.body.challenge, 'page')
  assert.ok(took < 2000, `the answer was there at once; the call took ${took} ms`)
  // Said in the log by name — a 200 that is a challenge does not read as a 200.
  assert.ok(lines.some(line => /egress \/api\/v2\/chats\/new -> 200 \(1\/16 pages\) — WAF challenge page$/.test(line)), lines.join('\n'))
  // The page is alive and well: nothing closed it, nothing waited for a backstop.
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)
  assert.equal(lines.some(line => /resident-close/.test(line)), false)
  assert.equal(lines.some(line => /unresponsive|stopped responding/.test(line)), false)

  // An HTML page without the challenge's markers is just an answer: said as what it is.
  signer.script.fetch = async () => new Response('<!doctype html><title>Maintenance</title>', { status: 503, headers: { 'content-type': 'text/html' } })
  const maintenance = await (await egress(post, email)).json()
  assert.equal(maintenance.status, 503)
  assert.equal(maintenance.challenge, undefined)
})

test('a challenge the page’s hooks keep from the call is read off the page’s network, and the page stays', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, keptGraceMs: 50, backstopMs: 5000 })
  const email = 'kept@example.invalid'
  withProfile(dataDir, email)
  // The page's request hooks hold an answer they take for a block: the call's
  // own listeners never hear of it. The page's network did.
  signer.script.hold = body => /aliyun_waf_/.test(body)
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  const { answer, lines, took } = await logged(async lines => {
    const since = Date.now()
    const response = await egress(post, email, { timeoutMs: 30000 })
    return { answer: await response.json(), lines, took: Date.now() - since }
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body, CHALLENGE_PAGE)
  assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(answer.challenge, 'network')
  assert.ok(took < 2000, `the answer was read off the network at once; the call took ${took} ms`)
  assert.ok(lines.some(line => /egress \/api\/v2\/chats\/new -> 200 \(1\/16 pages\) — WAF challenge page, kept from the call by the page$/.test(line)),
    lines.join('\n'))
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)
  assert.equal(lines.some(line => /resident-close|unresponsive|stopped responding/.test(line)), false)

  // The page is none the worse, and answers the next call itself.
  signer.script.hold = null
  signer.script.fetch = async () => jsonResponse({ success: true })
  const after = await (await egress(post, email)).json()
  assert.equal(JSON.parse(after.body).success, true)
  assert.equal(after.challenge, undefined)
  assert.equal((await health()).residentPages, 1)
})

test('only a challenge is taken off the page’s network: any other answer is the page’s to hand over or to time out', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, keptGraceMs: 50 })
  const email = 'patient@example.invalid'
  withProfile(dataDir, email)
  // The hooks hold every answer, JSON included: nothing in the worker's
  // watching says "challenge", so nothing is put in the page's place.
  signer.script.hold = () => true
  signer.script.fetch = async () => jsonResponse({ success: true })
  const held = await egress(post, email, { timeoutMs: 200 })
  assert.equal(held.status, 504)
  assert.equal((await held.json()).code, 'egress_timeout')
  assert.equal((await health()).residentPages, 1)

  // An HTML page without the challenge's markers is an answer like any other:
  // not qwen.ai asking for a verification, and not the worker's to take over.
  signer.script.fetch = async () => new Response('<!doctype html><title>Maintenance</title>', { status: 200, headers: { 'content-type': 'text/html' } })
  const maintenance = await egress(post, email, { timeoutMs: 200 })
  assert.equal(maintenance.status, 504)
  assert.equal((await maintenance.json()).code, 'egress_timeout')
  assert.equal((await health()).residentPages, 1)
})

test('of two calls held on one page, each is answered with qwen.ai’s answer to itself', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, keptGraceMs: 50 })
  const email = 'two@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()
  // Both calls are held by the page's hooks. qwen.ai answered the first with
  // a challenge page and the second with JSON. Neither answers before both
  // calls are in the page: each call's watch is up by then, and each watch
  // hears of both answers.
  const page = () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  let arrivals = 0
  let bothArrived
  const both = new Promise(resolve => { bothArrived = resolve })
  signer.script.hold = () => true
  signer.script.fetch = async url => {
    const arrival = ++arrivals
    if (arrivals === 2) bothArrived()
    await both
    return arrival === 1 ? page() : jsonResponse({ success: true, forThe: 'second' })
  }
  const held = await Promise.all([egress(post, email, { timeoutMs: 300 }), egress(post, email, { timeoutMs: 300 })])
  const answers = await Promise.all(held.map(async response => ({ status: response.status, body: await response.json() })))
  // The call that was challenged has its answer read off the network; the other is not answered with it.
  const challenged = answers.filter(answer => answer.status === 200)
  const timedOut = answers.filter(answer => answer.status !== 200)
  assert.equal(challenged.length, 1, JSON.stringify(answers))
  assert.equal(challenged[0].body.challenge, 'network')
  assert.equal(challenged[0].body.body, CHALLENGE_PAGE)
  assert.deepEqual(timedOut.map(answer => [answer.status, answer.body.code]), [[504, 'egress_timeout']])
  assert.equal((await health()).residentPages, 1)
})

test('a call leaves nothing listening on its page, however it ended', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, keptGraceMs: 50 })
  const email = 'tidy@example.invalid'
  withProfile(dataDir, email)
  const listening = () => signer.contexts[0].page.listenerCount('response')
  await (await egress(post, email)).json()
  assert.equal(listening(), 0, 'an answered call left its watch behind')

  // A hung page: the backstop abandons the call and drops the page.
  signer.script.evaluate = () => new Promise(() => {})
  assert.equal((await egress(post, email, { timeoutMs: 200 })).status, 504)
  await until(() => signer.contexts[0].closed)
  signer.script.evaluate = null
  await (await egress(post, email)).json()

  // A challenge kept from the call: answered off the page's network.
  signer.script.hold = body => /aliyun_waf_/.test(body)
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  assert.equal((await (await egress(post, email)).json()).challenge, 'network')
  assert.equal(listening(), 0, 'a call answered off the network left its watch behind')
  assert.equal((await health()).residentPages, 1)
})

test('the call listens, as the page’s hooks cannot hold it: no handler properties, no readyState', async () => {
  // The page's request hooks hold an answer back from a request by never
  // calling its onload, onloadend and onreadystatechange properties, and sit
  // on the readyState getter. The call must use none of the four — the stand-in
  // page notes every use. A stream has none of the four to use: it is a fetch
  // since Qwen2API-3ue.9, and makes no XMLHttpRequest at all.
  const request = { url: `${CHAT}/api/v2/chats/new`, init: { method: 'POST', headers: {} }, timeoutMs: 1000, maxBytes: 4096, reasons: ABORT_REASON }
  const whole = {
    frontEnd: '0.3.50',
    fetch: async () => jsonResponse({ success: true })
  }
  assert.deepEqual(await inPage(whole, request), { ok: true, status: 200, url: `${CHAT}/api/v2/chats/new`, redirected: false,
    headers: { 'content-type': 'application/json' }, body: '{"success":true}' })
  const streamed = {
    frontEnd: '0.3.50', [STREAM_CHANNEL]: () => undefined,
    fetch: async (url, init) => new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  assert.deepEqual(await inPage(streamed, { ...request, channel: STREAM_CHANNEL, registry: STREAM_ABORTS, id: 7 }), { ok: true })
  assert.equal(whole.xhrs.length, 1)
  assert.deepEqual(whole.xhrs[0].handlerProperties, undefined, 'a handler property was assigned')
  assert.equal(whole.xhrs[0].readyStateReads, undefined, 'readyState was read')
  assert.equal(streamed.fetches.length, 1, 'the stream was not a fetch')
  assert.equal(streamed.xhrs, undefined, 'the stream was made as an XMLHttpRequest')
})

test('markers quoted in an answer that is no page make no challenge', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'quoted@example.invalid'
  withProfile(dataDir, email)
  // An answer about this very code quotes the challenge's markers as text.
  const markers = 'aliyun_waf_aa aliyunCaptcha _waf_is_mobile id="captcha-element" <title>Verification</title>'
  signer.script.fetch = async () => jsonResponse({ success: true, text: markers })
  const { lines } = await logged(async captured => {
    const answer = await (await egress(post, email)).json()
    assert.equal(answer.status, 200)
    assert.equal(answer.challenge, undefined, 'an answer that quotes the markers was named a challenge')
    return { lines: captured }
  })
  assert.equal(lines.some(line => /WAF challenge/.test(line)), false, lines.join('\n'))
})

test('each marker of the challenge makes an HTML answer one — and only an HTML answer', () => {
  const html = { 'content-type': 'text/html; charset=utf-8' }
  for (const page of [
    '<meta name="aliyun_waf_aa" content="x">', '<script src="aliyunCaptcha.js"></script>', '<div id="_waf_is_mobile"></div>',
    '<div id="captcha-element"></div>', "<div id='captcha-element'></div>", '<title>Verification</title>', '<TITLE>VERIFICATION</TITLE>'
  ]) {
    assert.equal(isChallengePage(html, page), true, page)
    for (const type of ['application/json', 'text/event-stream', 'text/plain']) {
      assert.equal(isChallengePage({ 'content-type': type }, page), false, `${page} as ${type}`)
    }
    assert.equal(isChallengePage({}, page), false, page)
  }
  assert.equal(isChallengePage(html, 'The word captcha on its own'), false)
  // Beyond the start of the body nothing is looked at: the first 64 KiB.
  const marker = '<meta name="aliyun_waf_aa">'
  assert.equal(isChallengePage(html, 'x'.repeat(64 * 1024 - marker.length) + marker), true)
  assert.equal(isChallengePage(html, 'x'.repeat(64 * 1024) + marker), false)
  assert.equal(isHtmlAnswer(html), true)
  assert.equal(isHtmlAnswer({ 'content-type': 'text/html' }), true)
  assert.equal(isHtmlAnswer({ 'content-type': 'application/json' }), false)
  assert.equal(isHtmlAnswer({}), false)
})

test('the worker names a challenge by the same markers the app screens by', () => {
  const { isWafChallengeBody } = require('../src/utils/upstream-error')
  const html = { 'content-type': 'text/html' }
  for (const body of [
    '<meta name="aliyun_waf_aa" content="x">', 'aliyunCaptcha', '_waf_is_mobile', 'id="captcha-element"', "id='captcha-element'",
    '<title>Verification</title>', '<TITLE>VERIFICATION</TITLE>', 'ALIYUN_WAF_BB',
    // Not a challenge page.
    '{"success":true}', '<html><title>Qwen</title></html>', 'The word captcha on its own', ''
  ]) {
    assert.equal(isChallengePage(html, body), isWafChallengeBody(body), body)
  }
})

test('the worker names its own failures by their own codes: the page’s doing is neither qwen.ai’s nor the account’s', () => {
  const { CODE_FOR_OUTCOME } = require('../signin-worker/lib/egress-fetch')
  const { STATUS_FOR_CODE } = require('../signin-worker/lib/worker-errors')
  assert.deepEqual(CODE_FOR_OUTCOME, {
    timeout: 'egress_timeout', too_large: 'egress_too_large', aborted_in_page: 'page_fault', report_failed: 'page_fault'
  })
  // A code the worker does not answer by would come out as browser_error.
  assert.equal(STATUS_FOR_CODE.page_fault, 502)
  for (const code of Object.values(CODE_FOR_OUTCOME)) assert.equal(typeof STATUS_FOR_CODE[code], 'number', code)
})

test('a listener of the call that throws ends the call, named as the page’s doing', async () => {
  const request = { url: `${CHAT}/api/v2/chats/new`, init: { method: 'POST', headers: {} }, timeoutMs: 1000, maxBytes: 4096, reasons: ABORT_REASON }
  // The page's channel is gone from under the stream (a report cannot be made).
  const broken = {
    [STREAM_CHANNEL]: () => { throw new Error('the binding is gone') },
    fetch: async () => new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  assert.deepEqual(await inPage(broken, { ...request, channel: STREAM_CHANNEL, registry: STREAM_ABORTS, id: 7 }),
    { ok: false, error: 'report_failed', message: 'the binding is gone' })
})

test('the front end is read for a log line only: a page that cannot be asked still opens', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'unasked@example.invalid'
  withProfile(dataDir, email)
  const openContext = signer.openContext
  signer.openContext = async options => {
    const context = await openContext(options)
    const evaluate = context.pages()[0].evaluate
    context.pages()[0].evaluate = (fn, arg) => {
      if (fn === readFrontEndVersion) throw new TypeError('this page cannot be asked')
      return evaluate(fn, arg)
    }
    return context
  }
  const { lines } = await logged(async captured => {
    assert.equal((await (await egress(post, email)).json()).status, 200)
    return { lines: captured }
  })
  assert.ok(lines.some(line => /resident-open ok \(1\/16 pages, front-end unknown\)$/.test(line)), lines.join('\n'))
  assert.equal((await health()).residentPages, 1)
})

test('a page is not handed to a call until its token has stopped changing', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, settleStableMs: 60, settlePollMs: 10 })
  const email = 'settling@example.invalid'
  withProfile(dataDir, email)
  // The page's token as a real one boots (24.11, prod): the old one, then
  // one for 30 days, then one for 15 minutes — within about a second.
  signer.script.pageToken = 'old'
  const started = Date.now()
  const changes = [[20, 'for-30-days'], [40, 'for-15-minutes']]
    .map(([ms, token]) => setTimeout(() => { signer.script.pageToken = token }, ms))
  t.after(() => { for (const timer of changes) clearTimeout(timer) })
  const sent = []
  signer.script.fetch = async (url, init) => {
    sent.push({ at: Date.now() - started, authorization: init.headers.authorization })
    return jsonResponse({ success: true })
  }

  const answer = await (await egress(post, email)).json()
  assert.equal(answer.status, 200)
  assert.equal(sent.length, 1)
  // The call went out on the token the page settled on, not before.
  assert.equal(sent[0].authorization, 'Bearer for-15-minutes')
  assert.ok(sent[0].at >= 40 + 60, `the call went out ${sent[0].at} ms after the page began to open`)
  // And what the renewal harvested is untouched by the wait: the first stable token, as before.
  assert.equal((await (await post('/renew', { email })).json()).token, 'token-renew-1')
})

test('a page that has just been reloaded is not handed to a call before its token has settled either', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // minCacheSeconds forces the live path on /renew.
  const { post, dataDir } = await start(t, { signer, minCacheSeconds: 7200, settleStableMs: 60, settlePollMs: 10 })
  const email = 'reloaded-settle@example.invalid'
  withProfile(dataDir, email)
  signer.script.pageToken = 'before'
  await (await egress(post, email)).json()
  let tokenChanges
  signer.script.renew = async () => {
    signer.script.pageToken = 'reloaded-1'
    tokenChanges = setTimeout(() => { signer.script.pageToken = 'reloaded-2' }, 30)
    return { token: 'token-renew-2', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
  }
  const sent = []
  signer.script.fetch = async (url, init) => {
    sent.push(init.headers.authorization)
    return jsonResponse({ success: true })
  }

  // A reload (what the app asks for on a refused session), then the app's retry.
  const since = Date.now()
  const renewed = await post('/renew', { email, force: true })
  assert.equal(renewed.status, 200)
  assert.ok(Date.now() - since >= 30 + 60, `/renew answered ${Date.now() - since} ms after it was asked: before the token settled`)
  clearTimeout(tokenChanges)
  assert.equal((await (await egress(post, email)).json()).status, 200)
  // The retry after the reload went out on the token the reloaded page settled on.
  assert.deepEqual(sent, ['Bearer reloaded-2'])
})

test('a page that cannot be asked, or does not answer, holds nothing up', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, settleStableMs: 60, settlePollMs: 10, settleTimeoutMs: 300 })
  const email = 'unasked-settle@example.invalid'
  withProfile(dataDir, email)

  // No token to read: not waited for.
  signer.script.pageToken = undefined
  const since = Date.now()
  assert.equal((await (await egress(post, email)).json()).status, 200)
  assert.ok(Date.now() - since < 250, `a page without a token took ${Date.now() - since} ms`)

  // A page that answers nothing at all: the wait ends with its budget (not
  // never), the call then meets the backstop, and the page is dropped as before.
  const hungSince = Date.now()
  signer.script.evaluate = () => new Promise(() => {})
  const hung = await post('/egress', { email, url: `${CHAT}/api/v2/chats/new`, method: 'POST', body: '{"x":1}', timeoutMs: 200 })
  assert.equal(hung.status, 504)
  // The backstop alone is timeoutMs + 5 s; the waits at the opening added no more than their 300 ms.
  assert.ok(Date.now() - hungSince < 200 + 5000 + 300 + 1500, `a page that answers nothing took ${Date.now() - hungSince} ms`)
})

test('a stalled upstream is aborted inside the page and the page stays usable', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'stall@example.invalid'
  withProfile(dataDir, email)
  signer.script.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(abortError()))
  })

  const stalled = await egress(post, email, { timeoutMs: 200 })
  assert.equal(stalled.status, 504)
  assert.equal((await stalled.json()).code, 'egress_timeout')
  // A slow upstream is not a broken page.
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)

  signer.script.fetch = async () => jsonResponse({ success: true })
  assert.equal((await (await egress(post, email)).json()).status, 200)
})

test('a browser-side network failure is a 502 and the page stays usable', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'offline@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()

  signer.script.fetch = async () => { throw new TypeError('Failed to fetch') }
  const failed = await egress(post, email)
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).code, 'egress_failed')
  assert.equal((await health()).residentPages, 1)

  signer.script.fetch = async () => jsonResponse({ success: true })
  assert.equal((await (await egress(post, email)).json()).status, 200)
})

test('an oversized upstream body is cut off instead of buffered', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, egressMaxBytes: 1024 })
  withProfile(dataDir, 'big@example.invalid')
  signer.script.fetch = async () => jsonResponse('x'.repeat(4096))

  const cut = await egress(post, 'big@example.invalid')
  assert.equal(cut.status, 502)
  assert.equal((await cut.json()).code, 'egress_too_large')
})

test('a page that stops responding is dropped, and the next call reopens it', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, backstopMs: 100 })
  const email = 'hung@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()

  // The page accepts the call and never answers: not even its own abort timer
  // comes back, so the Node-side backstop has to end it.
  signer.script.evaluate = () => new Promise(() => {})
  const hung = await egress(post, email, { timeoutMs: 200 })
  assert.equal(hung.status, 504)
  assert.equal((await hung.json()).code, 'egress_timeout')
  await until(() => signer.contexts[0].closed)
  assert.equal((await health()).residentPages, 0)

  signer.script.evaluate = null
  assert.equal((await (await egress(post, email)).json()).status, 200)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 2)
})

test('a crashed or closed page is dropped and reopened on the next call', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'crash@example.invalid'
  withProfile(dataDir, email)
  const opens = () => signer.calls.filter(call => call.op === 'open').length
  await (await egress(post, email)).json()

  // Renderer crash: Playwright reports it as an event while the context lives on.
  signer.contexts[0].page.emit('crash')
  assert.equal((await health()).residentPages, 0)
  await until(() => signer.contexts[0].closed)

  await (await egress(post, email)).json()
  assert.equal(opens(), 2)

  // The browser itself going away.
  signer.contexts[1].emit('close')
  assert.equal((await health()).residentPages, 0)

  await (await egress(post, email)).json()
  // The tab closing.
  signer.contexts[2].page.emit('close')
  assert.equal((await health()).residentPages, 0)

  await (await egress(post, email)).json()
  const live = signer.contexts[3]
  // A late event from a page that was already replaced takes nothing down.
  signer.contexts[0].page.emit('close')
  signer.contexts[1].emit('close')
  assert.equal((await health()).residentPages, 1)
  assert.equal(live.closed, false)

  // A call in flight when its page dies ends as page_closed, not as a hang.
  // (Of that page's evaluations, the calls are the ones given a request:
  // the call above, and the one in flight.)
  signer.script.fetch = () => new Promise(() => {})
  const inflight = egress(post, email, { timeoutMs: 60000 })
  await until(() => live.page.evaluations.filter(arg => arg?.url).length === 2)
  live.page.emit('crash')
  const failed = await inflight
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).code, 'page_closed')
})

test('MAX_RESIDENT_PAGES evicts the least recently used idle page', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, maxPages: 2 })
  for (const email of ['a@example.invalid', 'b@example.invalid', 'c@example.invalid']) withProfile(dataDir, email)
  const opens = () => signer.calls.filter(call => call.op === 'open').length

  await (await egress(post, 'a@example.invalid')).json()
  await (await egress(post, 'b@example.invalid')).json()
  // a is used again: b is now the least recently used.
  await new Promise(resolve => setTimeout(resolve, 5))
  await (await egress(post, 'a@example.invalid')).json()
  await (await egress(post, 'c@example.invalid')).json()

  assert.equal(opens(), 3)
  assert.equal(signer.contexts[1].closed, true) // b evicted
  assert.equal(signer.contexts[0].closed, false) // a survived: used more recently
  assert.equal((await health()).residentPages, 2)

  // b comes back on demand.
  assert.equal((await (await egress(post, 'b@example.invalid')).json()).status, 200)
  assert.equal(opens(), 4)
})

test('a busy page is never evicted: at the cap the new call fails fast instead', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, maxPages: 2 })
  for (const email of ['x@example.invalid', 'y@example.invalid', 'z@example.invalid']) withProfile(dataDir, email)

  // Two long calls hold both pages.
  const release = []
  signer.script.fetch = () => new Promise(resolve => { release.push(resolve) })
  const held = [egress(post, 'x@example.invalid', { timeoutMs: 60000 }), egress(post, 'y@example.invalid', { timeoutMs: 60000 })]
  await until(() => release.length === 2)

  // Nothing idle to evict: refuse the third call rather than kill a running one.
  const refused = await egress(post, 'z@example.invalid')
  assert.equal(refused.status, 503)
  assert.equal((await refused.json()).code, 'resident_capacity')
  assert.equal(signer.calls.filter(call => call.op === 'close').length, 0)

  for (const resolve of release) resolve(jsonResponse({ success: true }))
  assert.deepEqual((await Promise.all(held)).map(response => response.status), [200, 200])

  // Idle again: the least recently used page (x) makes room.
  signer.script.fetch = async () => jsonResponse({ success: true })
  assert.equal((await (await egress(post, 'z@example.invalid')).json()).status, 200)
  assert.equal(signer.contexts[0].closed, true)
  assert.equal(signer.contexts[1].closed, false)
})

test('calls on one page run concurrently; a renewal waits for them before reloading', async t => {
  const signer = fakeBrowser()
  const { post, dataDir, server } = await start(t, { signer, minCacheSeconds: 7200 })
  const email = 'busy@example.invalid'
  withProfile(dataDir, email)

  // minCacheSeconds forces the live path on /renew; record what the renewal
  // saw when it ran.
  let inflight = 0
  const seenAtRenew = []
  signer.script.renew = () => {
    seenAtRenew.push(inflight)
    return { token: `token-live-${seenAtRenew.length}`, exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
  }
  const release = []
  signer.script.fetch = () => {
    inflight++
    return new Promise(resolve => {
      release.push(() => { inflight--; resolve(jsonResponse({ success: true })) })
    })
  }

  // Both calls are inside the page at once: the account lock covers opening only.
  const held = [egress(post, email), egress(post, email)]
  await until(() => release.length === 2)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)

  // A renewal asked for while both calls are still held must park until they
  // land: a reload destroys their execution context.
  const asked = new Promise(resolve => { server.on('request', req => { if (req.url === '/renew') resolve() }) })
  const renewal = post('/renew', { email })
  await asked
  // Let it reach the page before letting the calls go, or the check is empty.
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const finish of release) finish()
  assert.deepEqual((await Promise.all(held)).map(response => response.status), [200, 200])

  // The renewal ran on the same page, after both calls had landed.
  const renewed = await (await renewal).json()
  assert.equal(renewed.token, 'token-live-2')
  assert.deepEqual(seenAtRenew, [0, 0])
  assert.equal(signer.calls.filter(call => call.op === 'renew').at(-1).page, signer.contexts[0].page)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
  assert.equal(signer.contexts[0].closed, false)
})

test('sign-in and renewal reuse the resident page instead of launching on the locked profile', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, minCacheSeconds: 7200 })
  const email = 'reuse@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()
  const context = signer.contexts[0]
  const opens = () => signer.calls.filter(call => call.op === 'open').length
  const closes = () => signer.calls.filter(call => call.op === 'close').length

  // A live renewal is a reload of the resident page.
  const renewed = await post('/renew', { email })
  assert.equal(renewed.status, 200)
  assert.match((await renewed.json()).token, /^token-renew-/)
  assert.equal(signer.calls.filter(call => call.op === 'renew').at(-1).page, context.page)
  assert.equal(opens(), 1)
  assert.equal(closes(), 0)

  // A full sign-in lands on the same page: one load of qwen.ai, not a
  // relaunch. (Without force the live session from the lazy open would
  // answer from the cache, and no sign-in would run at all.)
  const signedIn = await post('/session', { email, password: 'pw', force: true })
  assert.equal(signedIn.status, 200)
  assert.equal(signer.calls.find(call => call.op === 'signin').page, context.page)
  assert.equal(opens(), 1)
  assert.equal(closes(), 0)
  assert.equal((await health()).residentPages, 1)

  // A renewal that fails leaves the page in an unknown state: it is closed,
  // the profile stays, and the next call reopens from it.
  signer.script.renew = () => {
    const error = new Error('The persisted profile no longer authenticates.')
    error.code = 'session_expired'
    throw error
  }
  const dead = await post('/renew', { email })
  assert.equal(dead.status, 422)
  assert.equal((await dead.json()).code, 'session_expired')
  await until(() => context.closed)
  assert.equal((await health()).residentPages, 0)
})

test('an explicit invalidation (/renew with force) is answered live although the cache is fresh', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'forced@example.invalid'
  withProfile(dataDir, email)
  // The lazy open caches a session, the way a sign-in or any renewal does.
  await (await egress(post, email)).json()
  const renews = () => signer.calls.filter(call => call.op === 'renew').length
  assert.equal(renews(), 1)

  // Fresh cache: a plain /renew answers from it, as before.
  const cached = await (await post('/renew', { email })).json()
  assert.equal(cached.token, 'token-renew-1')
  assert.equal(renews(), 1)

  // The same request with force is a live reload. Answering it from the cache
  // is the no-op that replayed one refused jar for hours on prod (23.11).
  const forced = await post('/renew', { email, force: true })
  assert.equal(forced.status, 200)
  assert.equal((await forced.json()).token, 'token-renew-2')
  assert.equal(renews(), 2)
  // On the resident page: no second launch on the locked profile.
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
  assert.deepEqual(await health(), {
    ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16, headless: true, headlessMode: 'shell',
    // Reported where a flip is verified, as the headless mode is (Qwen2API-xun, Qwen2API-nch); the queue of page loads is off in these tests.
    pageTokenRefresh: true, streamWaitMs: 20000, loadMinIntervalMs: 1, loadMaxWaitMs: 120000,
    pageLoadQueue: { waiting: 0, nextInMs: 0 }
  })

  // Another explicit invalidation is another reload; an explicit false is a plain renew.
  assert.equal((await (await post('/renew', { email, force: true })).json()).token, 'token-renew-3')
  assert.equal((await (await post('/renew', { email, force: false })).json()).token, 'token-renew-3')
  assert.equal(renews(), 3)

  // Anything but a boolean is refused before the cache or a browser is touched.
  for (const force of ['yes', 1, {}, []]) {
    const refused = await post('/renew', { email, force })
    assert.equal(refused.status, 400, `${JSON.stringify(force)} must be refused`)
    assert.equal((await refused.json()).code, 'invalid_request')
  }
  assert.equal(renews(), 3)
  assert.equal((await (await post('/renew', { email })).json()).token, 'token-renew-3')
})

test('a forced reload that fails leaves nothing behind to hand the refused session out again', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'refused@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()
  signer.script.renew = () => {
    const error = new Error('The persisted profile no longer authenticates.')
    error.code = 'session_expired'
    throw error
  }

  const dead = await post('/renew', { email, force: true })
  assert.equal(dead.status, 422)
  assert.equal((await dead.json()).code, 'session_expired')
  // The refused entry is gone: a plain /renew no longer answers with the old
  // token — it has to go live, and fails the same way.
  const again = await post('/renew', { email })
  assert.equal(again.status, 422)
  assert.equal((await again.json()).code, 'session_expired')
  assert.equal((await health()).sessions, 0)
})

// Resolves once every request of this route has been read by the worker:
// whatever its handler is going to do, it is doing it by then.
const received = (server, route) => {
  let seen = 0
  server.on('request', req => { if (req.url === route) req.on('end', () => { seen++ }) })
  return () => seen
}

test('forced renewals that overlap share one reload', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir, server } = await start(t, { signer })
  const email = 'storm@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()

  // Hold every reload the way a real page load would.
  const releases = []
  signer.script.renew = () => new Promise(resolve => {
    releases.push(() => resolve({ token: 'token-live', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }))
  })
  const renewsReceived = received(server, '/renew')
  const asked = [
    post('/renew', { email, force: true }), post('/renew', { email, force: true }),
    post('/renew', { email }), post('/renew', { email, force: true })
  ]
  await until(() => renewsReceived() === 4)
  await until(() => releases.length === 1)
  // Keep letting reloads land until all four are answered: a regression that
  // starts a reload per request then fails on the count, not on a hang.
  const answers = await (async () => {
    for (;;) {
      for (const release of releases.splice(0)) release()
      const settled = await Promise.race([Promise.all(asked), new Promise(resolve => setTimeout(() => resolve(null), 20))])
      if (settled) return settled
    }
  })()
  assert.deepEqual(answers.map(response => response.status), [200, 200, 200, 200])
  assert.deepEqual((await Promise.all(answers.map(response => response.json()))).map(body => body.token),
    ['token-live', 'token-live', 'token-live', 'token-live'])
  // The lazy open, then ONE reload for all four: a burst of failures on one
  // account is not a burst of page loads.
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 2)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
})

test('a forced /renew joins the silent renewal the timer already started for the account', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir, server } = await start(t, { signer, minRenewDelayMs: 20, renewFraction: 0.5 })
  const email = 'warm@example.invalid'
  withProfile(dataDir, email)
  // The lazy open harvests a token that is about to expire: the silent timer
  // fires right behind it.
  let reloads = 0
  let release
  signer.script.renew = () => {
    reloads++
    if (reloads === 1) return { token: 'token-short', exp: Math.floor(Date.now() / 1000) + 1, cookies: [] }
    return new Promise(resolve => {
      release = () => resolve({ token: 'token-silent', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] })
    })
  }
  await (await egress(post, email)).json()
  await until(() => reloads === 2) // the timer's reload is running, held

  const renewsReceived = received(server, '/renew')
  const forced = post('/renew', { email, force: true })
  await until(() => renewsReceived() === 1)
  release()
  const answer = await forced
  assert.equal(answer.status, 200)
  assert.equal((await answer.json()).token, 'token-silent')
  assert.equal(reloads, 2, 'the forced /renew joined the silent reload: no second page load')
  assert.equal((await health()).residentPages, 1)
})

test('a dead session found on the lazy open surfaces as session_expired and leaves no page behind', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'dead@example.invalid'
  withProfile(dataDir, email)
  signer.script.renew = () => {
    const error = new Error('The persisted profile no longer authenticates.')
    error.code = 'session_expired'
    throw error
  }

  const dead = await egress(post, email)
  assert.equal(dead.status, 422)
  assert.equal((await dead.json()).code, 'session_expired')
  assert.equal((await health()).residentPages, 0)
  assert.equal(signer.contexts.length, 1)
  await until(() => signer.contexts[0].closed)
})

test('the resident page follows the account proxy', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'proxy@example.invalid'
  withProfile(dataDir, email)
  const opens = () => signer.calls.filter(call => call.op === 'open')

  // After a worker restart only the profile is left: no proxy is known.
  await (await egress(post, email)).json()
  assert.equal(opens().length, 1)
  assert.equal(opens()[0].proxy, null)

  // Another proxy means another browser: the page is relaunched through it
  // and the proxy is remembered for the calls that follow.
  const switched = await post('/egress', { email, url: '/api/v2/models', method: 'GET', proxy: 'http://q:9090' })
  assert.equal(switched.status, 200)
  assert.equal(opens().length, 2)
  assert.equal(opens()[1].proxy, 'http://q:9090')
  assert.equal(signer.contexts[0].closed, true)
  await (await egress(post, email)).json()
  assert.equal(opens().length, 2)

  // The proxy an account logged in with is what its lazy open uses.
  const other = 'proxied@example.invalid'
  withProfile(dataDir, other)
  const signedIn = await post('/session', { email: other, password: 'pw', proxy: 'http://p:8080' })
  assert.equal(signedIn.status, 200)
  assert.equal((await (await egress(post, other)).json()).status, 200)
  assert.equal(opens().at(-1).proxy, 'http://p:8080')
})

test('the keep-alive poll refreshes the cached jar from the live page', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, keepAliveMs: 20 })
  const email = 'warm@example.invalid'
  withProfile(dataDir, email)
  await (await egress(post, email)).json()
  const context = signer.contexts[0]
  const polls = () => signer.calls.filter(call => call.op === 'cookies').length
  assert.equal(polls(), 1) // the answer itself, so far

  // The browser rotates its cookies; nothing else happens on the page.
  context.jar = [{ name: 'ssxmod_itna', value: 'rotated', domain: 'chat.qwen.ai', path: '/' }]
  await until(() => polls() >= 3)
  // A cached /renew hands out what the browser holds now, not the old jar.
  const renewed = await (await post('/renew', { email })).json()
  assert.deepEqual(renewed.cookies.map(cookie => cookie.value), ['rotated'])
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
  assert.equal((await health()).residentPages, 1)

  // A context that stops answering the poll is dropped by it.
  context.cookies = async () => { throw new Error('Target closed') }
  await until(() => context.closed)
  assert.equal((await health()).residentPages, 0)
})

test('graceful shutdown closes every resident browser and fails an in-flight call as page_closed', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir, server } = await start(t, { signer, keepAliveMs: 20, shutdownMs: 300 })
  for (const email of ['s1@example.invalid', 's2@example.invalid']) {
    withProfile(dataDir, email)
    await (await egress(post, email)).json()
  }
  assert.equal((await health()).residentPages, 2)

  // A long call does not hold the stop hostage.
  const release = []
  signer.script.fetch = () => new Promise(resolve => { release.push(resolve) })
  const held = egress(post, 's1@example.invalid', { timeoutMs: 60000 })
  await until(() => release.length === 1)

  await server.workerShutdown()
  const failed = await held
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).code, 'page_closed')
  assert.deepEqual(signer.contexts.map(context => context.closed), [true, true])
  assert.equal((await health()).residentPages, 0)

  // No keep-alive poll outlives the pages it was polling.
  const polls = signer.calls.filter(call => call.op === 'cookies').length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(signer.calls.filter(call => call.op === 'cookies').length, polls)
  await server.workerShutdown() // idempotent
})

test('a new browser on a profile waits for the previous one to be fully closed', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, maxPages: 2, minCacheSeconds: 7200 })
  for (const email of ['x@example.invalid', 'y@example.invalid', 'z@example.invalid']) withProfile(dataDir, email)
  // Chromium takes a while to let go of the profile lock.
  signer.script.closeDelay = 150
  const ops = () => signer.calls
  const goneAt = context => ops().findIndex(call => call.op === 'closed' && call.context === context)
  const lastLaunchOn = dataDirOf => ops().findLastIndex(call => call.op === 'open' && call.dataDir === dataDirOf)

  await (await egress(post, 'x@example.invalid')).json()
  await (await egress(post, 'y@example.invalid')).json()
  const launches = () => ops().filter(call => call.op === 'open')
  const xProfile = launches()[0].dataDir
  const yProfile = launches()[1].dataDir

  // z's arrival evicts x (the least recently used) and x's browser is slow to go.
  const evicting = egress(post, 'z@example.invalid')
  await until(() => signer.contexts[0].closed)
  // A full sign-in for x inside that window must not launch onto the locked profile.
  const signedIn = post('/session', { email: 'x@example.invalid', password: 'pw' })
  assert.equal((await signedIn).status, 200)
  assert.equal((await evicting).status, 200)
  assert.ok(lastLaunchOn(xProfile) > goneAt(signer.contexts[0]))

  // Same when the page died on its own and the next call reopens it.
  const y = signer.contexts[1]
  y.page.emit('crash')
  assert.equal((await (await egress(post, 'y@example.invalid')).json()).status, 200)
  await until(() => goneAt(y) >= 0)
  assert.ok(lastLaunchOn(yProfile) > goneAt(y))
})

test('a keep-alive poll keeps the page but does not count as using it', async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-lru-'))
  const profileDir = email => path.join(dataDir, email)
  const residents = createResidents({ signer, profileDir, keepAliveMs: 20 })
  t.after(() => {
    residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  fs.mkdirSync(profileDir('warm@example.invalid'))
  const entry = await residents.acquire('warm@example.invalid')
  await residents.fetch(entry, { url: `${CHAT}/api/v2/models`, init: { method: 'GET', headers: {} }, timeoutMs: 5000 })
  const used = entry.lastUsed

  // Several polls later the page is still there, its LRU clock has not moved:
  // eviction must go by real traffic, or every page looks equally used.
  await until(() => signer.calls.filter(call => call.op === 'cookies').length >= 4)
  assert.equal(residents.stats().residentPages, 1)
  assert.equal(entry.lastUsed, used)
})

test('a page handed out for a call is not idle until that call has run', async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-claim-'))
  const profileDir = email => path.join(dataDir, email)
  const residents = createResidents({ signer, profileDir, maxPages: 1 })
  t.after(() => {
    residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  for (const email of ['a@example.invalid', 'b@example.invalid']) fs.mkdirSync(profileDir(email))
  const call = { url: `${CHAT}/api/v2/models`, init: { method: 'GET', headers: {} }, timeoutMs: 5000 }

  // Both ways a page is handed out: freshly opened, then reused.
  for (const handedOut of ['opened', 'reused']) {
    const page = await residents.acquire('a@example.invalid')
    // Handed out, call not started. Another account arriving at the cap in
    // that gap must be refused, not allowed to evict the page from under
    // the call.
    await new Promise(resolve => setTimeout(resolve, 5))
    await assert.rejects(residents.acquire('b@example.invalid'), { code: 'resident_capacity' })
    assert.equal(signer.contexts[0].closed, false, handedOut)
    // The call consumes the claim; the page is idle again.
    await residents.fetch(page, call)
  }

  // Idle: it can make room.
  await residents.acquire('b@example.invalid')
  assert.equal(signer.contexts[0].closed, true)
})

test('a stop that lands while a reopen waits for the old browser never lets the page come back', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir, server } = await start(t, { signer })
  const email = 'again@example.invalid'
  withProfile(dataDir, email)

  // The page crashes and its browser is slow to go: the reopen parks, waiting.
  signer.script.closeDelay = 400
  await (await egress(post, email)).json()
  signer.contexts[0].page.emit('crash')
  const asked = new Promise(resolve => { server.on('request', req => { if (req.url === '/egress') resolve() }) })
  const pending = egress(post, email)
  await asked
  await new Promise(resolve => setTimeout(resolve, 100))
  await server.workerShutdown()

  const refused = await pending
  assert.equal(refused.status, 502)
  assert.equal((await refused.json()).code, 'page_closed')
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
  await until(() => signer.calls.some(call => call.op === 'closed'))
  assert.equal((await health()).residentPages, 0)
})

test('a stop that lands while the browser is launching never lets the page come back', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir, server } = await start(t, { signer })
  const email = 'slow@example.invalid'
  withProfile(dataDir, email)

  // Hold the launch open the way a real Chromium start would.
  let launch
  const gate = new Promise(resolve => { launch = resolve })
  let opening = false
  const openContext = signer.openContext
  signer.openContext = async options => { opening = true; await gate; return openContext(options) }

  const pending = egress(post, email)
  await until(() => opening)
  await server.workerShutdown()
  launch()
  const refused = await pending
  assert.equal(refused.status, 502)
  assert.equal((await refused.json()).code, 'page_closed')
  await until(() => signer.contexts[0].closed)
  assert.equal((await health()).residentPages, 0)

  // Nothing opens after the stop either.
  const late = await egress(post, email)
  assert.equal(late.status, 502)
  assert.equal((await late.json()).code, 'page_closed')
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
})

test('a stop signal exits only after the resident browsers are closed; a second one does not wait', async t => {
  const signer = fakeBrowser()
  const { post, dataDir, server } = await start(t, { signer })
  for (const email of ['s1@example.invalid', 's2@example.invalid']) {
    withProfile(dataDir, email)
    await (await egress(post, email)).json()
  }
  // Chromium takes a moment to flush and exit.
  signer.script.closeDelay = 100
  const exits = []
  const stop = shutdownHandler(server, code => exits.push(code))

  stop('SIGTERM')
  assert.deepEqual(signer.contexts.map(context => context.closed), [true, true])
  assert.deepEqual(exits, []) // still closing
  stop('SIGTERM')
  assert.deepEqual(exits, [0]) // "now" means now
  await until(() => exits.length === 2)
  assert.deepEqual(exits, [0, 0])
  await until(() => signer.calls.filter(call => call.op === 'closed').length === 2)
})

// Since Qwen2API-xun (2026-11-26): the page's token, renewed in place. Read off
// the front end of 0.3.50 (NOTES Qwen2API-xun, "26.11, 09:45 UTC"): the Bearer of
// a call is the token the page keeps, an access token of fifteen minutes, which
// the page's own code trades for a new one — GET /api/v2/auths/refresh on the
// auth host, by XMLHttpRequest with the session's cookies and no Bearer — only
// for a request of its own, never on a timer. So a page only the worker talks to
// kept an expired token, and qwen.ai refused the first call after fifteen idle
// minutes for it (seen live, 2026-11-26), and the app's recovery reloaded the
// page. Here the worker makes the front end's call for the page instead. That
// qwen.ai takes it from the worker, and a call made on the token it brings, is
// to be verified live (the session of the rollout).

const AUTH_HOST = 'https://auth.qwen.ai'
const REFRESH_PATH = '/api/v2/auths/refresh'
const REFRESH = `${AUTH_HOST}${REFRESH_PATH}`
const RENEWED = 'renewed-access-token'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url')
// An access token in the shape qwen.ai issues one: a JWT, which says when it ends.
const accessTokenExpiringIn = seconds => `${b64url({ alg: 'HS256', type: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + seconds })}.signature`
const isRefresh = url => new URL(url).pathname === REFRESH_PATH

// What the front end keeps of its token once its refresh wrote it (main.js, IC):
// the state it reads first, and the two keys it falls back on.
const keptToken = ({ leftMs, token = 'page-access-token' }) => {
  const expiresAt = Date.now() + leftMs
  return {
    qwen_access_token_state: JSON.stringify({ version: 1, stateId: 'the-page', token, expiresAt, updatedAt: 0, sourceId: 'page' }),
    token,
    at_expire_time: String(expiresAt)
  }
}
// qwen.ai for these tests: the auth host answers the refresh, the chat host
// answers an ordinary call — each written down, with its time.
function qwenAi(script, refresh = () => jsonResponse({
  success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 }
})) {
  const asked = []
  script.fetch = (url, init) => {
    asked.push({ url, init, at: Date.now() })
    return isRefresh(url) ? refresh(init) : jsonResponse({ success: true })
  }
  return asked
}
const refreshesOf = asked => asked.filter(call => isRefresh(call.url))
const tokenReads = page => page.asked.filter(name => name === 'pageTokenState').length
const callOnce = async (post, email) => (await egress(post, email)).status

// What the refresh sends: the front end's own request (NOTES Qwen2API-xun, "the
// form of the refresh").
function assertRefresh(xhr, url = REFRESH, timeoutMs = 10000) {
  assert.equal(xhr.sent.url, url)
  assert.equal(xhr.sent.method, 'GET')
  assert.equal(xhr.sent.body, undefined)
  // Another origin than the page's: the session's cookies ride along only when asked for.
  assert.equal(xhr.withCredentials, true, 'the session’s cookies were not asked for')
  assert.equal(xhr.timeout, timeoutMs)
  // Listened to with addEventListener, as the page's hooks leave alone.
  assert.equal(xhr.handlerProperties, undefined)
  const sent = xhr.sent.headers
  // No Bearer: the front end's interceptor sets none for /auths/refresh. No
  // Content-Type: axios drops it from a request without a body. No origin: the
  // front end sets x-request-origin for everything but /auths/*.
  for (const name of ['authorization', 'content-type', 'cookie', 'x-request-origin']) {
    assert.equal(name in sent, false, `${name} was sent`)
  }
  assert.deepEqual({ ...sent, timezone: '<the page’s clock>', 'x-request-id': '<a uuid>' }, {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    source: 'web',
    version: '0.3.50',
    timezone: '<the page’s clock>',
    'x-request-id': '<a uuid>'
  })
  assert.match(sent.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
  assert.match(sent['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
}
const refreshXhrOf = (script, url = REFRESH) => script.xhrs.find(xhr => xhr.sent.url === url)
// What the refresh wrote: a token as the front end writes one.
function assertKept(storage, token) {
  const state = JSON.parse(storage.qwen_access_token_state)
  assert.equal(state.version, 1)
  assert.equal(state.token, token)
  assert.equal(state.sourceId, 'signin-worker')
  assert.equal(typeof state.stateId, 'string')
  assert.ok(state.expiresAt > Date.now() + 14 * 60 * 1000)
  assert.equal(storage.token, token)
  assert.equal(Number(storage.at_expire_time), state.expiresAt)
  assert.equal(Object.hasOwn(storage, 'qwen_token_logged_out_marker'), false)
}

test('Qwen2API-xun: a call on a page whose token is nearly spent renews the token first, by the front end’s own call — and no page is reloaded for it', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'idle@example.invalid'
  withProfile(dataDir, email)
  signer.script.frontEnd = '0.3.50'
  // Fourteen minutes since the page's token was written: a minute of it is left.
  signer.script.storage = keptToken({ leftMs: 60000 })
  const asked = qwenAi(signer.script)

  const { answer, lines } = await logged(async lines => {
    const response = await egress(post, email)
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.equal(answer.status, 200, lines.join('\n'))
  assert.deepEqual(JSON.parse(answer.body.body), { success: true })

  // Two requests left the page: the refresh, then the call.
  assert.deepEqual(asked.map(call => call.url), [REFRESH, `${CHAT}/api/v2/chats/new`])
  assertRefresh(refreshXhrOf(signer.script))
  assertKept(signer.script.storage, RENEWED)

  // The call went out after the refresh, on the renewed token...
  const [refresh, call] = asked
  assert.equal(call.init.headers.authorization, `Bearer ${RENEWED}`)
  assert.ok(call.at >= refresh.at)
  // ...and no page was loaded for it: the one load is the page's own opening.
  assert.equal(signer.calls.filter(entry => entry.op === 'renew').length, 1)
  assert.ok(lines.some(line => /token-refresh ok \(\d+ ms, 15 min left\)$/.test(line)), lines.join('\n'))
  assert.equal(lines.join('\n').includes(RENEWED), false, 'a token is not for the log')
  assert.equal((await health()).residentPages, 1)
})

test('Qwen2API-xun: what was read of the page’s token stands for a while — a fresh page is not asked again at once, a nearly spent one is renewed before the next call', async t => {
  const signer = fakeBrowser()
  // Long enough that two calls in a row fall inside it on a loaded machine, short enough to wait out.
  const { post, dataDir } = await start(t, { signer, tokenReadAgainMs: 1500 })
  const email = 'later@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 3600000 })
  const asked = qwenAi(signer.script)

  assert.equal(await callOnce(post, email), 200)
  const page = signer.contexts[0].page
  assert.equal(await callOnce(post, email), 200)
  // Read once, on the page's opening: the call after that did not ask the page again.
  assert.equal(tokenReads(page), 1)
  assert.equal(refreshesOf(asked).length, 0)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')

  // Time passes as far as the page's token is concerned: its last two minutes.
  await sleep(1700)
  signer.script.storage = keptToken({ leftMs: 120000 })
  assert.equal(await callOnce(post, email), 200)
  assert.equal(tokenReads(page), 2)
  assert.equal(refreshesOf(asked).length, 1)
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
  // And the call after that finds the reading of the renewed token still standing.
  assert.equal(await callOnce(post, email), 200)
  assert.equal(tokenReads(page), 2)
  assert.equal(refreshesOf(asked).length, 1)
})

test('Qwen2API-xun: a token with the front end’s own margin left is left alone', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'young@example.invalid'
  withProfile(dataDir, email)
  // Four minutes: more than the three the front end renews at.
  signer.script.storage = keptToken({ leftMs: 4 * 60 * 1000 })
  const asked = qwenAi(signer.script)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(refreshesOf(asked).length, 0)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')
})

test('Qwen2API-xun: a refresh qwen.ai refuses costs the call its time and nothing else', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, tokenRetryMs: 250 })
  const email = 'stubborn@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  const asked = qwenAi(signer.script, () => jsonResponse({
    success: false, data: { code: 'unauthorized', details: 'private-upstream-refusal-fixture' }
  }, 401))

  const { answer, lines } = await logged(async lines => {
    const response = await egress(post, email)
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  // The call went out all the same, on the token the page had: a refusal of it
  // is the app's recovery's to answer, with a reload.
  assert.equal(answer.status, 200, lines.join('\n'))
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')
  assert.equal(signer.script.storage.token, 'page-access-token')
  assert.equal(signer.calls.filter(entry => entry.op === 'renew').length, 1)
  const said = lines.filter(line => / token-refresh /.test(line))
  assert.equal(said.length, 1, lines.join('\n'))
  assert.match(said[0], /token-refresh failed \(refused, status 401, code unauthorized, \d+ ms\)$/)
  // What qwen.ai put in its refusal beyond the code is not for the worker's log.
  assert.equal(lines.join('\n').includes('private-upstream-refusal-fixture'), false)

  // Not tried again at once, whatever calls arrive...
  assert.equal(await callOnce(post, email), 200)
  assert.equal(refreshesOf(asked).length, 1)
  // ...and tried again once that while has passed.
  await sleep(300)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(refreshesOf(asked).length, 2)
})

test('Qwen2API-xun: a page that does not answer the refresh is said so, and the call goes out', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'torn@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  const asked = qwenAi(signer.script)
  // The document leaves from under the refresh, the way a navigation makes it.
  signer.script.evaluate = (fn, arg, inSandbox) => (fn.name === 'pageRefreshToken'
    ? Promise.reject(new Error('Execution context was destroyed.'))
    : inSandbox(fn, arg))

  const { status, lines } = await logged(async lines => ({ status: await callOnce(post, email), lines }))
  assert.equal(status, 200)
  assert.equal(refreshesOf(asked).length, 0)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')
  assert.ok(lines.some(line => /token-refresh failed \(the page did not answer, \d+ ms\)$/.test(line)), lines.join('\n'))
})

test('Qwen2API-xun: with the refresh off the page is not asked about its token at all', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer, pageTokenRefresh: false })
  const email = 'asbefore@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  const asked = qwenAi(signer.script)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(refreshesOf(asked).length, 0)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')
  assert.equal(signer.contexts[0].page.asked.includes('pageTokenState'), false)
  // Said where a flip is verified.
  assert.equal((await health()).pageTokenRefresh, false)
})

test('Qwen2API-xun: SIGNIN_PAGE_TOKEN_REFRESH=false turns the refresh off, and /health says so', async t => {
  const previous = process.env.SIGNIN_PAGE_TOKEN_REFRESH
  t.after(() => {
    if (previous === undefined) delete process.env.SIGNIN_PAGE_TOKEN_REFRESH
    else process.env.SIGNIN_PAGE_TOKEN_REFRESH = previous
  })
  const signer = fakeBrowser()
  delete process.env.SIGNIN_PAGE_TOKEN_REFRESH
  const on = await start(t, { signer })
  assert.equal((await on.health()).pageTokenRefresh, true)
  process.env.SIGNIN_PAGE_TOKEN_REFRESH = 'false'
  const off = await start(t, { signer })
  assert.equal((await off.health()).pageTokenRefresh, false)
})

test('Qwen2API-xun: a page that keeps no token, or one whose end cannot be read, is left to the app’s recovery', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, tokenReadAgainMs: 40 })
  const email = 'bare@example.invalid'
  withProfile(dataDir, email)
  const asked = qwenAi(signer.script)

  // No token at all: the call goes as the app made it, with no Bearer of its own.
  assert.equal(await callOnce(post, email), 200)
  assert.equal('authorization' in asked.at(-1).init.headers, false)
  assert.equal(refreshesOf(asked).length, 0)

  // A token that says nothing of its end, and nothing written beside it.
  signer.script.storage = {}
  signer.script.pageToken = 'opaque-token'
  await sleep(60)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer opaque-token')
  assert.equal(refreshesOf(asked).length, 0)

  // A JWT says its own end: nearly spent, it is renewed.
  signer.script.pageToken = accessTokenExpiringIn(60)
  await sleep(60)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(refreshesOf(asked).length, 1)
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
})

test('Qwen2API-xun: the refresh goes to the auth host the worker is told of, with no second slash whatever the host ends with', async t => {
  for (const authOrigin of ['https://auth.qwen.com', 'https://auth.qwen.com/', 'https://auth.qwen.com//']) {
    const signer = fakeBrowser()
    const { post, dataDir } = await start(t, { signer, authOrigin })
    const email = 'com@example.invalid'
    withProfile(dataDir, email)
    signer.script.storage = keptToken({ leftMs: 60000 })
    const asked = qwenAi(signer.script)
    assert.equal(await callOnce(post, email), 200, authOrigin)
    // However the host was written, the path follows it with one slash.
    assertRefresh(refreshXhrOf(signer.script, `https://auth.qwen.com${REFRESH_PATH}`), `https://auth.qwen.com${REFRESH_PATH}`)
    assert.equal(refreshesOf(asked).length, 1)
  }
})

test('Qwen2API-xun: the refreshes of the pages are kept apart', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, tokenRefreshMinIntervalMs: 300, tokenReadAgainMs: 40 })
  const emails = ['first@example.invalid', 'second@example.invalid']
  for (const email of emails) withProfile(dataDir, email)
  const asked = qwenAi(signer.script)
  // Both pages are open...
  for (const email of emails) assert.equal(await callOnce(post, email), 200)
  // ...and each keeps a token of its own, a minute from its end.
  const pages = signer.contexts.map(context => context.page)
  for (const page of pages) page.storage = keptToken({ leftMs: 60000 })
  await sleep(60)

  // Both are called at once.
  assert.deepEqual(await Promise.all(emails.map(email => callOnce(post, email))), [200, 200])
  const refreshes = refreshesOf(asked)
  assert.equal(refreshes.length, 2)
  const [first, second] = refreshes
  // Timers never fire early.
  assert.ok(second.at - first.at >= 300, `the second refresh followed the first by ${second.at - first.at} ms`)
  assert.equal(pages.every(page => page.storage.token === RENEWED), true)
})

// page.evaluate sends pageTokenState and pageRefreshToken by source: run them
// the same way, in a bare sandbox, to reach what the HTTP tests cannot stage.
// The guard turns a call that never settles into a failure here instead of a
// hung test runner. Its objects come from the sandbox's realm, so they are
// compared as plain data.
const inPageAsk = async (fn, script, arg) => {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the in-page call never settled')), 2000)
  })
  try {
    const run = vm.runInNewContext(`(${fn.toString()})`, { AbortController, setTimeout, clearTimeout, ...script, ...pageGlobals(script) })
    return JSON.parse(JSON.stringify(await Promise.race([run(arg), guard])))
  } finally {
    clearTimeout(timer)
  }
}

test('Qwen2API-xun: pageTokenState reads the token the way the front end does — the state, then the two keys, then the token itself — and hands back no token', async () => {
  const left = 120000
  const jwt = accessTokenExpiringIn(120)
  const jwtEnd = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000
  // What its refresh wrote (IC): all three, and the state is what is read.
  const written = Date.now() + left
  const state = await inPageAsk(pageTokenState, { storage: {
    qwen_access_token_state: JSON.stringify({ version: 1, stateId: 's', token: 'state-token', expiresAt: written, updatedAt: 0, sourceId: 'page' }),
    token: 'older-token', at_expire_time: '1'
  } })
  assert.equal(state.present, true)
  assert.equal(state.source, 'state')
  assert.equal(state.expiresAt, written)
  assert.ok(state.msLeft > 0 && state.msLeft <= left)
  assert.equal(JSON.stringify(state).includes('state-token'), false)
  assert.equal(JSON.stringify(state).includes('older-token'), false)

  // The two keys it wrote before it kept a state.
  const keys = await inPageAsk(pageTokenState, { storage: { token: 'keys-token', at_expire_time: String(Date.now() + left) } })
  assert.equal(keys.present, true)
  assert.equal(keys.source, 'keys')
  assert.ok(keys.msLeft > 0 && keys.msLeft <= left)

  // A state that does not say when its token ends is no state: the two keys decide.
  const blind = await inPageAsk(pageTokenState, { storage: {
    qwen_access_token_state: JSON.stringify({ version: 1, stateId: 's', token: 'opaque' }), token: 'opaque', at_expire_time: String(Date.now() + left)
  } })
  assert.equal(blind.source, 'keys')
  assert.ok(blind.msLeft > 0 && blind.msLeft <= left)

  // A token that is a JWT says its own end.
  const own = await inPageAsk(pageTokenState, { pageToken: jwt })
  assert.equal(own.present, true)
  assert.equal(own.source, 'jwt')
  assert.equal(own.expiresAt, jwtEnd)

  // One that is not, with nothing written beside it: its end cannot be read.
  assert.deepEqual(await inPageAsk(pageTokenState, { pageToken: 'opaque' }),
    { present: true, expiresAt: null, msLeft: null, source: 'jwt' })

  // A state that does not read is no state.
  const broken = await inPageAsk(pageTokenState, { storage: { qwen_access_token_state: '{not json', token: 'keys-token', at_expire_time: String(Date.now() + left) } })
  assert.equal(broken.source, 'keys')

  // No token at all.
  assert.deepEqual(await inPageAsk(pageTokenState, {}), { present: false, expiresAt: null, msLeft: null, source: 'none' })
})

test('Qwen2API-xun: pageRefreshToken is the front end’s own refresh — what it sends, and what it writes', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 900
  const script = {
    storage: { token: 'spent-token', at_expire_time: '1', qwen_token_logged_out_marker: 'x' },
    fetch: url => jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: expiresAt } })
  }
  const answer = await inPageAsk(pageRefreshToken, script, { url: REFRESH, timeoutMs: 4000, sourceId: 'signin-worker' })
  assert.equal(answer.ok, true)
  assert.equal(answer.status, 200)
  assert.equal(answer.expiresAt, expiresAt * 1000)
  assert.ok(answer.msLeft > 0 && answer.msLeft <= 900000)
  assert.equal(typeof answer.tookMs, 'number')
  // The token never leaves the page in the answer.
  assert.equal(JSON.stringify(answer).includes(RENEWED), false)
  assert.equal(script.xhrs.length, 1)
  assertRefresh(script.xhrs[0], REFRESH, 4000)
  assertKept(script.storage, RENEWED)
})

test('Qwen2API-xun: pageRefreshToken reads the end off the token when the answer names none, and assumes a quarter of an hour when it cannot', async () => {
  const jwt = accessTokenExpiringIn(600)
  const jwtEnd = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000
  const fromToken = await inPageAsk(pageRefreshToken, {
    storage: {}, fetch: () => jsonResponse({ success: true, data: { access_token: jwt } })
  }, { url: REFRESH, timeoutMs: 4000, sourceId: 'signin-worker' })
  assert.equal(fromToken.ok, true)
  assert.equal(fromToken.expiresAt, jwtEnd)

  // Neither says: fifteen minutes, as the front end assumes (parseTokenExpireTime).
  const assumed = await inPageAsk(pageRefreshToken, {
    storage: {}, fetch: () => jsonResponse({ success: true, data: { access_token: 'opaque' } })
  }, { url: REFRESH, timeoutMs: 4000, sourceId: 'signin-worker' })
  assert.equal(assumed.ok, true)
  assert.ok(Math.abs(assumed.expiresAt - (Date.now() + 900000)) < 2000)
})

test('Qwen2API-xun: a refresh qwen.ai refuses, or one that does not get through, leaves the page’s token as it was', async () => {
  const before = { token: 'spent-token', at_expire_time: '1', qwen_token_logged_out_marker: 'x' }
  const cases = [
    ['refused under a 200', () => jsonResponse({ success: false, data: { code: 'unauthorized', details: 'private-upstream-refusal-fixture' } }),
      { ok: false, status: 200, code: 'unauthorized', reason: 'refused', message: 'private-upstream-refusal-fixture' }],
    ['refused with a 401', () => jsonResponse({ success: false, code: 'invalid token' }, 401),
      { ok: false, status: 401, code: 'invalid token', reason: 'refused' }],
    ['a page, not data', () => jsonResponse('<!doctype html><title>Verification</title>'),
      { ok: false, status: 200, code: null, reason: 'refused' }],
    ['a token that is already spent', () => jsonResponse({ success: true, data: { access_token: 'late', expires_at: 1 } }),
      { ok: false, status: 200, code: null, reason: 'refused', message: 'the token is already spent' }],
    ['an answer with a token and no success', () => jsonResponse({ data: { access_token: 'not-issued', expires_at: Math.floor(Date.now() / 1000) + 900 } }),
      { ok: false, status: 200, code: null, reason: 'refused' }],
    ['success false, a token all the same', () => jsonResponse({ success: false, data: { access_token: 'not-issued' } }),
      { ok: false, status: 200, code: null, reason: 'refused' }],
    ['a token under a 500', () => jsonResponse({ success: true, data: { access_token: 'not-issued' } }, 500),
      { ok: false, status: 500, code: null, reason: 'refused' }],
    ['a dead connection', () => Promise.reject(new TypeError('Failed to fetch')),
      { ok: false, status: 0, code: null, reason: 'network_error' }]
  ]
  for (const [what, answer, expected] of cases) {
    const script = { storage: { ...before }, fetch: () => answer() }
    // How long it took is the one thing not compared.
    const result = await inPageAsk(pageRefreshToken, script, { url: REFRESH, timeoutMs: 4000, sourceId: 'signin-worker' })
    delete result.tookMs
    assert.deepEqual(result, expected, what)
    // Nothing was written, and the mark of a logged-out session is not the refresh's to remove.
    assert.deepEqual(script.storage, before, what)
  }
})

// Since Qwen2API-0c6 (2026-11-26): what the worker's line says of a whole answer
// beyond its status. qwen.ai refused chats/new in the body of a 200 twice in the
// hour of 2026-11-26, and the line read like an accepted call; on 2026-11-25 it
// answered a file call with 405, and whether the header that names a regional
// block was there could not be told afterwards.

test('Qwen2API-0c6: a refusal qwen.ai puts in the body of a 200 is said by its code on the worker’s line', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'refused@example.invalid'
  withProfile(dataDir, email)
  // The code where the app reads it: on the answer, and on its data.
  for (const body of [
    { success: false, code: 'unauthorized' },
    { success: false, data: { code: 'unauthorized', details: 'private-upstream-refusal-fixture' } }
  ]) {
    signer.script.fetch = () => jsonResponse(body)
    const { answer, lines } = await logged(async lines => {
      const response = await egress(post, email)
      return { answer: { status: response.status, body: await response.json() }, lines }
    })
    // The app gets qwen.ai's answer as it was, and classifies it itself...
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 200)
    assert.deepEqual(JSON.parse(answer.body.body), body)
    // ...and the log tells the refused call from an accepted one.
    assert.ok(lines.some(line => /egress \/api\/v2\/chats\/new -> 200 \(1\/16 pages\) — code unauthorized$/.test(line)),
      `${JSON.stringify(body)}:\n${lines.join('\n')}`)
    assert.equal(lines.join('\n').includes('private-upstream-refusal-fixture'), false)
  }
  // A refusal that names no code is told from an accepted call all the same.
  signer.script.fetch = () => jsonResponse({ success: false })
  const lines = await logged(async captured => {
    await (await egress(post, email)).json()
    return captured
  })
  assert.ok(lines.some(line => /egress \/api\/v2\/chats\/new -> 200 \(1\/16 pages\) — refused, no code$/.test(line)), lines.join('\n'))
})

test('Qwen2API-0c6: an answer that is no 2xx is said by its headers and the start of its body — and by nothing that could hold a credential', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'blocked@example.invalid'
  withProfile(dataDir, email)
  // What qwen.ai answered a file call with on 2026-11-25: 405, a page of error.
  const page = '<!doctype html><html><head><title>405</title></head><body>\n\t<p>Method Not Allowed</p></body></html>'
  signer.script.fetch = () => new Response(page, {
    status: 405,
    headers: {
      'content-type': 'text/html; charset=utf-8', server: 'Tengine', 'x-region-restriction': 'true',
      'set-cookie': 'secret_cookie=1', Authorization: 'Bearer secret_bearer', 'x-api-key': 'secret_key',
      'x-session-id': 'secret_session', 'x-token': 'secret_token', 'x-request-id': 'abc'
    }
  })
  const { answer, lines } = await logged(async lines => {
    const response = await egress(post, email)
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.status, 405)
  const line = lines.find(entry => /egress \/api\/v2\/chats\/new -> 405 /.test(entry))
  assert.ok(line, lines.join('\n'))
  // On one line, whatever the body had in it; the start of the body only.
  assert.ok(line.endsWith(' — headers: content-type=text/html; charset=utf-8, server=Tengine, x-region-restriction=true, x-request-id=abc; ' +
    'body: <!doctype html><html><head><title>405</title></head><body> <p>Method Not Allowed</p></body></html>'), line)
  for (const secret of ['secret_cookie', 'secret_bearer', 'secret_key', 'secret_session', 'secret_token', 'set-cookie']) {
    assert.equal(line.includes(secret), false, `${secret} reached the log`)
  }
  // The app still has the answer whole, headers included.
  assert.equal(answer.body.headers['x-region-restriction'], 'true')
  assert.equal(answer.body.headers['set-cookie'], 'secret_cookie=1')
})

test('Qwen2API-0c6: answerNote quotes a refusal and a failure, and nothing else', () => {
  // An accepted answer says nothing beyond its status...
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"success":true}' }), '')
  // ...nor does a body that is no refusal, or no JSON at all (a challenge page is named beside this, by the worker).
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"ret":[]}' }), '')
  assert.equal(answerNote({ status: 201, headers: {}, body: '[1,2]' }), '')
  // A code on an answer that is no refusal (an accepted call may carry one) is not quoted as one.
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"success":true,"code":"OK","data":{}}' }), '')
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"code":"0"}' }), '')
  assert.equal(answerNote({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html>' }), '')

  // A refusal in the body of a 2xx: its code, wherever the app reads it from.
  for (const [body, code] of [
    ['{"success":false,"code":"unauthorized"}', 'unauthorized'],
    ['{"success":false,"data":{"code":"unauthorized"}}', 'unauthorized'],
    ['{"success":false,"error":{"code":"invalid token"}}', 'invalid token'],
    ['{"success":false,"error":"forbidden"}', 'forbidden']
  ]) {
    const note = answerNote({ status: 200, headers: {}, body })
    assert.equal(note, ` — code ${code}`)
    assert.equal(answerNote({ status: 204, headers: {}, body }).replace(/ — code .+$/, ' — code <code>'), ' — code <code>')
  }
  // A punish envelope: what its lines say.
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::x"]}' }),
    ' — code FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x')
  // What only a refusal carries says it too, with success not in the answer at all.
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"error":{"code":"FAIL_SYS_USER_VALIDATE","details":"Unable to process your request"}}' }),
    ' — code FAIL_SYS_USER_VALIDATE')
  // A refusal that names no code is said to be one: it is no accepted call. One too long to be a refusal is not looked into.
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"success":false}' }), ' — refused, no code')
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"success":false,"message":"Something went wrong."}' }), ' — refused, no code')
  assert.equal(answerNote({ status: 200, headers: {}, body: `{"success":false,"code":"x","pad":"${'x'.repeat(256 * 1024)}"}` }), '')
  // What travels with a refusal is not quoted on a 2xx.
  assert.equal(answerNote({ status: 200, headers: { 'set-cookie': 'a=b' }, body: '{"success":false,"code":"quota","data":{"details":"private"}}' }), ' — code quota')

  // Not a 2xx: its code, the headers that could hold no credential, and the
  // start of its body on one line.
  assert.equal(answerNote({ status: 405, headers: {
    'content-type': 'text/html', 'Set-Cookie': 'a=b', AUTHORIZATION: 'Bearer x', 'x-api-key': 'k', 'x-session-id': 's', 'X-Token': 't', server: 'T'
  }, body: 'first\n\tline\r\nsecond' }), ' — headers: content-type=text/html, server=T; body: first line second')
  assert.equal(answerNote({ status: 405, headers: {}, body: '{"success":false,"code":"Method Not Allowed"}' }),
    ' — code Method Not Allowed; headers: none; body: {"success":false,"code":"Method Not Allowed"}')
  assert.equal(answerNote({ status: 502, headers: {}, body: '' }), ' — headers: none; body: ')
  // A code on an answer that is no 2xx is said, refusal or not.
  assert.equal(answerNote({ status: 500, headers: {}, body: '{"code":"internal_error","message":"x"}' }),
    ' — code internal_error; headers: none; body: {"code":"internal_error","message":"x"}')
  assert.equal(answerNote({ status: 403, headers: {}, body: '{"success":false}' }), ' — headers: none; body: {"success":false}')
  // Of a long body, the start only.
  const long = answerNote({ status: 500, headers: {}, body: 'y'.repeat(1000) })
  assert.equal(long, ` — headers: none; body: ${'y'.repeat(300)}`)
  // Of many headers, the first few; of a long value, the start.
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, at) => [`x-h${at}`, String(at)]))
  assert.equal(answerNote({ status: 503, headers: many, body: '' }), ` — headers: ${
    Array.from({ length: 12 }, (_, at) => `x-h${at}=${at}`).join(', ')}; body: `)
  // A credential inside a body is not quoted as itself.
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(10)}`
  const masked = answerNote({ status: 502, headers: {}, body: `Bearer abc.${jwt} and ${jwt} again` })
  assert.equal(masked, ' — headers: none; body: <credential> and <credential> again')
  // What is named a secret — a field of a JSON body, a pair of a form — loses
  // its value too, in a body and in a header, string or not, whatever its case;
  // a header so named is not quoted at all; what is not named one keeps it.
  const named = answerNote({ status: 502, headers: { 'x-signature': 'named_secret_header', 'x-auth': 'Bearer abc.def', 'x-trace': 'token=abc123&ok=1' },
    body: '{"AccessKeySecret":"named_secret_json","SecurityToken":"named_secret_token","access_token":"named_secret_access",' +
      '"refresh_token":"named_secret_refresh","api_key":"named_secret_key","session_id":123456789,"ok":"kept"}' +
      '&Signature=named_secret_signature&session=named_secret_session&token="two words"&plain=kept2' })
  assert.equal(named, ' — headers: x-auth=<credential>, x-trace=token=<credential>&ok=1; ' +
    'body: {"AccessKeySecret":"<credential>","SecurityToken":"<credential>","access_token":"<credential>","refresh_token":"<credential>",' +
    '"api_key":"<credential>","session_id":"<credential>","ok":"kept"}&Signature=<credential>&session=<credential>&token=<credential>&plain=kept2')
  assert.equal(answerNote({ status: 502, headers: {}, body: 'bearer v' }), ' — headers: none; body: <credential>')
  // A body made to be gone through again and again — a name that never ends, a JWT that never
  // ends, from every place either may start — is gone through once: it costs a moment, not the worker.
  const begun = Date.now()
  answerNote({ status: 500, headers: {}, body: `${'a.'.repeat(6 * 1024)}secret${'eyJ'.repeat(21 * 1024)}` })
  assert.ok(Date.now() - begun < 1000, `${Date.now() - begun} ms on a body made to be slow`)
  // Nothing that would break the line, or make it read backwards: separators and direction marks.
  const odd = answerNote({ status: 500, headers: { 'x-note': 'a\u2028b\u2029c\u0085d\u202e\u2066f' }, body: 'one\u2028two\u2029three\u202egfour' })
  assert.equal(odd, ' — headers: x-note=a b c d f; body: one two three gfour')
  assert.equal(answerNote({ status: 500, headers: { 'x-note': 'a\u200eb\u200fc\u061cd' }, body: '' }), ' — headers: x-note=a b c d; body: ')
  // The code itself, as a log line may show it: a number is one; one that is nothing but control
  // characters is no code; one with a separator in it is not cut at it; one that carries a
  // credential is masked like anything else.
  assert.equal(answerNote({ status: 200, headers: {}, body: '{"success":false,"code":401}' }), ' — code 401')
  assert.equal(answerNote({ status: 200, headers: {}, body: JSON.stringify({ success: false, code: '\u0001\u0002' }) }), ' — refused, no code')
  assert.equal(answerNote({ status: 200, headers: {}, body: JSON.stringify({ success: false, code: 'a; b' }) }), ' — code a; b')
  assert.equal(answerNote({ status: 200, headers: {}, body: JSON.stringify({ success: false, code: 'token=abc' }) }), ' — code token=<credential>')
})

test('Qwen2API-xun: a page is not idle while its token is renewed on a call — at the cap it is not evicted for another account', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, maxPages: 2, tokenReadAgainMs: 40 })
  for (const email of ['x@example.invalid', 'y@example.invalid', 'z@example.invalid']) withProfile(dataDir, email)
  // Both pages are open, each on a token of its own.
  for (const email of ['x@example.invalid', 'y@example.invalid']) assert.equal(await callOnce(post, email), 200)
  const [x, y] = signer.contexts.map(context => context.page)
  x.storage = keptToken({ leftMs: 60000 })
  y.storage = keptToken({ leftMs: 3600000 })
  await sleep(60)
  // The refresh of x's page takes a while...
  let release
  const refreshing = new Promise(resolve => { release = resolve })
  const asked = []
  signer.script.fetch = async (url, init) => {
    asked.push({ url, init, at: Date.now() })
    if (isRefresh(url)) await refreshing
    // ...and y's page is busy with a call of its own meanwhile.
    if (init.headers['x-request-id'] === 'y-hold') await refreshing
    return isRefresh(url)
      ? jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 } })
      : jsonResponse({ success: true })
  }
  const busy = egress(post, 'y@example.invalid', { headers: { 'content-type': 'application/json', 'x-request-id': 'y-hold' } })
  const renewed = egress(post, 'x@example.invalid', { headers: { 'content-type': 'application/json' } })
  await until(() => asked.some(call => isRefresh(call.url)))

  // z arrives at the cap: x's page is claimed for its call, y's is busy with one.
  const refused = await egress(post, 'z@example.invalid')
  assert.equal(refused.status, 503)
  assert.equal((await refused.json()).code, 'resident_capacity')

  release()
  assert.equal((await renewed).status, 200)
  assert.equal((await busy).status, 200)
  // x's call went out on the renewed token, on the page it started with.
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
  assert.equal(signer.contexts[0].closed, false, "x's page was evicted while its token was being renewed")
  assert.equal(signer.contexts.length, 2)
})

test('Qwen2API-xun: a page is claimed while its token is renewed as it opens — at the cap it is not evicted for another account', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, maxPages: 1 })
  for (const email of ['x@example.invalid', 'z@example.invalid']) withProfile(dataDir, email)
  // x's page opens on a token with a minute left, and the refresh takes a while.
  signer.script.storage = keptToken({ leftMs: 60000 })
  let release
  const refreshing = new Promise(resolve => { release = resolve })
  const asked = []
  signer.script.fetch = async (url, init) => {
    asked.push({ url, init, at: Date.now() })
    if (isRefresh(url)) await refreshing
    return isRefresh(url)
      ? jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 } })
      : jsonResponse({ success: true })
  }
  const opening = egress(post, 'x@example.invalid', { headers: { 'content-type': 'application/json' } })
  await until(() => asked.some(call => isRefresh(call.url)))

  // z arrives at the cap while x's page is up for its caller, its token being renewed.
  const refused = await egress(post, 'z@example.invalid')
  assert.equal(refused.status, 503)
  assert.equal((await refused.json()).code, 'resident_capacity')

  release()
  assert.equal((await opening).status, 200)
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
  assert.equal(signer.contexts[0].closed, false, "x's page was evicted while its token was being renewed")
  assert.equal(signer.contexts.length, 1)
})

test('Qwen2API-nch: a renewal on a resident page takes its turn in the queue, like the page’s own opening', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 200, minCacheSeconds: 7200 })
  const email = 'turn@example.invalid'
  withProfile(dataDir, email)
  // When the page was loaded: its opening, then its reload.
  const loads = []
  const renew = signer.renew
  signer.renew = async context => { loads.push(Date.now()); return renew(context) }
  assert.equal(await callOnce(post, email), 200)
  const askedAt = Date.now()
  assert.equal((await post('/renew', { email, force: true })).status, 200)
  assert.equal(loads.length, 2)
  // Timers never fire early: the reload waited for the worker's turn.
  assert.ok(loads[1] - loads[0] >= 200, `the reload came ${loads[1] - loads[0]} ms after the opening`)
  assert.ok(loads[1] >= askedAt)
})

test('Qwen2API-nch: two accounts opening their pages at once load them one after the other, and no browser is launched before its turn', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 150 })
  const emails = ['first@example.invalid', 'second@example.invalid']
  for (const email of emails) withProfile(dataDir, email)
  // When each browser was launched, and when each page was loaded.
  const launches = []
  const loads = []
  const open = signer.openContext
  signer.openContext = async options => { launches.push(Date.now()); return open(options) }
  const renew = signer.renew
  signer.renew = async context => { loads.push(Date.now()); return renew(context) }

  assert.deepEqual(await Promise.all(emails.map(email => callOnce(post, email))), [200, 200])
  assert.equal(loads.length, 2)
  // Timers never fire early.
  assert.ok(loads[1] - loads[0] >= 150, `the pages were loaded ${loads[1] - loads[0]} ms apart`)
  // The turn is waited for before the browser starts: a line of openings is not a line of browsers waiting.
  assert.ok(launches[1] - launches[0] >= 150, `the browsers were launched ${launches[1] - launches[0]} ms apart`)
})

test('Qwen2API-xun: what was read of the page’s token stands exactly as long as the token leaves the margin — no longer', async t => {
  const signer = fakeBrowser()
  // A reading may stand for five seconds; this token leaves the margin for three.
  const { post, dataDir } = await start(t, { signer, tokenReadAgainMs: 5000 })
  const email = 'edge@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 180000 + 3000, token: 'edge-token' })
  const asked = qwenAi(signer.script)

  assert.equal(await callOnce(post, email), 200)
  assert.equal(await callOnce(post, email), 200)
  // More than the margin is left: no refresh, and no second question to the page.
  assert.equal(refreshesOf(asked).length, 0)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer edge-token')
  const reads = tokenReads(signer.contexts[0].page)
  assert.equal(reads, 1)

  // The token has run into the margin since — sooner than a reading may stand: it is read again, and renewed.
  await sleep(3300)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(tokenReads(signer.contexts[0].page), reads + 1)
  assert.equal(refreshesOf(asked).length, 1)
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
})

test('Qwen2API-xun: a refresh the page reports as renewing to a token that is already spent is a failure, and the call goes out', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'late@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  const asked = qwenAi(signer.script)
  // The page answers the question, but not with a token that has time left.
  signer.script.evaluate = (fn, arg, inSandbox) => (fn.name === 'pageRefreshToken'
    ? Promise.resolve({ ok: true, status: 200, expiresAt: 1000, msLeft: 0, tookMs: 1 })
    : inSandbox(fn, arg))

  const { status, lines } = await logged(async lines => ({ status: await callOnce(post, email), lines }))
  assert.equal(status, 200)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')
  assert.equal(lines.some(line => / token-refresh ok /.test(line)), false, `a spent token was said to be a renewal:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => / token-refresh failed \(.+, \d+ ms\)$/.test(line)), lines.join('\n'))
})

test('Qwen2API-nch: a stop that lands while a page waits for its turn to open ends the call with page_closed, and no page is said to have died', async t => {
  const signer = fakeBrowser()
  // Another account's page took the worker's only turn for a long time.
  const { post, dataDir, server } = await start(t, { signer, loadMinIntervalMs: 60000 })
  const first = 'first@example.invalid'
  const email = 'waiting@example.invalid'
  withProfile(dataDir, first)
  withProfile(dataDir, email)
  assert.equal(await callOnce(post, first), 200)

  const waiting = callOnce(post, email)
  await sleep(80)
  const { status, lines } = await logged(async lines => {
    await server.workerShutdown()
    return { status: await waiting, lines }
  })
  assert.equal(status, 502)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1, 'a browser was launched for the waiting page')
  assert.equal(lines.some(line => /^resident-close (open_failed|operation_failed) /.test(line.replace(/^\S+ /, ''))), false,
    `a page was said to have died while the worker was stopping:\n${lines.join('\n')}`)
})

test('Qwen2API-xun: by default what was read of the page’s token stands a minute — a call soon after does not ask the page again', async t => {
  const signer = fakeBrowser()
  // No tokenReadAgainMs here: the default is what is measured.
  const { post, dataDir } = await start(t, { signer })
  const email = 'default@example.invalid'
  withProfile(dataDir, email)
  const asked = qwenAi(signer.script)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(await callOnce(post, email), 200)
  assert.equal(tokenReads(signer.contexts[0].page), 1)
  assert.equal(refreshesOf(asked).length, 0)
})

// What a reading of the first version of the three changes found (2026-11-26), and what two
// readings of the corrections found besides. A stand-in for the worker's queue, which a test
// holds: a page load that is to take a turn waits in it until let through; one that is not, does not.
function heldQueue() {
  const asked = []
  let held = null
  return {
    asked,
    async beforeLoad({ turn } = {}) {
      asked.push({ turn })
      if (turn !== false && held) await held
    },
    hold() {
      let release
      held = new Promise(resolve => { release = resolve })
      return { release: () => { held = null; release() } }
    }
  }
}

// A registry of resident pages on its own, without the worker's server around
// it: on a held queue, with what it says of its pages written down.
async function queuedResidents(t, options) {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-turn-'))
  const queue = heldQueue()
  const said = []
  const residents = createResidents({
    signer, profileDir: email => path.join(dataDir, email), beforeLoad: queue.beforeLoad, drainMs: 10,
    log: (event, extra) => said.push(`${new Date().toISOString()} ${event}${extra ? ' ' + extra : ''}`),
    ...options
  })
  t.after(() => {
    residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { signer, queue, residents, said, withProfile: email => fs.mkdirSync(path.join(dataDir, email)) }
}
// What was said of the pages, without the time of it.
const saidOfPages = lines => lines.filter(line => /^\S+ resident-(close|open) /.test(line)).map(line => line.replace(/^\S+ /, ''))
const diedWhileStopping = /^resident-close (open_failed|operation_failed) /

test('Qwen2API-nch: a page waiting for its turn to open counts against the cap meanwhile — an account arriving then finds the cap taken', { timeout: 10000 }, async t => {
  const { signer, queue, residents, withProfile } = await queuedResidents(t, { maxPages: 1 })
  withProfile('a@example.invalid')
  withProfile('b@example.invalid')
  // a's page is in line for the worker's turn: nothing is launched for it yet.
  const hold = queue.hold()
  const waiting = residents.acquire('a@example.invalid').then(() => 'opened', error => error.code)
  await until(() => queue.asked.length === 1)
  assert.deepEqual(queue.asked[0], { turn: true })
  assert.equal(signer.calls.length, 0)

  // b arrives at the cap: the one page there is is a's, claimed for the call that asked for it.
  await assert.rejects(residents.acquire('b@example.invalid'), { code: 'resident_capacity' })
  assert.equal(signer.calls.length, 0, 'a browser was launched while another page was in line for the only slot')

  hold.release()
  assert.equal(await waiting, 'opened')
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
})

test('Qwen2API-nch: a stop that lands while a page waits for its turn launches no browser for it, even though its wait then ends well — and no page is said to have died', { timeout: 10000 }, async t => {
  const { signer, queue, residents, said, withProfile } = await queuedResidents(t)
  withProfile('a@example.invalid')
  const hold = queue.hold()
  const opening = residents.acquire('a@example.invalid').then(() => 'opened', error => error.code)
  await until(() => queue.asked.length === 1)
  await residents.shutdown()
  hold.release()
  assert.equal(await opening, 'page_closed')
  assert.equal(signer.calls.length, 0, 'a browser was launched after the stop')
  assert.equal(said.some(line => diedWhileStopping.test(line)), false, said.join('\n'))
})

test('Qwen2API-nch: a page dropped while its renewal waited for the turn to load is not run on, and is said to have died once', { timeout: 10000 }, async t => {
  const { signer, queue, residents, said, withProfile } = await queuedResidents(t)
  withProfile('a@example.invalid')
  const entry = await residents.acquire('a@example.invalid')
  // The renewal waits for the turn...
  const hold = queue.hold()
  const ran = []
  const renewal = residents.exclusive(entry, async () => { ran.push(Date.now()); return 'renewed' })
  await until(() => queue.asked.length === 2)
  assert.deepEqual(queue.asked[1], { turn: true })
  // ...and the page dies while it does, as a crash takes it.
  const openingSaid = said.length
  signer.contexts[0].page.emit('crash')
  hold.release()
  await assert.rejects(renewal, { code: 'page_closed' })
  assert.equal(ran.length, 0, 'the renewal ran on a page that was gone')
  assert.deepEqual(saidOfPages(said.slice(openingSaid)), ['resident-close page_crashed (0 pages)'])
})

test('Qwen2API-nch: a page that is gone before its navigation would ask for a turn asks for none', { timeout: 10000 }, async t => {
  const { queue, residents, withProfile } = await queuedResidents(t)
  withProfile('a@example.invalid')
  const entry = await residents.acquire('a@example.invalid')
  // Closed for good before anything is asked of the queue — as it is for a change of proxy.
  await residents.close(entry, 'proxy_changed')
  await assert.rejects(residents.exclusive(entry, async () => 'renewed'), { code: 'page_closed' })
  assert.equal(queue.asked.length, 1, 'a turn was asked for a page that was already gone')
})

test('Qwen2API-nch: a sign-in on a resident page does not wait for the turn — nothing is waited for in the queue for it', { timeout: 10000 }, async t => {
  const { signer, queue, residents, withProfile } = await queuedResidents(t)
  withProfile('a@example.invalid')
  const entry = await residents.acquire('a@example.invalid')
  // The worker's turn is taken for a long time, and a renewal waits for it...
  const hold = queue.hold()
  const renewal = residents.exclusive(entry, async () => 'renewed')
  await until(() => queue.asked.length === 2)
  // ...but a sign-in does not: the login pacer is what spaces sign-ins, and the worker's
  // queue is told of it by the worker itself.
  const signIn = residents.exclusive(entry, async context => {
    await signer.signin(context, { email: 'a@example.invalid' })
    return 'signed in'
  }, { turn: false })
  assert.equal(await signIn, 'signed in')
  assert.deepEqual(queue.asked[2], { turn: false })
  hold.release()
  assert.equal(await renewal, 'renewed')
})

// A page opening on a token with a minute left, whose refresh is held until `release()`; `asked` is what was asked of qwen.ai.
async function heldRefresh(t, options) {
  const signer = fakeBrowser()
  const worker = await start(t, { signer, ...options })
  const email = 'held@example.invalid'
  withProfile(worker.dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  let release
  const refreshing = new Promise(resolve => { release = resolve })
  const asked = qwenAi(signer.script, async () => {
    await refreshing
    return jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 } })
  })
  return { ...worker, signer, email, asked, release }
}

test('Qwen2API-xun: a stop that lands while an opening page’s token is renewed ends the call with page_closed — no page said to have died, no refresh said at all', { timeout: 10000 }, async t => {
  const { post, email, asked, release, server } = await heldRefresh(t)
  const opening = egress(post, email)
  await until(() => asked.some(call => isRefresh(call.url)))
  const { status, lines } = await logged(async lines => {
    const stopped = server.workerShutdown()
    // The refresh is answered after all: the worker has stopped all the same.
    release()
    await stopped
    return { status: (await opening).status, lines }
  })
  assert.equal(status, 502)
  assert.equal(lines.some(line => diedWhileStopping.test(line.replace(/^\S+ /, ''))), false, lines.join('\n'))
  assert.equal(lines.some(line => / token-refresh /.test(line)), false, `a refresh was said while the worker was stopping:\n${lines.join('\n')}`)
})

test('Qwen2API-xun: a refresh the worker’s stop closes the page under is not said to have failed', { timeout: 10000 }, async t => {
  // The stop waits no time for the call, and closes the page under its refresh.
  const { post, email, asked, server } = await heldRefresh(t, { shutdownMs: 60 })
  const opening = egress(post, email)
  await until(() => asked.some(call => isRefresh(call.url)))
  const { status, lines } = await logged(async lines => {
    await server.workerShutdown()
    return { status: (await opening).status, lines }
  })
  assert.equal(status, 502)
  assert.equal(lines.some(line => diedWhileStopping.test(line.replace(/^\S+ /, ''))), false, lines.join('\n'))
  assert.equal(lines.some(line => / token-refresh /.test(line)), false, `a refresh was said while the worker was stopping:\n${lines.join('\n')}`)
})

test('Qwen2API-xun: a page that dies while its token is renewed as it opens is not handed out, and is said to have died once', { timeout: 10000 }, async t => {
  const { post, email, asked, release, signer } = await heldRefresh(t)
  const opening = egress(post, email)
  await until(() => asked.some(call => isRefresh(call.url)))
  const { answer, lines } = await logged(async lines => {
    signer.contexts[0].page.emit('crash')
    release()
    const response = await opening
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.equal(answer.status, 502)
  assert.equal(answer.body.code, 'page_closed')
  assert.equal(signer.contexts.length, 1)
  assert.deepEqual(saidOfPages(lines), ['resident-close page_crashed (0 pages)'])
  // The page's death is said by its close; the refresh that was under way is nobody's failure.
  assert.equal(lines.some(line => / token-refresh /.test(line)), false, `a refresh was said of a page that died under it:\n${lines.join('\n')}`)
})

test('Qwen2API-xun: a page that dies while its token is renewed for a call is not handed out either — the call opens the page anew', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // What was read of the page's token stands no time: the next call reads it again.
  const { post, dataDir } = await start(t, { signer, tokenReadAgainMs: 0 })
  const email = 'reopened@example.invalid'
  withProfile(dataDir, email)
  assert.equal(await callOnce(post, email), 200)
  // A nearly spent token since, and a refresh that takes a while.
  const page = signer.contexts[0].page
  page.storage = keptToken({ leftMs: 60000 })
  let release
  const refreshing = new Promise(resolve => { release = resolve })
  const asked = qwenAi(signer.script, async () => {
    await refreshing
    return jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 } })
  })
  const call = egress(post, email)
  await until(() => asked.some(entry => isRefresh(entry.url)))
  const { status, lines } = await logged(async lines => {
    page.emit('crash')
    // The page opened anew keeps a young token of its own.
    signer.script.storage = keptToken({ leftMs: 3600000, token: RENEWED })
    release()
    return { status: (await call).status, lines }
  })
  assert.equal(status, 200)
  assert.equal(signer.contexts.length, 2)
  assert.equal(signer.contexts[0].closed, true)
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
  // The page that died is said so once; the one opened for the call is said up, once.
  assert.deepEqual(saidOfPages(lines), ['resident-close page_crashed (0 pages)', 'resident-open ok (1/16 pages, front-end 0.3.50)'])
  assert.equal(lines.some(line => / token-refresh /.test(line)), false, `a refresh was said of a page that died under it:\n${lines.join('\n')}`)
})

test('Qwen2API-xun: a page that dies, or a worker that stops, while the front end of an opening page is read is neither said up nor handed out', { timeout: 10000 }, async t => {
  for (const how of ['dies', 'stops']) {
    const signer = fakeBrowser()
    const worker = await start(t, { signer })
    const email = `front-${how}@example.invalid`
    withProfile(worker.dataDir, email)
    // The front end is read for the line that says the page is up; the reading takes a while.
    let release
    const reading = new Promise(resolve => { release = resolve })
    let readings = 0
    signer.script.evaluate = (fn, arg, inSandbox) => (fn.name !== 'readFrontEndVersion'
      ? inSandbox(fn, arg)
      : (readings++, reading.then(() => inSandbox(fn, arg))))
    const opening = egress(worker.post, email)
    await until(() => readings === 1)
    const { status, lines } = await logged(async lines => {
      if (how === 'dies') signer.contexts[0].page.emit('crash')
      else await worker.server.workerShutdown()
      release()
      return { status: (await opening).status, lines }
    })
    assert.equal(status, 502, how)
    assert.equal(lines.some(line => /resident-open ok/.test(line)), false, `the page ${how}, and was said up:\n${lines.join('\n')}`)
  }
})

test('Qwen2API-xun: a refresh that does not get through keeps every page behind that proxy from trying its own for a while, and each call goes out all the same; a refusal keeps nobody', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // The circuit stands a second and a half: long enough for the next call to land inside it on a loaded machine.
  const { post, dataDir } = await start(t, { signer, tokenRefreshCircuitMs: 1500 })
  const [down, quiet, later] = ['down@example.invalid', 'quiet@example.invalid', 'later@example.invalid']
  for (const email of [down, quiet, later]) withProfile(dataDir, email)
  // Every page keeps a token with a minute left. The auth host does not answer...
  signer.script.storage = keptToken({ leftMs: 60000 })
  let unreachable = true
  const asked = qwenAi(signer.script, () => (unreachable
    ? Promise.reject(new TypeError('Failed to fetch'))
    : jsonResponse({ success: false, data: { code: 'unauthorized' } }, 401)))
  const first = await logged(async lines => {
    assert.equal(await callOnce(post, down), 200)
    return lines
  })
  assert.ok(first.some(line => / token-refresh failed \(network_error, \d+ ms\)$/.test(line)), first.join('\n'))

  // While it is down, no other page pays the wait for a try of its own: the
  // call goes out at once, on the token there is.
  const { status, lines } = await logged(async lines => ({ status: await callOnce(post, quiet), lines }))
  assert.equal(status, 200)
  assert.equal(signer.contexts[1].page.asked.includes('pageTokenState'), false, `the page was asked about its token:\n${lines.join('\n')}`)
  assert.equal(signer.contexts[1].page.asked.includes('pageRefreshToken'), false, `the page was asked to refresh:\n${lines.join('\n')}`)
  assert.equal(refreshesOf(asked).length, 1)
  assert.equal(asked.at(-1).init.headers.authorization, 'Bearer page-access-token')

  // The while over, a page tries again...
  await sleep(1600)
  unreachable = false
  const refused = await logged(async lines => {
    assert.equal(await callOnce(post, later), 200)
    return lines
  })
  assert.equal(refreshesOf(asked).length, 2)
  assert.ok(refused.some(line => / token-refresh failed \(refused, status 401, code unauthorized, \d+ ms\)$/.test(line)), refused.join('\n'))
  // ...and a refresh qwen.ai refuses is that page's own: it keeps nobody else from trying.
  assert.equal(await callOnce(post, quiet), 200)
  assert.equal(refreshesOf(asked).length, 3)
})

test('Qwen2API-xun: the circuit is the road’s — a page behind another proxy, or behind none, tries its own refresh all the same', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, tokenRefreshCircuitMs: 60000 })
  // Three roads: a proxy whose way to the auth host is dead, no proxy (that way is dead too), and a proxy whose way is not.
  const [onDead, onNone, onLive, onDeadAgain] = ['dead-road@example.invalid', 'no-road@example.invalid', 'live-road@example.invalid', 'dead-road-too@example.invalid']
  for (const email of [onDead, onNone, onLive, onDeadAgain]) withProfile(dataDir, email)
  // Every page keeps a token with a minute left.
  signer.script.storage = keptToken({ leftMs: 60000 })
  let refreshes = 0
  const asked = []
  signer.script.fetch = (url, init) => {
    asked.push({ url, init, at: Date.now() })
    if (!isRefresh(url)) return jsonResponse({ success: true })
    // The first two roads are dead; the third answers.
    return ++refreshes <= 2 ? Promise.reject(new TypeError('Failed to fetch'))
      : jsonResponse({ success: true, data: { access_token: RENEWED, expires_at: Math.floor(Date.now() / 1000) + 900 } })
  }
  const call = (email, proxy) => egress(post, email, { proxy })
  assert.equal((await call(onDead, 'http://dead-road.invalid:8080')).status, 200)
  assert.equal((await call(onNone)).status, 200)
  assert.equal((await call(onLive, 'http://live-road.invalid:8080')).status, 200)
  // Each of the three was asked on its own road — and the last one's token was renewed.
  assert.equal(refreshes, 3, 'a page was kept from its refresh by a dead road it is not on, or not asked on a dead one')
  assert.equal(asked.at(-1).init.headers.authorization, `Bearer ${RENEWED}`)
  // A second page on the first road is not asked: that road is known to be dead.
  assert.equal((await call(onDeadAgain, 'http://dead-road.invalid:8080')).status, 200)
  assert.equal(refreshes, 3, 'a page was asked on a road known to be dead')
  assert.equal(signer.contexts[3].page.asked.includes('pageRefreshToken'), false)
})

test('Qwen2API-nch: a sign-in on a resident page does not wait for the worker’s turn either — the login pacer is what spaces sign-ins', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 60000, minCacheSeconds: 7200 })
  const email = 'signed@example.invalid'
  withProfile(dataDir, email)
  // The page's own opening took the only turn there is for a long time.
  assert.equal(await callOnce(post, email), 200)
  const began = Date.now()
  const signedIn = await post('/session', { email, password: 'pw', force: true })
  assert.equal(signedIn.status, 200, JSON.stringify(await signedIn.json()))
  assert.ok(Date.now() - began < 5000, `the sign-in waited ${Date.now() - began} ms`)
  // On the resident page: no second launch on the locked profile.
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
  assert.equal(signer.calls.find(call => call.op === 'signin').page, signer.contexts[0].page)
})

test('Qwen2API-xun: the code of a refused refresh is cut to one line of at most 80 characters, whatever qwen.ai put in it', async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer })
  const email = 'wordy@example.invalid'
  withProfile(dataDir, email)
  signer.script.storage = keptToken({ leftMs: 60000 })
  // A code with a line break and a forged line of the worker's own log in it, and then some.
  qwenAi(signer.script, () => jsonResponse({
    success: false, data: { code: `unauthorized\r\n2026-11-26T00:00:00.000Z token-refresh ok (forged) ${'z'.repeat(200)}` }
  }, 401))
  const { status, lines } = await logged(async lines => ({ status: await callOnce(post, email), lines }))
  assert.equal(status, 200)
  // Control characters are spaces, and 80 characters are quoted at most: one line, saying one failure.
  const said = lines.filter(line => / token-refresh /.test(line))
  assert.equal(said.length, 1, lines.join('\n'))
  assert.match(said[0], / token-refresh failed \(refused, status 401, code unauthorized 2026-11-26T00:00:00\.000Z token-refresh ok \(forged\) z{16}, \d+ ms\)$/)
})

// Another account's page takes the turn, so this account's page — opened for a call — stands in
// line; a renewal of the account arrives behind it, on the account's lock.
async function renewalBehindOpening(t, body) {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 400 })
  withProfile(dataDir, 'first@example.invalid')
  assert.equal(await callOnce(post, 'first@example.invalid'), 200)
  const email = 'queued@example.invalid'
  withProfile(dataDir, email)
  const call = callOnce(post, email)
  await sleep(100)
  const renews = () => signer.calls.filter(entry => entry.op === 'renew').length
  const before = renews()
  const { answer, lines } = await logged(async lines => {
    const response = await post('/renew', { email, ...body })
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.equal(await call, 200)
  return { answer, lines, reloaded: renews() - before - 1 }
}

test('Qwen2API-nch: a renewal that stood behind its own page’s opening answers the session that opening settled — no turn and no reload of its own', { timeout: 10000 }, async t => {
  const { answer, lines, reloaded } = await renewalBehindOpening(t, {})
  assert.equal(answer.status, 200, lines.join('\n'))
  // The opening loaded the page once and settled its session; that is the session answered.
  assert.equal(reloaded, 0, 'a second page load for a session that was just settled')
  assert.equal(answer.body.token, 'token-renew-2')
  assert.ok(lines.some(line => / renew no reload \(/.test(line)), lines.join('\n'))
  assert.equal(lines.some(line => / renew ok /.test(line)), false, lines.join('\n'))
})

test('Qwen2API-nch: a forced renewal standing behind the same opening reloads all the same', { timeout: 10000 }, async t => {
  const { answer, lines, reloaded } = await renewalBehindOpening(t, { force: true })
  assert.equal(answer.status, 200, lines.join('\n'))
  assert.equal(reloaded, 1)
  assert.equal(answer.body.token, 'token-renew-3')
  assert.ok(lines.some(line => / renew ok \(forced\)/.test(line)), lines.join('\n'))
})

test('Qwen2API-nch: a forced renewal that joins one already standing behind the opening gets its reload too', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 400 })
  withProfile(dataDir, 'first@example.invalid')
  assert.equal(await callOnce(post, 'first@example.invalid'), 200)
  const email = 'joined@example.invalid'
  withProfile(dataDir, email)
  const call = callOnce(post, email)
  await sleep(100)
  const renews = () => signer.calls.filter(entry => entry.op === 'renew').length
  const before = renews()
  // A plain renewal stands behind the opening; then the application's recovery insists on a live one.
  const plain = post('/renew', { email })
  await sleep(50)
  const { answer, lines } = await logged(async lines => {
    const response = await post('/renew', { email, force: true })
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.equal((await plain).status, 200)
  assert.equal(await call, 200)
  // One reload for both, as always — and a reload it is, not the session the opening settled meanwhile.
  assert.equal(renews(), before + 2)
  assert.equal(answer.body.token, 'token-renew-3')
  assert.ok(lines.some(line => / renew ok \(/.test(line)), lines.join('\n'))
  assert.equal(lines.some(line => / renew no reload /.test(line)), false, lines.join('\n'))
})
