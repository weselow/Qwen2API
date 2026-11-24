const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createServer } = require('../signin-worker/server')
const { openContext, BrowserSigninError } = require('../signin-worker/lib/browser-signin')
const { parseHeadlessMode, IDENTITY_URL } = require('../signin-worker/lib/browser-identity')
const { createResidents } = require('../signin-worker/lib/resident-pages')

const AUTH = { authorization: 'Bearer secret' }
const OVERRIDE = 'Emulation.setUserAgentOverride'

// What a full Chromium on Linux reports about itself, as measured in the
// worker's image (Qwen2API-3ue.4).
const IDENTITY = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/159.0.0.0 Safari/537.36',
  brands: [{ brand: 'Chromium', version: '159' }, { brand: 'Not/A)Brand', version: '8' }],
  mobile: false,
  platform: 'Linux',
  architecture: 'x86',
  model: '',
  platformVersion: '',
  fullVersionList: [
    { brand: 'Chromium', version: '159.0.8154.6' }, { brand: 'Not/A)Brand', version: '8.0.0.0' }
  ]
}
const HINTS = {
  brands: IDENTITY.brands,
  fullVersionList: IDENTITY.fullVersionList,
  platform: 'Linux',
  platformVersion: '',
  architecture: 'x86',
  model: '',
  mobile: false
}
// The window frame per platform, as the headed browser has it.
const FRAME = { win32: [16, 134], linux: [8, 131], darwin: [2, 126] }[process.platform] || [24, 134]

const emitter = () => {
  const handlers = {}
  return {
    on(event, handler) { (handlers[event] ||= []).push(handler) },
    emit(event, ...args) { for (const handler of handlers[event] || []) handler(...args) }
  }
}

/**
 * A fake "Playwright" in the jik.3 mold: a context whose pages record what
 * the worker does. What the browser says about itself is scripted; whether
 * the real browser answers the in-page function is the real browser's smoke
 * to show (tools/worker-egress-local-smoke.js).
 */
function fakeChromium(script = {}) {
  const calls = {
    launches: [], pages: [], routes: [], gotos: [], evaluations: [], closedPages: [],
    sent: [], sessions: [], newPages: 0
  }
  const makePage = kind => {
    const page = { kind, ...emitter() }
    page.route = async (url, handler) => {
      calls.routes.push({ page, url, handler })
      if (script.route) await script.route()
    }
    page.goto = async (url, options) => {
      calls.gotos.push({ page, url, options })
      if (script.goto) await script.goto()
    }
    page.evaluate = async fn => {
      calls.evaluations.push({ page, fn })
      return Object.hasOwn(script, 'identity') ? script.identity : IDENTITY
    }
    // As in the browser: a closed page is gone from context.pages().
    page.close = async () => {
      calls.closedPages.push(page)
      context.open = context.open.filter(open => open !== page)
    }
    calls.pages.push(page)
    return page
  }
  const context = {
    ...emitter(), closed: 0, open: [makePage('first')]
  }
  context.pages = () => context.open
  context.newPage = async () => {
    calls.newPages++
    const page = makePage('later')
    context.open.push(page)
    context.emit('page', page)
    return page
  }
  context.newCDPSession = async page => {
    const session = {
      page, detached: 0, sends: [],
      async send(method, params) {
        session.sends.push({ method, params })
        calls.sent.push({ page, method, params })
        if (script.send) return script.send(method, params)
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 }
        return {}
      },
      async detach() { session.detached++ }
    }
    calls.sessions.push(session)
    return session
  }
  context.close = async () => { context.closed++; context.emit('close') }
  return {
    calls, context,
    chromium: {
      async launchPersistentContext(dataDir, options) {
        calls.launches.push({ dataDir, options })
        return context
      }
    }
  }
}

// What the first page was told to present.
const overrideOf = fake => fake.calls.sent.find(call => call.method === OVERRIDE && call.page.kind === 'first')
const windowBoundsOf = fake => fake.calls.sent
  .filter(call => call.method === 'Browser.setWindowBounds').map(call => call.params.bounds)

test('SIGNIN_HEADLESS_MODE is shell unless it says chrome, and refuses everything else', () => {
  assert.equal(parseHeadlessMode(undefined), 'shell')
  assert.equal(parseHeadlessMode(null), 'shell')
  assert.equal(parseHeadlessMode(''), 'shell')
  assert.equal(parseHeadlessMode('shell'), 'shell')
  assert.equal(parseHeadlessMode('chrome'), 'chrome')
  assert.equal(parseHeadlessMode(undefined, 'chrome'), 'chrome')
  // Read from an env file or Coolify: a value with no exact meaning is an error, not the shell.
  for (const wrong of ['chrom', 'Chrome', 'CHROME', 'headed', 'full', ' chrome', 'chrome ', 'true', '1']) {
    assert.throws(() => parseHeadlessMode(wrong), error => {
      assert.match(error.message, /SIGNIN_HEADLESS_MODE/)
      assert.ok(error.message.includes(wrong.trim()) || error.message.includes(JSON.stringify(wrong)))
      return true
    }, wrong)
  }
})

test('the default launches the headless shell and touches nothing else', async () => {
  const fake = fakeChromium()
  const context = await openContext({
    dataDir: '/profiles/a', proxy: 'http://p:8080', headless: true, launcher: fake.chromium
  })
  assert.equal(context, fake.context)
  assert.equal(fake.calls.launches.length, 1)
  const { options } = fake.calls.launches[0]
  assert.equal(options.channel, undefined)
  assert.equal(options.headless, true)
  assert.deepEqual(options.viewport, { width: 1280, height: 800 })
  assert.deepEqual(options.proxy, { server: 'http://p:8080' })
  // No identity read, no CDP: the page is whatever the shell makes of it.
  assert.equal(fake.calls.newPages, 0)
  assert.equal(fake.calls.sessions.length, 0)
  assert.equal(fake.calls.sent.length, 0)
  assert.equal(context.closed, 0)
})

test('chrome launches the full Chromium and presents it as a browser with a window', async () => {
  const fake = fakeChromium()
  const context = await openContext({
    dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
  })
  assert.equal(context, fake.context)
  assert.equal(fake.calls.launches[0].options.channel, 'chromium')
  assert.equal(context.closed, 0)

  // The identity came from a throwaway page, served by a route — the real
  // page was never navigated anywhere for it.
  assert.equal(fake.calls.newPages, 1)
  const [scratch] = fake.calls.closedPages
  assert.equal(scratch.kind, 'later')
  assert.deepEqual(fake.calls.routes, [{ page: scratch, url: '**/*', handler: fake.calls.routes[0].handler }])
  assert.deepEqual(fake.calls.gotos, [{
    page: scratch, url: IDENTITY_URL, options: { waitUntil: 'domcontentloaded' }
  }])
  assert.equal(fake.calls.evaluations.length, 1)
  assert.equal(fake.calls.evaluations[0].page, scratch)
  assert.deepEqual(fake.calls.gotos.filter(call => call.page.kind === 'first'), [])
  assert.equal(context.open.length, 1)

  // One word of the User-Agent changed; every hint is the browser's own, and nothing else is sent.
  const override = overrideOf(fake)
  assert.deepEqual(override.params, {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36',
    userAgentMetadata: HINTS
  })
  assert.deepEqual(override.params.userAgent, IDENTITY.userAgent.replace('HeadlessChrome', 'Chrome'))
  assert.doesNotMatch(override.params.userAgent, /Headless/i)

  // The window is framed as a headed one: larger than the viewport by the platform's frame.
  assert.deepEqual(fake.calls.sent.filter(call => call.method === 'Browser.getWindowForTarget')
    .map(call => call.page.kind), ['first'])
  assert.deepEqual(windowBoundsOf(fake), [
    { windowState: 'normal' },
    { width: 1280 + FRAME[0], height: 800 + FRAME[1] }
  ])

  // The session that set it stays for the life of the context, and goes with it.
  const session = fake.calls.sessions[0]
  assert.equal(session.page.kind, 'first')
  assert.equal(session.detached, 0)
  context.emit('close')
  assert.equal(session.detached, 1)
})

test('a page opened later in a chrome context is presented the same way', async () => {
  const fake = fakeChromium()
  const context = await openContext({
    dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
  })
  const later = await context.newPage()
  const overrides = fake.calls.sent.filter(call => call.method === OVERRIDE)
  assert.deepEqual(overrides.map(call => call.page.kind), ['first', 'later'])
  assert.deepEqual(overrides[1].params, overrides[0].params)
  // Its window is its own business: the frame was asked for the first page only.
  assert.deepEqual(fake.calls.sent.filter(call => call.page === later).map(call => call.method), [OVERRIDE])
  assert.equal(later.closed, undefined)
})

test('every hint is carried as the browser reported it, mobile included', async () => {
  const fake = fakeChromium({ identity: { ...IDENTITY, mobile: true, platformVersion: '6.1.0' } })
  await openContext({
    dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
  })
  assert.deepEqual(overrideOf(fake).params.userAgentMetadata, { ...HINTS, mobile: true, platformVersion: '6.1.0' })
})

test('a User-Agent that does not say HeadlessChrome goes out as it is', async () => {
  const fake = fakeChromium({ identity: {
    ...IDENTITY, userAgent: IDENTITY.userAgent.replace('HeadlessChrome', 'Chrome')
  } })
  await openContext({ dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium })
  assert.equal(overrideOf(fake).params.userAgent, IDENTITY.userAgent.replace('HeadlessChrome', 'Chrome'))
})

test('chrome mode means nothing to a browser with a window', async () => {
  const fake = fakeChromium()
  const context = await openContext({
    dataDir: '/profiles/a', proxy: null, headless: false, headlessMode: 'chrome', launcher: fake.chromium
  })
  assert.equal(fake.calls.launches[0].options.headless, false)
  assert.equal(fake.calls.launches[0].options.channel, undefined)
  assert.equal(fake.calls.newPages, 0)
  assert.equal(fake.calls.sent.length, 0)
  assert.equal(context.closed, 0)
})

test('a value that is not a mode is refused before any browser starts', async () => {
  const fake = fakeChromium()
  await assert.rejects(openContext({
    dataDir: '/profiles/a', proxy: null, headlessMode: 'chrom', launcher: fake.chromium
  }), /SIGNIN_HEADLESS_MODE/)
  assert.equal(fake.calls.launches.length, 0)
})

test('a browser that does not report its hints is closed and fails the launch', async () => {
  for (const identity of [
    undefined, {}, { ...IDENTITY, brands: undefined }, { ...IDENTITY, brands: [] },
    { ...IDENTITY, fullVersionList: [] }, { ...IDENTITY, platformVersion: undefined },
    { ...IDENTITY, mobile: undefined }, { ...IDENTITY, userAgent: 159 }
  ]) {
    const fake = fakeChromium({ identity })
    await assert.rejects(openContext({
      dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
    }), error => {
      assert.ok(error instanceof BrowserSigninError, String(error))
      assert.equal(error.code, 'browser_error')
      assert.match(error.message, /client hints/)
      return true
    }, JSON.stringify(identity))
    // Closed — a browser left open holds the profile against the next launch —
    // and nothing half-made was sent.
    assert.equal(fake.context.closed, 1)
    assert.equal(fake.calls.sent.length, 0)
    // The throwaway page is gone too.
    assert.deepEqual(fake.calls.closedPages.map(page => page.kind), ['later'])
  }
})

test('a refused override fails the launch the same way', async () => {
  const fake = fakeChromium({ send: method => {
    if (method === OVERRIDE) throw new Error('Protocol error (Emulation.setUserAgentOverride): Invalid parameters')
  } })
  await assert.rejects(openContext({
    dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
  }), error => {
    assert.equal(error.code, 'browser_error')
    assert.match(error.message, /present as Chrome: Protocol error/)
    return true
  })
  assert.equal(fake.context.closed, 1)
  assert.equal(fake.context.open.length, 1)
})

test('a window that will not resize costs the frame, not the launch', async () => {
  const fake = fakeChromium({ send: method => {
    if (method === 'Browser.setWindowBounds') throw new Error('Browser.setWindowBounds is not allowed')
  } })
  const context = await openContext({
    dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium
  })
  assert.equal(context, fake.context)
  assert.equal(context.closed, 0)
  assert.ok(overrideOf(fake), 'the override stands')
})

test('the resident pages on their own open with the shell, and pass on what they are given', async t => {
  const start = async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-identity-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
    const opens = []
    const signer = {
      async openContext(options) {
        opens.push(options)
        const page = { ...emitter(), exposeFunction: async () => {} }
        return { ...emitter(), pages: () => [page], cookies: async () => [], close: async () => {} }
      },
      async renew() {
        return { token: 'token', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
      }
    }
    const profileDir = () => path.join(dataDir, 'account-x')
    fs.mkdirSync(profileDir())
    return { opens, signer, profileDir, dataDir }
  }
  const open = residents => residents.acquire('a@example.invalid').then(entry => residents.release(entry))

  // Nothing said: the shell.
  const plain = await start(t)
  await open(createResidents({ signer: plain.signer, profileDir: plain.profileDir, keepAliveMs: 60000 }))
  assert.deepEqual(plain.opens.map(options => [options.headless, options.headlessMode]), [[true, 'shell']])

  // Something said: exactly that, for a resident page as for any other launch.
  const told = await start(t)
  const residents = createResidents({
    signer: told.signer, profileDir: told.profileDir, headless: false, headlessMode: 'chrome', keepAliveMs: 60000
  })
  await open(residents)
  assert.deepEqual(told.opens.map(options => [options.headless, options.headlessMode]), [[false, 'chrome']])
  assert.equal(told.opens[0].proxy, null)
  assert.equal(told.opens[0].dataDir, told.profileDir())
})

// One worker on a loopback port, with a signer that records its launches.
async function startWorker(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-identity-'))
  const opens = []
  const signer = {
    async openContext(contextOptions) {
      opens.push(contextOptions)
      const page = { ...emitter(), exposeFunction: async () => {}, evaluate: async () => { throw new Error('not reached') } }
      return { ...emitter(), pages: () => [page], cookies: async () => [], close: async () => {} }
    },
    async signin() {
      return { token: 'token', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
    },
    // The lazy open ends here: what the tests read is the launch before it.
    async renew() { throw new BrowserSigninError('session_expired', 'no session') }
  }
  const server = createServer({ dataDir, token: 'secret', signer, minLoginIntervalMs: 1, ...options })
  t.after(async () => {
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const post = async (route, payload) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json() }
  }
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json()
  // A persisted profile is what asks /egress for a resident page.
  const withProfile = email => fs.mkdirSync(path.join(dataDir,
    'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)), { recursive: true })
  return { opens, post, health, withProfile }
}

const EMAIL = 'a@example.invalid'
// A login (a browser of its own while there is no page) and a lazy page open:
// the two ways the worker launches a browser.
const bothLaunches = async worker => {
  assert.equal((await worker.post('/session', { email: EMAIL, password: 'pw' })).status, 200)
  worker.withProfile(EMAIL)
  const refused = await worker.post('/egress', { email: EMAIL, url: '/api/v2/chats/new', method: 'POST' })
  assert.equal(refused.status, 422, JSON.stringify(refused.body))
  assert.equal(refused.body.code, 'session_expired')
}

test('the worker hands the headless mode to every launch it makes', async t => {
  // Default: the shell, for a login and for a resident page alike.
  const shell = await startWorker(t)
  await bothLaunches(shell)
  assert.deepEqual(shell.opens.map(options => [options.headless, options.headlessMode]), [[true, 'shell'], [true, 'shell']])
  assert.deepEqual(await shell.health(), {
    ok: true, sessions: 1, residentPages: 0, maxResidentPages: 16, headless: true, headlessMode: 'shell'
  })

  // Chrome by override, and reported where a flip is verified.
  const chrome = await startWorker(t, { headlessMode: 'chrome' })
  await bothLaunches(chrome)
  assert.deepEqual(chrome.opens.map(options => [options.headless, options.headlessMode]), [[true, 'chrome'], [true, 'chrome']])
  assert.equal((await chrome.health()).headlessMode, 'chrome')
})

test('SIGNIN_HEADLESS_MODE is read from the environment', async t => {
  const previous = process.env.SIGNIN_HEADLESS_MODE
  t.after(() => {
    if (previous === undefined) delete process.env.SIGNIN_HEADLESS_MODE
    else process.env.SIGNIN_HEADLESS_MODE = previous
  })
  delete process.env.SIGNIN_HEADLESS_MODE
  assert.equal((await (await startWorker(t)).health()).headlessMode, 'shell')
  process.env.SIGNIN_HEADLESS_MODE = 'chrome'
  assert.equal((await (await startWorker(t)).health()).headlessMode, 'chrome')
})

test('a browser with a window has no headless mode to report', async t => {
  const headed = await startWorker(t, { headless: false, headlessMode: 'chrome' })
  assert.equal((await headed.post('/session', { email: EMAIL, password: 'pw' })).status, 200)
  assert.equal(headed.opens[0].headless, false)
  assert.deepEqual(await headed.health(), {
    ok: true, sessions: 1, residentPages: 0, maxResidentPages: 16, headless: false, headlessMode: null
  })
})

test('a SIGNIN_HEADLESS_MODE the worker does not know stops it at start', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-identity-'))
  const previous = process.env.SIGNIN_HEADLESS_MODE
  t.after(() => {
    if (previous === undefined) delete process.env.SIGNIN_HEADLESS_MODE
    else process.env.SIGNIN_HEADLESS_MODE = previous
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  process.env.SIGNIN_HEADLESS_MODE = 'chrom'
  assert.throws(() => createServer({ dataDir }), /SIGNIN_HEADLESS_MODE.*chrom/)
})
