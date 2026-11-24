const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { once } = require('node:events')
const express = require('express')
const { parse } = require('yaml')

// Full sign-ins are deduplicated and paced in the signin-worker
// (Qwen2API-43a); these tests are the app's half of it: ask the worker for as
// few sign-ins as possible. One "add account" on prod (23.11) was three
// /session in 4 s — the route signed in, saved by signing in again, and a
// second click signed in a third time. Browser mode, as on prod; the logins
// themselves are stubs, nothing reaches a worker.
process.env.API_KEY = 'login-dedupe-test'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.DATA_SAVE_MODE = 'none'
process.env.ENABLE_CLI = 'false'
process.env.ACCOUNTS = ''
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const routes = require('../src/routes/accounts')

const exp = Math.floor(Date.now() / 1000) + 3600
const token = 'eyJhbGciOiJub25lIn0.' +
  Buffer.from(JSON.stringify({ sub: 'fixture', exp })).toString('base64url') + '.fixture'

// Every sign-in the app asks for goes through here; `peak` is how many ran
// at once, which is what qwen.ai's WAF sees from one IP.
function countingLogin(t, emails = {}) {
  let active = 0
  let peak = 0
  t.mock.method(accountManager.tokenManager, 'login', async email => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 30))
    active--
    return emails[email] || token
  })
  return () => peak
}

async function serve(t) {
  await accountManager._initPromise
  const app = express()
  app.use(express.json(), routes)
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    accountManager.destroy()
  })
  await once(server, 'listening')
  const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY },
    body: JSON.stringify(body)
  })
  return { post, restore: () => { v2sessions.browser = true } }
}

test('adding one account is one sign-in, and the token it got is the one saved', async t => {
  const { post } = await serve(t)
  const peak = countingLogin(t)
  const saved = []
  t.mock.method(accountManager, 'addAccountWithToken', async (...args) => { saved.push(args); return true })

  const response = await post('setAccount', { email: 'new@example.invalid', password: 'fixture', proxy: 'http://p:8080' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { email: 'new@example.invalid', message: '账号创建成功' })
  // Was three on prod: the sign-in, a second one inside "save", a second submit.
  assert.equal(accountManager.tokenManager.login.mock.callCount(), 1)
  assert.equal(peak(), 1)
  assert.deepEqual(saved, [['new@example.invalid', 'fixture', token, exp, 'http://p:8080']])
})

test('a second add of the same account is refused before any sign-in', async t => {
  const { post } = await serve(t)
  countingLogin(t)
  accountManager.accountTokens = [{ email: 'there@example.invalid', password: 'fixture', token, expires: exp }]

  const response = await post('setAccount', { email: 'there@example.invalid', password: 'fixture' })
  assert.equal(response.status, 409)
  assert.equal(accountManager.tokenManager.login.mock.callCount(), 0)
})

test('bulk import signs in one account at a time in browser mode', async t => {
  const { post, restore } = await serve(t)
  const peak = countingLogin(t)
  t.mock.method(accountManager, 'addAccountWithToken', async () => true)

  const imported = await (await post('setAccounts', {
    accounts: 'a@example.invalid:pw\nb@example.invalid:pw\nc@example.invalid:pw'
  })).json()
  assert.equal(imported.status, 'completed')
  assert.equal(imported.success, 3)
  assert.equal(imported.concurrency, 1)
  assert.equal(peak(), 1)
  assert.equal(accountManager.tokenManager.login.mock.callCount(), 3)

  // Elsewhere the configured concurrency (5 here) still applies.
  v2sessions.browser = false
  t.after(restore)
  const parallel = await (await post('setAccounts', {
    accounts: 'd@example.invalid:pw\ne@example.invalid:pw\nf@example.invalid:pw'
  })).json()
  assert.equal(parallel.success, 3)
  assert.equal(parallel.concurrency, 5)
  assert.equal(peak(), 3)
})

test('environment accounts sign in one at a time at startup in browser mode', async t => {
  await accountManager._initPromise
  t.after(() => accountManager.destroy())
  const peak = countingLogin(t)
  accountManager.accountTokens = ['a', 'b', 'c'].map(name => ({ email: `${name}@example.invalid`, password: 'pw' }))

  await accountManager._loginEnvironmentAccounts()
  assert.equal(peak(), 1)
  assert.ok(accountManager.accountTokens.every(account => account.token === token && account.expires === exp))

  v2sessions.browser = false
  t.after(() => { v2sessions.browser = true })
  accountManager.accountTokens = ['d', 'e', 'f'].map(name => ({ email: `${name}@example.invalid`, password: 'pw' }))
  await accountManager._loginEnvironmentAccounts()
  assert.equal(peak(), 3)
})

test('the Add button cannot submit while its sign-in is still running', () => {
  const dashboard = fs.readFileSync(require.resolve('../public/src/views/dashboard.vue'), 'utf8')
  assert.match(dashboard, /:disabled="!newAccountProxyValid \|\| isAddingAccount"/)
  assert.match(dashboard, /const addToken = async \(\) => \{\s+if \(isAddingAccount\.value\) return\s+isAddingAccount\.value = true/)
  assert.match(dashboard, /\} finally \{\s+isAddingAccount\.value = false\s+\}\s+\}/)
})

test('every locale explains a paced sign-in without jargon', () => {
  for (const lang of ['ru', 'zh', 'en']) {
    const messages = JSON.parse(fs.readFileSync(require.resolve(`../public/src/locales/${lang}.json`), 'utf8'))
    assert.ok(messages.msg.signin_busy, `${lang}: msg.signin_busy is missing`)
  }
})

test('both compose stacks forward the login queue to the worker and the call budget to the app', () => {
  // Compose hands a service only what is listed under its environment:, so a
  // knob that is documented but not forwarded there silently does nothing.
  for (const file of ['docker-compose.signin.yml', 'docker-compose.prod.yml']) {
    const { services } = parse(fs.readFileSync(require.resolve(`../docker/${file}`), 'utf8'))
    const forwarded = name => services['signin-worker'].environment.some(entry => entry.startsWith(`${name}=`))
    assert.ok(forwarded('SIGNIN_LOGIN_MIN_INTERVAL_MS'), `${file}: the worker does not get SIGNIN_LOGIN_MIN_INTERVAL_MS`)
    assert.ok(forwarded('SIGNIN_LOGIN_MAX_WAIT_MS'), `${file}: the worker does not get SIGNIN_LOGIN_MAX_WAIT_MS`)
    assert.ok(services.qwen2api.environment.includes('SIGNIN_WORKER_TIMEOUT_MS=${SIGNIN_WORKER_TIMEOUT_MS:-240000}'),
      `${file}: the app does not get SIGNIN_WORKER_TIMEOUT_MS`)
  }
})
