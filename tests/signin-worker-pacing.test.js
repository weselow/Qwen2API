const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createServer } = require('../signin-worker/server')
const { createLoginPacer } = require('../signin-worker/lib/login-pacer')

// Full logins are deduplicated and paced (Qwen2API-43a): one "add account"
// must not reach qwen.ai as three sign-ins, and a bulk import must not reach
// it as a burst. No browser anywhere near CI: the fake signer records when
// each sign-in began, so the tests can count and measure them.

// Timers never fire early and may fire a millisecond or two late.
const SLOP = 5
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

function fakeSigner(script = {}) {
  const calls = []
  const contexts = []
  let generation = 0
  return {
    calls,
    contexts,
    async openContext(options) {
      calls.push({ op: 'open', ...options })
      const context = { async close() { calls.push({ op: 'close' }) }, pages: () => [] }
      contexts.push(context)
      return context
    },
    async signin(context, { email }) {
      calls.push({ op: 'signin', email, at: Date.now() })
      // One token per sign-in, so tests can tell sign-ins apart.
      return script.signin ? script.signin(email, ++generation)
        : { token: `token-${email}-${++generation}`, exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
    },
    async renew() {
      calls.push({ op: 'renew', at: Date.now() })
      return { token: 'token-renewed', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
    }
  }
}

const harvest = email => ({ token: `token-${email}`, exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] })

async function start(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-pacing-'))
  const server = createServer({ dataDir, minRenewDelayMs: 60000, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const post = (pathName, payload) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  })
  t.after(async () => {
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { post, dataDir, server }
}

const refusals = pacer => {
  try {
    pacer.admit()
  } catch (error) {
    return error
  }
  throw new Error('expected the pacer to refuse the slot')
}

test('login pacer hands out slots one interval apart, plus jitter', () => {
  const even = createLoginPacer({ minIntervalMs: 1000, random: () => 0 })
  const first = even.admit()
  assert.equal(first.waitMs, 0)
  assert.equal(even.admit().at - first.at, 1000)
  assert.equal(even.admit().at - first.at, 2000)

  // The jitter is up to the interval again: a burst never looks metronomic.
  const jittered = createLoginPacer({ minIntervalMs: 1000, random: () => 0.999 })
  const base = jittered.admit()
  assert.ok(jittered.admit().at - base.at > 1998)
})

test('a slot that would be waited for longer than the budget is refused at once and stays free', () => {
  const pacer = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 1500, random: () => 0 })
  pacer.admit()
  assert.equal(pacer.admit().waitMs, 1000)
  // Third in line: 2000 ms. Refused, and told when a slot would be theirs.
  assert.equal(refusals(pacer).code, 'signin_paced')
  assert.equal(refusals(pacer).retryAfterMs, 2000)
  // The refusal reserved nothing: the next request finds the same slot, not
  // one pushed out by a sign-in that will never run.
  assert.equal(refusals(pacer).retryAfterMs, 2000)

  const roomier = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 2500, random: () => 0 })
  assert.deepEqual([roomier.admit(), roomier.admit(), roomier.admit()].map(slot => slot.waitMs), [0, 1000, 2000])
  const unbounded = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 0, random: () => 0 })
  assert.equal([unbounded.admit(), unbounded.admit(), unbounded.admit()].at(-1).waitMs, 2000)
})

test('pacing off: every sign-in may start at once', async () => {
  const pacer = createLoginPacer({ minIntervalMs: 0 })
  assert.deepEqual([pacer.admit(), pacer.admit()],
    [{ at: 0, waitMs: 0, spacing: 0 }, { at: 0, waitMs: 0, spacing: 0 }])
  await pacer.enter({ at: 0, waitMs: 0 })
  await pacer.enter({ at: 0, waitMs: 0 })
})

test('a sign-in holds when the one before it began later than its own slot', async () => {
  const pacer = createLoginPacer({ minIntervalMs: 200, random: () => 0 })
  const first = pacer.admit()
  const second = pacer.admit()
  assert.equal(second.waitMs, 200)
  // The first launches its browser before its flow reaches the page.
  await sleep(100)
  await pacer.enter(first)
  const held = Date.now()
  await pacer.enter(second)
  // Second's slot was at +200; the first began at +100, so it waits until +300.
  assert.ok(Date.now() - held >= 100 - SLOP)
})

test('/session answers from the live harvested session instead of signing in again', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: 1 })
  const email = 'live@example.invalid'
  const signIns = () => signer.calls.filter(call => call.op === 'signin')

  const acquired = await post('/session', { email, password: 'pw' })
  assert.equal(acquired.status, 200)
  const session = await acquired.json()

  // The same account asked for again while the session is live: no browser.
  const again = await post('/session', { email, password: 'pw' })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).token, session.token)
  assert.equal(signIns().length, 1)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)

  // force is what asks for a real sign-in from a cached session (one that
  // was just refused upstream).
  const forced = await post('/session', { email, password: 'pw', force: true })
  assert.equal(forced.status, 200)
  assert.notEqual((await forced.json()).token, session.token)
  assert.equal(signIns().length, 2)
})

test('a cached answer takes no slot: it delays nobody and is never refused', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: 300, maxLoginWaitMs: 250 })
  const email = 'warm@example.invalid'
  await (await post('/session', { email, password: 'pw' })).json()

  // The slot is taken: another account would have to wait a whole interval.
  const again = await post('/session', { email, password: 'pw' })
  assert.equal(again.status, 200)
  const other = await post('/session', { email: 'cold@example.invalid', password: 'pw' })
  assert.equal(other.status, 429)
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 1)
})

test('a stale session does not answer /session: the password signs in again', async t => {
  const signer = fakeSigner({
    signin: email => ({ token: `short-${email}`, exp: Math.floor(Date.now() / 1000) + 30, cookies: [] })
  })
  const { post } = await start(t, { signer, minLoginIntervalMs: 1 })
  const email = 'short@example.invalid'
  await (await post('/session', { email, password: 'pw' })).json()
  const renewed = await post('/session', { email, password: 'pw' })
  assert.equal(renewed.status, 200)
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 2)
})

test('force must be a boolean', async t => {
  const { post } = await start(t, { signer: fakeSigner() })
  const refused = await post('/session', { email: 'a@example.invalid', password: 'pw', force: 'yes' })
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).code, 'invalid_request')
})

test('concurrent /session for one account is one sign-in, however many callers wait for it', async t => {
  const release = []
  const signer = fakeSigner({
    signin: email => new Promise(resolve => { release.push(() => resolve(harvest(email))) })
  })
  // A tight budget makes a caller that signs in on its own fail fast (429)
  // instead of hanging the test for a whole interval.
  const { post, server } = await start(t, { signer, minLoginIntervalMs: 60000, maxLoginWaitMs: 500 })
  const email = 'burst@example.invalid'
  // The 23.11 prod burst: three /session in 4 s for one "add account".
  const arrived = new Promise(resolve => {
    let seen = 0
    server.on('request', req => { if (req.url === '/session' && ++seen === 3) resolve() })
  })
  const waiting = [
    post('/session', { email, password: 'pw' }),
    post('/session', { email, password: 'pw' }),
    post('/session', { email, password: 'pw' })
  ]
  await arrived
  await until(() => release.length === 1)
  // Let the other two reach the sign-in that is in flight for them.
  await sleep(100)
  for (const finish of release) finish()

  const sessions = await Promise.all((await Promise.all(waiting)).map(response => response.json()))
  assert.equal(new Set(sessions.map(session => session.token)).size, 1)
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 1)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 1)
})

test('callers that joined a failed sign-in share its failure', async t => {
  const release = []
  const signer = {
    calls: [],
    async openContext() { return { async close() {}, pages: () => [] } },
    async signin() {
      return new Promise((resolve, reject) => {
        release.push(() => {
          const error = new Error('Qwen rejected the credentials.')
          error.code = 'invalid_credentials'
          reject(error)
        })
      })
    }
  }
  const { post, server } = await start(t, { signer, minLoginIntervalMs: 60000, maxLoginWaitMs: 500 })
  const arrived = new Promise(resolve => {
    let seen = 0
    server.on('request', req => { if (req.url === '/session' && ++seen === 2) resolve() })
  })
  const waiting = [
    post('/session', { email: 'wrong@example.invalid', password: 'nope' }),
    post('/session', { email: 'wrong@example.invalid', password: 'nope' })
  ]
  await arrived
  await until(() => release.length === 1)
  await sleep(100)
  for (const finish of release) finish()

  const answers = await Promise.all(waiting)
  assert.deepEqual(answers.map(response => response.status), [401, 401])
  assert.equal((await answers[1].json()).code, 'invalid_credentials')
})

test('full sign-ins across accounts start at least minLoginIntervalMs apart', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: 60, maxLoginWaitMs: 1000 })
  const answers = await Promise.all(['a', 'b', 'c'].map(name =>
    post('/session', { email: `${name}@example.invalid`, password: 'pw' })))
  assert.deepEqual(answers.map(response => response.status), [200, 200, 200])

  const starts = signer.calls.filter(call => call.op === 'signin').map(call => call.at)
  assert.equal(starts.length, 3)
  assert.ok(starts[1] - starts[0] >= 60 - SLOP, `${starts[1] - starts[0]}ms between the first two`)
  assert.ok(starts[2] - starts[1] >= 60 - SLOP, `${starts[2] - starts[1]}ms between the last two`)
})

test('a sign-in that would wait past the budget is refused as signin_paced and signs nobody in', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: 300, maxLoginWaitMs: 250 })
  const [first, second] = await Promise.all([
    post('/session', { email: 'first@example.invalid', password: 'pw' }),
    post('/session', { email: 'second@example.invalid', password: 'pw' })
  ])
  // The second in line has a whole interval (300-600 ms) ahead: over budget.
  const [admitted, refused] = first.status === 200 ? [first, second] : [second, first]
  assert.equal(admitted.status, 200)
  assert.equal(refused.status, 429)
  const failure = await refused.json()
  assert.equal(failure.code, 'signin_paced')
  assert.ok(failure.retryAfterMs >= 300 - SLOP && failure.retryAfterMs < 600)
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 1)

  // A caller that comes back after the retry delay gets its slot.
  await sleep(failure.retryAfterMs)
  const retried = await post('/session', { email: 'third@example.invalid', password: 'pw' })
  assert.equal(retried.status, 200)
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 2)
})

test('a rejected sign-in takes a slot too: failed attempts are what the WAF counts', async t => {
  const signer = fakeSigner({
    signin: () => { throw new Error('Sign-in did not leave the auth page.'); }
  })
  const { post } = await start(t, { signer, minLoginIntervalMs: 300, maxLoginWaitMs: 250 })
  const rejected = await post('/session', { email: 'stuck@example.invalid', password: 'pw' })
  assert.equal(rejected.status, 500)
  const next = await post('/session', { email: 'next@example.invalid', password: 'pw' })
  assert.equal(next.status, 429)
  assert.equal((await next.json()).code, 'signin_paced')
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 1)
})

test('only full sign-ins are paced: a renewal runs at once', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: 60000, minCacheSeconds: 7200 })
  const email = 'renew@example.invalid'
  await (await post('/session', { email, password: 'pw' })).json()

  const started = Date.now()
  const renewed = await post('/renew', { email })
  assert.equal(renewed.status, 200)
  assert.match((await renewed.json()).token, /^token-renewed/)
  assert.ok(Date.now() - started < 5000, 'the renewal waited for a sign-in slot')
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
})
