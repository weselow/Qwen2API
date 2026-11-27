const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { createServer } = require('../signin-worker/server')
const { openContext, BrowserSigninError } = require('../signin-worker/lib/browser-signin')
const { parseHeadlessMode, presentedUserAgent } = require('../signin-worker/lib/browser-identity')
const { createResidents } = require('../signin-worker/lib/resident-pages')

const AUTH = { authorization: 'Bearer secret' }

// What the full Chromium calls itself when it is launched headless on Linux
// and left alone, as measured in the worker's image (Qwen2API-3ue.4).
const STOCK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/159.0.0.0 Safari/537.36'
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
 * A fake "Playwright" in the jik.3 mold: every launch makes a context of its
 * own, whose pages record what the worker does. What the browser answers when
 * it is asked for its User-Agent is scripted; whether the real browser answers
 * at all is the real browser's smoke to show (tools/worker-egress-local-smoke.js).
 */
function fakeChromium(script = {}) {
  const calls = { launches: [], contexts: [], evaluations: [], sent: [], sessions: [], newPages: 0 }
  const makeContext = () => {
    const page = { ...emitter() }
    page.evaluate = async fn => {
      calls.evaluations.push({ page, fn })
      return Object.hasOwn(script, 'userAgent') ? script.userAgent : STOCK
    }
    // A fresh context opens with a page; `firstPage: false` is for the one that is really launched.
    const context = {
      ...emitter(), closed: 0, open: script.firstPage === false && calls.contexts.length > 0 ? [] : [page]
    }
    context.pages = () => context.open
    context.newPage = async () => {
      calls.newPages++
      context.open.push(page)
      context.emit('page', page)
      return page
    }
    context.newCDPSession = async target => {
      const session = {
        page: target, detached: 0,
        async send(method, params) {
          calls.sent.push({ page: target, method, params })
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
    calls.contexts.push(context)
    return context
  }
  return {
    calls, script,
    chromium: {
      async launchPersistentContext(dataDir, options) {
        if (script.launch) await script.launch({ dataDir, options })
        // What the directory was when the browser was started on it.
        calls.launches.push({ dataDir, options, present: fs.existsSync(dataDir) })
        return makeContext()
      }
    }
  }
}

// One launch in the chrome mode: asks the browser for its User-Agent, then launches it.
const openChrome = (fake, extra = {}) => openContext({
  dataDir: '/profiles/a', proxy: null, headless: true, headlessMode: 'chrome', launcher: fake.chromium, ...extra
})
const boundsOf = fake => fake.calls.sent
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
  assert.equal(context, fake.calls.contexts[0])
  assert.equal(fake.calls.launches.length, 1)
  const { dataDir, options } = fake.calls.launches[0]
  assert.equal(dataDir, '/profiles/a')
  // Every option exactly as it was before the headless mode existed.
  assert.deepEqual(options, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    chromiumSandbox: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: { server: 'http://p:8080' },
    timeout: 30000
  })
  // No browser asked, no page opened, no CDP: the page is whatever the shell makes of it.
  assert.equal(fake.calls.evaluations.length, 0)
  assert.equal(fake.calls.newPages, 0)
  assert.equal(fake.calls.sessions.length, 0)
  assert.equal(fake.calls.sent.length, 0)
  assert.equal(context.closed, 0)
})

test('chrome asks the full Chromium what it calls itself, then launches it saying Chrome', async () => {
  const fake = fakeChromium()
  const context = await openChrome(fake, { proxy: 'http://p:8080', timeoutMs: 45000 })
  const [asking, real] = fake.calls.launches
  assert.equal(fake.calls.contexts.length, 2)

  // Asked on a throwaway profile — never the real one — started the same way
  // (headless, the full build) and with nothing else, and closed.
  assert.equal(asking.present, true)
  assert.notEqual(asking.dataDir, real.dataDir)
  assert.equal(fs.existsSync(asking.dataDir), false, 'the throwaway profile is removed')
  assert.deepEqual(asking.options, { headless: true, channel: 'chromium', chromiumSandbox: false, timeout: 45000 })
  assert.equal(fake.calls.evaluations.length, 1)
  assert.equal(fake.calls.evaluations[0].page, fake.calls.contexts[0].open[0])
  assert.equal(fake.calls.contexts[0].closed, 1)
  // It is asked in the page, for the User-Agent and nothing else.
  const { fn } = fake.calls.evaluations[0]
  assert.equal(vm.runInNewContext(`(${fn.toString()})`, { navigator: { userAgent: 'asked and answered' } })(), 'asked and answered')

  // The real launch: the full build, on the real profile, with one word of the
  // User-Agent changed — and Playwright's option is what carries it into every frame.
  assert.equal(real.dataDir, '/profiles/a')
  assert.deepEqual(real.options, {
    headless: true,
    channel: 'chromium',
    userAgent: STOCK.replace('HeadlessChrome', 'Chrome'),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    chromiumSandbox: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: { server: 'http://p:8080' },
    timeout: 45000
  })
  // Nothing was done to the context for it: no page opened, nothing navigated, no override sent.
  assert.equal(context, fake.calls.contexts[1])
  assert.equal(fake.calls.newPages, 0)
  assert.equal(context.closed, 0)
  assert.equal(fake.calls.sent.filter(call => call.method.startsWith('Emulation.')).length, 0)

  // The window is framed as a headed one: larger than the viewport by the platform's frame.
  assert.deepEqual(fake.calls.sent.map(call => call.method),
    ['Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Browser.setWindowBounds'])
  assert.deepEqual(boundsOf(fake), [
    { windowState: 'normal' },
    { width: 1280 + FRAME[0], height: 800 + FRAME[1] }
  ])
  // The session was only ever for that.
  assert.equal(fake.calls.sessions.length, 1)
  assert.equal(fake.calls.sessions[0].page, context.open[0])
  assert.equal(fake.calls.sessions[0].detached, 1)
})

test('the User-Agent is asked for once per browser, not once per launch', async () => {
  const fake = fakeChromium()
  await openChrome(fake)
  await openChrome(fake)
  await openChrome(fake, { proxy: 'socks5://127.0.0.1:1080' })
  assert.deepEqual(fake.calls.launches.map(launch => launch.options.userAgent === undefined),
    [true, false, false, false])
  assert.equal(fake.calls.evaluations.length, 1)
  // Another browser (another Playwright, in a test) is asked in its turn.
  const other = fakeChromium({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/160.0.0.0 Safari/537.36' })
  await openChrome(other)
  assert.equal(other.calls.launches.length, 2)
  assert.equal(other.calls.launches[1].options.userAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/160.0.0.0 Safari/537.36')
})

test('a context that opens without a page gets one, for its window', async () => {
  const fake = fakeChromium({ firstPage: false })
  const context = await openChrome(fake)
  assert.equal(fake.calls.newPages, 1, 'the real context had no page to size')
  assert.equal(fake.calls.sessions[0].page, context.open[0])
  assert.equal(context.closed, 0)
})

test('a User-Agent that is not a browser\'s fails the launch before the real profile is touched', async () => {
  for (const userAgent of [undefined, null, '', 159, {}, 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0',
    'HeadlessChrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome']) {
    const fake = fakeChromium({ userAgent })
    await assert.rejects(openChrome(fake), error => {
      assert.ok(error instanceof BrowserSigninError, String(error))
      assert.equal(error.code, 'browser_error')
      assert.match(error.message, /^Could not make the browser present as Chrome: The browser did not report its User-Agent\.$/)
      return true
    }, String(userAgent))
    // The real profile was never launched on; the throwaway one is closed and gone.
    assert.equal(fake.calls.launches.length, 1)
    assert.equal(path.dirname(fake.calls.launches[0].dataDir), os.tmpdir().replace(/[\\/]+$/, ''))
    assert.ok(path.basename(fake.calls.launches[0].dataDir).startsWith('signin-worker-identity-'))
    assert.equal(fake.calls.contexts.length, 1)
    assert.equal(fake.calls.contexts[0].closed, 1)
    assert.equal(fs.existsSync(fake.calls.launches[0].dataDir), false)
    assert.equal(fake.calls.sent.length, 0)
    // A reading that failed is not kept: the next launch asks again.
    fake.script.userAgent = STOCK
    const context = await openChrome(fake)
    assert.equal(context.closed, 0)
    assert.equal(fake.calls.launches.length, 3)
    assert.equal(fake.calls.launches[2].options.userAgent, STOCK.replace('HeadlessChrome', 'Chrome'))
  }
})

test('a browser that cannot be started to be asked fails the launch the same way', async () => {
  const fake = fakeChromium({ launch: async ({ options }) => {
    if (options.userAgent === undefined) throw new Error('Executable doesn\'t exist at /opt/pw-browsers/chromium-1255')
  } })
  await assert.rejects(openChrome(fake), error => {
    assert.equal(error.code, 'browser_error')
    assert.equal(error.message, 'Could not make the browser present as Chrome: Executable doesn\'t exist at /opt/pw-browsers/chromium-1255')
    return true
  })
  assert.equal(fake.calls.launches.length, 0)
  assert.equal(fake.calls.contexts.length, 0)
})

test('a throwaway profile that will not delete costs nothing', async t => {
  const remove = fs.rmSync
  fs.rmSync = (target, options) => {
    if (String(target).includes('signin-worker-identity-')) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    return remove(target, options)
  }
  t.after(() => { fs.rmSync = remove })
  const fake = fakeChromium()
  const context = await openChrome(fake)
  assert.equal(context.closed, 0)
  assert.equal(fake.calls.contexts[0].closed, 1)
  // Not this test's to leave behind: removed once it can be.
  fs.rmSync = remove
  remove(fake.calls.launches[0].dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('only the one word of the User-Agent changes', () => {
  assert.equal(presentedUserAgent(STOCK), STOCK.replace('HeadlessChrome', 'Chrome'))
  // A browser that does not say HeadlessChrome goes out as it is.
  const headed = STOCK.replace('HeadlessChrome', 'Chrome')
  assert.equal(presentedUserAgent(headed), headed)
})

test('chrome mode means nothing to a browser with a window', async () => {
  const fake = fakeChromium()
  const context = await openChrome(fake, { headless: false })
  assert.equal(fake.calls.launches.length, 1, 'nobody was asked')
  assert.equal(fake.calls.launches[0].options.headless, false)
  assert.equal(fake.calls.launches[0].options.channel, undefined)
  assert.equal(fake.calls.launches[0].options.userAgent, undefined)
  assert.equal(fake.calls.evaluations.length, 0)
  assert.equal(fake.calls.sent.length, 0)
  assert.equal(context.closed, 0)
})

test('a value that is not a mode is refused before any browser starts', async () => {
  const fake = fakeChromium()
  await assert.rejects(openChrome(fake, { headlessMode: 'chrom' }), /SIGNIN_HEADLESS_MODE/)
  assert.equal(fake.calls.launches.length, 0)
})

test('a window that will not resize costs the frame, not the launch', async () => {
  const fake = fakeChromium({ send: method => {
    if (method === 'Browser.getWindowForTarget') throw new Error('Browser.getWindowForTarget is not allowed')
  } })
  const context = await openChrome(fake)
  assert.equal(context, fake.calls.contexts[1])
  assert.equal(context.closed, 0)
  assert.deepEqual(boundsOf(fake), [])
  // It still says Chrome.
  assert.equal(fake.calls.launches[1].options.userAgent, STOCK.replace('HeadlessChrome', 'Chrome'))
})

test('the resident pages on their own open with the shell, and pass on what they are given', async t => {
  const start = async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-identity-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
    const opens = []
    const signer = {
      async openContext(options) {
        opens.push(options)
        // A page is asked one thing as it opens (the front end's version, for the log).
        const page = { ...emitter(), exposeFunction: async () => {}, evaluate: async () => '' }
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
  // The queue that keeps the page loads of every account apart (Qwen2API-nch) is off: signin-worker-pacing.test.js measures it.
  const server = createServer({ dataDir, token: 'secret', signer, minLoginIntervalMs: 1, loadMinIntervalMs: 1, ...options })
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
    ok: true, sessions: 1, residentPages: 0, maxResidentPages: 16, headless: true, headlessMode: 'shell',
    // Reported where a flip is verified, as the mode is (Qwen2API-xun, Qwen2API-nch); the queue of page loads is off in these tests.
    pageTokenRefresh: true, streamWaitMs: 20000, loadMinIntervalMs: 1, loadMaxWaitMs: 120000,
    pageLoadQueue: { waiting: 0, nextInMs: 0 }, forgetDeletesProfile: false, forgetGraceMs: 120000
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
    ok: true, sessions: 1, residentPages: 0, maxResidentPages: 16, headless: false, headlessMode: null,
    pageTokenRefresh: true, streamWaitMs: 20000, loadMinIntervalMs: 1, loadMaxWaitMs: 120000,
    pageLoadQueue: { waiting: 0, nextInMs: 0 }, forgetDeletesProfile: false, forgetGraceMs: 120000
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
