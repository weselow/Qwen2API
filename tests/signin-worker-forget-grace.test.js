const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parse } = require('yaml')

const { createServer } = require('../signin-worker/server')
const { fakeResidentBrowser } = require('./helpers/fake-resident-browser')

// The pause before /forget deletes a removed account's profile
// (Qwen2API-t8s; SIGNIN_FORGET_GRACE_MS). "Remove an account and add it again
// at once" used to cost a password sign-in: the adding's sign-in is not in
// line behind the app's removal, and the worker, still waiting in /forget,
// took the session it had just made and deleted the fresh profile. The
// profile is now put down for deletion, not deleted: a request the worker
// takes for the account inside the pause takes that back. The mark that
// notes it lies in the profile, and outlives the worker.
// The deletion at once (pause 0) is signin-worker-forget.test.js's, as before.
// The browser is the fake of tests/helpers/fake-resident-browser.js; nothing
// reaches qwen.ai.
const AUTH = { authorization: 'Bearer secret' }
const CHAT = 'https://chat.qwen.ai'
const MARK = '.qwen2api-forget-at'
const profileDir = (dataDir, email) => path.join(dataDir,
  'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32))
const markPath = (dataDir, email) => path.join(profileDir(dataDir, email), MARK)
const withProfile = (dataDir, email) => {
  fs.mkdirSync(profileDir(dataDir, email), { recursive: true })
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Every request carries a deadline: a route stuck waiting must fail a test in seconds, not hang the runner.
async function request(port, route, payload, headers = AUTH) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  })
  return { status: response.status, ...await response.json() }
}

// Poll until the condition holds: fixed sleeps flake under CI load.
async function until(condition, timeoutMs = 5000, what = 'condition') {
  if (typeof timeoutMs !== 'number') throw new TypeError(`until(condition, timeoutMs, what): the second argument is the timeout in ms, got ${typeof timeoutMs}`)
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} not met in ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// `pending`, or a failure after `ms`: nothing a test waits for may keep it for ever.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
  const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
  Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

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

/**
 * A worker on `dataDir` that deletes profiles, after a pause of `graceMs`
 * (600 by default: a real timer, so that the rest of the worker's clocks
 * stay real). `signIns` counts the sign-ins it is asked for.
 */
async function start(t, { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-grace-')), graceMs = 600, script, ...options } = {}) {
  const signer = fakeResidentBrowser(script)
  const signIns = { made: 0 }
  const signin = signer.signin
  signer.signin = async (...args) => { signIns.made++; return signin(...args) }
  const server = createServer({
    dataDir, token: 'secret', signer, timeoutMs: 60000, maxPages: 16, keepAliveMs: 60000, drainMs: 1000,
    frontEndMs: 100, settleStableMs: 40, settlePollMs: 10, settleTimeoutMs: 300,
    // Login pacing is signin-worker-pacing.test.js's subject; the line that
    // keeps the page loads of every account apart, and the token refreshes,
    // are signin-worker-egress.test.js's.
    minLoginIntervalMs: 1, loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1, minRenewDelayMs: 60000,
    forgetDeletesProfile: true, forgetGraceMs: graceMs,
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
  const add = (email, headers) => call('/session', { email, password: 'pw' }, headers)
  const forget = email => call('/forget', { email })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
  }
  t.after(async () => {
    await stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { call, egress, add, forget, health, dataDir, signer, signIns, stop }
}

const profileThere = (dataDir, email) => fs.existsSync(profileDir(dataDir, email))
const markThere = (dataDir, email) => fs.existsSync(markPath(dataDir, email))

test('removed and added again inside the pause: the profile stays, and the adding is one sign-in', { timeout: 20000 }, async t => {
  const graceMs = 800
  const worker = await start(t, { graceMs })
  const { dataDir } = worker
  const email = 'again@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.add(email)).status, 200)
  assert.equal(worker.signIns.made, 1)

  const { lines, answer } = await logged(async captured => ({ lines: captured, answer: await worker.forget(email) }))
  assert.deepEqual(answer, { status: 200, ok: true, session: true, page: false, profile: 'deferred' })
  assert.equal(profileThere(dataDir, email), true, 'the profile is put down for deletion, not deleted')
  assert.equal(markThere(dataDir, email), true, 'and marked so')
  assert.equal(lines.some(line => /^\S+ forget session, no page, profile deferred \(\d+ sessions\)$/.test(line)), true)
  assert.equal(lines.some(line => line.includes(email)), false)

  assert.equal((await worker.add(email)).status, 200)
  assert.equal(worker.signIns.made, 2, 'the adding is one sign-in, not two')
  await until(() => !markThere(dataDir, email), 5000, 'the mark going with the account being asked for')
  // Past the moment the deletion was put down for.
  await sleep(graceMs + 300)
  assert.equal(profileThere(dataDir, email), true, 'the profile outlives the pause')
})

test('removed and not added again: the profile is deleted once the pause is over — not before, and /forget does not wait for it', { timeout: 20000 }, async t => {
  // Long enough that a loaded runner's own slowness cannot pass for /forget waiting the pause out.
  const graceMs = 2500
  const worker = await start(t, { graceMs })
  const { dataDir } = worker
  const email = 'not-again@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.add(email)).status, 200)

  // What the worker says from here to the end of the test: the line of the removal comes after the pause.
  const lines = []
  const say = console.log
  console.log = (...args) => lines.push(args.join(' '))
  t.after(() => { console.log = say })
  const before = Date.now()
  assert.equal((await worker.forget(email)).profile, 'deferred')
  assert.equal(profileThere(dataDir, email), true, 'not at once')
  assert.equal(Date.now() - before < graceMs, true, 'and /forget did not wait for the pause')
  await until(() => !profileThere(dataDir, email), 8000, 'the profile removed after the pause')
  assert.equal(Date.now() - before >= graceMs, true, 'not before the pause is over')
  // One line says what became of the profile, and it carries no email. Waited for, not read the
  // moment the directory is gone: the worker writes it after the removal (server.js#runDeletion),
  // and a poll of the test can see the directory gone a turn of the event loop before that.
  const afterThePause = () => lines.filter(line => /^\S+ forget profile deleted after the pause \(\d+ sessions\)$/.test(line))
  await until(() => afterThePause().length > 0, 8000, "the worker's line of the removal after the pause")
  assert.equal(afterThePause().length, 1)
  assert.equal(lines.some(line => line.includes(email)), false)
  assert.equal((await worker.call('/renew', { email })).status, 404)
  assert.equal((await worker.egress(email)).code, 'no_profile')
})

test('a request that lands while the mark itself is being written keeps the profile: the asking is seen again once the mark is written', { timeout: 20000 }, async t => {
  // The window is one small write. An asking that comes inside it finds no deletion yet to take back —
  // so the account is asked once more once the mark is written.
  const worker = await start(t)
  const { dataDir } = worker
  const email = 'asked-while-marked@example.invalid'
  withProfile(dataDir, email)
  const write = fs.promises.writeFile
  const writing = deferred()
  const written = deferred()
  t.mock.method(fs.promises, 'writeFile', async function (file, ...rest) {
    const done = write.call(this, file, ...rest)
    if (String(file).endsWith(MARK)) {
      writing.resolve()
      await written.promise
    }
    return done
  })
  const forgetting = worker.forget(email)
  forgetting.catch(() => {})
  await within(writing.promise, 5000, 'the mark beginning to be written')
  const adding = worker.call('/session', { email, password: 'pw' })
  adding.catch(() => {})
  // The sign-in itself waits for the account's turn, which /forget holds while it writes the mark.
  // A later request of the worker's own, answered after /session reached it, says the asking is in.
  await worker.health()
  await new Promise(resolve => setImmediate(resolve))
  written.resolve()
  assert.equal((await within(forgetting, 8000, '/forget')).profile, 'kept', 'asked for again while the mark was written: no deletion is left to fire')
  assert.equal((await within(adding, 8000, 'the adding')).status, 200)
  await until(() => !markThere(dataDir, email), 5000, 'no mark left behind')
  // Past the pause the deletion was to be put down for.
  await sleep(900)
  assert.equal(profileThere(dataDir, email), true, 'the profile of the account added again outlives the pause')
})

test('at the start a mark that names another profile is left alone, and one that cannot be read is said and left', { timeout: 20000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-grace-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const own = 'mark-own@example.invalid'
  const other = 'mark-other@example.invalid'
  const unreadable = 'mark-unreadable@example.invalid'
  for (const email of [own, other, unreadable]) withProfile(dataDir, email)
  // A mark lying in `other`'s profile that names `own`'s, past its moment: it is nobody's to act on.
  fs.writeFileSync(markPath(dataDir, other), `${JSON.stringify({ email: own, at: Date.now() - 1000 })}\n`)
  fs.writeFileSync(markPath(dataDir, unreadable), '{not json')

  const { lines } = await logged(async captured => {
    await start(t, { dataDir, graceMs: 600 })
    await sleep(500)
    return { lines: captured }
  })
  assert.equal(profileThere(dataDir, own), true, 'the profile the stray mark names is not removed')
  assert.equal(profileThere(dataDir, other), true, 'nor the one it lies in')
  assert.equal(profileThere(dataDir, unreadable), true, 'nor the one whose mark cannot be read')
  assert.equal(lines.some(line => /^\S+ forget a mark that names no profile of its own was left alone$/.test(line)), true)
  assert.equal(lines.some(line => /^\S+ forget a mark could not be read: its profile stays as it is$/.test(line)), true)
  assert.equal([own, other, unreadable].some(email => lines.some(line => line.includes(email))), false, 'no email in the log')
})

test('a /egress inside the pause takes the deletion back, and the page opens from the profile that stayed', { timeout: 20000 }, async t => {
  const graceMs = 800
  const worker = await start(t, { graceMs })
  const { dataDir } = worker
  const email = 'called-again@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.add(email)).status, 200)
  assert.equal((await worker.forget(email)).profile, 'deferred')
  assert.equal((await worker.egress(email)).status, 200)
  await sleep(graceMs + 300)
  assert.equal(profileThere(dataDir, email), true)
  assert.equal(markThere(dataDir, email), false)
})

test('a /renew inside the pause takes the deletion back too', { timeout: 20000 }, async t => {
  const graceMs = 800
  const worker = await start(t, { graceMs })
  const { dataDir } = worker
  const email = 'renewed-again@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.forget(email)).profile, 'deferred')
  const live = await worker.call('/renew', { email })
  assert.equal(live.status, 200)
  assert.match(live.token, /^token-renew-/)
  await sleep(graceMs + 300)
  assert.equal(profileThere(dataDir, email), true)
  assert.equal(markThere(dataDir, email), false)
})

test('the worker stops and starts again: a profile whose moment has not come is kept until it comes; one whose moment has passed is removed at the start', { timeout: 20000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-grace-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const waiting = 'waiting@example.invalid'
  const due = 'due@example.invalid'
  const later = 'later@example.invalid'
  const untouched = 'untouched@example.invalid'
  for (const email of [waiting, due, later, untouched]) withProfile(dataDir, email)

  // The first worker put one profile down for deletion, with its moment far off, and stopped.
  const first = await start(t, { dataDir, graceMs: 3600000 })
  assert.equal((await first.add(waiting)).status, 200)
  assert.equal((await first.forget(waiting)).profile, 'deferred')
  await first.stop()
  assert.equal(profileThere(dataDir, waiting), true)

  // While no worker ran: one mark written past its moment, one for a moment close by; a profile without a mark.
  fs.writeFileSync(markPath(dataDir, due), `${JSON.stringify({ email: due, at: Date.now() - 1000 })}\n`)
  fs.writeFileSync(markPath(dataDir, later), `${JSON.stringify({ email: later, at: Date.now() + 700 })}\n`)

  const second = await start(t, { dataDir, graceMs: 3600000 })
  assert.equal((await second.health()).forgetGraceMs, 3600000)
  await until(() => !profileThere(dataDir, due), 5000, 'the profile past its moment removed at the start')
  assert.equal(profileThere(dataDir, waiting), true, 'the profile whose moment has not come is kept')
  assert.equal(profileThere(dataDir, untouched), true, 'a profile without a mark is nobody’s to remove')
  await until(() => !profileThere(dataDir, later), 5000, 'the profile removed once its moment came')
  await sleep(300)
  assert.equal(profileThere(dataDir, waiting), true)
  // Asked for inside its pause: taken back all the same after the restart.
  assert.equal((await second.add(waiting)).status, 200)
  await until(() => !markThere(dataDir, waiting), 5000, 'the mark read at the start going with the request')
  assert.equal(profileThere(dataDir, waiting), true)
})

test('a request that reaches the worker as it starts does not get ahead of the marks read at the start', { timeout: 20000 }, async t => {
  // Were the adding of the account served before its mark was read, the mark would be armed after it,
  // and the timer would take the profile from under the account just added again.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-grace-'))
  const graceMs = 500
  const email = 'at-start@example.invalid'
  withProfile(dataDir, email)
  fs.writeFileSync(markPath(dataDir, email), `${JSON.stringify({ email, at: Date.now() + graceMs })}\n`)
  // The start's reading of the marks is held back, so that the request is surely at the worker first.
  const read = fs.promises.readFile
  t.mock.method(fs.promises, 'readFile', async function (file, ...rest) {
    if (String(file).endsWith(MARK)) await sleep(200)
    return read.call(this, file, ...rest)
  })
  const worker = await start(t, { dataDir, graceMs })
  assert.equal((await worker.add(email)).status, 200)
  await sleep(graceMs + 400)
  assert.equal(profileThere(dataDir, email), true, 'the profile of the account added again inside its pause')
  await until(() => !markThere(dataDir, email), 5000, 'the mark taken back')
})

test('a sign-in that lands while /forget is still waiting for the account: the profile is kept outright', { timeout: 20000 }, async t => {
  // The race of the task: the app's removal is waiting in /forget while the adding's sign-in reaches the worker.
  const worker = await start(t)
  const { dataDir, signer } = worker
  const email = 'raced@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.add(email)).status, 200)

  // The next sign-in is held until the test lets it go.
  const entered = deferred()
  const released = deferred()
  const signin = signer.signin
  let hold = true
  signer.signin = async (...args) => {
    if (hold) { hold = false; entered.resolve(); await released.promise }
    return signin(...args)
  }
  const adding = worker.call('/session', { email, password: 'pw', force: true })
  await within(entered.promise, 5000, 'the adding’s sign-in beginning')
  let settled = false
  const forgetting = worker.forget(email).then(answer => { settled = true; return answer })
  await sleep(200)
  assert.equal(settled, false, '/forget waits for the sign-in, as it did')

  released.resolve()
  assert.equal((await adding).status, 200)
  const answer = await within(forgetting, 8000, '/forget')
  assert.equal(answer.profile, 'kept', 'the account is being added again: its profile is not put down for deletion')
  assert.equal(markThere(dataDir, email), false)
  await sleep(1000)
  assert.equal(profileThere(dataDir, email), true)
})

test('a request that lands while /forget is still at work keeps the profile outright', { timeout: 20000 }, async t => {
  // The page's close is held: /forget is in its rounds, and nothing else of the account gets its lock meanwhile.
  const released = deferred()
  let hold = false
  const worker = await start(t, { script: { beforeClose: async () => { if (hold) await released.promise } } })
  const { dataDir } = worker
  const email = 'asked-meanwhile@example.invalid'
  withProfile(dataDir, email)
  assert.equal((await worker.egress(email)).status, 200)

  hold = true
  let settled = false
  const forgetting = worker.forget(email).then(answer => { settled = true; return answer })
  await until(() => worker.signer.calls.some(call => call.op === 'closing'), 5000, 'the page beginning to close')
  const renewal = worker.call('/renew', { email })
  await sleep(200)
  assert.equal(settled, false)

  released.resolve()
  assert.equal((await renewal).status, 200)
  assert.equal((await within(forgetting, 8000, '/forget')).profile, 'kept')
  assert.equal(markThere(dataDir, email), false)
  await sleep(1000)
  assert.equal(profileThere(dataDir, email), true)
})

test('a renewal of the removed account that was still running is waited for as before — and does not save the profile', { timeout: 20000 }, async t => {
  // A renewal in flight is the removed account's own late call, not an adding: the profile is put down all the same.
  const entered = deferred()
  const released = deferred()
  const worker = await start(t, {
    script: {
      renew: async () => {
        entered.resolve()
        await released.promise
        return { token: 'late-token', exp: Math.floor(Date.now() / 1000) + 3600, cookies: [] }
      }
    }
  })
  const { dataDir } = worker
  const email = 'late-renewal@example.invalid'
  withProfile(dataDir, email)
  const renewal = worker.call('/renew', { email })
  await within(entered.promise, 5000, 'the renewal beginning')
  let settled = false
  const forgetting = worker.forget(email).then(answer => { settled = true; return answer })
  await sleep(200)
  assert.equal(settled, false, '/forget waits for the renewal')
  released.resolve()
  assert.equal((await renewal).status, 200)
  assert.equal((await within(forgetting, 8000, '/forget')).profile, 'deferred')
  await until(() => !profileThere(dataDir, email), 8000, 'the profile removed after the pause')
})

test('with the pause at zero the profile goes at once, as before; with profile deletion off nothing is marked', { timeout: 20000 }, async t => {
  const atOnce = await start(t, { graceMs: 0 })
  const quick = 'quick@example.invalid'
  withProfile(atOnce.dataDir, quick)
  assert.equal((await atOnce.add(quick)).status, 200)
  assert.equal((await atOnce.forget(quick)).profile, 'deleted')
  assert.equal(profileThere(atOnce.dataDir, quick), false)

  const off = await start(t, { forgetDeletesProfile: false })
  const kept = 'kept@example.invalid'
  withProfile(off.dataDir, kept)
  assert.equal((await off.add(kept)).status, 200)
  assert.deepEqual(await off.forget(kept), { status: 200, ok: true, session: true, page: false, profile: 'kept' })
  assert.equal(markThere(off.dataDir, kept), false)
  await sleep(900)
  assert.equal(profileThere(off.dataDir, kept), true)
  assert.equal((await off.health()).forgetGraceMs, 600, 'the pause is read on /health next to the switch it belongs to')
})

test('the pause is read from SIGNIN_FORGET_GRACE_MS, 0 being a value of its own', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-signin-forget-grace-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const saved = process.env.SIGNIN_FORGET_GRACE_MS
  t.after(() => {
    if (saved === undefined) delete process.env.SIGNIN_FORGET_GRACE_MS
    else process.env.SIGNIN_FORGET_GRACE_MS = saved
  })
  for (const [value, expected] of [['0', 0], ['45000', 45000], ['-5', 120000], ['soon', 120000], [undefined, 120000]]) {
    if (value === undefined) delete process.env.SIGNIN_FORGET_GRACE_MS
    else process.env.SIGNIN_FORGET_GRACE_MS = value
    const { workerConfig } = createServer({ dataDir, signer: fakeResidentBrowser() })
    assert.equal(workerConfig.forgetGraceMs, expected, `SIGNIN_FORGET_GRACE_MS=${value}`)
  }
})

test('both compose stacks hand the pause to the worker, with its default', () => {
  // Compose hands a service only what is listed under its environment:, so a
  // knob that is documented but not forwarded there silently does nothing.
  for (const file of ['docker-compose.signin.yml', 'docker-compose.prod.yml']) {
    const { services } = parse(fs.readFileSync(require.resolve(`../docker/${file}`), 'utf8'))
    assert.ok(services['signin-worker'].environment.includes('SIGNIN_FORGET_GRACE_MS=${SIGNIN_FORGET_GRACE_MS:-120000}'),
      `${file}: the worker does not get SIGNIN_FORGET_GRACE_MS`)
  }
})
