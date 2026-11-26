const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// Removing an account reaches the signin-worker (Qwen2API-2l0). In browser
// mode the worker holds a session, a silent-renew timer and a resident page
// for every account it has seen, and nothing told it when the app dropped one:
// on prod ten profiles of accounts removed on 21–22.11 lay in the worker while
// the app had one account. Browser mode, as on prod. The worker is a stand-in
// on loopback that answers as signin-worker/server.js does and records what it
// is asked; the last test runs the real worker route. Nothing reaches qwen.ai.
process.env.API_KEY = 'account-forget-test-key'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const config = require('../src/config')
const DataPersistence = require('../src/utils/data-persistence')
const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const signinWorker = require('../src/utils/signin-worker-client')
const { logger } = require('../src/utils/logger')
const router = require('../src/routes/accounts')
const deleteHandler = router.stack.find(layer => layer.route?.path === '/deleteAccount').route.stack.at(-1).handle

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const token = exp => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
const record = email => ({ email, password: 'synthetic', token: token(Math.floor(Date.now() / 1000) + 3600) })

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

// The worker as far as the app's removal is concerned. `mode.answer` says how
// /forget is answered: ok — as signin-worker/server.js does; refuse — a
// structured failure; old — a worker from before the route existed;
// malformed — a 200 that is not the shape the client checks; hang — nothing
// until the test answers it.
async function standIn(t) {
  const requests = []
  const pending = []
  const mode = { answer: 'ok' }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
      if (req.url !== '/forget') return reply(res, 500, { code: 'browser_error', message: 'Not this test’s subject.' })
      switch (mode.answer) {
        case 'refuse': return reply(res, 500, { code: 'browser_error', message: 'boom' })
        case 'old': return reply(res, 400, { code: 'invalid_request', message: 'Unknown route.' })
        case 'malformed': return reply(res, 200, { ok: true })
        case 'hang': return pending.push(res)
        default: return reply(res, 200, mode.payload || { ok: true, session: true, page: true, profile: 'kept' })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const saved = { signinWorkerUrl: config.signinWorkerUrl, signinWorkerToken: config.signinWorkerToken }
  config.signinWorkerUrl = `http://127.0.0.1:${server.address().port}`
  config.signinWorkerToken = 'shared-secret'
  t.after(async () => {
    Object.assign(config, saved)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { requests, pending, mode }
}

let sequence = 0

// Two accounts in a file, as on prod. The emails are unique to a test: a
// deleted record stays deleted for the persistence (data-persistence.js#markAccountDeleted).
async function withAccounts(t, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-account-forget-'))
  const persistence = new DataPersistence()
  persistence.dataFilePath = path.join(dir, 'data.json')
  persistence.backupFilePath = `${persistence.dataFilePath}.bak`
  const original = {
    mode: config.dataSaveMode, persistence: accountManager.dataPersistence,
    accounts: accountManager.accountTokens, browser: v2sessions.browser
  }
  const [removed, retained] = [`removed-${++sequence}`, `retained-${sequence}`].map(name => record(`${name}@example.invalid`))
  await fs.writeFile(persistence.dataFilePath, JSON.stringify({ accounts: [removed, retained], settings: {}, defaultHeaders: {} }))
  config.dataSaveMode = 'file'
  accountManager.dataPersistence = persistence
  accountManager.accountTokens = [removed, retained]
  accountManager.accountRotator.setAccounts(accountManager.accountTokens)
  try {
    await fn({ persistence, removed, retained })
  } finally {
    for (const timer of persistence._statsPersistTimers.values()) clearTimeout(timer)
    config.dataSaveMode = original.mode
    accountManager.dataPersistence = original.persistence
    accountManager.accountTokens = original.accounts
    v2sessions.browser = original.browser
    accountManager.accountRotator.setAccounts(original.accounts)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// What the account manager says while a test runs.
function capture(t) {
  const lines = { warn: [], info: [] }
  const saved = { warn: logger.warn, info: logger.info }
  logger.warn = message => lines.warn.push(String(message))
  logger.info = message => lines.info.push(String(message))
  t.after(() => Object.assign(logger, saved))
  return lines
}

// Poll until the condition holds: fixed sleeps flake under CI load.
async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('in browser mode the dashboard’s delete tells the worker — once, with the secret, about that account alone', async t => {
  const worker = await standIn(t)
  const lines = capture(t)
  await withAccounts(t, async ({ persistence, removed, retained }) => {
    v2sessions.setSession(removed.email, { token: 'session-token', expiresAt: 1, jar: null })
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    await deleteHandler({ body: { email: removed.email } }, res)
    assert.deepEqual([res.statusCode, res.body], [200, { message: '账号删除成功' }])

    assert.deepEqual(worker.requests.map(request => [request.url, request.auth, request.body]),
      [['/forget', 'Bearer shared-secret', { email: removed.email }]])
    // The app's own half is as before: memory, rotation, the session store, the file.
    assert.deepEqual(accountManager.getAllAccountKeys().map(account => account.email), [retained.email])
    assert.equal(accountManager.accountRotator.accounts.length, 1)
    assert.equal(v2sessions.sessions.has(removed.email), false)
    const saved = JSON.parse(await fs.readFile(persistence.dataFilePath, 'utf8'))
    assert.deepEqual(saved.accounts.map(account => account.email), [retained.email])
    // A worker that took the news is one line, and no warning.
    assert.equal(lines.warn.length, 0)
    assert.equal(lines.info.filter(line => line.includes('signin-worker 已忘掉账户')).length, 1)
    assert.ok(lines.info.some(line => line.includes(removed.email) && line.includes('会话已清除') && line.includes('页面已关闭')))
  })
})

test('a worker that refuses does not keep the account: it is removed all the same, and the refusal is in the log', async t => {
  const worker = await standIn(t)
  worker.mode.answer = 'refuse'
  const lines = capture(t)
  await withAccounts(t, async ({ persistence, removed, retained }) => {
    assert.equal(await accountManager.removeAccount(removed.email), true)
    assert.deepEqual(accountManager.getAllAccountKeys().map(account => account.email), [retained.email])
    const saved = JSON.parse(await fs.readFile(persistence.dataFilePath, 'utf8'))
    assert.deepEqual(saved.accounts.map(account => account.email), [retained.email])
    assert.equal(worker.requests.length, 1)
    assert.equal(lines.warn.length, 1)
    assert.ok(lines.warn[0].includes(removed.email))
    assert.ok(lines.warn[0].includes('(browser_error)'), lines.warn[0])
  })
})

test('a worker that cannot be reached does not keep the account either', async t => {
  // A port nobody listens on.
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  const saved = config.signinWorkerUrl
  config.signinWorkerUrl = `http://127.0.0.1:${port}`
  t.after(() => { config.signinWorkerUrl = saved })
  const lines = capture(t)
  await withAccounts(t, async ({ removed, retained }) => {
    assert.equal(await accountManager.removeAccount(removed.email), true)
    assert.deepEqual(accountManager.getAllAccountKeys().map(account => account.email), [retained.email])
    assert.equal(lines.warn.length, 1)
    // Nothing will finish on the worker's side here: the warning says so.
    assert.ok(lines.warn[0].includes('(signin_transport_error)') && lines.warn[0].includes('直到 signin-worker 重启'), lines.warn[0])
  })
})

test('a worker from before the route existed, or one answering out of shape, is a logged refusal — nothing worse', async t => {
  const worker = await standIn(t)
  const lines = capture(t)
  for (const [answer, code] of [['old', 'invalid_request'], ['malformed', 'signin_upstream_error']]) {
    worker.mode.answer = answer
    const before = lines.warn.length
    await withAccounts(t, async ({ removed }) => {
      assert.equal(await accountManager.removeAccount(removed.email), true)
      assert.equal(accountManager.getAllAccountKeys().length, 1)
    })
    assert.equal(lines.warn.length, before + 1)
    assert.ok(lines.warn.at(-1).includes(`(${code})`), lines.warn.at(-1))
  }
})

test('a worker that does not answer is given up on after a bound; the account is removed all the same', async t => {
  const worker = await standIn(t)
  worker.mode.answer = 'hang'
  const lines = capture(t)
  // The bound is 35 s (signin-worker-client.js); here it is short — the giving up is what is under test.
  assert.equal(signinWorker.FORGET_TIMEOUT_MS, 35000)
  const forgetAccount = signinWorker.forgetAccount
  t.mock.method(signinWorker, 'forgetAccount', email => forgetAccount(email, 200))
  await withAccounts(t, async ({ removed, retained }) => {
    const started = Date.now()
    // Raced against a deadline of its own: a removal that waited on the silent
    // worker for the client's whole default budget would meet every other
    // assertion here — minutes later.
    const removal = await Promise.race([
      accountManager.removeAccount(removed.email),
      new Promise(resolve => setTimeout(() => resolve('still waiting on the worker'), 10000))
    ])
    assert.notEqual(removal, 'still waiting on the worker')
    const took = Date.now() - started
    assert.equal(removal, true)
    assert.ok(took >= 200, `the worker was given its time (${took} ms)`)
    assert.ok(took < 4000, `and no more than its time (${took} ms)`)
    assert.deepEqual(accountManager.getAllAccountKeys().map(account => account.email), [retained.email])
    assert.equal(worker.requests.length, 1)
    assert.equal(lines.warn.length, 1)
    // Said of a worker that is slow, not of one that refused: it goes on without the app and finishes.
    assert.ok(lines.warn[0].includes('(signin_transport_error)') && lines.warn[0].includes('没有及时回答'), lines.warn[0])
    assert.equal(lines.warn[0].includes('直到 signin-worker 重启'), false, lines.warn[0])
  })
  for (const res of worker.pending) reply(res, 200, { ok: true, session: true, page: true, profile: 'kept' })
})

test('a worker that gave up waiting for the account says so, and the warning says what may come of it', async t => {
  const worker = await standIn(t)
  worker.mode.payload = { ok: true, session: true, page: true, profile: 'kept', pending: 'renewal' }
  const lines = capture(t)
  await withAccounts(t, async ({ removed }) => { assert.equal(await accountManager.removeAccount(removed.email), true) })
  // Not said to be forgotten: the removal's own line is the only one.
  assert.equal(lines.info.filter(line => line.includes('signin-worker 已忘掉账户')).length, 0)
  assert.equal(lines.warn.length, 1)
  assert.ok(lines.warn[0].includes('等不下去了') && lines.warn[0].includes('续期') && lines.warn[0].includes('/forget'), lines.warn[0])
})

test('a word of what is still pending that is not one of the worker’s two is an answer out of shape', async t => {
  const worker = await standIn(t)
  worker.mode.payload = { ok: true, session: true, page: true, profile: 'kept', pending: 'bogus' }
  await assert.rejects(signinWorker.forgetAccount('solo@example.invalid'),
    { code: 'signin_upstream_error', message: 'Signin worker returned a malformed forget.' })
})

test('an answer that does not say yes is not taken for one, however well formed the rest of it is', async t => {
  const worker = await standIn(t)
  for (const payload of [
    { session: true, page: true, profile: 'kept' },
    { ok: false, session: true, page: true, profile: 'kept' },
    { ok: 'true', session: true, page: true, profile: 'kept' }
  ]) {
    worker.mode.payload = payload
    await assert.rejects(signinWorker.forgetAccount('solo@example.invalid'),
      { code: 'signin_upstream_error', message: 'Signin worker returned a malformed forget.' })
  }
})

test('outside browser mode the app does not use the worker, and does not tell it', async t => {
  const worker = await standIn(t)
  const lines = capture(t)
  await withAccounts(t, async ({ removed }) => {
    v2sessions.browser = false
    assert.equal(await accountManager.removeAccount(removed.email), true)
  })
  assert.equal(worker.requests.length, 0)
  assert.equal(lines.warn.length, 0)
})

test('a storage that refuses the deletion keeps the worker out of it', async t => {
  const worker = await standIn(t)
  await withAccounts(t, async ({ persistence, removed }) => {
    const write = persistence._writeFileAtomic
    persistence._writeFileAtomic = async function (target, content) {
      if (target === this.dataFilePath) throw new Error('synthetic disk failure')
      return write.call(this, target, content)
    }
    assert.equal(await accountManager.removeAccount(removed.email), false)
    assert.equal(accountManager.getAllAccountKeys().length, 2)
    // The account still exists here: the session and the page the worker holds for it are still wanted.
    assert.equal(worker.requests.length, 0)
  })
})

test('the worker is told once the deletion is durable, and what the account’s queue does next does not overtake it', async t => {
  const worker = await standIn(t)
  worker.mode.answer = 'hang'
  await withAccounts(t, async ({ removed, retained }) => {
    const removal = accountManager.removeAccount(removed.email)
    await until(() => worker.requests.length === 1)
    // Gone from the app already, the worker not yet answered: the account's queue is still busy,
    // so what goes through that queue for the account — the save of a re-add, a refresh — waits
    // until the worker has been told. The sign-in that a re-add makes BEFORE its save is not on
    // that queue: landing in the worker while the /forget is pending, it is waited for by the
    // /forget, and the session it just made is dropped with the rest (Qwen2API-2l0, NOTES).
    assert.equal(accountManager.getAllAccountKeys().some(account => account.email === removed.email), false)
    let added = false
    const addition = accountManager.addAccountWithToken(removed.email, removed.password, removed.token, removed.expires)
      .then(result => { added = true; return result })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(added, false)

    reply(worker.pending[0], 200, { ok: true, session: true, page: true, profile: 'kept' })
    assert.equal(await removal, true)
    assert.equal(await addition, true)
    assert.deepEqual(accountManager.getAllAccountKeys().map(account => account.email), [retained.email, removed.email])
  })
})

test('what became of the browser profile is said when there is something to say', async t => {
  const worker = await standIn(t)
  const lines = capture(t)
  for (const profile of ['deleted', 'left', 'kept', 'absent']) {
    worker.mode.payload = { ok: true, session: false, page: false, profile }
    await withAccounts(t, async ({ removed }) => { assert.equal(await accountManager.removeAccount(removed.email), true) })
    const line = lines.info.filter(line => line.includes('signin-worker 已忘掉账户')).at(-1)
    assert.ok(line.includes('会话本无') && line.includes('页面本无'), line)
    assert.equal(line.includes('浏览器配置已删除'), profile === 'deleted', `${profile}: ${line}`)
    assert.equal(line.includes('浏览器配置没能删除'), profile === 'left', `${profile}: ${line}`)
  }
  assert.equal(lines.warn.length, 0)
})

test('the client asks with the email alone and hands back what the worker reports', async t => {
  const worker = await standIn(t)
  assert.deepEqual(await signinWorker.forgetAccount('solo@example.invalid'), { session: true, page: true, profile: 'kept' })
  assert.deepEqual(worker.requests.map(request => [request.url, request.auth, request.body]),
    [['/forget', 'Bearer shared-secret', { email: 'solo@example.invalid' }]])

  worker.mode.answer = 'old'
  await assert.rejects(signinWorker.forgetAccount('solo@example.invalid'), error => {
    assert.equal(error.code, 'signin_upstream_error')
    assert.equal(error.workerCode, 'invalid_request')
    assert.equal(error.status, 400)
    return true
  })
  worker.mode.answer = 'malformed'
  await assert.rejects(signinWorker.forgetAccount('solo@example.invalid'),
    { code: 'signin_upstream_error', message: 'Signin worker returned a malformed forget.' })
})

test('the app and the real worker route, end to end: a removed account leaves nothing in the worker', async t => {
  const { createServer } = require('../signin-worker/server')
  const { fakeResidentBrowser } = require('./helpers/fake-resident-browser')
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-account-forget-e2e-'))
  const signer = fakeResidentBrowser()
  const server = createServer({
    dataDir, token: 'e2e-secret', signer, forgetDeletesProfile: true,
    frontEndMs: 100, settleStableMs: 40, settlePollMs: 10, settleTimeoutMs: 300,
    minLoginIntervalMs: 1, loadMinIntervalMs: 1, tokenRefreshMinIntervalMs: 1
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const saved = { signinWorkerUrl: config.signinWorkerUrl, signinWorkerToken: config.signinWorkerToken, accounts: accountManager.accountTokens }
  config.signinWorkerUrl = origin
  config.signinWorkerToken = 'e2e-secret'
  t.after(async () => {
    Object.assign(config, { signinWorkerUrl: saved.signinWorkerUrl, signinWorkerToken: saved.signinWorkerToken })
    accountManager.accountTokens = saved.accounts
    accountManager.accountRotator.setAccounts(saved.accounts)
    await server.workerShutdown()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const lines = capture(t)

  const email = 'end-to-end@example.invalid'
  const profile = path.join(dataDir, 'account-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32))
  await fs.mkdir(profile, { recursive: true })
  const health = async () => (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(8000) })).json()

  // The account as the app holds it, and the page the worker opened for it on the account's first call.
  const account = record(email)
  accountManager.accountTokens = [account]
  accountManager.accountRotator.setAccounts(accountManager.accountTokens)
  await signinWorker.egress(email, account, {
    url: 'https://chat.qwen.ai/api/v2/chats/new', method: 'POST', headers: {}, body: '{}', timeoutMs: 5000
  })
  assert.deepEqual([(await health()).sessions, (await health()).residentPages], [1, 1])

  assert.equal(await accountManager.removeAccount(email), true)
  assert.deepEqual([(await health()).sessions, (await health()).residentPages], [0, 0])
  assert.equal(signer.contexts[0].closed, true)
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' })
  assert.equal(accountManager.getAllAccountKeys().length, 0)
  assert.equal(lines.warn.length, 0)
  assert.ok(lines.info.some(line => line.includes(email) && line.includes('浏览器配置已删除')), lines.info.join('\n'))
})
