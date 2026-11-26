const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createServer } = require('../signin-worker/server')
const { createLoginPacer } = require('../signin-worker/lib/login-pacer')
const { createPageLoadQueue } = require('../signin-worker/lib/page-load-queue')

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
  // Login pacing is measured by the tests that ask for it; the queue that
  // keeps the page loads of every account apart (Qwen2API-nch) likewise.
  const server = createServer({ dataDir, minRenewDelayMs: 60000, loadMinIntervalMs: 1, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  // A request that is never answered fails its test in ten seconds, saying so — not on the gate's
  // timeout, minutes later, with every test behind it cancelled.
  const post = (pathName, payload) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  })
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json()
  t.after(async () => {
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { post, health, dataDir, server }
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

// Since Qwen2API-nch and Qwen2API-ops (2026-11-26): every page qwen.ai is asked
// to serve the worker — a lazy open, a renewal, a sign-in — takes a turn in one
// queue (signin-worker/lib/page-load-queue.js). The worker's pages are like
// tabs: one reloading is a tab reloading, and sixteen within a second, as after
// a restart or in one tick of the app's renewal timer, is a burst from one
// address — what fed qwen.ai's risk score on 2026-11-21. Unlike the login
// pacer the queue never refuses: a page load is on the way of a call somebody
// is waiting for. (A renewal of an account with no page of its own is a load
// like any other: these renewals open a browser for it.)

// What the worker logs while `fn` runs.
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

// A persisted profile is what authorizes /renew without a password.
const withProfile = (dataDir, email) => {
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
  fs.mkdirSync(path.join(dataDir, 'account-' + hash), { recursive: true })
}
const renewal = (post, email) => post('/renew', { email })
// That every load but the first began at least `interval` after the one before it. Timers never fire early.
const spaced = (starts, interval, what = 'loads') => {
  assert.ok(starts.length >= 2, 'nothing to space')
  for (let at = 1; at < starts.length; at++) {
    assert.ok(starts[at] - starts[at - 1] >= interval - SLOP, `${starts[at] - starts[at - 1]}ms between the ${what} ${at - 1} and ${at}`)
  }
}

test('Qwen2API-nch: the page loads of every account start loadMinIntervalMs apart, and none is refused', { timeout: 10000 }, async t => {
  const signer = fakeSigner()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 100 })
  // One tick of the app's renewal timer, or the first requests after a restart: every account at once.
  const emails = Array.from({ length: 4 }, (_, at) => `load${at}@example.invalid`)
  for (const email of emails) withProfile(dataDir, email)
  const answers = await Promise.all(emails.map(email => renewal(post, email)))
  assert.deepEqual(answers.map(response => response.status), [200, 200, 200, 200])
  const starts = signer.calls.filter(call => call.op === 'renew').map(call => call.at).sort((a, b) => a - b)
  assert.equal(starts.length, 4)
  spaced(starts, 100)
  // A line of four is waited out, not cut: the last load is three intervals after the first.
  assert.ok(starts[3] - starts[0] >= 300 - 4 * SLOP, `${starts[3] - starts[0]}ms from the first load to the last`)
})

test('Qwen2API-nch: the worker says in its log how long a load waited for its turn', { timeout: 10000 }, async t => {
  const signer = fakeSigner()
  const { post, dataDir } = await start(t, { signer, loadMinIntervalMs: 100 })
  for (const email of ['first@example.invalid', 'second@example.invalid']) withProfile(dataDir, email)
  const { answers, lines } = await logged(async lines => ({
    answers: await Promise.all(['first@example.invalid', 'second@example.invalid'].map(email => renewal(post, email))), lines
  }))
  assert.deepEqual(answers.map(response => response.status), [200, 200])
  const waits = lines.filter(line => / page-load waited \(\d+ ms\)$/.test(line))
  // The first load had no turn to wait for: one line, for the one that waited.
  assert.equal(waits.length, 1, lines.join('\n'))
})

test('Qwen2API-nch: RESIDENT_LOAD_MIN_INTERVAL_MS at 1 turns the queue off, and /health says what is in force', { timeout: 10000 }, async t => {
  const previous = process.env.RESIDENT_LOAD_MIN_INTERVAL_MS
  t.after(() => {
    if (previous === undefined) delete process.env.RESIDENT_LOAD_MIN_INTERVAL_MS
    else process.env.RESIDENT_LOAD_MIN_INTERVAL_MS = previous
  })
  const signer = fakeSigner()
  delete process.env.RESIDENT_LOAD_MIN_INTERVAL_MS
  // These two read the setting from the environment, as the worker in its container does.
  const fromEnvironment = { loadMinIntervalMs: undefined }
  const defaultWorker = await start(t, { signer, ...fromEnvironment })
  assert.equal((await defaultWorker.health()).loadMinIntervalMs, 10000)

  process.env.RESIDENT_LOAD_MIN_INTERVAL_MS = '1'
  const { post, dataDir, health } = await start(t, { signer, ...fromEnvironment })
  assert.equal((await health()).loadMinIntervalMs, 1)
  for (const email of ['a@example.invalid', 'b@example.invalid']) withProfile(dataDir, email)
  // Nothing ahead of them: both load at once, as neither had a turn to wait for.
  const answers = await Promise.all(['a@example.invalid', 'b@example.invalid'].map(email => renewal(post, email)))
  assert.deepEqual(answers.map(response => response.status), [200, 200])
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 2)
})

test('Qwen2API-nch: a full sign-in is a page load too, and takes its turn', { timeout: 10000 }, async t => {
  const signer = fakeSigner()
  // The sign-ins' own spacing is off here: only the page loads' is measured.
  const { post } = await start(t, { signer, loadMinIntervalMs: 150, minLoginIntervalMs: 1 })
  const answers = await Promise.all(['a@example.invalid', 'b@example.invalid'].map(email =>
    post('/session', { email, password: 'pw' })))
  assert.deepEqual(answers.map(response => response.status), [200, 200])
  const starts = signer.calls.filter(call => call.op === 'signin').map(call => call.at).sort((a, b) => a - b)
  assert.equal(starts.length, 2)
  spaced(starts, 150, 'sign-ins')
})

test('Qwen2API-nch: a sign-in held back by the queue still spaces the next one from its real start', { timeout: 15000 }, async t => {
  const signer = fakeSigner()
  // Page loads are close together and sign-ins far: a sign-in waits in the queue, and the
  // sign-ins' interval must be kept from when each really begins, not from the moment
  // it was admitted — which is why the queue is waited in before the login pacer's enter().
  const { post, dataDir } = await start(t, {
    signer, loadMinIntervalMs: 40, minLoginIntervalMs: 200, maxLoginWaitMs: 5000
  })
  const emails = name => Array.from({ length: 10 }, (_, at) => `${name}${at}@example.invalid`)
  for (const email of [...emails('warm'), 'a@example.invalid', 'b@example.invalid']) withProfile(dataDir, email)

  // A line of ten loads ahead of everybody...
  const warm = Promise.all(emails('warm').map(email => renewal(post, email)))
  // ...and two sign-ins arriving at once behind it.
  const signedIn = Promise.all(['a@example.invalid', 'b@example.invalid'].map(email =>
    post('/session', { email, password: 'pw', force: true })))
  const answers = await Promise.all([...await warm, ...await signedIn])
  assert.ok(answers.every(response => response.status === 200), answers.map(response => response.status).join(','))
  const starts = signer.calls.filter(call => call.op === 'signin').map(call => call.at).sort((a, b) => a - b)
  assert.equal(starts.length, 2)
  // Both were held back by the queue, one load interval apart; the sign-ins' own interval holds all the same.
  spaced(starts, 200, 'sign-ins')
})

test('Qwen2API-nch: a stop ends every wait for a turn with page_closed, and nobody gets a turn after it', { timeout: 10000 }, async t => {
  const signer = fakeSigner()
  // The first load takes the only turn there is for a long time.
  const { post, dataDir, server } = await start(t, { signer, loadMinIntervalMs: 60000 })
  for (const email of ['first@example.invalid', 'waiting@example.invalid', 'late@example.invalid']) withProfile(dataDir, email)
  assert.equal((await renewal(post, 'first@example.invalid')).status, 200)

  const waiting = renewal(post, 'waiting@example.invalid')
  await sleep(100)
  const { answer, lines } = await logged(async lines => {
    await server.workerShutdown()
    const response = await waiting
    return { answer: { status: response.status, body: await response.json() }, lines }
  })
  assert.deepEqual(answer, { status: 502, body: { code: 'page_closed', message: 'The worker is shutting down.' } })
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
  assert.equal(lines.some(line => /^resident-close (open_failed|operation_failed) /.test(line.replace(/^\S+ /, ''))), false,
    `a page was said to have died while the worker was stopping:\n${lines.join('\n')}`)
  // Nothing opens after the stop either.
  const late = await renewal(post, 'late@example.invalid')
  assert.equal(late.status, 502)
  assert.equal((await late.json()).code, 'page_closed')
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
})

test('Qwen2API-nch: the queue hands out turns one interval apart plus jitter, is off at 1, and only a stop ends a wait', async () => {
  const even = createPageLoadQueue({ minIntervalMs: 1000, random: () => 0 })
  const since = Date.now()
  await even.wait()
  await even.wait()
  await even.wait()
  // Timers never fire early; the second turn came a second after the first, the third a second after that.
  assert.ok(Date.now() - since >= 2000 - SLOP, `${Date.now() - since}ms for three turns`)

  // The jitter is up to the interval again: a line never looks metronomic.
  const jittered = createPageLoadQueue({ minIntervalMs: 200, random: () => 0.999 })
  const started = Date.now()
  await jittered.wait()
  await jittered.wait()
  assert.ok(Date.now() - started >= 399 - SLOP, `${Date.now() - started}ms for the second turn`)

  // Off: no turn is waited for.
  const off = createPageLoadQueue({ minIntervalMs: 1 })
  const atOnce = Date.now()
  await Promise.all([off.wait(), off.wait(), off.wait()])
  assert.ok(Date.now() - atOnce < 500, `${Date.now() - atOnce}ms with the queue off`)

  // A stop ends the wait of whoever is in line...
  const stopping = createPageLoadQueue({ minIntervalMs: 60000, random: () => 0 })
  await stopping.wait()
  const inLine = stopping.wait()
  stopping.stop()
  await assert.rejects(inLine, { code: 'page_closed', message: 'The worker is shutting down.' })
  // ...and whoever comes after it gets no turn at all.
  await assert.rejects(stopping.wait(), { code: 'page_closed' })
  stopping.stop()
  await assert.rejects(stopping.wait(), { code: 'page_closed' })
})

test('Qwen2API-nch: RESIDENT_STREAM_WAIT_MS is read from the environment, 0 included — no wait', async t => {
  const previous = process.env.RESIDENT_STREAM_WAIT_MS
  t.after(() => {
    if (previous === undefined) delete process.env.RESIDENT_STREAM_WAIT_MS
    else process.env.RESIDENT_STREAM_WAIT_MS = previous
  })
  const signer = fakeSigner()
  const fromEnvironment = { streamWaitMs: undefined }
  delete process.env.RESIDENT_STREAM_WAIT_MS
  assert.equal((await (await start(t, { signer, ...fromEnvironment })).health()).streamWaitMs, 20000)
  process.env.RESIDENT_STREAM_WAIT_MS = '0'
  assert.equal((await (await start(t, { signer, ...fromEnvironment })).health()).streamWaitMs, 0)
  // A value that is no number leaves the default.
  process.env.RESIDENT_STREAM_WAIT_MS = 'soon'
  assert.equal((await (await start(t, { signer, ...fromEnvironment })).health()).streamWaitMs, 20000)
})
