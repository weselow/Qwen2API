const test = require('node:test')
const assert = require('node:assert/strict')
const https = require('node:https')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const axios = require('axios')
const { text } = require('node:stream/consumers')

const auth = 'auth.session.test'
const chat = 'chat.session.test'
const domain = 'session.test'
const signin = '/api/v2/auths/signin'
const refresh = '/api/v2/auths/refresh'
const newChat = '/api/v2/chats/new'
const completions = '/api/v2/chat/completions'

function certificate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-v2-cookie-test-'))
  const key = path.join(tmp, 'test.key')
  const cert = path.join(tmp, 'test.crt')
  const gitOpenSSL = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe')
  const openssl = process.platform === 'win32' && fs.existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl'
  try {
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=session.test', '-addext', `subjectAltName=DNS:${auth},DNS:${chat}`,
      '-keyout', key, '-out', cert], { stdio: 'ignore', windowsHide: true })
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
  } finally {
    for (const entry of [key, cert]) fs.rmSync(entry, { force: true })
    fs.rmdirSync(tmp)
  }
}

function jwt(email, generation) {
  const payload = { sub: email, exp: Math.floor(Date.now() / 1000) + 3600, generation }
  return 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture'
}

test('isolated v2 sessions select cookies per account, host and path on the wire', async t => {
  const tls = certificate()
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-v2-accounts-'))
  const dataDir = path.join(runtime, 'data')
  const dataPath = path.join(dataDir, 'data.json')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(dataPath, JSON.stringify({ accounts: [] }))
  t.after(() => {
    for (const entry of [dataPath, dataPath + '.bak']) fs.rmSync(entry, { force: true })
    fs.rmdirSync(dataDir)
    fs.rmdirSync(runtime)
  })
  const records = []
  const pendingForms = new Set()
  let formCount = 0
  let refuse = false
  const server = https.createServer(tls, async (req, res) => {
    const url = new URL(req.url, 'https://' + req.headers.host)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const fixture = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(pair => {
      const i = pair.indexOf('=')
      return [pair.slice(0, i), pair.slice(i + 1)]
    }))
    records.push({ host: url.hostname, path: url.pathname, method: req.method, fixture, bearer: req.headers.authorization, raw })
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/auth') {
      res.setHeader('Content-Type', 'text/html')
      const id = String(++formCount)
      pendingForms.add(id)
      res.setHeader('Set-Cookie', `prelogin=${id}; Domain=${domain}; Path=${signin}; Secure; HttpOnly`)
      return res.end('<form></form>')
    }
    if (url.pathname === signin) {
      if (!pendingForms.delete(fixture.prelogin)) {
        res.writeHead(400)
        return res.end('{}')
      }
      const { email } = JSON.parse(raw)
      if (email.startsWith('blocked') || refuse) {
        res.setHeader('Content-Type', 'text/html')
        res.setHeader('Set-Cookie', 'untrusted=denied; Path=/; Secure')
        return res.end('<title>Verification</title>')
      }
      res.setHeader('Set-Cookie', [
        `shared=${email}; Domain=${domain}; Path=/; Secure; HttpOnly`,
        `authOnly=${email}; Path=/; Secure`,
        `refreshOnly=${email}; Path=${refresh}; Secure`,
        `chatOnly=${email}; Domain=${domain}; Path=/api/v2/chat; Secure`,
        `gone=old; Domain=${domain}; Path=/; Max-Age=0; Secure`,
        `foreign=bad; Domain=other.test; Path=/; Secure`
      ])
      return res.end(JSON.stringify({ token: jwt(email, 1) }))
    }
    if (url.pathname === refresh) {
      if (refuse) {
        res.setHeader('Set-Cookie', `shared=poison; Domain=${domain}; Path=/; Secure`)
        res.writeHead(401)
        return res.end('{}')
      }
      res.setHeader('Set-Cookie', [
        `shared=renewed-${fixture.authOnly}; Domain=${domain}; Path=/; Secure`,
        `chatOnly=; Domain=${domain}; Path=/api/v2/chat; Max-Age=0; Secure`
      ])
      return res.end(JSON.stringify({ token: jwt(fixture.authOnly, 2) }))
    }
    if (url.pathname === newChat) return res.end(JSON.stringify({ data: { id: 'fixture-chat' } }))
    if (url.pathname === completions) {
      res.setHeader('Content-Type', 'text/event-stream')
      const message = JSON.parse(raw).messages[0]
      const content = message?.role === 'user' && message.content === 'Reply with OK' ? 'OK' : 'Unexpected request'
      const frame = { choices: [{ delta: { phase: 'answer', content } }] }
      return res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const agent = new https.Agent({ ca: tls.cert })
  // Route both fixture names to loopback without changing machine DNS.
  const transport = {
    request(options, callback) {
      const host = options.hostname
      assert.ok([auth, chat].includes(host))
      return https.request({ ...options, hostname: '127.0.0.1', servername: host,
        ca: tls.cert, headers: { ...options.headers, host: host + ':' + port } }, callback)
    }
  }
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)) })
  Object.assign(process.env, {
    QWEN_LAB_V2_AUTH_ORIGIN: `https://${auth}:${port}`, QWEN_CHAT_PROXY_URL: `https://${chat}:${port}`,
    QWEN2API_RUNTIME_DIR: runtime, API_KEY: 'offline', ACCOUNTS: '', DATA_SAVE_MODE: 'file', ENABLE_CLI: 'false', ENABLE_FILE_LOG: 'false'
  })
  const intercept = axios.interceptors.request.use(c => {
    assert.ok([auth, chat].includes(new URL(c.url).hostname))
    c.transport = transport
    c.httpsAgent = agent
    return c
  })
  t.after(() => axios.interceptors.request.eject(intercept))
  const manager = require('../src/utils/account')
  const { sendChatRequest, generateChatID } = require('../src/utils/request')
  const lab = require('../src/utils/v2-lab-sessions')
  await manager._initPromise
  t.after(() => manager.destroy())
  const accounts = await Promise.all(['a', 'b'].map(async id => {
    const email = id + '@example.invalid'
    const token = await manager.login(email, 'fixture')
    assert.ok(token)
    return { email, token, password: 'fixture' }
  }))
  const beforeBlockedSignin = records.length
  await assert.rejects(manager.login('blocked@example.invalid', 'fixture', null, { throwOnFailure: true }),
    { code: 'signin_verification_required', upstreamStatus: 200 })
  assert.deepEqual(records.slice(beforeBlockedSignin).map(({ method, path }) => [method, path]),
    [['GET', '/auth'], ['POST', signin]])
  assert.equal(lab.sessions.has('blocked@example.invalid'), false)
  const signinRequests = records.filter(r => r.path === signin)
  assert.equal(signinRequests.length, 3)
  assert.equal(new Set(signinRequests.map(r => r.fixture.prelogin)).size, 3)
  assert.equal(pendingForms.size, 0)
  for (const account of accounts) {
    assert.equal(await manager.addAccountWithToken(account.email, account.password, account.token,
      manager.tokenManager.validateToken(account.token).exp), true)
  }
  const [a, b] = accounts
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Reply with OK' }] }
  const post = async account => {
    const result = await sendChatRequest(body, { currentAccount: account })
    assert.equal(result.status, true)
    const [answer, done] = (await text(result.response)).trimEnd().split('\n\n')
    assert.equal(JSON.parse(answer.slice('data: '.length)).choices[0].delta.content, 'OK')
    assert.equal(done, 'data: [DONE]')
  }
  await Promise.all(accounts.map(post))
  for (const acct of accounts) {
    const wire = records.filter(r => r.bearer === 'Bearer ' + acct.token)
    assert.deepEqual(wire.map(r => r.path), [newChat, completions])
    for (const r of wire) {
      assert.equal(r.host, chat)
      assert.equal(r.fixture.shared, acct.email)
      assert.equal(r.fixture.token, acct.token)
      assert.equal(r.fixture.chatOnly, r.path === completions ? acct.email : undefined)
      for (const key of ['authOnly', 'refreshOnly', 'gone', 'foreign', 'prelogin']) assert.equal(r.fixture[key], undefined)
    }
    assert.equal(lab.sessionFor(acct.email, acct.token).jar.getCookieStringSync('http://' + chat + '/'), '')
  }
  const firstSession = lab.sessionFor(a.email, a.token)
  refuse = true
  assert.equal(await manager.refreshAccountToken(a.email), false)
  assert.equal(lab.sessionFor(a.email, a.token), firstSession)
  refuse = false
  // Temporarily refuse storage writes, then commit the next refresh to the fixture file.
  const config = require('../src/config')
  config.dataSaveMode = 'none'
  assert.equal(await manager.refreshAccountToken(a.email), false)
  assert.equal(lab.sessionFor(a.email, a.token), firstSession)
  config.dataSaveMode = 'file'
  assert.equal(await manager.refreshAccountToken(a.email), true)
  const renewed = manager.accountTokens[0]
  assert.notEqual(renewed.token, a.token)
  const disk = fs.readFileSync(dataPath, 'utf8')
  assert.equal(JSON.parse(disk).accounts.find(row => row.email === a.email).token, renewed.token)
  assert.doesNotMatch(disk, /shared=|authOnly|refreshOnly|chatOnly|cookieJar|renewed-|prelogin/)
  assert.equal(lab.sessionFor(a.email, a.token), null)
  for (const r of records.filter(row => row.path === refresh)) {
    assert.equal(r.method, 'GET')
    assert.equal(r.host, auth)
    assert.deepEqual(r.fixture, { refreshOnly: a.email, shared: a.email, authOnly: a.email })
    assert.equal(r.raw, '')
  }
  assert.equal(records.filter(row => row.path === refresh).length, 3)
  await Promise.all([post(renewed), post(b)])
  const final = records.filter(row => row.path === completions).slice(-2)
  assert.equal(final.find(row => row.bearer === 'Bearer ' + renewed.token).fixture.shared, 'renewed-' + a.email)
  assert.equal(final.find(row => row.bearer === 'Bearer ' + renewed.token).fixture.chatOnly, undefined)
  assert.equal(final.find(row => row.bearer === 'Bearer ' + b.token).fixture.shared, b.email)
  assert.equal(await manager.removeAccount(a.email), true)
  assert.equal(lab.sessions.has(a.email), false)
  assert.ok(lab.sessionFor(b.email, b.token))
  const requestCount = records.length
  await assert.rejects(generateChatID(renewed.token, 'fixture', b), { code: 'lab_session_required', status: 409 })
  await assert.rejects(sendChatRequest(body, { currentAccount: renewed, chatId: 'fixture-chat' }),
    { code: 'lab_session_required', status: 409 })
  assert.equal(records.length, requestCount)
})
