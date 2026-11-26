const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
      return script.renew ? script.renew()
        : { token: 'token-renewed', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
    }
  }
}

const harvest = email => ({ token: `token-${email}`, exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] })

async function start(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-pacing-'))
  const server = createServer({ dataDir, minRenewDelayMs: 60000, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  // A request that is never answered fails its test in ten seconds, saying so — not on the gate's
  // timeout, minutes later, with every test behind it cancelled.
  const post = (pathName, payload) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
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
  const gap = jittered.admit().at - base.at
  assert.ok(gap > 1998 && gap <= 2000, `${gap}ms: one interval plus up to one more, and no more`)
})

test('a slot that would be waited for longer than the budget is refused at once and stays free', () => {
  // Slots are compared by their moments, never by waitMs: a millisecond that
  // ticks between two calls shaves it off the wait and nothing else.
  const pacer = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 1500, random: () => 0 })
  const first = pacer.admit()
  assert.equal(pacer.admit().at - first.at, 1000)
  // Third in line: 2000 ms. Refused, and told when a slot would be theirs.
  const refused = refusals(pacer)
  assert.equal(refused.code, 'signin_paced')
  assert.ok(refused.retryAfterMs > 1900 && refused.retryAfterMs <= 2000)
  // The refusal reserved nothing: the next request finds the same slot, not
  // one pushed out by a sign-in that will never run.
  assert.ok(Math.abs(refusals(pacer).retryAfterMs - refused.retryAfterMs) <= 10)

  const roomier = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 2500, random: () => 0 })
  const base = roomier.admit()
  assert.deepEqual([roomier.admit(), roomier.admit()].map(slot => slot.at - base.at), [1000, 2000])
  const unbounded = createLoginPacer({ minIntervalMs: 1000, maxWaitMs: 0, random: () => 0 })
  const start = unbounded.admit()
  assert.equal([unbounded.admit(), unbounded.admit()].at(-1).at - start.at, 2000)
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
  assert.equal(second.at - first.at, 200)
  // The first launches its browser before its flow reaches the page: by then
  // its own slot, and the second's, are both in the past.
  await sleep(300)
  await pacer.enter(first)
  const held = Date.now()
  await pacer.enter(second)
  // The first began at +300, so the second waits until +500.
  assert.ok(Date.now() - held >= 200 - SLOP)
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

// An interval with room to spare over the budget (maxLoginWaitMs, 250 in the tests that refuse).
// What a request is refused over is the gap after the sign-in ahead of it, less how much later it
// arrived — and the gap is never below the interval. So with 3000 against 250 the refusal holds
// while the request reaches the worker up to 2750 ms after the slot it would wait for was taken,
// whatever the jitter and whatever the runner is doing. With 300 against 250 it held for 50 ms.
const ROOMY_INTERVAL_MS = 3000

test('a cached answer takes no slot: it delays nobody and is never refused', async t => {
  const signer = fakeSigner()
  const { post } = await start(t, { signer, minLoginIntervalMs: ROOMY_INTERVAL_MS, maxLoginWaitMs: 250 })
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
  // The first sign-in stays where it is until the test lets it go: when the second arrives, the slot is taken for good.
  let letGo = () => {}
  const signer = fakeSigner({
    signin: email => email === 'first@example.invalid'
      ? new Promise(resolve => { letGo = () => resolve(harvest(email)) })
      : harvest(email)
  })
  const minLoginIntervalMs = 600
  const maxLoginWaitMs = 250
  const { post } = await start(t, { signer, minLoginIntervalMs, maxLoginWaitMs })
  const signIns = () => signer.calls.filter(call => call.op === 'signin')
  const first = post('/session', { email: 'first@example.invalid', password: 'pw' })
  // One at a time: the second goes out once the first is in its sign-in, so it holds the only slot
  // there is. (Sent together, the two arrive however a loaded runner likes. By that this test
  // used to fail, 2026-11-25: the second a few milliseconds late made its wait look too short.)
  await until(() => signIns().length === 1)
  const second = await post('/session', { email: 'second@example.invalid', password: 'pw' })
  const answeredAt = Date.now()
  letGo()
  assert.equal((await first).status, 200)
  assert.equal(second.status, 429, `the second was answered ${second.status}: its wait for a slot was not refused`)
  const failure = await second.json()
  assert.equal(failure.code, 'signin_paced')
  // What the second would have waited: the gap after the first sign-in — one interval and up to one
  // more of jitter — less the moment it came later than that. So more than the budget, which is the
  // refusal; and never more than two intervals. Where the low end falls is not this test's to say:
  // how much of it is jitter and how much the late arrival, the worker does not tell. The gap itself
  // is the pacer's, and is measured above with the jitter held still.
  assert.ok(failure.retryAfterMs > maxLoginWaitMs,
    `${failure.retryAfterMs}ms: a wait within the budget is made, not refused`)
  assert.ok(failure.retryAfterMs <= 2 * minLoginIntervalMs,
    `${failure.retryAfterMs}ms: more than two intervals`)
  assert.equal(signIns().length, 1, 'the refusal signed nobody in')

  // A caller that comes back after the retry delay gets its slot — and at once, not an interval later.
  await sleep(failure.retryAfterMs)
  const retried = await post('/session', { email: 'third@example.invalid', password: 'pw' })
  assert.equal(retried.status, 200, `the third was answered ${retried.status} after waiting the delay it was told`)
  assert.equal(signIns().length, 2)
  const lateBy = signIns()[1].at - answeredAt - failure.retryAfterMs
  assert.ok(lateBy < minLoginIntervalMs,
    `the third sign-in began ${lateBy}ms after the delay it was told: the delay named is not the delay kept`)
})

test('a session that turned live while the request waited for its slot answers without a sign-in', async t => {
  const signer = fakeSigner()
  const { post, dataDir } = await start(t, { signer, minLoginIntervalMs: 300, maxLoginWaitMs: 1000 })
  await (await post('/session', { email: 'first@example.invalid', password: 'pw' })).json()
  const email = 'waiting@example.invalid'
  // A persisted profile is what authorizes /renew without a password.
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
  fs.mkdirSync(path.join(dataDir, 'account-' + hash), { recursive: true })

  // In line behind the first sign-in...
  const waiting = post('/session', { email, password: 'pw' })
  // ...and while it waits, a live renewal of the same account settles a session.
  const renewed = await post('/renew', { email })
  assert.equal(renewed.status, 200)

  const answered = await waiting
  assert.equal(answered.status, 200)
  assert.equal((await answered.json()).token, 'token-renewed')
  assert.equal(signer.calls.filter(call => call.op === 'signin').length, 1)
})

test('the interval holds between real starts: a sign-in delayed by its profile still spaces the next one', async t => {
  const release = []
  const signer = fakeSigner({
    renew: () => new Promise(resolve => { release.push(() => resolve({ token: 'renewed', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] })) })
  })
  const { post, dataDir } = await start(t, { signer, minLoginIntervalMs: 300, maxLoginWaitMs: 1000 })
  const delayed = 'delayed@example.invalid'
  const hash = crypto.createHash('sha256').update(delayed).digest('hex').slice(0, 32)
  fs.mkdirSync(path.join(dataDir, 'account-' + hash), { recursive: true })

  // A renewal holds the account's profile...
  const renewing = post('/renew', { email: delayed })
  await until(() => release.length === 1)
  // ...so its sign-in, admitted at once, cannot reach the page for a while.
  const held = post('/session', { email: delayed, password: 'pw', force: true })
  await sleep(450)
  const following = post('/session', { email: 'following@example.invalid', password: 'pw' })
  for (const finish of release) finish()

  const answers = await Promise.all([held, following, renewing])
  assert.deepEqual(answers.map(response => response.status), [200, 200, 200])
  const starts = signer.calls.filter(call => call.op === 'signin').map(call => call.at).sort((a, b) => a - b)
  assert.equal(starts.length, 2)
  // Spaced from the delayed sign-in's real start, not from the slot it was
  // handed half a second earlier.
  assert.ok(starts[1] - starts[0] >= 300 - SLOP, `${starts[1] - starts[0]}ms between the real starts`)
})

test('a rejected sign-in takes a slot too: failed attempts are what the WAF counts', async t => {
  const signer = fakeSigner({
    signin: () => { throw new Error('Sign-in did not leave the auth page.'); }
  })
  const { post } = await start(t, { signer, minLoginIntervalMs: ROOMY_INTERVAL_MS, maxLoginWaitMs: 250 })
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
