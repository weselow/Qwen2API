const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { createServer, relayWriter } = require('../signin-worker/server')
const { createResidents } = require('../signin-worker/lib/resident-pages')
const {
    pageCall, pageAbortStream, STREAM_CHANNEL, STREAM_ABORTS, ABORT_REASON, streamRefusal, isJsonAnswer, answerNote
} = require('../signin-worker/lib/egress-fetch')
// The log counter reads the lines the worker writes (Qwen2API-qic): a line of this file's own, through it.
const { summarize } = require('../tools/egress-log-watch')
const { pageGlobals, pageLocation, pageFetch, pageStorage, xmlHttpRequest, pageDocument } = require('./helpers/fake-xml-http-request')

// The streaming /egress (Qwen2API-3ue.3): qwen.ai's answer relayed to the app
// as it arrives, and the app's going away aborting the fetch inside the page.
// Since Qwen2API-3ue.9 that fetch is what the call is: the page makes it as
// its own front end makes its completions call. (Before, it was an
// XMLHttpRequest, which qwen.ai refused.) The whole-answer call is
// signin-worker-egress.test.js's subject, and is an XMLHttpRequest still.

const CHAT = 'https://chat.qwen.ai'
const COMPLETIONS = `${CHAT}/api/v2/chat/completions?chat_id=c1`
const AUTH = { authorization: 'Bearer secret' }

const profileHash = email => crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
// A persisted profile is what authorizes /renew and the lazy open.
const withProfile = (dataDir, email) => {
  fs.mkdirSync(path.join(dataDir, 'account-' + profileHash(email)), { recursive: true })
}
const cookie = (name, value) => ({ name, value, domain: 'chat.qwen.ai', path: '/', secure: true })

// Poll until the condition holds: fixed sleeps flake under CI load.
async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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

const jsonResponse = (payload, status = 200) =>
  new Response(typeof payload === 'string' ? payload : JSON.stringify(payload),
    { status, headers: { 'content-type': 'application/json' } })

// A fake "Playwright" in signin-worker-egress.test.js's mold, for streams:
// every evaluate of a page runs in ONE JavaScript realm — what one call
// leaves on globalThis the next one sees, as on a real page — the page
// carries the binding exposeFunction gave it, a renewal throws the page's
// running scripts out the way a navigation does, and its fetch and its
// XMLHttpRequest both answer from a scripted fetch
// (helpers/fake-xml-http-request.js), each telling the page's network of
// every answer. No Chromium anywhere near CI:
// tools/worker-egress-local-smoke.js runs this same worker on a real one.
function fakeBrowser() {
  const script = { fetch: () => jsonResponse({ success: true }), cookies: [], renew: null, evaluate: null, closeDelay: 0 }
  const calls = []
  const contexts = []
  const harvest = source => ({
    token: `token-${source}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    cookies: [cookie('cna', source)]
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
      const realm = vm.createContext({})
      // Read at call time: a test re-scripts fetch while the page lives.
      const define = (name, get) => Object.defineProperty(realm, name, { get, configurable: true })
      for (const [name, value] of Object.entries({ AbortController, setTimeout, clearTimeout, Blob, btoa, atob, crypto, TextEncoder, URL })) {
        define(name, () => value)
      }
      define('fetch', () => pageFetch(script, page))
      // What a page gives its requests (Qwen2API-3ue.5).
      define('XMLHttpRequest', () => xmlHttpRequest(script, page))
      define('document', () => pageDocument(script))
      define('location', () => pageLocation(script))
      define('navigator', () => ({ language: script.language || 'en-US' }))
      define('localStorage', () => pageStorage(script))
      page.realm = realm
      // What exposeFunction puts on a page: its streams report through it.
      page.exposeFunction = async (name, handler) => {
        page.bindings[name] = handler
        define(name, () => page.bindings[name])
      }
      page.evaluate = (fn, arg) => new Promise((resolve, reject) => {
        page.pending.add(reject)
        const run = script.evaluate || ((fn, arg) => {
          page.evaluations.push({ fn: fn.name, arg })
          return vm.runInContext(`(${fn.toString()})`, realm)(arg)
        })
        Promise.resolve().then(() => run(fn, arg)).then(resolve, reject)
          .finally(() => { page.pending.delete(reject) })
      })
      // What a navigation does to scripts still running in the page.
      page.navigate = () => {
        for (const reject of page.pending) reject(new Error('Execution context was destroyed.'))
        page.pending.clear()
      }
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
      context.pages()[0].navigate()
      return harvest(`signin-${email}`)
    },
    async renew(context) {
      calls.push({ op: 'renew', page: context.pages()[0] })
      // A reload replaces the document, and every script that was in it.
      context.pages()[0].navigate()
      if (script.renew) return script.renew()
      return harvest('renew')
    }
  }
  return signer
}

// A scripted qwen.ai whose answer the test feeds by hand: body chunks when
// the test says so, and an abort of the fetch's signal that errors the body
// the way the browser would.
function feedable() {
  const upstream = {
    url: null, init: null, status: 200,
    headers: { 'content-type': 'text/event-stream' }, cancelled: false
  }
  let body = null
  upstream.opened = new Promise(resolve => { upstream.markOpened = resolve })
  upstream.aborted = new Promise(resolve => { upstream.markAborted = resolve })
  upstream.fetch = (url, init) => {
    upstream.url = url
    upstream.init = init
    return Promise.resolve(new Response(new ReadableStream({
      start(stream) {
        body = stream
        init.signal.addEventListener('abort', () => {
          try { stream.error(init.signal.reason) } catch { /* the body was already over */ }
          upstream.markAborted(init.signal.reason)
        }, { once: true })
        upstream.markOpened()
      },
      cancel() { upstream.cancelled = true }
    }), { status: upstream.status, headers: upstream.headers }))
  }
  upstream.push = text => body.enqueue(new TextEncoder().encode(text))
  upstream.pushBytes = bytes => body.enqueue(new Uint8Array(bytes))
  upstream.finish = () => body.close()
  upstream.fail = error => body.error(error)
  return upstream
}

// Every relay a test opens, so that none outlives it: an open one would
// hold the server's connection and its teardown with it.
const relays = []

async function start(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-'))
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
  const post = (pathName, payload, signal) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(payload), signal
  })
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json()
  const streamCall = {
    url: COMPLETIONS, method: 'POST', stream: true,
    headers: { 'content-type': 'application/json', authorization: 'Bearer app-token' },
    body: '{"stream":true}', timeoutMs: 5000
  }
  // The app's side of a streaming /egress: its events, one next() at a time.
  const relay = async (email, extra = {}) => {
    const controller = new AbortController()
    const close = () => controller.abort()
    relays.push(close)
    const response = await post('/egress', { email, ...streamCall, ...extra }, controller.signal)
    const reader = response.body.getReader()
    let pending = ''
    const next = async () => {
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (line) return JSON.parse(line)
          continue
        }
        const { value, done } = await reader.read()
        if (done) return { type: 'eof' }
        pending += Buffer.from(value).toString('utf8')
      }
    }
    return { response, next, close }
  }
  // ... and of a stream that is under way, past its head and first chunk.
  const streaming = async (email, extra) => {
    const opened = await relay(email, extra)
    assert.equal((await opened.next()).type, 'head')
    return opened
  }
  t.after(async () => {
    for (const close of relays.splice(0)) close()
    await server.workerShutdown()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { post, health, relay, streaming, streamCall, dataDir, server }
}

// What a relay said, start to finish.
const readAll = async opened => {
  const events = []
  for (;;) {
    const event = await opened.next()
    if (event.type === 'eof') return events
    events.push(event)
  }
}
const bytesOf = event => Buffer.from(event.data, 'base64')
const text = event => bytesOf(event).toString('utf8')
const kinds = events => events.map(event => event.type === 'chunk' ? text(event) : event.type)

// A clock the test turns by hand, for what runs inside the page: no sleeps,
// so no load to flake on. Timers fire in the order they come due.
function manualClock() {
  let now = 0
  const timers = new Set()
  return {
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms }
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.delete(due)
        now = due.at
        due.fn()
        // Let the page's loop run up to its next wait.
        await new Promise(resolve => setImmediate(resolve))
      }
      now = end
    }
  }
}

// page.evaluate serializes the in-page functions by source: run them the
// same way, in a bare realm, to reach what the HTTP tests cannot stage. The
// guard turns a stream that never settles (a broken abort) into a failure
// here instead of a hung test runner. `script` is what the page's requests
// answer from (its fetch, the channel, a clock), and its `fetches` are the
// requests the run made.
const pageRealm = script => vm.createContext({ AbortController, setTimeout, clearTimeout, btoa, ...script, ...pageGlobals(script) })
const runIn = (realm, fn) => vm.runInContext(`(${fn.toString()})`, realm)
const plain = async promise => JSON.parse(JSON.stringify(await promise))
const inPage = async (script, arg) => {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the in-page stream never settled')), 2000)
  })
  try {
    return await plain(Promise.race([runIn(pageRealm(script), pageCall)(arg), guard]))
  } finally {
    clearTimeout(timer)
  }
}
// The same, on a page of the test's own — for a call the test has to reach
// into while it runs, to abort it from Node's side or to turn the page's
// clock, or before the request is out.
const running = (page, arg) => {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the in-page stream never settled')), 2000)
  })
  return plain(Promise.race([runIn(page, pageCall)(arg), guard])).finally(() => clearTimeout(timer))
}
const PAGE = (extra = {}) => ({
  url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 1000, maxBytes: 1024,
  channel: STREAM_CHANNEL, registry: STREAM_ABORTS, id: 7, reasons: ABORT_REASON, ...extra
})
// What the browser does to a body whose fetch was aborted: it errors with the
// abort reason. Every scripted body here answers to the signal that way.
const erroredOnAbort = (init, stream) => init.signal.addEventListener('abort', () => {
  try { stream.error(init.signal.reason) } catch { /* the body was already over */ }
}, { once: true })
const encoder = new TextEncoder()
// A body that hands out `pieces` and ends; with `keep`, one that stays open.
const answering = (init, pieces = [], { status = 200, keep = false, onCancel } = {}) =>
  new Response(new ReadableStream({
    start(controller) {
      erroredOnAbort(init, controller)
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      if (!keep) controller.close()
    },
    cancel: onCancel
  }), { status, headers: { 'content-type': 'text/event-stream' } })
// The channel as a plain page has it: it notes every report and answers as told.
function channel(answer = () => undefined) {
  const reports = []
  return { reports, call: (id, event) => { reports.push({ id, event }); return answer(event, reports.length) } }
}

/* ------------------------------------------------------------- inside the page -- */

const CHALLENGE_PAGE = '<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="x"> <script> /* v2.0.1 */ </script>'

test('the in-page stream reports the head and every chunk as they come, each under its own id', async () => {
  const binding = channel()
  assert.deepEqual(await inPage({
    [STREAM_CHANNEL]: binding.call, fetch: async (url, init) => answering(init, ['data: {"a":"при",', '"b":1}\n\n', 'data: [DONE]\n\n'])
  }, PAGE({ maxBytes: 4096 })), { ok: true })
  assert.deepEqual(binding.reports.map(report => report.id), [7, 7, 7, 7])
  const [head, ...chunks] = binding.reports.map(report => report.event)
  // The head goes out before a byte of the body was read. (Its objects come
  // from the page's realm: compared as plain data.)
  assert.deepEqual(JSON.parse(JSON.stringify(head)), {
    type: 'head', status: 200, url: COMPLETIONS, redirected: false, headers: { 'content-type': 'text/event-stream' }
  })
  assert.deepEqual(chunks.map(event => Buffer.from(event.data, 'base64').toString('utf8')),
    ['data: {"a":"при",', '"b":1}\n\n', 'data: [DONE]\n\n'])
})

test('the page reports in order, one at a time: a report the app has not taken holds the next', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  // The second report — the first chunk — is taken slowly.
  const binding = channel((event, at) => (at === 2 ? gate : undefined))
  const script = {
    [STREAM_CHANNEL]: binding.call,
    // All of the body is in at once. What holds the reports up is the app.
    fetch: async (url, init) => answering(init, ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n'])
  }
  const running = plain(runIn(pageRealm(script), pageCall)(PAGE()))
  await until(() => binding.reports.length === 2)
  // The first chunk is reported and not acknowledged: no report goes out over it.
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(binding.reports.map(report => report.event.type), ['head', 'chunk'])
  release()
  assert.deepEqual(await running, { ok: true })
  assert.deepEqual(binding.reports.map(report => report.event.type), ['head', 'chunk', 'chunk', 'chunk'])
  assert.deepEqual(binding.reports.slice(1).map(report => Buffer.from(report.event.data, 'base64').toString('utf8')),
    ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n'])
})

test('an answer that is a page goes out whole, once it is in: the head, then the page as one piece', async () => {
  const binding = channel()
  const script = {
    [STREAM_CHANNEL]: binding.call,
    fetch: async (url, init) => new Response(new ReadableStream({
      start(controller) {
        // The page in two pieces, as it arrived.
        const bytes = encoder.encode(CHALLENGE_PAGE)
        controller.enqueue(bytes.subarray(0, 40))
        controller.enqueue(bytes.subarray(40))
        controller.close()
      }
    }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  assert.deepEqual(await inPage(script, PAGE()), { ok: true })
  assert.deepEqual(binding.reports.map(report => report.event.type), ['head', 'chunk'])
  const [head, page] = binding.reports.map(report => report.event)
  assert.equal(head.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), CHALLENGE_PAGE)
})

test('the page cuts a stream at timeoutMs of qwen.ai’s silence: every chunk re-arms the timer, the app’s turn does not count', async () => {
  const clock = manualClock()
  let body
  let given
  let take
  // The app takes the second chunk slowly.
  const held = new Promise(resolve => { take = resolve })
  const binding = channel((event, at) => (at === 3 ? held : undefined))
  const realm = pageRealm({
    [STREAM_CHANNEL]: binding.call, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: (url, init) => {
      given = init
      return Promise.resolve(new Response(new ReadableStream({
        start(stream) {
          body = stream
          erroredOnAbort(init, stream)
        }
      }), { headers: { 'content-type': 'text/event-stream' } }))
    }
  })
  const running = plain(runIn(realm, pageCall)(PAGE({ timeoutMs: 100 })))
  await until(() => body && binding.reports.length === 1) // the head
  const feed = async n => {
    body.enqueue(encoder.encode(`data: {"n":${n}}\n\n`))
    await until(() => binding.reports.length === n + 1)
  }
  await feed(1)
  await clock.advance(90) // not silent for long enough
  assert.equal(given.signal.aborted, false)
  // The second chunk is reported and not taken: the page is on the app's
  // turn, however long that takes — it is not qwen.ai being silent.
  await feed(2)
  await clock.advance(1000)
  assert.equal(given.signal.aborted, false, 'the app being behind was taken for qwen.ai falling silent')
  take()
  await clock.advance(90) // 180 ms of qwen.ai's silence into a call with a 100 ms budget
  assert.equal(given.signal.aborted, false, 'the stream was cut by a timer that counted the whole call')
  await feed(3)
  await clock.advance(99)
  assert.equal(given.signal.aborted, false)
  await clock.advance(2)
  assert.equal(given.signal.aborted, true, 'the request was aborted inside the page')
  assert.deepEqual(await running, { ok: false, error: 'timeout' })
  assert.deepEqual(binding.reports.map(report => report.event.type), ['head', 'chunk', 'chunk', 'chunk'])
})

test('an abort from outside the page is the app going away: reported as aborted, never as a timeout', async () => {
  let given
  const binding = channel()
  const realm = pageRealm({
    [STREAM_CHANNEL]: binding.call,
    // A body that started and now hangs: only an abort can end it.
    fetch: (url, init) => {
      given = init
      return Promise.resolve(answering(init, ['data: x\n\n'], { keep: true }))
    }
  })
  const running = plain(runIn(realm, pageCall)(PAGE({ timeoutMs: 1000 })))
  await until(() => binding.reports.length >= 1) // the head: the request is live
  // What Node runs in the page when the app closes its connection.
  assert.equal(runIn(realm, pageAbortStream)({ registry: STREAM_ABORTS, id: 7, reason: ABORT_REASON.cancelled }), true)
  assert.deepEqual(await running, { ok: false, error: 'aborted' })
  // The request itself was aborted, as the browser reports the signal of it.
  assert.equal(given.signal.aborted, true)
})

test('an abort reaches a report nobody acknowledged: the page does not wait on a stream that is over', async () => {
  // Every report is taken and never answered: the page is parked on the head.
  const binding = channel(() => new Promise(() => {}))
  const realm = pageRealm({
    [STREAM_CHANNEL]: binding.call, fetch: async (url, init) => answering(init, ['data: x\n\n'], { keep: true })
  })
  const running = plain(runIn(realm, pageCall)(PAGE()))
  await until(() => binding.reports.length === 1)
  assert.equal(runIn(realm, pageAbortStream)({ registry: STREAM_ABORTS, id: 7, reason: ABORT_REASON.cancelled }), true)
  assert.deepEqual(await running, { ok: false, error: 'aborted' })
})

test('the page forgets a stream once it is over: a late abort finds nothing', async () => {
  const binding = channel()
  const realm = pageRealm({
    [STREAM_CHANNEL]: binding.call, fetch: async (url, init) => answering(init, ['data: x\n\n'])
  })
  assert.deepEqual(await plain(runIn(realm, pageCall)(PAGE())), { ok: true })
  assert.equal(runIn(realm, pageAbortStream)({ registry: STREAM_ABORTS, id: 7, reason: ABORT_REASON.cancelled }), false)
  // And it left nothing behind on the page.
  assert.equal(vm.runInContext(`Object.keys(globalThis[${JSON.stringify(STREAM_ABORTS)}]).length`, realm), 0)
})

test('the in-page stream maps its own failures: no body, a dead network, an oversized body', async () => {
  // No body at all (204, HEAD).
  assert.deepEqual(await inPage({
    [STREAM_CHANNEL]: channel().call, fetch: async () => ({ status: 204, headers: new Headers(), body: null })
  }, PAGE()), { ok: true })
  // The browser's own failure: a dead connection, a blocked request. What a
  // fetch says of it, as it says it.
  assert.deepEqual(await inPage({
    [STREAM_CHANNEL]: channel().call, fetch: async () => { throw new TypeError('Failed to fetch') }
  }, PAGE()), { ok: false, error: 'network_error', message: 'Failed to fetch' })
  // Oversize is cut as it arrives, not after it: the request is aborted.
  const oversize = {
    [STREAM_CHANNEL]: channel().call, fetch: async (url, init) => answering(init, ['x'.repeat(600), 'x'.repeat(600)])
  }
  assert.deepEqual(await inPage(oversize, PAGE({ maxBytes: 512 })), { ok: false, error: 'too_large', status: 200 })
  assert.equal(oversize.fetches[0].aborted, true)
  // No cap asked, none applied: a stream is not the worker's to cap by default.
  assert.deepEqual(await inPage({
    [STREAM_CHANNEL]: channel().call, fetch: async (url, init) => answering(init, ['x'.repeat(600), 'x'.repeat(600)])
  }, PAGE({ maxBytes: 0 })), { ok: true })
})

// Qwen2API-3ue.9: on prod (2026-11-25) qwen.ai's risk control refused the
// call as an XMLHttpRequest, and passed it as a fetch (pageCall).

test('Qwen2API-3ue.9: a stream is a fetch — no XMLHttpRequest is made for it — that the call never waits on; a whole answer is an XMLHttpRequest still', async () => {
  const stream = {
    [STREAM_CHANNEL]: channel().call, fetch: async (url, init) => answering(init, ['data: x\n\n'])
  }
  assert.deepEqual(await inPage(stream, PAGE()), { ok: true })
  assert.equal(stream.fetches?.length, 1, 'the stream did not go out as a fetch')
  assert.equal(stream.xhrs, undefined, 'an XMLHttpRequest was made for the stream')

  // A fetch is one promise, and the page's hooks are known to keep it pending
  // on a challenge page and to ignore an abort through their wrapper
  // (2026-11-24). The call is not that promise: its own signal says it, and it
  // waits for nothing — not for the fetch, nor for the request to be out.
  const kept = { [STREAM_CHANNEL]: channel().call, fetch: () => new Promise(() => {}) }
  // The app going away while the fetch is out, and kept.
  const page = pageRealm(kept)
  const cancelled = running(page, PAGE({ timeoutMs: 1000 }))
  assert.equal(kept.fetches.length, 1, 'the fetch was not made')
  assert.equal(runIn(page, pageAbortStream)({ registry: STREAM_ABORTS, id: 7, reason: ABORT_REASON.cancelled }), true)
  assert.deepEqual(await cancelled, { ok: false, error: 'aborted' })
  // The app gone before the request is out at all: a hook of the page's is still holding on to it.
  let heldPage
  const held = {
    [STREAM_CHANNEL]: channel().call,
    fetch: () => {
      runIn(heldPage, pageAbortStream)({ registry: STREAM_ABORTS, id: 7, reason: ABORT_REASON.cancelled })
      return new Promise(() => {})
    }
  }
  heldPage = pageRealm(held)
  assert.deepEqual(await running(heldPage, PAGE({ timeoutMs: 1000 })), { ok: false, error: 'aborted' })
  // And qwen.ai's silence: the page's own timer cuts it, and says so.
  const clock = manualClock()
  const silent = {
    [STREAM_CHANNEL]: channel().call, fetch: () => new Promise(() => {}),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  }
  const quiet = running(pageRealm(silent), PAGE({ timeoutMs: 100 }))
  await clock.advance(99)
  assert.equal(silent.fetches[0].aborted, false)
  await clock.advance(2)
  assert.deepEqual(await quiet, { ok: false, error: 'timeout' })

  // The whole-answer call (chats/new) is what it was: an XMLHttpRequest, which
  // passes, and no fetch.
  const whole = { fetch: async () => jsonResponse({ success: true }) }
  assert.deepEqual(await inPage(whole, {
    url: `${CHAT}/api/v2/chats/new`, init: { method: 'POST', headers: {} }, timeoutMs: 1000, maxBytes: 1024, reasons: ABORT_REASON
  }), { ok: true, status: 200, url: `${CHAT}/api/v2/chats/new`, redirected: false, headers: { 'content-type': 'application/json' }, body: '{"success":true}' })
  assert.equal(whole.xhrs.length, 1, 'the whole-answer call is not an XMLHttpRequest')
  assert.equal(whole.fetches, undefined, 'the whole-answer call went out as a fetch')
})

test('Qwen2API-3ue.9: a stream’s fetch carries what the page’s own completions call carried — the same headers, in the same order, on the page’s session', async () => {
  // What the passing call sent, by name and in order (prod, 2026-11-25).
  const carried = ['accept', 'accept-language', 'content-type', 'authorization', 'source', 'timezone', 'version',
    'x-accel-buffering', 'bx-v', 'x-request-id']
  // What one call left the page with, as plain data (it comes from the page's
  // realm). `headers` is what the caller brought: the app's is content-type,
  // x-request-id and accept: application/json, and no authorization
  // (Qwen2API-jr9).
  const sentBy = async (script, headers) => {
    const page = {
      frontEnd: '0.3.50', pageToken: 'page-session', [STREAM_CHANNEL]: channel().call, ...script,
      fetch: async (url, init) => answering(init, ['data: x\n\n'])
    }
    await inPage(page, PAGE({ init: { method: 'POST', headers, body: '{"stream":true}' } }))
    const sent = page.fetches?.[0]?.sent
    assert.ok(sent, 'the stream did not go out as a fetch')
    return plain(sent)
  }
  const app = { 'content-type': 'application/json', 'x-request-id': 'app-request-1', accept: 'application/json' }

  const { url, init } = await sentBy({}, app)
  assert.equal(url, COMPLETIONS)
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{"stream":true}')
  // The browser's own cookies ride along, and the referer is not set: the
  // page's own goes out.
  assert.equal(init.credentials, 'include')
  assert.equal('referrer' in init, false)
  assert.equal('referrerPolicy' in init, false)
  assert.deepEqual(Object.keys(init.headers), carried)
  // The page's clock, in the front end's format. (Not the very second: the
  // call and this check may straddle one.)
  assert.match(init.headers.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
  assert.deepEqual(init.headers, {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    // The caller brought no Bearer: the call is one of the page's own, on the
    // token of its session.
    authorization: 'Bearer page-session',
    source: 'web',
    timezone: init.headers.timezone,
    // The front end's version, read off the address its scripts load from.
    version: '0.3.50',
    'x-accel-buffering': 'no',
    'bx-v': '2.5.36',
    'x-request-id': 'app-request-1'
  })
  assert.equal((await sentBy({ frontEnd: '0.4.1' }, app)).init.headers.version, '0.4.1')

  // A call that brings a Bearer has it sent as given.
  assert.equal((await sentBy({}, { ...app, authorization: 'Bearer app-token' })).init.headers.authorization, 'Bearer app-token')
  // So has any header it brings, in its place among the page's.
  const own = await sentBy({}, { ...app, accept: 'text/event-stream', 'x-accel-buffering': 'yes' })
  assert.equal(own.init.headers.accept, 'text/event-stream')
  assert.equal(own.init.headers['x-accel-buffering'], 'yes')
  assert.deepEqual(Object.keys(own.init.headers), carried)
  // What it brings that is not among those goes after them, as it brought it.
  assert.deepEqual(Object.keys((await sentBy({}, { ...app, 'x-custom': '1' })).init.headers), [...carried, 'x-custom'])
  // A page without a session sends no Bearer: the rest stands, in order.
  const signedOut = await sentBy({ pageToken: '' }, app)
  assert.equal('authorization' in signedOut.init.headers, false, 'a page without a session sends a Bearer')
  assert.deepEqual(Object.keys(signedOut.init.headers), carried.filter(name => name !== 'authorization'))
})

/* ------------------------------------------------------------------ over HTTP -- */

test('a streaming /egress relays the answer as it arrives: the head, every chunk, then the end', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'stream@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  signer.script.cookies = [cookie('cna', 'live')]

  const opened = await relay(email)
  assert.equal(opened.response.status, 200)
  assert.match(opened.response.headers.get('content-type'), /application\/x-ndjson/)
  await upstream.opened
  // What left the page: the app's call as a fetch (Qwen2API-3ue.9) — no
  // XMLHttpRequest was made for it — on the browser's own credentials, with
  // the page's own headers as its own completions call carries them
  // (Qwen2API-3ue.5).
  assert.equal(signer.script.fetches.length, 1)
  assert.equal(signer.script.xhrs, undefined, 'the stream was made as an XMLHttpRequest')
  assert.equal(upstream.url, COMPLETIONS)
  assert.equal(upstream.init.method, 'POST')
  assert.equal(upstream.init.body, '{"stream":true}')
  assert.equal(upstream.init.credentials, 'include')
  assert.equal(upstream.init.headers['content-type'], 'application/json')
  assert.equal(upstream.init.headers.authorization, 'Bearer app-token')
  assert.equal(upstream.init.headers.accept, 'application/json')
  assert.equal(upstream.init.headers['accept-language'], 'en-US,en;q=0.9')
  assert.equal(upstream.init.headers.source, 'web')
  assert.equal(upstream.init.headers.version, '0.3.50')
  assert.match(upstream.init.headers.timezone, /^\S{3} \S{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}$/)
  assert.match(upstream.init.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const { arg } = signer.contexts[0].page.evaluations.find(call => call.fn === 'pageCall')
  assert.equal(arg.timeoutMs, 5000)
  assert.deepEqual(arg.reasons, ABORT_REASON)

  // The head is relayed while the body is still being made.
  const head = await opened.next()
  assert.deepEqual(head, {
    type: 'head', status: 200, url: COMPLETIONS, redirected: false,
    headers: { 'content-type': 'text/event-stream' }, cookies: [cookie('cna', 'live')]
  })

  // A frame cut inside a two-byte character comes back whole.
  const frame = Buffer.from('data: {"choices":[{"delta":{"content":"при"}}]}\n\n')
  const split = frame.indexOf(Buffer.from('р')) + 1
  upstream.pushBytes(frame.subarray(0, split))
  upstream.pushBytes(frame.subarray(split))
  // How the two writes reach the page — one chunk or two — is the network's
  // business. What arrives is the frame's bytes, whole; a reader decodes them
  // as one (two half-characters decoded apart would not be "при").
  const frameText = frame.toString('utf8')
  const received = []
  while (received.reduce((sum, bytes) => sum + bytes.length, 0) < frame.length) received.push(bytesOf(await opened.next()))
  assert.equal(Buffer.concat(received).toString('utf8'), frameText)
  upstream.push('data: [DONE]\n\n')
  upstream.finish()
  assert.equal(text(await opened.next()), 'data: [DONE]\n\n')
  assert.deepEqual(await opened.next(), { type: 'end', cookies: [cookie('cna', 'live')] })
  assert.equal((await opened.next()).type, 'eof')
  assert.deepEqual(await health(), {
    ok: true, sessions: 1, residentPages: 1, maxResidentPages: 16, headless: true, headlessMode: 'shell',
    // Reported where a flip is verified, as the headless mode is (Qwen2API-xun, Qwen2API-nch); the queue of page loads is off in these tests.
    pageTokenRefresh: true, streamWaitMs: 20000, loadMinIntervalMs: 1, loadMaxWaitMs: 120000,
    pageLoadQueue: { waiting: 0, nextInMs: 0 }, forgetDeletesProfile: false, forgetGraceMs: 120000
  })
})

// Qwen2API-3ue.9: the call is a fetch now; what the app gets of the answer is
// what it got — and each piece is the bytes qwen.ai delivered.
test('Qwen2API-3ue.9: a stream’s body reaches the app in pieces while qwen.ai is still answering — each the bytes that arrived — and the end follows the last one', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'pieces@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email)
  await upstream.opened
  // A piece that arrives eventually is no proof that it came while the answer
  // ran: each is waited for here and now.
  const inTime = (promise, what) => Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} did not arrive while qwen.ai was still answering`)), 2000)
    })
  ])
  assert.equal((await inTime(opened.next(), 'the head')).type, 'head')

  // qwen.ai is generating still. What it has delivered is with the app
  // already, as the bytes that arrived: a piece may end inside a two-byte
  // character — nothing decodes the body and encodes it back on the way.
  const frame = Buffer.from('data: {"choices":[{"delta":{"content":"при"}}]}\n\n')
  const split = frame.indexOf(Buffer.from('р')) + 1
  const pieces = [frame.subarray(0, split), frame.subarray(split), Buffer.from('data: [DONE]\n\n')]
  for (const [at, piece] of pieces.entries()) {
    upstream.pushBytes(piece)
    assert.deepEqual(await inTime(opened.next(), `piece ${at + 1}`), { type: 'chunk', data: Buffer.from(piece).toString('base64') })
  }

  // The body is over: the relay ends right after its last piece, with nothing in between.
  upstream.finish()
  assert.deepEqual(kinds(await readAll(opened)), ['end'])
  assert.equal((await health()).residentPages, 1)
})

test('the stream flag is validated, and off it is the whole-answer call', async t => {
  const signer = fakeBrowser()
  const { post, health, streamCall, dataDir } = await start(t, { signer })
  const email = 'flag@example.invalid'
  withProfile(dataDir, email)

  for (const stream of ['yes', 1, {}, []]) {
    const refused = await post('/egress', { email, ...streamCall, stream })
    assert.equal(refused.status, 400, `${JSON.stringify(stream)} must be refused`)
    assert.equal((await refused.json()).code, 'invalid_request')
  }
  assert.equal((await health()).residentPages, 0)

  // An app that never heard of streams gets what /egress always answered.
  const plainCall = { ...streamCall }
  delete plainCall.stream
  const answer = await post('/egress', { email, ...plainCall })
  assert.equal(answer.status, 200)
  assert.match(answer.headers.get('content-type'), /application\/json/)
  const payload = await answer.json()
  assert.equal(payload.status, 200)
  assert.equal(payload.body, '{"success":true}')
})

test('what goes wrong before qwen.ai answered is an ordinary error status, not a relay', async t => {
  const signer = fakeBrowser()
  const { post, health, streamCall, dataDir } = await start(t, { signer })
  const email = 'early@example.invalid'
  withProfile(dataDir, email)

  // qwen.ai unreachable from the page.
  signer.script.fetch = async () => { throw new TypeError('Failed to fetch') }
  const dead = await post('/egress', { email, ...streamCall })
  assert.equal(dead.status, 502)
  assert.match(dead.headers.get('content-type'), /application\/json/)
  const deadBody = await dead.json()
  assert.equal(deadBody.code, 'egress_failed')
  // No head came, so there was no answer to read: nothing of a refusal, not an empty word of one (Qwen2API-qic).
  assert.equal('refusal' in deadBody, false)
  // The page is fine; it is qwen.ai that did not answer.
  assert.equal((await health()).residentPages, 1)

  // The page dying while qwen.ai has not answered yet.
  signer.script.fetch = () => new Promise(() => {})
  const dying = post('/egress', { email, ...streamCall })
  // (The refused call above was this page's first stream. This is its second.)
  const streams = () => signer.contexts[0].page.evaluations.filter(call => call.fn === 'pageCall' && call.arg.channel).length
  await until(() => streams() === 2)
  signer.contexts[0].page.emit('crash')
  const failed = await dying
  assert.equal(failed.status, 502)
  const failedBody = await failed.json()
  assert.equal(failedBody.code, 'page_closed')
  assert.equal('refusal' in failedBody, false)
})

test('what goes wrong after qwen.ai answered is the relay’s last event', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer, egressMaxStreamBytes: 64 })
  const email = 'late@example.invalid'
  withProfile(dataDir, email)
  const serving = async extra => {
    const upstream = feedable()
    signer.script.fetch = upstream.fetch
    const opened = await relay(email, extra)
    await upstream.opened
    return { upstream, opened }
  }
  // These answers are SSE, and none began as a refusal: the error that ends them says nothing of
  // one — no field at all, not an empty word of it (Qwen2API-qic).
  const unrefused = event => assert.equal('refusal' in event, false, JSON.stringify(event))

  // The connection dropping under the body.
  const dropped = await serving()
  dropped.upstream.push('data: {"n":1}\n\n')
  dropped.upstream.fail(new TypeError('Failed to fetch'))
  const cut = await readAll(dropped.opened)
  assert.deepEqual(cut.map(event => event.type), ['head', 'chunk', 'error'])
  assert.equal(cut[2].code, 'egress_failed')
  assert.match(cut[2].message, /network_error/)
  unrefused(cut[2])

  // Silence past the budget: cut inside the page.
  const stalled = await serving({ timeoutMs: 200 })
  stalled.upstream.push('data: {"n":1}\n\n')
  const since = Date.now()
  const quiet = await readAll(stalled.opened)
  assert.deepEqual(quiet.map(event => event.type), ['head', 'chunk', 'error'])
  assert.equal(quiet[2].code, 'egress_timeout')
  assert.ok(Date.now() - since >= 190, 'the stream was cut before its silence ran out')
  unrefused(quiet[2])

  // More body than the worker is allowed to relay.
  const big = await serving()
  big.upstream.push('x'.repeat(100))
  const tooLarge = await readAll(big.opened)
  assert.deepEqual(tooLarge.map(event => [event.type, event.code]), [['head', undefined], ['error', 'egress_too_large']])
  unrefused(tooLarge[1])
  // The request inside the page was cut, not left to run its course.
  assert.equal(signer.script.fetches.at(-1).aborted, true)

  // None of that was the page's doing.
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)

  // The page dying mid-stream: what a call in flight gets then.
  const crashed = await serving()
  crashed.upstream.push('data: {"n":1}\n\n')
  assert.equal((await crashed.opened.next()).type, 'head')
  assert.equal((await crashed.opened.next()).type, 'chunk')
  signer.contexts[0].page.emit('crash')
  const died = await readAll(crashed.opened)
  assert.deepEqual(died.map(event => [event.type, event.code]), [['error', 'page_closed']])
  unrefused(died[0])
})

test('a stream is not held to the whole-answer size cap', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // The whole-answer call could not carry this body.
  const { relay, dataDir } = await start(t, { signer, egressMaxBytes: 64 })
  const email = 'long@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email)
  await upstream.opened
  upstream.push('x'.repeat(4096))
  upstream.finish()
  assert.deepEqual(kinds(await readAll(opened)), ['head', 'x'.repeat(4096), 'end'])
})

test('the app closing its connection aborts the fetch inside the page, and the page stays', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, post, health, streamCall, dataDir } = await start(t, { signer })
  const email = 'cancelled@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email)
  await upstream.opened
  assert.equal((await opened.next()).type, 'head')
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')

  const lines = await logged(async lines => {
    // The app going away is it closing the connection — nothing else it can say.
    opened.close()
    const reason = await Promise.race([
      upstream.aborted,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('the request inside the page was not aborted')), 3000))
    ])
    // The request inside the page was aborted: that is the signal of it, the
    // fetch's own. It says for what — the worker's word for the app going
    // away, and not a timeout.
    assert.equal(reason, ABORT_REASON.cancelled)
    await until(() => lines.some(line => /egress-stream .* cancelled \(/.test(line)), 3000)
    return lines
  })
  assert.equal(lines.some(line => /egress-stream .* \((page_closed|browser_error|egress_\w+)/.test(line)), false,
    `a cancelled stream is not a failure:\n${lines.join('\n')}`)

  // The page is none the worse...
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)
  // ...and answers right after.
  signer.script.fetch = async () => jsonResponse({ success: true })
  const after = await post('/egress', { email, ...streamCall, stream: false })
  assert.equal((await after.json()).status, 200)
})

test('the app giving up while its page is opening runs nothing there and holds nothing', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, health, streamCall, dataDir, server } = await start(t, { signer, maxPages: 1 })
  const email = 'slow@example.invalid'
  for (const who of [email, 'other@example.invalid']) withProfile(dataDir, who)
  // Hold the launch open the way a real Chromium start would.
  let launch
  const gate = new Promise(resolve => { launch = resolve })
  let began
  const launching = new Promise(resolve => { began = resolve })
  const openContext = signer.openContext
  signer.openContext = async options => { began(); await gate; return openContext(options) }
  const fetched = []
  signer.script.fetch = (...args) => { fetched.push(args); return jsonResponse({ success: true }) }

  let connection = null
  server.on('request', req => { connection = req.socket })
  const controller = new AbortController()
  const pending = post('/egress', { email, ...streamCall }, controller.signal)
  await launching
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  // What the worker knows of it is its end of the connection going.
  await until(() => connection?.destroyed === true)
  launch()

  // The page opens all the same — it is the account's to keep...
  await until(async () => (await health()).residentPages === 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  // ...but nothing ran in it for a caller that is gone.
  assert.equal(fetched.length, 0)
  assert.equal(signer.contexts[0].page.evaluations.some(call => call.arg?.channel), false)
  // And nothing is held: at the cap, the page makes room for another account.
  const other = await post('/egress', { email: 'other@example.invalid', ...streamCall, stream: false })
  assert.equal(other.status, 200)
  assert.equal(signer.contexts[0].closed, true)
})

// Since Qwen2API-nch (2026-11-26) a navigation on a live page waits for the
// streams running on it. Measured without a network — the real worker on the
// real Chromium, and the real app against a stand-in for it (NOTES Qwen2API-nch,
// "26.11, 09:45 UTC"): a reload cut every call on the page at once, and an
// answer the app had begun to hand to its client was lost to that client. A
// stream is still no in-flight call: it does not hold the page against
// eviction, and a stop does not wait for it.
test('a renewal waits for the stream running on its page, and the answer reaches the app whole (Qwen2API-nch)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, health, dataDir } = await start(t, { signer, streamWaitMs: 3000, minCacheSeconds: 7200 })
  const email = 'renewed@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')
  const renew = signer.renew
  const reloaded = []
  signer.renew = async context => { reloaded.push(Date.now()); return renew(context) }

  const { status, lines, finishedAt } = await logged(async lines => {
    const pending = post('/renew', { email })
    // A moment into the wait: the page is still the one the stream runs on.
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(reloaded.length, 0, 'the renewal reloaded the page under a running stream')
    const finishedAt = Date.now()
    upstream.finish()
    // Not an error frame: the answer ran to its end.
    assert.deepEqual(kinds(await readAll(opened)), ['end'])
    return { status: (await pending).status, lines, finishedAt }
  })
  assert.equal(status, 200, lines.join('\n'))
  assert.equal(reloaded.length, 1)
  assert.ok(reloaded[0] >= finishedAt, `the page was reloaded at ${reloaded[0] - finishedAt} ms of the stream's end`)
  assert.ok(lines.some(line => /resident-wait ended \(waited \d+ ms for the page's streams\)$/.test(line)),
    `the log does not say the renewal waited:\n${lines.join('\n')}`)
  assert.equal((await health()).residentPages, 1)
})

test('a renewal waits for the streams on its page up to streamWaitMs; past it the page is reloaded and they are cut', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, health, dataDir } = await start(t, { signer, streamWaitMs: 300, minCacheSeconds: 7200 })
  const email = 'patient@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')

  // The stream does not end: the wait has its limit.
  const since = Date.now()
  const { status, lines } = await logged(async lines => ({ status: (await post('/renew', { email })).status, lines }))
  assert.equal(status, 200, lines.join('\n'))
  // Timers never fire early.
  assert.ok(Date.now() - since >= 300, `the renewal gave up after ${Date.now() - since} ms`)
  // The reload replaced the document the fetch ran in: the stream ends with it.
  assert.deepEqual((await readAll(opened)).map(event => [event.type, event.code]), [['error', 'browser_error']])
  assert.ok(lines.some(line => /resident-wait 1 still running \(waited \d+ ms for the page's streams\)$/.test(line)),
    `the log does not say the renewal gave up waiting:\n${lines.join('\n')}`)
  assert.equal((await health()).residentPages, 1)
})

test('a stream does not hold its page: with the wait at 0 a renewal does not wait for it', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, health, dataDir } = await start(t, { signer, streamWaitMs: 0, minCacheSeconds: 7200 })
  const email = 'renewed@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')

  const since = Date.now()
  const { status, lines } = await logged(async lines => ({ status: (await post('/renew', { email })).status, lines }))
  assert.equal(status, 200, lines.join('\n'))
  assert.ok(Date.now() - since < 2000, `the renewal waited ${Date.now() - since} ms for the stream`)
  assert.deepEqual((await readAll(opened)).map(event => [event.type, event.code]), [['error', 'browser_error']])
  assert.equal(lines.some(line => / resident-wait /.test(line)), false, `nothing was waited for:\n${lines.join('\n')}`)
  assert.equal((await health()).residentPages, 1)
})

test('while a renewal waits for the page’s streams, the account’s calls wait too, and run on the page once it is reloaded (Qwen2API-nch)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, streamCall, dataDir } = await start(t, { signer, streamWaitMs: 3000, minCacheSeconds: 7200 })
  const email = 'queued@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')
  // What reached qwen.ai, and the reload, in their order.
  const order = []
  const renew = signer.renew
  signer.renew = async context => { order.push('reload'); return renew(context) }
  signer.script.fetch = async url => { order.push(`call ${new URL(url).pathname}`); return jsonResponse({ success: true }) }

  const renewal = post('/renew', { email })
  await new Promise(resolve => setTimeout(resolve, 150))
  // A call of the same account, while the renewal holds the page for its wait.
  const call = post('/egress', { email, ...streamCall, stream: false })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(order, [], 'the call ran on a page that was about to be reloaded')
  upstream.finish()
  assert.equal((await call).status, 200)
  assert.equal((await renewal).status, 200)
  // The call found the page as the reload left it, not the page the stream was on.
  assert.deepEqual(order, ['reload', 'call /api/v2/chat/completions'])
  assert.deepEqual(kinds(await readAll(opened)), ['end'])
})

test('at the cap the page evicted is one without a stream, whatever was used last (Qwen2API-nch)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, streamCall, health, dataDir } = await start(t, { signer, maxPages: 2 })
  for (const who of ['x@example.invalid', 'y@example.invalid', 'z@example.invalid']) withProfile(dataDir, who)
  const quiet = async () => jsonResponse({ success: true })
  signer.script.fetch = quiet
  assert.equal((await post('/egress', { email: 'x@example.invalid', ...streamCall, stream: false })).status, 200)
  // y's page carries a stream...
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming('y@example.invalid')
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')
  // ...and x's page was used since the stream began: by use alone, y's is the one to go.
  // A moment first, so that "since" is a different millisecond on a clock that ticks coarsely too.
  await new Promise(resolve => setTimeout(resolve, 40))
  signer.script.fetch = quiet
  assert.equal((await post('/egress', { email: 'x@example.invalid', ...streamCall, stream: false })).status, 200)
  // z arrives at the cap.
  assert.equal((await post('/egress', { email: 'z@example.invalid', ...streamCall, stream: false })).status, 200)
  assert.equal(signer.contexts[0].closed, true, "x's page, the one without a stream, was not the one evicted")
  assert.equal(signer.contexts[1].closed, false, 'the page with the stream on it was evicted')
  assert.equal((await health()).residentPages, 2)
  upstream.finish()
  assert.deepEqual(kinds(await readAll(opened)), ['end'])
})

test('a stop ends a renewal that waits for its turn to load with page_closed, and no page is said to have died (Qwen2API-nch)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // The page's own opening takes the worker's only turn for a long time: the renewal queues behind it.
  const { post, streamCall, dataDir, server } = await start(t, { signer, loadMinIntervalMs: 60000, minCacheSeconds: 7200 })
  const email = 'stopping@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await post('/egress', { email, ...streamCall, stream: false })).status, 200)
  const renewal = post('/renew', { email })
  await new Promise(resolve => setTimeout(resolve, 150))
  const { answer, lines } = await logged(async lines => {
    await server.workerShutdown()
    const response = await renewal
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.deepEqual(answer, { status: 502, body: { code: 'page_closed', message: 'The worker is shutting down.' } })
  assert.equal(lines.some(line => /^resident-close (operation_failed|open_failed) /.test(line.replace(/^\S+ /, ''))), false,
    `a page was said to have died while the worker was stopping:\n${lines.join('\n')}`)
})

test('a stream does not hold its page: at the cap the page makes room, and its stream ends', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, post, streamCall, dataDir } = await start(t, { signer, maxPages: 1 })
  for (const who of ['x@example.invalid', 'y@example.invalid']) withProfile(dataDir, who)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming('x@example.invalid')
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')

  // y arrives at the cap: x's page is the least recently used, stream or no stream.
  signer.script.fetch = async () => jsonResponse({ success: true })
  const other = await post('/egress', { email: 'y@example.invalid', ...streamCall, stream: false })
  assert.equal(other.status, 200)
  assert.deepEqual((await readAll(opened)).map(event => [event.type, event.code]), [['error', 'page_closed']])
})

test('streams on one page run side by side, each on its own id', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'parallel@example.invalid'
  withProfile(dataDir, email)
  const first = feedable()
  const second = feedable()
  signer.script.fetch = (url, init) => (url.endsWith('=a') ? first : second).fetch(url, init)
  const a = await relay(email, { url: `${CHAT}/api/v2/chat/completions?chat_id=a` })
  const b = await relay(email, { url: `${CHAT}/api/v2/chat/completions?chat_id=b` })
  await Promise.all([first.opened, second.opened])

  first.push('A1')
  second.push('B1')
  second.push('B2')
  first.push('A2')
  first.finish()
  second.push('B3')
  second.finish()
  assert.deepEqual(kinds(await readAll(a)), ['head', 'A1', 'A2', 'end'])
  assert.deepEqual(kinds(await readAll(b)), ['head', 'B1', 'B2', 'B3', 'end'])
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
})

test('a page that stops reporting mid-stream is dropped, and the stream is answered as a timeout', async t => {
  const signer = fakeBrowser()
  const { post, health, streamCall, dataDir } = await start(t, { signer, backstopMs: 100 })
  const email = 'hung@example.invalid'
  withProfile(dataDir, email)
  // The page takes the call and never says a word: not even its own timer
  // comes back, so the Node-side backstop has to end it.
  signer.script.evaluate = () => new Promise(() => {})
  const refused = await post('/egress', { email, ...streamCall, timeoutMs: 200 })
  assert.equal(refused.status, 504)
  assert.equal((await refused.json()).code, 'egress_timeout')
  await until(() => signer.contexts[0].closed)
  assert.equal((await health()).residentPages, 0)
})

test('a stop does not wait for a stream: the stream is cut and the browsers close', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, server, health, dataDir } = await start(t, { signer, shutdownMs: 1000 })
  const email = 'stopping@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')

  await server.workerShutdown()
  assert.deepEqual((await readAll(opened)).map(event => [event.type, event.code]), [['error', 'page_closed']])
  assert.equal(signer.contexts[0].closed, true)
  assert.equal((await health()).residentPages, 0)
})

test('the worker says in its log what became of a stream', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'logged@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const { events, lines } = await logged(async lines => {
    const opened = await relay(email)
    await upstream.opened
    upstream.push('data: x\n\n')
    upstream.finish()
    return { events: await readAll(opened), lines }
  })
  assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
  const said = lines.filter(line => line.includes('egress-stream '))
  assert.equal(said.length, 2, said.join('\n'))
  assert.match(said[0], /egress-stream \/api\/v2\/chat\/completions -> 200 \(\d+ ms, 1\/16 pages\)/)
  assert.match(said[1], /egress-stream \/api\/v2\/chat\/completions end \(\d+ ms\)/)
})

test('a WAF challenge page answered to a stream is relayed whole and said by name, and the page stays', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'challenged@example.invalid'
  withProfile(dataDir, email)
  // What qwen.ai answered an API call with on 2026-11-24: status 200, a page.
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  const { events, lines, took } = await logged(async lines => {
    const since = Date.now()
    const opened = await relay(email, { timeoutMs: 30000 })
    return { events: await readAll(opened), lines, took: Date.now() - since }
  })
  // qwen.ai's status and body travel as for any answer; the app classifies.
  assert.deepEqual(kinds(events), ['head', CHALLENGE_PAGE, 'end'])
  assert.equal(events[0].headers['content-type'], 'text/html; charset=utf-8')
  assert.ok(took < 2000, `the answer was there at once; the stream took ${took} ms`)
  assert.ok(lines.some(line => /egress-stream \/api\/v2\/chat\/completions end \(\d+ ms\) — WAF challenge page$/.test(line)),
    lines.join('\n'))
  assert.equal(lines.some(line => /resident-close|unresponsive|stopped responding/.test(line)), false, lines.join('\n'))
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)
})

test('a challenge the page’s hooks keep from a streaming call is relayed by the worker, off the page’s network', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer, keptGraceMs: 50 })
  const email = 'kept@example.invalid'
  withProfile(dataDir, email)
  // The hooks hold the answer back: the call's own listeners never hear it end.
  signer.script.hold = body => /aliyun_waf_/.test(body)
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  const { events, lines, took } = await logged(async lines => {
    const since = Date.now()
    const opened = await relay(email, { timeoutMs: 30000 })
    return { events: await readAll(opened), lines, took: Date.now() - since }
  })
  assert.deepEqual(kinds(events), ['head', CHALLENGE_PAGE, 'end'])
  assert.equal(events[0].status, 200)
  assert.ok(took < 2000, `the answer was read off the network at once; the stream took ${took} ms`)
  assert.ok(lines.some(line => /egress-stream \/api\/v2\/chat\/completions end \(\d+ ms\) — WAF challenge page, kept from the call by the page$/.test(line)),
    lines.join('\n'))
  assert.equal(lines.some(line => /resident-close|unresponsive|stopped responding/.test(line)), false, lines.join('\n'))
  assert.equal((await health()).residentPages, 1)
  assert.equal(signer.contexts[0].closed, false)

  // The page is none the worse: the next stream is its own again, and nothing is relayed twice.
  signer.script.hold = null
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const after = await relay(email)
  await upstream.opened
  upstream.push('data: after\n\n')
  upstream.finish()
  assert.deepEqual(kinds(await readAll(after)), ['head', 'data: after\n\n', 'end'])
  assert.equal((await health()).residentPages, 1)
})

// Since Qwen2API-qic (2026-11-28): the line that ends a stream says when qwen.ai's 2xx carried a
// refusal in the start of its body — as a whole answer's line says since Qwen2API-0c6
// (signin-worker-egress.test.js). Before, such a stream read as accepted, in the log and in the
// log counter. It is read off the start of the body the relay keeps for a challenge page, once the
// call is over: nothing waits for it. Seen live once, on 2026-11-24 — a stream the page made as an
// XMLHttpRequest, answered with the punish envelope under 200 (docs/browser-egress-design.md);
// chats/new was refused so on 2026-11-26.

// qwen.ai's answer to a stream as JSON, fed by hand (feedable): `said` is the content-type it
// names — null for none at all —, and the status it comes under.
const jsonFeedable = (said = 'application/json', status = 200) => {
  const upstream = feedable()
  upstream.headers = said === null ? {} : { 'content-type': said }
  upstream.status = status
  return upstream
}
// One stream of a scripted answer, start to finish: what the app got, and the worker's lines.
const streamed = (relay, email, upstream, feed) => logged(async lines => {
  const opened = await relay(email)
  await upstream.opened
  await feed(upstream)
  return { events: await readAll(opened), lines }
})
// What the worker said of streams, without its time stamps; the milliseconds were its own.
const streamSaid = lines => lines.filter(line => line.includes('egress-stream '))
  .map(line => line.replace(/^\S+ /, '').replace(/\(\d+ ms/, '(N ms'))
const HEADED = 'egress-stream /api/v2/chat/completions -> 200 (N ms, 1/16 pages)'
const ENDED = 'egress-stream /api/v2/chat/completions end (N ms)'

test('Qwen2API-qic: a refusal qwen.ai puts in the body of a 200 that streamed is said on the line that ends the stream, and the end event carries its code', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'refused-stream@example.invalid'
  withProfile(dataDir, email)
  signer.script.cookies = [cookie('cna', 'live')]
  // The code where the app reads it, as chats/new was refused on 2026-11-26: on the answer, and on its data.
  const said = []
  for (const body of [
    { success: false, code: 'unauthorized' },
    { success: false, data: { code: 'unauthorized', details: 'private-upstream-refusal-fixture' } }
  ]) {
    const upstream = jsonFeedable()
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push(JSON.stringify(body))
      upstream.finish()
    })
    said.push(...lines)
    // The app gets qwen.ai's answer as it was — it classifies it itself —, and the code with the end.
    assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
    assert.equal(events[0].headers['content-type'], 'application/json')
    assert.equal(text(events[1]), JSON.stringify(body))
    assert.deepEqual(events[2], { type: 'end', cookies: [cookie('cna', 'live')], refusal: 'unauthorized' })
    // The log tells the refused stream from an accepted one, in the whole-answer line's own words...
    assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED} — code unauthorized`])
    // ...and the log counter reads it as the refusal it is (tools/egress-log-watch.js).
    const counted = summarize(lines).counts
    assert.equal(counted.get('stream.head.200'), 1)
    assert.equal(counted.get('stream.refused.unauthorized'), 1)
    assert.equal(counted.get('stream.ended'), undefined)
  }
  // What travels with a refusal is for the app, which has the body; not the log.
  assert.equal(said.join('\n').includes('private-upstream-refusal-fixture'), false)
  assert.equal((await health()).residentPages, 1)
})

test('Qwen2API-qic: the punish envelope under a 200 that streamed is said by its lines, as a whole answer’s is', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'punished-stream@example.invalid'
  withProfile(dataDir, email)
  // What qwen.ai's risk control answers with; and what only a refusal carries, success not in the answer at all.
  for (const [body, code] of [
    [{ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::x'] }, 'FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x'],
    [{ error: { code: 'FAIL_SYS_USER_VALIDATE', details: 'Unable to process your request' } }, 'FAIL_SYS_USER_VALIDATE']
  ]) {
    const upstream = jsonFeedable()
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push(JSON.stringify(body))
      upstream.finish()
    })
    assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [], refusal: code })
    assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED} — code ${code}`])
  }
})

test('Qwen2API-qic: a refusal that names no code is said to be one — on the line, and in the end event', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'refused-unsaid@example.invalid'
  withProfile(dataDir, email)
  const said = []
  for (const body of [{ success: false }, { success: false, message: 'Something went wrong.' }]) {
    const upstream = jsonFeedable()
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push(JSON.stringify(body))
      upstream.finish()
    })
    said.push(...lines)
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [], refusal: 'no_code' })
    assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED} — refused, no code`])
  }
  // What qwen.ai said with it is for the app, which has the body; not the log.
  assert.equal(said.join('\n').includes('Something went wrong.'), false)
})

test('Qwen2API-qic: a text/event-stream answer is not read for a refusal, whatever its text says', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'quoted-refusal@example.invalid'
  withProfile(dataDir, email)
  // A stream of frames may quote the words of a refusal as text — an answer about this very
  // code. And not even the bare JSON is looked into under a head that does not say JSON: the
  // body is the app's to read, as every SSE answer is.
  for (const piece of ['data: {"success":false,"code":"unauthorized"}\n\n', '{"success":false,"code":"unauthorized"}']) {
    const upstream = jsonFeedable('text/event-stream')
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push(piece)
      upstream.finish()
    })
    assert.deepEqual(kinds(events), ['head', piece, 'end'])
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [] })
    assert.deepEqual(streamSaid(lines), [HEADED, ENDED])
  }
})

test('Qwen2API-qic: a JSON answer that is no refusal is an ordinary stream — nothing said of it, nothing carried', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'plain-json@example.invalid'
  withProfile(dataDir, email)
  // An accepted call may carry a code of its own: it is not quoted as a refusal's.
  for (const body of ['{"success":true}', '{"code":"0"}', '{"success":true,"code":"OK","data":{}}', '[1,2]', '{"ret":[]}', '']) {
    const upstream = jsonFeedable()
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      if (body) upstream.push(body)
      upstream.finish()
    })
    assert.deepEqual(kinds(events), ['head', ...(body ? [body] : []), 'end'])
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [] })
    assert.deepEqual(streamSaid(lines), [HEADED, ENDED])
  }
})

test('Qwen2API-qic: a long body is relayed as it arrives, nothing held back — and past the limit a refusal it begins like is not called one', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'long-refusal@example.invalid'
  withProfile(dataDir, email)
  const bare = '{"success":false,"code":"unauthorized","pad":""}'
  const padded = size => bare.replace('""', `"${'x'.repeat(size)}"`)

  // qwen.ai is answering still: a JSON answer reaches the app piece by piece, as an SSE one does,
  // and the end follows the last piece.
  const upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const { rest, lines } = await logged(async lines => {
    const opened = await relay(email)
    await upstream.opened
    // A piece that arrives eventually is no proof that it came while the answer ran: each is
    // waited for here and now.
    const inTime = (promise, what) => Promise.race([
      promise,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error(`${what} did not arrive while qwen.ai was still answering`)), 2000)
      })
    ])
    assert.equal((await inTime(opened.next(), 'the head')).type, 'head')
    const pieces = [bare.slice(0, -2), 'x'.repeat(3000), 'x'.repeat(2000), '"}']
    for (const [at, piece] of pieces.entries()) {
      upstream.push(piece)
      assert.deepEqual(await inTime(opened.next(), `piece ${at + 1}`), { type: 'chunk', data: Buffer.from(piece).toString('base64') })
    }
    upstream.finish()
    return { rest: await readAll(opened), lines }
  })
  // Past the limit of 4096 bytes, and cut inside the document: it does not parse, so it is not called
  // a refusal.
  assert.deepEqual(kinds(rest), ['end'])
  assert.deepEqual(streamSaid(lines), [HEADED, ENDED])

  // The limit itself. A refusal is named when its document is complete within the first 4096 bytes:
  // one 4096 bytes long is, and so is that document with a line break after it — JSON.parse does not
  // mind whitespace after a document. A document the limit cuts inside, one byte longer, does not parse.
  const wholeDoc = padded(4096 - bare.length)
  for (const [body, code] of [[wholeDoc, 'unauthorized'], [`${wholeDoc}\n`, 'unauthorized'], [padded(4097 - bare.length), null]]) {
    const whole = jsonFeedable()
    signer.script.fetch = whole.fetch
    const { events, lines } = await streamed(relay, email, whole, async () => {
      whole.push(body)
      whole.finish()
    })
    assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [], ...(code ? { refusal: code } : {}) }, `${Buffer.byteLength(body)} bytes`)
    assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED}${code ? ` — code ${code}` : ''}`], `${Buffer.byteLength(body)} bytes`)
  }
})

test('Qwen2API-qic: an answer that is no 2xx is said by its status, as before — whatever JSON its body carries', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'refused-by-status@example.invalid'
  withProfile(dataDir, email)
  for (const status of [401, 500]) {
    const upstream = jsonFeedable('application/json', status)
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push('{"success":false,"code":"invalid token"}')
      upstream.finish()
    })
    assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
    assert.equal(events[0].status, status)
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [] })
    assert.deepEqual(streamSaid(lines), [HEADED.replace('-> 200', `-> ${status}`), ENDED])
  }
})

test('Qwen2API-qic: a stream that ends with an error after a 2xx answer that began as a refusal is said of it too — on the line and in the error event', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'refused-then-cut@example.invalid'
  withProfile(dataDir, email)
  const upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email)
  await upstream.opened
  assert.equal((await opened.next()).type, 'head')
  // qwen.ai's refusal is with the app...
  upstream.push('{"success":false,"code":"unauthorized"}')
  assert.equal(text(await opened.next()), '{"success":false,"code":"unauthorized"}')
  // ...and the body then dies under it: the connection dropping.
  const { rest, lines } = await logged(async lines => {
    upstream.fail(new TypeError('Failed to fetch'))
    return { rest: await readAll(opened), lines }
  })
  assert.deepEqual(rest.map(event => event.type), ['error'])
  assert.equal(rest[0].code, 'egress_failed')
  assert.match(rest[0].message, /network_error/)
  assert.equal(rest[0].refusal, 'unauthorized')
  assert.deepEqual(streamSaid(lines), ['egress-stream /api/v2/chat/completions egress_failed (N ms) — code unauthorized'])
  // The page is none the worse.
  assert.equal((await health()).residentPages, 1)
})

test('Qwen2API-qic: a refusal that arrives in two pieces is seen whole', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'refused-in-pieces@example.invalid'
  withProfile(dataDir, email)
  const upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  // The start of the body is collected across the chunks, not read off the first.
  const { events, lines } = await streamed(relay, email, upstream, async () => {
    upstream.push('{"success":false,"code":"un')
    upstream.push('authorized"}')
    upstream.finish()
  })
  assert.deepEqual(kinds(events), ['head', '{"success":false,"code":"un', 'authorized"}', 'end'])
  assert.deepEqual(events.at(-1), { type: 'end', cookies: [], refusal: 'unauthorized' })
  assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED} — code unauthorized`])
})

test('Qwen2API-qic: an answer is read for a refusal only when its head says JSON — with a charset or without, whatever its case; never without the header', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'typed@example.invalid'
  withProfile(dataDir, email)
  for (const [said, code] of [
    ['application/json; charset=utf-8', 'unauthorized'], ['application/json;charset=UTF-8', 'unauthorized'],
    ['Application/JSON', 'unauthorized'], [null, null]
  ]) {
    const upstream = jsonFeedable(said)
    signer.script.fetch = upstream.fetch
    const { events, lines } = await streamed(relay, email, upstream, async () => {
      upstream.push('{"success":false,"code":"unauthorized"}')
      upstream.finish()
    })
    assert.deepEqual(events.at(-1), { type: 'end', cookies: [], ...(code ? { refusal: code } : {}) })
    assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED}${code ? ` — code ${code}` : ''}`], String(said))
  }
})

test('Qwen2API-qic: an ordinary SSE stream is relayed as it was — every frame, every line', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, streamCall, dataDir } = await start(t, { signer })
  const email = 'untouched@example.invalid'
  withProfile(dataDir, email)
  signer.script.cookies = [cookie('cna', 'live')]
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  // The relay as the app reads it off the wire: one JSON object per line.
  const frame = Buffer.from('data: {"choices":[{"delta":{"content":"при"}}]}\n\n')
  const split = frame.indexOf(Buffer.from('р')) + 1
  const { wire, lines } = await logged(async lines => {
    const response = await post('/egress', { email, ...streamCall })
    await upstream.opened
    upstream.pushBytes(frame.subarray(0, split))
    upstream.pushBytes(frame.subarray(split))
    upstream.push('data: [DONE]\n\n')
    upstream.finish()
    return { wire: await response.text(), lines }
  })
  const jar = JSON.stringify(cookie('cna', 'live'))
  // Each piece the bytes that arrived — a frame cut inside a two-byte character comes back as its two pieces.
  assert.deepEqual(wire.split('\n').filter(Boolean), [
    `{"type":"head","status":200,"url":"${COMPLETIONS}","redirected":false,"headers":{"content-type":"text/event-stream"},"cookies":[${jar}]}`,
    `{"type":"chunk","data":"${frame.subarray(0, split).toString('base64')}"}`,
    `{"type":"chunk","data":"${frame.subarray(split).toString('base64')}"}`,
    `{"type":"chunk","data":"${Buffer.from('data: [DONE]\n\n').toString('base64')}"}`,
    `{"type":"end","cookies":[${jar}]}`
  ])
  assert.deepEqual(streamSaid(lines), [HEADED, ENDED])
})

test('Qwen2API-qic: the lines the worker writes of a refused stream are these, to the byte — the ones the application’s reader of the relay is tried with', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { post, streamCall, dataDir } = await start(t, { signer })
  const email = 'literal@example.invalid'
  withProfile(dataDir, email)
  // One stream as the application's reader takes it off the wire, a line at a time
  // (src/utils/signin-worker-client.js#relayFrames; the same lines in tests/signin-worker-client.test.js).
  // `feed` may wait for lines before it goes on.
  const wireOf = async feed => {
    const upstream = jsonFeedable()
    signer.script.fetch = upstream.fetch
    const reader = (await post('/egress', { email, ...streamCall })).body.getReader()
    let wire = ''
    const lines = async count => {
      while (wire.split('\n').filter(Boolean).length < count) wire += Buffer.from((await reader.read()).value).toString('utf8')
    }
    await upstream.opened
    await feed(upstream, lines)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return wire.split('\n').filter(Boolean)
      wire += Buffer.from(value).toString('utf8')
    }
  }
  const REFUSAL = '{"success":false,"code":"unauthorized"}'
  const chunk = body => `{"type":"chunk","data":"${Buffer.from(body).toString('base64')}"}`
  // The end of a refused stream, with its code...
  assert.deepEqual(await wireOf(async upstream => {
    upstream.push(REFUSAL)
    upstream.finish()
  }), [
    `{"type":"head","status":200,"url":"${COMPLETIONS}","redirected":false,"headers":{"content-type":"application/json"},"cookies":[]}`,
    chunk(REFUSAL),
    '{"type":"end","cookies":[],"refusal":"unauthorized"}'
  ])
  // ...with no code to name...
  assert.deepEqual(await wireOf(async upstream => {
    upstream.push('{"success":false}')
    upstream.finish()
  }), [
    `{"type":"head","status":200,"url":"${COMPLETIONS}","redirected":false,"headers":{"content-type":"application/json"},"cookies":[]}`,
    chunk('{"success":false}'),
    '{"type":"end","cookies":[],"refusal":"no_code"}'
  ])
  // ...and the error it ended with, the code after the message.
  assert.deepEqual(await wireOf(async (upstream, lines) => {
    upstream.push(REFUSAL)
    await lines(2) // the head and the refusal are with the app
    upstream.fail(new TypeError('Failed to fetch'))
  }), [
    `{"type":"head","status":200,"url":"${COMPLETIONS}","redirected":false,"headers":{"content-type":"application/json"},"cookies":[]}`,
    chunk(REFUSAL),
    '{"type":"error","code":"egress_failed","message":"In-page request failed (network_error: Failed to fetch).","refusal":"unauthorized"}'
  ])
})

test('Qwen2API-qic: a code that looks like a credential is not shown as itself — not on the line, not in the event', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'credential-code@example.invalid'
  withProfile(dataDir, email)
  const upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const { events, lines } = await streamed(relay, email, upstream, async () => {
    upstream.push('{"success":false,"code":"Bearer private-upstream-token"}')
    upstream.finish()
  })
  // The app has qwen.ai's answer as it was, and classifies it itself...
  assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'end'])
  assert.equal(text(events[1]), '{"success":false,"code":"Bearer private-upstream-token"}')
  // ...and what the worker says of the code is masked, the same in the event and on the line, as a
  // whole answer's line masks it (answerNote).
  assert.deepEqual(events.at(-1), { type: 'end', cookies: [], refusal: '<credential>' })
  assert.deepEqual(streamSaid(lines), [HEADED, `${ENDED} — code <credential>`])
  assert.equal(lines.join('\n').includes('private-upstream-token'), false)
})

test('Qwen2API-qic: a stream that falls silent after a 2xx answer began as a refusal is cut by the page’s own timer — and the error line and the error event carry the code', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'refused-then-silent@example.invalid'
  withProfile(dataDir, email)
  const upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email, { timeoutMs: 200 })
  await upstream.opened
  assert.equal((await opened.next()).type, 'head')
  upstream.push('{"success":false,"code":"unauthorized"}')
  assert.equal(text(await opened.next()), '{"success":false,"code":"unauthorized"}')
  // Then qwen.ai says nothing more, and the body never ends: the page's own timer cuts the call.
  const since = Date.now()
  const { rest, lines } = await logged(async lines => ({ rest: await readAll(opened), lines }))
  assert.deepEqual(rest.map(event => event.type), ['error'])
  assert.equal(rest[0].code, 'egress_timeout')
  assert.equal(rest[0].refusal, 'unauthorized')
  assert.ok(Date.now() - since >= 190, 'the stream was cut before its silence ran out')
  assert.deepEqual(streamSaid(lines), ['egress-stream /api/v2/chat/completions egress_timeout (N ms) — code unauthorized'])
  // The page is none the worse.
  assert.equal((await health()).residentPages, 1)
})

/* ------------------------------------------------------- the service on its own -- */

test('the page is held back while the app is behind: nothing is reported over an unacknowledged event', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-hold-'))
  const residents = createResidents({ signer, profileDir: email => path.join(dataDir, email), drainMs: 10 })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const page = await residents.acquire('a@example.invalid')
  const delivered = []
  let acknowledge
  const gate = new Promise(resolve => { acknowledge = resolve })
  const done = residents.stream(page, { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 5000 }, {
    id: 1,
    // The app takes the second event — the first chunk — slowly.
    onEvent: event => { delivered.push(event.type); return delivered.length === 2 ? gate : undefined }
  })
  await upstream.opened
  upstream.push('data: 1\n\n')
  await until(() => delivered.length === 2)
  upstream.push('data: 2\n\n')
  upstream.push('data: 3\n\n')
  upstream.finish()
  // The page can report nothing more until the app has taken what it has.
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(delivered, ['head', 'chunk'])
  acknowledge()
  assert.deepEqual(await done, { cookies: [], aborted: false })
  assert.deepEqual(delivered, ['head', 'chunk', 'chunk', 'chunk'])
  // The stream is over and forgotten: whatever the page says of it now reaches nobody.
  assert.equal(await signer.contexts[0].page.bindings[STREAM_CHANNEL](1, { type: 'chunk', data: '' }), undefined)
  assert.deepEqual(delivered, ['head', 'chunk', 'chunk', 'chunk'])
  assert.equal(await residents.abort(1), false)
})

test('a challenge the page is handing over is not taken from it, however slowly the app takes it', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-slow-'))
  // The worker would read a kept answer off the network after 20 ms; the app
  // takes longer than that over the head.
  const residents = createResidents({
    signer, profileDir: email => path.join(dataDir, email), drainMs: 10, frontEndMs: 50, keptGraceMs: 20
  })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const page = await residents.acquire('a@example.invalid')
  const delivered = []
  let take
  const held = new Promise(resolve => { take = resolve })
  const done = residents.stream(page, { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 5000 }, {
    id: 1,
    onEvent: event => { delivered.push(event.type); return event.type === 'head' ? held : undefined }
  })
  await until(() => delivered.length === 1)
  // Past the time a kept answer would have been read off the network.
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(delivered, ['head'])
  take()
  assert.deepEqual(await done, { cookies: [], aborted: false, challenge: 'page' })
  assert.deepEqual(delivered, ['head', 'chunk'])
  // And the watch is over: nothing is left listening on the page.
  assert.equal(signer.contexts[0].page.listenerCount('response'), 0)
})

test('once the worker took a kept answer, what the page says of it is not relayed — while it is relayed, or after', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-late-'))
  const residents = createResidents({
    signer, profileDir: email => path.join(dataDir, email), drainMs: 10, frontEndMs: 50, keptGraceMs: 20
  })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  signer.script.hold = body => /aliyun_waf_/.test(body)
  signer.script.fetch = async () => new Response(CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const page = await residents.acquire('a@example.invalid')
  const delivered = []
  let take
  const held = new Promise(resolve => { take = resolve })
  const running = residents.stream(page, { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 5000 }, {
    // The app takes its time over the head of the worker's own relay.
    id: 1, onEvent: event => { delivered.push(event.type); return event.type === 'head' ? held : undefined }
  })
  await until(() => delivered.length === 1)
  const answer = signer.script.fetches.at(-1)
  assert.ok(answer.held, 'the stand-in held the answer back from the call')
  // The worker cut the call in the page before relaying what it read: nothing
  // of it waits there for the call's own timer.
  assert.equal(vm.runInContext(`Object.keys(globalThis[${JSON.stringify(STREAM_ABORTS)}] || {}).length`, signer.contexts[0].page.realm), 0)

  // The page's hooks let go of it while the worker is still relaying what it
  // read off the network: the call is told of the answer now. Nothing of it
  // goes out twice.
  answer.release()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(delivered, ['head'])
  take()
  assert.deepEqual(await running, { cookies: [], aborted: false, challenge: 'network' })
  assert.deepEqual(delivered, ['head', 'chunk'])

  // Nor after: whatever the page says of a stream that is over reaches nobody.
  const said = await signer.contexts[0].page.bindings[STREAM_CHANNEL](1, { type: 'chunk', data: '' })
  assert.equal(said, undefined)
  assert.deepEqual(delivered, ['head', 'chunk'])
  assert.equal(await residents.abort(1), false)
  assert.equal(signer.contexts[0].page.listenerCount('response'), 0)
})

test('a script of the page cutting the stream’s request is the page’s fault, not the app going away', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, health, dataDir } = await start(t, { signer })
  const email = 'cut@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await relay(email)
  await upstream.opened
  assert.equal((await opened.next()).type, 'head')
  // Not the app closing its connection: something in the page cuts the request
  // itself. A fetch has no abort() for a script to call: the page's own
  // AbortController ends it, and the browser ends the body with it — an
  // AbortError, and not the call's own signal's.
  const { said, events } = await logged(async captured => {
    upstream.fail(new DOMException('The operation was aborted.', 'AbortError'))
    return { said: captured, events: await readAll(opened) }
  })
  // The relay ends, with the failure said by its name.
  assert.deepEqual(events.map(event => [event.type, event.code]), [['error', 'page_fault']])
  assert.ok(said.some(line => /egress-stream \/api\/v2\/chat\/completions page_fault \(\d+ ms\)$/.test(line)), said.join('\n'))
  assert.equal(said.some(line => /cancelled/.test(line)), false, 'a cut request was logged as the app going away')
  assert.equal((await health()).residentPages, 1)
})

test('a script of the page cutting a whole-answer request is the page’s fault too', async t => {
  const signer = fakeBrowser()
  const { post, health, dataDir } = await start(t, { signer })
  const email = 'cut-whole@example.invalid'
  withProfile(dataDir, email)
  await (await post('/egress', { email, url: `${CHAT}/api/v2/models`, method: 'GET', timeoutMs: 30000 }).then(async r => r.json()))
  const pending = () => new Promise(() => {})
  const cutting = post('/egress', { email, url: `${CHAT}/api/v2/models`, method: 'GET', timeoutMs: 30000 })
  signer.script.fetch = pending
  await until(() => signer.script.xhrs.length === 2)
  signer.script.xhrs.at(-1).abort()
  const failed = await cutting
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).code, 'page_fault')
  assert.equal((await health()).residentPages, 1)
})

test('a stream whose text quotes the challenge’s markers is an answer, and is logged as one', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { relay, dataDir } = await start(t, { signer })
  const email = 'quoted@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const { said, events } = await logged(async captured => {
    const opened = await relay(email)
    await upstream.opened
    // An answer about this very code.
    upstream.push('data: {"choices":[{"delta":{"content":"aliyun_waf_aa aliyunCaptcha <title>Verification</title>"}}]}\n\n')
    upstream.push('data: [DONE]\n\n')
    upstream.finish()
    return { said: captured, events: await readAll(opened) }
  })
  assert.deepEqual(events.map(event => event.type), ['head', 'chunk', 'chunk', 'end'])
  assert.equal(said.some(line => /WAF challenge/.test(line)), false, said.join('\n'))
  assert.ok(said.some(line => /egress-stream \/api\/v2\/chat\/completions end \(\d+ ms\)$/.test(line)), said.join('\n'))
})

test('the network watch is over once the answer is known to stream: a stream is no page to read', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-watch-'))
  const residents = createResidents({ signer, profileDir: email => path.join(dataDir, email), drainMs: 10, frontEndMs: 50 })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const page = await residents.acquire('a@example.invalid')
  const listening = () => signer.contexts[0].page.listenerCount('response')
  const delivered = []
  const done = residents.stream(page, { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 5000 }, {
    id: 1, onEvent: event => { delivered.push(event.type) }
  }).then(value => value, error => error)
  await until(() => delivered.length === 1) // the head: qwen.ai's answer is known to stream
  // The stream is under way and will run on: there is nothing in it to read for the watch.
  assert.equal(listening(), 0)
  upstream.push('data: 1\n\n')
  upstream.finish()
  assert.deepEqual(await done, { cookies: [], aborted: false })
  assert.equal(listening(), 0)
})

test('a frame the app has not taken counts as taken once its socket goes', { timeout: 10000 }, async () => {
  const listeners = {}
  let writes = 0
  // An app that is behind: nothing it takes fits in the socket, so a write never says "done".
  const behind = {
    write: () => { writes++; return false },
    once(event, handler) { (listeners[event] ||= []).push(handler) },
    off(event, handler) { listeners[event] = (listeners[event] || []).filter(kept => kept !== handler) }
  }
  const taken = []
  const writing = relayWriter(behind, () => false)({ type: 'chunk', data: '' }).then(() => taken.push(true))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(taken, [], 'the frame was taken before the app caught up')
  assert.deepEqual(Object.keys(listeners).sort(), ['close', 'drain'])
  // The app is gone instead: its socket closes, and will never drain.
  for (const handler of listeners.close) handler()
  await writing
  assert.deepEqual(taken, [true])
  assert.deepEqual(listeners, { close: [], drain: [] }, 'nothing is left listening on a dead socket')

  // An app that is already gone is not written to at all.
  await relayWriter(behind, () => true)({ type: 'chunk', data: '' })
  assert.equal(writes, 1)
})

test('a chunk after a long silence, taken slowly by the app, is not a hung page', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-slow-'))
  const residents = createResidents({
    signer, profileDir: email => path.join(dataDir, email), drainMs: 10, backstopMs: 50
  })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const page = await residents.acquire('a@example.invalid')
  const withApp = []
  let take
  const held = new Promise(resolve => { take = resolve })
  const done = residents.stream(page, { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 1000 }, {
    id: 1,
    // The app takes the head at once, the chunk after the silence slowly.
    onEvent: event => {
      withApp.push(event.type)
      return event.type === 'chunk' ? held : undefined
    }
  }).then(value => value, error => error)
  await upstream.opened
  await until(() => withApp.length === 1)

  // qwen.ai falls silent for longer than the grace on top of its budget...
  await new Promise(resolve => setTimeout(resolve, 600))
  upstream.push('data: x\n\n')
  upstream.finish()
  await until(() => withApp.length === 2) // the chunk is with the app, not taken yet
  // ...and the app sits on that chunk past where a watch left running from the
  // head would end: the page is fine, it is the app that is behind.
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(signer.contexts[0].closed, false, 'a healthy page was dropped as unresponsive')
  take()
  assert.deepEqual(await done, { cookies: [], aborted: false })
  assert.equal(signer.contexts[0].closed, false)
})

test('the service says of a stream what qwen.ai’s 2xx began as: a refusal is on its result, and on the error it throws after one (Qwen2API-qic)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-stream-refused-'))
  const residents = createResidents({ signer, profileDir: email => path.join(dataDir, email), drainMs: 10, frontEndMs: 50 })
  t.after(async () => {
    await residents.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'a@example.invalid'))
  const call = { url: COMPLETIONS, init: { method: 'POST', headers: {} }, timeoutMs: 5000 }

  // An answer that is no refusal: no word of one.
  let upstream = feedable()
  signer.script.fetch = upstream.fetch
  const page = await residents.acquire('a@example.invalid')
  const plain = residents.stream(page, call, { id: 1, onEvent: () => {} })
  await upstream.opened
  upstream.push('data: x\n\n')
  upstream.finish()
  assert.deepEqual(await plain, { cookies: [], aborted: false })

  // A refusal in the body of a 200: on the result, with the note the log makes of it.
  upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const refused = residents.stream(page, call, { id: 2, onEvent: () => {} })
  await upstream.opened
  upstream.push('{"success":false,"code":"unauthorized"}')
  upstream.finish()
  assert.deepEqual(await refused, {
    cookies: [], aborted: false, refusal: { code: 'unauthorized', note: ' — code unauthorized' }
  })

  // The call failing after such an answer: on the error, for the line and the error event.
  upstream = jsonFeedable()
  signer.script.fetch = upstream.fetch
  const delivered = []
  const cut = residents.stream(page, call, { id: 3, onEvent: event => { delivered.push(event.type) } })
    .then(value => value, error => error)
  await upstream.opened
  await until(() => delivered.length === 1) // the head
  upstream.push('{"success":false,"code":"unauthorized"}')
  await until(() => delivered.length === 2) // the refusal is with the app
  upstream.fail(new TypeError('Failed to fetch'))
  const failed = await cut
  assert.equal(failed.code, 'egress_failed')
  assert.deepEqual(failed.refusal, { code: 'unauthorized', note: ' — code unauthorized' })

  // A call that fails before any head comes: there was no answer to read, and the error says nothing
  // of a refusal — no field at all, not an empty one.
  signer.script.fetch = async () => { throw new TypeError('Failed to fetch') }
  const early = await residents.stream(page, call, { id: 4, onEvent: () => {} }).then(value => value, error => error)
  assert.equal(early.code, 'egress_failed')
  assert.equal('refusal' in early, false)
})

test('Qwen2API-qic: streamRefusal says of a stream’s start what answerNote says of a whole answer — and nothing of the rest', () => {
  const json = { status: 200, headers: { 'content-type': 'application/json' } }
  const read = (body, head = json) => streamRefusal(head, [Buffer.from(body)])
  // A refusal in the body of a 2xx: its code, wherever the app reads it from — and the line in the
  // whole answer's own words.
  for (const [body, code] of [
    ['{"success":false,"code":"unauthorized"}', 'unauthorized'],
    ['{"success":false,"data":{"code":"unauthorized"}}', 'unauthorized'],
    ['{"success":false,"error":{"code":"invalid token"}}', 'invalid token'],
    ['{"success":false,"error":"forbidden"}', 'forbidden'],
    ['{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::x"]}', 'FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x'],
    ['{"error":{"code":"FAIL_SYS_USER_VALIDATE","details":"Unable to process your request"}}', 'FAIL_SYS_USER_VALIDATE'],
    ['{"success":false}', 'no_code'],
    ['{"success":false,"message":"Something went wrong."}', 'no_code'],
    // The code as a log line may show it: one line of at most 80 characters, as a whole answer's is.
    [`{"success":false,"code":"${'y'.repeat(100)}"}`, 'y'.repeat(80)]
  ]) {
    const found = read(body)
    assert.deepEqual(found, { code, note: ` — ${code === 'no_code' ? 'refused, no code' : `code ${code}`}` }, body)
    assert.equal(found.note, answerNote({ status: 200, headers: json.headers, body }), body)
  }
  // A code that looks like a credential is shown as little of itself as a whole answer's is — on
  // the line, and in the event.
  assert.deepEqual(read('{"success":false,"code":"Bearer private-upstream-token"}'), { code: '<credential>', note: ' — code <credential>' })
  // The start of the body is read in the pieces it arrived in.
  assert.equal(streamRefusal(json, [Buffer.from('{"success":false,"code":"un'), Buffer.from('authorized"}')]).code, 'unauthorized')

  const refusal = '{"success":false,"code":"unauthorized"}'
  // Nothing to say of a head that is no 2xx — the line says its status —, that does not say JSON,
  // that says nothing, or that never came.
  for (const head of [null, { status: 401, headers: json.headers }, { status: 503, headers: json.headers },
    { status: 200, headers: { 'content-type': 'text/event-stream' } }, { status: 200, headers: {} }]) {
    assert.equal(streamRefusal(head, [Buffer.from(refusal)]), null)
  }
  // ...nor of a body that is no JSON, is JSON and no refusal, or never came.
  for (const body of ['', 'data: {"success":false}\n\n', '{"success":true}', '{"code":"0"}', '[1,2]', '<!doctype html>']) {
    assert.equal(read(body), null, body)
  }
  // The limit: a refusal is named when its document is complete within the first 4096 bytes, and not
  // when the limit cuts inside the document, whatever it began like. Whitespace after the document is
  // nothing (JSON.parse does not mind it): a line break makes the body 4097 bytes long, and the
  // refusal is named all the same — in one piece, or with the line break in a piece of its own.
  const bare = '{"success":false,"code":"unauthorized","pad":""}'
  const padded = size => bare.replace('""', `"${'x'.repeat(size)}"`)
  const whole = padded(4096 - bare.length)
  assert.equal(read(whole).code, 'unauthorized')
  assert.equal(read(`${whole}\n`).code, 'unauthorized')
  assert.equal(read(`${whole}\n\n \t`).code, 'unauthorized')
  assert.equal(streamRefusal(json, [Buffer.from(whole), Buffer.from('\n')]).code, 'unauthorized')
  assert.equal(read(padded(4097 - bare.length)), null)
  // The gate is what the head says the answer is: `application/json` with a charset or without, in
  // any case; no other type, and no header at all.
  assert.deepEqual([
    'application/json', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON', ' application/json ',
    'text/event-stream', 'application/problem+json', '', undefined
  ].map(said => isJsonAnswer(said === undefined ? {} : { 'content-type': said })), [true, true, true, true, true, false, false, false, false])
})

// Since Qwen2API-xun (2026-11-26; the page's token is signin-worker-egress.test.js's
// subject): a stream is sent on the page's token like any other call, so that
// token is renewed first when it is nearly spent.
test('Qwen2API-xun: a stream on a page whose token is nearly spent is sent on the renewed token', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  const { streaming, dataDir } = await start(t, { signer })
  const email = 'idle@example.invalid'
  withProfile(dataDir, email)
  // What the front end keeps of a token a minute from its end (main.js, IC).
  const expiresAt = Date.now() + 60000
  signer.script.storage = {
    qwen_access_token_state: JSON.stringify({ version: 1, stateId: 'the-page', token: 'spent-access-token', expiresAt, updatedAt: 0, sourceId: 'page' }),
    token: 'spent-access-token',
    at_expire_time: String(expiresAt)
  }
  const renewals = []
  const answer = () => Promise.resolve(new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      stream.close()
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  signer.script.fetch = (url, init) => {
    if (url === 'https://auth.qwen.ai/api/v2/auths/refresh') {
      renewals.push(Date.now())
      return jsonResponse({
        success: true, data: { access_token: 'renewed-access-token', expires_at: Math.floor(Date.now() / 1000) + 900 }
      })
    }
    return answer()
  }

  // As the app makes the call: no Bearer of its own — the page’s token is the one sent (Qwen2API-jr9).
  const opened = await streaming(email, { headers: { 'content-type': 'application/json' } })
  // The refresh went out from the page, as the front end makes it — an XMLHttpRequest to the auth host, the session's cookies asked for...
  assert.equal(renewals.length, 1)
  assert.equal(signer.script.xhrs.length, 1)
  const [refresh] = signer.script.xhrs
  assert.equal(refresh.sent.url, 'https://auth.qwen.ai/api/v2/auths/refresh')
  assert.equal(refresh.withCredentials, true)
  // The page named itself in x-request-origin, as the front end's interceptor does.
  assert.equal(refresh.sent.headers['x-request-origin'], CHAT)
  // ...and the stream, which is a fetch, on what it brought.
  assert.equal(signer.script.fetches.length, 1)
  const [stream] = signer.script.fetches
  assert.equal(stream.sent.init.headers.authorization, 'Bearer renewed-access-token')
  assert.deepEqual(kinds(await readAll(opened)), ['data: [DONE]\n\n', 'end'])
  // No page was reloaded for any of it.
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
})

test('a page that is closed for a proxy change waits for its streams first (Qwen2API-nch)', { timeout: 10000 }, async t => {
  const signer = fakeBrowser()
  // minCacheSeconds forces the live path: the default cache would answer /renew without touching the page.
  const { streaming, post, dataDir } = await start(t, { signer, streamWaitMs: 3000, minCacheSeconds: 7200 })
  const email = 'proxy@example.invalid'
  withProfile(dataDir, email)
  const upstream = feedable()
  signer.script.fetch = upstream.fetch
  const opened = await streaming(email)
  upstream.push('data: {"n":1}\n\n')
  assert.equal((await opened.next()).type, 'chunk')
  // When the page's browser is told to close.
  const closes = []
  const page = signer.contexts[0]
  const close = page.close.bind(page)
  page.close = async () => { closes.push(Date.now()); return close() }

  // The account is asked for on another proxy: its page cannot serve that, and is closed for a new browser.
  const switched = post('/renew', { email, proxy: 'http://proxy.example:8080' })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(closes, [], 'the page was closed under a running stream')
  const finishedAt = Date.now()
  upstream.finish()
  assert.deepEqual(kinds(await readAll(opened)), ['end'])
  assert.equal((await switched).status, 200)
  assert.equal(closes.length, 1)
  assert.ok(closes[0] >= finishedAt, `the page was closed at ${closes[0] - finishedAt} ms of the stream's end`)
  assert.equal(signer.calls.filter(call => call.op === 'open').at(-1).proxy, 'http://proxy.example:8080')
})
