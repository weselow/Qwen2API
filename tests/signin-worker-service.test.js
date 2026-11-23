const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createServer } = require('../signin-worker/server')

// The worker HTTP contract with a fake browser module: no Chromium anywhere
// near CI. The fake records what the server hands to the "browser" so the
// tests can assert profile isolation, serialization and renewal behavior.
function fakeSigner(script = {}) {
  const calls = []
  let generation = 0
  const signer = {
    calls,
    async openContext(options) {
      calls.push({ op: 'open', ...options })
      return {
        async close() { calls.push({ op: 'close' }) },
        pages: () => []
      }
    },
    async signin(context, { email, password }) {
      calls.push({ op: 'signin', email, password })
      if (script.signin) return script.signin({ email, generation: ++generation })
      return { token: `token-${email}-1`, exp: Math.floor(Date.now() / 1000) + 3600,
        cookies: [{ name: 'cna', value: String(generation), domain: 'chat.qwen.ai', path: '/' }] }
    },
    async renew(context) {
      calls.push({ op: 'renew' })
      if (script.renew) return script.renew({ generation: ++generation })
      return { token: `token-renewed-${generation}`, exp: Math.floor(Date.now() / 1000) + 3600,
        cookies: [{ name: 'cna', value: `r${generation}`, domain: 'chat.qwen.ai', path: '/' }] }
    }
  }
  return signer
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    post: (pathName, payload, headers = {}) => fetch(`http://127.0.0.1:${port}${pathName}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload)
    }),
    get: pathName => fetch(`http://127.0.0.1:${port}${pathName}`)
  }
}

test('signin worker serves acquired sessions, silent renewals and structured failures', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-worker-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

  // 1. Happy path: acquire, then a cached renew that never touches the browser.
  const signer = fakeSigner()
  const server = createServer({ signer, dataDir, token: 'secret', minRenewDelayMs: 50 })
  const api = await listen(server)
  t.after(() => new Promise(resolve => server.close(resolve)))

  const health = await api.get('/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)

  const denied = await api.post('/session', { email: 'a@example.invalid', password: 'pw' })
  assert.equal(denied.status, 401)
  assert.equal((await denied.json()).code, 'unauthorized')
  const badRequest = await api.post('/session', { email: 'not-an-email', password: 'pw' },
    { authorization: 'Bearer secret' })
  assert.equal(badRequest.status, 400)

  const acquired = await api.post('/session',
    { email: 'a@example.invalid', password: 'pw', proxy: 'http://p:8080' }, { authorization: 'Bearer secret' })
  assert.equal(acquired.status, 200)
  const session = await acquired.json()
  assert.equal(session.token, 'token-a@example.invalid-1')
  assert.ok(Number.isFinite(session.expiresAt))
  assert.deepEqual(session.cookies.map(cookie => cookie.name), ['cna'])
  // The profile directory is a hash: emails never become paths or log lines.
  const openCall = signer.calls.find(call => call.op === 'open')
  assert.match(openCall.dataDir, /account-[0-9a-f]{32}$/)
  assert.equal(openCall.dataDir.includes('a@example.invalid'), false)
  assert.equal(openCall.proxy, 'http://p:8080')
  assert.equal(signer.calls.filter(call => call.op === 'close').length, 1)

  // Cached renew: fresh TTL means no browser launch at all.
  const cached = await api.post('/renew', { email: 'a@example.invalid' }, { authorization: 'Bearer secret' })
  assert.equal(cached.status, 200)
  assert.equal((await cached.json()).token, session.token)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)

  // Unknown account without a persisted profile.
  const missing = await api.post('/renew', { email: 'ghost@example.invalid' }, { authorization: 'Bearer secret' })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'no_profile')

  // Invalid credentials surface as a structured 401.
  const rejected = fakeSigner({
    signin: () => { const error = new Error('Qwen rejected the credentials.'); error.code = 'invalid_credentials'; throw error }
  })
  const rejectServer = createServer({ signer: rejected, dataDir })
  const rejectApi = await listen(rejectServer)
  t.after(() => new Promise(resolve => rejectServer.close(resolve)))
  const refused = await rejectApi.post('/session', { email: 'b@example.invalid', password: 'wrong' })
  assert.equal(refused.status, 401)
  assert.equal((await refused.json()).code, 'invalid_credentials')

  // 2. Live renewal after a cache miss (simulated worker restart): the
  // persisted profile directory is what authorizes /renew without a password.
  const profileHash = crypto.createHash('sha256').update('a@example.invalid').digest('hex').slice(0, 32)
  fs.mkdirSync(path.join(dataDir, 'account-' + profileHash), { recursive: true })
  const restarted = createServer({ signer, dataDir })
  const restartApi = await listen(restarted)
  t.after(() => new Promise(resolve => restarted.close(resolve)))
  const live = await restartApi.post('/renew', { email: 'a@example.invalid', proxy: 'http://p:8080' })
  assert.equal(live.status, 200)
  const liveSession = await live.json()
  assert.match(liveSession.token, /^token-renewed-/)
  assert.equal(signer.calls.some(call => call.op === 'renew'), true)
  // The caller (app) supplies the per-account proxy on every renew call.
  const renewOpen = signer.calls.filter(call => call.op === 'open').at(-1)
  assert.equal(renewOpen.proxy, 'http://p:8080')

  // 3. The silent renewal timer keeps the cache rotated without callers.
  const shortTtl = fakeSigner({
    signin: () => ({ token: 'short-1', exp: Math.floor(Date.now() / 1000) + 1,
      cookies: [{ name: 'cna', value: 's', domain: 'chat.qwen.ai', path: '/' }] }),
    renew: ({ generation }) => ({ token: `short-renewed-${generation}`, exp: Math.floor(Date.now() / 1000) + 3600,
      cookies: [{ name: 'cna', value: 'r', domain: 'chat.qwen.ai', path: '/' }] })
  })
  const timerServer = createServer({ signer: shortTtl, dataDir, minRenewDelayMs: 20, renewFraction: 0.5 })
  const timerApi = await listen(timerServer)
  t.after(() => new Promise(resolve => timerServer.close(resolve)))
  const short = await timerApi.post('/session', { email: 't@example.invalid', password: 'pw' })
  assert.equal(short.status, 200)
  await new Promise(resolve => setTimeout(resolve, 700))
  const afterTimer = await timerApi.post('/renew', { email: 't@example.invalid' })
  assert.equal((await afterTimer.json()).token, 'short-renewed-2')
})

test('signin worker serializes browser launches per account profile', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-worker-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

  const launches = []
  let active = 0
  let maxConcurrent = 0
  const signer = {
    async openContext(options) {
      active++
      maxConcurrent = Math.max(maxConcurrent, active)
      launches.push(options.dataDir)
      await new Promise(resolve => setTimeout(resolve, 80))
      return { async close() { active-- }, pages: () => [] }
    },
    async signin() {
      return { token: 'serial', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
    },
    async renew() { return { token: 'serial', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] } }
  }
  // Two /session for one account would just join into one sign-in (that is
  // signin-worker-pacing.test.js's subject), so the lock is raced with the
  // other flow that launches on the profile: a live renewal. Login pacing is
  // off, leaving the bare rule.
  const email = 'same@example.invalid'
  const profileHash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
  const expectedDir = path.join(dataDir, 'account-' + profileHash)
  fs.mkdirSync(expectedDir, { recursive: true })
  const server = createServer({ signer, dataDir, minRenewDelayMs: 60000, minLoginIntervalMs: 1 })
  const api = await listen(server)
  t.after(() => new Promise(resolve => server.close(resolve)))

  const [signedIn, renewed] = await Promise.all([
    api.post('/session', { email, password: 'pw', force: true }),
    api.post('/renew', { email })
  ])
  assert.deepEqual([signedIn.status, renewed.status], [200, 200])
  // Chromium locks a profile directory: the two launches must not overlap.
  assert.equal(maxConcurrent, 1)
  assert.deepEqual(launches, [expectedDir, expectedDir])
})
