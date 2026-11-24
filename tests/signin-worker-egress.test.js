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
    STREAM_CHANNEL, STREAM_ABORTS
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
      const page = { ...emitter(), evaluations: [], pending: new Set(), bindings: {} }
      // What exposeFunction puts on the page: its streams report through it.
      page.exposeFunction = async (name, handler) => { page.bindings[name] = handler }
      page.evaluate = (fn, arg) => new Promise((resolve, reject) => {
        page.pending.add(reject)
        const run = script.evaluate || ((fn, arg) => {
          page.evaluations.push(arg)
          // Only what a page can see: no module scope leaks in.
          const sandbox = { AbortController, setTimeout, clearTimeout, Blob, ...page.bindings, ...pageGlobals(script, page) }
          return vm.runInNewContext(`(${fn.toString()})`, sandbox)(arg)
        })
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
    minRenewDelayMs: 60000, keepAliveMs: 60000, drainMs: 1000, backstopMs: 5000, frontEndMs: 100,
    // Login pacing is signin-worker-pacing.test.js's subject.
    minLoginIntervalMs: 1,
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
    ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16, headless: true, headlessMode: 'shell'
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
  // page notes every use.
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
  for (const script of [whole, streamed]) {
    assert.equal(script.xhrs.length, 1)
    assert.deepEqual(script.xhrs[0].handlerProperties, undefined, 'a handler property was assigned')
    assert.equal(script.xhrs[0].readyStateReads, undefined, 'readyState was read')
  }
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
  // (That page's evaluations: the front end's version at its opening, the
  // call above, and the one in flight.)
  signer.script.fetch = () => new Promise(() => {})
  const inflight = egress(post, email, { timeoutMs: 60000 })
  await until(() => live.page.evaluations.length === 3)
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
    ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16, headless: true, headlessMode: 'shell'
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
