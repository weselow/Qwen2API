const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { createServer, shutdownHandler } = require('../signin-worker/server')
const { createResidents } = require('../signin-worker/lib/resident-pages')
const { pageFetch, normalizeEgress } = require('../signin-worker/lib/egress-fetch')

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
// sandbox whose fetch is scripted, so the tests see exactly what the page
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
      emit(event) { for (const handler of handlers[event] || []) handler() }
    }
  }

  const signer = {
    calls, contexts, script,
    async openContext(options) {
      calls.push({ op: 'open', ...options })
      const page = { ...emitter(), evaluations: [], pending: new Set() }
      page.evaluate = (fn, arg) => new Promise((resolve, reject) => {
        page.pending.add(reject)
        const run = script.evaluate || ((fn, arg) => {
          page.evaluations.push(arg)
          // Only what a page can see: no module scope leaks in.
          const sandbox = { AbortController, setTimeout, clearTimeout, Blob, fetch: script.fetch }
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
    minRenewDelayMs: 60000, keepAliveMs: 60000, drainMs: 1000, backstopMs: 5000,
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

// page.evaluate serializes pageFetch by source: run it the same way, in a
// bare sandbox, to reach the outcomes the HTTP tests cannot stage. Its
// objects come from the sandbox's realm, so they are compared as plain data.
// The guard turns a fetch that never settles (a broken abort timer) into a
// failure here instead of a hung test runner.
const inPage = async (sandbox, arg) => {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the in-page fetch never settled')), 2000)
  })
  try {
    const run = vm.runInNewContext(`(${pageFetch.toString()})`,
      { AbortController, setTimeout, clearTimeout, Blob, ...sandbox })(arg)
    return JSON.parse(JSON.stringify(await Promise.race([run, guard])))
  } finally {
    clearTimeout(timer)
  }
}

test('egress opens a resident page on first use and runs the call as an in-page fetch', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'live@example.invalid'

  // No persisted profile: nothing to open a page on, and no browser launched.
  const missing = await egress(post, email)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'no_profile')
  assert.equal(signer.calls.length, 0)

  withProfile(dataDir, email)
  const fetched = []
  signer.script.fetch = async (url, init) => {
    fetched.push({ url, init })
    return jsonResponse({ success: true })
  }
  signer.script.cookies = [{ name: 'ssxmod_itna', value: 'rotated', domain: 'chat.qwen.ai', path: '/' }]

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
  // The live jar rides back with every answer (jar sync, Qwen2API-3ue.2).
  assert.deepEqual(result.cookies.map(cookie => cookie.name), ['ssxmod_itna'])

  // One browser, on the hashed profile directory, loaded once like a renewal.
  const opens = () => signer.calls.filter(call => call.op === 'open')
  assert.equal(opens().length, 1)
  assert.match(opens()[0].dataDir, /account-[0-9a-f]{32}$/)
  assert.equal(opens()[0].dataDir.includes(email), false)
  const [context] = signer.contexts
  assert.equal(signer.calls.find(call => call.op === 'renew').page, context.page)

  // What the page sent: the profile's own cookies, the app's headers minus Cookie.
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].url, `${CHAT}/api/v2/chats/new`)
  const init = fetched[0].init
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{"chatId":""}')
  assert.equal(init.credentials, 'include')
  assert.ok(init.signal instanceof AbortSignal)
  assert.deepEqual(init.headers, {
    'content-type': 'application/json', 'x-request-id': '6f1c9d2e', authorization: 'Bearer app-token'
  })

  // Second call reuses the page: no launch, no reload.
  await (await egress(post, email)).json()
  assert.equal(opens().length, 1)
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
  assert.equal(context.page.evaluations.length, 2)

  assert.deepEqual(await health(), { ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16 })

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
  assert.deepEqual(normalizeEgress({ url: '/x', method: 'post', headers: { 'X-A': '1' }, body: '' }, lab), {
    url: 'http://127.0.0.1:8080/x',
    init: { method: 'POST', headers: { 'x-a': '1' }, body: undefined },
    timeoutMs: 1000
  })
})

test('the in-page fetch maps its own outcomes: chunked body, empty body, network failure, timeout, oversize', async () => {
  const request = { url: `${CHAT}/api/v2/models`, init: { method: 'GET', headers: {} }, timeoutMs: 1000, maxBytes: 1024 }

  // The body is assembled across stream chunks, decoded as UTF-8.
  const stream = (pieces, onCancel = () => {}) => new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
      controller.close()
    },
    cancel: onCancel
  }), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  const split = await inPage({ fetch: async () => stream(['{"answer":"при', 'вет"}']) }, request)
  assert.deepEqual(split, {
    ok: true, status: 200, url: '', redirected: false,
    headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '{"answer":"привет"}'
  })

  // No body at all (HEAD, 204).
  assert.deepEqual(await inPage({
    fetch: async () => ({ status: 204, headers: new Headers(), body: null, url: '', redirected: false })
  }, request), { ok: true, status: 204, url: '', redirected: false, headers: {}, body: '' })

  // The browser's own failure: a dead connection, a blocked request.
  const failed = await inPage({ fetch: async () => { throw new TypeError('Failed to fetch') } }, request)
  assert.deepEqual(failed, { ok: false, error: 'network_error', message: 'Failed to fetch' })

  // A stalled upstream: the in-page timer aborts the fetch.
  const stalled = await inPage({
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()))
    })
  }, { ...request, timeoutMs: 20 })
  assert.deepEqual(stalled, { ok: false, error: 'timeout', message: 'The operation was aborted.' })

  // An abort that is not ours is not reported as a timeout.
  const hijacked = await inPage({ fetch: async () => { throw abortError() } }, request)
  assert.equal(hijacked.error, 'aborted')

  // Oversize is cut off while streaming, not buffered whole.
  let cancelled = false
  const oversize = await inPage({
    fetch: async () => stream(['x'.repeat(2048), 'x'.repeat(2048)], () => { cancelled = true })
  }, request)
  assert.deepEqual(oversize, { ok: false, error: 'too_large', status: 200 })
  assert.equal(cancelled, true)
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
  signer.script.fetch = () => new Promise(() => {})
  const inflight = egress(post, email, { timeoutMs: 60000 })
  await until(() => live.page.evaluations.length === 2)
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

  // A full sign-in lands on the same page: one load of qwen.ai, not a relaunch.
  const signedIn = await post('/session', { email, password: 'pw' })
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
