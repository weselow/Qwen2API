const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parse } = require('yaml')

const { createServer } = require('../signin-worker/server')
const { fakeResidentBrowser } = require('./helpers/fake-resident-browser')
const { summarize } = require('../tools/egress-log-watch')

// POST /forget (Qwen2API-2l0): the app dropped an account, and the worker
// drops what it held for it — the cached session with its silent-renew timer,
// and the resident page. Found on prod: ten profiles of accounts removed on
// 21–22.11 lay in the worker while the app had one account. The browser is
// the fake of tests/helpers/fake-resident-browser.js; nothing reaches qwen.ai.
const AUTH = { authorization: 'Bearer secret' }
const CHAT = 'https://chat.qwen.ai'
const profileDir = (dataDir, email) => path.join(dataDir,
  'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32))
// A persisted profile is what authorizes /renew and the lazy open.
const withProfile = (dataDir, email) => {
  fs.mkdirSync(profileDir(dataDir, email), { recursive: true })
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Every request carries a deadline: a /forget stuck waiting for a renewal
// that waits for it must fail a test in seconds, not hang the runner.
async function request(port, route, payload, headers = AUTH) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  })
  return { status: response.status, ...await response.json() }
}

// Poll until the condition holds: fixed sleeps flake under CI load.
async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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

async function start(t, { script, ...options } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-'))
  const signer = fakeResidentBrowser(script)
  const server = createServer({
    dataDir, token: 'secret', signer, timeoutMs: 60000, maxPages: 16, keepAliveMs: 60000, drainMs: 1000,
    frontEndMs: 100, settleStableMs: 40, settlePollMs: 10, settleTimeoutMs: 300,
    // Login pacing is signin-worker-pacing.test.js's subject; the line that
    // keeps the page loads of every account apart, and the token refreshes,
    // are signin-worker-egress.test.js's.
    minLoginIntervalMs: 1, loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1, minRenewDelayMs: 60000,
    ...options
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const health = async () =>
    (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(8000) })).json()
  const call = (route, payload, headers) => request(port, route, payload, headers)
  const egress = email => call('/egress', {
    email, url: `${CHAT}/api/v2/chats/new`, method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"chatId":""}', timeoutMs: 5000
  })
  const forget = (email, headers) => call('/forget', { email }, headers)
  t.after(async () => {
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { call, egress, forget, health, dataDir, signer, server }
}

test('/forget is the worker’s own secret to use, and wants an email', async t => {
  const { forget, call, health } = await start(t)
  assert.equal((await forget('a@example.invalid', {})).status, 401)
  assert.equal((await call('/forget', { email: 'not-an-email' })).status, 400)
  assert.equal((await call('/forget', {})).status, 400)
  // Nothing above changed anything, and /health is as open as everywhere.
  const state = await health()
  assert.deepEqual([state.ok, state.sessions, state.residentPages], [true, 0, 0])
})

test('forgetting drops the cached session: the next /renew is a live reload, not the cache', async t => {
  const { call, forget, health, dataDir, signer } = await start(t)
  const email = 'gone@example.invalid'
  withProfile(dataDir, email)
  const signedIn = await call('/session', { email, password: 'pw' })
  assert.equal(signedIn.status, 200)
  assert.equal((await health()).sessions, 1)
  // While cached and fresh, /renew hands the session back and touches no browser.
  const cached = await call('/renew', { email })
  assert.equal(cached.token, signedIn.token)
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 0)

  assert.deepEqual(await forget(email), { status: 200, ok: true, session: true, page: false, profile: 'kept' })
  assert.equal((await health()).sessions, 0)
  // What stayed is the profile: an account removed from the app is not a deleted profile.
  assert.equal(fs.existsSync(profileDir(dataDir, email)), true)

  const live = await call('/renew', { email })
  assert.equal(live.status, 200)
  assert.match(live.token, /^token-renew-/)
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
})

test('forgetting cancels the silent-renew timer — next to an account left alone, whose timer fires', async t => {
  // Both tokens live a second, so each silent renewal is due about half a second after its session.
  const { call, forget, health, dataDir, signer } = await start(t, { script: { ttlSeconds: 1 }, renewFraction: 0.5, minRenewDelayMs: 20 })
  const gone = 'timer-gone@example.invalid'
  const kept = 'timer-kept@example.invalid'
  for (const email of [gone, kept]) withProfile(dataDir, email)
  assert.equal((await call('/session', { email: gone, password: 'pw' })).status, 200)
  assert.equal((await forget(gone)).session, true)
  assert.equal((await call('/session', { email: kept, password: 'pw' })).status, 200)

  // Control: the account that was not forgotten is reloaded by its timer.
  await until(() => signer.calls.some(call => call.op === 'renew' && call.dataDir === profileDir(dataDir, kept)))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(signer.calls.some(call => call.op === 'renew' && call.dataDir === profileDir(dataDir, gone)), false)
  assert.equal((await health()).sessions, 1, 'only the account that was left alone is still held')
  // Its own timer, re-armed by the renewal, is not left to fire into the tests that follow.
  assert.equal((await forget(kept)).session, true)
})

test('forgetting closes the resident page; a later call opens it again from the profile that stayed', async t => {
  const { egress, forget, health, dataDir, signer } = await start(t)
  const email = 'resident@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)
  assert.equal((await health()).residentPages, 1)

  assert.deepEqual(await forget(email), { status: 200, ok: true, session: true, page: true, profile: 'kept' })
  assert.equal((await health()).residentPages, 0)
  assert.equal(signer.contexts[0].closed, true)
  assert.equal(fs.existsSync(profileDir(dataDir, email)), true)

  // What any later /egress does — here only as the proof that the profile stayed usable.
  assert.equal((await egress(email)).status, 200)
  assert.equal(signer.contexts.length, 2)
  assert.equal((await health()).residentPages, 1)
})

test('a whole-answer call in flight on the page is let to finish before the page closes', async t => {
  const entered = deferred()
  const released = deferred()
  let hold = true
  const { egress, forget, dataDir, signer } = await start(t, {
    script: { call: async () => { if (hold) { hold = false; entered.resolve(); await released.promise } } }
  })
  const email = 'busy@example.invalid'
  withProfile(dataDir, email)
  const inFlight = egress(email)
  await entered.promise

  let settled = false
  const forgetting = forget(email).then(answer => { settled = true; return answer })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual([settled, signer.contexts[0].closed], [false, false], 'the page waits for its call')

  released.resolve()
  assert.equal((await inFlight).status, 200)
  assert.deepEqual(await forgetting, { status: 200, ok: true, session: true, page: true, profile: 'kept' })
  assert.equal(signer.contexts[0].closed, true)
})

test('with profiles deleted on forget the account is gone for good', async t => {
  const { egress, call, forget, dataDir } = await start(t, { forgetDeletesProfile: true })
  const email = 'wiped@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)
  assert.deepEqual(await forget(email), { status: 200, ok: true, session: true, page: true, profile: 'deleted' })
  assert.equal(fs.existsSync(profileDir(dataDir, email)), false)
  assert.equal((await egress(email)).code, 'no_profile')
  assert.equal((await call('/renew', { email })).status, 404)

  // An account without a profile is forgotten the same way; nothing was there to delete.
  assert.deepEqual(await forget('never@example.invalid'), { status: 200, ok: true, session: false, page: false, profile: 'absent' })
})

test('the profile is removed only once its browser is gone', async t => {
  const released = deferred()
  let hold = false
  const { egress, forget, dataDir, signer } = await start(t, {
    forgetDeletesProfile: true, script: { beforeClose: async () => { if (hold) await released.promise } }
  })
  const email = 'locked@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)

  hold = true
  let settled = false
  const forgetting = forget(email).then(answer => { settled = true; return answer })
  await until(() => signer.calls.some(call => call.op === 'closing'))
  assert.equal(settled, false)
  assert.equal(fs.existsSync(profileDir(dataDir, email)), true, 'Chromium still holds the directory')

  released.resolve()
  assert.deepEqual(await forgetting, { status: 200, ok: true, session: true, page: true, profile: 'deleted' })
  assert.equal(fs.existsSync(profileDir(dataDir, email)), false)
  assert.equal(signer.calls.find(call => call.op === 'closed').profileThere, true, 'removed after the close, not during it')
})

test('a profile that cannot be removed is said so — and the rest of the forgetting stands', async t => {
  const { egress, forget, dataDir } = await start(t, { forgetDeletesProfile: true })
  const email = 'stuck@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)
  t.mock.method(fs.promises, 'rm', async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })

  const { lines, answer } = await logged(async captured => ({ lines: captured, answer: await forget(email) }))
  assert.deepEqual(answer, { status: 200, ok: true, session: true, page: true, profile: 'left' })
  assert.equal(fs.existsSync(profileDir(dataDir, email)), true)
  assert.equal(lines.some(line => /^\S+ forget profile not removed \(EBUSY\)$/.test(line)), true)
  assert.equal(lines.some(line => /^\S+ forget session, page, profile left \(\d+ sessions\)$/.test(line)), true)
  assert.equal(lines.some(line => line.includes(email)), false)
})

test('profiles are deleted on forget only when the worker is told so, by an exact "true"', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const saved = process.env.SIGNIN_FORGET_DELETES_PROFILE
  t.after(() => {
    if (saved === undefined) delete process.env.SIGNIN_FORGET_DELETES_PROFILE
    else process.env.SIGNIN_FORGET_DELETES_PROFILE = saved
  })
  for (const [value, expected] of [['true', true], ['True', false], ['yes', false], ['1', false], [undefined, false]]) {
    if (value === undefined) delete process.env.SIGNIN_FORGET_DELETES_PROFILE
    else process.env.SIGNIN_FORGET_DELETES_PROFILE = value
    const { workerConfig } = createServer({ dataDir, signer: fakeResidentBrowser() })
    assert.equal(workerConfig.forgetDeletesProfile, expected, `SIGNIN_FORGET_DELETES_PROFILE=${value}`)
  }
})

test('both compose stacks hand the profile switch to the worker, off unless set', () => {
  // Compose hands a service only what is listed under its environment:, so a
  // knob that is documented but not forwarded there silently does nothing.
  for (const file of ['docker-compose.signin.yml', 'docker-compose.prod.yml']) {
    const { services } = parse(fs.readFileSync(require.resolve(`../docker/${file}`), 'utf8'))
    assert.ok(services['signin-worker'].environment.includes('SIGNIN_FORGET_DELETES_PROFILE=${SIGNIN_FORGET_DELETES_PROFILE:-false}'),
      `${file}: the worker does not get SIGNIN_FORGET_DELETES_PROFILE`)
  }
})

test('a renewal still running is waited for — and meanwhile the session is gone and no timer reloads the account', async t => {
  const released = deferred()
  let hold = true
  const { call, forget, health, dataDir, signer } = await start(t, {
    // The cached token has less than the worker's two minutes left: /renew is a
    // live reload, which the script holds — while the cached entry, with a
    // timer due 600 ms after it was made, is what /forget finds.
    minRenewDelayMs: 30, renewFraction: 0.01,
    script: {
      ttlSeconds: 60,
      renew: async () => {
        if (hold) { hold = false; await released.promise }
        return { token: 'late-token', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
      }
    }
  })
  const email = 'renewing@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await call('/session', { email, password: 'pw' })).status, 200)
  const madeAt = Date.now()
  const renewal = call('/renew', { email })
  await until(() => signer.calls.some(call => call.op === 'renew'))

  let settled = false
  const forgetting = forget(email).then(answer => { settled = true; return answer })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(settled, false, '/forget waits for the renewal')
  assert.equal((await health()).sessions, 0, 'and the session is gone from the first moment')

  released.resolve()
  assert.equal((await renewal).token, 'late-token')
  assert.deepEqual(await forgetting, { status: 200, ok: true, session: true, page: false, profile: 'kept' })
  // The renewal ended in remember(), as every renewal does: nothing of it stayed.
  assert.equal((await health()).sessions, 0)

  // Past the moment the cached entry's own timer was due (600 ms after the entry was made, i.e. while /forget was at work):
  // had it not been stopped, it would have reloaded the account here, into a fresh session and page.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, madeAt + 900 - Date.now())))
  assert.equal((await health()).sessions, 0)
  assert.equal(signer.calls.filter(call => call.op === 'renew').length, 1)
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 2, 'one browser for the sign-in, one for the renewal')
})

test('a renewal that arrives while the page is still being closed is served after it, and neither waits on the other forever', async t => {
  const released = deferred()
  let hold = false
  const { call, egress, forget, health, dataDir, signer } = await start(t, {
    script: { beforeClose: async () => { if (hold) await released.promise } }
  })
  const email = 'closing@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)

  hold = true
  let forgot = false
  const forgetting = forget(email).then(answer => { forgot = true; return answer })
  await until(() => signer.calls.some(call => call.op === 'closing'))

  // A renewal needs the account lock /forget holds while it closes: it queues, it does not get stuck.
  let renewed = false
  const renewal = call('/renew', { email }).then(answer => { renewed = true; return answer })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual([forgot, renewed], [false, false])

  released.resolve()
  assert.deepEqual(await forgetting, { status: 200, ok: true, session: true, page: true, profile: 'kept' })
  assert.equal((await renewal).status, 200)
  // One page was opened for the account, then — after that browser was gone — one for the renewal.
  assert.equal(signer.calls.filter(call => call.op === 'open').length, 2)
  assert.ok(signer.calls.findIndex(call => call.op === 'closed') < signer.calls.findLastIndex(call => call.op === 'open'))
  // It answered its caller — and left nothing behind: it came after the account was dropped.
  assert.equal((await health()).sessions, 0)
})

test('a renewal standing in the line of page loads is waited for like a running one — it holds the account lock until its turn', async t => {
  // The worker's line keeps the page loads of every account apart
  // (Qwen2API-nch, Qwen2API-ops). Here it is short, and on.
  const { call, egress, forget, health, dataDir, signer } = await start(t, { loadMinIntervalMs: 400 })
  const email = 'in-line@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)
  // The opening harvested the page it opened; no reload besides that.
  const reloads = () => signer.calls.filter(call => call.op === 'renew').length
  const opened = reloads()
  // A forced renewal is a reload, and takes a turn: behind the load that has just opened the page.
  const renewal = call('/renew', { email, force: true })
  await until(async () => (await health()).pageLoadQueue.waiting === 1)

  let settled = false
  const forgetting = forget(email).then(answer => { settled = true; return answer })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(settled, false, '/forget waits for the renewal that waits for its turn')
  assert.equal(reloads(), opened, 'nothing has been reloaded yet')

  assert.equal((await renewal).status, 200)
  assert.deepEqual(await forgetting, { status: 200, ok: true, session: true, page: true, profile: 'kept' })
  assert.deepEqual([(await health()).sessions, (await health()).residentPages], [0, 0])
})

test('a sign-in still in the login line is waited for as well — and neither keeps the other from the account', async t => {
  // Sign-ins this close together: the second waits in the worker's login line
  // for its slot, before it ever asks for the account lock — and /forget
  // lands while it does. A /forget that waited UNDER that lock would wait
  // forever: the sign-in needs the lock once its slot comes.
  const { call, forget, health, dataDir } = await start(t, { minLoginIntervalMs: 400 })
  const first = 'first@example.invalid'
  const queued = 'queued@example.invalid'
  for (const email of [first, queued]) withProfile(dataDir, email)
  assert.equal((await call('/session', { email: first, password: 'pw' })).status, 200)

  const { signedIn, answer } = await logged(async captured => {
    const signingIn = call('/session', { email: queued, password: 'pw' })
    await until(() => captured.some(line => / session queued \(/.test(line)))
    // Sent while the sign-in is still in line — not after it answered.
    const forgetting = forget(queued)
    return { signedIn: await signingIn, answer: await forgetting }
  })
  assert.equal(signedIn.status, 200)
  assert.deepEqual(answer, { status: 200, ok: true, session: true, page: false, profile: 'kept' })
  // The sign-in ended in remember(); only the account that was not forgotten is held.
  assert.equal((await health()).sessions, 1)
})

test('the log says what was forgotten, never the email, and the log counter reads it', async t => {
  const { egress, forget, dataDir } = await start(t)
  const email = 'quiet@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await egress(email)).status, 200)

  const { lines } = await logged(async captured => { await forget(email); return { lines: captured } })
  assert.equal(lines.some(line => /^\S+ forget session, page, profile kept \(\d+ sessions\)$/.test(line)), true)
  assert.equal(lines.some(line => /^\S+ resident-close forgotten \(0 pages\)$/.test(line)), true)
  assert.equal(lines.some(line => /^\S+ request POST \/forget -> 200 \d+ms$/.test(line)), true)
  // Emails never become log lines (docs/signin-worker.md, "API sidecar").
  assert.equal(lines.some(line => line.includes(email)), false)

  // tools/egress-log-watch.js, as the live session reads a worker's log: both lines it knows are counted, none is found unparsed.
  const report = summarize(lines)
  assert.equal(report.counts.get('pages.closed.forgotten'), 1)
  assert.equal(report.counts.get('workerHttp.forget.200'), 1)
  assert.equal(report.counts.has('unparsed.worker'), false)
})
